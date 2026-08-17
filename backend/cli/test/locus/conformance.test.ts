import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runConformance } from "./harness/index.ts"
import type { WorkerUnderTest } from "./harness/worker.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"

import {
  CONTRACT_TESTS,
  conformanceReport,
  coverageFindings,
  foreignInputFindings,
  pinnedInputs,
} from "../../src/locus/conformance.ts"
import { verifyPin } from "../../src/locus/schema-registry.ts"
import { PROTOCOL_VERSION, acceptVersion, buildHello, helloSignedBody } from "../../src/locus/protocol.ts"
import { loadOrCreateIdentity, revokeIdentity, verify } from "../../src/locus/identity.ts"
import { isActionAllowed } from "../../src/locus/auth.ts"
import { EventSpool } from "../../src/locus/event-spool.ts"
import { heartbeatDue, isExpired, lateMarker } from "../../src/locus/lease.ts"
import { contentHash, declareArtifact, publishArtifact } from "../../src/locus/artifact-client.ts"
import { acceptResponse, suspendForHuman } from "../../src/locus/human-input.ts"
import { isRegression, poll, startWatch } from "../../src/locus/capability-watch.ts"
import { LocusArtifactRejected } from "../../src/locus/errors.ts"
import type { Checkpoint } from "../../src/locus/resume-store.ts"

const scratch = (tag: string) => mkdtempSync(join(tmpdir(), `locus-conf-${tag}-`))
const START = Date.parse("2026-08-17T08:00:00.000Z")

/**
 * Les cas exécutés, enregistrés par leur nom de §28.2.
 *
 * Le tableau est rempli **par les tests eux-mêmes**, et relu par le dernier d'entre eux. Un item
 * du texte sans cas exécuté échoue alors, au lieu de manquer en silence — c'est tout l'objet de
 * W2.19.
 */
const executed: string[] = []
const covers = (name: string): void => {
  executed.push(name)
}

/**
 * Une sonde d'hôte contrôlée — le seul moyen d'exercer un changement de capacité sans changer de
 * machine. `s2` décide si `bubblewrap` fonctionne, donc si le niveau S2 est offert.
 */
function probe(s2: boolean) {
  return {
    platform: "linux",
    arch: "x64",
    release: "6.1.0",
    which: (binary: string) => (binary === "bwrap" && s2 ? "/usr/bin/bwrap" : null),
    bubblewrapWorks: () => s2,
    cpuCores: 8,
    memoryMb: 16_384,
    diskFreeMb: 100_000,
  }
}

const MANIFEST = {
  protocol: PROTOCOL_VERSION,
  worker_id: "canterel-1",
  worker_kind: "canterel",
  sandbox: { levels: ["S1", "S2"], network_modes: ["deny", "full"] },
} as unknown as CapabilityManifest

const MISSION = {
  protocol: PROTOCOL_VERSION,
  task_id: "task-1",
  attempt_id: "attempt-1",
  branch_id: "branch-1",
  sandbox: { minimum_level: "S2", network: "deny" },
} as unknown as MissionEnvelope

const LEASE = {
  protocol: PROTOCOL_VERSION,
  lease_id: "lease-1",
  task_id: "task-1",
  attempt: 1,
  worker_id: "canterel-1",
  issued_at: new Date(START).toISOString(),
  expires_at: new Date(START + 300_000).toISOString(),
  ttl_seconds: 300,
  heartbeat_interval_seconds: 60,
} as unknown as Lease

function draft(type: Event["event_type"], at: number, extra: Partial<Event> = {}): Omit<Event, "sequence"> {
  return {
    protocol: PROTOCOL_VERSION,
    event_type: type,
    occurred_at: new Date(at).toISOString(),
    idempotency_key: `${type}-${at}`,
    task_id: "task-1",
    attempt: 1,
    ...extra,
  } as Omit<Event, "sequence">
}

function checkpoint(): Checkpoint {
  return {
    task_id: "task-1",
    attempt: 1,
    state: "running",
    session: {},
    context_hash: `sha256:${"cd".repeat(32)}`,
    worktree: {},
    partial_artifacts: [],
    budget_spent: {},
    next_operations: ["reprendre"],
    unserializable: [],
    through_sequence: 3,
    taken_at: new Date(START).toISOString(),
  }
}

describe("les onze contract tests de §28.2", () => {
  test("handshake", async () => {
    covers("handshake")
    const me = await loadOrCreateIdentity(scratch("hs"))
    const hello = buildHello({ identity: me })
    // La signature couvre le corps annoncé : un handshake dont la signature porte sur autre chose
    // que ce qui est annoncé ne prouve rien de ce qui est annoncé.
    expect(verify(me.public.public_key, helloSignedBody(hello), hello.signature)).toBe(true)

    const worker: WorkerUnderTest = { register: () => MANIFEST, offer: () => true, events: () => [] }
    const report = await runConformance(worker, MISSION, LEASE)
    expect(report.findings).toEqual([])
    expect(report.ran.length).toBeGreaterThan(0)
  })

  test("version negotiation", () => {
    covers("version-negotiation")
    // Une mineure supérieure reste compatible : les ajouts mineurs sont des champs facultatifs.
    expect(acceptVersion(["lep/1.0", "lep/1.1"])).toBe("lep/1.1")
    expect(acceptVersion(["lep/1.0"])).toBe("lep/1.0")
    // Une majeure différente ne l'est pas, et le refus est structuré.
    expect(() => acceptVersion(["lep/2.0"])).toThrow()
  })

  test("resume", () => {
    covers("resume")
    const dir = scratch("resume")
    const spool = new EventSpool(dir)
    spool.append(draft("attempt.started", START))
    spool.append(draft("progress", START + 1000))
    spool.ack(1)

    // Ce qui n'a pas été acquitté survit au redémarrage, et la numérotation reprend après le
    // dernier attribué — pas après le dernier acquitté.
    const revived = new EventSpool(dir)
    expect(revived.unacked().map((entry) => entry.sequence)).toEqual([2])
    const next = revived.append(draft("progress", START + 2000))
    expect(next.ok && next.entry.sequence).toBe(3)
  })

  test("duplicate messages", async () => {
    covers("duplicate-messages")
    const dir = scratch("dup")
    const spool = new EventSpool(dir)
    spool.append(draft("attempt.started", START))
    spool.append(draft("heartbeat", START + 50_000))
    const sent = spool.unacked().map((entry) => entry.event)

    // Le cas réaliste n'est pas « les événements se perdent » mais « l'acquittement se perd » :
    // le worker retransmet un préfixe déjà vu, avec les mêmes clés d'idempotence.
    const worker: WorkerUnderTest = {
      register: () => MANIFEST,
      offer: () => true,
      events: () => [...sent, ...sent],
    }
    const report = await runConformance(worker, MISSION, LEASE)
    expect(report.findings).toEqual([])
  })

  test("sequence gaps", async () => {
    covers("sequence-gaps")
    // Une séquence qui recule est refusée par le harnais : sans monotonie, « rien perdu, rien
    // dupliqué » n'est plus vérifiable.
    const events = [
      { ...draft("attempt.started", START), sequence: 1 },
      { ...draft("progress", START + 1000), sequence: 3 },
      { ...draft("progress", START + 2000), sequence: 2 },
    ] as Event[]
    const worker: WorkerUnderTest = { register: () => MANIFEST, offer: () => true, events: () => events }
    const report = await runConformance(worker, MISSION, LEASE)
    // Nommé, pas compté : « il y a des constats » passerait sur n'importe quel autre problème.
    expect(report.findings.map((finding) => finding.rule)).toContain("sequence")
  })

  test("leases", () => {
    covers("leases")
    expect(isExpired(LEASE, START + 100_000)).toBe(false)
    expect(isExpired(LEASE, START + 400_000)).toBe(true)
    // Un heartbeat jamais émis est dû immédiatement : `null` n'est pas « récent ».
    expect(heartbeatDue(LEASE, null, START)).toBe(true)
    expect(heartbeatDue(LEASE, START, START + 10_000)).toBe(false)
  })

  test("late results", async () => {
    covers("late-results")
    // Un résultat tardif silencieux serait traité comme un résultat normal — c'est le
    // contournement que la quarantaine de §12.3 existe pour empêcher.
    expect(lateMarker(LEASE, START + 400_000)).toEqual({ late: true })
    expect(lateMarker(LEASE, START + 100_000)).toEqual({})

    const events = [
      { ...draft("attempt.started", START), sequence: 1 },
      { ...draft("attempt.completed", START + 400_000), sequence: 2 },
    ] as Event[]
    const worker: WorkerUnderTest = { register: () => MANIFEST, offer: () => true, events: () => events }
    const report = await runConformance(worker, MISSION, LEASE)
    // Le harnais le voit, et sous son nom : l'événement sort après l'échéance sans se déclarer
    // tardif.
    expect(report.findings.map((finding) => finding.rule)).toContain("late-result")
  })

  test("artifact upload", async () => {
    covers("artifact-upload")
    const bytes = new TextEncoder().encode("un résultat")
    const declared = declareArtifact({
      artifact_id: "artifact-1",
      bytes,
      media_type: "text/plain",
      classification: "internal",
      produced_by: { task_id: "task-1", attempt: 1 },
      now: () => new Date(START),
    })

    const honest = {
      requestUpload: async () => ({ url: "https://locus.example/upload/a" }),
      put: async (_t: unknown, payload: Uint8Array) => ({ received_hash: contentHash(payload) }),
    }
    const ok = await publishArtifact(declared, bytes, honest, () => new Date(START))
    expect(ok.ok).toBe(true)

    const liar = {
      requestUpload: async () => ({ url: "https://locus.example/upload/a" }),
      put: async () => ({ received_hash: contentHash(new TextEncoder().encode("autre chose")) }),
    }
    expect(publishArtifact(declared, bytes, liar, () => new Date(START))).rejects.toBeInstanceOf(LocusArtifactRejected)
  })

  test("human input", () => {
    covers("human-input")
    const question = {
      question_id: "q-1",
      task_id: "task-1",
      attempt: 1,
      category: "budget_extension" as const,
      decision: "prolonger le budget ?",
      context: "plafond atteint à l'étape 4",
      options: [
        { id: "stop", label: "arrêter", consequence: "résultat partiel" },
        { id: "extend", label: "prolonger", consequence: "coût supplémentaire" },
      ],
      deadline: new Date(START + 86_400_000).toISOString(),
      safe_default: "stop",
    }
    const suspended = suspendForHuman({
      from: "running",
      question,
      checkpoint: checkpoint(),
      resources: [{ id: "gpu-0", kind: "gpu_reservation" }],
    })
    expect(suspended.ok).toBe(true)
    if (!suspended.ok) return
    // §22.3 : rien de coûteux n'est gardé sans nécessité écrite.
    expect(suspended.plan.clean).toBe(true)

    // §22.4 : ce qui entre dans l'exécution est une option, corrélée à la question posée.
    expect(acceptResponse(question, { question_id: "q-1", option_id: "extend", at: "" }).ok).toBe(true)
    expect(acceptResponse(question, { question_id: "autre", option_id: "extend", at: "" }).ok).toBe(false)
    expect(acceptResponse(question, { question_id: "q-1", option_id: "voie-c", at: "" }).ok).toBe(false)
  })

  test("revocation", async () => {
    covers("revocation")
    const dir = scratch("revoke")
    await loadOrCreateIdentity(dir)
    await revokeIdentity(dir, new Date(START))

    // §7.5 : l'identité reste — la révoquer n'est pas l'effacer — et seules les actions de
    // clôture restent permises.
    const reloaded = await loadOrCreateIdentity(dir)
    expect(reloaded.public.worker_id).toBeTruthy()
    expect(isActionAllowed(true, "upload-closing-logs")).toBe(true)
    expect(isActionAllowed(true, "accept-mission")).toBe(false)
  })

  test("capability change", () => {
    covers("capability-change")
    const state = startWatch({ probe: probe(true), workerId: "canterel-1" })
    // Rien n'a changé : `null`, et non un rapport vide qui ressemblerait à un changement nul.
    expect(poll(state, { probe: probe(true), workerId: "canterel-1" }).change).toBeNull()

    // La sandbox S2 disparaît de l'hôte — le cas que §9.4 appelle une régression de capacité.
    const after = poll(state, { probe: probe(false), workerId: "canterel-1" })
    expect(after.change).not.toBeNull()
    // Une perte est une régression, et les pertes se lisent avant les gains.
    expect(after.change !== null && isRegression(after.change)).toBe(true)
  })
})

describe("la suite se compte elle-même — §28.2", () => {
  test("chaque item de §28.2 a un cas exécuté", () => {
    // Le test de sortie de W2.19. Une suite de conformance dont il manquerait « revocation »
    // serait verte, et sa vertu serait un artefact de ce qu'elle ne fait pas.
    const report = conformanceReport(executed)
    expect(report.findings).toEqual([])
    expect(report.missing).toEqual([])
    expect(report.complete).toBe(true)
    expect(new Set(executed).size).toBe(CONTRACT_TESTS.length)
  })

  test("le compteur attrape une absence, et un nom qui a dérivé", () => {
    // Sans ce test, `coverageFindings` pourrait rendre toujours la liste vide et le test précédent
    // passerait quand même.
    const partial = coverageFindings(CONTRACT_TESTS.filter((name) => name !== "revocation"))
    expect(partial).toHaveLength(1)
    expect(partial[0]).toContain("revocation")

    const drifted = coverageFindings([...CONTRACT_TESTS, "handshaking"])
    expect(drifted.some((finding) => finding.includes("a dérivé"))).toBe(true)
  })

  test("les onze noms du texte, sans doublon", () => {
    expect(CONTRACT_TESTS.length).toBe(11)
    expect(new Set(CONTRACT_TESTS).size).toBe(11)
  })
})

describe("consumer-driven contracts — §28.3", () => {
  test("toutes les entrées LEP viennent du pin", () => {
    // « Les tests ne doivent pas dépendre d'un dépôt Locus Solus local mutable. » Un fichier LEP lu
    // hors du pin porte une version que rien ne dit : la suite passerait ou échouerait selon
    // l'état d'un répertoire voisin, ce qui n'est plus une conformance mais une coïncidence.
    const inputs = [
      "backend/cli/src/locus/lep/generated.ts",
      "backend/cli/test/locus/harness/harness.ts",
      "backend/cli/test/locus/fixtures/mission-accepted.json",
    ]
    expect(foreignInputFindings(inputs)).toEqual([])
    expect(pinnedInputs().length).toBeGreaterThan(5)
  })

  test("une entrée hors du pin est signalée", () => {
    const findings = foreignInputFindings(["/home/quelquun/locusolus/schemas/lep/1.0/event.schema.json"])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain("§28.3")
  })

  test("le pin lui-même est intact — la suite tourne hors ligne", () => {
    // La conformance ne dépend d'aucun réseau : les empreintes sont dans le dépôt, et c'est ce qui
    // rend la suite reproductible ailleurs qu'ici.
    expect(verifyPin()).toEqual([])
  })

  test("un approvisionnement non vérifié se déclare", () => {
    // La vérification croisée contre le dépôt d'origine est un bonus, pas une condition. Le dire
    // vaut mieux que de laisser croire qu'elle a eu lieu.
    const report = conformanceReport([...CONTRACT_TESTS], "unverifiable")
    expect(report.source).toBe("unverifiable")
    expect(report.complete).toBe(true)
  })
})
