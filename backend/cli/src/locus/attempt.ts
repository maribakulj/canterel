/**
 * Le cycle de vie d'un attempt — `SPEC_V1.md` §11.2.
 *
 * ```text
 * offered → accepted → preparing → running
 *                    ↘ rejected
 * running → waiting_human | checkpointing | completing
 * completing → completed | failed
 * running → cancelled | lease_lost | security_stopped
 * ```
 *
 * La machine est **une donnée**, pas une suite de `if`. C'est ce qui permet de demander « depuis
 * `running`, où peut-on aller ? » et d'obtenir une réponse complète — et surtout de refuser une
 * transition que personne n'a autorisée, au lieu de la laisser passer parce qu'aucun `if` ne la
 * mentionnait.
 */

export const ATTEMPT_STATES = [
  "offered",
  "accepted",
  "rejected",
  "preparing",
  "running",
  "waiting_human",
  "checkpointing",
  "completing",
  "completed",
  "failed",
  "cancelled",
  "lease_lost",
  "security_stopped",
] as const

export type AttemptState = (typeof ATTEMPT_STATES)[number]

/** Les transitions de §11.2, transcrites. Une flèche absente est une transition interdite. */
export const TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  offered: ["accepted", "rejected"],
  accepted: ["preparing"],
  rejected: [],
  preparing: ["running", "cancelled", "lease_lost", "security_stopped"],
  running: ["waiting_human", "checkpointing", "completing", "cancelled", "lease_lost", "security_stopped"],
  // Une attente revient à l'exécution, ou se fait interrompre. Elle ne saute pas à `completing` :
  // ce serait rendre un résultat sans avoir repris le travail qu'on avait suspendu.
  waiting_human: ["running", "cancelled", "lease_lost", "security_stopped"],
  checkpointing: ["running", "cancelled", "lease_lost", "security_stopped"],
  completing: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  lease_lost: [],
  security_stopped: [],
}

/** Les états dont on ne sort plus. Les nommer évite de les déduire d'une liste vide. */
export const TERMINAL_STATES: readonly AttemptState[] = [
  "rejected",
  "completed",
  "failed",
  "cancelled",
  "lease_lost",
  "security_stopped",
]

export function isTerminal(state: AttemptState): boolean {
  return TERMINAL_STATES.includes(state)
}

/** Vrai quand `to` est atteignable depuis `from`. */
export function canTransition(from: AttemptState, to: AttemptState): boolean {
  return TRANSITIONS[from].includes(to)
}

export type TransitionResult =
  | { readonly ok: true; readonly state: AttemptState }
  | { readonly ok: false; readonly reason: string }

/**
 * Passer d'un état à un autre.
 *
 * Rend un refus plutôt que de lever, et le refus **nomme les sorties possibles** : une machine à
 * états qui dit seulement « transition invalide » oblige à relire son diagramme, alors que la
 * réponse est déjà dans la table.
 */
export function transition(from: AttemptState, to: AttemptState): TransitionResult {
  if (canTransition(from, to)) return { ok: true, state: to }
  const allowed = TRANSITIONS[from]
  return {
    ok: false,
    reason: isTerminal(from)
      ? `\`${from}\` est terminal : aucune transition n'en sort, et surtout pas vers \`${to}\``
      : `\`${from}\` → \`${to}\` n'existe pas en §11.2 ; sorties possibles : ${allowed.join(", ")}`,
  }
}

/**
 * L'état dans lequel une perte de lease met un attempt.
 *
 * `lease_lost` et non `failed` : ce sont deux choses différentes. Un attempt échoué a produit un
 * verdict ; un attempt qui a perdu sa lease n'en a pas produit — il a perdu le droit d'en
 * produire un. Les confondre ferait passer une perte d'infrastructure pour un résultat
 * scientifique négatif, ce que l'invariant 12 interdit précisément de brouiller.
 */
export function onLeaseLost(from: AttemptState): TransitionResult {
  if (isTerminal(from)) {
    return { ok: false, reason: `\`${from}\` est déjà terminal : la lease perdue n'y change rien` }
  }
  return transition(from, "lease_lost")
}

/**
 * L'état d'attempt de LEP correspondant — le vocabulaire du protocole diffère du nôtre.
 *
 * `Attempt.state` dans le SDK est un **sous-ensemble** des états de tâche de §5, et son
 * commentaire généré le dit : `accepted`, `rejected` et `superseded` en sont absents exprès, parce
 * que ce sont des verdicts de Locus Solus sur un attempt terminé, pas des états qu'un worker
 * s'attribue. Traduire plutôt que d'aligner les deux vocabulaires est ce qui empêche un worker de
 * s'auto-décerner un verdict.
 */
export function toProtocolState(state: AttemptState): string | null {
  const mapping: Partial<Record<AttemptState, string>> = {
    preparing: "running",
    running: "running",
    waiting_human: "waiting_for_human",
    checkpointing: "running",
    completing: "running",
    completed: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
    // Une lease perdue laisse l'attempt orphelin côté serveur : personne ne le tient plus.
    lease_lost: "orphaned",
    security_stopped: "failed",
  }
  return mapping[state] ?? null
}
