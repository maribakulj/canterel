import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  REFUSAL_CODES,
  admit,
  clampPolicy,
  hasBoundedBudget,
  insufficientResources,
  levelRank,
  missingCapabilities,
  type LocalPolicy,
} from "../../src/locus/admission.ts"
import type { CapabilityManifest, MissionEnvelope } from "../../src/locus/lep/generated.ts"

const FIXTURES = join(import.meta.dir, "fixtures")

/** Lire une fixture du corpus de W0.7 en retirant son enveloppe `_fixture`. */
function fixture<T>(name: string): T {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>
  const { _fixture, ...body } = raw
  void _fixture
  return body as T
}

function marker(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>
  return (raw["_fixture"] ?? {}) as Record<string, unknown>
}

const REFUSED_MISSION = () => fixture<MissionEnvelope>("mission-refused.json")
const MACOS_MANIFEST = () => fixture<CapabilityManifest>("manifest-macos.json")
const ACCEPTED_MISSION = () => fixture<MissionEnvelope>("mission-accepted.json")
const VM_MANIFEST = () => fixture<CapabilityManifest>("manifest-vm-linux.json")

describe("le test de sortie de W2.8 — la fixture de refus produit le bon code", () => {
  test("la paire de refus du corpus rend `sandbox_unavailable`", () => {
    // Le corpus de W0.7 énonce lui-même le cas : « sandbox.minimum_level S3 > capability
    // sandbox.levels [S1,S2] ». Le worker macOS de référence n'offre que Seatbelt.
    const verdict = admit({ mission: REFUSED_MISSION(), manifest: MACOS_MANIFEST() })

    expect(verdict.accepted).toBe(false)
    if (verdict.accepted) return
    expect(verdict.code).toBe("sandbox_unavailable")
    // Les détails sont canoniques, le message ne l'est pas : c'est sur eux qu'une machine décide.
    expect(verdict.details["required_level"]).toBe("S3")
    expect(verdict.details["offered_levels"]).toEqual(["S1", "S2"])
  })

  test("la fixture est bien celle que le corpus destine au refus", () => {
    // Sans ce contrôle, le test précédent passerait tout aussi bien sur une fixture renommée ou
    // remplacée — et vérifierait alors une admission qui n'est plus celle que W0.7 a définie.
    const mission = marker("mission-refused.json")
    expect(mission["expect"]).toBe("refused")
    expect(mission["pairs_with"]).toBe("capability-manifest.json")
    expect(String(mission["reason"])).toContain("S3")
  })

  test("la paire d'acceptation du corpus est acceptée", () => {
    // La moitié qui empêche de tout refuser : un admetteur qui dit non à tout passerait le test de
    // sortie sans rien valoir.
    expect(admit({ mission: ACCEPTED_MISSION(), manifest: VM_MANIFEST() }).accepted).toBe(true)
    expect(marker("mission-accepted.json")["expect"]).toBe("accepted")
  })

  test("croiser les paires inverse les verdicts", () => {
    // La mission nominale (S3) contre le worker macOS : refusée pour la même raison.
    const crossed = admit({ mission: ACCEPTED_MISSION(), manifest: MACOS_MANIFEST() })
    expect(crossed.accepted).toBe(false)
    if (!crossed.accepted) expect(crossed.code).toBe("sandbox_unavailable")

    // Et la mission refusée (S3) contre le worker VM Linux, qui offre S3 : acceptée.
    expect(admit({ mission: REFUSED_MISSION(), manifest: VM_MANIFEST() }).accepted).toBe(true)
  })
})

describe("codes de refus — §10.2", () => {
  test("les quatorze codes du texte sont présents, sans doublon", () => {
    expect(REFUSAL_CODES.length).toBe(14)
    expect(new Set(REFUSAL_CODES).size).toBe(14)
    for (const code of [
      "sandbox_unavailable",
      "local_policy_denied",
      "budget_unenforceable",
      "worker_draining",
    ] as const) {
      expect(REFUSAL_CODES).toContain(code)
    }
  })

  test("un protocole d'un autre majeur est refusé avant tout le reste", () => {
    // Ce qui rend le document ininterprétable passe en premier : refuser sur les ressources
    // dirait « pas assez de CPU » d'une mission qu'on ne sait de toute façon pas lire.
    const mission = { ...REFUSED_MISSION(), protocol: "lep/2.0" } as MissionEnvelope
    const verdict = admit({ mission, manifest: MACOS_MANIFEST() })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("unsupported_protocol")
  })

  test("un mode réseau inapplicable est refusé", () => {
    const mission = {
      ...ACCEPTED_MISSION(),
      // `full` est le seul mode que ce manifeste n'offre pas — la première version de ce test
      // avait choisi `connector-only`, que le worker VM annonce bel et bien, et vérifiait donc
      // un refus qui n'avait pas lieu d'être.
      sandbox: { minimum_level: "S3", network: "full" },
    } as unknown as MissionEnvelope
    const verdict = admit({ mission, manifest: VM_MANIFEST() })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) {
      expect(verdict.code).toBe("network_policy_unsupported")
      expect(verdict.details["requested_mode"]).toBe("full")
    }
  })

  test("une classe de données au-delà du worker est refusée", () => {
    const mission = { ...ACCEPTED_MISSION(), data_class: "restricted" } as unknown as MissionEnvelope
    const verdict = admit({ mission, manifest: VM_MANIFEST() })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("confidentiality_unsupported")
  })

  test("une capacité absente est refusée avec la liste de ce qui manque", () => {
    const mission = {
      ...ACCEPTED_MISSION(),
      required_capabilities: ["math-formal", "un-truc-absent"],
    } as unknown as MissionEnvelope
    const verdict = admit({ mission, manifest: VM_MANIFEST() })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) {
      expect(verdict.code).toBe("capability_missing")
      expect(verdict.details["missing"]).toEqual(["un-truc-absent"])
    }
  })

  test("des ressources au-delà de l'inventaire sont refusées", () => {
    const mission = {
      ...ACCEPTED_MISSION(),
      resources: { cpu: 4096, memory_mb: 1, disk_mb: 1 },
    } as unknown as MissionEnvelope
    const verdict = admit({ mission, manifest: VM_MANIFEST() })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) {
      expect(verdict.code).toBe("resource_exhausted")
      expect(verdict.details["what"]).toBe("cpu")
    }
  })

  test("un budget non borné est inapplicable, donc refusé", () => {
    // §17 : ce que la fixture `invalid-mission-unbounded-budget` du corpus démontre côté schéma.
    const mission = { ...ACCEPTED_MISSION(), budget: {} } as unknown as MissionEnvelope
    const verdict = admit({ mission, manifest: VM_MANIFEST() })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("budget_unenforceable")
  })

  test("un worker qui se vide refuse tout, y compris ce qu'il pourrait tenir", () => {
    const verdict = admit({ mission: ACCEPTED_MISSION(), manifest: VM_MANIFEST(), policy: { draining: true } })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("worker_draining")
  })
})

describe("politique locale — §10.3, plus restrictive et jamais l'inverse", () => {
  test("la machine peut exiger plus que la mission", () => {
    const verdict = admit({
      mission: ACCEPTED_MISSION(),
      manifest: VM_MANIFEST(),
      policy: { minimumSandboxLevel: "S4" },
    })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("local_policy_denied")
  })

  test("une politique locale ne peut pas élargir ce que le manifeste offre", () => {
    // La règle n'est pas vérifiée après coup : elle est rendue impossible. `clampPolicy`
    // intersecte, donc une politique qui prétend autoriser `restricted` ne l'autorise pas.
    const manifest = VM_MANIFEST()
    const generous: LocalPolicy = { dataClasses: ["public", "restricted"] }
    expect(clampPolicy(generous, manifest).dataClasses).toEqual(["public"])

    const mission = { ...ACCEPTED_MISSION(), data_class: "restricted" } as unknown as MissionEnvelope
    const verdict = admit({ mission, manifest, policy: generous })
    expect(verdict.accepted).toBe(false)
    // Et le refus reste `confidentiality_unsupported` : c'est le manifeste qui refuse, pas la
    // politique — l'inverse laisserait croire qu'assouplir la politique suffirait.
    if (!verdict.accepted) expect(verdict.code).toBe("confidentiality_unsupported")
  })

  test("une politique locale peut restreindre en deçà du manifeste", () => {
    const mission = { ...ACCEPTED_MISSION(), data_class: "internal" } as unknown as MissionEnvelope
    const manifest = VM_MANIFEST()
    expect(admit({ mission, manifest }).accepted).toBe(true)
    const verdict = admit({ mission, manifest, policy: { dataClasses: ["public"] } })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("local_policy_denied")
  })

  test("un plafond de durée local est appliqué", () => {
    const verdict = admit({
      mission: ACCEPTED_MISSION(),
      manifest: VM_MANIFEST(),
      policy: { maxWallTimeSeconds: 1 },
    })
    expect(verdict.accepted).toBe(false)
    if (!verdict.accepted) expect(verdict.code).toBe("deadline_impossible")
  })

  test("une politique vide ne change rien", () => {
    expect(admit({ mission: ACCEPTED_MISSION(), manifest: VM_MANIFEST(), policy: {} }).accepted).toBe(true)
  })
})

describe("détails structurés", () => {
  test("l'ordre des niveaux est celui de §21.6", () => {
    expect(levelRank("S0")).toBeLessThan(levelRank("S3"))
    expect(levelRank("S3")).toBeLessThan(levelRank("S5"))
    // Un niveau inconnu ne doit pas se glisser entre deux connus.
    expect(levelRank("SX")).toBe(-1)
  })

  test("les champs facultatifs absents ne font pas échouer l'admission", () => {
    // Le schéma est ouvert : une mission 1.0 peut ne pas porter ce que ce code sait lire, et une
    // 1.1 peut porter ce qu'il ne connaît pas. Supposer la présence refuserait une mission valide.
    const bare = {
      protocol: "lep/1.0",
      task_id: "t",
      sandbox: { minimum_level: "S1" },
    } as unknown as MissionEnvelope
    const manifest = { ...MACOS_MANIFEST() }
    expect(admit({ mission: bare, manifest }).accepted).toBe(true)
    expect(missingCapabilities(bare, manifest)).toEqual([])
    expect(insufficientResources(bare, manifest)).toBeNull()
    expect(hasBoundedBudget(bare)).toBe(true)
  })
})
