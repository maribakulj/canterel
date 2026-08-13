import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ALIASES,
  GENERATED_MODULES,
  LOCUS_DIR,
  LOCUS_SEAMS,
  STANDALONE_ENTRY,
  isInternal,
  resolveRelative,
  scanForLocusSpecifiers,
  dynamicSpecifiersOf,
  specifiersOf,
  staticSpecifiersOf,
  verifyStandalone,
  walkGraph,
} from "../../src/locus/standalone.ts"

const CLI = join(import.meta.dir, "../..")

/** Un petit dépôt jetable : les chemins rouges se démontrent, ils ne se supposent pas. */
function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "locus-standalone-"))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

describe("extraction des specifiers", () => {
  test("les quatre formes d'import sont vues", () => {
    const source = [
      `import { a } from "./a"`,
      `import "./side-effect"`,
      `export { b } from "./b"`,
      `const c = await import("./c")`,
      `const d = require("./d")`,
    ].join("\n")
    expect(specifiersOf(source)).toEqual(expect.arrayContaining(["./a", "./side-effect", "./b", "./c", "./d"]))
  })

  test("un import en commentaire n'est pas une dépendance", () => {
    // `src/science/connectors` documente son usage par des exemples d'import en en-tête. Les
    // compter signalerait une dépendance qui n'existe pas, et un garde-fou qui crie faux se fait
    // désarmer aussi sûrement qu'un garde-fou muet.
    const source = [` *   import { uniprot } from "./impl/uniprot"`, `// import x from "./commente"`].join("\n")
    expect(specifiersOf(source)).toEqual([])
  })
})

describe("résolution", () => {
  test("les extensions et les index sont essayés, l'échec n'est pas silencieux", () => {
    const root = scratch({
      "src/a.ts": "",
      "src/pkg/index.ts": "",
      "src/prompt/core.txt": "texte",
      "src/entry.ts": "",
    })
    expect(resolveRelative("src/entry.ts", "./a", root)).toBe("src/a.ts")
    expect(resolveRelative("src/entry.ts", "./pkg", root)).toBe("src/pkg/index.ts")
    // Les prompts sont importés tels quels : le candidat exact passe avant les extensions.
    expect(resolveRelative("src/entry.ts", "./prompt/core.txt", root)).toBe("src/prompt/core.txt")
    expect(resolveRelative("src/entry.ts", "./fantome", root)).toBeNull()
  })

  test("un alias `@/` se résout depuis la racine, pas depuis le fichier", () => {
    const root = scratch({ "src/bus/index.ts": "", "src/cli/cmd/deep/nested.ts": "" })
    expect(resolveRelative("src/cli/cmd/deep/nested.ts", "@/bus", root)).toBe("src/bus/index.ts")
    expect(resolveRelative("src/cli/cmd/deep/nested.ts", "@/fantome", root)).toBeNull()
  })

  test("un paquet externe n'est pas confondu avec un alias", () => {
    // `@synsci/util` commence par `@` sans être `@/`. Le suivre mènerait à des irrésolus en
    // cascade et noierait les vrais constats.
    expect(isInternal("@synsci/util/error")).toBe(false)
    expect(isInternal("yargs")).toBe(false)
    expect(isInternal("@/bus")).toBe(true)
    expect(isInternal("./voisin")).toBe(true)
  })
})

describe("le garde-fou sait rougir", () => {
  test("un import statique vers Locus depuis l'entrée est pris", () => {
    const root = scratch({
      "src/index.ts": `import { worker } from "./locus/worker"`,
      "src/locus/worker.ts": "export const worker = 1",
    })
    const report = walkGraph(root)
    expect(report.findings.map((f) => f.rule)).toContain("locus-in-standalone-graph")
  })

  test("Locus atteint par un intermédiaire est pris aussi", () => {
    // La forme réaliste : personne n'écrira l'import dans `index.ts`. Il arrivera trois niveaux
    // plus bas, dans une commande qui « avait juste besoin du statut du worker ».
    const root = scratch({
      "src/index.ts": `import "./cli/cmd/worker"`,
      "src/cli/cmd/worker.ts": `import "../../locus/config"`,
      "src/locus/config.ts": "export const config = 1",
    })
    const findings = walkGraph(root).findings
    expect(findings.length).toBe(1)
    expect(findings[0]?.where).toBe("src/locus/config.ts")
  })

  test("un import dynamique est pris par le balayage, là où le graphe ne le voit pas", () => {
    // La seconde porte : `await import("./locus/…")` sur une branche jamais prise en test
    // n'apparaît dans aucun parcours statique et se comporte pourtant comme la dépendance
    // interdite.
    const root = scratch({
      "src/index.ts": `export const noop = 1`,
      "src/cli/cmd/serve.ts": `if (flag) await import("../../locus/connection")`,
      "src/locus/connection.ts": "export const c = 1",
    })
    expect(walkGraph(root).findings).toEqual([])
    const scanned = scanForLocusSpecifiers(root)
    expect(scanned.map((f) => f.rule)).toEqual(["locus-specifier-outside-perimeter"])
    expect(scanned[0]?.where).toBe("src/cli/cmd/serve.ts")
  })

  test("un import irrésolu est un constat, jamais un saut silencieux", () => {
    // Un résolveur qui abandonne en silence sur ce qu'il ne comprend pas laisse exactement la
    // porte que ce garde-fou existe pour fermer : le verdict d'un graphe incomplet ne vaut rien.
    const root = scratch({ "src/index.ts": `import "./disparu"` })
    const findings = walkGraph(root).findings
    expect(findings.map((f) => f.rule)).toEqual(["unresolved-import"])
  })

  test("le périmètre Locus ne se dénonce pas lui-même", () => {
    // `src/locus/**` importe évidemment `src/locus/**`. Le balayage porte sur ce qui est HORS
    // périmètre ; l'y inclure rendrait le garde-fou rouge dès le premier module Locus écrit.
    const root = scratch({
      "src/index.ts": `export const noop = 1`,
      "src/locus/a.ts": `import "./b"`,
      "src/locus/b.ts": `export const b = 1`,
    })
    expect(scanForLocusSpecifiers(root)).toEqual([])
  })
})

describe("coutures", () => {
  test("chaque couture est paresseuse, existe, et porte sa raison", () => {
    // Ce test valait `toEqual([])` jusqu'à W2.3, et il est tombé au moment exact où il devait
    // tomber : la première couture est arrivée. C'était le but — en ajouter une est un acte
    // visible en revue, pas un assouplissement discret. Il vérifie maintenant ce qui doit rester
    // vrai de toutes les suivantes.
    for (const seam of LOCUS_SEAMS) {
      expect(seam.reason.length).toBeGreaterThan(30)
      expect(seam.path.startsWith(LOCUS_DIR)).toBe(false)
      const source = readFileSync(join(CLI, seam.path), "utf8")
      // Paresseuse : elle désigne Locus dynamiquement, et jamais statiquement. Un import statique
      // mettrait toute la couche dans le graphe de démarrage — le graphe le prendrait de toute
      // façon, mais l'exiger ici nomme la règle au lieu de la laisser déduire d'un échec.
      const designates = (specifier: string) => /(^|\/)locus(\/|$)/.test(specifier)
      expect(staticSpecifiersOf(source).some(designates)).toBe(false)
      expect(dynamicSpecifiersOf(source).some(designates)).toBe(true)
    }
  })

  test("une couture dispense du balayage, jamais du graphe", () => {
    // C'est la propriété qui compte : les deux règles ensemble disent qu'une couture doit être
    // paresseuse. Déclarer `serve.ts` couture l'autorise à écrire `import("@/locus/…")` sur une
    // branche ; ça ne l'autorise pas à le charger au démarrage.
    const root = scratch({
      "src/index.ts": `import "./cli/cmd/serve"`,
      "src/cli/cmd/serve.ts": `import { w } from "../../locus/worker"`,
      "src/locus/worker.ts": `export const w = 1`,
    })
    // Le graphe reste rouge même si l'on prétend que ce fichier est une couture : `walkGraph`
    // n'interroge pas la liste, et c'est délibéré.
    expect(walkGraph(root).findings.map((f) => f.rule)).toEqual(["locus-in-standalone-graph"])
  })
})

describe("modules générés", () => {
  test("chaque déclaration porte sa raison et sert réellement", () => {
    // Une déclaration que plus personne n'utilise est un trou : elle continue d'excuser un import
    // qui n'existe plus, et excusera le prochain qui portera le même nom.
    const encountered = verifyStandalone(CLI).generated
    expect(GENERATED_MODULES.length).toBeGreaterThan(0)
    for (const entry of GENERATED_MODULES) {
      expect(entry.reason.length).toBeGreaterThan(30)
      expect(encountered.some((line) => line.endsWith(`→ ${entry.specifier}`))).toBe(true)
    }
  })

  test("le relevé ne dépend pas de l'état du build", () => {
    // La CI a fait tomber la première version de ce test, et elle avait raison : le job `Test`
    // construit les assets web, les autres non. Un relevé conditionné par la présence du fichier
    // dit donc deux choses différentes dans deux jobs de la même CI. Ce qu'on veut savoir est
    // stable — cette déclaration correspond-elle encore à un import réel ?
    const absent = scratch({ "src/index.ts": `import "./assets.generated"` })
    const present = scratch({
      "src/index.ts": `import "./assets.generated"`,
      "src/assets.generated.ts": `export const A = 1`,
    })
    expect(walkGraph(absent).generated).toEqual(["src/index.ts → ./assets.generated"])
    expect(walkGraph(present).generated).toEqual(["src/index.ts → ./assets.generated"])
    // Et quand il existe, il est parcouru comme n'importe quel autre fichier.
    expect(walkGraph(present).reached).toContain("src/assets.generated.ts")
  })

  test("un module absent non déclaré reste un constat", () => {
    const root = scratch({ "src/index.ts": `import "./models-snapshot"\nimport "./autre-absent"` })
    const findings = walkGraph(root).findings
    // `./models-snapshot` est déclaré généré, `./autre-absent` ne l'est pas.
    expect(findings.length).toBe(1)
    expect(findings[0]?.message).toContain("autre-absent")
  })
})

describe("non-régression standalone — le test de sortie de W2.2", () => {
  test("le mode autonome ne charge aucun module Locus", () => {
    const report = verifyStandalone(CLI)
    expect(report.findings).toEqual([])
    expect(report.reached.filter((path) => path.startsWith(LOCUS_DIR))).toEqual([])
  })

  test("le graphe parcouru est le vrai, pas un moignon", () => {
    // Un parcours qui s'arrêterait à trois fichiers passerait le test précédent sans rien
    // vérifier. Les ancres ci-dessous sont les modules que `docs/locus/CLAUDE.md` nomme comme
    // « à préserver » : si le graphe ne les atteint pas, il ne parcourt pas la CLI historique.
    const report = verifyStandalone(CLI)
    expect(report.reached.length).toBeGreaterThan(200)
    for (const anchor of [
      STANDALONE_ENTRY,
      "src/agent/agent.ts",
      "src/session/prompt.ts",
      "src/session/system.ts",
      "src/provider/provider.ts",
      "src/sandbox/sandbox.ts",
      // `src/permission/next.ts`, pas `index.ts` : c'est `next.ts` que la CLI charge réellement.
      // L'ancre suit le graphe, elle ne le corrige pas.
      "src/permission/next.ts",
    ]) {
      expect(report.reached).toContain(anchor)
    }
  })

  test("le résolveur connaît tous les alias de tsconfig", () => {
    // La CLI amont importe massivement en `@/…`. Un résolveur qui ignore un alias croit parcourir
    // le graphe et n'en voit qu'une partie, puis rend un verdict rassurant sur ce qu'il n'a pas
    // regardé. Si `tsconfig.json` gagne un alias, ce test tombe avant que le trou s'ouvre.
    const tsconfig = JSON.parse(readFileSync(join(CLI, "tsconfig.json"), "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    const declared = Object.keys(tsconfig.compilerOptions?.paths ?? {})
    expect(declared.length).toBeGreaterThan(0)
    for (const pattern of declared) {
      const prefix = pattern.replace(/\*$/, "")
      expect(ALIASES.some((alias) => alias.prefix === prefix)).toBe(true)
    }
  })

  test("le rapport dit ce qui a tourné", () => {
    // « Rien à signaler » et « rien vérifié » ne doivent pas se ressembler.
    expect(verifyStandalone(CLI).ran).toEqual([
      "locus-in-standalone-graph",
      "unresolved-import",
      "locus-specifier-outside-perimeter",
    ])
  })
})
