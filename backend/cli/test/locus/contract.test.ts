import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runConformance, payloadHash } from "./harness/index.ts"
import type { WorkerUnderTest } from "./harness/worker.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"

import { loadOrCreateIdentity } from "../../src/locus/identity.ts"
import {
  PROTOCOL_VERSION,
  SUPPORTED_FEATURES,
  acceptVersion,
  buildHello,
  completeHandshake,
  granted,
  helloSignedBody,
  knownFeatures,
  majorOf,
} from "../../src/locus/protocol.ts"
import { verify } from "../../src/locus/identity.ts"
import { LocusProtocolRefused } from "../../src/locus/errors.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "locus-contract-"))

/**
 * Le worker de conformance : il produit une session LEP complète à partir de la couche protocole.
 *
 * Il n'y a **pas** de transport ici, et c'est le port du harnais qui l'impose (§15.2 autorise
 * WebSocket ou pull/queue). Ce qui est vérifié est la séquence et le contenu — ce qui reste vrai
 * quel que soit le tuyau.
 */
function workerFor(mission: MissionEnvelope, lease: Lease, manifest: CapabilityManifest): WorkerUnderTest {
  const events: Event[] = []
  let sequence = 0
  const emit = (type: Event["event_type"], extra: Partial<Event> = {}): void => {
    sequence += 1
    events.push({
      protocol: PROTOCOL_VERSION,
      event_type: type,
      sequence,
      occurred_at: new Date(Date.parse(lease.expires_at) - 60_000).toISOString(),
      idempotency_key: `${mission.task_id}-${sequence}`,
      task_id: mission.task_id,
      attempt: 1,
      ...extra,
    })
  }

  return {
    register: () => manifest,
    offer: (offered) => manifest.sandbox.levels.includes(offered.sandbox.minimum_level),
    events: () => {
      if (events.length > 0) return events
      emit("attempt.started")
      // §12.3 : battre plus souvent que le tiers du TTL. Le harnais vérifie la règle que le
      // schéma ne savait pas exprimer.
      emit("heartbeat")
      const payload = { step: "analyse", cpu: 4 }
      emit("tool.completed", { payload, payload_hash: payloadHash(payload) })
      emit("attempt.completed")
      return events
    },
  }
}

function mission(): MissionEnvelope {
  return {
    protocol: PROTOCOL_VERSION,
    task_id: "task-contract-1",
    attempt: 1,
    sandbox: { minimum_level: "S2", network: "deny" },
    resources: { cpu: 2, memory_mb: 2048 },
  } as unknown as MissionEnvelope
}

function lease(): Lease {
  const expires = new Date("2026-08-16T10:00:00.000Z")
  return {
    protocol: PROTOCOL_VERSION,
    task_id: "task-contract-1",
    attempt: 1,
    lease_id: "lease-1",
    expires_at: expires.toISOString(),
    ttl_seconds: 300,
    heartbeat_interval_seconds: 60,
  } as unknown as Lease
}

function manifest(levels: readonly string[] = ["S1", "S2", "S3"]): CapabilityManifest {
  return {
    protocol: PROTOCOL_VERSION,
    worker_id: "canterel-contract",
    worker_kind: "canterel",
    sandbox: { levels, network_modes: ["deny", "allowlist"] },
  } as unknown as CapabilityManifest
}

describe("contract tests contre le harnais — le test de sortie de W2.5", () => {
  test("un worker Canterel conforme ne produit aucun constat", async () => {
    const report = await runConformance(workerFor(mission(), lease(), manifest()), mission(), lease())
    expect(report.findings).toEqual([])
    // « Rien à signaler » et « rien vérifié » ne doivent pas se ressembler : le harnais dit ce
    // qu'il a passé.
    expect(report.ran.length).toBeGreaterThan(0)
  })

  test("le harnais attrape un worker Canterel fautif", async () => {
    // Le test précédent ne vaut que si celui-ci rougit : un harnais qui ne trouve jamais rien
    // valide n'importe quoi. Ici le worker accepte une mission S2 alors qu'il n'offre que S1.
    const under = manifest(["S1"])
    const worker: WorkerUnderTest = {
      ...workerFor(mission(), lease(), under),
      register: () => under,
      offer: () => true,
    }
    const report = await runConformance(worker, mission(), lease())
    expect(report.findings.map((finding) => finding.rule)).toContain("admission")
  })

  test("le refus d'une mission trop exigeante n'est pas une faute", async () => {
    const under = manifest(["S1"])
    const report = await runConformance(workerFor(mission(), lease(), under), mission(), lease())
    expect(report.findings).toEqual([])
  })
})

describe("versions — §8.2", () => {
  test("le mineur supérieur est accepté, le majeur différent refusé", () => {
    // docs/06 fait du mineur un ajout de champs optionnels : un worker 1.0 doit accepter un
    // serveur 1.1 et ignorer ce qu'il ne connaît pas. Refuser figerait le protocole.
    expect(acceptVersion(["lep/1.0"])).toBe("lep/1.0")
    expect(acceptVersion(["lep/1.0", "lep/1.3"])).toBe("lep/1.3")
    expect(acceptVersion(["lep/2.0", "lep/1.1"])).toBe("lep/1.1")

    // Poursuivre serait la compatibilité implicite que §8.2 interdit.
    expect(() => acceptVersion(["lep/2.0"])).toThrow()
    expect(() => acceptVersion([])).toThrow()
  })

  test("un refus porte ce qui était offert", () => {
    // « Version refusée » sans la liste ne se diagnostique pas : savoir que le serveur n'annonçait
    // que 2.0 distingue une mise à jour à faire d'une mauvaise adresse.
    try {
      acceptVersion(["lep/2.0", "lep/3.1"])
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusProtocolRefused.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusProtocolRefused>).data.offered).toEqual(["lep/2.0", "lep/3.1"])
    }
  })

  test("une version illisible n'est pas prise pour la ligne 1.x", () => {
    for (const bad of ["", "lep/", "1", "v1.0", "lep/1", "lep/x.y"]) {
      expect(Number.isNaN(majorOf(bad))).toBe(true)
      expect(() => acceptVersion([bad])).toThrow()
    }
  })
})

describe("handshake signé — §8.2", () => {
  test("la signature couvre l'identité, la version, les features et la séquence", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    const hello = buildHello({ identity, nonce: "n-1", lastServerSequence: 41 })

    expect(verify(identity.public.public_key, helloSignedBody(hello), hello.signature)).toBe(true)

    // Signer la seule identité laisserait un intermédiaire retirer une feature sans invalider la
    // signature — le worker tiendrait un accord qu'il n'a pas passé.
    const tampered = { ...hello, features: [] }
    expect(verify(identity.public.public_key, helloSignedBody(tampered), hello.signature)).toBe(false)
    const rewound = { ...hello, last_server_sequence: 0 }
    expect(verify(identity.public.public_key, helloSignedBody(rewound), hello.signature)).toBe(false)
  })

  test("les champs à venir sont absents plutôt que vides", async () => {
    // Le manifeste réel arrive avec W2.6 et la reprise avec W2.16. Les émettre à `undefined`
    // changerait la forme du message le jour où ils arrivent, ce qu'un handshake ne doit pas faire.
    const identity = await loadOrCreateIdentity(scratch())
    const hello = buildHello({ identity })
    expect("capability_manifest_hash" in hello).toBe(false)
    expect("resume_token" in hello).toBe(false)
    expect(hello.last_server_sequence).toBe(-1)

    const withBoth = buildHello({ identity, capabilityManifestHash: "sha256:x", resumeToken: "r-1" })
    expect(withBoth.capability_manifest_hash).toBe("sha256:x")
    expect(withBoth.resume_token).toBe("r-1")
  })

  test("le worker n'annonce que ce qu'il tient", () => {
    // Annoncer une feature qu'on ne tient pas est la seule façon de faire échouer un handshake
    // réussi : le serveur l'accorde et l'utilise.
    for (const feature of SUPPORTED_FEATURES) {
      expect(knownFeatures()).toContain(feature)
    }
    expect(SUPPORTED_FEATURES.length).toBeLessThan(knownFeatures().length)
  })
})

describe("négociation de features", () => {
  test("accordé, refusé et inconnu restent trois choses distinctes", () => {
    const handshake = completeHandshake({
      serverVersions: ["lep/1.0"],
      serverFeatures: ["late-results", "signed-events", "une-feature-du-futur"],
    })
    expect(handshake.version).toBe("lep/1.0")
    expect(granted(handshake, "late-results")).toBe(true)
    // Le worker n'annonce pas `pull-queue` côté serveur : elle est refusée, pas inconnue.
    expect(handshake.negotiated.declined).toContain("pull-queue")
    // `signed-events` n'est pas demandée par ce worker : elle n'apparaît nulle part de son côté.
    expect(granted(handshake, "signed-events")).toBe(false)
  })

  test("un serveur plus récent n'est pas une panne", () => {
    // Les fondre en un seul « non » rendrait un pair venu d'un mineur ultérieur indiscernable
    // d'un pair qui a mal orthographié son besoin.
    const handshake = completeHandshake({ serverVersions: ["lep/1.4"], serverFeatures: ["late-results"] })
    expect(handshake.version).toBe("lep/1.4")
    expect(granted(handshake, "late-results")).toBe(true)
  })
})
