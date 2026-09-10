/**
 * Ouvrir une session amont à partir d'un plan — `W2.20`, ADR 0010.
 *
 * # La couture, et pourquoi elle passe par un paramètre
 *
 * `src/locus/**` n'importe **rien** de `src/session/`, et ce n'est pas de la timidité : c'est ce qui
 * fait qu'une refonte amont ne casse rien ici. Le créateur de session est donc **passé** —
 * `src/cli/cmd/worker.ts`, la couture déclarée dans `LOCUS_SEAMS`, lui donne `Session.createNext`.
 *
 * Ce que ce module ajoute par rapport à un appel direct : la traduction du plan vers ce qu'attend
 * l'amont, et surtout la **borne** — un plan entre, un compte rendu de données sort, et rien
 * d'autre ne traverse. Un module qui rendrait l'objet de session amont ferait entrer sa forme dans
 * tout ce qui l'appelle, et la couture cesserait d'être une couture.
 *
 * # Ce que le compte rendu ne porte pas
 *
 * Ni handle, ni promesse, ni fonction. `sessionId` est ce qui prouve qu'une session **a réellement
 * été créée** : sans lui, un appelant ne pourrait pas distinguer une session ouverte d'un plan
 * simplement accepté.
 */

import type { SessionPlan } from "./session-map.ts"
import type { SessionReport } from "./worker-loop.ts"
import type { Usage } from "./usage-meter.ts"

/**
 * Ce que l'amont doit savoir faire pour qu'une session s'ouvre.
 *
 * Volontairement plus étroit que `Session.createNext` : ce que ce module n'emploie pas ne peut pas
 * se mettre à en dépendre. Le champ `permission` est absent pour la même raison — `W2.11` a établi
 * que la politique d'outils vit dans le plan, et la faire aussi voyager ici créerait deux vérités.
 */
export type SessionCreator = (input: {
  readonly title: string
  readonly directory: string
}) => Promise<{ readonly id: string }>

/**
 * Ce qui fait travailler une session ouverte, et rend ce qu'elle a dépensé.
 *
 * # La couture reste une frontière de données — ADR 0010
 *
 * Le plan entre, des observations sortent. Aucun handle de session, aucun message, aucun objet
 * amont : `src/locus/**` n'importe rien de `src/session/**`, et c'est cette règle qui permet à une
 * refonte amont de ne rien casser ici.
 *
 * # C'est l'amont qui arrête, et il a de quoi
 *
 * Le plan porte `budget`. §17.4 veut un « arrêt **sûr** au plafond », ce qui suppose de décider
 * **entre** deux appels de modèle — un endroit auquel cette couche n'a pas accès, puisqu'elle ne
 * voit que le début et la fin. L'arrêt appartient donc à l'implémentation, et ce qui remonte ici
 * est le compte de ce qui a été dépensé, pas la permission de le dépenser.
 */
export type SessionRunner = (input: {
  readonly sessionId: string
  readonly plan: SessionPlan
}) => Promise<{
  readonly output: Record<string, unknown>
  readonly usages: readonly Usage[]
}>

/**
 * Le titre que porte une session ouverte pour une mission.
 *
 * Il nomme la tâche **et** la tentative : deux tentatives d'une même tâche produisent deux sessions,
 * et un titre qui ne porterait que la tâche les rendrait indiscernables dans une liste — ce qui est
 * précisément ce qu'on regarde quand une reprise s'est mal passée.
 */
export function sessionTitle(plan: SessionPlan): string {
  return `locus ${plan.task_id} — ${plan.attempt_id}`
}

/**
 * Construire l'ouvreur de session que la boucle attend.
 *
 * # Errors
 *
 * Laisse remonter ce que le créateur lève. Une session qui ne s'ouvre pas est un fait dont la boucle
 * doit s'arrêter : l'avaler ici rendrait un compte rendu vide, et un tour qui rapporte un résultat
 * sans session serait pire qu'un tour interrompu.
 */
export function sessionOpener(input: {
  readonly create: SessionCreator
  readonly directory: string
  /**
   * Ce qui fait **travailler** la session.
   *
   * Facultatif, et c'est ce qui garde ce module utilisable sans amont : sans lui, la session est
   * ouverte et rien n'est demandé, ce qui était le comportement entier jusqu'ici. La différence
   * avec avant est qu'elle se lit maintenant dans le rapport — `usages: []` sur une session qui n'a
   * rien dépensé, contre l'absence de la question.
   */
  readonly run?: SessionRunner
}): (plan: SessionPlan) => Promise<SessionReport> {
  return async (plan) => {
    const created = await input.create({ title: sessionTitle(plan), directory: input.directory })
    if (!input.run) {
      return {
        sessionId: created.id,
        events: [],
        usages: [],
        output: { plan_task_id: plan.task_id, plan_attempt_id: plan.attempt_id },
      }
    }
    const done = await input.run({ sessionId: created.id, plan })
    return {
      sessionId: created.id,
      events: [],
      usages: done.usages,
      output: { plan_task_id: plan.task_id, plan_attempt_id: plan.attempt_id, ...done.output },
    }
  }
}
