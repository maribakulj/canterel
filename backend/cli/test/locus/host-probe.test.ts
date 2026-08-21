import { describe, expect, test } from "bun:test"

import {
  buildManifest,
  sandboxBackend,
  sandboxLevels,
  type HostProbe,
} from "../../src/locus/capability-manifest.ts"
import { LocusInventoryUnmeasured } from "../../src/locus/errors.ts"
import {
  bubblewrapCommand,
  bubblewrapStarts,
  freeDiskMb,
  probeFrom,
  realProbe,
  realSensors,
  type Launch,
  type Sensors,
} from "../../src/locus/host-probe.ts"

/**
 * Test de sortie de `W22.e` — **la sonde réelle**, ADR 0025 de `locusolus`.
 *
 * 1. `bwrap` présent mais refusé n'est **pas** `bwrap` qui marche — le cas que l'ancien adaptateur
 *    rendait inatteignable.
 * 2. Une sonde qui n'a pas conclu rend l'absence, et l'absence ne donne jamais la capacité.
 * 3. Le disque non mesuré fait **refuser** le manifeste, il ne devient pas zéro.
 * 4. L'adaptateur **réel** est exercé, pas seulement une sonde injectée.
 */

/** Des capteurs simulés : le seul moyen d'exercer un hôte cassé sans en avoir un sous la main. */
function sensors(input: {
  readonly binaries?: readonly string[]
  readonly launch?: Launch
  readonly freeBytes?: number | undefined
  readonly platform?: string
}): Sensors {
  const binaries = input.binaries ?? ["bwrap", "true"]
  return {
    which: (binary) => (binaries.includes(binary) ? `/usr/bin/${binary}` : null),
    launch: () => input.launch ?? "started",
    freeBytes: () => input.freeBytes,
    cpuCores: 4,
    memoryMb: 8192,
    platform: input.platform ?? "linux",
    arch: "x86_64",
  }
}

describe("W22.e — la sonde réelle", () => {
  // -------------------------------------------------------------------------------------------
  // 1. Le cas que l'ancien adaptateur rendait inatteignable
  // -------------------------------------------------------------------------------------------

  /**
   * **Un `bwrap` présent que l'hôte refuse ne vaut pas un `bwrap` qui marche.**
   *
   * Le test qui porte l'item. L'ancien adaptateur écrivait `() => Bun.which("bwrap") !== null` :
   * comme `sandboxBackend` appelle `which("bwrap")` **avant** d'appeler `bubblewrapWorks()`, la
   * seconde barrière ne pouvait être atteinte que si la première était passée. Elle rendait donc
   * toujours vrai — elle **ne pouvait pas refuser**. Ce test est précisément celui qu'elle rendait
   * impossible à écrire.
   *
   * Le cas est réel : sur Ubuntu 24.04, AppArmor bloque les namespaces utilisateur non privilégiés
   * et `bwrap` échoue alors qu'il est installé.
   */
  test("bwrap présent mais refusé ne donne pas S2", () => {
    const refuse = probeFrom(sensors({ launch: "refused" }), ".")

    expect(refuse.which("bwrap")).not.toBeNull()
    expect(refuse.bubblewrapWorks()).toBe(false)
    expect(sandboxBackend(refuse)).toBe("none")
    expect(sandboxLevels(refuse)).toEqual(["S1"])
  })

  /** **Un `bwrap` qui démarre donne S2, sinon le test précédent ne prouverait rien.** */
  test("bwrap qui démarre donne S2", () => {
    const marche = probeFrom(sensors({ launch: "started" }), ".")

    expect(marche.bubblewrapWorks()).toBe(true)
    expect(sandboxBackend(marche)).toBe("bubblewrap")
    expect(sandboxLevels(marche)).toEqual(["S1", "S2"])
  })

  /** **L'invocation demande le namespace utilisateur, sans quoi elle ne prouverait rien.** */
  test("l'invocation exerce le namespace utilisateur non privilégié", () => {
    const command = bubblewrapCommand("/usr/bin/true")

    expect(command).toContain("--unshare-user")
    expect(command[0]).toBe("bwrap")
    expect(command.at(-1)).toBe("/usr/bin/true")
  })

  // -------------------------------------------------------------------------------------------
  // 2. Trois issues, et l'absence ne donne rien
  // -------------------------------------------------------------------------------------------

  /**
   * **« On n'a pas pu essayer » n'est ni oui ni non, et ne donne pas la capacité.**
   *
   * C'est la règle de `W4.b` chez `locusolus` : une sonde non exécutée n'est pas une sonde réussie.
   * Ici elle vaut doublement, parce qu'annoncer trop est la seule faute qui compte pour un manifeste
   * de capacités.
   */
  test("une sonde qui n'a pas conclu rend l'absence, et n'accorde rien", () => {
    const sansTrue = bubblewrapStarts(sensors({ binaries: ["bwrap"] }))
    const nonTentee = bubblewrapStarts(sensors({ launch: "untried" }))
    const sansBinaire = bubblewrapStarts(sensors({ binaries: [] }))

    expect(sansTrue).toBeUndefined()
    expect(nonTentee).toBeUndefined()
    expect(sansBinaire).toBe(false)

    const ignorante = probeFrom(sensors({ launch: "untried" }), ".")
    expect(sandboxBackend(ignorante)).toBe("none")
  })

  /**
   * **Le binaire absent est une conclusion, l'essai impossible est une ignorance.**
   *
   * Les deux mènent au même refus de S2 et ne se disent pas pareil — même refus de collapse que les
   * absences de `xiiif` §19. Un exploitant à qui l'on dit « bwrap n'est pas installé » l'installe ;
   * à qui l'on dit « je n'ai pas su essayer » regarde ailleurs.
   */
  test("binaire absent et essai impossible ne se confondent pas", () => {
    expect(bubblewrapStarts(sensors({ binaries: [] }))).toBe(false)
    expect(bubblewrapStarts(sensors({ binaries: ["bwrap"] }))).toBeUndefined()
    expect(bubblewrapStarts(sensors({ binaries: [] }))).not.toBeUndefined()
  })

  // -------------------------------------------------------------------------------------------
  // 3. Le disque non mesuré fait refuser
  // -------------------------------------------------------------------------------------------

  /**
   * **Un disque non mesuré fait refuser le manifeste, il ne devient pas zéro.**
   *
   * `disk_free_mb` est requis par le protocole : l'absence ne peut pas partir sur le fil. Annoncer
   * `0` ferait lire « ce worker n'a plus de place » là où il faut lire « ce worker ne sait pas
   * mesurer sa place » — deux causes opposées pour la même conséquence, et une seule des deux se
   * répare en libérant du disque.
   */
  test("un disque non mesuré fait refuser le manifeste", () => {
    const aveugle = probeFrom(sensors({ freeBytes: undefined }), ".")
    expect(aveugle.diskFreeMb).toBeUndefined()

    expect(() => buildManifest({ probe: aveugle, workerId: "w-1" })).toThrow()
    try {
      buildManifest({ probe: aveugle, workerId: "w-1" })
    } catch (error) {
      expect(LocusInventoryUnmeasured.isInstance(error)).toBe(true)
      if (LocusInventoryUnmeasured.isInstance(error)) {
        expect(error.data.quantity).toBe("disk_free_mb")
      }
    }
  })

  /** **Un disque mesuré, même vide, laisse construire — c'est un fait, pas une ignorance.** */
  test("un disque mesuré à zéro n'est pas une absence", () => {
    const plein = probeFrom(sensors({ freeBytes: 0 }), ".")

    expect(plein.diskFreeMb).toBe(0)
    expect(buildManifest({ probe: plein, workerId: "w-1" }).resources.disk_free_mb).toBe(0)
  })

  /** **La conversion est en mégaoctets, arrondie vers le bas.** */
  test("l'espace libre est rendu en mégaoctets, jamais arrondi vers le haut", () => {
    expect(freeDiskMb(sensors({ freeBytes: 5 * 1024 * 1024 }), ".")).toBe(5)
    expect(freeDiskMb(sensors({ freeBytes: 1024 * 1024 - 1 }), ".")).toBe(0)
    expect(freeDiskMb(sensors({ freeBytes: -1 }), ".")).toBeUndefined()
    expect(freeDiskMb(sensors({ freeBytes: Number.NaN }), ".")).toBeUndefined()
  })

  // -------------------------------------------------------------------------------------------
  // 4. L'adaptateur réel, exercé
  // -------------------------------------------------------------------------------------------

  /**
   * **L'adaptateur de production est exercé, pas seulement le port.**
   *
   * C'est la décision 2 de l'ADR 0025 : un port impeccablement testé contre une sonde injectée ne
   * vaut rien si son unique implémentation réelle ment, et le déséquilibre est invisible parce que
   * la CI est verte. Ce test-ci touche la vraie machine.
   */
  test("les capteurs réels mesurent le disque de cette machine", () => {
    const reel = realSensors()
    const octets = reel.freeBytes(".")

    expect(typeof octets).toBe("number")
    expect(octets).toBeGreaterThan(0)
    expect(freeDiskMb(reel, ".")).toBeGreaterThan(0)
  })

  /**
   * **La sonde réelle conclut sur `bwrap`, dans un sens ou dans l'autre.**
   *
   * L'assertion ne fixe pas *lequel* : la CI n'a pas forcément `bwrap`, et un test qui exigerait un
   * verdict précis dirait plus sur le runner que sur le code. Ce qu'il exige est que la sonde
   * **conclue** — `undefined` ici voudrait dire qu'elle n'a pas su faire l'essai sur une machine
   * ordinaire, ce qui serait un défaut.
   *
   * Et il exige l'accord avec la réalité : si `bwrap` est absent, la réponse est exactement `false`.
   */
  test("la sonde réelle conclut sur bwrap, et son verdict suit la machine", () => {
    const verdict = bubblewrapStarts(realSensors())

    expect(verdict).not.toBeUndefined()
    if (Bun.which("bwrap") === null) {
      expect(verdict).toBe(false)
    }
  })

  /**
   * **Un lancement qui lève est « pas tenté », jamais « refusé ».**
   *
   * `Bun.spawnSync` lève quand l'exécutable est introuvable — une exception dit que **l'essai n'a
   * pas eu lieu**, et la ranger avec « la sandbox refuse » perdrait exactement la distinction que ce
   * module existe pour tenir. Une passe de mutation a trouvé le trou : rien n'exerçait le `catch`.
   *
   * Le cas est atteignable sur n'importe quelle machine, ce qui est ce qui le rend testable — et un
   * `refused` ici ferait annoncer « l'hôte refuse la sandbox » sur un hôte qu'on n'a pas interrogé.
   */
  test("un lancement qui lève est pas-tenté, pas refusé", () => {
    const reel = realSensors()

    expect(reel.launch(["ce-binaire-nexiste-pas-xyz"])).toBe("untried")
    expect(reel.launch([Bun.which("true") ?? "/usr/bin/true"])).toBe("started")
  })

  /** **La sonde de production se construit et rend un manifeste.** */
  test("la sonde de production rend un manifeste constructible", () => {
    const probe = realProbe()

    expect(probe.diskFreeMb).toBeGreaterThan(0)
    expect(probe.cpuCores).toBeGreaterThan(0)
    expect(buildManifest({ probe, workerId: "w-reel" }).resources.disk_free_mb).toBe(
      probe.diskFreeMb as number,
    )
  })

  /**
   * **Le point d'appel n'a plus de sonde à lui.**
   *
   * L'ancien défaut vivait dans `cli/cmd/worker.ts`, hors du périmètre local et donc hors des tests
   * de ce répertoire. Le ramener sous `src/locus/` est ce qui rend ce fichier possible : une sonde
   * qu'aucun test ne peut atteindre est une sonde qui dérivera.
   */
  test("le point d'appel délègue au module local", async () => {
    const source = await Bun.file(
      new URL("../../src/cli/cmd/worker.ts", import.meta.url).pathname,
    ).text()

    expect(source).toContain("locus.realProbe()")
    expect(source).not.toContain("bubblewrapWorks")
    expect(source).not.toContain("diskFreeMb")
  })
})

/** Le port accepte toujours une sonde entièrement simulée : l'injection n'est pas retirée. */
test("une sonde injectée reste possible", () => {
  const simulee: HostProbe = {
    platform: "darwin",
    arch: "arm64",
    which: (binary) => (binary === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
    bubblewrapWorks: () => undefined,
    cpuCores: 10,
    memoryMb: 32768,
    diskFreeMb: 500_000,
  }

  expect(sandboxBackend(simulee)).toBe("seatbelt")
  expect(buildManifest({ probe: simulee, workerId: "w-mac" }).resources.disk_free_mb).toBe(500_000)
})
