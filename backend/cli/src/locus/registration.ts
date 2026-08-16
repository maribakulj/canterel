import { join } from "node:path"

import { buildManifest, manifestHash, type HostProbe } from "./capability-manifest.ts"
import { LocusProtocolRefused, LocusServerRejected } from "./errors.ts"
import { loadOrCreateIdentity, verify, type Identity } from "./identity.ts"
import type { CapabilityManifest, DataClass } from "./lep/generated.ts"
import { buildHello, completeHandshake, helloSignedBody, type Handshake, type WorkerHello } from "./protocol.ts"

/**
 * L'enregistrement complet — `SPEC_V1.md` §8.2.
 *
 * Ce module ne parle pas le réseau : il **orchestre**. Le transport est un port, comme celui de
 * l'enrôlement, ce qui permet de jouer un handshake entier — y compris ses refus — sans serveur.
 *
 * Il assemble ce que les items précédents ont produit séparément : l'identité de W2.4 signe, le
 * manifeste de W2.6 est haché, la négociation de W2.5 conclut. L'intérêt d'un module dédié est
 * qu'aucun de ces trois ne connaît les deux autres.
 */

/** Où vit l'état Locus d'une installation, dérivé de la racine de données de l'hôte. */
export function locusStateDir(dataRoot: string): string {
  return join(dataRoot, "locus")
}

/** Ce que le serveur rend au `worker.hello`. */
export type ServerHello = {
  readonly supported_versions?: readonly string[]
  readonly features?: readonly string[]
  /** La séquence que le serveur a réellement reconnue — §8.4, étape 2. */
  readonly server_sequence?: number
  /** L'identité du serveur, quand il la signe. */
  readonly server_id?: string
  readonly nonce?: string
  readonly signature?: string
  readonly public_key?: string
}

export type HandshakeTransport = (hello: WorkerHello) => Promise<unknown>

/** Ce que l'enregistrement produit. */
export type Registration = {
  readonly identity: Identity
  readonly manifest: CapabilityManifest
  readonly hello: WorkerHello
  readonly handshake: Handshake
  /** La séquence reconnue par le serveur, point de départ de la reprise de §8.4. */
  readonly serverSequence: number
}

export type RegisterInput = {
  readonly stateDir: string
  readonly probe: HostProbe
  readonly transport: HandshakeTransport
  readonly endpoint: string
  readonly lastServerSequence?: number
  readonly resumeToken?: string
  readonly maxConcurrency?: number
  readonly dataClasses?: readonly DataClass[]
  readonly nonce?: string
}

/**
 * S'enregistrer auprès de `locusd`.
 *
 * L'ordre des étapes n'est pas indifférent. L'identité est chargée **avant** le manifeste parce
 * que le manifeste porte le `worker_id` ; le manifeste est haché **avant** le hello parce que le
 * hello porte ce hash ; et la version est acceptée **avant** que quoi que ce soit soit tenu pour
 * acquis de la réponse, parce que §8.2 refuse une version inconnue plutôt que de poursuivre.
 */
export async function register(input: RegisterInput): Promise<Registration> {
  const identity = await loadOrCreateIdentity(input.stateDir)

  const manifest = buildManifest({
    probe: input.probe,
    workerId: identity.public.worker_id,
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.dataClasses === undefined ? {} : { dataClasses: input.dataClasses }),
  })

  const hello = buildHello({
    identity,
    capabilityManifestHash: manifestHash(manifest),
    ...(input.lastServerSequence === undefined ? {} : { lastServerSequence: input.lastServerSequence }),
    ...(input.resumeToken === undefined ? {} : { resumeToken: input.resumeToken }),
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
  })

  const answer = await input.transport(hello).catch((error: unknown) => {
    throw new LocusServerRejected({
      endpoint: input.endpoint,
      reason: `handshake en échec : ${error instanceof Error ? error.message : String(error)}`,
    })
  })

  const server = readServerHello(answer, input.endpoint)
  const handshake = completeHandshake({
    serverVersions: server.supported_versions ?? [],
    serverFeatures: server.features ?? [],
  })

  return {
    identity,
    manifest,
    hello,
    handshake,
    // Le serveur peut ne rien reconnaître : `-1` veut dire « rien acquitté », pas « inconnu ».
    serverSequence: typeof server.server_sequence === "number" ? server.server_sequence : -1,
  }
}

function readServerHello(answer: unknown, endpoint: string): ServerHello {
  if (typeof answer !== "object" || answer === null) {
    throw new LocusProtocolRefused({ offered: [], reason: `réponse illisible de ${endpoint}` })
  }
  return answer as ServerHello
}

/**
 * Vérifier la signature du serveur quand il en fournit une — §7.3.
 *
 * Rend `"absente"` plutôt que `false` quand le serveur ne signe pas : les deux appellent des
 * décisions différentes. Un déploiement local peut légitimement ne pas signer (la feature
 * `signed-events` se négocie), tandis qu'une signature **présente et fausse** est une attaque ou
 * une erreur de configuration, jamais un choix.
 */
export function checkServerSignature(server: ServerHello, hello: WorkerHello): "absente" | "valide" | "invalide" {
  if (!server.signature || !server.public_key || !server.nonce) return "absente"
  // Le corps signé lie les deux nonces : sans le nôtre, une signature capturée sur un autre
  // handshake se rejouerait sur celui-ci.
  const body = [server.server_id ?? "", server.nonce, hello.nonce, hello.worker_id].join("\n")
  try {
    return verify(server.public_key, body, server.signature) ? "valide" : "invalide"
  } catch {
    return "invalide"
  }
}

/**
 * Ce qu'un `worker.hello` doit porter — §8.2, énuméré.
 *
 * La liste vit ici plutôt que dans le test : c'est le contrat du handshake, et un test qui porte sa
 * propre liste finit par vérifier ce qu'il a écrit plutôt que ce que la spec demande.
 */
export const HELLO_REQUIRED_FIELDS: readonly string[] = [
  "protocol",
  "supported_versions",
  "worker_id",
  "worker_kind",
  "runtime",
  "features",
  "capability_manifest_hash",
  "last_server_sequence",
  "nonce",
  "signature",
]

/**
 * Vérifier qu'un hello est conforme à §8.2 — la forme et la signature.
 *
 * Rend des constats plutôt que de lever, pour la même raison que le harnais de conformance : le
 * rapport complet dit si un worker est loin ou près, un premier échec ne dit rien.
 */
export function checkHelloConformance(hello: WorkerHello, publicKey: string): readonly string[] {
  const findings: string[] = []
  const record = hello as unknown as Record<string, unknown>
  for (const field of HELLO_REQUIRED_FIELDS) {
    if (record[field] === undefined) findings.push(`champ \`${field}\` absent (§8.2)`)
  }
  if (hello.supported_versions.length === 0) {
    findings.push("`supported_versions` vide : le serveur ne peut rien négocier")
  }
  // `verify` lève sur une clé illisible. Laisser filer l'exception ferait mentir le contrat de
  // cette fonction — « rend des constats plutôt que de lever » — précisément sur le worker le plus
  // cassé, celui dont on a le plus besoin du rapport.
  try {
    if (!verify(publicKey, helloSignedBody(hello), hello.signature)) {
      findings.push("signature invalide pour la clé publique annoncée")
    }
  } catch {
    findings.push("signature invérifiable : clé publique illisible")
  }
  return findings
}
