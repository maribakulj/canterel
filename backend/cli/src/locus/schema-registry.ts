import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { LEP_DOCUMENTS, type LepDocument } from "./lep/generated.ts"
import { applyRewrites, SOURCE_REPO, vendoredFiles } from "./lep/vendor.ts"
import { LocusPinBroken } from "./errors.ts"

/**
 * Le registre du SDK épinglé — `SPEC_V1.md` §8.1.
 *
 * Il répond à trois questions, et à trois seulement : quels documents LEP existent, à quel commit
 * le SDK est verrouillé, et la copie locale est-elle intacte.
 *
 * Ce qu'il ne fait **pas**, délibérément : revalider les documents contre les schémas JSON à
 * l'exécution. Cela demanderait un validateur Draft 7 — `ajv` — absent de ce dépôt, donc une
 * dépendance ajoutée à `package.json` et payée à chaque synchronisation amont pour un besoin que
 * seul Locus a. Les schémas sont déjà validés là où ils sont le contrat : la CI de `locusolus`
 * valide son corpus de fixtures à chaque commit (W0.7). Ici, les types du SDK portent la forme, et
 * ce que l'admission de W2.8 doit réellement contrôler — les valeurs qu'elle refuse — se contrôle
 * champ par champ, pas par un schéma qui dirait « objet valide » à une mission qu'on ne peut pas
 * tenir.
 *
 * Cette limite est écrite ici plutôt que laissée à découvrir.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
/** La racine de `backend/cli`, dont les chemins de `PINNED.json` sont relatifs au dépôt. */
const REPO_ROOT = join(HERE, "../../../..")

export type PinnedFile = {
  readonly source: string
  readonly sha256_source: string
  readonly sha256_vendored: string
}

export type Pin = {
  readonly repo: string
  readonly commit: string
  readonly files: Readonly<Record<string, PinnedFile>>
}

/** Lire l'épinglage. */
export function readPin(): Pin {
  const raw = readFileSync(join(HERE, "lep/PINNED.json"), "utf8")
  return JSON.parse(raw) as Pin
}

/** Les documents que LEP définit, dans l'ordre du registre amont. */
export function documents(): readonly LepDocument[] {
  return LEP_DOCUMENTS
}

/** Vrai si `name` est un document LEP connu de la version épinglée. */
export function isDocument(name: string): name is LepDocument {
  return (LEP_DOCUMENTS as readonly string[]).includes(name)
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")

/**
 * Vérifier que la copie locale est bien celle qui a été épinglée.
 *
 * **Hors ligne**, et c'est le point : le contrôle qui compte tous les jours est « personne n'a
 * retouché la copie à la main », et il doit tourner partout, y compris dans une CI qui n'a aucun
 * accès au dépôt amont. La vérification contre l'amont lui-même est une autre affaire, traitée
 * par `verifyAgainstSource`.
 *
 * Rend la liste des fichiers altérés plutôt que de lever : le rapport complet vaut mieux qu'un
 * premier échec quand on cherche ce qui a bougé.
 */
export function verifyPin(): readonly string[] {
  const pin = readPin()
  const altered: string[] = []
  for (const [target, entry] of Object.entries(pin.files)) {
    const content = readFileSync(join(REPO_ROOT, target), "utf8")
    if (sha256(content) !== entry.sha256_vendored) altered.push(target)
  }
  return altered
}

/**
 * Vérifier que la copie reproduit bien la source amont, réécritures comprises.
 *
 * Demande une copie de travail de `locusolus` au commit épinglé — donc pas exécutable partout, et
 * c'est assumé : `maribakulj/locusolus` est privé, la CI de ce fork n'a pas de quoi le lire. Le
 * résultat le **dit** au lieu de passer en silence, comme le merge à blanc de W2.1.
 *
 * Ce qu'il vérifie que l'empreinte locale ne peut pas : que la règle de réécriture déclarée dans
 * `vendor.ts` est bien celle qui a produit ces fichiers. Sans lui, une copie retouchée à la main
 * puis réépinglée serait cohérente avec elle-même.
 */
export function verifyAgainstSource(
  locusolusRoot: string,
): { ok: false; reason: string } | { ok: true; drifted: readonly string[] } {
  const pin = readPin()
  const drifted: string[] = []
  for (const target of vendoredFiles()) {
    const entry = pin.files[target]
    if (!entry) return { ok: false, reason: `\`${target}\` est déclaré copié mais absent de PINNED.json` }
    let original: string
    try {
      original = readFileSync(join(locusolusRoot, entry.source), "utf8")
    } catch {
      return { ok: false, reason: `source amont illisible : ${entry.source}` }
    }
    if (sha256(original) !== entry.sha256_source) {
      drifted.push(`${entry.source} (source)`)
      continue
    }
    const expected = applyRewrites(target, original)
    const actual = readFileSync(join(REPO_ROOT, target), "utf8")
    if (expected !== actual) drifted.push(`${target} (réécriture)`)
  }
  return { ok: true, drifted }
}

/**
 * Exiger une copie intacte.
 *
 * Appelé au démarrage du mode worker : parler LEP avec un SDK retouché produirait des messages
 * qu'un serveur conforme refuserait, en se plaignant du contenu plutôt que de la cause.
 */
export function requirePin(): Pin {
  const altered = verifyPin()
  if (altered.length > 0) {
    throw new LocusPinBroken({ files: [...altered], commit: readPin().commit })
  }
  return readPin()
}

/** D'où vient le SDK, pour les diagnostics — jamais deviné, toujours lu. */
export function describePin(): { repo: string; commit: string; files: number } {
  const pin = readPin()
  return { repo: pin.repo || SOURCE_REPO, commit: pin.commit, files: Object.keys(pin.files).length }
}
