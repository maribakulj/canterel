/**
 * Les ports du worker, sur le transport HTTP — `W2.21`.
 *
 * # Ce que cet item ajoute, et ce qu'il n'ajoute pas
 *
 * `W2.20` a livré la boucle et l'ouvreur de session : complets, testés, et **sans appelant**. Ce
 * module est l'appelant. Il ne change rien à la boucle — c'est le point d'un port.
 *
 * # La politique de transport n'est pas réécrite
 *
 * Aucune redirection suivie, une origine validée, un délai borné : ce sont les règles de §7.3 que
 * `httpEnrollmentTransport` applique déjà, et les redire ici en produirait une seconde version qui
 * divergerait. [`lepCall`] est donc la fonction unique par laquelle tout ce module parle.
 *
 * La leçon vient de `xiiif` : suivre une redirection laisse le serveur choisir la destination
 * **après** que la politique a été appliquée à l'URL d'origine. Un jeton de worker suit ce chemin.
 *
 * # « Rien pour toi » n'est pas « je n'ai pas pu demander »
 *
 * Un `204` — pas de mission — rend `null`, et la boucle en fait un tour `idle`. Une panne de
 * transport **lève**. Les deux envoient chercher à des endroits opposés : l'un un ordonnanceur qui
 * n'a rien à donner, l'autre un lien cassé. C'est la même séparation que l'ADR 0028 décision 4 tient
 * pour le broker de `locusolus`, et elle vaut ici pour la même raison.
 *
 * Depuis `W20.q`, le serveur tient l'autre moitié : un broker de placement injoignable rend `503`,
 * jamais `204`. Ce client n'a rien à changer pour ça — un `503` lève déjà — et c'est le point :
 * la séparation était écrite ici avant d'exister là-bas.
 */

import { assertEndpointAcceptable, sameOrigin, type Credential } from "./auth.ts"
import { DEFAULT_TIMEOUT_MS, type FetchLike } from "./connection.ts"
import { LocusResumeUnreadable, LocusServerRejected } from "./errors.ts"
import type { Event } from "./lep/generated.ts"
import type { ResumeStore } from "./resume-store.ts"
import type { SessionPlan } from "./session-map.ts"
import type { Offer, SessionReport, WorkerPorts } from "./worker-loop.ts"

/** Les chemins LEP que ce client emploie — §15.2, mode pull. */
export const CLAIM_PATH = "/lep/v1/claim"
export const EVENTS_PATH = "/lep/v1/events"
export const RESULT_PATH = "/lep/v1/result"

/**
 * Un appel LEP, sous la politique de §7.3.
 *
 * Rend `null` sur `204` — « rien », qui n'est pas une panne. Lève [`LocusServerRejected`] sur tout
 * le reste : redirection, statut non-`ok`, origine changée.
 *
 * # Errors
 *
 * [`LocusServerRejected`] quand le serveur refuse, redirige, ou répond hors des codes admis.
 */
export async function lepCall(input: {
  readonly endpoint: string
  readonly path: string
  readonly fetch: FetchLike
  readonly credential: Credential
  readonly body?: unknown
  readonly timeoutMs?: number
}): Promise<unknown | null> {
  const base = assertEndpointAcceptable(input.endpoint)
  const target = new URL(input.path, base).toString()
  if (!sameOrigin(target, input.endpoint)) {
    throw new LocusServerRejected({ endpoint: target, reason: "changement d'origine (§7.3)" })
  }

  const controller = new AbortController()
  const budget = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), budget)
  try {
    const response = await input
      .fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Le secret du worker, jamais journalisé — `describeConfig` le rédige déjà partout ailleurs.
          authorization: `Bearer ${input.credential.credential}`,
        },
        body: JSON.stringify(input.body ?? {}),
        redirect: "manual",
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        // Un serveur qui ne répond jamais est une panne comme une autre pour l'appelant : lui rendre
        // l'`AbortError` brut ferait deux formes d'échec de transport là où la boucle n'en distingue
        // qu'une. Le motif, lui, reste dans `reason` — un worker qui expire n'envoie pas chercher au
        // même endroit qu'un worker refusé.
        if (controller.signal.aborted) {
          throw new LocusServerRejected({ endpoint: target, reason: `délai de ${budget} ms dépassé (§7.3)` })
        }
        throw error
      })

    if (response.status >= 300 && response.status < 400) {
      throw new LocusServerRejected({ endpoint: target, reason: `redirection ${response.status} refusée (§7.3)` })
    }
    // `204` est la façon dont le plan de contrôle dit « rien pour toi ». Le traiter comme une panne
    // ferait chercher un lien cassé là où il n'y a que du calme.
    if (response.status === 204) return null
    if (!response.ok) {
      throw new LocusServerRejected({ endpoint: target, reason: `réponse ${response.status}` })
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Ce qu'il faut pour construire les ports HTTP d'un worker. */
export type ClientInput = {
  readonly endpoint: string
  readonly fetch: FetchLike
  readonly credential: Credential
  readonly store: ResumeStore
  readonly manifest: WorkerPorts["manifest"]
  readonly tools: WorkerPorts["tools"]
  readonly openSession: WorkerPorts["openSession"]
  readonly timeoutMs?: number
}

/**
 * Assembler les ports que la boucle attend.
 *
 * `manifest`, `tools` et `openSession` sont **passés** plutôt que construits ici : les deux premiers
 * dépendent de l'hôte, le troisième de l'amont, et ce module ne connaît que le transport. Les
 * fabriquer ici ferait de lui un composition root, ce qu'il n'a pas à être.
 */
export function workerPorts(input: ClientInput): WorkerPorts {
  const call = (path: string, body?: unknown) =>
    lepCall({
      endpoint: input.endpoint,
      path,
      fetch: input.fetch,
      credential: input.credential,
      body,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })

  return {
    now: () => Date.now(),
    manifest: input.manifest,
    tools: input.tools,
    openSession: input.openSession,
    claim: async () => {
      // Le manifeste part **à chaque réclamation**, et non une fois au handshake — `W20.q`.
      //
      // §15.3 le fait annoncer au handshake, et le hello de `W2.7` n'en porte que le *hash*. Mais un
      // inventaire vieillit : un disque se remplit, un accélérateur disparaît, et `capability-watch`
      // existe justement parce que ça arrive. Un manifeste figé à l'enrôlement ferait placer une
      // mission sur de l'espace disque qui n'existe plus.
      //
      // Ce qu'il ne dit pas, et ne doit pas dire : **qui** parle. C'est la créance qui le dit, et le
      // plan de contrôle refuse un manifeste au nom d'un autre worker plutôt que de l'ignorer.
      const answer = await call(CLAIM_PATH, {
        worker_id: input.credential.worker_id,
        manifest: input.manifest(),
      })
      return answer === null ? null : (answer as Offer)
    },
    emit: async (events: readonly Event[]) => {
      // Rien à dire est un fait, pas un appel : un `POST` vide à chaque tour ferait du bruit pour
      // rien et rendrait un journal de serveur illisible.
      if (events.length === 0) return
      await call(EVENTS_PATH, { events })
    },
    report: async (report: SessionReport, plan: SessionPlan) => {
      await call(RESULT_PATH, {
        task_id: plan.task_id,
        attempt_id: plan.attempt_id,
        session_id: report.sessionId,
        output: report.output,
      })
    },
    checkpoint: async (checkpoint) => {
      input.store.save(checkpoint)
    },
    // `null` veut dire « pas de checkpoint », jamais « je n'ai pas su le lire ». Un checkpoint en
    // quarantaine dit qu'un travail était en cours et que son état est perdu : le rendre `null`
    // ferait repartir sous un rang de tentative neuf, c'est-à-dire produire le doublon que §15.5
    // existe pour empêcher. Une ignorance n'est pas une absence.
    resume: async () => {
      const loaded = input.store.load()
      if (loaded.ok) return loaded.checkpoint
      if (loaded.outcome === "absent") return null
      throw new LocusResumeUnreadable({
        reason: loaded.reason,
        ...(loaded.movedTo === undefined ? {} : { movedTo: loaded.movedTo }),
      })
    },
  }
}
