import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  HELLO_REQUIRED_FIELDS,
  checkHelloConformance,
  checkServerSignature,
  locusStateDir,
  register,
  type HandshakeTransport,
  type ServerHello,
} from "../../src/locus/registration.ts"
import { manifestHash } from "../../src/locus/capability-manifest.ts"
import type { HostProbe } from "../../src/locus/capability-manifest.ts"
import { loadOrCreateIdentity, sign, verify } from "../../src/locus/identity.ts"
import { helloSignedBody, type WorkerHello } from "../../src/locus/protocol.ts"
import { LocusProtocolRefused, LocusServerRejected } from "../../src/locus/errors.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "locus-registration-"))

function probeOf(binaries: readonly string[] = ["sandbox-exec"]): HostProbe {
  const present = new Set(binaries)
  return {
    platform: "darwin",
    arch: "arm64",
    which: (binary) => (present.has(binary) ? `/usr/bin/${binary}` : null),
    bubblewrapWorks: () => false,
    cpuCores: 8,
    memoryMb: 16384,
    diskFreeMb: 50_000,
  }
}

/** Un serveur de complaisance : il accepte, et retient ce qu'on lui a envoyé. */
function serverOf(answer: ServerHello, seen: { hello?: WorkerHello } = {}): HandshakeTransport {
  return async (hello) => {
    seen.hello = hello
    return answer
  }
}

const NOMINAL: ServerHello = { supported_versions: ["lep/1.0"], features: ["late-results"], server_sequence: 7 }

describe("conformance §8.2 — le test de sortie de W2.7", () => {
  test("le hello porte tout ce que §8.2 énumère, et il est signé", async () => {
    const seen: { hello?: WorkerHello } = {}
    const result = await register({
      stateDir: scratch(),
      probe: probeOf(),
      transport: serverOf(NOMINAL, seen),
      endpoint: "https://locus.example",
    })

    // La liste vit dans le module, pas dans ce test : un test qui porte sa propre liste finit par
    // vérifier ce qu'il a écrit plutôt que ce que la spec demande.
    expect(checkHelloConformance(result.hello, result.identity.public.public_key)).toEqual([])
    expect(HELLO_REQUIRED_FIELDS.length).toBeGreaterThan(8)

    // Et le hello envoyé est bien celui qui a été vérifié.
    expect(seen.hello).toEqual(result.hello)
    expect(verify(result.identity.public.public_key, helloSignedBody(result.hello), result.hello.signature)).toBe(true)
  })

  test("le hash du manifeste transporté est celui du manifeste annoncé", async () => {
    // S'ils divergent, le serveur croit connaître des capacités que le worker n'a pas — ce qui est
    // pire que de ne pas les connaître.
    const result = await register({
      stateDir: scratch(),
      probe: probeOf(),
      transport: serverOf(NOMINAL),
      endpoint: "https://locus.example",
    })
    expect(result.hello.capability_manifest_hash).toBe(manifestHash(result.manifest))
    expect(result.manifest.worker_id).toBe(result.identity.public.worker_id)
    // Le manifeste dit ce que la machine sait faire : macOS avec sandbox-exec, donc S1/S2.
    expect(result.manifest.sandbox.levels).toEqual(["S1", "S2"])
  })

  test("un champ manquant est un constat, pas un silence", () => {
    // Le test précédent ne vaut que si celui-ci sait rougir.
    const broken = { protocol: "lep/1.0", supported_versions: [], features: [], nonce: "n", signature: "x" }
    const findings = checkHelloConformance(broken as unknown as WorkerHello, "")
    expect(findings.some((f) => f.includes("worker_id"))).toBe(true)
    expect(findings.some((f) => f.includes("supported_versions` vide"))).toBe(true)
    expect(findings.some((f) => f.includes("signature"))).toBe(true)
  })

  test("l'enregistrement rend la séquence reconnue par le serveur", async () => {
    // §8.4 étape 2 : c'est le point de départ de la reprise.
    const result = await register({
      stateDir: scratch(),
      probe: probeOf(),
      transport: serverOf(NOMINAL),
      endpoint: "https://locus.example",
    })
    expect(result.serverSequence).toBe(7)

    // Un serveur qui n'acquitte rien rend -1, pas `undefined` : « rien acquitté » et « inconnu »
    // ne doivent pas se ressembler.
    const fresh = await register({
      stateDir: scratch(),
      probe: probeOf(),
      transport: serverOf({ supported_versions: ["lep/1.0"] }),
      endpoint: "https://locus.example",
    })
    expect(fresh.serverSequence).toBe(-1)
  })
})

describe("refus au handshake", () => {
  test("un serveur d'un autre majeur est refusé", async () => {
    await expect(
      register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: serverOf({ supported_versions: ["lep/2.0"] }),
        endpoint: "https://locus.example",
      }),
    ).rejects.toThrow()
  })

  test("un serveur qui n'annonce aucune version est refusé", async () => {
    try {
      await register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: serverOf({}),
        endpoint: "https://locus.example",
      })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusProtocolRefused.isInstance(error)).toBe(true)
    }
  })

  test("une réponse illisible est refusée avec l'endpoint fautif", async () => {
    try {
      await register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: async () => "pas un objet",
        endpoint: "https://locus.example",
      })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusProtocolRefused.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusProtocolRefused>).data.reason).toContain("locus.example")
    }
  })

  test("un transport en panne devient un refus nommé", async () => {
    try {
      await register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: async () => {
          throw new Error("ECONNRESET")
        },
        endpoint: "https://locus.example",
      })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusServerRejected.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusServerRejected>).data.reason).toContain("ECONNRESET")
    }
  })

  test("un serveur plus récent est accepté, pas refusé", async () => {
    // docs/06 : le mineur n'ajoute que des champs optionnels. Refuser figerait le protocole.
    const result = await register({
      stateDir: scratch(),
      probe: probeOf(),
      transport: serverOf({ supported_versions: ["lep/1.7"], features: ["late-results", "inconnue-du-futur"] }),
      endpoint: "https://locus.example",
    })
    expect(result.handshake.version).toBe("lep/1.7")
    expect(result.handshake.negotiated.features).toContain("late-results")
  })
})

describe("signature du serveur — §7.3", () => {
  test("absente, valide et invalide sont trois réponses distinctes", async () => {
    const worker = await loadOrCreateIdentity(scratch())
    const server = await loadOrCreateIdentity(scratch())
    const hello = (
      await register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: serverOf(NOMINAL),
        endpoint: "https://locus.example",
        nonce: "n-worker",
      })
    ).hello

    // Un déploiement local peut légitimement ne pas signer — `signed-events` se négocie. Une
    // signature présente et fausse, elle, n'est jamais un choix.
    expect(checkServerSignature({ supported_versions: [] }, hello)).toBe("absente")

    const body = ["srv-1", "n-serveur", hello.nonce, hello.worker_id].join("\n")
    const signed: ServerHello = {
      server_id: "srv-1",
      nonce: "n-serveur",
      signature: sign(server, body),
      public_key: server.public.public_key,
    }
    expect(checkServerSignature(signed, hello)).toBe("valide")

    // Signée par quelqu'un d'autre.
    expect(checkServerSignature({ ...signed, public_key: worker.public.public_key }, hello)).toBe("invalide")
    // Clé publique illisible : invalide, jamais une exception qui remonte.
    expect(checkServerSignature({ ...signed, public_key: "pas-une-cle" }, hello)).toBe("invalide")
  })

  test("une signature capturée sur un autre handshake ne se rejoue pas", async () => {
    // Le corps signé lie les deux nonces : sans le nôtre, la même signature vaudrait pour
    // n'importe quel handshake du même serveur.
    const server = await loadOrCreateIdentity(scratch())
    const first = (
      await register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: serverOf(NOMINAL),
        endpoint: "https://locus.example",
        nonce: "n-1",
      })
    ).hello
    const second = (
      await register({
        stateDir: scratch(),
        probe: probeOf(),
        transport: serverOf(NOMINAL),
        endpoint: "https://locus.example",
        nonce: "n-2",
      })
    ).hello

    const body = ["srv", "n-srv", first.nonce, first.worker_id].join("\n")
    const captured: ServerHello = {
      server_id: "srv",
      nonce: "n-srv",
      signature: sign(server, body),
      public_key: server.public.public_key,
    }
    expect(checkServerSignature(captured, first)).toBe("valide")
    expect(checkServerSignature(captured, second)).toBe("invalide")
  })
})

describe("emplacement de l'état", () => {
  test("l'état Locus vit sous la racine de données, dans son propre répertoire", () => {
    // Dérivé, pas deviné : c'est ce qui permet à `worker status` et à `worker enroll` de regarder
    // au même endroit sans se le dire.
    expect(locusStateDir("/data/openscience")).toBe("/data/openscience/locus")
  })

  test("l'identité survit à un second enregistrement", async () => {
    const stateDir = scratch()
    const first = await register({
      stateDir,
      probe: probeOf(),
      transport: serverOf(NOMINAL),
      endpoint: "https://locus.example",
    })
    const second = await register({
      stateDir,
      probe: probeOf(),
      transport: serverOf(NOMINAL),
      endpoint: "https://locus.example",
    })
    // Se réenregistrer ne doit pas donner une nouvelle identité : le serveur perdrait tout ce
    // qu'il a enregistré sous l'ancienne.
    expect(second.identity.public.worker_id).toBe(first.identity.public.worker_id)
  })
})
