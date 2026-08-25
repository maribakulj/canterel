/**
 * La boucle du worker — `W2.20`. De `inert` à une mission exécutée.
 *
 * # Ce que cet item lève, et ce qu'il ne lève pas
 *
 * `W22.f` a rendu vraie la **raison** de l'inertie : le commentaire de `index.ts` invoquait une
 * condition levée depuis longtemps. L'inertie elle-même est restée, et c'est celle-ci que cet item
 * lève. Confondre les deux ferait passer une correction de vérité pour une livraison.
 *
 * Ce qui manquait n'était aucune des pièces — enrôlement, offre, lease, admission, plan, contexte,
 * événements, résultat, reprise existent tous et sont testés — mais **ce qui les enchaîne**.
 *
 * # Des ports, et aucune entrée/sortie ici
 *
 * Cette boucle ne connaît ni `fetch`, ni le disque, ni l'amont. Tout ce qu'elle fait passe par
 * [`WorkerPorts`], ce qui la rend exerçable de bout en bout sans serveur, sans réseau et sans
 * modèle — c'est la même discipline que `packages/event-store` chez `locusolus`, où le port précède
 * le driver.
 *
 * # La couture reste une frontière de **données** — ADR 0010
 *
 * [`WorkerPorts.openSession`] prend un `SessionPlan` et rend un [`SessionReport`]. Les deux sont des
 * données sérialisables, et un test le tient par un aller-retour JSON : **aucun handle ne traverse
 * la couture**. C'est ce qui permet à `src/locus/**` de ne rien importer de `src/session/`, et donc
 * à une refonte amont de ne rien casser ici.
 *
 * # Le numéro d'attempt ne se réinvente pas
 *
 * §11.1 : « aucune de ces identités ne doit être substituée aux autres ». Une reprise après
 * interruption **relit** son numéro dans le checkpoint plutôt que d'en demander un neuf — un
 * résultat rendu sous un autre numéro serait un doublon pour l'institution, ce que §15.5 existe pour
 * empêcher.
 */

import type { AttemptState } from "./attempt.ts"
import { transition } from "./attempt.ts"
import { LocusAttemptPathBroken } from "./errors.ts"
import type { Checkpoint } from "./resume-store.ts"
import type { Refusal } from "./admission.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "./lep/generated.ts"
import type { ToolDescriptor } from "./tool-policy.ts"
import { mapMission, type SessionPlan } from "./session-map.ts"

/** Ce que le plan de contrôle propose : une mission et le bail qui l'autorise. */
export type Offer = {
  readonly mission: MissionEnvelope
  readonly lease: Lease
}

/**
 * Ce que l'amont rend d'une session — **des données, jamais un handle**.
 *
 * Le champ `sessionId` est ce qui prouve qu'une session a réellement été créée : une couture qui
 * rendrait un objet vivant rendrait aussi impossible de dire, en la lisant, si quelque chose a eu
 * lieu.
 */
export type SessionReport = {
  readonly sessionId: string
  readonly events: readonly Event[]
  /** Ce que la session a produit, opaque ici : cette boucle le transporte, elle ne l'interprète pas. */
  readonly output: Record<string, unknown>
}

/** Tout ce que la boucle demande au monde extérieur. */
export type WorkerPorts = {
  readonly now: () => number
  /** Demander du travail. `null` veut dire « rien pour toi », ce qui n'est pas une panne. */
  readonly claim: () => Promise<Offer | null>
  /** Ce que cet hôte sait faire, tel que `W2.6` l'établit. */
  readonly manifest: () => CapabilityManifest
  /** Les outils dont cette installation dispose. */
  readonly tools: () => readonly ToolDescriptor[]
  /** Ouvrir une session amont à partir d'un plan. Données à l'aller, données au retour. */
  readonly openSession: (plan: SessionPlan) => Promise<SessionReport>
  /** Faire remonter des événements — `W2.12` les a déjà rendus coalescibles. */
  readonly emit: (events: readonly Event[]) => Promise<void>
  /** Rendre le résultat. */
  readonly report: (report: SessionReport, plan: SessionPlan) => Promise<void>
  /** Écrire un point de reprise — `W2.16`. */
  readonly checkpoint: (checkpoint: Checkpoint) => Promise<void>
  /** Relire le point de reprise, s'il y en a un. */
  readonly resume: () => Promise<Checkpoint | null>
}

/** Les étapes que la boucle traverse, dans l'ordre, et sous leur nom. */
export const PHASES = ["claim", "plan", "session", "emit", "report"] as const

/** Une étape. */
export type Phase = (typeof PHASES)[number]

/**
 * Ce qu'un tour de boucle a produit.
 *
 * Trois issues et pas une de plus : `idle` — personne n'a de travail —, `refused` — la mission
 * existe et cette installation ne peut pas l'honorer —, `ran` — elle l'a exécutée. Les fondre ferait
 * lire « rien à faire » sur un refus d'admission, ce qui enverrait chercher un ordonnanceur en panne
 * plutôt qu'un hôte incapable.
 */
export type LoopOutcome =
  | { readonly status: "idle" }
  | {
      readonly status: "refused"
      readonly refusal: Refusal
      readonly phases: readonly Phase[]
      /** L'état atteint — `rejected`, jamais `failed` : rien n'a été tenté. */
      readonly state: AttemptState
    }
  | {
      readonly status: "ran"
      readonly phases: readonly Phase[]
      /** Le rang, relu du checkpoint quand il y en avait un — jamais réinventé. */
      readonly attempt: number
      readonly taskId: string
      readonly sessionId: string
      readonly resumed: boolean
      /** L'état atteint, parcouru par la machine de §11.2 et jamais écrit à la main. */
      readonly state: AttemptState
    }

/**
 * Faire un tour : réclamer, planifier, ouvrir la session, faire remonter, rendre.
 *
 * # Pourquoi les étapes sont rendues plutôt que journalisées
 *
 * Un tour qui n'aurait laissé qu'un log serait indiscernable d'un tour qui n'a rien fait. Les étapes
 * traversées sont une **valeur**, donc un test les lit — c'est le remède que `W22.c` a posé pour
 * `main.rs` de `locus-execd`, appliqué ici.
 */
export async function runLoop(ports: WorkerPorts): Promise<LoopOutcome> {
  const phases: Phase[] = []
  let state: AttemptState = "offered"

  const offer = await ports.claim()
  if (!offer) return { status: "idle" }
  phases.push("claim")
  // On reste `offered` jusqu'à ce que l'admission tranche. Accepter dès la réclamation était une
  // faute que la machine de §11.2 a attrapée : `rejected` n'y est atteignable que depuis `offered`,
  // et c'est juste — on ne rejette pas ce qu'on a déjà accepté. Le tableau de `W2.9` savait donc
  // quelque chose que cette boucle ignorait, ce qui est exactement pourquoi elle le traverse au lieu
  // d'écrire ses états à la main.

  const mapped = mapMission({
    mission: offer.mission,
    manifest: ports.manifest(),
    tools: ports.tools(),
    containedWrites: true,
  })
  if (!mapped.ok) {
    // `rejected` et non `failed` : l'admission a dit non **avant** toute exécution, et les deux
    // n'envoient pas chercher au même endroit — l'un un hôte incapable, l'autre un travail qui a
    // mal tourné.
    state = advance(state, "rejected")
    return { status: "refused", refusal: mapped.refusal, phases, state }
  }
  phases.push("plan")
  state = advance(state, "accepted")
  state = advance(state, "preparing")

  // Le rang d'attempt vient du checkpoint quand il existe, du bail sinon. Le demander au bail dans
  // les deux cas ferait repartir une reprise sous un rang neuf, et l'institution y lirait un
  // doublon plutôt qu'une reprise.
  const previous = await ports.resume()
  const resumed = previous !== null && previous.task_id === offer.mission.task_id
  const attempt = resumed ? previous.attempt : offer.lease.attempt

  state = advance(state, "running")
  const report = await ports.openSession(mapped.plan)
  phases.push("session")

  await ports.emit(report.events)
  phases.push("emit")

  state = advance(state, "completing")
  await ports.checkpoint(
    checkpointFor({
      taskId: offer.mission.task_id,
      attempt,
      state,
      report,
      mission: offer.mission,
      at: ports.now(),
    }),
  )

  await ports.report(report, mapped.plan)
  phases.push("report")
  state = advance(state, "completed")

  return {
    status: "ran",
    phases,
    attempt,
    taskId: offer.mission.task_id,
    sessionId: report.sessionId,
    resumed,
    state,
  }
}

/**
 * Le point de reprise d'un tour en cours.
 *
 * `unserializable` est vide **et le dit** : §24.2 exige que ce champ soit rempli de ce qu'on sait,
 * pas laissé de côté. Vide veut dire « rien d'insérialisable », et non « je n'ai pas regardé » —
 * cette boucle ne fait traverser que des données, donc il n'y a effectivement rien.
 */
function checkpointFor(input: {
  taskId: string
  attempt: number
  state: AttemptState
  report: SessionReport
  mission: MissionEnvelope
  at: number
}): Checkpoint {
  return {
    task_id: input.taskId,
    attempt: input.attempt,
    state: input.state,
    session: { session_id: input.report.sessionId, output: input.report.output },
    context_hash: input.mission.context_view.hash,
    worktree: {},
    partial_artifacts: [],
    budget_spent: {},
    next_operations: [],
    unserializable: [],
    through_sequence: input.report.events.length,
    taken_at: new Date(input.at).toISOString(),
  }
}

/**
 * La suite d'états qu'un tour réussi traverse — §11.2, transcrite par `W2.9`.
 *
 * Écrite ici comme un **chemin**, et parcourue par `transition` : la machine à états connaît déjà
 * ce qui est permis, et écrire les états à la main ferait exister deux vérités sur les mêmes
 * transitions. Un chemin qu'elle refuserait ne passe pas les tests.
 */
export const RUN_PATH: readonly AttemptState[] = ["accepted", "preparing", "running", "completing", "completed"]

/**
 * Le chemin d'un refus d'admission — un seul cran, et il part d'`offered`.
 *
 * §11.2 ne permet `rejected` que depuis `offered`, et c'est juste : on ne rejette pas ce qu'on a
 * déjà accepté. Une première rédaction de la boucle acceptait dès la réclamation, et la machine à
 * états l'a démentie.
 */
export const REFUSAL_PATH: readonly AttemptState[] = ["rejected"]

/**
 * Avancer d'un cran, ou refuser bruyamment.
 *
 * Aucun chemin de cette boucle ne peut le faire échouer : `RUN_PATH` et `REFUSAL_PATH` sont
 * parcourus par `canTransition` dans les tests. C'est ce qui rend cette fonction utile plutôt
 * qu'inutile — elle garde la propriété vraie pour le cran suivant qu'on ajoutera.
 *
 * Une première rédaction rendait l'état **inchangé** sur un refus. Une passe de mutation l'a
 * démentie : remplacer tout le corps par `return to` ne faisait rougir aucun test, ce qui voulait
 * dire que passer par §11.2 n'était vérifié nulle part. Le silence était le vrai défaut — un tour
 * aurait continué et écrit un checkpoint portant un état que la boucle n'a pas atteint, envoyant
 * une reprise repartir d'un endroit où rien ne s'était passé.
 *
 * # Errors
 *
 * [`LocusAttemptPathBroken`] quand §11.2 n'autorise pas le cran demandé.
 */
export function advance(from: AttemptState, to: AttemptState): AttemptState {
  if (!transition(from, to).ok) throw new LocusAttemptPathBroken({ from, to })
  return to
}

/**
 * Ce qu'un tour a fait, en clair — le pendant de la valeur que `runLoop` rend déjà.
 *
 * # Le défaut que cette fonction retire
 *
 * `runLoop` rend un [`LoopOutcome`] complet, et son propre commentaire dit pourquoi : « un tour qui
 * n'aurait laissé qu'un log serait indiscernable d'un tour qui n'a rien fait ». La valeur existe
 * donc, et elle est exacte. **Ce qui la reçoit la jetait** : `WorkerCommand` imprimait
 * `worker: ${outcome.status}` et la configuration, jamais l'issue du tour.
 *
 * Conséquence mesurée en montant la chaîne réelle : un worker qui n'a **rien réclamé** — parce
 * qu'aucune mission n'était en file — affiche `worker: ran`. Le mot dit le contraire de ce qui s'est
 * passé, `idle`, `refused` et un tour complet sont indiscernables au terminal, et la seule façon de
 * savoir ce que le worker a fait est de relire le journal du plan de contrôle.
 *
 * C'est la forme exacte que `W5.x` a retirée du côté `locusolus`, dans l'autre sens : là un binaire
 * disait et le harnais jetait, ici la boucle rend et la commande jette.
 *
 * # Pourquoi des lignes plutôt qu'un JSON
 *
 * La configuration est déjà rendue en JSON juste au-dessus, et c'est un objet que l'utilisateur peut
 * aller corriger. Une issue de tour n'est pas éditable : ce qu'on en veut est de la lire. Les lignes
 * restent stables et préfixées, donc un harnais les lit aussi bien qu'un humain.
 */
export function describeOutcome(outcome: LoopOutcome): readonly string[] {
  if (outcome.status === "idle") {
    // La ligne qui manquait le plus. « Rien à réclamer » est un état parfaitement normal — une file
    // vide — et le confondre avec un tour complet envoie chercher un défaut d'exécution là où il n'y
    // a qu'une file vide, ou l'inverse.
    return ["tour : aucune mission à réclamer"]
  }

  if (outcome.status === "refused") {
    return [
      `tour : mission refusée à l'admission — ${outcome.refusal.code}`,
      // Le message humain **et** les détails structurés : §10.3 dit que les seconds sont ce qui
      // décide, et n'imprimer que le premier ferait discuter une phrase.
      `  motif : ${outcome.refusal.message}`,
      `  détails : ${JSON.stringify(outcome.refusal.details)}`,
      `  étapes : ${outcome.phases.join(", ") || "aucune"}`,
      `  état : ${outcome.state}`,
    ]
  }

  return [
    `tour : mission ${outcome.taskId} exécutée`,
    `  attempt : ${outcome.attempt}${outcome.resumed ? " (reprise)" : ""}`,
    `  session : ${outcome.sessionId}`,
    `  étapes : ${outcome.phases.join(", ")}`,
    `  état : ${outcome.state}`,
  ]
}
