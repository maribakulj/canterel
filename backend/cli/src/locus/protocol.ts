import crypto from "node:crypto"

import { LEP_FEATURES, type LepFeature } from "./lep/generated.ts"
import { negotiate, type Negotiated } from "./lep/negotiate.ts"
import { LocusProtocolRefused } from "./errors.ts"
import { sign, type Identity } from "./identity.ts"

/**
 * Le handshake LEP — `SPEC_V1.md` §8.2.
 *
 * « Le worker refuse une version inconnue plutôt que de poursuivre en compatibilité implicite. »
 * C'est la règle qui gouverne tout ce module, et elle est plus subtile qu'un test d'égalité :
 * `docs/06` fait du mineur un ajout de champs optionnels compatibles, donc un worker `1.0` doit
 * **accepter** un serveur `1.1` et ignorer ce qu'il ne connaît pas, tout en **refusant** `2.0`.
 * Refuser trop large fige le protocole ; accepter trop large est la compatibilité implicite que la
 * spec interdit.
 */

/** La ligne de protocole que ce worker implémente. */
export const PROTOCOL_MAJOR = 1
export const PROTOCOL_VERSION = "lep/1.0"

/** Les features que ce worker sait réellement tenir. Annoncer plus serait mentir au handshake. */
export const SUPPORTED_FEATURES: readonly LepFeature[] = ["late-results", "pull-queue"]

/**
 * Le message `worker.hello` de §8.2.
 *
 * `capability_manifest_hash` et `resume_token` sont optionnels ici : le manifeste réel arrive avec
 * W2.6 et la reprise avec W2.16. Les déclarer maintenant évite que leur arrivée change la forme du
 * message, ce qui est précisément ce qu'un handshake ne doit pas faire.
 */
export type WorkerHello = {
  readonly protocol: string
  readonly supported_versions: readonly string[]
  readonly worker_id: string
  readonly worker_kind: "canterel"
  readonly runtime: string
  readonly features: readonly string[]
  readonly capability_manifest_hash?: string
  readonly resume_token?: string
  /** Dernière séquence serveur acquittée — §8.3. `-1` tant que rien n'a été reçu. */
  readonly last_server_sequence: number
  readonly nonce: string
  readonly signature: string
}

/**
 * Décider si une version annoncée par le serveur est acceptable.
 *
 * Rend la version retenue, ou lève. Trois cas distincts, et les distinguer est ce qui rend le
 * refus exploitable : version illisible, majeur différent, ou aucune version commune.
 */
export function acceptVersion(offered: readonly string[]): string {
  if (offered.length === 0) {
    throw new LocusProtocolRefused({ offered: [], reason: "le serveur n'annonce aucune version" })
  }

  const usable = offered.filter((version) => majorOf(version) === PROTOCOL_MAJOR)
  if (usable.length === 0) {
    throw new LocusProtocolRefused({
      offered: [...offered],
      reason: `aucune version de la ligne ${PROTOCOL_MAJOR}.x — poursuivre serait la compatibilité implicite que §8.2 interdit`,
    })
  }

  // La plus haute compatible : un mineur supérieur n'ajoute que des champs optionnels (docs/06),
  // donc le prendre ne coûte rien et laisse le serveur utiliser ce qu'il a de plus récent.
  return usable.sort(byMinorDescending)[0] as string
}

/** Le majeur d'une version `lep/1.2` ou `1.2`, ou `NaN` si la forme est inconnue. */
export function majorOf(version: string): number {
  const match = /^(?:lep\/)?(\d+)\.(\d+)$/.exec(version.trim())
  return match ? Number(match[1]) : Number.NaN
}

/** Le mineur, même convention. */
export function minorOf(version: string): number {
  const match = /^(?:lep\/)?(\d+)\.(\d+)$/.exec(version.trim())
  return match ? Number(match[2]) : Number.NaN
}

function byMinorDescending(left: string, right: string): number {
  return minorOf(right) - minorOf(left)
}

/**
 * Ce que le worker et le serveur se sont accordé.
 *
 * `negotiate` vient du SDK épinglé, pas d'une réimplémentation locale : la logique de négociation
 * est du contrat, et la réécrire ici serait exactement la duplication cross-repo que
 * `docs/locus/CLAUDE.md` interdit.
 */
export type Handshake = {
  readonly version: string
  readonly negotiated: Negotiated
}

/**
 * Construire le `worker.hello` signé de §8.2.
 *
 * Le nonce et la signature couvrent l'identité, la version et les features annoncées. Signer la
 * seule identité laisserait un intermédiaire retirer des features du message sans invalider la
 * signature — un worker se retrouverait à tenir un accord qu'il n'a pas passé.
 */
export function buildHello(input: {
  readonly identity: Identity
  readonly lastServerSequence?: number
  readonly capabilityManifestHash?: string
  readonly resumeToken?: string
  readonly nonce?: string
}): WorkerHello {
  const nonce = input.nonce ?? crypto.randomBytes(16).toString("base64")
  const features = [...SUPPORTED_FEATURES].sort()
  const last = input.lastServerSequence ?? -1

  const body = [PROTOCOL_VERSION, input.identity.public.worker_id, features.join(","), String(last), nonce].join("\n")

  return {
    protocol: PROTOCOL_VERSION,
    supported_versions: [PROTOCOL_VERSION],
    worker_id: input.identity.public.worker_id,
    worker_kind: "canterel",
    runtime: input.identity.public.runtime,
    features,
    ...(input.capabilityManifestHash ? { capability_manifest_hash: input.capabilityManifestHash } : {}),
    ...(input.resumeToken ? { resume_token: input.resumeToken } : {}),
    last_server_sequence: last,
    nonce,
    signature: sign(input.identity, body),
  }
}

/** Recomposer le corps signé d'un `worker.hello` — ce que `locusd` vérifiera. */
export function helloSignedBody(hello: WorkerHello): string {
  return [
    hello.protocol,
    hello.worker_id,
    [...hello.features].sort().join(","),
    String(hello.last_server_sequence),
    hello.nonce,
  ].join("\n")
}

/**
 * Conclure le handshake à partir de la réponse du serveur.
 *
 * Les features que le serveur annonce et que ce protocole ne connaît pas ne sont **pas** une
 * erreur : c'est le signal d'un pair plus récent, et `negotiate` les range à part exprès. Les
 * traiter comme une panne empêcherait un worker `1.0` de parler à un serveur `1.1`, ce que docs/06
 * autorise explicitement.
 */
export function completeHandshake(input: {
  readonly serverVersions: readonly string[]
  readonly serverFeatures: readonly string[]
}): Handshake {
  const version = acceptVersion(input.serverVersions)
  return {
    version,
    negotiated: negotiate([...SUPPORTED_FEATURES], [...input.serverFeatures]),
  }
}

/** Vrai si la feature a été accordée par les deux pairs. */
export function granted(handshake: Handshake, feature: LepFeature): boolean {
  return handshake.negotiated.features.includes(feature)
}

/** Toutes les features que le protocole épinglé connaît — pour rendre compte, pas pour annoncer. */
export function knownFeatures(): readonly string[] {
  return Object.keys(LEP_FEATURES).sort()
}
