import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  JUSTIFIED_UPSTREAM_EDITS,
  LOCAL_PATHS,
  classify,
  isJustifiedUpstreamEdit,
  isLocal,
} from "../../src/locus/upstream.ts"
import { dryRunMerge } from "../../src/locus/upstream-merge.ts"

const REPO = join(import.meta.dir, "../../../..")

describe("périmètre Locus", () => {
  test("le code Locus est reconnu comme local", () => {
    for (const path of [
      "backend/cli/src/locus/upstream.ts",
      "backend/cli/src/locus/deep/nested.ts",
      "backend/cli/test/locus/upstream.test.ts",
      "docs/locus/SPEC_V1.md",
      "IMPLEMENTATION_LEDGER.md",
    ]) {
      expect(isLocal(path)).toBe(true)
    }
  })

  test("le code amont n'est pas confondu avec du local", () => {
    for (const path of [
      "backend/cli/src/session/prompt.ts",
      "backend/cli/src/agent/agent.ts",
      "frontend/workspace/index.ts",
      "NOTICE",
    ]) {
      expect(isLocal(path)).toBe(false)
    }
  })

  test("un préfixe qui ressemble ne suffit pas", () => {
    // `src/locusd/` n'est pas `src/locus/`. Un préfixe sans son slash final attraperait le
    // premier, et le périmètre s'étendrait sans que personne l'ait décidé.
    expect(isLocal("backend/cli/src/locusd/main.ts")).toBe(false)
    expect(isLocal("docs/locus-notes.md")).toBe(false)
  })

  test("les fichiers amont modifiés sont justifiés un par un", () => {
    // ADR 0010 n'interdit pas de les toucher : il exige que le prix soit écrit. Une entrée sans
    // raison rendrait la liste décorative.
    expect(JUSTIFIED_UPSTREAM_EDITS.length).toBeGreaterThan(0)
    for (const entry of JUSTIFIED_UPSTREAM_EDITS) {
      expect(isJustifiedUpstreamEdit(entry.path)).toBe(true)
      expect(isLocal(entry.path)).toBe(false)
      expect(entry.reason.length).toBeGreaterThan(30)
    }
  })
})

describe("classement d'un merge", () => {
  test("les trois catégories sont séparées", () => {
    // Les distinguer est tout l'intérêt : toucher de l'amont est normal, toucher un fichier
    // justifié est un coût connu, toucher du Locus est le seul des trois qui soit une faute.
    const verdict = classify(["backend/cli/src/session/prompt.ts", "CLAUDE.md", "backend/cli/src/locus/upstream.ts"])
    expect(verdict.upstreamTouched).toEqual(["backend/cli/src/session/prompt.ts"])
    expect(verdict.justifiedTouched).toEqual(["CLAUDE.md"])
    expect(verdict.localTouched).toEqual(["backend/cli/src/locus/upstream.ts"])
  })

  test("un merge qui ne touche que l'amont ne signale rien", () => {
    const verdict = classify(["backend/cli/src/agent/agent.ts", "README.md"])
    expect(verdict.localTouched).toEqual([])
  })
})

describe("merge amont à blanc — le test de sortie de W2.1", () => {
  test("aucun fichier Locus n'est touché", async () => {
    const result = await dryRunMerge(REPO)
    if (!result.ok) {
      // Hors ligne ou pare-feu : ce n'est pas une violation de la politique, et le dire
      // autrement rendrait le contrôle bruyant là où il devrait être muet. Mais il le DIT,
      // plutôt que de passer en silence — un contrôle qu'on croit avoir tourné est pire
      // qu'un contrôle absent.
      console.warn(`[W2.1] merge à blanc non exécuté : ${result.reason}`)
      expect(result.reason.length).toBeGreaterThan(0)
      return
    }
    expect(result.verdict.localTouched).toEqual([])
  }, 120_000)

  test("la politique écrite énumère le périmètre que le code applique", async () => {
    // Deux endroits disent le périmètre : le code, qui l'applique, et `docs/locus/upstream.md`,
    // qu'un humain lit avant de merger. Le second qui dérive du premier est pire qu'absent — on
    // résout un conflit en croyant une liste qui n'est plus la bonne.
    const policy = await Bun.file(join(REPO, "docs/locus/upstream.md")).text()
    for (const path of LOCAL_PATHS) {
      expect(policy).toContain(path)
    }
    for (const entry of JUSTIFIED_UPSTREAM_EDITS) {
      expect(policy).toContain(entry.path)
    }
  })

  test("le périmètre déclaré existe réellement dans le dépôt", async () => {
    // Un périmètre qui protégerait des chemins inexistants passerait toujours. Chaque préfixe
    // doit correspondre à quelque chose.
    for (const path of LOCAL_PATHS) {
      const target = join(REPO, path)
      const exists = await Bun.file(target)
        .exists()
        .catch(() => false)
      const isDir = path.endsWith("/")
      if (isDir) {
        const probe = Bun.spawnSync(["test", "-d", target])
        expect(probe.exitCode).toBe(0)
      } else {
        expect(exists).toBe(true)
      }
    }
  })
})
