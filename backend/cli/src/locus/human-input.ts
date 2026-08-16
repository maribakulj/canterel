import { transition, type AttemptState, type TransitionResult } from "./attempt.ts"
import type { Checkpoint } from "./resume-store.ts"

/**
 * Questions humaines et approvals — `SPEC_V1.md` §22.
 *
 * Trois phrases gouvernent le fichier, et elles disent trois choses différentes.
 *
 * §22.3 : « le worker **ne garde pas un modèle ou processus actif** pendant une longue attente
 * sans nécessité ». Une attente humaine se compte en heures ou en jours, pas en secondes. Garder
 * un container, une réservation GPU ou une session de modèle ouverte pendant ce temps, c'est
 * facturer une ressource rare pour qu'elle ne serve à rien — et l'invariant 6 dit que les
 * ressources sont réservées, pas supposées illimitées.
 *
 * §22.2 : une question porte un « **comportement par défaut sûr** ». Sans lui, une deadline
 * dépassée produit un blocage plutôt qu'une décision, et le blocage arrive au pire moment — quand
 * personne ne regarde.
 *
 * §22.4 : la réponse est « injectée comme **décision externe**, pas comme message de source non
 * fiable ». Le texte libre d'un humain qui répond n'est pas une instruction pour l'agent : c'est
 * une donnée. Ce module ne rend donc jamais du texte à exécuter — il rend l'option choisie parmi
 * celles qui étaient offertes, et refuse tout ce qui n'en fait pas partie.
 */

/** Les sept catégories de §22.1, dans l'ordre du texte. */
export const QUESTION_CATEGORIES = [
  "scientific_precision",
  "incompatible_strategies",
  "external_effect_authorization",
  "budget_extension",
  "classified_source_access",
  "definition_conflict",
  "ethical_or_legal",
] as const

export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number]

/** Une option concrète — §22.2. Concrète veut dire choisissable, donc nommée et conséquencée. */
export type QuestionOption = {
  readonly id: string
  readonly label: string
  /** Ce qui arrive si on la choisit. §22.2 l'exige : une option sans conséquence n'est pas un choix éclairé. */
  readonly consequence: string
}

/** Les sept contenus de §22.2. */
export type HumanQuestion = {
  readonly question_id: string
  readonly task_id: string
  readonly attempt: number
  readonly category: QuestionCategory
  /** La décision demandée, pas le récit de ce qui a mené à la poser. */
  readonly decision: string
  /** Contexte **minimal** : ce qu'il faut pour décider, et pas le transcript. */
  readonly context: string
  readonly options: readonly QuestionOption[]
  readonly recommendation?: string
  readonly deadline: string
  /**
   * Le comportement par défaut sûr — §22.2.
   *
   * Obligatoire, et il doit désigner une des options. Un défaut hors liste serait un comportement
   * que personne n'a relu ; un défaut absent transforme la deadline en blocage.
   */
  readonly safe_default: string
}

/**
 * Ce qui manque à une question — §22.2.
 *
 * Rend des constats plutôt que de lever : une question se corrige mieux avec la liste complète.
 */
export function questionFindings(question: HumanQuestion): readonly string[] {
  const findings: string[] = []
  if (question.decision.trim().length === 0) findings.push("décision demandée vide")
  if (question.options.length < 2) {
    // Une seule option n'est pas un choix : c'est une notification déguisée en question, et elle
    // fera attendre un humain pour rien.
    findings.push("moins de deux options : une question à une seule issue n'en est pas une")
  }
  for (const option of question.options) {
    if (option.consequence.trim().length === 0) {
      findings.push(`option \`${option.id}\` sans conséquence déclarée`)
    }
  }
  if (Number.isNaN(Date.parse(question.deadline))) findings.push("deadline illisible")
  if (!question.options.some((option) => option.id === question.safe_default)) {
    findings.push(
      `le défaut sûr \`${question.safe_default}\` ne figure pas parmi les options : un défaut hors liste est un comportement que personne n'a relu`,
    )
  }
  const ids = question.options.map((option) => option.id)
  for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) {
    findings.push(`identifiant d'option \`${id}\` en double`)
  }
  return findings
}

/**
 * Une ressource que l'attente coûterait cher à garder.
 *
 * `holdReason` est le seul moyen d'en garder une, et il est **obligatoire pour la garder**. §22.3
 * dit « sans nécessité » : la nécessité doit donc s'écrire, sinon tout se libère. Prendre la règle
 * dans l'autre sens — garder par défaut, libérer sur demande — ferait qu'une ressource ajoutée
 * demain serait retenue par défaut pendant une attente de trois jours.
 */
export type CostlyResource = {
  readonly id: string
  readonly kind: "model_session" | "gpu_reservation" | "sandbox_container" | "subprocess" | "connection" | "other"
  /** Ce que garder coûte, dans l'unité qui a du sens pour ce type. Sert au diagnostic, pas à la décision. */
  readonly cost_hint?: string
  /**
   * La raison de garder, quand il y en a une. Absente = libérée.
   *
   * Une raison recevable est une nécessité, pas une commodité : « le relancer prendra deux
   * minutes » n'en est pas une quand l'attente se compte en heures.
   */
  readonly holdReason?: string
}

export type ReleasePlan = {
  readonly release: readonly string[]
  readonly hold: readonly { readonly id: string; readonly reason: string }[]
  /** Vrai quand rien de coûteux n'est gardé sans nécessité déclarée. C'est le test de sortie. */
  readonly clean: boolean
}

/**
 * Ce qu'il faut libérer avant d'attendre — §22.3.
 *
 * Tout se libère, sauf ce qui déclare une nécessité. Le plan est rendu plutôt qu'exécuté : ce
 * module décide, l'exécuteur agit, et les tests peuvent vérifier la décision sans lancer de
 * container.
 */
export function releasePlan(resources: readonly CostlyResource[]): ReleasePlan {
  const release: string[] = []
  const hold: { id: string; reason: string }[] = []
  for (const resource of resources) {
    const reason = resource.holdReason?.trim() ?? ""
    if (reason.length === 0) {
      release.push(resource.id)
      continue
    }
    hold.push({ id: resource.id, reason })
  }
  return { release, hold, clean: hold.length === 0 }
}

export type SuspensionResult =
  | {
      readonly ok: true
      readonly state: AttemptState
      readonly checkpoint: Checkpoint
      readonly plan: ReleasePlan
      readonly question: HumanQuestion
    }
  | { readonly ok: false; readonly reason: string; readonly findings?: readonly string[] }

/**
 * Suspendre pour attendre un humain — §22.3.
 *
 * Trois gestes, dans cet ordre : passer en `waiting_human`, produire un checkpoint, libérer les
 * ressources coûteuses. L'ordre compte — libérer avant de checkpointer perdrait ce que la
 * ressource tenait encore, et le checkpoint serait celui d'un état déjà démoli.
 *
 * La question est validée **avant** la suspension. Suspendre sur une question malformée ferait
 * attendre un humain devant un écran qui ne lui demande rien de décidable.
 */
export function suspendForHuman(input: {
  readonly from: AttemptState
  readonly question: HumanQuestion
  readonly checkpoint: Checkpoint
  readonly resources: readonly CostlyResource[]
}): SuspensionResult {
  const findings = questionFindings(input.question)
  if (findings.length > 0) {
    return { ok: false, reason: "question malformée (§22.2)", findings }
  }

  const moved: TransitionResult = transition(input.from, "waiting_human")
  if (!moved.ok) return { ok: false, reason: moved.reason }

  const checkpoint: Checkpoint = { ...input.checkpoint, state: "waiting_human" }
  return {
    ok: true,
    state: moved.state,
    checkpoint,
    plan: releasePlan(input.resources),
    question: input.question,
  }
}

/**
 * Une décision venue de l'extérieur — §22.4.
 *
 * `option_id` et non du texte : « injectée comme décision externe, pas comme message de source non
 * fiable » veut dire que ce qui entre dans l'exécution est un **choix parmi ceux qui étaient
 * offerts**, pas une consigne rédigée par qui répond. Le champ `note` existe pour que l'humain
 * puisse s'expliquer, et il est explicitement marqué comme donnée : rien ne l'interprète.
 */
export type ExternalDecision = {
  readonly question_id: string
  readonly option_id: string
  readonly origin: "human"
  readonly decided_at: string
  /** Vrai quand personne n'a répondu et que le défaut sûr s'est appliqué. Jamais silencieux. */
  readonly defaulted?: true
  /** Texte libre du répondant. **Donnée, jamais instruction.** */
  readonly note?: string
}

export type ResponseResult =
  | { readonly ok: true; readonly decision: ExternalDecision }
  | { readonly ok: false; readonly reason: string }

/**
 * Accepter une réponse humaine — §22.4.
 *
 * Deux refus, et les deux comptent.
 *
 * La **corrélation** d'abord : une réponse qui ne désigne pas la question posée est une réponse à
 * autre chose, et l'appliquer reviendrait à laisser un tiers décider d'une question qu'il n'a pas
 * vue. §22.4 l'exige explicitement.
 *
 * L'**option** ensuite : une réponse qui ne choisit pas parmi les options offertes n'est pas une
 * décision, c'est une suggestion. L'accepter ferait entrer dans l'exécution un comportement que
 * la question n'avait pas décrit — donc dont personne n'a lu les conséquences.
 */
export function acceptResponse(
  question: HumanQuestion,
  response: { readonly question_id: string; readonly option_id: string; readonly note?: string; readonly at: string },
): ResponseResult {
  if (response.question_id !== question.question_id) {
    return {
      ok: false,
      reason: `réponse non corrélée : elle porte \`${response.question_id}\`, la question est \`${question.question_id}\` (§22.4)`,
    }
  }
  if (!question.options.some((option) => option.id === response.option_id)) {
    return {
      ok: false,
      reason: `\`${response.option_id}\` ne figure pas parmi les options offertes : une réponse hors liste n'est pas une décision`,
    }
  }
  return {
    ok: true,
    decision: {
      question_id: question.question_id,
      option_id: response.option_id,
      origin: "human",
      decided_at: response.at,
      ...(response.note === undefined ? {} : { note: response.note }),
    },
  }
}

/**
 * Ce qui se passe quand la deadline tombe sans réponse — §22.2, « comportement par défaut sûr ».
 *
 * `defaulted: true` n'est pas décoratif. Une décision par défaut qui ne se déclare pas est lue
 * comme un choix humain, et le premier à s'en apercevoir sera celui qui cherchera qui a décidé.
 * Même règle que le résultat tardif de §11.4, le commit tardif de §21.6 et le commit partiel de
 * §24.4 : ce qui n'est pas ce qu'il paraît le dit.
 *
 * Rend `null` avant la deadline : le défaut ne s'applique pas par impatience.
 */
export function applyDeadline(question: HumanQuestion, now: number): ExternalDecision | null {
  const deadline = Date.parse(question.deadline)
  // Une deadline illisible n'est pas une deadline dépassée. `questionFindings` la refuse déjà en
  // amont ; ici, ne rien décider est le comportement prudent.
  if (Number.isNaN(deadline) || now < deadline) return null
  return {
    question_id: question.question_id,
    option_id: question.safe_default,
    origin: "human",
    decided_at: new Date(now).toISOString(),
    defaulted: true,
  }
}

/**
 * La charge d'un `human.input.requested` — §18.2.
 *
 * Le contexte n'y est pas recopié : §22.2 demande un contexte **minimal**, et l'événement le
 * transporte tel quel plutôt que de l'enrichir. Ce qui figure en plus, c'est ce que l'attente
 * coûte — le plan de libération — parce qu'une demande humaine qui tairait les ressources encore
 * tenues laisserait croire que l'attente est gratuite.
 */
export function humanInputPayload(result: Extract<SuspensionResult, { ok: true }>): Record<string, unknown> {
  return {
    question_id: result.question.question_id,
    category: result.question.category,
    decision: result.question.decision,
    context: result.question.context,
    options: result.question.options.map((option) => ({ ...option })),
    ...(result.question.recommendation === undefined ? {} : { recommendation: result.question.recommendation }),
    deadline: result.question.deadline,
    safe_default: result.question.safe_default,
    released: [...result.plan.release],
    held: result.plan.hold.map((entry) => ({ ...entry })),
  }
}
