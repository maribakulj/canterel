import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runConformance } from "./harness/index.ts"
import type { WorkerUnderTest } from "./harness/worker.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"

import { DEFAULT_MAX_ENTRIES, EventSpool, SPOOL_FILE } from "../../src/locus/event-spool.ts"
import {
  ATTEMPT_SCOPED_TYPES,
  COALESCIBLE_TYPES,
  NEVER_COALESCIBLE_TYPES,
  REQUIRED_EVENT_FIELDS,
  coalesce,
  coalescencePolicyFindings,
  eventFieldFindings,
  isCoalescible,
} from "../../src/locus/event-bridge.ts"
import { PROTOCOL_VERSION } from "../../src/locus/protocol.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "locus-spool-"))
const START = Date.parse("2026-08-16T10:00:00.000Z")

function draft(type: Event["event_type"], at = START, extra: Partial<Event> = {}): Omit<Event, "sequence"> {
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

describe("perte de connexion : rien perdu, rien dupliqué — le test de sortie de W2.12", () => {
  test("ce qui n'a pas été acquitté survit à un redémarrage, et une seule fois", () => {
    const dir = scratch()
    const spool = new EventSpool(dir)

    for (const type of ["attempt.started", "heartbeat", "progress", "tool.completed"] as const) {
      const result = spool.append(draft(type, START + COALESCIBLE_TYPES.indexOf(type) * 1000))
      expect(result.ok).toBe(true)
    }
    // Le serveur acquitte les deux premiers, puis la connexion tombe.
    spool.ack(2)

    // « Redémarrage » : tout est relu depuis le disque, rien n'est gardé en mémoire.
    const revived = new EventSpool(dir)
    const pending = revived.unacked()

    // Rien perdu : les deux non acquittés sont là.
    expect(pending.map((entry) => entry.sequence)).toEqual([3, 4])
    // Rien dupliqué : ni les acquittés, ni deux fois les mêmes.
    expect(new Set(pending.map((entry) => entry.sequence)).size).toBe(pending.length)
    expect(revived.acknowledged()).toBe(2)
    // Et la numérotation reprend après le dernier attribué, pas après le dernier acquitté.
    const next = revived.append(draft("attempt.completed", START + 9000))
    expect(next.ok && next.entry.sequence).toBe(5)
  })

  test("la reprise rejouée traverse le harnais sans constat", async () => {
    // Le rejeu de §8.4 : mêmes séquences, mêmes clés d'idempotence. Le harnais doit le
    // dédupliquer, et refuserait une séquence réutilisée avec une autre clé.
    // Le cas réaliste n'est pas « les événements se perdent » mais « l'acquittement se perd » :
    // le serveur a bien reçu 1 à 3, son ack n'est jamais arrivé, et le worker retransmet donc un
    // préfixe déjà vu. C'est là que « rien dupliqué » se joue — pas dans une rediffusion après la
    // fin de l'attempt, qui serait un flux que personne n'émet.
    const dir = scratch()
    const spool = new EventSpool(dir)
    spool.append(draft("attempt.started", START))
    spool.append(draft("heartbeat", START + 50_000))
    spool.append(draft("progress", START + 60_000))

    const sent = spool.unacked().map((entry) => entry.event)

    // Redémarrage sans acquittement reçu : le spool retransmet à l'identique, puis poursuit.
    const revived = new EventSpool(dir)
    const retransmitted = revived.unacked().map((entry) => entry.event)
    expect(retransmitted).toEqual(sent)
    const tail = revived.append(draft("attempt.completed", START + 120_000))
    expect(tail.ok).toBe(true)

    const worker: WorkerUnderTest = {
      register: () => MANIFEST,
      offer: () => true,
      events: () => [...sent, ...retransmitted, ...(tail.ok ? [tail.entry.event] : [])],
    }
    const report = await runConformance(worker, MISSION, LEASE)
    expect(report.findings).toEqual([])
  })

  test("le nettoyage n'a lieu qu'à l'acquittement, jamais au redémarrage", () => {
    // Un spool qui purge sur autre chose qu'un acquittement perd ce qu'il existe pour ne pas
    // perdre, au moment exact où ça compte.
    const dir = scratch()
    const spool = new EventSpool(dir)
    spool.append(draft("progress", START))
    spool.append(draft("progress", START + 1000))

    for (let restart = 0; restart < 3; restart += 1) {
      const revived = new EventSpool(dir)
      expect(revived.unacked()).toHaveLength(2)
    }
    new EventSpool(dir).ack(1)
    expect(new EventSpool(dir).unacked().map((e) => e.sequence)).toEqual([2])
  })

  test("un acquittement qui recule est ignoré", () => {
    // Le serveur peut réémettre un acquittement ancien après reconnexion ; le prendre au mot
    // ferait ressusciter des entrées déjà purgées.
    const dir = scratch()
    const spool = new EventSpool(dir)
    spool.append(draft("progress", START))
    spool.append(draft("progress", START + 1000))
    spool.ack(2)
    spool.ack(1)
    expect(spool.unacked()).toEqual([])
    expect(spool.acknowledged()).toBe(2)
  })

  test("la séquence est attribuée par le spool, jamais par l'appelant", () => {
    // La laisser à l'appelant rendrait possible deux événements de même rang, ce que le harnais
    // refuse à juste titre.
    const spool = new EventSpool(scratch())
    const forced = spool.append({ ...draft("progress"), sequence: 99 } as never)
    expect(forced.ok && forced.entry.sequence).toBe(1)
    expect(forced.ok && forced.entry.event.sequence).toBe(1)
  })

  test("un journal tronqué ne perd que sa dernière ligne", () => {
    // Une coupure de courant en cours d'écriture ne doit pas coûter tout ce qui précède : seules
    // les lignes valides sont des faits.
    const dir = scratch()
    const spool = new EventSpool(dir)
    spool.append(draft("progress", START))
    spool.append(draft("progress", START + 1000))
    const file = join(dir, SPOOL_FILE)
    writeFileSync(file, `${readFileSync(file, "utf8")}{"kind":"event","sequ`)

    expect(new EventSpool(dir).unacked()).toHaveLength(2)
  })
})

describe("borne et backpressure — §18.4", () => {
  test("à saturation, le spool refuse au lieu de perdre", () => {
    // « En cas de saturation, le worker passe en backpressure plutôt que de perdre les événements
    // canoniques. » Refuser est bruyant ; perdre est silencieux.
    const spool = new EventSpool(scratch(), { maxEntries: 2, fsync: false })
    expect(spool.append(draft("progress", START)).ok).toBe(true)
    expect(spool.append(draft("progress", START + 1)).ok).toBe(true)
    expect(spool.saturated()).toBe(true)

    const refused = spool.append(draft("tool.completed", START + 2))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain("backpressure")

    // Et acquitter libère la place, parce que c'est le seul mécanisme de nettoyage.
    spool.ack(1)
    expect(spool.append(draft("tool.completed", START + 3)).ok).toBe(true)
  })

  test("la borne par défaut est déclarée, pas improvisée", () => {
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(1000)
  })
})

describe("coalescence — §18.3", () => {
  const evt = (type: string, at: number, extra: Partial<Event> = {}): Event =>
    ({ ...draft(type as Event["event_type"], at, extra), sequence: at }) as Event

  test("les deux listes de §18.3 ne se recoupent pas", () => {
    // La seule façon de s'apercevoir qu'un type a été rangé du mauvais côté.
    expect(coalescencePolicyFindings()).toEqual([])
    for (const type of NEVER_COALESCIBLE_TYPES) expect(isCoalescible(type)).toBe(false)
  })

  test("une rafale de progression fusionne, et le compte est visible", () => {
    const out = coalesce([evt("progress", 1), evt("progress", 2), evt("progress", 3)])
    expect(out).toHaveLength(1)
    // Le survivant est le dernier : c'est lui qui porte l'état le plus récent.
    expect(out[0]?.occurred_at).toBe(new Date(3).toISOString())
    expect((out[0]?.payload as Record<string, unknown>)["coalesced_count"]).toBe(3)
  })

  test("rien ne fusionne à travers un événement non coalescible", () => {
    // Sans cette coupure, deux `progress` encadrant un `tool.completed` fusionneraient et
    // feraient passer l'appel d'outil APRÈS une progression qui le précédait. Une coalescence qui
    // réordonne est pire qu'une absence de coalescence.
    const out = coalesce([evt("progress", 1), evt("tool.completed", 2), evt("progress", 3)])
    expect(out.map((e) => e.event_type)).toEqual(["progress", "tool.completed", "progress"])
  })

  test("un coût, une alerte, une demande humaine ne fusionnent jamais", () => {
    for (const type of ["usage.reported", "security.alert", "human.input.requested"]) {
      const out = coalesce([evt(type, 1), evt(type, 2)])
      expect(out).toHaveLength(2)
    }
  })

  test("deux attempts ne fusionnent pas entre eux", () => {
    // Ils racontent deux histoires ; les fondre en ferait une troisième, qui n'a eu lieu nulle part.
    const out = coalesce([evt("progress", 1), evt("progress", 2, { attempt: 2 })])
    expect(out).toHaveLength(2)
  })

  test("une liste vide ou d'un seul élément traverse sans dommage", () => {
    expect(coalesce([])).toEqual([])
    expect(coalesce([evt("progress", 1)])).toHaveLength(1)
  })
})

describe("champs d'événement — §18.2", () => {
  test("les champs que le schéma épinglé définit sont exigés", () => {
    const complete = { ...draft("progress"), sequence: 1 } as Event
    expect(eventFieldFindings(complete)).toEqual([])

    const partial = { ...complete, task_id: undefined } as unknown as Event
    expect(eventFieldFindings(partial)).toHaveLength(1)
  })

  test("`worker.registered` n'a pas à déclarer une tâche qu'il précède", () => {
    // Correction apportée par W2.14 : exiger `task_id` sur tout événement faisait passer
    // `worker.registered` pour non conforme alors qu'il n'a rien à déclarer — il précède toute
    // tâche. Une vérification qui se trompe sur les cas normaux apprend surtout à ne plus être lue.
    const registered = {
      protocol: PROTOCOL_VERSION,
      event_type: "worker.registered",
      sequence: 1,
      occurred_at: new Date(START).toISOString(),
      idempotency_key: "registered-1",
    } as unknown as Event
    expect(eventFieldFindings(registered)).toEqual([])
    expect(ATTEMPT_SCOPED_TYPES).not.toContain("worker.registered")
    // Mais un événement d'attempt sans tâche reste un constat.
    expect(ATTEMPT_SCOPED_TYPES).toContain("artifact.declared")
  })

  test("aucun champ absent du schéma n'est inventé localement", () => {
    // §18.2 cite `message_id`, que `lep/1.0` ne définit pas. L'ajouter ici serait dupliquer le
    // contrat cross-repo : un champ inventé côté worker ne serait ni validé ni reconnu par un pair
    // conforme. L'écart est écrit au ledger, pas comblé en douce.
    const source = readFileSync(join(import.meta.dir, "../../src/locus/event-bridge.ts"), "utf8")
    expect(source).toContain("message_id")
    // `correlation_id`, lui, EXISTE dans le schéma — facultatif. C'est la couche qui émet qui le
    // pose ; il n'a pas à être inventé, et il n'a pas non plus à être exigé de ce qui ne le pose
    // pas encore.
    expect(REQUIRED_EVENT_FIELDS).not.toContain("correlation_id")
    const spoolSource = readFileSync(join(import.meta.dir, "../../src/locus/event-spool.ts"), "utf8")
    for (const invented of ["correlation_id:", "message_id:"]) {
      expect(spoolSource).not.toContain(invented)
    }
  })
})
