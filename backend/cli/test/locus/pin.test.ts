import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { applyRewrites, REWRITES, SOURCE_REPO, vendoredFiles } from "../../src/locus/lep/vendor.ts"
import {
  describePin,
  documents,
  isDocument,
  readPin,
  requirePin,
  verifyAgainstSource,
  verifyPin,
} from "../../src/locus/schema-registry.ts"
import { LocusPinBroken } from "../../src/locus/errors.ts"

const REPO = join(import.meta.dir, "../../../..")

describe("épinglage du SDK — §8.1", () => {
  test("le SDK est épinglé à un commit, pas à une version publiée", () => {
    // §8.1 : « pendant la construction de la V1, épingler par commit Git plutôt que par version
    // npm publiée ».
    const pin = readPin()
    expect(pin.repo).toBe(SOURCE_REPO)
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  test("la copie locale est intacte", () => {
    // Le contrôle qui compte tous les jours : personne n'a retouché la copie à la main. Il tourne
    // hors ligne, donc partout, y compris dans une CI sans accès au dépôt amont.
    expect(verifyPin()).toEqual([])
    expect(describePin().files).toBe(vendoredFiles().length)
  })

  test("chaque fichier déclaré existe et est épinglé", () => {
    // Un fichier déclaré mais absent rendrait la vérification silencieusement partielle.
    const pin = readPin()
    for (const target of vendoredFiles()) {
      expect(existsSync(join(REPO, target))).toBe(true)
      expect(pin.files[target]?.sha256_vendored).toMatch(/^[0-9a-f]{64}$/)
    }
    // Et l'inverse : rien d'épinglé qui ne soit déclaré.
    expect(Object.keys(pin.files).sort()).toEqual([...vendoredFiles()].sort())
  })

  test("une retouche à la main est détectée", () => {
    const target = "backend/cli/src/locus/lep/generated.ts"
    const path = join(REPO, target)
    const original = readFileSync(path, "utf8")
    try {
      writeFileSync(path, `${original}\n// retouche\n`)
      expect(verifyPin()).toEqual([target])
      // `requirePin` est appelé au démarrage du mode worker : parler LEP avec un SDK retouché
      // produirait des messages qu'un serveur conforme refuserait en se plaignant du contenu
      // plutôt que de la cause.
      try {
        requirePin()
        throw new Error("aurait dû lever")
      } catch (error) {
        expect(LocusPinBroken.isInstance(error)).toBe(true)
      }
    } finally {
      writeFileSync(path, original)
    }
    expect(verifyPin()).toEqual([])
  })

  test("les réécritures sont déclarées avec leur raison", () => {
    // La règle de réécriture est ce qui distingue une copie reproductible d'une copie bricolée.
    // Sans raison écrite, la liste redevient un geste que personne ne peut rejouer.
    for (const rewrites of Object.values(REWRITES)) {
      for (const rewrite of rewrites) {
        expect(rewrite.reason.length).toBeGreaterThan(20)
        expect(rewrite.from.startsWith('"')).toBe(true)
      }
    }
  })

  test("la réécriture est déterministe et n'attrape que ce qu'elle déclare", () => {
    const target = "backend/cli/test/locus/harness/harness.ts"
    const source = `import type { Event } from "@locus/lep";\nconst s = "@locus/lepidoptere";\n`
    const out = applyRewrites(target, source)
    expect(out).toContain('from "../../../src/locus/lep/generated.ts"')
    // Le remplacement est littéral, guillemets compris : `"@locus/lep"` ne doit pas attraper
    // `"@locus/lepidoptere"`.
    expect(out).toContain('"@locus/lepidoptere"')
  })

  test("aucun fichier copié ne dépend encore d'un nom de workspace amont", () => {
    // C'est la propriété que la réécriture existe pour obtenir. La vérifier sur le résultat plutôt
    // que sur la règle est ce qui la rend vraie.
    for (const target of vendoredFiles()) {
      const content = readFileSync(join(REPO, target), "utf8")
      expect(content).not.toContain('from "@locus/')
      expect(content).not.toContain('from "../../../tooling/')
    }
  })
})

describe("vérification contre la source amont", () => {
  test("elle le dit quand elle ne peut pas tourner", () => {
    // `maribakulj/locusolus` est privé : la CI de ce fork n'a pas de quoi le lire, et ce contrôle
    // y sera toujours dégradé. Le dire vaut mieux que passer en silence — un contrôle qu'on croit
    // avoir lancé est pire qu'un contrôle absent.
    const result = verifyAgainstSource("/chemin/qui/n/existe/pas")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })

  test("avec une copie de travail de locusolus, elle rejoue la réécriture", () => {
    const locusolus = "/home/user/locusolus"
    if (!existsSync(join(locusolus, "packages/lep/src/generated.ts"))) {
      console.warn("[W2.5] locusolus absent : vérification contre la source non exécutée")
      return
    }
    const result = verifyAgainstSource(locusolus)
    expect(result.ok).toBe(true)
    // Ce que l'empreinte locale ne peut pas dire : que la règle déclarée est bien celle qui a
    // produit ces fichiers. Sans lui, une copie retouchée puis réépinglée serait cohérente avec
    // elle-même.
    if (result.ok) expect(result.drifted).toEqual([])
  })
})

describe("registre des documents", () => {
  test("les documents LEP viennent du SDK, pas d'une liste locale", () => {
    // Les réénumérer ici serait la duplication cross-repo du contrat que docs/locus/CLAUDE.md
    // interdit.
    expect(documents()).toContain("MissionEnvelope")
    expect(documents()).toContain("CapabilityManifest")
    expect(isDocument("Event")).toBe(true)
    expect(isDocument("PasUnDocument")).toBe(false)
  })
})
