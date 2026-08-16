/**
 * La surface publique de la couche Locus.
 *
 * Tout ce qui, hors de `src/locus/**`, a affaire à Locus passe par ce fichier — et une seule
 * chose en a le droit aujourd'hui, la couture déclarée dans `standalone.ts`. Ce point de passage
 * unique est ce qui permet au garde-fou de §28.8 d'être une question à laquelle on sait répondre :
 * « qui importe Locus ? » a une réponse énumérable.
 *
 * Le worker de W2.3 **ne fait rien**, délibérément (`docs/10` : « `canterel worker --locus` qui ne
 * fait rien »). Il résout sa configuration et rend compte de ce qu'il ferait. Ce n'est pas un
 * bouchon vide pour autant : la résolution des cinq niveaux de priorité de §6, le refus structuré
 * d'une variable illisible et le rendu rédigé sont réels, et ce sont eux que W2.4 trouvera en
 * place plutôt qu'à écrire en même temps que l'enrôlement.
 */

export {
  describeConfig,
  ENV_BINDINGS,
  LAYER_ORDER,
  LocusConfig,
  layerFromEnv,
  mergeLayers,
  parseConfig,
  requireConnectable,
  resolveConfig,
  type Layer,
  type LayerName,
} from "./config.ts"

export {
  LocusConfigInvalid,
  LocusEnrollmentRefused,
  LocusIdentityUnusable,
  LocusNotConfigured,
  LocusServerRejected,
} from "./errors.ts"

export {
  createIdentity,
  describeIdentity,
  isRevoked,
  loadIdentity,
  loadOrCreateIdentity,
  revokeIdentity,
  runtimeFingerprint,
  sign,
  verify,
  type Identity,
  type PublicIdentity,
} from "./identity.ts"

export {
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  SUPPORTED_FEATURES,
  acceptVersion,
  buildHello,
  completeHandshake,
  granted,
  helloSignedBody,
  knownFeatures,
  majorOf,
  minorOf,
  type Handshake,
  type WorkerHello,
} from "./protocol.ts"

export {
  describePin,
  documents,
  isDocument,
  readPin,
  requirePin,
  verifyAgainstSource,
  verifyPin,
  type Pin,
} from "./schema-registry.ts"

export {
  applyRedactions,
  assertBranchScope,
  assertViewIntegrity,
  classRank,
  materialize,
  requestExtension,
  viewContentHash,
  type ContextItem,
  type Exclusion,
  type ExclusionReason,
  type Materialized,
} from "./context-materializer.ts"

export { LocusContextRefused } from "./errors.ts"

export {
  ALLOWED_AFTER_LOSS,
  HEARTBEAT_TTL_RATIO,
  LEASE_LOST_ACTIONS,
  deadlineOf,
  heartbeatDue,
  isAllowedAfterLoss,
  isExpired,
  lateMarker,
  leaseTimingFindings,
  remainingMs,
  type LeaseLostAction,
} from "./lease.ts"

export {
  ATTEMPT_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  onLeaseLost,
  toProtocolState,
  transition,
  type AttemptState,
  type TransitionResult,
} from "./attempt.ts"

export {
  REFUSAL_CODES,
  admit,
  clampPolicy,
  hasBoundedBudget,
  insufficientResources,
  levelRank,
  missingCapabilities,
  type Admission,
  type LocalPolicy,
  type Refusal,
  type RefusalCode,
} from "./admission.ts"

export {
  DEFAULT_DATA_CLASSES,
  TOOLCHAIN_PROBES,
  accelerators,
  buildManifest,
  hostProbe,
  manifestHash,
  networkModes,
  sandboxBackend,
  sandboxLevels,
  toolchains,
  type HostProbe,
  type ManifestInput,
} from "./capability-manifest.ts"

export {
  HELLO_REQUIRED_FIELDS,
  checkHelloConformance,
  checkServerSignature,
  locusStateDir,
  register,
  type HandshakeTransport,
  type Registration,
  type ServerHello,
} from "./registration.ts"

export {
  describeChange,
  isRegression,
  poll,
  startWatch,
  type CapabilityChange,
  type WatchState,
} from "./capability-watch.ts"

export {
  DEFAULT_TIMEOUT_MS,
  attemptsToCeiling,
  httpEnrollmentTransport,
  reconnectDelay,
  type FetchLike,
} from "./connection.ts"

export {
  assertEndpointAcceptable,
  enroll,
  forgetCredential,
  isActionAllowed,
  loadCredential,
  REVOKED_ALLOWED_ACTIONS,
  sameOrigin,
  saveCredential,
  type Credential,
  type EnrollmentRequest,
  type EnrollmentTransport,
} from "./auth.ts"

import { describeConfig, layerFromEnv, resolveConfig, type Layer, type LocusConfig } from "./config.ts"

/** Ce que le worker rend quand on le lance — aujourd'hui, un constat. */
export type WorkerOutcome = {
  /** `inert` tant que W2.4 n'a pas donné d'identité au worker. Le mot est explicite exprès. */
  readonly status: "inert"
  /** La configuration résolue, rédigée — la seule forme qui a le droit d'être affichée. */
  readonly config: Record<string, unknown>
  /** Ce qui manque pour que le worker puisse se connecter. Vide ne veut pas dire prêt. */
  readonly missing: readonly string[]
}

/**
 * Résoudre la configuration du worker depuis les couches disponibles.
 *
 * `env` est un paramètre plutôt que `process.env` lu en douce, pour la même raison que dans
 * `config.ts` : un module qui va chercher son contexte tout seul se teste en muant le processus,
 * et se comporte différemment selon qui l'appelle.
 */
export function loadConfig(env: Record<string, string | undefined>, extra: readonly Layer[] = []): LocusConfig {
  return resolveConfig([...extra, layerFromEnv(env)])
}

/**
 * Lancer le worker — inerte à W2.3.
 *
 * Rend un constat au lieu de lever quand la configuration est incomplète : à ce stade, « tu n'as
 * pas d'endpoint » est une information, pas une panne. `requireConnectable` existe pour le moment
 * où ça deviendra une panne, c'est-à-dire quand quelque chose tentera vraiment de se connecter.
 */
export function runWorker(config: LocusConfig): WorkerOutcome {
  const missing: string[] = []
  if (!config.endpoint) missing.push("locus.endpoint")
  if (!config.identity) missing.push("locus.identity")
  return { status: "inert", config: describeConfig(config), missing }
}
