/**
 * Les briques de rendu des vues Locus — `SPEC_V1.md` §23.4 et §25.4.
 *
 * Deux règles, et les deux sont des règles de **vérité**, pas de mise en forme.
 *
 * §25.4 : « prompts, sources et sorties ne sont pas exportés par défaut dans la télémétrie. Les
 * logs utilisent identifiants et hashes, avec redaction configurable. » Une vue est de la
 * télémétrie qui s'affiche : ce qui ne doit pas sortir dans un log ne doit pas non plus s'afficher
 * dans un terminal partagé, collé dans un ticket ou capturé dans une copie d'écran. Les vues
 * rendent donc des identifiants, des hashes et des états — jamais du contenu.
 *
 * La seconde règle n'est écrite nulle part sous cette forme, et elle traverse tout le projet :
 * **une valeur inconnue se rend `inconnu`, jamais par un défaut plausible.** Un budget non mesuré
 * affiché `0` ne dit pas « rien dépensé » : il dit « rien mesuré », et les deux se ressemblent
 * exactement à l'écran. C'est la même distinction que `not-run` face à `blocked` dans les
 * self-tests d'ADR 0004, et que `skipped` face à `enforced` dans le scanner d'artefacts.
 */

/** Ce qu'on affiche quand on ne sait pas. Un mot, toujours le même, jamais une valeur inventée. */
export const UNKNOWN = "inconnu"

/**
 * Un champ `clé : valeur`.
 *
 * `undefined` et `null` deviennent `inconnu`. Une chaîne vide aussi : une valeur vide affichée
 * comme vide se lit comme une absence de problème, alors qu'elle est une absence d'information.
 */
export function field(label: string, value: unknown): string {
  return `${label} : ${render(value)}`
}

export function render(value: unknown): string {
  if (value === undefined || value === null) return UNKNOWN
  if (typeof value === "string") return value.trim().length === 0 ? UNKNOWN : value
  if (typeof value === "boolean") return value ? "oui" : "non"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : UNKNOWN
  if (Array.isArray(value)) return value.length === 0 ? "aucun" : value.map((item) => render(item)).join(", ")
  return String(value)
}

/** Un titre de section, souligné. Les vues se lisent dans un terminal, pas dans un navigateur. */
export function section(title: string): readonly string[] {
  return [title, "─".repeat(title.length)]
}

/** Une ligne de liste. */
export function bullet(text: string): string {
  return `  · ${text}`
}

/**
 * Un hash raccourci pour l'affichage, **préfixe conservé**.
 *
 * Le préfixe d'algorithme survit à la troncature : c'est ce qui permet de savoir quoi recalculer,
 * et un digest abrégé sans son algorithme n'identifie plus rien. La troncature est un confort de
 * lecture ; elle ne doit pas transformer une empreinte en décoration.
 */
export function shortHash(hash: string | undefined, keep = 12): string {
  if (hash === undefined || hash.length === 0) return UNKNOWN
  const separator = hash.indexOf(":")
  if (separator <= 0) return `${hash.slice(0, keep)}…`
  const algorithm = hash.slice(0, separator)
  const digest = hash.slice(separator + 1)
  return digest.length <= keep ? hash : `${algorithm}:${digest.slice(0, keep)}…`
}

/**
 * Les motifs qu'une vue ne doit jamais laisser passer — §25.4 et la règle de sécurité du dépôt
 * (« ne logge ni OAuth token, API key, cookie ni contenu classifié »).
 *
 * Sert de **filet**, pas de politique : la politique est de ne pas mettre de secret dans une vue.
 * Un filet existe pour le jour où quelqu'un en met un quand même, et pour que le test puisse le
 * dire au lieu de faire confiance.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/,
]

/**
 * Ce qui, dans un rendu, n'aurait pas dû s'y trouver.
 *
 * Rend des constats plutôt que de censurer : masquer sur place produirait une vue partiellement
 * fausse dont personne ne saurait qu'elle l'est. Le rendu qui contient un secret est un **bug**,
 * et un bug se corrige à la source.
 */
export function leakFindings(rendered: string): readonly string[] {
  return SECRET_SHAPES.filter((shape) => shape.test(rendered)).map(
    (shape) => `forme de secret dans un rendu (${shape.source.slice(0, 24)}…) — §25.4`,
  )
}
