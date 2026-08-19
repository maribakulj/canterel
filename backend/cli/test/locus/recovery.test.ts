import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { EventSpool } from "../../src/locus/event-spool.ts"
import { PROTOCOL_VERSION } from "../../src/locus/protocol.ts"
import { CHECKPOINT_FILE, ResumeStore, type Checkpoint } from "../../src/locus/resume-store.ts"
import {
  leaseAfterRestart,
  offlineVerdict,
  partialSubmission,
  restartDiagnostics,
  restorabilityFindings,
  resumeDecision,
} from "../../src/locus/recovery.ts"
import { payloadHash } from "../../src/locus/lep/canonical.ts"
import type { Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "locus-recovery-"))
const START = Date.parse("2026-08-16T10:00:00.000Z")

const LEASE = {
  protocol: PROTOCOL_VERSION,
  lease_id: "lease-1",
  task_id: "task-1",
  attempt: 1,
  worker_id: "canterel-1",
  issued_at: new Date(START).toISOString(),
  expires_at: new Date(START + 1_800_000).toISOString(),
  ttl_seconds: 1800,
  heartbeat_interval_seconds: 300,
} as unknown as Lease

const MISSION = {
  protocol: PROTOCOL_VERSION,
  task_id: "task-1",
  attempt_id: "attempt-1",
  branch_id: "branch-1",
} as unknown as MissionEnvelope

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    task_id: "task-1",
    attempt: 1,
    state: "running",
    session: { step: 7 },
    context_hash: `sha256:${"cd".repeat(32)}`,
    worktree: { "notes.md": `sha256:${"ef".repeat(32)}` },
    partial_artifacts: ["artifact-1", "artifact-2"],
    budget_spent: { model_calls: 12, cost: 3 },
    next_operations: ["reprendre l'analyse spectrale"],
    unserializable: [],
    through_sequence: 4,
    taken_at: new Date(START + 600_000).toISOString(),
    ...over,
  }
}

function draft(type: Event["event_type"], at: number): Omit<Event, "sequence"> {
  return {
    protocol: PROTOCOL_VERSION,
    event_type: type,
    occurred_at: new Date(at).toISOString(),
    idempotency_key: `${type}-${at}`,
    task_id: "task-1",
    attempt: 1,
  } as Omit<Event, "sequence">
}

describe("redémarrage du worker en cours de mission — le test de sortie de W2.16", () => {
  test("après redémarrage, le lease n'est pas supposé valide, et rien ne reprend sans autorisation", () => {
    const dir = scratch()
    const store = new ResumeStore(dir)
    const spool = new EventSpool(dir)

    // Une mission en cours : des événements émis, un acquittement partiel, un checkpoint.
    spool.append(draft("attempt.started", START))
    spool.append(draft("progress", START + 60_000))
    spool.append(draft("progress", START + 120_000))
    spool.ack(1)
    store.save(checkpoint())

    // « Redémarrage » : tout est relu depuis le disque.
    const revivedStore = new ResumeStore(dir)
    const revivedSpool = new EventSpool(dir)
    const loaded = revivedStore.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    // §24.1 : « préserver les artefacts et événements ».
    expect(revivedSpool.unacked().map((entry) => entry.sequence)).toEqual([2, 3])
    expect(loaded.checkpoint.partial_artifacts).toEqual(["artifact-1", "artifact-2"])
    // Et « reconstruire les attempts locaux » : l'état est celui du checkpoint, pas un état neuf.
    expect(loaded.checkpoint.state).toBe("running")

    // Le lease est encore dans sa TTL selon l'horloge locale — et ça ne suffit pas.
    const now = START + 900_000
    expect(leaseAfterRestart(LEASE, now)).toBe("unconfirmed")

    const decision = resumeDecision({ checkpoint: loaded.checkpoint, lease: LEASE, now })
    // Pendant l'arrêt, le serveur a pu déclarer l'attempt orphelin et le réattribuer. Reprendre
    // sur la foi d'un lease relu, c'est deux workers sur la même mission croyant chacun être seul.
    expect(decision.action).toBe("reconcile")
    if (decision.action !== "reconcile") return
    expect(decision.reason).toContain("non reconfirmé")

    // Et seule l'autorisation du serveur débloque la reprise.
    const authorized = resumeDecision({
      checkpoint: loaded.checkpoint,
      lease: LEASE,
      now,
      serverAuthorized: true,
    })
    expect(authorized.action).toBe("resume")
    if (authorized.action === "resume") expect(authorized.from.through_sequence).toBe(4)
  })

  test("un lease expiré pendant l'arrêt se lit localement, et ne demande rien", () => {
    // C'est le seul verdict que l'horloge locale a le droit de rendre : une échéance dépassée
    // l'est pour tout le monde.
    expect(leaseAfterRestart(LEASE, START + 2_000_000)).toBe("expired")
    expect(leaseAfterRestart(null, START)).toBe("expired")

    const decision = resumeDecision({ checkpoint: checkpoint(), lease: LEASE, now: START + 2_000_000 })
    expect(decision.action).toBe("reconcile")
  })

  test("sans checkpoint, on repart de zéro plutôt que de deviner", () => {
    const decision = resumeDecision({ checkpoint: null, lease: LEASE, now: START })
    expect(decision.action).toBe("start-fresh")
  })

  test("un attempt déjà terminé ne se reprend pas", () => {
    for (const state of ["completed", "failed", "cancelled", "lease_lost"] as const) {
      const decision = resumeDecision({
        checkpoint: checkpoint({ state }),
        lease: LEASE,
        now: START + 900_000,
        serverAuthorized: true,
      })
      expect(decision.action).toBe("start-fresh")
    }
  })
})

describe("checkpoints — §24.2", () => {
  test("une dépendance non sérialisable et non reconstructible rend la session irrécupérable", () => {
    // Reprendre en faisant comme si elle n'avait pas existé produirait un état qui n'a jamais eu
    // lieu — et la reprise repartirait avec confiance.
    const broken = checkpoint({
      unserializable: [{ kind: "contexte GPU", reason: "le device a été libéré à l'arrêt", recoverable: false }],
    })
    const decision = resumeDecision({ checkpoint: broken, lease: LEASE, now: START, serverAuthorized: true })
    expect(decision.action).toBe("abandon")
    if (decision.action !== "abandon") return
    expect(decision.findings[0]).toContain("contexte GPU")
  })

  test("une dépendance reconstructible est du travail, pas une impossibilité", () => {
    const rebuildable = checkpoint({
      unserializable: [{ kind: "worktree git", reason: "à recloner", recoverable: true }],
    })
    expect(restorabilityFindings(rebuildable)).toEqual([])
  })

  test("une empreinte de contexte absente empêche de ré-authentifier la vue", () => {
    // §12.3 : une vue dont l'empreinte manque n'est pas un contexte appauvri, c'est un contexte
    // dont on ne sait pas ce qu'il est.
    const findings = restorabilityFindings(checkpoint({ context_hash: "" }))
    expect(findings.some((finding) => finding.includes("empreinte"))).toBe(true)
  })

  test("un checkpoint d'une autre majeure de protocole n'est pas relu", () => {
    const findings = restorabilityFindings(checkpoint(), {
      checkpoint: null,
      lease: null,
      now: START,
      protocol: "lep/2.0",
      checkpointProtocol: "lep/1.0",
    })
    expect(findings.some((finding) => finding.includes("majeures incompatibles"))).toBe(true)
  })

  test("les sept contenus de §24.2 sont portés, `unserializable` compris", () => {
    const store = new ResumeStore(scratch())
    store.save(checkpoint())
    const loaded = store.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    for (const field of [
      "session",
      "context_hash",
      "worktree",
      "partial_artifacts",
      "budget_spent",
      "next_operations",
      "unserializable",
    ] as const) {
      expect(loaded.checkpoint[field]).toBeDefined()
    }
  })
})

describe("corruption locale — §24.5", () => {
  test("une empreinte incohérente met en quarantaine, et ne répare rien", () => {
    // « Une incohérence déclenche quarantaine et diagnostic, jamais réparation silencieuse. »
    const dir = scratch()
    const store = new ResumeStore(dir)
    store.save(checkpoint())

    // Un octet change dans le contenu, l'empreinte reste celle d'avant.
    const file = join(dir, CHECKPOINT_FILE)
    const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    const tampered = { ...(envelope["checkpoint"] as Record<string, unknown>), through_sequence: 999 }
    writeFileSync(file, JSON.stringify({ checkpoint: tampered, hash: envelope["hash"] }))

    const loaded = new ResumeStore(dir).load()
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.outcome).toBe("quarantined")
    if (loaded.outcome !== "quarantined") return
    expect(loaded.reason).toContain("§24.5")
    // Déplacé, jamais supprimé : c'est la seule pièce qui dira ce qui s'est passé.
    expect(loaded.movedTo).toBeTruthy()
    expect(new ResumeStore(dir).quarantined()).toHaveLength(1)
  })

  test("un checkpoint malformé ne se lit pas à moitié", () => {
    const dir = scratch()
    new ResumeStore(dir).save(checkpoint())
    writeFileSync(join(dir, CHECKPOINT_FILE), '{"checkpoint":{"task_id":"task-1"')

    const loaded = new ResumeStore(dir).load()
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.outcome).toBe("quarantined")
  })

  test("l'absence de checkpoint n'est pas une corruption", () => {
    const loaded = new ResumeStore(scratch()).load()
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.outcome).toBe("absent")
  })

  test("l'empreinte porte sur le JSON canonique, pas sur les octets écrits", () => {
    // Deux exécutions conformes n'ordonnent pas forcément les clés pareil ; vérifier un hash
    // calculé sur des octets non canoniques ferait échouer la relecture sur rien.
    const store = new ResumeStore(scratch())
    const point = checkpoint()
    expect(store.save(point)).toBe(payloadHash(point))
  })

  test("aucune fonction ne répare un checkpoint", () => {
    const module = require("../../src/locus/resume-store.ts") as Record<string, unknown>
    for (const forbidden of ["repair", "rehash", "fix", "salvage", "forceLoad"]) {
      expect(module[forbidden]).toBeUndefined()
    }
    const source = readFileSync(join(import.meta.dir, "../../src/locus/resume-store.ts"), "utf8")
    // Réécrire l'empreinte pour la faire correspondre serait la réparation silencieuse elle-même.
    expect(source).not.toContain("hash: recomputed")
    expect(source).not.toContain("unlinkSync")
  })
})

describe("offline — §24.3, et la tranche 3 du mineur `lep/1.1`", () => {
  /** Une mission qui porte la permission, sous le nom que l'enveloppe lui donne. */
  function permise(permission: Partial<MissionEnvelope>): MissionEnvelope {
    return { ...MISSION, ...permission }
  }

  test("sans autorisation de la mission, le worker checkpoint et suspend", () => {
    // Deny-by-default : continuer parce que rien ne l'interdit ferait travailler hors ligne sur
    // la mission dont l'auteur n'a jamais imaginé qu'on le lui demanderait.
    const verdict = offlineVerdict(MISSION, LEASE, START)
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.action).toBe("checkpoint-and-suspend")

    const explicit = offlineVerdict(permise({ offline_allowed: false }), LEASE, START)
    expect(explicit.allowed).toBe(false)
  })

  test("la permission vient de l'enveloppe, et de nulle part ailleurs", () => {
    // Le sujet du branchement. `offlineVerdict` prenait la permission en quatrième paramètre,
    // faute de champ sur le fil ; un appelant pouvait donc accorder une dispense que la mission
    // n'avait jamais donnée — exactement le trou que le refus par défaut protégeait. La signature
    // ne l'accepte plus, et un test qui compterait ses arités le dirait mieux qu'un commentaire.
    expect(offlineVerdict.length).toBe(3)

    const source = readFileSync(join(import.meta.dir, "../../src/locus/recovery.ts"), "utf8")
    const bloc = source.slice(source.indexOf("export function offlineVerdict"))
    expect(bloc.slice(0, bloc.indexOf("}\n\n"))).not.toContain("permission")
  })

  test("autorisé, le plafond ne dépasse jamais le lease", () => {
    // Un budget offline plus long que le lease donnerait le droit de travailler après la fin du
    // droit de travailler.
    const generous = offlineVerdict(
      permise({ offline_allowed: true, offline_budget_ms: 99_999_999 }),
      LEASE,
      START,
    )
    expect(generous.allowed).toBe(true)
    if (generous.allowed) expect(generous.untilMs).toBe(1_800_000)

    const tight = offlineVerdict(permise({ offline_allowed: true, offline_budget_ms: 60_000 }), LEASE, START)
    if (tight.allowed) expect(tight.untilMs).toBe(60_000)
  })

  test("un budget sans permission n'autorise rien", () => {
    // Un budget n'est pas une permission. Le lire comme telle ferait d'un plafond une dispense,
    // c'est-à-dire d'une borne une autorisation — la même confusion que `network_mode` face à
    // `offline_allowed`, à un cran de plus.
    const verdict = offlineVerdict(permise({ offline_budget_ms: 60_000 }), LEASE, START)
    expect(verdict.allowed).toBe(false)
  })

  test("le confinement réseau ne décide pas de la dispense", () => {
    // Les quatre combinaisons, côté lecteur cette fois : `network` contraint, la permission
    // dispense, et aucune des deux ne se déduit de l'autre. Une mission en `deny` sans dispense
    // n'a jamais eu de réseau à perdre ; une mission en `full` sans dispense doit échouer s'il
    // tombe. Si le lecteur dérivait l'une de l'autre, la seconde disparaîtrait.
    for (const network of ["deny", "full"] as const) {
      const sandbox = { ...MISSION.sandbox, network }
      expect(offlineVerdict(permise({ sandbox }), LEASE, START).allowed).toBe(false)
      expect(offlineVerdict(permise({ sandbox, offline_allowed: true }), LEASE, START).allowed).toBe(true)
    }
  })

  test("sans lease valide, aucun offline", () => {
    const verdict = offlineVerdict(permise({ offline_allowed: true }), LEASE, START + 2_000_000)
    expect(verdict.allowed).toBe(false)
  })
})

describe("résultats partiels — §24.4", () => {
  test("un commit partiel se déclare partiel, et nomme ce qui manque", () => {
    // Un commit partiel qui ne se déclare pas partiel est lu comme un commit complet dont les
    // résultats manquants n'existent pas. Même règle qu'en §11.4 et §21.6.
    const submission = partialSubmission({
      checkpoint: checkpoint(),
      state: "failed",
      verifiedArtifacts: ["artifact-1"],
      negativeResults: ["la piste B ne donne rien"],
      diagnostics: ["OOM à l'étape 7"],
      causes: ["mémoire insuffisante"],
    })
    expect(submission.partial).toBe(true)
    expect(submission.artifacts).toEqual(["artifact-1"])
    // Nommé, pas déduit d'une absence.
    expect(submission.lost).toEqual(["artifact-2"])
    expect(submission.negative_results).toHaveLength(1)
    expect(submission.progress).toEqual(["reprendre l'analyse spectrale"])
  })

  test("le diagnostic de redémarrage dit ce qui n'a pas été supposé", () => {
    // « On a redémarré » ne doit pas être un événement muet.
    const lines = restartDiagnostics({
      decision: { action: "reconcile", reason: "lease non reconfirmé" },
      standing: "unconfirmed",
      unackedEvents: 2,
      quarantined: [],
    })
    expect(lines.some((line) => line.includes("non supposé valide"))).toBe(true)
    expect(lines.some((line) => line.includes("2"))).toBe(true)
  })

  test("un abandon transporte ses constats dans le diagnostic", () => {
    const lines = restartDiagnostics({
      decision: { action: "abandon", reason: "irrécupérable", findings: ["contexte GPU perdu"] },
      standing: "expired",
      unackedEvents: 0,
      quarantined: ["/tmp/x/quarantine/checkpoint.json.hash-mismatch.0"],
    })
    expect(lines.some((line) => line.includes("contexte GPU perdu"))).toBe(true)
    expect(lines.some((line) => line.includes("quarantine"))).toBe(true)
  })
})
