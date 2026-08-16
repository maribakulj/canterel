import { isTerminal, type AttemptState } from "./attempt.ts"
import { isExpired } from "./lease.ts"
import type { Checkpoint } from "./resume-store.ts"
import type { Lease, MissionEnvelope } from "./lep/generated.ts"

/**
 * Redémarrage, offline et résultats partiels — `SPEC_V1.md` §24.
 *
 * §24.1 donne six obligations après redémarrage, et la deuxième est celle qui coûte cher quand
 * elle manque : « **ne pas supposer les leases valides** ».
 *
 * La tentation est évidente. Le lease est sur le disque, sa date d'expiration est dans le futur,
 * l'horloge locale est d'accord : tout dit qu'on peut reprendre. Sauf que pendant l'arrêt, le
 * serveur a très bien pu constater les heartbeats manquants, déclarer l'attempt orphelin et le
 * réattribuer. Reprendre sur la foi d'un lease non reconfirmé, c'est deux workers qui exécutent
 * la même mission en croyant chacun être seul.
 *
 * D'où la forme de ce module : un lease relu vaut `unconfirmed`, et `unconfirmed` n'autorise
 * rien. Ce n'est pas un état d'erreur — c'est l'état normal après un redémarrage, et le nommer
 * empêche de le confondre avec `valid`.
 */

/**
 * L'état d'un lease après relecture.
 *
 * `unconfirmed` est la valeur par défaut et la seule qu'un redémarrage puisse produire seul :
 * seule une réponse du serveur fait passer à `valid`. `expired` se lit localement — une échéance
 * dépassée est dépassée pour tout le monde — et c'est le seul verdict que l'horloge locale a le
 * droit de rendre.
 */
export type LeaseStanding = "unconfirmed" | "expired" | "valid"

/**
 * Ce qu'on sait d'un lease relu sur disque.
 *
 * Jamais `valid` : cette fonction n'a pas parlé au serveur. Elle distingue seulement « déjà
 * expiré, inutile de demander » de « peut-être encore bon, il faut demander ».
 */
export function leaseAfterRestart(lease: Lease | null, now: number): LeaseStanding {
  if (lease === null) return "expired"
  return isExpired(lease, now) ? "expired" : "unconfirmed"
}

/** La décision de reprise — §24.1, « reprendre uniquement sur autorisation ». */
export type ResumeDecision =
  | { readonly action: "resume"; readonly from: Checkpoint }
  /** Reconnecter et réconcilier avant toute chose. Le cas ordinaire après un redémarrage. */
  | { readonly action: "reconcile"; readonly reason: string }
  /** Rien à reprendre, ou plus rien à reprendre : l'attempt était terminé. */
  | { readonly action: "start-fresh"; readonly reason: string }
  /** §24.1 : « détecter les sessions impossibles à restaurer ». */
  | { readonly action: "abandon"; readonly reason: string; readonly findings: readonly string[] }

export type RecoveryInput = {
  readonly checkpoint: Checkpoint | null
  readonly lease: Lease | null
  readonly now: number
  /**
   * L'autorisation du serveur, quand elle est arrivée. Absente veut dire absente : c'est ce qui
   * fait que `reconcile` est la réponse par défaut et non un cas particulier.
   */
  readonly serverAuthorized?: boolean
  /** Le protocole que parle ce worker, pour repérer un checkpoint d'une autre époque. */
  readonly protocol?: string
  readonly checkpointProtocol?: string
}

/**
 * Décider quoi faire au démarrage.
 *
 * L'ordre des questions est l'ordre du coût d'une erreur, comme pour l'admission de §10.2 : ce qui
 * rend la reprise impossible d'abord, ce qui la rend inutile ensuite, l'autorisation en dernier.
 * Demander l'autorisation avant de savoir si l'état est restaurable ferait autoriser une reprise
 * qui ne peut pas avoir lieu.
 */
export function resumeDecision(input: RecoveryInput): ResumeDecision {
  const { checkpoint } = input
  if (checkpoint === null) {
    return { action: "start-fresh", reason: "aucun checkpoint : rien à reprendre" }
  }

  const findings = restorabilityFindings(checkpoint, input)
  if (findings.length > 0) {
    return {
      action: "abandon",
      reason: "session impossible à restaurer (§24.1)",
      findings,
    }
  }

  if (isTerminal(checkpoint.state)) {
    return { action: "start-fresh", reason: `l'attempt était déjà en \`${checkpoint.state}\`` }
  }

  const standing = leaseAfterRestart(input.lease, input.now)
  if (standing === "expired") {
    return { action: "reconcile", reason: "le lease a expiré pendant l'arrêt : rien ne reprend sans un nouveau" }
  }
  if (input.serverAuthorized !== true) {
    // Le cœur de §24.1. Le lease paraît encore bon, et c'est exactement pour ça qu'il faut demander :
    // pendant l'arrêt, le serveur a pu déclarer l'attempt orphelin et le réattribuer.
    return {
      action: "reconcile",
      reason: "lease non reconfirmé par le serveur : un lease relu sur disque n'autorise rien (§24.1)",
    }
  }
  return { action: "resume", from: checkpoint }
}

/**
 * Ce qui rend une session impossible à restaurer — §24.1, dernière obligation.
 *
 * Rend des constats, et l'absence de constat vaut restaurable. Une dépendance non sérialisable
 * **non reconstructible** est bloquante : reprendre en faisant comme si elle n'avait pas existé
 * produirait un état qui n'a jamais eu lieu. Une dépendance reconstructible ne l'est pas — c'est
 * du travail pour la reprise, pas une impossibilité.
 */
export function restorabilityFindings(checkpoint: Checkpoint, input: RecoveryInput = emptyInput()): readonly string[] {
  const findings: string[] = []

  for (const dependency of checkpoint.unserializable) {
    if (!dependency.recoverable) {
      findings.push(
        `dépendance non sérialisable et non reconstructible : \`${dependency.kind}\` — ${dependency.reason}`,
      )
    }
  }

  if (checkpoint.context_hash.length === 0) {
    // §12.3 : une vue dont l'empreinte manque n'est pas un contexte appauvri, c'est un contexte
    // dont on ne sait pas ce qu'il est.
    findings.push("empreinte de contexte absente : la vue ne peut pas être ré-authentifiée (§12.3)")
  }

  const expected = input.protocol
  const found = input.checkpointProtocol
  if (expected !== undefined && found !== undefined && major(expected) !== major(found)) {
    findings.push(`checkpoint écrit en \`${found}\`, worker en \`${expected}\` : majeures incompatibles`)
  }
  return findings
}

function emptyInput(): RecoveryInput {
  return { checkpoint: null, lease: null, now: 0 }
}

function major(version: string): string {
  return version.split(".")[0] ?? version
}

/**
 * Le verdict offline — §24.3.
 *
 * « Le worker peut poursuivre hors ligne **uniquement si la MissionEnvelope l'autorise** et
 * jusqu'au plafond de lease/offline budget. Sinon il checkpoint et suspend. »
 *
 * Le schéma épinglé `lep/1.0` ne porte aucun champ de permission offline. La lecture est donc
 * **deny-by-default** : une mission qui n'autorise rien n'autorise pas. L'inverse — continuer
 * parce que rien ne l'interdit — ferait travailler hors ligne sur la mission la plus sensible du
 * lot, celle dont l'auteur n'a jamais imaginé qu'on le lui demanderait. L'écart est écrit au
 * ledger plutôt que comblé par un champ inventé côté worker.
 */
export type OfflineVerdict =
  | { readonly allowed: true; readonly untilMs: number }
  | { readonly allowed: false; readonly reason: string; readonly action: "checkpoint-and-suspend" }

export function offlineVerdict(
  mission: MissionEnvelope,
  lease: Lease | null,
  now: number,
  permission?: { readonly offline_allowed?: boolean; readonly offline_budget_ms?: number },
): OfflineVerdict {
  if (permission?.offline_allowed !== true) {
    return {
      allowed: false,
      reason: `la mission \`${mission.task_id}\` n'autorise pas le travail hors ligne : checkpoint et suspension (§24.3)`,
      action: "checkpoint-and-suspend",
    }
  }
  if (lease === null || isExpired(lease, now)) {
    return {
      allowed: false,
      reason: "aucun lease valide : le plafond offline ne peut pas dépasser le droit d'exécuter",
      action: "checkpoint-and-suspend",
    }
  }
  // Le plus contraignant des deux plafonds. Un budget offline plus long que le lease donnerait le
  // droit de travailler après la fin du droit de travailler.
  const leaseRemaining = Date.parse(lease.expires_at) - now
  const budget = permission.offline_budget_ms ?? leaseRemaining
  return { allowed: true, untilMs: Math.min(leaseRemaining, budget) }
}

/**
 * Ce qu'un échec peut encore rendre — §24.4.
 *
 * « En cas d'échec, le worker soumet **si possible** : artefacts valides, résultats négatifs,
 * diagnostics, état de progression, causes, commit partiel explicitement marqué. »
 *
 * `partial: true` n'est pas décoratif : un commit partiel qui ne se déclare pas partiel est lu
 * comme un commit complet dont les résultats manquants n'existent pas. C'est la même erreur que
 * le résultat tardif silencieux de §11.4 et le commit tardif de §21.6 — trois endroits, une seule
 * règle : ce qui est diminué le dit.
 */
export type PartialSubmission = {
  readonly partial: true
  readonly task_id: string
  readonly attempt: number
  readonly state: AttemptState
  /** Les artefacts déjà vérifiés. Un artefact en quarantaine n'en fait pas partie. */
  readonly artifacts: readonly string[]
  readonly negative_results: readonly string[]
  readonly diagnostics: readonly string[]
  readonly progress: readonly string[]
  readonly causes: readonly string[]
  /** Ce qui a été perdu avec l'échec — nommé, pas déduit d'une absence. */
  readonly lost: readonly string[]
}

export function partialSubmission(input: {
  readonly checkpoint: Checkpoint
  readonly state: AttemptState
  readonly verifiedArtifacts: readonly string[]
  readonly negativeResults?: readonly string[]
  readonly diagnostics?: readonly string[]
  readonly causes?: readonly string[]
}): PartialSubmission {
  const verified = new Set(input.verifiedArtifacts)
  return {
    partial: true,
    task_id: input.checkpoint.task_id,
    attempt: input.checkpoint.attempt,
    state: input.state,
    artifacts: [...verified],
    negative_results: [...(input.negativeResults ?? [])],
    diagnostics: [...(input.diagnostics ?? [])],
    progress: [...input.checkpoint.next_operations],
    causes: [...(input.causes ?? [])],
    // Les artefacts déclarés que la vérification n'a pas atteints. Les taire ferait passer une
    // soumission amputée pour une soumission complète.
    lost: input.checkpoint.partial_artifacts.filter((id) => !verified.has(id)),
  }
}

/**
 * Le diagnostic de redémarrage — §24.1, sous forme lisible.
 *
 * Existe pour que « on a redémarré » ne soit pas un événement muet : la liste dit ce qui a été
 * reconstruit, ce qui a été mis en quarantaine et ce qui n'a pas été supposé.
 */
export function restartDiagnostics(input: {
  readonly decision: ResumeDecision
  readonly standing: LeaseStanding
  readonly unackedEvents: number
  readonly quarantined: readonly string[]
}): readonly string[] {
  const lines = [
    `décision de reprise : ${input.decision.action}`,
    `lease : ${input.standing}${input.standing === "unconfirmed" ? " (non supposé valide — §24.1)" : ""}`,
    `événements non acquittés conservés : ${input.unackedEvents}`,
  ]
  if (input.quarantined.length > 0) {
    lines.push(`en quarantaine : ${input.quarantined.join(", ")}`)
  }
  if (input.decision.action === "abandon") {
    lines.push(...input.decision.findings)
  }
  return lines
}
