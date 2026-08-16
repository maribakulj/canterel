import type { Event } from "./lep/generated.ts"

/**
 * Le bridge d'événements et la coalescence — `SPEC_V1.md` §18.3.
 *
 * §18.3 donne deux listes, et c'est la seconde qui compte : ce qui **ne peut pas** être coalescé —
 * transitions d'état, appels d'outil à effet, coûts, déclarations d'artefact, changements de
 * modèle, alertes, demandes humaines, propositions épistémiques.
 *
 * La règle est donc écrite en **deny-by-default** : un type d'événement est coalescible seulement
 * s'il figure dans la courte liste des coalescibles. Prendre le problème par l'autre bout — « tout
 * est coalescible sauf ceci » — ferait qu'un type d'événement ajouté demain serait fusionnable par
 * défaut, et un coût ou une alerte perdus dans une fusion sont perdus pour de bon.
 */

/** §18.3, première liste. Rien d'autre n'est coalescible. */
export const COALESCIBLE_TYPES: readonly string[] = ["progress", "log", "token", "resource.sampled", "heartbeat"]

/**
 * §18.3, seconde liste — les catégories qui ne peuvent jamais l'être.
 *
 * Redondante avec la première par construction, et gardée exprès : elle permet à un test de
 * vérifier que les deux listes ne se recoupent pas, ce qui est la seule façon de s'apercevoir
 * qu'un type a été rangé du mauvais côté.
 */
export const NEVER_COALESCIBLE_TYPES: readonly string[] = [
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "attempt.orphaned",
  "tool.started",
  "tool.completed",
  "artifact.declared",
  "artifact.uploaded",
  "usage.reported",
  "model.changed",
  "security.alert",
  "human.input.requested",
  "epistemic_commit.submitted",
]

export function isCoalescible(eventType: string): boolean {
  return COALESCIBLE_TYPES.includes(eventType)
}

/**
 * Fusionner les rafales coalescibles, sans jamais franchir un événement qui ne l'est pas.
 *
 * Deux propriétés, et la seconde est celle qui fait les bugs quand elle manque :
 *
 * 1. seuls des événements **consécutifs et de même type** fusionnent ;
 * 2. un événement non coalescible **coupe** la rafale.
 *
 * Sans (2), deux `progress` encadrant un `tool.completed` fusionneraient et feraient passer
 * l'appel d'outil **après** une progression qui le précédait. L'ordre est ce que le harnais
 * vérifie, et une coalescence qui réordonne est pire qu'une absence de coalescence.
 *
 * Le survivant d'une rafale est le **dernier** : c'est lui qui porte l'état le plus récent, et le
 * nombre d'événements fusionnés est reporté dans son payload pour que la compression soit visible
 * plutôt que devinée.
 */
export function coalesce(events: readonly Event[]): readonly Event[] {
  const out: Event[] = []
  for (const event of events) {
    const previous = out[out.length - 1]
    const mergeable =
      previous !== undefined &&
      isCoalescible(event.event_type) &&
      previous.event_type === event.event_type &&
      // Ne jamais fusionner à travers deux attempts : ils racontent deux histoires.
      previous.task_id === event.task_id &&
      previous.attempt === event.attempt

    if (!mergeable) {
      out.push(event)
      continue
    }
    out[out.length - 1] = {
      ...event,
      payload: {
        ...(typeof event.payload === "object" && event.payload !== null ? event.payload : {}),
        coalesced_count: coalescedCount(previous) + 1,
      },
    } as Event
  }
  return out
}

function coalescedCount(event: Event): number {
  if (typeof event.payload !== "object" || event.payload === null) return 1
  const value = (event.payload as Record<string, unknown>)["coalesced_count"]
  return typeof value === "number" ? value : 1
}

/**
 * Les constats d'une politique de coalescence mal réglée.
 *
 * Rend des constats plutôt que de lever : c'est une vérification de cohérence des listes, et son
 * public est le test, pas l'exécution.
 */
export function coalescencePolicyFindings(): readonly string[] {
  const findings: string[] = []
  for (const type of COALESCIBLE_TYPES) {
    if (NEVER_COALESCIBLE_TYPES.includes(type)) {
      findings.push(`\`${type}\` figure dans les deux listes de §18.3`)
    }
  }
  return findings
}

/**
 * Ce qu'un événement doit porter — §18.2.
 *
 * §18.2 cite `message_id`, que le schéma épinglé `lep/1.0` ne définit pas : `Event` y porte
 * `idempotency_key` comme identité de message. L'ajouter ici serait **dupliquer le contrat
 * cross-repo**, ce que `docs/locus/CLAUDE.md` interdit — le contrat est dans `locusolus/schemas/`,
 * et un champ inventé côté worker ne serait ni validé ni reconnu par un pair conforme. L'écart est
 * écrit au ledger plutôt que comblé en douce.
 *
 * `correlation_id`, en revanche, **existe** dans le schéma — avec `causation_id` — et y est
 * facultatif. Il n'est donc pas dans cette liste : c'est la couche qui émet qui le pose, et exiger
 * ici un champ que rien ne remplit encore ferait crier la vérification sur chaque événement
 * conforme. (Une entrée de ledger antérieure disait le champ absent du schéma ; c'était faux, et
 * corrigé au ledger de W2.14.)
 */
export const REQUIRED_EVENT_FIELDS: readonly string[] = [
  "protocol",
  "event_type",
  "sequence",
  "occurred_at",
  "idempotency_key",
]

/**
 * Les types d'événement qui appartiennent à un attempt.
 *
 * `worker.registered` n'en fait pas partie : il précède toute tâche. Exiger `task_id` partout le
 * ferait passer pour non conforme alors qu'il n'a rien à déclarer — et une vérification qui se
 * trompe sur les cas normaux apprend surtout à ne plus être lue.
 */
export const ATTEMPT_SCOPED_TYPES: readonly string[] = [
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "attempt.orphaned",
  "heartbeat",
  "progress",
  "tool.started",
  "tool.completed",
  "artifact.declared",
  "artifact.uploaded",
  "resource.sampled",
  "human.input.requested",
  "epistemic_commit.submitted",
]

export function eventFieldFindings(event: Event): readonly string[] {
  const record = event as unknown as Record<string, unknown>
  const required = ATTEMPT_SCOPED_TYPES.includes(event.event_type)
    ? [...REQUIRED_EVENT_FIELDS, "task_id", "attempt"]
    : REQUIRED_EVENT_FIELDS
  return required.filter((field) => record[field] === undefined).map((field) => `champ \`${field}\` absent (§18.2)`)
}
