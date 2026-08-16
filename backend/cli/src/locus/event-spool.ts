import fs from "node:fs"
import path from "node:path"

import type { Event } from "./lep/generated.ts"

/**
 * Le spool d'événements — `SPEC_V1.md` §18.4.
 *
 * « Durable ; ordonné ; borné ; chiffrable ; redacted ; **nettoyé seulement après acquittement**.
 * En cas de saturation, le worker passe en backpressure plutôt que de perdre les événements
 * canoniques. »
 *
 * Ces six mots gouvernent tout le fichier, et le plus important est le cinquième : **nettoyé
 * seulement après acquittement**. Un spool qui purge sur autre chose qu'un acquittement — l'âge,
 * la place, un redémarrage — perd exactement ce qu'il existe pour ne pas perdre, et le perd au
 * moment où ça compte, c'est-à-dire quand la connexion vient de tomber.
 *
 * La durabilité passe par un journal en append-only sur disque, relu au démarrage. Garder l'état
 * en mémoire seule ferait un spool qui protège de la perte de connexion mais pas de la perte du
 * processus — or les deux arrivent ensemble.
 */

export const SPOOL_FILE = "events.jsonl"

/** L'entrée journalisée. `acked` est un fait daté, pas une suppression. */
export type SpoolEntry = {
  readonly event: Event
  /** Séquence worker — §18.2. Monotone, attribuée par le spool, jamais par l'appelant. */
  readonly sequence: number
}

export type SpoolOptions = {
  /** Borne de §18.4. Au-delà, backpressure — jamais de perte silencieuse. */
  readonly maxEntries?: number
  /** §6 `resume.fsync`. Coûteux, et c'est le prix de la durabilité. */
  readonly fsync?: boolean
}

export const DEFAULT_MAX_ENTRIES = 10_000

export type AppendResult =
  | { readonly ok: true; readonly entry: SpoolEntry }
  /** §18.4 : saturation. L'appelant ralentit ; l'événement n'est pas perdu, il n'est pas accepté. */
  | { readonly ok: false; readonly backpressure: true; readonly reason: string }

/**
 * Un spool durable, ordonné et borné.
 *
 * La classe garde son état en mémoire **et** sur disque, et se reconstruit depuis le disque à
 * l'ouverture : c'est ce qui rend « rien perdu » vrai à travers un redémarrage et pas seulement à
 * travers une déconnexion.
 */
export class EventSpool {
  private readonly file: string
  private readonly maxEntries: number
  private readonly fsync: boolean
  private entries: SpoolEntry[] = []
  private lastSequence = 0
  private ackedThrough = 0

  constructor(dir: string, options: SpoolOptions = {}) {
    this.file = path.join(dir, SPOOL_FILE)
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.fsync = options.fsync ?? true
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.reload()
  }

  /**
   * Relire le journal depuis le disque.
   *
   * Une ligne illisible est **ignorée avec son rang**, pas fatale : un journal tronqué par une
   * coupure de courant en cours d'écriture perdrait sinon tout ce qui le précède, alors que seule
   * la dernière ligne est douteuse. Les lignes valides restent des faits.
   */
  private reload(): void {
    this.entries = []
    this.lastSequence = 0
    this.ackedThrough = 0
    if (!fs.existsSync(this.file)) return

    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (record["kind"] === "ack" && typeof record["through"] === "number") {
        this.ackedThrough = Math.max(this.ackedThrough, record["through"])
        continue
      }
      const sequence = record["sequence"]
      const event = record["event"]
      if (typeof sequence !== "number" || typeof event !== "object" || event === null) continue
      this.entries.push({ sequence, event: event as Event })
      this.lastSequence = Math.max(this.lastSequence, sequence)
    }
    // Le nettoyage n'a lieu qu'ici, à partir d'acquittements **relus** — donc toujours après
    // acquittement, jamais à cause du redémarrage lui-même.
    this.entries = this.entries.filter((entry) => entry.sequence > this.ackedThrough)
  }

  private write(record: Record<string, unknown>): void {
    const handle = fs.openSync(this.file, "a", 0o600)
    try {
      fs.writeSync(handle, `${JSON.stringify(record)}\n`)
      if (this.fsync) fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
  }

  /**
   * Ajouter un événement.
   *
   * La séquence est attribuée **ici** et nulle part ailleurs : la laisser à l'appelant rendrait
   * possible deux événements de même rang, ce que le harnais de conformance refuse à juste titre.
   *
   * L'écriture disque précède l'ajout mémoire. Dans l'autre ordre, un plantage entre les deux
   * laisserait un événement que le processus croit avoir spoolé et que le disque ignore —
   * c'est-à-dire exactement la perte silencieuse que §18.4 interdit.
   */
  append(event: Omit<Event, "sequence">): AppendResult {
    if (this.entries.length >= this.maxEntries) {
      return {
        ok: false,
        backpressure: true,
        reason: `spool saturé (${this.entries.length}/${this.maxEntries}) : backpressure plutôt que perte (§18.4)`,
      }
    }
    const sequence = this.lastSequence + 1
    const entry: SpoolEntry = { sequence, event: { ...event, sequence } as Event }
    this.write({ kind: "event", sequence, event: entry.event })
    this.entries.push(entry)
    this.lastSequence = sequence
    return { ok: true, entry }
  }

  /**
   * Acquitter jusqu'à une séquence incluse — le **seul** déclencheur de nettoyage.
   *
   * Un acquittement qui recule est ignoré : le serveur peut réémettre un acquittement ancien après
   * une reconnexion, et le prendre au mot ferait ressusciter des entrées déjà purgées.
   */
  ack(through: number): void {
    if (through <= this.ackedThrough) return
    this.ackedThrough = through
    this.write({ kind: "ack", through })
    this.entries = this.entries.filter((entry) => entry.sequence > through)
  }

  /** Ce qui reste à transmettre, dans l'ordre. C'est ce qu'une reprise rejoue. */
  unacked(): readonly SpoolEntry[] {
    return [...this.entries]
  }

  /** La dernière séquence acquittée par le serveur. */
  acknowledged(): number {
    return this.ackedThrough
  }

  /** La dernière séquence attribuée, acquittée ou non. */
  highestSequence(): number {
    return this.lastSequence
  }

  /** Vrai quand le spool est plein. L'appelant ralentit avant d'être refusé. */
  saturated(): boolean {
    return this.entries.length >= this.maxEntries
  }

  /**
   * Rouvrir depuis le disque, comme après un redémarrage.
   *
   * Existe pour que « rien perdu » soit **testable** sans lancer un second processus : c'est la
   * même relecture que fait le constructeur.
   */
  reopen(): void {
    this.reload()
  }
}
