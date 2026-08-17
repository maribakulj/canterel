import { UNKNOWN, bullet, field, render, section, shortHash } from "./format.ts"
import type { LeaseStanding } from "../recovery.ts"
import type { CapabilityManifest } from "../lep/generated.ts"

/**
 * La vue d'état du worker — `SPEC_V1.md` §23.4 et §25.2.
 *
 * Ce que cette vue doit rendre visible tient en une question : **de quel droit ce worker
 * travaille-t-il en ce moment ?** D'où la place du lease, et la raison pour laquelle son état
 * s'affiche avec le vocabulaire de §24.1 plutôt qu'en `oui/non`.
 *
 * `unconfirmed` n'est pas « probablement bon ». C'est l'état normal après un redémarrage, et le
 * rendre par « lease : oui » parce que l'échéance n'est pas passée redirait à l'écran exactement
 * l'erreur que `recovery.ts` refuse de faire dans le code.
 */

/** Ce que la vue sait de la connexion. Chaque valeur est un état nommé, jamais un booléen. */
export type ConnectionState = "connected" | "reconnecting" | "offline" | "never-connected"

export type WorkerStatusInput = {
  readonly workerId?: string
  /** L'empreinte de la clé publique, pas la clé. La vue identifie, elle ne distribue pas. */
  readonly publicKeyHash?: string
  readonly protocol?: string
  readonly negotiated?: string
  readonly connection: ConnectionState
  readonly lease: LeaseStanding | "none"
  readonly manifest?: CapabilityManifest
  /** Profondeur du spool — §25.2. Un spool qui gonfle est le premier signe visible d'un problème. */
  readonly spoolUnacked?: number
  readonly spoolSaturated?: boolean
  readonly slotsUsed?: number
  readonly slotsTotal?: number
  /** Ce que le magasin de reprise a mis de côté — §24.5. Zéro se dit, l'absence de ligne ne se dit pas. */
  readonly quarantined?: readonly string[]
  readonly revoked?: boolean
}

/**
 * Le droit d'exécuter, en toutes lettres.
 *
 * Quatre états, quatre phrases. Aucune ne se laisse abréger en « ok » : le point de §24.1 est
 * précisément qu'un lease dont l'échéance est dans le futur n'autorise pas pour autant.
 */
export function renderLease(standing: LeaseStanding | "none"): string {
  const phrases: Record<LeaseStanding | "none", string> = {
    valid: "valide — reconfirmé par le serveur",
    unconfirmed: "non reconfirmé — relu localement, n'autorise rien (§24.1)",
    expired: "expiré",
    none: "aucun",
  }
  return field("lease", phrases[standing])
}

export function renderWorkerStatus(input: WorkerStatusInput): readonly string[] {
  const lines: string[] = []

  lines.push(...section("Worker"))
  lines.push(field("identifiant", input.workerId))
  // L'empreinte, jamais la clé : une vue s'affiche, se copie, se colle dans un ticket.
  lines.push(field("empreinte de clé", shortHash(input.publicKeyHash)))
  lines.push(field("protocole", input.protocol))
  lines.push(field("version négociée", input.negotiated))
  if (input.revoked === true) {
    // Une révocation qui ne se voit pas est une révocation qu'on découvrira par un refus
    // incompréhensible. §7.5 : l'identité reste, le droit d'agir non.
    lines.push(bullet("identité RÉVOQUÉE — seules les actions de clôture restent permises (§7.5)"))
  }

  lines.push("")
  lines.push(...section("Connexion"))
  lines.push(field("état", input.connection))
  lines.push(renderLease(input.lease))
  lines.push(field("événements en attente d'acquittement", input.spoolUnacked))
  if (input.spoolSaturated === true) {
    lines.push(bullet("spool saturé — backpressure, aucun événement perdu (§18.4)"))
  }

  lines.push("")
  lines.push(...section("Capacités"))
  lines.push(...renderCapabilities(input.manifest))
  lines.push(field("slots", slots(input)))

  lines.push("")
  lines.push(...section("Quarantaine"))
  lines.push(...renderQuarantine(input.quarantined))

  return lines
}

function slots(input: WorkerStatusInput): string {
  if (input.slotsUsed === undefined || input.slotsTotal === undefined) return UNKNOWN
  return `${input.slotsUsed} / ${input.slotsTotal}`
}

/**
 * Les capacités déclarées.
 *
 * Les niveaux de sandbox et les modes réseau d'abord : ce sont eux qui décident ce que le worker
 * a le droit de se voir confier, et un manifeste absent doit se lire `inconnu` plutôt que de
 * laisser une section vide qui ressemblerait à « rien de particulier ».
 */
export function renderCapabilities(manifest: CapabilityManifest | undefined): readonly string[] {
  if (manifest === undefined) return [bullet(`manifeste de capacités : ${UNKNOWN}`)]
  const sandbox = manifest.sandbox as unknown as Record<string, unknown> | undefined
  return [
    field("genre", manifest.worker_kind),
    field("niveaux de sandbox", sandbox?.["levels"]),
    field("modes réseau", sandbox?.["network_modes"]),
    // Chaque fournisseur porte sa provenance ici aussi : la vue de mission n'est pas le seul
    // endroit où l'on doit pouvoir voir qu'un modèle envoie les prompts ailleurs (§23.4).
    field(
      "modèles déclarés",
      manifest.models?.map((model) => `${model.provider} (${model.remote_inference === false ? "local" : "distant"})`),
    ),
  ]
}

/**
 * Ce qui a été mis de côté — §19.5 et §24.5.
 *
 * « Aucune » s'écrit. Une section vide se lirait comme une section sans problème, alors que c'est
 * la même apparence qu'une section jamais remplie.
 */
export function renderQuarantine(entries: readonly string[] | undefined): readonly string[] {
  if (entries === undefined) return [bullet(`quarantaine : ${UNKNOWN}`)]
  if (entries.length === 0) return [bullet("aucune pièce en quarantaine")]
  return entries.map((entry) => bullet(entry))
}
