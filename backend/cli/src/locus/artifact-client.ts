import { createHash } from "node:crypto"

import { assertEndpointAcceptable } from "./auth.ts"
import { LocusArtifactRejected } from "./errors.ts"
import { quarantineReason, scanArtifact, type ScanReport, type ScannerTools } from "./artifact-scanner.ts"
import type { ArtifactManifest, ContentHash, DataClass } from "./lep/generated.ts"

/**
 * Le client d'artefacts — `SPEC_V1.md` §19.
 *
 * §19.1 tient en une ligne, et l'ordre y est tout :
 *
 * ```text
 * artifact.declared → URL temporaire → upload → vérification → artifact.uploaded
 * ```
 *
 * Déclarer **avant** d'uploader veut dire que le hash est une promesse faite quand personne ne
 * sait encore ce qui arrivera à l'autre bout. La vérification compare cette promesse à ce qui a
 * été reçu. Inverser les deux — hasher ce que le serveur confirme avoir reçu, ou redéclarer après
 * coup — produirait une vérification qui ne peut jamais échouer, donc pas une vérification.
 *
 * Trois conséquences, écrites ici plutôt que laissées à la discipline de l'appelant :
 *
 *  1. **Aucun chemin ne réécrit le hash déclaré.** Il n'existe pas de fonction pour ça.
 *  2. Un hash reçu qui diffère fait **rejeter**, et ne fait pas retenter avec la nouvelle valeur.
 *  3. Sans preuve de réception, `artifact.uploaded` n'est pas émis. §19.1 place la vérification
 *     *avant* l'événement ; l'émettre quand même transformerait « je crois » en « c'est fait ».
 */

/** Les algorithmes de hash acceptés, avec la longueur de digest qui les identifie. */
export const HASH_ALGORITHMS: Readonly<Record<string, number>> = { sha256: 64, sha512: 128 }

export const DEFAULT_HASH_ALGORITHM = "sha256"

/**
 * Le hash d'un contenu, préfixé par son algorithme.
 *
 * Le préfixe n'est pas décoratif : « un hash nu ne dit pas comment le recalculer, et une
 * vérification d'intégrité qui devine son algorithme n'en est pas une » — le vocabulaire des
 * schémas le dit pour `ContentHash`, et le respecter des deux côtés du fil est tout l'intérêt.
 */
export function contentHash(bytes: Uint8Array, algorithm: string = DEFAULT_HASH_ALGORITHM): ContentHash {
  if (!(algorithm in HASH_ALGORITHMS)) throw new TypeError(`algorithme de hash inconnu : ${algorithm}`)
  return `${algorithm}:${createHash(algorithm).update(bytes).digest("hex")}`
}

export type ParsedHash = { readonly algorithm: string; readonly digest: string }

/**
 * Lire un `ContentHash`, ou dire pourquoi il n'en est pas un.
 *
 * La longueur est vérifiée **par algorithme** : un digest tronqué est la forme que prend une
 * intégrité cassée, et il ressemble en tout point à un digest valide tant que personne ne compte.
 */
export function parseHash(value: string): ParsedHash | null {
  const separator = value.indexOf(":")
  if (separator <= 0) return null
  const algorithm = value.slice(0, separator).toLowerCase()
  const digest = value.slice(separator + 1).toLowerCase()
  const expected = HASH_ALGORITHMS[algorithm]
  if (expected === undefined || digest.length !== expected) return null
  if (!/^[0-9a-f]+$/.test(digest)) return null
  return { algorithm, digest }
}

/**
 * Deux hashes désignent-ils le même contenu.
 *
 * Normalise la casse — `SHA256:AB…` et `sha256:ab…` sont le même hash, et les traiter comme deux
 * ferait rejeter un upload correct. Un hash illisible ne « ressemble » à rien : `false`, et
 * l'appelant en fait un rejet, jamais une égalité par défaut.
 */
export function sameHash(left: string, right: string): boolean {
  const a = parseHash(left)
  const b = parseHash(right)
  if (a === null || b === null) return false
  return a.algorithm === b.algorithm && a.digest === b.digest
}

/** L'URL temporaire de §19.1, telle que le serveur la rend. */
export type UploadTicket = {
  readonly url: string
  readonly expires_at?: string
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Ce que le serveur dit avoir reçu.
 *
 * `received_hash` est facultatif dans le type parce qu'un serveur peut ne pas le renvoyer — pas
 * parce que son absence serait acceptable. Le client la traite comme une vérification manquante,
 * et refuse de conclure.
 */
export type UploadReceipt = {
  readonly received_hash?: string
  readonly size_bytes?: number
}

/** Le transport d'artefacts. Port pur : ni HTTP, ni disque, ni horloge ne sont supposés ici. */
export type ArtifactTransport = {
  readonly requestUpload: (manifest: ArtifactManifest) => Promise<UploadTicket>
  readonly put: (ticket: UploadTicket, bytes: Uint8Array) => Promise<UploadReceipt>
}

export type DeclareInput = {
  readonly artifact_id: string
  readonly bytes: Uint8Array
  readonly media_type: string
  readonly filename?: string
  readonly classification: DataClass
  readonly produced_by: ArtifactManifest["produced_by"]
  readonly allowed_classes?: readonly DataClass[]
  readonly tools?: ScannerTools
  readonly derived_from?: ArtifactManifest["derived_from"]
  readonly now?: () => Date
}

export type Declaration = {
  readonly manifest: ArtifactManifest
  readonly scan: ScanReport
}

/**
 * Déclarer un artefact — la première étape de §19.1.
 *
 * Le hash et la taille sont **calculés ici**, sur les octets, jamais repris d'un appelant : une
 * déclaration dont le hash vient d'ailleurs promet quelque chose que ce module n'a pas vu.
 *
 * Le scan a lieu avant la déclaration parce que son résultat entre dans le manifest (§19.2). Un
 * artefact dont le scan a trouvé quelque chose est déclaré en `quarantined` : il est déclaré —
 * l'effacer ou le taire supprimerait la preuve, ce que §19.5 interdit — mais il n'ira pas plus
 * loin.
 */
export function declareArtifact(input: DeclareInput): Declaration {
  const scan = scanArtifact({
    bytes: input.bytes,
    media_type: input.media_type,
    filename: input.filename,
    classification: input.classification,
    allowed_classes: input.allowed_classes,
    tools: input.tools,
  })
  const at = (input.now ?? (() => new Date()))().toISOString()

  const manifest: ArtifactManifest = {
    artifact_id: input.artifact_id,
    content_hash: contentHash(input.bytes),
    media_type: input.media_type,
    size_bytes: input.bytes.length,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    produced_by: input.produced_by,
    classification: input.classification,
    ...(input.derived_from === undefined ? {} : { derived_from: input.derived_from }),
    state: scan.verdict === "clean" ? "declared" : "quarantined",
    declared_at: at,
  }
  return { manifest, scan }
}

/**
 * Les issues de §19.1, nommées.
 *
 * Chacune dit ce qui a été prouvé, pas seulement ce qui a échoué : `quarantined` sait que le
 * contenu est intact et refusé pour autre chose, `unverified` sait que les octets sont partis sans
 * preuve de réception. Les confondre sous un seul `false` ferait perdre l'information qui décide
 * quoi faire ensuite.
 */
export type PublishResult =
  | { readonly ok: true; readonly manifest: ArtifactManifest; readonly receipt: UploadReceipt }
  | {
      readonly ok: false
      readonly outcome: "quarantined"
      readonly manifest: ArtifactManifest
      readonly reason: string
    }
  | {
      readonly ok: false
      readonly outcome: "unverified"
      readonly manifest: ArtifactManifest
      readonly reason: string
    }

/**
 * Le parcours complet de §19.1.
 *
 * Le rejet est une **erreur levée**, pas une valeur de retour, et c'est délibéré : les deux autres
 * issues laissent une suite possible — un artefact en quarantaine attend une revue, un upload non
 * vérifié attend un nouvel essai — alors qu'un hash qui ne correspond pas ne laisse rien à tenter.
 * Le rendre comme une valeur inviterait un appelant à l'ignorer d'un `if (!result.ok) continue`.
 */
export async function publishArtifact(
  declaration: Declaration,
  bytes: Uint8Array,
  transport: ArtifactTransport,
  now: () => Date = () => new Date(),
): Promise<PublishResult> {
  const { manifest, scan } = declaration

  if (scan.verdict !== "clean") {
    // §19.5 : la preuve reste, et n'est pas envoyée. Le manifest déjà déclaré dit pourquoi.
    return { ok: false, outcome: "quarantined", manifest, reason: quarantineReason(scan) }
  }

  // Les octets ont pu changer entre la déclaration et l'envoi — c'est le cas ordinaire d'un worker
  // qui écrit encore dans le fichier qu'il vient de déclarer. Vérifier ici coûte un hash et évite
  // d'envoyer un contenu que la promesse ne couvre pas.
  const outgoing = contentHash(bytes, parseHash(manifest.content_hash)?.algorithm ?? DEFAULT_HASH_ALGORITHM)
  if (!sameHash(outgoing, manifest.content_hash)) {
    throw new LocusArtifactRejected({
      artifact_id: manifest.artifact_id,
      reason: "le contenu a changé entre la déclaration et l'upload",
      declared_hash: manifest.content_hash,
      received_hash: outgoing,
    })
  }
  if (bytes.length !== manifest.size_bytes) {
    throw new LocusArtifactRejected({
      artifact_id: manifest.artifact_id,
      reason: `taille déclarée ${manifest.size_bytes}, taille envoyée ${bytes.length}`,
      declared_hash: manifest.content_hash,
    })
  }

  const ticket = await transport.requestUpload(manifest)
  // L'URL temporaire vient du serveur, donc c'est une entrée distante : même politique que pour
  // l'endpoint d'enrôlement (§7.3). Un ticket qui pointerait en clair ou vers un hôte interne
  // ferait sortir l'artefact par un chemin que personne n'a autorisé.
  assertEndpointAcceptable(ticket.url)
  if (ticketExpired(ticket, now())) {
    return {
      ok: false,
      outcome: "unverified",
      manifest,
      reason: "URL temporaire expirée avant l'envoi",
    }
  }

  const receipt = await transport.put(ticket, bytes)

  if (receipt.received_hash === undefined) {
    // §19.1 place la vérification AVANT `artifact.uploaded`. Sans preuve, l'événement n'est pas
    // émis et l'état ne bouge pas : le manifest reste `declared`, ce qui est exactement vrai.
    return {
      ok: false,
      outcome: "unverified",
      manifest,
      reason: "le serveur n'a pas renvoyé de hash de réception : rien ne prouve ce qui a été reçu",
    }
  }
  if (!sameHash(receipt.received_hash, manifest.content_hash)) {
    throw new LocusArtifactRejected({
      artifact_id: manifest.artifact_id,
      reason: "hash déclaré ≠ hash reçu",
      declared_hash: manifest.content_hash,
      received_hash: receipt.received_hash,
    })
  }
  if (receipt.size_bytes !== undefined && receipt.size_bytes !== manifest.size_bytes) {
    throw new LocusArtifactRejected({
      artifact_id: manifest.artifact_id,
      reason: `taille déclarée ${manifest.size_bytes}, taille reçue ${receipt.size_bytes}`,
      declared_hash: manifest.content_hash,
    })
  }

  const verified: ArtifactManifest = {
    ...manifest,
    state: "uploaded",
    uploaded_at: now().toISOString(),
    integrity: { verified_at: now().toISOString(), verified_hash_matches: true },
  }
  return { ok: true, manifest: verified, receipt }
}

function ticketExpired(ticket: UploadTicket, at: Date): boolean {
  if (ticket.expires_at === undefined) return false
  const deadline = Date.parse(ticket.expires_at)
  // Une date d'expiration illisible vaut expirée : envoyer sur un ticket dont on ne sait pas s'il
  // est valide est le seul des deux choix qui puisse faire fuiter l'artefact.
  return Number.isNaN(deadline) || deadline <= at.getTime()
}

/**
 * La charge d'un `artifact.declared` — §19.1.
 *
 * Le résultat de scan y figure (§19.2, « résultat de scan »), **y compris les contrôles qui n'ont
 * pas tourné** : un rapport qui ne montrerait que les constats laisserait croire que la liste des
 * problèmes est complète sur une machine où le scan antimalware n'existe pas.
 */
export function artifactDeclaredPayload(declaration: Declaration): Record<string, unknown> {
  return {
    manifest: { ...declaration.manifest },
    scan: {
      verdict: declaration.scan.verdict,
      complete: declaration.scan.complete,
      outcomes: declaration.scan.outcomes.map((outcome) => ({ ...outcome })),
      findings: declaration.scan.findings.map((finding) => ({ ...finding })),
    },
  }
}

/**
 * La charge d'un `artifact.uploaded`.
 *
 * N'est appelée que sur le chemin vérifié : `verified_hash_matches` y est un fait constaté, pas
 * une valeur par défaut optimiste.
 */
export function artifactUploadedPayload(manifest: ArtifactManifest, receipt: UploadReceipt): Record<string, unknown> {
  return {
    artifact_id: manifest.artifact_id,
    content_hash: manifest.content_hash,
    size_bytes: manifest.size_bytes,
    state: manifest.state,
    integrity: manifest.integrity === undefined ? undefined : { ...manifest.integrity },
    received_hash: receipt.received_hash,
  }
}

/**
 * Le cache local, content-addressed — §19.6.
 *
 * Le chemin dérive du hash et de rien d'autre : deux artefacts de même contenu occupent la même
 * entrée, et un nom de fichier ne peut pas faire écrire ailleurs. Le digest est éclaté en deux
 * niveaux pour ne pas faire un répertoire de cent mille entrées.
 */
export function cachePath(root: string, hash: string): string {
  const parsed = parseHash(hash)
  if (parsed === null) throw new TypeError(`hash de contenu illisible : ${hash}`)
  return `${root}/${parsed.algorithm}/${parsed.digest.slice(0, 2)}/${parsed.digest.slice(2)}`
}

/**
 * Une copie locale peut-elle être supprimée — §19.6.
 *
 * « La suppression ne concerne que les copies locales non requises par un attempt actif. Le worker
 * ne décide pas de la conservation canonique. » La fonction rend donc un verdict sur une **copie**,
 * et il n'existe nulle part ici de fonction qui supprime quoi que ce soit côté serveur.
 *
 * Un artefact en quarantaine n'est jamais évinçable : §19.5 dit que l'échec ne supprime pas la
 * preuve, et le cache local est souvent le seul endroit où cette preuve existe.
 */
export function evictable(hash: string, held: readonly string[], quarantined: readonly string[] = []): boolean {
  if (quarantined.some((entry) => sameHash(entry, hash))) return false
  return !held.some((entry) => sameHash(entry, hash))
}
