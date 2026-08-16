import { assertEndpointAcceptable, sameOrigin, type EnrollmentTransport } from "./auth.ts"
import { LocusServerRejected } from "./errors.ts"
import type { LocusConfig } from "./config.ts"

/**
 * Le transport vers `locusd` — §7.3, et la politique de reconnexion de §6.
 *
 * Deux choses seulement, mais les deux ont un fond de sécurité.
 *
 * **Aucune redirection n'est suivie.** `fetch` suit les redirections par défaut ; ici `redirect`
 * vaut `"manual"`, et un `3xx` est un refus. C'est la leçon payée dans `xiiif` : suivre une
 * redirection, c'est laisser le serveur choisir la destination **après** que la politique a été
 * appliquée à l'URL d'origine. §7.3 le dit sans détour — « les redirections et changements
 * d'origine sont refusés par défaut ». Un token d'enrôlement suit ce chemin ; il ne doit pas
 * partir vers un hôte que personne n'a validé.
 *
 * **Le backoff est borné et gigué.** §6 donne `initial_ms`, `max_ms` et `jitter`. Sans gigue, tous
 * les workers d'un parc reviennent en même temps après une panne du serveur et le remettent par
 * terre au moment où il se relève.
 */

/** Un délai d'attente par défaut, pour qu'aucun appel ne puisse pendre indéfiniment. */
export const DEFAULT_TIMEOUT_MS = 30_000

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Construire le transport d'enrôlement de W2.4 sur un `fetch` réel.
 *
 * `fetch` est **injecté** plutôt qu'importé : c'est ce qui permet de tester la politique — refus
 * de redirection, refus de changement d'origine, délai — sans serveur ni réseau, et sans
 * remplacer une globale pendant les tests.
 */
export function httpEnrollmentTransport(input: {
  readonly endpoint: string
  readonly fetch: FetchLike
  readonly timeoutMs?: number
}): EnrollmentTransport {
  const base = assertEndpointAcceptable(input.endpoint)
  const target = new URL("/lep/v1/enroll", base).toString()

  return async (request) => {
    // Le chemin construit doit rester sur l'origine validée. `new URL` avec un chemin absolu ne
    // peut pas en sortir, mais le vérifier coûte une ligne et documente l'invariant.
    if (!sameOrigin(target, input.endpoint)) {
      throw new LocusServerRejected({ endpoint: target, reason: "changement d'origine (§7.3)" })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await input.fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "manual",
        signal: controller.signal,
      })

      // `redirect: "manual"` rend un statut 3xx au lieu de suivre. Le refuser est le point :
      // suivre laisserait le serveur choisir la destination après coup.
      if (response.status >= 300 && response.status < 400) {
        throw new LocusServerRejected({
          endpoint: target,
          reason: `redirection ${response.status} refusée (§7.3)`,
        })
      }
      if (!response.ok) {
        throw new LocusServerRejected({ endpoint: target, reason: `réponse ${response.status}` })
      }
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Le délai avant la n-ième tentative de reconnexion — §6.
 *
 * Exponentiel, plafonné à `max_ms`, et gigué vers le **bas** seulement : un délai tiré entre la
 * moitié et la totalité du délai nominal reste borné par ce que la configuration autorise. Giguer
 * vers le haut ferait dépasser `max_ms`, c'est-à-dire ignorer la seule limite que l'opérateur a
 * écrite.
 *
 * `random` est un paramètre, pour que le test porte sur la formule et non sur une graine.
 */
export function reconnectDelay(config: LocusConfig, attempt: number, random: () => number = Math.random): number {
  const { initial_ms, max_ms, jitter } = config.reconnect
  const exponential = Math.min(max_ms, initial_ms * 2 ** Math.max(0, attempt))
  if (!jitter) return exponential
  return Math.round(exponential * (0.5 + random() * 0.5))
}

/** Le nombre de tentatives avant que le délai atteigne son plafond — utile pour rendre compte. */
export function attemptsToCeiling(config: LocusConfig): number {
  const { initial_ms, max_ms } = config.reconnect
  if (initial_ms >= max_ms) return 0
  return Math.ceil(Math.log2(max_ms / initial_ms))
}
