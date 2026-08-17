import { readPin } from "./schema-registry.ts"

/**
 * La suite de conformance — `SPEC_V1.md` §28.2 et §28.3.
 *
 * §28.2 énumère onze contract tests. Une liste dans une spécification ne teste rien par elle-même :
 * ce qui la rend exécutoire, c'est que **l'absence d'un cas soit un échec**, pas une absence.
 * D'où ce module. Il ne teste rien ; il tient le compte, et il rend un constat quand un item du
 * texte n'a pas de cas correspondant.
 *
 * C'est la même règle que partout ailleurs dans cette couche, appliquée à la suite elle-même : un
 * contrôle qui ne tourne pas ressemble à un contrôle qui passe. Une suite de conformance dont il
 * manquerait « revocation » serait verte, et sa vertu serait un artefact de ce qu'elle ne fait pas.
 *
 * §28.3 ajoute la contrainte d'approvisionnement : « les tests ne doivent pas dépendre d'un dépôt
 * Locus Solus local mutable ». Toute entrée LEP de la suite vient donc de la copie **épinglée**,
 * dont `PINNED.json` porte les empreintes. Un fichier d'entrée absent du pin est un fichier que
 * personne ne peut certifier, et le signaler vaut mieux que de le lire.
 */

/** Les onze contract tests de §28.2, dans l'ordre du texte. */
export const CONTRACT_TESTS = [
  "handshake",
  "version-negotiation",
  "resume",
  "duplicate-messages",
  "sequence-gaps",
  "leases",
  "late-results",
  "artifact-upload",
  "human-input",
  "revocation",
  "capability-change",
] as const

export type ContractTest = (typeof CONTRACT_TESTS)[number]

export function isContractTest(name: string): name is ContractTest {
  return (CONTRACT_TESTS as readonly string[]).includes(name)
}

/**
 * Ce qui manque, et ce qui est en trop.
 *
 * Les deux sens comptent, et pour des raisons différentes.
 *
 * Un item **manquant** est un pan de §28.2 que la suite ne couvre pas et sur lequel elle est
 * pourtant verte.
 *
 * Un item **inconnu** est un cas qui croit couvrir quelque chose que le texte ne demande pas :
 * soit le nom a dérivé, soit §28.2 a bougé. Dans les deux cas, la correspondance entre la suite et
 * la spec a cessé d'être vérifiable, et c'est exactement ce que cette fonction existe pour dire.
 */
export function coverageFindings(executed: readonly string[]): readonly string[] {
  const seen = new Set(executed)
  const findings = CONTRACT_TESTS.filter((name) => !seen.has(name)).map(
    (name) => `contract test \`${name}\` de §28.2 sans cas exécuté : une suite qui l'omet est verte pour rien`,
  )
  return [
    ...findings,
    ...executed
      .filter((name) => !isContractTest(name))
      .map((name) => `cas \`${name}\` hors de la liste de §28.2 : le nom a dérivé, ou la spec a bougé`),
  ]
}

/**
 * Les entrées LEP que la suite a le droit de lire — §28.3.
 *
 * Ce sont les chemins épinglés, et rien d'autre. La liste vient de `PINNED.json` plutôt que d'une
 * énumération à la main : une liste écrite deux fois se désynchronise une fois.
 */
export function pinnedInputs(): readonly string[] {
  return Object.keys(readPin().files)
}

/**
 * Les entrées qui ne viennent pas du pin — §28.3.
 *
 * « Les tests ne doivent pas dépendre d'un dépôt Locus Solus local mutable. » Un fichier LEP lu
 * hors du pin est un fichier dont rien ne dit quelle version il porte : la suite passerait ou
 * échouerait selon l'état d'un répertoire voisin, ce qui n'est plus une conformance mais une
 * coïncidence.
 */
export function foreignInputFindings(inputs: readonly string[]): readonly string[] {
  const allowed = new Set(pinnedInputs())
  return inputs
    .filter((input) => !allowed.has(input))
    .map((input) => `entrée \`${input}\` absente de \`PINNED.json\` : non certifiable, et §28.3 l'interdit`)
}

/**
 * L'état d'approvisionnement de la suite.
 *
 * `pinned` est le mode nominal et le seul qui soit hors ligne. `verified-against-source` est un
 * bonus quand le dépôt d'origine est joignable ; `unverifiable` dit que la vérification croisée
 * n'a pas eu lieu — et le dire est le point, parce que la suite reste valide dans ce cas, mais
 * moins étayée.
 */
export type SourceStanding = "pinned" | "verified-against-source" | "unverifiable"

/**
 * Un rapport de conformance, prêt à être rendu ou écrit au ledger.
 *
 * `complete` est faux dès qu'un item de §28.2 manque. Le distinguer de `ok` évite qu'une suite
 * incomplète mais sans constat se lise comme une suite verte.
 */
export type ConformanceReport = {
  readonly executed: readonly string[]
  readonly missing: readonly ContractTest[]
  readonly findings: readonly string[]
  readonly source: SourceStanding
  readonly complete: boolean
}

export function conformanceReport(executed: readonly string[], source: SourceStanding = "pinned"): ConformanceReport {
  const seen = new Set(executed)
  const missing = CONTRACT_TESTS.filter((name) => !seen.has(name))
  const findings = coverageFindings(executed)
  return { executed: [...executed], missing, findings, source, complete: missing.length === 0 }
}
