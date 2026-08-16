import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { LocusIdentityUnusable } from "./errors.ts"

/**
 * L'identité persistante du worker — `SPEC_V1.md` §7.1.
 *
 * Une installation possède un `worker_id` stable, une clé privée locale protégée, un état de
 * révocation et une empreinte de runtime. **La clé privée ne quitte jamais la machine** : elle
 * n'est ni rendue par `describeIdentity`, ni journalisée, ni transportée. Ce qui sort d'ici est
 * une signature, jamais la clé qui l'a produite.
 *
 * Le choix du stockage est un fichier à permissions restreintes, pas un trousseau système. Un
 * trousseau serait mieux gardé sur macOS et inexistant ailleurs ; `docs/locus/CLAUDE.md` interdit
 * « toute dépendance implicite à une machine de développeur », et un worker doit s'enrôler
 * identiquement sur un runner Linux sans session graphique. Le fichier est créé en `wx` avec le
 * mode `0600`, comme `src/util/secret-file.ts` le fait déjà en amont pour la même raison.
 */

/** Le nom des deux fichiers. Le second est le seul secret du dépôt à ce stade. */
export const IDENTITY_FILE = "identity.json"
export const PRIVATE_KEY_FILE = "identity.key"

/** Ce qui est public et peut être journalisé, exporté, envoyé. */
export type PublicIdentity = {
  readonly worker_id: string
  readonly worker_kind: "canterel"
  /** Clé publique Ed25519, SPKI en base64. C'est elle que `locusd` vérifie. */
  readonly public_key: string
  readonly created_at: string
  /** Empreinte du runtime — §7.1. Change avec la machine, pas avec l'identité. */
  readonly runtime: string
  /** §7.4. Un worker révoqué garde son identité : il ne l'oublie pas, il la sait révoquée. */
  readonly revoked_at: string | null
}

/** L'identité utilisable en mémoire. `privateKey` ne sort jamais de ce processus. */
export type Identity = {
  readonly public: PublicIdentity
  readonly privateKey: crypto.KeyObject
}

/**
 * L'empreinte de runtime de §7.1.
 *
 * Volontairement grossière — plateforme, architecture, version du moteur. Elle sert à repérer
 * qu'un worker a changé de machine, pas à l'identifier de façon unique : une empreinte fine
 * deviendrait un identifiant matériel transmis à chaque handshake, ce que personne n'a demandé.
 */
export function runtimeFingerprint(): string {
  return `bun/${process.versions["bun"] ?? "?"} ${process.platform}/${process.arch}`
}

function publicKeyOf(privateKey: crypto.KeyObject): string {
  return crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64")
}

/**
 * Charger l'identité, ou la créer si elle n'existe pas.
 *
 * **Ne régénère jamais en silence.** C'est la propriété la plus importante du module : une
 * identité qu'on remplace parce qu'on n'a pas su la relire est une identité perdue, et avec elle
 * tout ce que `locusd` a enregistré sous ce `worker_id` — enrôlement, attestations, historique de
 * manifestes. Une clé illisible, un couple incohérent ou un fichier tronqué produisent une
 * `LocusIdentityUnusable` qui demande une intervention. C'est exactement la posture de
 * `src/util/secret-file.ts` en amont : « refusing to replace it ».
 */
export async function loadOrCreateIdentity(dir: string): Promise<Identity> {
  const existing = await loadIdentity(dir)
  if (existing) return existing
  return createIdentity(dir)
}

/** Charger une identité existante, ou `null` si l'installation n'en a pas encore. */
export async function loadIdentity(dir: string): Promise<Identity | null> {
  const metaPath = path.join(dir, IDENTITY_FILE)
  const keyPath = path.join(dir, PRIVATE_KEY_FILE)

  const rawMeta = await fs.readFile(metaPath, "utf8").catch(() => null)
  const rawKey = await fs.readFile(keyPath, "utf8").catch(() => null)

  // Aucun des deux : installation neuve, cas normal.
  if (rawMeta === null && rawKey === null) return null

  // Un seul des deux : à moitié écrite, ou à moitié effacée. Créer par-dessus donnerait une
  // identité neuve qui hérite silencieusement de l'emplacement de l'ancienne.
  if (rawMeta === null || rawKey === null) {
    throw new LocusIdentityUnusable({
      path: rawMeta === null ? metaPath : keyPath,
      reason: "identité incomplète : un des deux fichiers manque, refus d'en fabriquer une nouvelle par-dessus",
    })
  }

  const meta = parseIdentityFile(rawMeta, metaPath)

  const privateKey = readPrivateKey(rawKey, keyPath)

  // Le couple doit être cohérent. Une clé publique enregistrée qui ne correspond pas à la clé
  // privée présente signerait des messages que `locusd` rejetterait, avec un message d'erreur
  // parlant de signature invalide plutôt que du vrai problème.
  const derived = publicKeyOf(privateKey)
  if (derived !== meta.public_key) {
    throw new LocusIdentityUnusable({
      path: dir,
      reason: "la clé privée ne correspond pas à la clé publique enregistrée",
    })
  }

  return { public: meta, privateKey }
}

function parseIdentityFile(raw: string, where: string): PublicIdentity {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      throw new LocusIdentityUnusable({ path: where, reason: "JSON illisible" })
    }
  })()

  if (typeof parsed !== "object" || parsed === null) {
    throw new LocusIdentityUnusable({ path: where, reason: "attendu un objet" })
  }
  const record = parsed as Record<string, unknown>
  for (const field of ["worker_id", "public_key", "created_at", "runtime"]) {
    if (typeof record[field] !== "string") {
      throw new LocusIdentityUnusable({ path: where, reason: `champ \`${field}\` absent ou non textuel` })
    }
  }
  return {
    worker_id: record["worker_id"] as string,
    worker_kind: "canterel",
    public_key: record["public_key"] as string,
    created_at: record["created_at"] as string,
    runtime: record["runtime"] as string,
    revoked_at: typeof record["revoked_at"] === "string" ? record["revoked_at"] : null,
  }
}

function readPrivateKey(raw: string, where: string): crypto.KeyObject {
  try {
    return crypto.createPrivateKey({ key: raw, format: "pem", type: "pkcs8" })
  } catch {
    throw new LocusIdentityUnusable({ path: where, reason: "clé privée illisible" })
  }
}

/**
 * Créer une identité neuve.
 *
 * La clé privée est écrite en **création exclusive** (`wx`) avec le mode `0600` et synchronisée
 * avant d'être publiée. L'exclusivité n'est pas une précaution théorique : deux processus qui
 * démarrent ensemble sur une installation neuve écriraient sinon deux identités, et la seconde
 * gagnerait sans que la première le sache.
 */
export async function createIdentity(dir: string): Promise<Identity> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  const { privateKey } = crypto.generateKeyPairSync("ed25519")
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const keyPath = path.join(dir, PRIVATE_KEY_FILE)

  const handle = await fs.open(keyPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return undefined
    throw error
  })
  if (!handle) {
    // Quelqu'un d'autre a gagné la course. Relire est la bonne réponse — écraser serait perdre
    // l'identité de l'autre processus.
    const raced = await loadIdentity(dir)
    if (raced) return raced
    throw new LocusIdentityUnusable({
      path: keyPath,
      reason: "une clé existe déjà mais aucune identité complète ne se laisse relire",
    })
  }

  try {
    await handle.writeFile(pem)
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  await fs.chmod(keyPath, 0o600)

  const identity: PublicIdentity = {
    worker_id: `canterel-${crypto.randomUUID()}`,
    worker_kind: "canterel",
    public_key: publicKeyOf(privateKey),
    created_at: new Date().toISOString(),
    runtime: runtimeFingerprint(),
    revoked_at: null,
  }
  await writeIdentityFile(dir, identity)
  return { public: identity, privateKey }
}

async function writeIdentityFile(dir: string, identity: PublicIdentity): Promise<void> {
  const target = path.join(dir, IDENTITY_FILE)
  // Écriture par fichier temporaire puis renommage : une identité à moitié écrite serait
  // exactement le cas que `loadIdentity` refuse de réparer tout seul.
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, target)
}

/**
 * Marquer l'identité révoquée — §7.4.
 *
 * Le worker **garde** son identité : il ne l'oublie pas, il la sait révoquée. L'effacer le ferait
 * repartir avec un `worker_id` neuf au prochain démarrage, c'est-à-dire contourner la révocation
 * en redémarrant.
 */
export async function revokeIdentity(dir: string, at = new Date()): Promise<PublicIdentity> {
  const identity = await loadIdentity(dir)
  if (!identity) {
    throw new LocusIdentityUnusable({ path: dir, reason: "aucune identité à révoquer" })
  }
  const revoked: PublicIdentity = { ...identity.public, revoked_at: at.toISOString() }
  await writeIdentityFile(dir, revoked)
  return revoked
}

/** Vrai si l'identité est révoquée. §7.4 : plus de mission, plus de renouvellement de lease. */
export function isRevoked(identity: PublicIdentity): boolean {
  return identity.revoked_at !== null
}

/**
 * Signer une charge avec la clé privée du worker — §8.2 (`nonce` et signature du handshake).
 *
 * C'est la seule sortie de la clé : une signature. Rien dans ce module ne rend la clé elle-même.
 */
export function sign(identity: Identity, payload: string | Buffer): string {
  return crypto.sign(null, bytes(payload), identity.privateKey).toString("base64")
}

/** `Buffer.from` n'a pas de surcharge pour l'union ; le détour explicite vaut mieux qu'un cast. */
function bytes(payload: string | Buffer): Buffer {
  return typeof payload === "string" ? Buffer.from(payload, "utf8") : payload
}

/** Vérifier une signature avec une clé publique SPKI base64 — l'inverse de `sign`, pour les tests et les pairs. */
export function verify(publicKeyBase64: string, payload: string | Buffer, signature: string): boolean {
  const key = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  })
  return crypto.verify(null, bytes(payload), key, Buffer.from(signature, "base64"))
}

/**
 * Le rendu affichable d'une identité.
 *
 * Rend la partie publique et **rien d'autre** : le type le garantit déjà, mais le point de passage
 * existe pour la même raison que `describeConfig` — que la promesse « la clé privée ne quitte
 * jamais la machine » ait un seul endroit où être tenue.
 */
export function describeIdentity(identity: Identity | PublicIdentity): PublicIdentity {
  return "public" in identity ? identity.public : identity
}
