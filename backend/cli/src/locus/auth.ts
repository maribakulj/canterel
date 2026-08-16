import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { LocusEnrollmentRefused, LocusServerRejected } from "./errors.ts"
import { isRevoked, sign, type Identity } from "./identity.ts"

/**
 * Enrôlement, authentification du serveur et révocation — `SPEC_V1.md` §7.2 à §7.4.
 *
 * Le transport est un **port injecté**, pas un client HTTP écrit ici. `locusd` n'existe pas encore
 * (W2.5 apporte `connection.ts`), et `docs/locus/CLAUDE.md` demande les interfaces avant le
 * branchement. Conséquence utile : tout ce module se teste sans réseau, y compris ses refus.
 */

/** Le nom du fichier qui garde la créance obtenue à l'enrôlement. */
export const CREDENTIAL_FILE = "credential.json"

/**
 * Ce que le serveur rend en échange d'un enrôlement réussi.
 *
 * Ce n'est **pas** le token d'enrôlement : §7.2 dit qu'un token « ne devient pas le secret
 * permanent du worker ». Le token est court-terme, à usage unique, et disparaît avec le processus.
 */
export type Credential = {
  readonly worker_id: string
  /** Créance renouvelable délivrée par `locusd`. */
  readonly credential: string
  readonly issued_at: string
  readonly expires_at: string | null
  /** Le scope imposé par le token (§7.2 : « possède un scope »). */
  readonly scope: readonly string[]
  /** Les labels que l'enrôlement impose, le cas échéant. */
  readonly labels: readonly string[]
}

/** La demande signée envoyée au serveur — la forme de §8.2 en réduction. */
export type EnrollmentRequest = {
  readonly worker_id: string
  readonly worker_kind: "canterel"
  readonly public_key: string
  readonly runtime: string
  readonly nonce: string
  readonly signature: string
  /** Le token, transporté une fois et jamais persisté. */
  readonly enrollment_token: string
}

/** Le port de transport. Injecté, jamais construit ici. */
export type EnrollmentTransport = (request: EnrollmentRequest) => Promise<unknown>

/**
 * Vérifier qu'un endpoint est acceptable avant de lui parler — §7.3.
 *
 * « En mode non local, TLS est obligatoire. Les certificats invalides, les redirections et
 * changements d'origine sont refusés par défaut. » Ce qui se décide ici est la moitié qu'on peut
 * décider sans réseau : le schéma et l'origine. Le reste — validité du certificat, refus de
 * suivre une redirection — appartient au transport de W2.5, et cette fonction existe pour qu'il
 * ait une politique à appliquer plutôt qu'à inventer.
 *
 * `http://` n'est toléré que vers une boucle locale. La tolérance est étroite exprès : « localhost »
 * résolu par DNS peut pointer ailleurs, donc seules les adresses de bouclage littérales passent.
 */
export function assertEndpointAcceptable(endpoint: string): URL {
  const url = (() => {
    try {
      return new URL(endpoint)
    } catch {
      throw new LocusServerRejected({ endpoint, reason: "URL illisible" })
    }
  })()

  if (url.protocol === "https:") return url

  if (url.protocol !== "http:") {
    throw new LocusServerRejected({ endpoint, reason: `schéma ${url.protocol} refusé` })
  }
  if (!isLoopback(url.hostname)) {
    throw new LocusServerRejected({
      endpoint,
      reason: "TLS obligatoire hors boucle locale (§7.3)",
    })
  }
  return url
}

function isLoopback(hostname: string): boolean {
  // Littéraux seulement : un nom résolu par DNS peut désigner autre chose que la machine locale,
  // et c'est précisément la faille qu'une exception « pour le local » ouvre d'habitude.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  return bare === "127.0.0.1" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare)
}

/**
 * Vrai si deux endpoints ont la même origine — §7.3, « changements d'origine refusés ».
 *
 * Comparé sur le triplet schéma/hôte/port, jamais sur la chaîne : `https://x:443/` et `https://x/`
 * sont la même origine, et les traiter comme deux origines ferait crier la politique sur un
 * changement qui n'en est pas un.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * S'enrôler auprès de `locusd` — §7.2.
 *
 * Le token est un **paramètre**, jamais un champ de configuration et jamais écrit sur le disque.
 * §7.2 : court-terme, scopé, non réutilisable, et il « ne devient pas le secret permanent du
 * worker ». Ce qui est persisté est la créance rendue par le serveur ; le token meurt avec le
 * processus.
 *
 * L'enrôlement est **explicite** : cette fonction n'est appelée par aucun chemin automatique.
 */
export async function enroll(input: {
  readonly identity: Identity
  readonly endpoint: string
  readonly token: string
  readonly transport: EnrollmentTransport
  readonly nonce?: string
}): Promise<Credential> {
  if (isRevoked(input.identity.public)) {
    throw new LocusEnrollmentRefused({ reason: "identité révoquée (§7.4)" })
  }
  if (input.token.trim().length === 0) {
    throw new LocusEnrollmentRefused({ reason: "token d'enrôlement vide" })
  }
  assertEndpointAcceptable(input.endpoint)

  // Le nonce est signé avec l'identité et le endpoint : une demande capturée ne peut pas être
  // rejouée vers un autre serveur, ni resservie au même.
  const nonce = input.nonce ?? crypto.randomBytes(16).toString("base64")
  const signed = `${input.identity.public.worker_id}\n${input.endpoint}\n${nonce}`

  const request: EnrollmentRequest = {
    worker_id: input.identity.public.worker_id,
    worker_kind: "canterel",
    public_key: input.identity.public.public_key,
    runtime: input.identity.public.runtime,
    nonce,
    signature: sign(input.identity, signed),
    enrollment_token: input.token,
  }

  const answer = await input.transport(request).catch((error: unknown) => {
    throw new LocusEnrollmentRefused({
      reason: `transport en échec : ${error instanceof Error ? error.message : String(error)}`,
    })
  })

  return parseCredential(answer, input.identity.public.worker_id)
}

function parseCredential(answer: unknown, expectedWorker: string): Credential {
  if (typeof answer !== "object" || answer === null) {
    throw new LocusEnrollmentRefused({ reason: "réponse d'enrôlement illisible" })
  }
  const record = answer as Record<string, unknown>
  const credential = record["credential"]
  if (typeof credential !== "string" || credential.length === 0) {
    throw new LocusEnrollmentRefused({ reason: "réponse sans créance" })
  }
  // Le serveur ne peut pas enrôler quelqu'un d'autre à notre place. Accepter un `worker_id`
  // différent ferait persister sous notre chemin une créance appartenant à une autre identité.
  const worker = record["worker_id"]
  if (typeof worker === "string" && worker !== expectedWorker) {
    throw new LocusEnrollmentRefused({
      reason: `créance émise pour ${worker}, attendue pour ${expectedWorker}`,
    })
  }
  return {
    worker_id: expectedWorker,
    credential,
    issued_at: typeof record["issued_at"] === "string" ? record["issued_at"] : new Date().toISOString(),
    expires_at: typeof record["expires_at"] === "string" ? record["expires_at"] : null,
    scope: readStrings(record["scope"]),
    labels: readStrings(record["labels"]),
  }
}

function readStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

/** Écrire la créance, en `0600` comme la clé privée : c'en est un secret au même titre. */
export async function saveCredential(dir: string, credential: Credential): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, CREDENTIAL_FILE)
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, target)
  await fs.chmod(target, 0o600)
}

/** Relire la créance, ou `null` si le worker ne s'est jamais enrôlé. */
export async function loadCredential(dir: string): Promise<Credential | null> {
  const raw = await fs.readFile(path.join(dir, CREDENTIAL_FILE), "utf8").catch(() => null)
  if (raw === null) return null
  try {
    return parseCredential(JSON.parse(raw), (JSON.parse(raw) as Record<string, string>)["worker_id"] ?? "")
  } catch {
    return null
  }
}

/**
 * Effacer la créance locale — la moitié locale de §7.4.
 *
 * L'identité, elle, **survit** : `revokeIdentity` la marque au lieu de l'effacer, sans quoi un
 * simple redémarrage donnerait un `worker_id` neuf et contournerait la révocation.
 */
export async function forgetCredential(dir: string): Promise<void> {
  await fs.rm(path.join(dir, CREDENTIAL_FILE), { force: true })
}

/** Ce qu'un worker révoqué a encore le droit de faire — §7.4, énuméré plutôt que supposé. */
export const REVOKED_ALLOWED_ACTIONS: readonly string[] = ["upload-closing-logs"]

/**
 * Décider si une action est permise à ce worker.
 *
 * Énumérer ce qui reste permis plutôt que ce qui est interdit : une liste d'interdits oublie
 * toujours l'action ajoutée le mois suivant, et l'oubli penche du mauvais côté.
 */
export function isActionAllowed(revoked: boolean, action: string): boolean {
  if (!revoked) return true
  return REVOKED_ALLOWED_ACTIONS.includes(action)
}
