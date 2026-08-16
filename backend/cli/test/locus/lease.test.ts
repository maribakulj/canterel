import { describe, expect, test } from "bun:test"

import { runConformance, payloadHash } from "./harness/index.ts"
import type { WorkerUnderTest } from "./harness/worker.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"

import {
  ALLOWED_AFTER_LOSS,
  HEARTBEAT_TTL_RATIO,
  LEASE_LOST_ACTIONS,
  deadlineOf,
  heartbeatDue,
  isAllowedAfterLoss,
  isExpired,
  lateMarker,
  leaseTimingFindings,
  remainingMs,
} from "../../src/locus/lease.ts"
import {
  ATTEMPT_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  onLeaseLost,
  toProtocolState,
  transition,
  type AttemptState,
} from "../../src/locus/attempt.ts"
import { PROTOCOL_VERSION } from "../../src/locus/protocol.ts"

const START = Date.parse("2026-08-16T10:00:00.000Z")

function leaseOf(over: Partial<Lease> = {}): Lease {
  return {
    protocol: PROTOCOL_VERSION,
    lease_id: "lease-1",
    task_id: "task-1",
    attempt: 1,
    worker_id: "canterel-1",
    issued_at: new Date(START).toISOString(),
    expires_at: new Date(START + 300_000).toISOString(),
    ttl_seconds: 300,
    heartbeat_interval_seconds: 60,
    ...over,
  } as Lease
}

const MISSION = {
  protocol: PROTOCOL_VERSION,
  task_id: "task-1",
  attempt: 1,
  sandbox: { minimum_level: "S2", network: "deny" },
} as unknown as MissionEnvelope

const MANIFEST = {
  protocol: PROTOCOL_VERSION,
  worker_id: "canterel-1",
  worker_kind: "canterel",
  sandbox: { levels: ["S1", "S2"], network_modes: ["deny", "full"] },
} as unknown as CapabilityManifest

/** Un worker piloté par une horloge explicite : il émet ce que §11 impose, à l'instant dit. */
function workerFor(lease: Lease, events: readonly Event[]): WorkerUnderTest {
  return { register: () => MANIFEST, offer: () => true, events: () => events }
}

function event(sequence: number, type: Event["event_type"], at: number, extra: Partial<Event> = {}): Event {
  return {
    protocol: PROTOCOL_VERSION,
    event_type: type,
    sequence,
    occurred_at: new Date(at).toISOString(),
    idempotency_key: `task-1-${sequence}`,
    task_id: "task-1",
    attempt: 1,
    ...extra,
  }
}

describe("expiration et reprise contre le harnais — le test de sortie de W2.9", () => {
  test("un attempt qui rend après l'échéance se déclare tardif", async () => {
    const lease = leaseOf()
    const late = START + 400_000 // 100 s après l'échéance
    const events = [
      event(1, "attempt.started", START),
      event(2, "heartbeat", START + 50_000),
      event(3, "heartbeat", START + 100_000),
      // §11.4 : les artefacts déjà produits peuvent être déclarés *late result*. Le marqueur vient
      // de `lateMarker`, pas d'une constante écrite à la main dans ce test.
      event(4, "attempt.completed", late, { payload: { ...lateMarker(lease, late), artifacts: 1 } }),
    ]
    const report = await runConformance(workerFor(lease, events), MISSION, lease)
    expect(report.findings).toEqual([])
  })

  test("le même attempt sans le marqueur est pris par le harnais", async () => {
    // La moitié qui donne sa valeur au test précédent : sans elle, un worker qui ne déclare rien
    // passerait aussi.
    const lease = leaseOf()
    const late = START + 400_000
    const events = [
      event(1, "attempt.started", START),
      event(2, "heartbeat", START + 50_000),
      event(3, "attempt.completed", late, { payload: { artifacts: 1 } }),
    ]
    const report = await runConformance(workerFor(lease, events), MISSION, lease)
    expect(report.findings.map((f) => f.rule)).toContain("late-result")
  })

  test("une reprise rejoue sans dupliquer", async () => {
    // §8.4 : après reconnexion le worker retransmet les messages manquants. Le harnais accepte un
    // rejeu — même séquence, même clé d'idempotence — et refuserait une séquence réutilisée avec
    // une autre clé.
    const lease = leaseOf()
    const events = [
      event(1, "attempt.started", START),
      event(2, "heartbeat", START + 50_000),
      event(3, "progress", START + 60_000),
      event(3, "progress", START + 60_000),
      event(4, "attempt.completed", START + 120_000),
    ]
    const report = await runConformance(workerFor(lease, events), MISSION, lease)
    expect(report.findings).toEqual([])
  })

  test("un rejeu qui change de clé d'idempotence est pris", async () => {
    const lease = leaseOf()
    const events = [
      event(1, "attempt.started", START),
      event(2, "heartbeat", START + 50_000),
      event(3, "progress", START + 60_000),
      event(3, "progress", START + 60_000, { idempotency_key: "autre" }),
      event(4, "attempt.completed", START + 120_000),
    ]
    const report = await runConformance(workerFor(lease, events), MISSION, lease)
    expect(report.findings.map((f) => f.rule)).toContain("sequence")
  })

  test("le rythme de battement de la lease satisfait le harnais", async () => {
    // La lease utilisée bat toutes les 60 s pour un TTL de 300 s : strictement moins du tiers.
    expect(leaseTimingFindings(leaseOf())).toEqual([])
    const lease = leaseOf()
    const events = [
      event(1, "attempt.started", START),
      event(2, "heartbeat", START + 50_000),
      event(3, "tool.completed", START + 60_000, {
        payload: { step: "x" },
        payload_hash: payloadHash({ step: "x" }),
      }),
      event(4, "attempt.completed", START + 120_000),
    ]
    expect((await runConformance(workerFor(lease, events), MISSION, lease)).findings).toEqual([])
  })
})

describe("rythme et échéance", () => {
  test("un tiers pile est déjà trop lent", () => {
    // `>=` et non `>` : un worker qui bat exactement trois fois par TTL n'a aucune marge, et le
    // premier battement en retard fait expirer la lease.
    expect(leaseTimingFindings(leaseOf({ ttl_seconds: 300, heartbeat_interval_seconds: 100 }))).not.toEqual([])
    expect(leaseTimingFindings(leaseOf({ ttl_seconds: 300, heartbeat_interval_seconds: 99 }))).toEqual([])
    expect(HEARTBEAT_TTL_RATIO).toBe(3)
  })

  test("des durées absurdes sont refusées", () => {
    expect(leaseTimingFindings(leaseOf({ ttl_seconds: 0 })).length).toBeGreaterThan(0)
    expect(leaseTimingFindings(leaseOf({ heartbeat_interval_seconds: 0 })).length).toBeGreaterThan(0)
  })

  test("l'expiration s'observe à un instant donné, jamais devinée", () => {
    const lease = leaseOf()
    expect(isExpired(lease, START)).toBe(false)
    expect(isExpired(lease, START + 299_999)).toBe(false)
    // L'échéance elle-même est déjà dehors : un droit qui expire « à » un instant ne vaut pas à
    // cet instant.
    expect(isExpired(lease, START + 300_000)).toBe(true)
    expect(remainingMs(lease, START + 299_000)).toBe(1000)
    expect(remainingMs(lease, START + 400_000)).toBe(0)
  })

  test("une échéance illisible est traitée comme expirée", () => {
    // « Je ne sais pas lire la date, donc je continue » est exactement la posture qui fait produire
    // un résultat après la fin d'un droit d'exécuter.
    const broken = leaseOf({ expires_at: "pas une date" })
    expect(Number.isNaN(deadlineOf(broken))).toBe(true)
    expect(isExpired(broken, START)).toBe(true)
    expect(remainingMs(broken, START)).toBe(0)
  })

  test("le premier battement est dû tout de suite", () => {
    // Traiter « jamais battu » comme « battu à l'instant » ferait attendre un intervalle complet
    // avant le premier signe de vie.
    const lease = leaseOf()
    expect(heartbeatDue(lease, null, START)).toBe(true)
    expect(heartbeatDue(lease, START, START + 59_000)).toBe(false)
    expect(heartbeatDue(lease, START, START + 60_000)).toBe(true)
  })

  test("le marqueur tardif n'apparaît que quand il est vrai", () => {
    const lease = leaseOf()
    expect(lateMarker(lease, START + 100_000)).toEqual({})
    expect(lateMarker(lease, START + 400_000)).toEqual({ late: true })
  })
})

describe("perte de lease — §11.4", () => {
  test("les gestes imposés sont énumérés dans l'ordre du texte", () => {
    expect(LEASE_LOST_ACTIONS).toEqual([
      "stop-costly-calls",
      "revoke-secrets",
      "block-external-writes",
      "checkpoint-if-permitted",
      "declare-late-artifacts",
    ])
  })

  test("ce qui reste permis est énuméré, et un commit n'en fait pas partie", () => {
    // §11.4 : « aucun commit ne doit être présenté comme applicable implicitement ».
    expect(isAllowedAfterLoss("upload-closing-logs")).toBe(true)
    expect(isAllowedAfterLoss("present-commit-as-applicable")).toBe(false)
    expect(isAllowedAfterLoss("start-costly-call")).toBe(false)
    expect(ALLOWED_AFTER_LOSS).not.toContain("present-commit-as-applicable")
  })

  test("une perte de lease donne `lease_lost`, jamais `failed`", () => {
    // Un attempt échoué a produit un verdict ; un attempt qui a perdu sa lease a perdu le droit
    // d'en produire un. Les confondre ferait passer une panne d'infrastructure pour un résultat
    // scientifique négatif.
    const lost = onLeaseLost("running")
    expect(lost.ok).toBe(true)
    if (lost.ok) expect(lost.state).toBe("lease_lost")
    expect(toProtocolState("lease_lost")).toBe("orphaned")
    expect(toProtocolState("failed")).toBe("failed")
  })

  test("une perte de lease sur un attempt déjà terminé ne change rien", () => {
    expect(onLeaseLost("completed").ok).toBe(false)
    expect(onLeaseLost("cancelled").ok).toBe(false)
  })
})

describe("cycle de l'attempt — §11.2", () => {
  test("le chemin nominal du texte est praticable", () => {
    const path: readonly AttemptState[] = ["offered", "accepted", "preparing", "running", "completing", "completed"]
    for (let index = 0; index + 1 < path.length; index += 1) {
      expect(canTransition(path[index] as AttemptState, path[index + 1] as AttemptState)).toBe(true)
    }
  })

  test("les raccourcis que §11.2 ne dessine pas sont refusés", () => {
    // Une machine à états qui laisse passer ce que personne n'a autorisé n'est pas une machine à
    // états, c'est une suggestion.
    for (const [from, to] of [
      ["offered", "running"],
      ["running", "completed"],
      ["preparing", "completing"],
      ["waiting_human", "completing"],
      ["rejected", "running"],
    ] as const) {
      const result = transition(from, to)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(20)
    }
  })

  test("un refus nomme les sorties possibles", () => {
    // Dire seulement « transition invalide » obligerait à relire le diagramme ; la réponse est
    // déjà dans la table.
    const result = transition("running", "completed")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("completing")
  })

  test("les états terminaux ne mènent nulle part", () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state]).toEqual([])
      expect(isTerminal(state)).toBe(true)
    }
    expect(isTerminal("running")).toBe(false)
  })

  test("chaque état déclaré a une entrée dans la table, et réciproquement", () => {
    // Un état sans entrée ferait planter la première transition qui l'atteint ; une entrée sans
    // état est une transition vers nulle part.
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ATTEMPT_STATES].sort())
    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) expect(ATTEMPT_STATES).toContain(target)
    }
  })

  test("le vocabulaire du protocole est traduit, pas aligné", () => {
    // `Attempt.state` du SDK exclut `accepted`/`rejected` exprès : ce sont des verdicts de Locus
    // Solus, pas des états qu'un worker s'attribue.
    expect(toProtocolState("offered")).toBeNull()
    expect(toProtocolState("accepted")).toBeNull()
    expect(toProtocolState("rejected")).toBeNull()
    expect(toProtocolState("waiting_human")).toBe("waiting_for_human")
    expect(toProtocolState("completed")).toBe("succeeded")
  })
})
