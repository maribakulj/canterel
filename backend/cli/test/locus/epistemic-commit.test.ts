import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LOCUS_ONLY_STATUSES,
  PROPOSAL_STATUSES,
  addFindings,
  assertProposable,
  buildCommit,
  commitSubmittedPayload,
  isProposalStatus,
  stage,
  submitCommit,
  validateCommit,
  type CommitInput,
} from "../../src/locus/epistemic-commit.ts"
import { LocusCommitRefused } from "../../src/locus/errors.ts"
import { loadOrCreateIdentity } from "../../src/locus/identity.ts"
import { verify } from "../../src/locus/identity.ts"
import { payloadHash } from "../../src/locus/lep/canonical.ts"
import { PROTOCOL_VERSION } from "../../src/locus/protocol.ts"
import type { EpistemicCommit, Lease } from "../../src/locus/lep/generated.ts"

const PRODUCED_AT = "2026-08-16T12:00:00.000Z"
const HASH = `sha256:${"ab".repeat(32)}`

const identity = () => loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "locus-commit-")))

function input(over: Partial<CommitInput> = {}): CommitInput {
  return {
    protocol: PROTOCOL_VERSION,
    task_id: "task-1",
    attempt: 1,
    produced_at: PRODUCED_AT,
    ...over,
  }
}

/** Un commit qui passe §21.4 : références résolues, hashées, inférence complète. */
function sound(over: Partial<CommitInput> = {}): EpistemicCommit {
  return buildCommit(
    input({
      artifact_refs: [{ artifact_id: "artifact-1", content_hash: HASH }],
      claims: [{ statement: "le solvant n'explique pas l'écart", confidence: 0.6 }],
      inferences: [{ rule: "modus tollens", premise_refs: ["p1"], conclusion_refs: ["c1"] }],
      ...over,
    }),
  )
}

const KNOWN = new Map([["artifact-1", HASH]])
const VALID = { knownArtifacts: KNOWN, baseRevision: "rev-42" }

describe("tentative de promotion → erreur structurée — le test de sortie de W2.15", () => {
  test("un statut au-delà de `staged` est refusé, et l'erreur dit lequel", () => {
    // §2.3 : « Canterel NE DOIT PAS promouvoir un claim au-delà de `staged` ». Le schéma le rend
    // déjà indéfaisable, mais un type ne survit pas à la frontière du processus : ce qui traverse
    // le fil est du JSON, et du JSON ne porte aucun type.
    for (const status of LOCUS_ONLY_STATUSES) {
      const failure = (() => {
        try {
          return buildCommit(input({ status }))
        } catch (error: unknown) {
          return error
        }
      })()
      expect(failure).toBeInstanceOf(LocusCommitRefused)
      const payload = (failure as InstanceType<typeof LocusCommitRefused>).data
      // Structurée, pas une chaîne : `attempted` porte le statut demandé, parce que la question
      // qu'on se pose en lisant l'erreur est lequel a été tenté.
      expect(payload.attempted).toBe(status)
      expect(payload.reason).toContain("staged")
    }
  })

  test("`validated` est nommé comme un verdict, pas comme une faute de frappe", () => {
    // « Statut invalide » envoie relire un schéma ; « c'est un verdict de l'institution » se
    // corrige.
    const refused = (() => {
      try {
        assertProposable("validated")
      } catch (error: unknown) {
        return error as InstanceType<typeof LocusCommitRefused>
      }
      return null
    })()
    expect(refused?.data.reason).toContain("verdict")

    const unknown = (() => {
      try {
        assertProposable("à-peu-près-validé")
      } catch (error: unknown) {
        return error as InstanceType<typeof LocusCommitRefused>
      }
      return null
    })()
    expect(unknown?.data.reason).toContain("inconnu")
  })

  test("un statut interdit n'est jamais corrigé en silence", () => {
    // Le ramener à `staged` apprendrait à l'appelant qu'il peut en demander un.
    expect(() => buildCommit(input({ status: "promoted" }))).toThrow(LocusCommitRefused)
    expect(PROPOSAL_STATUSES).toEqual(["draft", "staged"])
    for (const status of LOCUS_ONLY_STATUSES) expect(isProposalStatus(status)).toBe(false)
  })

  test("aucune fonction ne promeut, et aucune ne dérive un statut d'une confiance", () => {
    // §21.5 : « le champ `confidence` d'un agent ne remplace jamais la validation Locus Solus ».
    const module = require("../../src/locus/epistemic-commit.ts") as Record<string, unknown>
    for (const forbidden of ["promote", "validate", "accept", "merge", "canonicalize", "statusFromConfidence"]) {
      expect(module[forbidden]).toBeUndefined()
    }
    const source = readFileSync(join(import.meta.dir, "../../src/locus/epistemic-commit.ts"), "utf8")
    for (const forbidden of ['status: "validated"', 'status: "promoted"', 'status: "accepted"']) {
      expect(source).not.toContain(forbidden)
    }
  })

  test("`draft` est le défaut, et `stage` est la seule transition", () => {
    // `staged` est ce qu'on soumet : l'atteindre doit être un geste, pas une valeur par défaut.
    expect(buildCommit(input()).status).toBe("draft")
    const staged = stage(buildCommit(input()))
    expect(staged.status).toBe("staged")
    // Idempotente, et sans retour en arrière : revenir à `draft` laisserait croire qu'on peut
    // retirer une proposition déjà partie.
    expect(stage(staged)).toBe(staged)
    const module = require("../../src/locus/epistemic-commit.ts") as Record<string, unknown>
    expect(module["unstage"]).toBeUndefined()
  })
})

describe("validation locale avant soumission — §21.4", () => {
  test("un commit sain passe, et son rapport dit ce qui n'a pas tourné", () => {
    const report = validateCommit(sound(), VALID)
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    // Le scan de secrets appartient à l'admission : `ok` avec `complete: false` veut dire « rien
    // trouvé sur ce que j'ai pu regarder », pas « conforme ».
    expect(report.complete).toBe(false)
    expect(report.checks.find((check) => check.check === "secrets")?.status).toBe("skipped")
    for (const check of report.checks) {
      if (check.status !== "enforced") expect(check.note).toBeTruthy()
    }
  })

  test("une inférence sans prémisse est une conclusion déguisée en raisonnement", () => {
    // §7.6 : une inférence est un nœud explicite, avec ses prémisses — pas une flèche implicite
    // entre deux claims.
    const report = validateCommit(
      sound({ inferences: [{ rule: "au pif", premise_refs: [], conclusion_refs: ["c1"] }] }),
      VALID,
    )
    expect(report.ok).toBe(false)
    expect(report.findings.some((finding) => finding.includes("sans prémisse"))).toBe(true)
  })

  test("une référence sans hash désigne un nom, pas un contenu", () => {
    const report = validateCommit(sound({ artifact_refs: [{ artifact_id: "artifact-1" }] }), VALID)
    expect(report.findings.some((finding) => finding.includes("sans hash"))).toBe(true)
  })

  test("un hash tronqué est refusé, pas raccourci", () => {
    const report = validateCommit(
      sound({ artifact_refs: [{ artifact_id: "artifact-1", content_hash: "sha256:court" }] }),
      VALID,
    )
    expect(report.findings.some((finding) => finding.includes("illisible"))).toBe(true)
  })

  test("une référence non résolue est un constat, et sans catalogue le contrôle se déclare", () => {
    const orphan = validateCommit(sound({ artifact_refs: [{ artifact_id: "fantôme", content_hash: HASH }] }), VALID)
    expect(orphan.findings.some((finding) => finding.includes("non résolue"))).toBe(true)

    // Sans catalogue, le contrôle ne tourne pas — et il le dit plutôt que de laisser croire
    // que les références sont résolues.
    const blind = validateCommit(sound(), { baseRevision: "rev-42" })
    expect(blind.checks.find((check) => check.check === "artifact_resolution")?.status).toBe("skipped")
    expect(blind.ok).toBe(true)
    expect(blind.complete).toBe(false)
  })

  test("deux objets locaux de même identifiant rendent les relations ambiguës", () => {
    const report = validateCommit(
      sound({
        artifact_refs: [
          { artifact_id: "artifact-1", content_hash: HASH },
          { artifact_id: "artifact-1", content_hash: HASH },
        ],
      }),
      VALID,
    )
    expect(report.findings.some((finding) => finding.includes("en double"))).toBe(true)
  })

  test("sans révision de base, on ne sait pas sur quoi le commit porte", () => {
    const report = validateCommit(sound(), { knownArtifacts: KNOWN })
    expect(report.findings.some((finding) => finding.includes("révision de base"))).toBe(true)
  })
})

describe("soumission signée — §21.3, §21.6", () => {
  test("la signature porte sur le hash canonique, pas sur une sérialisation", async () => {
    // Deux pairs conformes n'écrivent pas les mêmes octets pour la même donnée ; signer la sortie
    // d'un sérialiseur ferait échouer la vérification sur rien.
    const me = await identity()
    const signed = submitCommit(sound(), me, VALID)
    expect(signed.commit.status).toBe("staged")
    expect(signed.commit_hash).toBe(payloadHash(signed.commit))
    expect(verify(me.public.public_key, signed.commit_hash, signed.signature)).toBe(true)
  })

  test("un commit invalide ne part pas, et l'erreur porte tous les constats", async () => {
    // Un commit rendu invalide une raison à la fois se corrige une soumission à la fois.
    const me = await identity()
    const failure = (() => {
      try {
        return submitCommit(sound({ artifact_refs: [{ artifact_id: "fantôme" }] }), me, VALID)
      } catch (error: unknown) {
        return error
      }
    })()
    expect(failure).toBeInstanceOf(LocusCommitRefused)
    const payload = (failure as InstanceType<typeof LocusCommitRefused>).data
    expect((payload.findings ?? []).length).toBeGreaterThan(1)
  })

  test("un commit produit après l'échéance se déclare tardif", async () => {
    // §21.6 : « un commit produit après expiration porte le statut `late` » — sauf que `status`
    // est pris par §2.3. Le marqueur vit donc à côté, comme pour un résultat tardif en §11.4.
    const me = await identity()
    const lease = {
      protocol: PROTOCOL_VERSION,
      lease_id: "lease-1",
      task_id: "task-1",
      attempt: 1,
      worker_id: "canterel-1",
      issued_at: "2026-08-16T11:00:00.000Z",
      expires_at: "2026-08-16T11:30:00.000Z",
      ttl_seconds: 1800,
      heartbeat_interval_seconds: 300,
    } as unknown as Lease

    const late = submitCommit(sound(), me, { ...VALID, lease })
    expect(late.late).toBe(true)
    expect(commitSubmittedPayload(late)["late"]).toBe(true)
    // Et le statut n'a pas bougé : `late` n'en est pas un.
    expect(late.commit.status).toBe("staged")

    const onTime = submitCommit(sound(), me, { ...VALID, lease, at: Date.parse("2026-08-16T11:15:00.000Z") })
    expect(onTime.late).toBeUndefined()
    expect(commitSubmittedPayload(onTime)["late"]).toBeUndefined()
  })
})

describe("invariant 12 — rien ne se supprime pour faire propre", () => {
  test("objections et résultats négatifs ne font que s'ajouter", () => {
    const base = sound({ objections: [{ statement: "le contrôle manque" }] })
    const enriched = addFindings(base, {
      objections: [{ statement: "l'échantillon est trop petit" }],
      negative_results: [{ statement: "la piste B ne donne rien", attempted: "variation du pH" }],
    })
    expect(enriched.objections).toHaveLength(2)
    expect(enriched.negative_results).toHaveLength(1)
    // L'original n'a pas bougé : ajouter ne réécrit pas.
    expect(base.objections).toHaveLength(1)
  })

  test("aucune fonction ne retire une objection ou un résultat négatif", () => {
    // C'est la seule façon de garder vraie une phrase que personne ne relit.
    const module = require("../../src/locus/epistemic-commit.ts") as Record<string, unknown>
    for (const forbidden of [
      "dropObjection",
      "removeObjection",
      "clearNegativeResults",
      "pruneObjections",
      "filterFindings",
    ]) {
      expect(module[forbidden]).toBeUndefined()
    }
  })

  test("le rapport de soumission compte les objections plutôt que de les taire", async () => {
    const me = await identity()
    const signed = submitCommit(
      addFindings(sound(), { objections: [{ statement: "résultat non répliqué" }] }),
      me,
      VALID,
    )
    const payload = commitSubmittedPayload(signed)
    expect(payload["objections"]).toBe(1)
    expect(payload["claims"]).toBe(1)
  })
})
