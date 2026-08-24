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
}): (plan: SessionPlan) => Promise<SessionReport> {
  return async (plan) => {
    const created = await input.create({ title: sessionTitle(plan), directory: input.directory })
    return {
      sessionId: created.id,
      events: [],
      // Ce que la session a produit se remplira quand `W2.12` sera branché sur un vrai fil ; le
      // laisser vide est exact aujourd'hui, et un champ absent aurait laissé croire que la question
      // ne se pose pas. La session, elle, est bien ouverte — `sessionId` l'atteste.
      output: { plan_task_id: plan.task_id, plan_attempt_id: plan.attempt_id },
    }
  }
}
