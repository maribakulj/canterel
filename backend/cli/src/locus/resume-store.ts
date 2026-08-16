import fs from "node:fs"
import path from "node:path"

import { payloadHash } from "./lep/canonical.ts"
import type { AttemptState } from "./attempt.ts"
import type { BudgetDimension } from "./usage-meter.ts"

/**
 * Les checkpoints — `SPEC_V1.md` §24.2, sous la garde de §24.5.
 *
 * §24.2 énumère sept contenus, et le septième est celui qui décide si les six autres valent
 * quelque chose : « **dépendances non sérialisables signalées** ». Un checkpoint qui laisse
 * tomber en silence ce qu'il ne sait pas sérialiser — un sous-processus vivant, un contexte GPU,
 * une connexion ouverte — a exactement l'air d'un checkpoint complet. La reprise repart alors
 * d'un état qui n'a jamais existé, et elle repart avec confiance.
 *
 * §24.5 gouverne la relecture : « les manifests, événements et artefacts sont hashés. Une
 * incohérence déclenche quarantaine et diagnostic, **jamais réparation silencieuse** ». Un
 * checkpoint dont le hash ne correspond pas n'est donc pas réparé, pas ignoré, pas partiellement
 * relu : il est mis de côté avec sa raison, et la reprise n'a pas lieu.
 */

export const CHECKPOINT_FILE = "checkpoint.json"
export const QUARANTINE_DIR = "quarantine"

/**
 * Une dépendance que le checkpoint ne sait pas emporter.
 *
 * `kind` dit quoi, `reason` dit pourquoi, et `recoverable` dit si la reprise peut la reconstruire.
 * Les trois ensemble, parce que « il y avait un sous-processus » et « il y avait un sous-processus
 * qu'on ne peut pas relancer » n'appellent pas la même décision.
 */
export type UnserializableDependency = {
  readonly kind: string
  readonly reason: string
  readonly recoverable: boolean
}

/** Les sept contenus de §24.2, dans l'ordre du texte. */
export type Checkpoint = {
  readonly task_id: string
  readonly attempt: number
  readonly state: AttemptState
  /** État de session sérialisable. Opaque ici : ce module le transporte, il ne l'interprète pas. */
  readonly session: Record<string, unknown>
  /** Contexte hashé — §12.3 : une vue dont l'empreinte ne correspond pas n'est pas un contexte appauvri. */
  readonly context_hash: string
  /** Fichiers / worktree, par chemin logique et hash de contenu. */
  readonly worktree: Readonly<Record<string, string>>
  /** Artefacts partiels, par identifiant. Partiels veut dire déclarés et non encore complets. */
  readonly partial_artifacts: readonly string[]
  /** Budget consommé — les dimensions de §17.1. */
  readonly budget_spent: Partial<Record<BudgetDimension, number>>
  readonly next_operations: readonly string[]
  /** §24.2, le champ qui rend le reste honnête. Vide veut dire vide, pas « je n'ai pas regardé ». */
  readonly unserializable: readonly UnserializableDependency[]
  /** La séquence d'événements couverte, pour recoller avec le spool de §18.4. */
  readonly through_sequence: number
  readonly taken_at: string
}

/** Ce qui est écrit sur disque : le checkpoint et son empreinte. */
type Envelope = {
  readonly checkpoint: Checkpoint
  readonly hash: string
}

export type LoadResult =
  | { readonly ok: true; readonly checkpoint: Checkpoint }
  /** Aucun checkpoint : un premier démarrage n'est pas une corruption. */
  | { readonly ok: false; readonly outcome: "absent" }
  /** §24.5 : mis de côté avec sa raison, jamais réparé. */
  | { readonly ok: false; readonly outcome: "quarantined"; readonly reason: string; readonly movedTo?: string }

/**
 * Le magasin de reprise.
 *
 * Écriture atomique par fichier temporaire puis renommage : un checkpoint à moitié écrit est
 * précisément l'état qu'une coupure de courant produit, et c'est aussi celui qu'un lecteur
 * confiant traiterait comme un état valide. Le renommage est la seule opération que le système
 * de fichiers rend indivisible ; s'en passer reviendrait à espérer.
 */
export class ResumeStore {
  private readonly file: string
  private readonly quarantine: string

  constructor(private readonly dir: string) {
    this.file = path.join(dir, CHECKPOINT_FILE)
    this.quarantine = path.join(dir, QUARANTINE_DIR)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  /**
   * Écrire un checkpoint.
   *
   * Le hash porte sur le **JSON canonique**, pas sur la sérialisation écrite : deux exécutions
   * conformes n'ordonnent pas forcément les clés pareil, et vérifier un hash calculé sur des
   * octets non canoniques ferait échouer la relecture sur rien.
   */
  save(checkpoint: Checkpoint): string {
    const hash = payloadHash(checkpoint)
    const envelope: Envelope = { checkpoint, hash }
    const temporary = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
    return hash
  }

  /**
   * Relire le checkpoint, ou dire pourquoi il n'est pas utilisable.
   *
   * Aucun chemin ne rend un checkpoint partiellement valide. Un fichier illisible, un JSON cassé,
   * un hash qui ne correspond pas : les trois donnent `quarantined`, et le fichier est déplacé
   * plutôt que supprimé — §24.5 demande un diagnostic, et un diagnostic sur une preuve effacée
   * n'en est pas un.
   */
  load(): LoadResult {
    if (!fs.existsSync(this.file)) return { ok: false, outcome: "absent" }

    const raw = (() => {
      try {
        return fs.readFileSync(this.file, "utf8")
      } catch (error: unknown) {
        return error instanceof Error ? error : new Error("illisible")
      }
    })()
    if (raw instanceof Error) {
      return { ok: false, outcome: "quarantined", reason: `checkpoint illisible : ${raw.message}` }
    }

    const envelope = (() => {
      try {
        return JSON.parse(raw) as Partial<Envelope>
      } catch {
        return null
      }
    })()
    if (envelope === null || typeof envelope.hash !== "string" || typeof envelope.checkpoint !== "object") {
      return {
        ok: false,
        outcome: "quarantined",
        reason: "checkpoint malformé : ni son empreinte ni son contenu ne se lisent",
        movedTo: this.setAside("malformed"),
      }
    }

    const checkpoint = envelope.checkpoint as Checkpoint
    const recomputed = payloadHash(checkpoint)
    if (recomputed !== envelope.hash) {
      return {
        ok: false,
        outcome: "quarantined",
        reason: `empreinte du checkpoint incohérente (attendue ${envelope.hash}, calculée ${recomputed}) : quarantaine et diagnostic, jamais réparation silencieuse (§24.5)`,
        movedTo: this.setAside("hash-mismatch"),
      }
    }
    return { ok: true, checkpoint }
  }

  /**
   * Mettre de côté un checkpoint douteux.
   *
   * Déplacé, jamais supprimé : c'est la seule pièce qui dira plus tard ce qui s'est passé. Le nom
   * porte la raison et le rang, pour que deux corruptions successives ne s'écrasent pas.
   */
  private setAside(reason: string): string {
    fs.mkdirSync(this.quarantine, { recursive: true, mode: 0o700 })
    const existing = fs.readdirSync(this.quarantine).length
    const target = path.join(this.quarantine, `${CHECKPOINT_FILE}.${reason}.${existing}`)
    fs.renameSync(this.file, target)
    return target
  }

  /** Ce qui a été mis en quarantaine. Le diagnostic de §24.5 a besoin de la liste, pas d'un compteur. */
  quarantined(): readonly string[] {
    if (!fs.existsSync(this.quarantine)) return []
    return fs.readdirSync(this.quarantine).map((name) => path.join(this.quarantine, name))
  }

  /** Le répertoire du magasin, pour les diagnostics qui doivent le nommer. */
  location(): string {
    return this.dir
  }
}
