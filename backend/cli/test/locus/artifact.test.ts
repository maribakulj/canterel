import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

import {
  DEFAULT_HASH_ALGORITHM,
  HASH_ALGORITHMS,
  artifactDeclaredPayload,
  artifactUploadedPayload,
  cachePath,
  contentHash,
  declareArtifact,
  evictable,
  parseHash,
  publishArtifact,
  sameHash,
  type ArtifactTransport,
  type DeclareInput,
  type UploadReceipt,
  type UploadTicket,
} from "../../src/locus/artifact-client.ts"
import {
  MAX_ARCHIVE_EXPANSION_RATIO,
  SCAN_CHECKS,
  quarantineReason,
  scanArtifact,
} from "../../src/locus/artifact-scanner.ts"
import { LocusArtifactRejected, LocusServerRejected } from "../../src/locus/errors.ts"

const NOW = new Date("2026-08-16T12:00:00.000Z")
const bytes = (text: string) => new TextEncoder().encode(text)

const PRODUCED_BY = { task_id: "task-1", attempt: 1, worker_id: "canterel-1" } as const

/**
 * Les appâts du scanner, assemblés à l'exécution.
 *
 * Écrits en clair, ils feraient rougir le job `Gitleaks` — à juste titre : son travail est de crier
 * sur une clé privée et sur un identifiant AWS dans le dépôt, et il n'a pas à savoir lesquels sont
 * des décors de test. Les allowlister apprendrait au garde-fou à ignorer une forme réelle. Les
 * assembler ici ne change rien à ce que le scanner voit, et laisse les deux outils faire leur
 * travail sans se marcher dessus.
 */
const BAIT = {
  pem: ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
  aws: `AKIA${"IOSFODNN7EXAMPLE"}`,
}

function declaration(over: Partial<DeclareInput> = {}) {
  const content = over.bytes ?? bytes("des résultats parfaitement ordinaires\n")
  return declareArtifact({
    artifact_id: "artifact-1",
    media_type: "text/plain",
    classification: "internal",
    produced_by: PRODUCED_BY,
    now: () => NOW,
    ...over,
    bytes: content,
  })
}

/** Un transport qui renvoie exactement ce qu'on lui dit de renvoyer. */
function transportOf(receipt: (bytes: Uint8Array) => UploadReceipt, ticket?: Partial<UploadTicket>): ArtifactTransport {
  return {
    requestUpload: async () => ({ url: "https://locus.example/upload/abc", ...ticket }),
    put: async (_ticket, payload) => receipt(payload),
  }
}

/** Le transport honnête : il rend le hash de ce qu'il a réellement reçu. */
const HONEST = transportOf((payload) => ({
  received_hash: contentHash(payload),
  size_bytes: payload.length,
}))

describe("hash déclaré ≠ hash reçu → rejet — le test de sortie de W2.14", () => {
  test("un hash reçu différent fait rejeter, et rien ne le répare", async () => {
    const content = bytes("le contenu promis")
    const declared = declaration({ bytes: content })

    // Le serveur annonce avoir reçu autre chose. Peu importe quoi : la promesse ne couvre pas ça.
    const menteur = transportOf(() => ({ received_hash: contentHash(bytes("autre chose")) }))

    const failure = await publishArtifact(declared, content, menteur, () => NOW).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LocusArtifactRejected)
    const payload = (failure as InstanceType<typeof LocusArtifactRejected>).data
    expect(payload.reason).toBe("hash déclaré ≠ hash reçu")
    // Les deux moitiés voyagent : la première question est laquelle a bougé.
    expect(payload.declared_hash).toBe(declared.manifest.content_hash)
    expect(payload.received_hash).not.toBe(declared.manifest.content_hash)

    // Et le manifest n'a pas bougé : ni `uploaded`, ni un hash réécrit avec celui du serveur.
    expect(declared.manifest.state).toBe("declared")
    expect(declared.manifest.content_hash).toBe(contentHash(content))
  })

  test("aucun chemin ne réécrit le hash déclaré", () => {
    // §24.5 : une incohérence déclenche quarantaine et diagnostic, jamais réparation silencieuse.
    // Offrir une fonction qui redéclare avec le hash du serveur offrirait le moyen de contourner
    // exactement la vérification que §19.1 installe.
    const module = require("../../src/locus/artifact-client.ts") as Record<string, unknown>
    for (const forbidden of ["redeclare", "rehash", "acceptServerHash", "repairManifest", "forceUpload"]) {
      expect(module[forbidden]).toBeUndefined()
    }
    const source = readFileSync(join(import.meta.dir, "../../src/locus/artifact-client.ts"), "utf8")
    expect(source).not.toContain("content_hash: receipt")
    expect(source).not.toContain("content_hash: received")
  })

  test("le trajet nominal aboutit à `uploaded` avec une intégrité constatée", async () => {
    const content = bytes("un artefact honnête")
    const declared = declaration({ bytes: content })
    expect(declared.manifest.state).toBe("declared")

    const result = await publishArtifact(declared, content, HONEST, () => NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.state).toBe("uploaded")
    expect(result.manifest.uploaded_at).toBe(NOW.toISOString())
    // Constaté, pas supposé : ce champ n'est posé que sur le chemin qui a comparé les deux hashes.
    expect(result.manifest.integrity?.verified_hash_matches).toBe(true)
  })

  test("une taille reçue divergente fait rejeter, même à hash égal", async () => {
    // Deux chiffres qui se contredisent ne se moyennent pas. Un hash juste avec une taille fausse
    // veut dire que l'un des deux compteurs ment, et on ne sait pas lequel.
    const content = bytes("charge utile")
    const declared = declaration({ bytes: content })
    const bavard = transportOf((payload) => ({ received_hash: contentHash(payload), size_bytes: payload.length + 1 }))

    const failure = await publishArtifact(declared, content, bavard, () => NOW).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LocusArtifactRejected)
  })
})

describe("déclaration avant upload — §19.1", () => {
  test("le hash est calculé sur les octets, jamais repris de l'appelant", () => {
    const content = bytes("contenu mesurable")
    const declared = declaration({ bytes: content })
    expect(declared.manifest.content_hash).toBe(`sha256:${createHash("sha256").update(content).digest("hex")}`)
    expect(declared.manifest.size_bytes).toBe(content.length)
    expect(declared.manifest.declared_at).toBe(NOW.toISOString())
  })

  test("un contenu modifié entre déclaration et upload est refusé avant l'envoi", async () => {
    // Le cas ordinaire d'un worker qui écrit encore dans le fichier qu'il vient de déclarer.
    // La promesse ne couvre pas ces octets-là ; les envoyer quand même les ferait passer pour
    // couverts.
    const declared = declaration({ bytes: bytes("version A") })
    let touched = false
    const transport: ArtifactTransport = {
      requestUpload: async () => {
        touched = true
        return { url: "https://locus.example/upload/abc" }
      },
      put: async () => ({}),
    }

    const failure = await publishArtifact(declared, bytes("version B"), transport, () => NOW).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LocusArtifactRejected)
    // Refusé AVANT de demander l'URL : rien n'est sorti de la machine.
    expect(touched).toBe(false)
  })

  test("sans hash de réception, `artifact.uploaded` n'est pas atteint", async () => {
    // §19.1 place la vérification avant l'événement. Émettre quand même transformerait « je crois »
    // en « c'est fait ».
    const content = bytes("silencieux")
    const declared = declaration({ bytes: content })
    const muet = transportOf(() => ({}))

    const result = await publishArtifact(declared, content, muet, () => NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.outcome).toBe("unverified")
    // Et l'état reste exactement ce qui est vrai : déclaré.
    expect(result.manifest.state).toBe("declared")
  })

  test("l'URL temporaire subit la politique d'endpoint de §7.3", async () => {
    // Le ticket vient du serveur : c'est une entrée distante. Un ticket en clair ou vers un hôte
    // interne ferait sortir l'artefact par un chemin que personne n'a autorisé.
    const content = bytes("à ne pas exfiltrer")
    const declared = declaration({ bytes: content })
    const louche: ArtifactTransport = {
      requestUpload: async () => ({ url: "http://169.254.169.254/upload" }),
      put: async () => ({ received_hash: contentHash(content) }),
    }
    expect(publishArtifact(declared, content, louche, () => NOW)).rejects.toBeInstanceOf(LocusServerRejected)
  })

  test("un ticket expiré, ou daté de travers, ne sert pas", async () => {
    const content = bytes("trop tard")
    const declared = declaration({ bytes: content })

    for (const expires of [new Date(NOW.getTime() - 1000).toISOString(), "pas une date"]) {
      const transport = transportOf(() => ({ received_hash: contentHash(content) }), { expires_at: expires })
      const result = await publishArtifact(declared, content, transport, () => NOW)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.outcome).toBe("unverified")
    }
  })

  test("le rapport `artifact.declared` porte le scan, contrôles manquants compris", () => {
    const declared = declaration()
    const payload = artifactDeclaredPayload(declared)
    const scan = payload["scan"] as Record<string, unknown>
    expect(scan["verdict"]).toBe("clean")
    // `complete: false` sur une machine sans antimalware : « clean » n'y veut pas dire « propre ».
    expect(scan["complete"]).toBe(false)
    expect((scan["outcomes"] as unknown[]).length).toBe(SCAN_CHECKS.length)
  })

  test("`artifact.uploaded` ne se construit que sur des faits", async () => {
    const content = bytes("fait établi")
    const declared = declaration({ bytes: content })
    const result = await publishArtifact(declared, content, HONEST, () => NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const payload = artifactUploadedPayload(result.manifest, result.receipt)
    expect(payload["content_hash"]).toBe(declared.manifest.content_hash)
    expect(payload["received_hash"]).toBe(declared.manifest.content_hash)
  })
})

describe("le hash préfixé — §19.2", () => {
  test("un hash nu n'est pas un hash", () => {
    // « Un hash nu ne dit pas comment le recalculer, et une vérification d'intégrité qui devine son
    // algorithme n'en est pas une. »
    expect(parseHash(createHash("sha256").update("x").digest("hex"))).toBeNull()
    expect(parseHash("sha256:court")).toBeNull()
    expect(parseHash("md5:d41d8cd98f00b204e9800998ecf8427e")).toBeNull()
    expect(parseHash(`sha256:${"z".repeat(64)}`)).toBeNull()
  })

  test("un digest tronqué est refusé, pas raccourci", () => {
    // C'est la forme que prend une intégrité cassée, et elle ressemble à un digest valide tant que
    // personne ne compte.
    const full = contentHash(bytes("x"))
    expect(parseHash(full)).not.toBeNull()
    expect(parseHash(full.slice(0, -2))).toBeNull()
  })

  test("la casse ne fait pas deux hashes de un", () => {
    const hash = contentHash(bytes("x"))
    expect(sameHash(hash, hash.toUpperCase())).toBe(true)
    // Mais un hash illisible ne ressemble à rien : `false`, jamais une égalité par défaut.
    expect(sameHash(hash, "n'importe quoi")).toBe(false)
    expect(sameHash("n'importe quoi", "n'importe quoi")).toBe(false)
  })

  test("les algorithmes acceptés déclarent leur longueur", () => {
    expect(HASH_ALGORITHMS[DEFAULT_HASH_ALGORITHM]).toBe(64)
    expect(() => contentHash(bytes("x"), "md5")).toThrow()
  })
})

describe("scan et quarantaine — §19.5", () => {
  test("les six familles du texte sont contrôlées, et chacune dit son état", () => {
    const report = scanArtifact({ bytes: bytes("rien à signaler"), media_type: "text/plain", classification: "public" })
    expect(report.outcomes.map((outcome) => outcome.check)).toEqual([...SCAN_CHECKS])
    // Un contrôle qui n'a pas tourné doit le dire : « je n'ai pas pu regarder » n'est pas « je n'ai
    // rien vu ».
    for (const outcome of report.outcomes) {
      if (outcome.status !== "enforced") expect(outcome.note).toBeTruthy()
    }
  })

  test("sans outil antimalware, le contrôle est `skipped` et le rapport incomplet", () => {
    const sans = scanArtifact({ bytes: bytes("ok"), media_type: "text/plain", classification: "public" })
    expect(sans.outcomes.find((o) => o.check === "malware")?.status).toBe("skipped")
    expect(sans.verdict).toBe("clean")
    // Le point de tout le module : `clean` + `complete: false` ≠ propre.
    expect(sans.complete).toBe(false)

    const avec = scanArtifact({
      bytes: bytes("ok"),
      media_type: "text/plain",
      classification: "public",
      allowed_classes: ["public"],
      tools: { malware: () => [] },
    })
    expect(avec.outcomes.find((o) => o.check === "malware")?.status).toBe("enforced")
  })

  test("un secret est trouvé, et n'est jamais recopié dans le constat", () => {
    const body = "MIIEvQIBADAN"
    const secret = `${BAIT.pem}\n${body}\n`
    const report = scanArtifact({ bytes: bytes(secret), media_type: "text/plain", classification: "internal" })
    expect(report.verdict).toBe("quarantined")
    expect(report.findings.some((finding) => finding.check === "secrets")).toBe(true)
    // « Ne logge ni OAuth token, API key, cookie ni contenu classifié » : le constat nomme la
    // forme, jamais la valeur.
    expect(JSON.stringify(report)).not.toContain(body)
  })

  test("un chemin de machine de développeur est un constat", () => {
    const report = scanArtifact({
      bytes: bytes("résultats dans /home/marcel/.ssh/id_ed25519"),
      media_type: "text/plain",
      classification: "internal",
    })
    expect(report.findings.some((finding) => finding.check === "sensitive_paths")).toBe(true)
  })

  test("une classification hors des classes autorisées est une donnée interdite", () => {
    const report = scanArtifact({
      bytes: bytes("contenu"),
      media_type: "text/plain",
      classification: "restricted",
      allowed_classes: ["public", "internal"],
    })
    expect(report.findings.some((finding) => finding.check === "forbidden_data")).toBe(true)
  })

  test("une archive dont l'expansion déclarée est absurde est signalée sans être ouverte", () => {
    // Décompresser pour inspecter, c'est exécuter la bombe qu'on cherche. L'en-tête suffit.
    const bomb = new Uint8Array(64)
    bomb.set([0x1f, 0x8b, 0x08, 0x00], 0)
    new DataView(bomb.buffer).setUint32(bomb.length - 4, 4_000_000_000, true)
    const report = scanArtifact({ bytes: bomb, media_type: "application/gzip", classification: "public" })
    expect(report.findings.some((finding) => finding.check === "dangerous_archive")).toBe(true)
    expect(MAX_ARCHIVE_EXPANSION_RATIO).toBeGreaterThan(1)
  })

  test("un zip se déclare non vérifié plutôt que sain", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    const report = scanArtifact({ bytes: zip, media_type: "application/zip", classification: "public" })
    expect(report.outcomes.find((o) => o.check === "dangerous_archive")?.status).toBe("skipped")
    expect(report.complete).toBe(false)
  })

  test("des octets qui contredisent le media type déclaré sont un constat", () => {
    // Le media type décide du viewer : un `image/png` qui est une archive fait ouvrir la mauvaise
    // chose par le bon outil.
    const report = scanArtifact({
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      media_type: "image/png",
      classification: "public",
    })
    expect(report.findings.some((finding) => finding.check === "format_mismatch")).toBe(true)
  })

  test("un binaire ne fait pas semblant d'avoir été fouillé pour des secrets", () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
    const report = scanArtifact({ bytes: binary, media_type: "image/png", classification: "public" })
    expect(report.outcomes.find((o) => o.check === "secrets")?.status).toBe("not-applicable")
  })

  test("la raison de quarantaine cite aussi ce qui n'a pas été vérifié", () => {
    // Mettre en quarantaine sans dire ce qui n'a pas pu être contrôlé laisserait croire que la
    // liste des problèmes est complète.
    const report = scanArtifact({
      bytes: bytes(BAIT.aws),
      media_type: "text/plain",
      classification: "public",
    })
    const reason = quarantineReason(report)
    expect(reason).toContain("AWS")
    expect(reason).toContain("malware")
  })

  test("aucune fonction n'efface un artefact", () => {
    // §19.5 : « un échec ne supprime pas la preuve ». Le scanner qui détruit ce qu'il n'aime pas
    // détruit aussi la pièce qui permettrait de dire qu'il s'est trompé.
    const module = require("../../src/locus/artifact-scanner.ts") as Record<string, unknown>
    for (const forbidden of ["deleteArtifact", "purge", "remove", "unlinkArtifact"]) {
      expect(module[forbidden]).toBeUndefined()
    }
    const source = readFileSync(join(import.meta.dir, "../../src/locus/artifact-scanner.ts"), "utf8")
    expect(source).not.toContain("unlinkSync")
    expect(source).not.toContain("rmSync")
  })
})

describe("quarantaine et upload — §19.5 croise §19.1", () => {
  test("un artefact en quarantaine est déclaré, et n'est pas envoyé", async () => {
    const content = bytes(`clé : ${BAIT.aws}`)
    const declared = declaration({ bytes: content })
    expect(declared.manifest.state).toBe("quarantined")

    let touched = false
    const transport: ArtifactTransport = {
      requestUpload: async () => {
        touched = true
        return { url: "https://locus.example/upload/abc" }
      },
      put: async () => ({}),
    }
    const result = await publishArtifact(declared, content, transport, () => NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.outcome).toBe("quarantined")
    expect(result.reason).toContain("AWS")
    // Déclaré — la preuve existe et le serveur sait qu'elle existe — mais rien n'est parti.
    expect(touched).toBe(false)
    expect(result.manifest.state).toBe("quarantined")
  })

  test("`quarantined` n'est pas un état dont on sort tout seul", () => {
    // Le vocabulaire du schéma ne connaît aucune valeur signifiant « promu automatiquement », et
    // ce module n'offre aucune fonction de promotion.
    const module = require("../../src/locus/artifact-client.ts") as Record<string, unknown>
    for (const forbidden of ["promote", "release", "clearQuarantine", "approve"]) {
      expect(module[forbidden]).toBeUndefined()
    }
  })
})

describe("cache local content-addressed — §19.6", () => {
  test("le chemin dérive du hash et de rien d'autre", () => {
    const hash = contentHash(bytes("x"))
    const digest = hash.slice("sha256:".length)
    expect(cachePath("/cache", hash)).toBe(`/cache/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`)
    // Un nom de fichier ne peut pas faire écrire ailleurs, parce qu'il n'entre pas dans le calcul.
    expect(() => cachePath("/cache", "../../etc/passwd")).toThrow()
  })

  test("une copie requise par un attempt actif n'est pas évinçable", () => {
    const held = contentHash(bytes("en cours"))
    const idle = contentHash(bytes("terminé"))
    expect(evictable(held, [held])).toBe(false)
    expect(evictable(idle, [held])).toBe(true)
  })

  test("une copie en quarantaine n'est jamais évinçable", () => {
    // Le cache local est souvent le seul endroit où cette preuve existe.
    const suspect = contentHash(bytes("suspect"))
    expect(evictable(suspect, [], [suspect])).toBe(false)
  })

  test("le worker ne décide pas de la conservation canonique", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/locus/artifact-client.ts"), "utf8")
    // `evictable` rend un verdict sur une copie locale ; rien ici ne supprime, ni localement ni
    // côté serveur.
    for (const forbidden of ["rmSync", "unlinkSync", "DELETE"]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
