/**
 * La non-régression standalone, exécutable — `SPEC_V1.md` §28.8.
 *
 * `docs/locus/CLAUDE.md` le dit sans détour : « le mode autonome ne doit jamais charger
 * `src/locus/**` ». C'est une propriété du **graphe d'imports**, pas une intention : elle se tient
 * ou elle ne se tient pas, et la seule façon de le savoir est de marcher le graphe depuis le vrai
 * point d'entrée de la CLI.
 *
 * Ce garde-fou s'écrit avant le premier module `locus/` fonctionnel, exprès. Écrit après, il
 * documenterait l'état atteint ; écrit avant, il refuse le premier pas de travers — celui de W2.3,
 * qui ajoutera `canterel worker --locus` et aura toutes les raisons du monde de câbler le worker
 * « juste un peu » dans l'entrée standalone.
 *
 * Deux portes, et il faut les fermer toutes les deux. Un `import` statique se voit dans le graphe.
 * Un `await import("./locus/…")` ne s'y voit pas : il n'apparaît qu'à l'exécution, sur une branche
 * qui peut ne jamais être prise en test. La seconde vérification balaie donc le texte de tout ce
 * qui n'est pas Locus, à la recherche d'un specifier qui désigne Locus, quelle qu'en soit la forme.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

/** Un constat. Le garde-fou en rend une liste, jamais une exception : le rapport complet vaut mieux qu'un premier échec. */
export type Finding = {
  /** La règle enfreinte, pour pouvoir la citer. */
  readonly rule: "locus-in-standalone-graph" | "locus-specifier-outside-perimeter" | "unresolved-import"
  /** Le fichier fautif, relatif à `backend/cli`. */
  readonly where: string
  readonly message: string
}

/** Le rapport. `ran` distingue « rien à signaler » de « rien vérifié ». */
export type StandaloneReport = {
  readonly findings: readonly Finding[]
  /** Les fichiers effectivement atteints depuis le point d'entrée. */
  readonly reached: readonly string[]
  /** Les vérifications qui ont tourné, nommément. */
  readonly ran: readonly string[]
  /**
   * Les références aux modules déclarés générés, rencontrées pendant le parcours.
   *
   * Relevées qu'elles se résolvent ou non : le job `Test` construit les assets web, les autres
   * non, et un relevé conditionné par l'état du build dirait deux choses différentes dans deux
   * jobs de la même CI. Elles sont **rapportées**, pas tues — un garde-fou qui avale ses
   * exceptions en silence finit par n'avoir plus que des exceptions, sans que personne le voie.
   */
  readonly generated: readonly string[]
}

/**
 * Les modules que le graphe ne peut pas résoudre parce qu'ils n'existent qu'après un build.
 *
 * La liste est explicite et porte ses raisons, comme `JUSTIFIED_UPSTREAM_EDITS` : un import
 * irrésolu **hors** de cette liste reste un constat. Sans elle, le garde-fou serait rouge au HEAD
 * pour trois fichiers d'amont parfaitement sains — et un garde-fou rouge en permanence finit
 * désarmé, ce qui est le seul échec dont on ne se relève pas.
 */
export const GENERATED_MODULES: readonly { specifier: string; reason: string }[] = [
  {
    specifier: "./models-snapshot",
    reason:
      "Instantané du catalogue models.dev, produit par le script de release ; .prettierignore le déclare déjà généré.",
  },
  {
    specifier: "./assets.generated",
    reason: "Assets web embarqués, produits par script/generate-web-assets.ts ; seul le .d.ts est versionné.",
  },
  {
    specifier: "./bundled.generated",
    reason:
      "Skills embarqués, produits au build ; l'appelant l'importe déjà avec un .catch, donc son absence est un cas prévu.",
  },
]

function isGenerated(specifier: string): boolean {
  return GENERATED_MODULES.some((entry) => entry.specifier === specifier)
}

/**
 * Les coutures : les fichiers hors périmètre autorisés à désigner Locus, un par un.
 *
 * Il en faudra. `canterel worker --locus` (W2.3) doit bien atteindre le worker depuis quelque
 * part, et prétendre le contraire condamnerait la fonctionnalité ou, bien plus probablement,
 * ferait desserrer le garde-fou sous la pression le jour où il gênera. Autant décider maintenant,
 * à froid, ce qu'une couture légitime a le droit d'être.
 *
 * Vide au HEAD, et c'est le point : ajouter une entrée est un acte visible en revue, pas un
 * assouplissement discret. Une couture ne dispense **que** du balayage textuel — le parcours du
 * graphe continue de s'appliquer à elle. Les deux règles ensemble disent donc exactement la bonne
 * chose : une couture doit être **paresseuse**. Un `import` statique vers Locus dans un fichier
 * atteignable depuis `src/index.ts` met Locus dans le graphe standalone et reste rouge, couture
 * déclarée ou non.
 */
export const LOCUS_SEAMS: readonly { path: string; reason: string }[] = []

function isSeam(file: string): boolean {
  return LOCUS_SEAMS.some((seam) => seam.path === file)
}

/** Le point d'entrée du mode autonome — la CLI historique, celle que §28.8 protège. */
export const STANDALONE_ENTRY = "src/index.ts"

/** Le répertoire dont le mode autonome ne doit jamais dépendre. */
export const LOCUS_DIR = "src/locus/"

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".json"]

/** Ce qui n'est ni du code de la CLI ni intéressant à marcher. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__snapshots__"])

/**
 * Les alias de chemin de `tsconfig.json`, que le résolveur doit connaître pour voir le graphe.
 *
 * La CLI amont importe massivement en `@/…` — 84 specifiers distincts. Un résolveur qui ne suit
 * que le relatif croit parcourir le graphe et n'en voit qu'une partie, puis rend un verdict
 * rassurant sur ce qu'il n'a pas regardé. Un alias inconnu de cette table est un **constat**, pas
 * un saut : `standalone.test.ts` relit `tsconfig.json` et échoue si un alias y apparaît sans être
 * ici.
 */
export const ALIASES: readonly { prefix: string; target: string }[] = [{ prefix: "@/", target: "src/" }]

/** Vrai pour un specifier que ce résolveur sait suivre : relatif, ou aliasé. */
export function isInternal(specifier: string): boolean {
  return specifier.startsWith(".") || ALIASES.some((alias) => specifier.startsWith(alias.prefix))
}

/**
 * Résoudre un specifier interne comme le ferait le runtime.
 *
 * Rend `null` quand rien ne correspond — et l'appelant en fait un **constat**, jamais un saut
 * silencieux. Un résolveur qui abandonne en silence sur ce qu'il ne comprend pas laisse
 * exactement la porte que ce garde-fou existe pour fermer.
 */
export function resolveRelative(fromFile: string, specifier: string, root: string): string | null {
  const alias = ALIASES.find((entry) => specifier.startsWith(entry.prefix))
  const base = alias
    ? resolve(root, alias.target + specifier.slice(alias.prefix.length))
    : resolve(root, dirname(fromFile), specifier)
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => join(base, "index" + ext)),
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return relative(root, candidate)
    } catch {
      // Ce candidat n'existe pas ; on essaie le suivant. L'absence de TOUS les candidats est ce
      // qui produit un constat, pas l'absence de l'un d'eux.
    }
  }
  return null
}

/**
 * Extraire les specifiers d'un fichier : `import`, `export … from`, et `import()` dynamique.
 *
 * Une regex plutôt qu'un parseur, assumé : le garde-fou doit sur-détecter, pas sous-détecter. Un
 * parseur qui rate une forme produit un silence, et le silence est le seul résultat inacceptable
 * ici.
 *
 * Les lignes de commentaire sont écartées, et c'est la seule concession. `src/science/connectors`
 * documente son usage par des exemples d'`import` en en-tête de fichier ; les compter serait
 * signaler une dépendance qui n'existe pas, et un garde-fou qui crie faux se fait désarmer aussi
 * sûrement qu'un garde-fou muet. Rien n'est perdu : un import en commentaire ne s'exécute pas.
 */
export function specifiersOf(source: string): readonly string[] {
  const found: string[] = []
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  const code = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) found.push(specifier)
    }
  }
  return found
}

/**
 * Marcher le graphe d'imports depuis le point d'entrée standalone.
 *
 * Seuls les specifiers relatifs sont suivis : un paquet externe ne peut pas atteindre `src/locus/`
 * sans passer par un fichier de ce dépôt, et ce fichier-là est dans le graphe. Les specifiers
 * externes ne sont pas ignorés pour autant — la seconde vérification les balaie par le texte.
 */
export function walkGraph(
  root: string,
  entry = STANDALONE_ENTRY,
): { reached: string[]; findings: Finding[]; generated: string[] } {
  const reached: string[] = []
  const findings: Finding[] = []
  const generated: string[] = []
  const seen = new Set<string>([entry])
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.shift()
    if (!file) break
    reached.push(file)

    if (file.startsWith(LOCUS_DIR)) {
      findings.push({
        rule: "locus-in-standalone-graph",
        where: file,
        message: `${file} est atteignable depuis ${entry} : le mode autonome chargerait du code Locus (§28.8)`,
      })
      // On ne descend pas plus loin : le constat porte sur le point d'entrée dans Locus, et
      // dérouler tout `src/locus/**` derrière lui noierait la cause dans ses conséquences.
      continue
    }

    let source: string
    try {
      source = readFileSync(resolve(root, file), "utf8")
    } catch {
      continue
    }

    for (const specifier of specifiersOf(source)) {
      if (!isInternal(specifier)) continue
      // Relevé AVANT la résolution, et non dans la branche « irrésolu » : selon que le build a
      // tourné ou non, `./assets.generated` existe ou pas, et un relevé qui dépendrait de ça
      // dirait deux choses différentes dans deux jobs de la même CI. Ce qu'on veut savoir est
      // stable : cette déclaration correspond-elle encore à un import réel ?
      if (isGenerated(specifier)) generated.push(`${file} → ${specifier}`)

      const resolved = resolveRelative(file, specifier, root)
      if (!resolved) {
        if (isGenerated(specifier)) continue
        findings.push({
          rule: "unresolved-import",
          where: file,
          message: `\`${specifier}\` n'a pas pu être résolu — le graphe est incomplet, donc son verdict ne vaut rien`,
        })
        continue
      }
      if (seen.has(resolved)) continue
      seen.add(resolved)
      queue.push(resolved)
    }
  }
  return { reached, findings, generated }
}

/** Lister récursivement les sources d'un répertoire, relatives à `root`. */
function sourcesUnder(root: string, dir: string): string[] {
  const out: string[] = []
  const absolute = resolve(root, dir)
  let entries: string[]
  try {
    entries = readdirSync(absolute)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const child = join(dir, name)
    const stats = statSync(resolve(root, child))
    if (stats.isDirectory()) out.push(...sourcesUnder(root, child))
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(child)
  }
  return out
}

/**
 * Chercher, hors du périmètre Locus, tout specifier qui désigne Locus.
 *
 * C'est la porte que le graphe ne voit pas : `await import("./locus/worker")` sur une branche
 * jamais prise en test n'apparaît nulle part dans un parcours statique des imports, et se
 * comporterait pourtant exactement comme la dépendance que §28.8 interdit.
 */
export function scanForLocusSpecifiers(root: string, dirs: readonly string[] = ["src"]): Finding[] {
  const findings: Finding[] = []
  for (const dir of dirs) {
    for (const file of sourcesUnder(root, dir)) {
      if (file.startsWith(LOCUS_DIR) || isSeam(file)) continue
      const source = readFileSync(resolve(root, file), "utf8")
      for (const specifier of specifiersOf(source)) {
        if (!/(^|\/)locus(\/|$)/.test(specifier)) continue
        findings.push({
          rule: "locus-specifier-outside-perimeter",
          where: file,
          message: `\`${specifier}\` désigne Locus depuis un fichier hors périmètre — statique ou dynamique, c'est la dépendance que §28.8 interdit`,
        })
      }
    }
  }
  return findings
}

/**
 * Le test de sortie de W2.2 : le mode autonome ne charge pas Locus.
 *
 * Rend un rapport, pas un booléen. « Non conforme » sans le détail n'est pas exploitable, et la
 * liste `ran` est ce qui distingue un garde-fou muet d'un garde-fou satisfait.
 */
export function verifyStandalone(root: string): StandaloneReport {
  const graph = walkGraph(root)
  const scan = scanForLocusSpecifiers(root)
  return {
    findings: [...graph.findings, ...scan],
    reached: graph.reached,
    ran: ["locus-in-standalone-graph", "unresolved-import", "locus-specifier-outside-perimeter"],
    generated: graph.generated,
  }
}
