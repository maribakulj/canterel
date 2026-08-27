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
 * La clé d'idempotence que porte **chaque** enveloppe — §15.2, `W2.26`.
 *
 * # Ce que le worker n'envoyait pas, et ce que ça coûtait
 *
 * §15.2, en toutes lettres : « toutes les enveloppes portent version de protocole, sequence,
 * correlation IDs et **idempotency key** ». Les trois enveloppes de ce client n'en portaient
 * aucune, et `CommandEnvelope::mutating` côté plan de contrôle refuse une clé vide.
 *
 * Le défaut ne se voyait pas, et pour une raison précise : `locusd` ne construit sa commande que
 * lorsqu'il a **quelque chose à écrire**. Une réclamation qui ne trouve aucune mission plaçable
 * répond `204` avant d'en arriver là. Tant qu'aucune mission n'était plaçable — et aucune ne l'était,
 * les trois clauses précédentes de `W12.d` le montrent — la réclamation semblait fonctionner. La
 * **première** mission réellement plaçable a rendu `400 : validation — « idempotency_key » : vide`,
 * et le tour est mort sur place.
 *
 * # Une seule clé est inventée, les deux autres sont **dérivées**
 *
 * C'est la leçon de `W20.x`, où le même trou s'était présenté à l'enrôlement : le daemon y a pris le
 * **nonce** comme clé, parce que le worker avait déjà envoyé ce qu'il fallait sous un autre nom.
 * Exiger une valeur de plus quand une identité naturelle existe donne deux valeurs pour une
 * garantie, et la moins sûre des deux.
 *
 * - **`result`** : reporter deux fois le même attempt **est** le même acte. La clé le dit —
 *   `result:<task>:<attempt>:<session>` — et une reprise qui rejoue son rapport ne produit pas un
 *   second fait.
 * - **`events`** : chaque `Event` porte déjà son `idempotency_key` (§18.2). L'enveloppe reprend
 *   celui du **premier** du lot : retransmettre le même lot est le même acte, et rien n'est inventé.
 * - **`claim`** : rien dans le corps n'identifie l'acte — ni le `worker_id`, qui est le même à
 *   chaque tour, ni le manifeste, qui peut l'être. C'est le seul endroit où une valeur neuve est
 *   nécessaire, et le seul où elle est produite.
 */
export type IdempotencyKey = string

/** D'où vient la clé neuve de la réclamation. Un port, pour qu'un test la rende prévisible. */
export type KeySource = () => IdempotencyKey

/** La clé d'un rapport : son acte, pas son instant. */
export function resultKey(taskId: string, attemptId: string, sessionId: string): IdempotencyKey {
  return `result:${taskId}:${attemptId}:${sessionId}`
}

/**
 * La clé d'un lot d'événements : celle de son premier.
 *
 * Le lot vide n'atteint jamais le réseau — [`workerPorts`] rend la main avant —, donc l'absence de
 * premier événement ne se produit pas par le chemin normal. Elle est traitée quand même, et
 * **bruyamment** : rendre une clé vide ferait refuser l'envoi par le serveur avec un message parlant
 * de la clé là où le défaut serait dans le lot.
 */
export function eventsKey(events: readonly Event[]): IdempotencyKey {
  const premier = events[0]
  if (premier === undefined) throw new Error("lot d'événements vide : aucune clé à en dériver")
  return `events:${premier.idempotency_key}`
}

/** Au-delà, un refus n'explique plus rien : il remplit un journal. */
const REFUSAL_EXCERPT = 400

/**
 * Ce qu'un refus dit de lui-même — §22.5.
 *
 * # Pourquoi le corps est lu, et pas seulement le statut
 *
 * Le plan de contrôle refuse de façon **typée** : `{ "family": "validation", "detail": "« project_id »
 * : sans projet, un fait n'a pas d'endroit où appartenir" }`. Jeter ce corps pour ne garder que
 * « réponse 400 » revient à transformer un diagnostic complet en une invitation à chercher.
 *
 * Ce n'est pas une hypothèse : la première réclamation d'un worker réel contre un `locusd` réel a
 * échoué exactement ainsi, et il a fallu **rejouer la requête à la main** pour lire ce que le
 * serveur avait déjà dit du premier coup. Le worker avait la phrase entre les mains et l'a jetée.
 *
 * # Trois précautions, et chacune a sa raison
 *
 * - le corps est **borné**. Un serveur mal en point peut répondre une page entière ; un refus qui
 *   remplit un journal ne s'y lit plus ;
 * - un corps illisible ne devient pas une seconde panne. Ce qui est demandé ici est un
 *   renseignement ; échouer à l'obtenir laisse le statut, qui reste vrai ;
 * - un corps qui n'est **pas** du JSON typé est repris tel quel, tronqué. Un serveur intermédiaire —
 *   un proxy, une passerelle — répond en HTML, et cet HTML dit souvent lequel des deux a refusé.
 */
async function refusalReason(response: Response): Promise<string> {
  const statut = `réponse ${response.status}`
  const corps = await response.text().catch(() => "")
  if (corps.trim() === "") return statut

  const probleme = ((): string | undefined => {
    try {
      const lu: unknown = JSON.parse(corps)
      if (typeof lu !== "object" || lu === null) return undefined
      const { family, detail } = lu as { family?: unknown; detail?: unknown }
      if (typeof family !== "string" || typeof detail !== "string") return undefined
      return `${family} — ${detail}`
    } catch {
      return undefined
    }
  })()

  const dit = probleme ?? corps.trim()
  return `${statut} : ${dit.length > REFUSAL_EXCERPT ? `${dit.slice(0, REFUSAL_EXCERPT)}…` : dit}`
}

/**
 * Un appel LEP, sous la politique de §7.3.
 *
 * Rend `null` sur `204` — « rien », qui n'est pas une panne. Lève [`LocusServerRejected`] sur tout
 * le reste : redirection, statut non-`ok`, origine changée. Un refus porte **ce que le serveur en a
 * dit** — voir [`refusalReason`].
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
      throw new LocusServerRejected({ endpoint: target, reason: await refusalReason(response) })
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
  /**
   * D'où vient la clé neuve de la réclamation — `W2.26`.
   *
   * Facultatif : `crypto.randomUUID` par défaut, ce qu'un worker réel veut. Un test l'injecte pour
   * lire la clé qui est **partie**, et non celle qu'il aurait devinée.
   */
  readonly newKey?: KeySource
}

/**
 * Assembler les ports que la boucle attend.
 *
 * `manifest`, `tools` et `openSession` sont **passés** plutôt que construits ici : les deux premiers
 * dépendent de l'hôte, le troisième de l'amont, et ce module ne connaît que le transport. Les
 * fabriquer ici ferait de lui un composition root, ce qu'il n'a pas à être.
 */
export function workerPorts(input: ClientInput): WorkerPorts {
  const newKey = input.newKey ?? (() => crypto.randomUUID())
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
        // La seule clé **neuve** des trois enveloppes : rien dans ce corps n'identifie l'acte, le
        // `worker_id` étant le même à chaque tour et le manifeste pouvant l'être. Voir
        // [`IdempotencyKey`].
        idempotency_key: newKey(),
        worker_id: input.credential.worker_id,
        manifest: input.manifest(),
      })
      return answer === null ? null : (answer as Offer)
    },
    emit: async (events: readonly Event[]) => {
      // Rien à dire est un fait, pas un appel : un `POST` vide à chaque tour ferait du bruit pour
      // rien et rendrait un journal de serveur illisible.
      if (events.length === 0) return
      await call(EVENTS_PATH, { idempotency_key: eventsKey(events), events })
    },
    report: async (report: SessionReport, plan: SessionPlan) => {
      await call(RESULT_PATH, {
        idempotency_key: resultKey(plan.task_id, plan.attempt_id, report.sessionId),
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
