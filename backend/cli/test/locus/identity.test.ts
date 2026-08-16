import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  IDENTITY_FILE,
  PRIVATE_KEY_FILE,
  createIdentity,
  describeIdentity,
  isRevoked,
  loadIdentity,
  loadOrCreateIdentity,
  revokeIdentity,
  sign,
  verify,
} from "../../src/locus/identity.ts"
import {
  assertEndpointAcceptable,
  enroll,
  forgetCredential,
  isActionAllowed,
  loadCredential,
  sameOrigin,
  saveCredential,
  type EnrollmentTransport,
} from "../../src/locus/auth.ts"
import { LocusEnrollmentRefused, LocusIdentityUnusable, LocusServerRejected } from "../../src/locus/errors.ts"

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "locus-identity-"))
}

describe("identité persistante — le test de sortie de W2.4", () => {
  test("un redémarrage retrouve le même worker_id et la même clé", async () => {
    const dir = scratch()
    const first = await loadOrCreateIdentity(dir)

    // « Redémarrage » : rien n'est gardé en mémoire, tout est relu depuis le disque.
    const second = await loadOrCreateIdentity(dir)

    expect(second.public.worker_id).toBe(first.public.worker_id)
    expect(second.public.public_key).toBe(first.public.public_key)
    expect(second.public.created_at).toBe(first.public.created_at)

    // Et la clé relue est réellement la même : une signature faite après « redémarrage » se
    // vérifie avec la clé publique d'avant. Comparer les chaînes ne prouverait que l'égalité des
    // fichiers, pas celle des clés.
    const signature = sign(second, "handshake")
    expect(verify(first.public.public_key, "handshake", signature)).toBe(true)
  })

  test("deux installations distinctes ont deux identités distinctes", async () => {
    const a = await loadOrCreateIdentity(scratch())
    const b = await loadOrCreateIdentity(scratch())
    expect(a.public.worker_id).not.toBe(b.public.worker_id)
    expect(a.public.public_key).not.toBe(b.public.public_key)
  })

  test("une signature ne se vérifie pas avec la mauvaise clé, ni sur une charge modifiée", async () => {
    const a = await loadOrCreateIdentity(scratch())
    const b = await loadOrCreateIdentity(scratch())
    const signature = sign(a, "mission-42")
    expect(verify(a.public.public_key, "mission-42", signature)).toBe(true)
    expect(verify(b.public.public_key, "mission-42", signature)).toBe(false)
    expect(verify(a.public.public_key, "mission-43", signature)).toBe(false)
  })
})

describe("la clé privée est protégée et ne sort pas", () => {
  test("le fichier de clé est en 0600", async () => {
    const dir = scratch()
    await createIdentity(dir)
    const mode = statSync(join(dir, PRIVATE_KEY_FILE)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("le rendu affichable ne contient pas la clé privée", async () => {
    const dir = scratch()
    const identity = await createIdentity(dir)
    const rendered = JSON.stringify(describeIdentity(identity))
    expect(rendered).not.toContain("PRIVATE KEY")
    expect(rendered).toContain(identity.public.public_key)
  })

  test("le fichier d'identité public ne contient pas la clé privée", async () => {
    const dir = scratch()
    await createIdentity(dir)
    const meta = readFileSync(join(dir, IDENTITY_FILE), "utf8")
    expect(meta).not.toContain("PRIVATE KEY")
  })
})

describe("jamais de régénération silencieuse", () => {
  test("une clé illisible est refusée, pas remplacée", async () => {
    const dir = scratch()
    const original = await createIdentity(dir)
    writeFileSync(join(dir, PRIVATE_KEY_FILE), "ceci n'est pas une clé", { mode: 0o600 })

    // Remplacer donnerait un worker_id neuf et orphelinerait tout ce que `locusd` a enregistré
    // sous l'ancien — enrôlement, attestations, historique de manifestes.
    await expect(loadOrCreateIdentity(dir)).rejects.toThrow()
    expect(readFileSync(join(dir, IDENTITY_FILE), "utf8")).toContain(original.public.worker_id)
  })

  test("une identité à moitié présente est refusée, dans les deux sens", async () => {
    const withKeyOnly = scratch()
    await createIdentity(withKeyOnly)
    rmSync(join(withKeyOnly, IDENTITY_FILE))
    // La clé seule : créer par-dessus donnerait une identité neuve qui hérite silencieusement de
    // l'emplacement de l'ancienne.
    await expect(loadOrCreateIdentity(withKeyOnly)).rejects.toThrow()

    // Les métadonnées seules — le sens que le premier test manquait, et le plus dangereux : rien
    // n'empêche techniquement d'écrire une clé neuve à côté, ce qui écraserait le `worker_id`
    // enregistré par une identité neuve sans que personne ne s'en aperçoive. Trouvé en mutant
    // `loadOrCreateIdentity` pour qu'il retombe sur la création en cas d'erreur : la suite restait
    // verte, donc elle ne couvrait pas ce chemin.
    const withMetaOnly = scratch()
    const original = await createIdentity(withMetaOnly)
    rmSync(join(withMetaOnly, PRIVATE_KEY_FILE))
    await expect(loadOrCreateIdentity(withMetaOnly)).rejects.toThrow()
    expect(readFileSync(join(withMetaOnly, IDENTITY_FILE), "utf8")).toContain(original.public.worker_id)
  })

  test("un couple incohérent est refusé avec la vraie raison", async () => {
    const dir = scratch()
    const other = await createIdentity(scratch())
    await createIdentity(dir)
    // La clé publique enregistrée ne correspond plus à la clé privée présente. Laisser passer
    // ferait signer des messages que `locusd` rejetterait en parlant de signature invalide,
    // plutôt que du vrai problème.
    const meta = JSON.parse(readFileSync(join(dir, IDENTITY_FILE), "utf8")) as Record<string, unknown>
    meta["public_key"] = other.public.public_key
    writeFileSync(join(dir, IDENTITY_FILE), JSON.stringify(meta))

    try {
      await loadIdentity(dir)
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusIdentityUnusable.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusIdentityUnusable>).data.reason).toContain("ne correspond pas")
    }
  })

  test("un répertoire neuf n'est pas une erreur", async () => {
    expect(await loadIdentity(scratch())).toBeNull()
  })
})

describe("révocation — §7.4", () => {
  test("un worker révoqué garde son identité", async () => {
    const dir = scratch()
    const before = await loadOrCreateIdentity(dir)
    const revoked = await revokeIdentity(dir)

    // L'effacer le ferait repartir avec un worker_id neuf au prochain démarrage, c'est-à-dire
    // contourner la révocation en redémarrant.
    expect(revoked.worker_id).toBe(before.public.worker_id)
    expect(isRevoked(revoked)).toBe(true)
    const reloaded = await loadOrCreateIdentity(dir)
    expect(reloaded.public.worker_id).toBe(before.public.worker_id)
    expect(isRevoked(reloaded.public)).toBe(true)
  })

  test("ce qui reste permis est énuméré, pas déduit", async () => {
    // Une liste d'interdits oublie toujours l'action ajoutée le mois suivant, et l'oubli penche
    // du mauvais côté.
    expect(isActionAllowed(false, "accept-mission")).toBe(true)
    expect(isActionAllowed(true, "accept-mission")).toBe(false)
    expect(isActionAllowed(true, "renew-lease")).toBe(false)
    expect(isActionAllowed(true, "upload-closing-logs")).toBe(true)
    // Une action inventée après coup est refusée à un worker révoqué, sans que personne ait pensé
    // à l'interdire.
    expect(isActionAllowed(true, "action-ajoutee-plus-tard")).toBe(false)
  })

  test("un worker révoqué ne peut pas se réenrôler", async () => {
    const dir = scratch()
    await loadOrCreateIdentity(dir)
    await revokeIdentity(dir)
    const identity = await loadOrCreateIdentity(dir)
    await expect(
      enroll({
        identity,
        endpoint: "https://locus.example",
        token: "t-1",
        transport: async () => ({ credential: "c" }),
      }),
    ).rejects.toThrow()
  })
})

describe("authentification du serveur — §7.3", () => {
  test("TLS est obligatoire hors boucle locale", () => {
    expect(assertEndpointAcceptable("https://locus.example").protocol).toBe("https:")
    expect(assertEndpointAcceptable("http://127.0.0.1:7420").hostname).toBe("127.0.0.1")
    expect(() => assertEndpointAcceptable("http://locus.example")).toThrow()
  })

  test("« localhost » n'est pas une boucle locale", () => {
    // Un nom résolu par DNS peut désigner autre chose que la machine locale, et c'est précisément
    // la faille qu'une exception « pour le local » ouvre d'habitude. Seuls les littéraux passent.
    expect(() => assertEndpointAcceptable("http://localhost:7420")).toThrow()
    expect(assertEndpointAcceptable("http://[::1]:7420").protocol).toBe("http:")
  })

  test("un schéma exotique est refusé avec sa raison", () => {
    try {
      assertEndpointAcceptable("file:///etc/passwd")
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusServerRejected.isInstance(error)).toBe(true)
    }
    expect(() => assertEndpointAcceptable("pas une url")).toThrow()
  })

  test("l'origine se compare sur le triplet, pas sur la chaîne", () => {
    expect(sameOrigin("https://x/a", "https://x/b")).toBe(true)
    expect(sameOrigin("https://x:443/", "https://x/")).toBe(true)
    expect(sameOrigin("https://x", "https://y")).toBe(false)
    expect(sameOrigin("https://x", "http://x")).toBe(false)
  })
})

describe("enrôlement — §7.2", () => {
  const transportOf = (answer: unknown, seen: { request?: unknown } = {}): EnrollmentTransport => {
    return async (request) => {
      seen.request = request
      return answer
    }
  }

  test("la demande est signée et vérifiable par le serveur", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    const seen: { request?: unknown } = {}
    await enroll({
      identity,
      endpoint: "https://locus.example",
      token: "enrol-123",
      nonce: "nonce-fixe",
      transport: transportOf({ credential: "cred-1" }, seen),
    })
    const request = seen.request as Record<string, string>
    // Le nonce est signé avec l'identité ET le endpoint : une demande capturée ne peut être
    // rejouée ni vers un autre serveur, ni resservie au même.
    const signed = `${identity.public.worker_id}\nhttps://locus.example\nnonce-fixe`
    expect(verify(identity.public.public_key, signed, request["signature"] as string)).toBe(true)
    expect(
      verify(
        identity.public.public_key,
        `${identity.public.worker_id}\nhttps://ailleurs\nnonce-fixe`,
        request["signature"] as string,
      ),
    ).toBe(false)
  })

  test("le token d'enrôlement n'atteint jamais le disque", async () => {
    // §7.2 : un token « ne devient pas le secret permanent du worker ». Ce qui est persisté est la
    // créance rendue par le serveur ; le token meurt avec le processus.
    const dir = scratch()
    const identity = await loadOrCreateIdentity(dir)
    const credential = await enroll({
      identity,
      endpoint: "https://locus.example",
      token: "TOKEN-ULTRA-SECRET",
      transport: transportOf({ credential: "cred-1", scope: ["run"], labels: ["gpu"] }),
    })
    await saveCredential(dir, credential)

    for (const name of readdirSync(dir)) {
      const body = readFileSync(join(dir, name), "utf8")
      expect(body).not.toContain("TOKEN-ULTRA-SECRET")
    }
  })

  test("la créance est persistée en 0600 et se relit", async () => {
    const dir = scratch()
    const identity = await loadOrCreateIdentity(dir)
    const credential = await enroll({
      identity,
      endpoint: "https://locus.example",
      token: "t",
      transport: transportOf({ credential: "cred-1", scope: ["run"], labels: ["gpu"] }),
    })
    await saveCredential(dir, credential)
    expect(statSync(join(dir, "credential.json")).mode & 0o777).toBe(0o600)

    const reloaded = await loadCredential(dir)
    expect(reloaded?.credential).toBe("cred-1")
    expect(reloaded?.scope).toEqual(["run"])
    expect(reloaded?.labels).toEqual(["gpu"])

    await forgetCredential(dir)
    expect(await loadCredential(dir)).toBeNull()
    // Oublier la créance n'oublie pas l'identité — sans quoi un redémarrage contournerait §7.4.
    expect((await loadIdentity(dir))?.public.worker_id).toBe(identity.public.worker_id)
  })

  test("une créance émise pour un autre worker est refusée", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    // Accepter ferait persister sous notre chemin une créance appartenant à une autre identité.
    await expect(
      enroll({
        identity,
        endpoint: "https://locus.example",
        token: "t",
        transport: transportOf({ credential: "c", worker_id: "canterel-quelquun-dautre" }),
      }),
    ).rejects.toThrow()
  })

  test("un endpoint inacceptable est refusé avant tout envoi", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    let called = false
    await expect(
      enroll({
        identity,
        endpoint: "http://locus.example",
        token: "t",
        transport: async () => {
          called = true
          return { credential: "c" }
        },
      }),
    ).rejects.toThrow()
    // « Avant tout envoi » est la propriété : le token ne part pas vers un serveur non vérifié.
    expect(called).toBe(false)
  })

  test("une réponse vide ou sans créance est un refus structuré", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    for (const answer of [null, {}, { credential: "" }]) {
      try {
        await enroll({ identity, endpoint: "https://l.example", token: "t", transport: transportOf(answer) })
        throw new Error("aurait dû refuser")
      } catch (error) {
        expect(LocusEnrollmentRefused.isInstance(error)).toBe(true)
      }
    }
  })

  test("un transport en panne devient un refus nommé, pas une exception brute", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    try {
      await enroll({
        identity,
        endpoint: "https://l.example",
        token: "t",
        transport: async () => {
          throw new Error("ECONNREFUSED")
        },
      })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusEnrollmentRefused.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusEnrollmentRefused>).data.reason).toContain("ECONNREFUSED")
    }
  })

  test("un token vide est refusé sans appeler le transport", async () => {
    const identity = await loadOrCreateIdentity(scratch())
    let called = false
    await expect(
      enroll({
        identity,
        endpoint: "https://l.example",
        token: "   ",
        transport: async () => {
          called = true
          return { credential: "c" }
        },
      }),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })
})
