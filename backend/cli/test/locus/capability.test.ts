import { describe, expect, test } from "bun:test"

import {
  DEFAULT_DATA_CLASSES,
  TOOLCHAIN_PROBES,
  accelerators,
  buildManifest,
  manifestHash,
  networkModes,
  sandboxBackend,
  sandboxLevels,
  toolchains,
  type HostProbe,
} from "../../src/locus/capability-manifest.ts"
import { describeChange, isRegression, poll, startWatch } from "../../src/locus/capability-watch.ts"

/**
 * Une machine simulée. Toute la raison d'être de l'injection : le test de sortie porte sur ce que
 * ce worker annonce **sur un Mac**, et il doit tourner dans une CI Linux.
 */
function probeOf(over: Partial<HostProbe> & { binaries?: readonly string[] } = {}): HostProbe {
  const binaries = new Set(over.binaries ?? [])
  return {
    platform: over.platform ?? "linux",
    arch: over.arch ?? "x64",
    ...(over.release ? { release: over.release } : {}),
    which: over.which ?? ((binary: string) => (binaries.has(binary) ? `/usr/bin/${binary}` : null)),
    bubblewrapWorks: over.bubblewrapWorks ?? (() => true),
    cpuCores: over.cpuCores ?? 8,
    memoryMb: over.memoryMb ?? 16384,
    diskFreeMb: over.diskFreeMb ?? 100_000,
  }
}

const MACOS_ARM = { platform: "darwin", arch: "arm64", binaries: ["sandbox-exec", "python3", "git"] } as const

describe("le test de sortie de W2.6 — sur macOS, S1/S2 et mps, jamais plus", () => {
  test('un Mac Apple Silicon annonce exactement `["S1","S2"]` et `mps`', () => {
    const manifest = buildManifest({ probe: probeOf(MACOS_ARM), workerId: "canterel-mac" })

    expect(manifest.sandbox.levels).toEqual(["S1", "S2"])
    expect((manifest.accelerators ?? []).map((a) => a.type)).toEqual(["mps"])

    // « Jamais plus » est la moitié qui compte : la sandbox amont est du containment en écriture
    // sans cgroups ni quota, donc S3/S4 seraient une promesse que la machine ne tient pas.
    for (const forbidden of ["S0", "S3", "S4", "S5"]) {
      expect(manifest.sandbox.levels).not.toContain(forbidden)
    }
    // Et pas d'accélérateur inventé : un Mac n'a ni CUDA ni ROCm.
    for (const forbidden of ["cuda", "rocm", "tpu"]) {
      expect((manifest.accelerators ?? []).map((a) => a.type)).not.toContain(forbidden)
    }
    expect(manifest.platform).toEqual({ os: "macos", arch: "arm64" })
    expect(manifest.sandbox.backend).toBe("seatbelt")
  })

  test("un Mac Intel n'annonce pas mps", () => {
    // Metal Performance Shaders n'est pas utilisable comme accélérateur de calcul sur Intel ;
    // l'annoncer ferait échouer les missions qui le demandent.
    const manifest = buildManifest({ probe: probeOf({ ...MACOS_ARM, arch: "x64" }), workerId: "w" })
    expect(manifest.accelerators).toEqual([])
    expect(manifest.sandbox.levels).toEqual(["S1", "S2"])
  })

  test("un Mac sans sandbox-exec tombe à S1", () => {
    const manifest = buildManifest({
      probe: probeOf({ platform: "darwin", arch: "arm64", binaries: [] }),
      workerId: "w",
    })
    expect(manifest.sandbox.levels).toEqual(["S1"])
    expect(manifest.sandbox.backend).toBe("none")
  })
})

describe("le niveau annoncé est le niveau réel", () => {
  test("S1 est toujours là, S2 seulement avec un backend qui marche", () => {
    // S1 = permissions/logical (docs/03) : le système de permissions amont existe toujours.
    expect(sandboxLevels(probeOf({ binaries: [] }))).toEqual(["S1"])
    expect(sandboxLevels(probeOf({ binaries: ["bwrap"] }))).toEqual(["S1", "S2"])
  })

  test("un bwrap présent mais qui ne démarre pas ne donne pas S2", () => {
    // Le cas courant sur Ubuntu 24.04 : la politique AppArmor de l'hôte bloque les namespaces
    // utilisateur non privilégiés. Annoncer S2 sur la seule présence du binaire promettrait une
    // isolation que la machine refuse.
    const probe = probeOf({ binaries: ["bwrap"], bubblewrapWorks: () => false })
    expect(sandboxBackend(probe)).toBe("none")
    expect(sandboxLevels(probe)).toEqual(["S1"])
  })

  test("une plateforme sans backend connu n'invente rien", () => {
    expect(sandboxLevels(probeOf({ platform: "win32", binaries: ["bwrap", "sandbox-exec"] }))).toEqual(["S1"])
  })

  test("sans isolation, le worker n'annonce pas savoir couper le réseau", () => {
    // `full` seul est une mauvaise nouvelle honnête ; un `deny` qui ne dénie rien est pire.
    expect(networkModes(probeOf({ binaries: [] }))).toEqual(["full"])
    expect(networkModes(probeOf({ binaries: ["bwrap"] }))).toEqual(["deny", "full"])
  })

  test("`allowlist` n'est jamais annoncé", () => {
    // Ni Seatbelt tel que l'amont l'écrit, ni bubblewrap ne filtrent par hôte. Une restriction
    // qu'on croit appliquée est pire que pas de restriction du tout.
    for (const probe of [probeOf({ binaries: ["bwrap"] }), probeOf({ ...MACOS_ARM })]) {
      expect(networkModes(probe)).not.toContain("allowlist")
      expect(networkModes(probe)).not.toContain("connector-only")
    }
  })

  test("l'attestation est annoncée fausse tant qu'on ne sait pas attester", () => {
    const manifest = buildManifest({ probe: probeOf({ ...MACOS_ARM }), workerId: "w" })
    expect(manifest.sandbox.attestation).toBe(false)
  })
})

describe("inventaire", () => {
  test("les accélérateurs Linux viennent des binaires présents", () => {
    expect(accelerators(probeOf({ binaries: ["nvidia-smi"] })).map((a) => a.type)).toEqual(["cuda"])
    expect(accelerators(probeOf({ binaries: ["rocm-smi"] })).map((a) => a.type)).toEqual(["rocm"])
    expect(accelerators(probeOf({ binaries: [] }))).toEqual([])
  })

  test("les toolchains sont triées et n'annoncent que ce qui est là", () => {
    const found = toolchains(probeOf({ binaries: ["python3", "cargo", "git"] }))
    expect(found).toEqual(["git", "python", "rust"])
    // Trié : deux inventaires égaux doivent donner le même hash, et l'ordre de détection ne doit
    // pas s'y glisser.
    expect([...found].sort()).toEqual([...found])
  })

  test("chaque profil déclaré est sondé par un binaire distinct", () => {
    // Deux profils sur le même binaire annonceraient deux capacités pour une seule preuve.
    const binaries = TOOLCHAIN_PROBES.map((entry) => entry.binary)
    expect(new Set(binaries).size).toBe(binaries.length)
    expect(new Set(TOOLCHAIN_PROBES.map((e) => e.profile)).size).toBe(TOOLCHAIN_PROBES.length)
  })

  test("les classes de données sont une politique, pas une détection", () => {
    // `confidential` et `restricted` demandent qu'on les écrive : un worker qui les annonce par
    // défaut se verra confier des données que personne n'a décidé de lui confier.
    expect(DEFAULT_DATA_CLASSES).toEqual(["public", "internal"])
    const manifest = buildManifest({ probe: probeOf(), workerId: "w" })
    expect(manifest.data_classes).not.toContain("confidential")
    expect(manifest.data_classes).not.toContain("restricted")

    const widened = buildManifest({ probe: probeOf(), workerId: "w", dataClasses: ["public", "confidential"] })
    expect(widened.data_classes).toEqual(["public", "confidential"])
  })
})

describe("hash du manifeste", () => {
  test("deux inventaires égaux ont le même hash", () => {
    const a = buildManifest({ probe: probeOf({ binaries: ["python3", "git"] }), workerId: "w" })
    const b = buildManifest({ probe: probeOf({ binaries: ["git", "python3"] }), workerId: "w" })
    // L'ordre de détection ne doit pas produire deux hashes : le serveur croirait à un changement
    // de capacités à chaque reconnexion.
    expect(manifestHash(a)).toBe(manifestHash(b))
    expect(manifestHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("un inventaire différent a un hash différent", () => {
    const withSandbox = buildManifest({ probe: probeOf({ binaries: ["bwrap"] }), workerId: "w" })
    const without = buildManifest({ probe: probeOf({ binaries: [] }), workerId: "w" })
    expect(manifestHash(withSandbox)).not.toBe(manifestHash(without))
  })
})

describe("surveillance des capacités", () => {
  const input = (binaries: readonly string[], over: Partial<HostProbe> = {}) => ({
    probe: probeOf({ binaries, ...over }),
    workerId: "w",
  })

  test("un sondage sans changement est silencieux", () => {
    // Le cas de loin le plus fréquent. Un watcher qui rend un objet à chaque tour oblige son
    // appelant à comparer, ce qui ramène chez lui le bug qu'on vient d'éviter.
    const state = startWatch(input(["bwrap", "python3"]))
    const result = poll(state, input(["python3", "bwrap"]))
    expect(result.change).toBeNull()
    expect(result.state).toBe(state)
  })

  test("une perte de S2 est signalée comme une régression", () => {
    // Perdre S2 parce que bwrap ne démarre plus est précisément le cas où le serveur doit cesser
    // d'envoyer ce qui l'exige.
    const state = startWatch(input(["bwrap"]))
    const result = poll(state, input(["bwrap"], { bubblewrapWorks: () => false }))
    expect(result.change).not.toBeNull()
    expect(result.change?.reasons.some((r) => r.includes("S2"))).toBe(true)
    expect(isRegression(result.change!)).toBe(true)
  })

  test("un gain n'est pas une régression", () => {
    const state = startWatch(input([]))
    const result = poll(state, input(["python3"]))
    expect(result.change?.reasons.some((r) => r.includes("gagnées"))).toBe(true)
    expect(isRegression(result.change!)).toBe(false)
  })

  test("les pertes sont énoncées avant les gains", () => {
    // Quand un opérateur lit un journal, « S2 perdu » doit arriver en premier, pas noyé après
    // trois toolchains installées.
    const before = buildManifest(input(["bwrap"]))
    const after = buildManifest(input(["python3", "git"], { bubblewrapWorks: () => false }))
    const reasons = describeChange(before, after)
    const firstLoss = reasons.findIndex((r) => r.includes("perdu"))
    const firstGain = reasons.findIndex((r) => r.includes("gagn"))
    expect(firstLoss).toBeGreaterThanOrEqual(0)
    expect(firstGain).toBeGreaterThan(firstLoss)
  })

  test("un changement inexpliqué le dit au lieu de rendre une liste vide", () => {
    // Un `reasons` vide laisserait croire à un faux positif du hash.
    const before = buildManifest(input([]))
    const after = buildManifest({ ...input([]), workerId: "autre-worker" })
    const reasons = describeChange(before, after)
    expect(reasons).toEqual(["inventaire modifié sur une dimension non détaillée"])
  })

  test("l'état rendu suit le dernier sondage", () => {
    const state = startWatch(input([]))
    const result = poll(state, input(["bwrap"]))
    expect(result.change).not.toBeNull()
    expect(result.state.hash).toBe(result.change!.current)
    expect(result.state.manifest.sandbox.levels).toEqual(["S1", "S2"])
    // Et un sondage identique juste après redevient silencieux.
    expect(poll(result.state, input(["bwrap"])).change).toBeNull()
  })
})
