import type { Lease } from "./lep/generated.ts"

/**
 * Les leases — `SPEC_V1.md` §11.4 et la règle de rythme que le schéma ne savait pas exprimer.
 *
 * Une lease est un droit **daté** d'exécuter. Tout ce module tient dans une idée : le worker ne
 * décide pas de sa validité, il l'observe. L'horloge est donc un **paramètre** partout, jamais un
 * `Date.now()` caché — sans quoi ces règles ne se testeraient qu'en dormant, et un test qui dort
 * finit désactivé.
 */

/** Le rapport de rythme exigé : battre strictement plus souvent qu'un tiers du TTL. */
export const HEARTBEAT_TTL_RATIO = 3

/**
 * Vérifier qu'une lease est tenable avant de l'accepter.
 *
 * La règle est une relation entre deux champs, hors de portée d'un schéma Draft 7 : le harnais de
 * conformance de W0.9 la vérifie côté serveur, ce module la vérifie côté worker. `>=` et non `>` :
 * un tiers pile n'est pas *inférieur* à un tiers, et un worker qui bat exactement trois fois par
 * TTL n'a aucune marge — le premier battement en retard fait expirer la lease.
 */
export function leaseTimingFindings(lease: Lease): readonly string[] {
  const findings: string[] = []
  if (lease.ttl_seconds <= 0) findings.push("ttl_seconds doit être strictement positif")
  if (lease.heartbeat_interval_seconds <= 0) {
    findings.push("heartbeat_interval_seconds doit être strictement positif")
  }
  if (lease.heartbeat_interval_seconds * HEARTBEAT_TTL_RATIO >= lease.ttl_seconds) {
    findings.push(
      `intervalle de ${lease.heartbeat_interval_seconds}s pour un TTL de ${lease.ttl_seconds}s : ` +
        "il faut strictement moins du tiers",
    )
  }
  return findings
}

/** L'échéance observée, en millisecondes epoch. `NaN` si la date est illisible. */
export function deadlineOf(lease: Lease): number {
  return Date.parse(lease.expires_at)
}

/** Vrai quand la lease est expirée à l'instant donné. L'instant est fourni, jamais lu. */
export function isExpired(lease: Lease, now: number): boolean {
  const deadline = deadlineOf(lease)
  // Une échéance illisible est traitée comme expirée. Le contraire — « je ne sais pas lire la
  // date, donc je continue » — est exactement la posture qui fait produire un résultat après la
  // fin d'un droit d'exécuter.
  if (Number.isNaN(deadline)) return true
  return now >= deadline
}

/** Le temps restant en millisecondes, jamais négatif. */
export function remainingMs(lease: Lease, now: number): number {
  const deadline = deadlineOf(lease)
  if (Number.isNaN(deadline)) return 0
  return Math.max(0, deadline - now)
}

/**
 * Vrai quand il est temps de battre.
 *
 * `lastBeatAt` vaut `null` tant qu'aucun battement n'a eu lieu : il faut alors battre tout de
 * suite. Traiter « jamais battu » comme « battu à l'instant » ferait attendre un intervalle
 * complet avant le premier signe de vie, ce qui est la moitié d'un TTL de retard pour rien.
 */
export function heartbeatDue(lease: Lease, lastBeatAt: number | null, now: number): boolean {
  if (lastBeatAt === null) return true
  return now - lastBeatAt >= lease.heartbeat_interval_seconds * 1000
}

/**
 * Les gestes imposés par §11.4 après une perte de lease.
 *
 * Énumérés dans l'ordre du texte, et rendus comme données plutôt qu'exécutés ici : ce module ne
 * sait ni révoquer un secret ni arrêter un appel, et prétendre le contraire mettrait la politique
 * et sa mise en œuvre au même endroit. L'appelant les applique ; la liste, elle, se relit et se
 * teste.
 */
export const LEASE_LOST_ACTIONS = [
  "stop-costly-calls",
  "revoke-secrets",
  "block-external-writes",
  "checkpoint-if-permitted",
  "declare-late-artifacts",
] as const

export type LeaseLostAction = (typeof LEASE_LOST_ACTIONS)[number]

/**
 * Ce qu'un worker a encore le droit de faire après avoir perdu sa lease.
 *
 * Énumérer ce qui reste permis plutôt que ce qui est interdit — le même choix qu'en §7.4, et pour
 * la même raison : une liste d'interdits oublie toujours l'action ajoutée le mois suivant, et
 * l'oubli penche du mauvais côté.
 *
 * `present-commit-as-applicable` n'y figure pas et n'y figurera pas : §11.4 dit « aucun commit ne
 * doit être présenté comme applicable implicitement ».
 */
export const ALLOWED_AFTER_LOSS: readonly string[] = [
  "upload-closing-logs",
  "checkpoint-if-permitted",
  "declare-late-artifacts",
]

export function isAllowedAfterLoss(action: string): boolean {
  return ALLOWED_AFTER_LOSS.includes(action)
}

/**
 * Un résultat rendu après l'échéance doit se déclarer tardif.
 *
 * §11.4 permet de déclarer les artefacts déjà produits comme *late result* ; §12.3 met un résultat
 * tardif en quarantaine. Encore faut-il que le serveur sache qu'il l'est : un résultat tardif
 * silencieux serait traité comme un résultat normal, ce qui est précisément le contournement que
 * la quarantaine existe pour empêcher. Le harnais de conformance le vérifie.
 */
export function lateMarker(lease: Lease, producedAt: number): { late: true } | Record<string, never> {
  return isExpired(lease, producedAt) ? { late: true } : {}
}
