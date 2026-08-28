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
  BUDGET_DIMENSIONS,
  ESCALATION_STAGES,
  STAGE_THRESHOLDS,
  UsageMeter,
  budgetUsagePayload,
  confidenceOf,
  stageFor,
  type Budget,
  type BudgetDimension,
  type Divergence,
  type EscalationStage,
  type MeterReport,
  type Usage,
} from "./usage-meter.ts"

export {
  DEFAULT_MAX_ENTRIES,
  EventSpool,
  SPOOL_FILE,
  type AppendResult,
  type SpoolEntry,
  type SpoolOptions,
} from "./event-spool.ts"

export {
  ATTEMPT_SCOPED_TYPES,
  COALESCIBLE_TYPES,
  NEVER_COALESCIBLE_TYPES,
  REQUIRED_EVENT_FIELDS,
  coalesce,
  coalescencePolicyFindings,
  eventFieldFindings,
  isCoalescible,
} from "./event-bridge.ts"

export {
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
  type Declaration,
  type DeclareInput,
  type PublishResult,
  type UploadReceipt,
  type UploadTicket,
} from "./artifact-client.ts"

export { UNKNOWN, bullet, field, leakFindings, render, section, shortHash } from "./ui/format.ts"

export { inferenceLabel, renderBudget, renderMission, renderModels, type MissionViewInput } from "./ui/mission-view.ts"

export {
  renderCapabilities,
  renderLease,
  renderQuarantine,
  renderWorkerStatus,
  type ConnectionState,
  type WorkerStatusInput,
} from "./ui/worker-status.ts"

export { MARKS, SELF_TESTS, alarms, mark, renderSecurity, type SecurityViewInput } from "./ui/security-view.ts"

export {
  QUESTION_CATEGORIES,
  acceptResponse,
  applyDeadline,
  humanInputPayload,
  questionFindings,
  releasePlan,
  suspendForHuman,
  type CostlyResource,
  type ExternalDecision,
  type HumanQuestion,
  type QuestionCategory,
  type QuestionOption,
  type ReleasePlan,
  type ResponseResult,
  type SuspensionResult,
} from "./human-input.ts"

export {
  CHECKPOINT_FILE,
  QUARANTINE_DIR,
  ResumeStore,
  type Checkpoint,
  type LoadResult,
  type UnserializableDependency,
} from "./resume-store.ts"

export {
  leaseAfterRestart,
  offlineVerdict,
  partialSubmission,
  restartDiagnostics,
  restorabilityFindings,
  resumeDecision,
  type LeaseStanding,
  type OfflineVerdict,
  type PartialSubmission,
  type RecoveryInput,
  type ResumeDecision,
} from "./recovery.ts"

export {
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
  type CommitCheck,
  type CommitInput,
  type ProposalStatus,
  type SignedCommit,
  type ValidationInput,
  type ValidationReport,
} from "./epistemic-commit.ts"

export {
  MAX_ARCHIVE_EXPANSION_RATIO,
  SCAN_CHECKS,
  TEXT_SNIFF_BYTES,
  quarantineReason,
  scanArtifact,
  type CheckOutcome,
  type CheckStatus,
  type ScanCheck,
  type ScanFinding,
  type ScanInput,
  type ScanReport,
  type ScannerTools,
} from "./artifact-scanner.ts"

export {
  UNTOUCHABLE_UPSTREAM_DIRS,
  mapMission,
  type MapInput,
  type MapResult,
  type SessionPlan,
} from "./session-map.ts"

export {
  AGENT_BY_CAPABILITY,
  DEFAULT_AGENT,
  UPSTREAM_AGENTS,
  selectOverlay,
  type AgentOverlay,
  type UpstreamAgent,
} from "./agent-overlay.ts"

export { REMOTE_INFERENCE_CEILING, modelUnavailableReason, usableModels, type ModelChoice } from "./model-policy.ts"

export {
  TOOL_FACULTIES,
  judgeTool,
  partitionTools,
  type ToolContext,
  type ToolDescriptor,
  type ToolFaculty,
  type ToolVerdict,
} from "./tool-policy.ts"

export { forkModifiedFiles } from "./upstream-merge.ts"

export {
  applyRedactions,
  assertBranchScope,
  assertNamedByMission,
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
  levelApplied,
  levelRank,
  missingCapabilities,
  type Accepted,
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

import type { Assembly } from "./composition.ts"
import { describeConfig, layerFromEnv, resolveConfig, type Layer, type LocusConfig } from "./config.ts"
import { runLoop, type LoopOutcome, type WorkerPorts } from "./worker-loop.ts"

/**
 * Ce que le worker rend quand on le lance.
 *
 * # `inert` n'est plus le seul état — `W2.20`
 *
 * Il l'a été jusqu'ici, et le mot était explicite exprès. Ce qui manquait n'était aucune des
 * pièces — enrôlement, offre, lease, admission, plan, contexte, événements, résultat, reprise
 * existaient tous et étaient testés — mais **ce qui les enchaîne**. `runLoop` les enchaîne
 * désormais.
 *
 * `inert` reste, et il dit maintenant exactement ce qu'il a toujours voulu dire : **cette
 * installation n'a pas de quoi se connecter**. Ce n'est pas une panne, c'est une information, et
 * `missing` la porte.
 */
export type WorkerOutcome =
  | {
      /** Cette installation n'a pas de quoi se connecter ; `missing` dit quoi. */
      readonly status: "inert"
      /** La configuration résolue, rédigée — la seule forme qui a le droit d'être affichée. */
      readonly config: Record<string, unknown>
      /** Ce qui manque pour que le worker puisse se connecter. Vide ne veut pas dire prêt. */
      readonly missing: readonly string[]
    }
  | {
      /** Un tour a eu lieu, et voici ce qu'il a fait. */
      readonly status: "ran"
      readonly config: Record<string, unknown>
      readonly outcome: LoopOutcome
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
 * Ce qu'on peut donner à [`runWorker`] en fait de ports.
 *
 * Soit les ports eux-mêmes — un test qui veut éprouver la boucle les fabrique directement —, soit
 * l'[`Assembly`] qu'un composition root a produit, y compris quand il a **échoué**. La seconde
 * forme existe parce qu'un échec d'assemblage sait pourquoi il a échoué, et que cette raison vaut
 * mieux que le mot « ports » dans un constat destiné à un humain.
 */
export type PortSupply = WorkerPorts | Assembly

/**
 * Lancer le worker.
 *
 * Rend un constat au lieu de lever quand la configuration est incomplète : à ce stade, « tu n'as
 * pas d'endpoint » est une information, pas une panne. `requireConnectable` existe pour le moment
 * où ça deviendra une panne, c'est-à-dire quand quelque chose tentera vraiment de se connecter.
 *
 * # Sans ports, il n'y a rien à enchaîner — et c'est dit plutôt que supposé
 *
 * Les ports sont **facultatifs** parce que `canterel worker status` et les diagnostics veulent le
 * constat de configuration sans rien exécuter. Leur absence rend donc `inert`, avec `missing` qui
 * nomme ce qui manque — y compris les ports eux-mêmes. Un worker qui rendrait « rien à faire » alors
 * qu'on ne lui a pas donné de quoi faire enverrait chercher un ordonnanceur vide.
 */
export async function runWorker(config: LocusConfig, supply?: PortSupply): Promise<WorkerOutcome> {
  const missing: string[] = []
  if (!config.endpoint) missing.push("locus.endpoint")
  // **Pas de garde sur `config.identity`**, et l'absence est le correctif.
  //
  // `W2.3` en posait une, à un moment où l'identité d'un worker n'était qu'un champ de §6 qu'on
  // écrivait à la main. `W2.4` a livré l'enrôlement, et l'identité qui compte est devenue la paire
  // de clés du répertoire d'état — celle que `assemblePorts` charge et dont il nomme l'absence
  // (« identité de worker (`canterel worker enroll`) »).
  //
  // La garde, elle, est restée. Conséquence : **un worker correctement enrôlé restait `inert`**, en
  // réclamant un champ que l'enrôlement ne remplit pas et que rien ne lit. Constaté en enrôlant un
  // worker réel contre un `locusd` réel — l'enrôlement rendait « enrôlé : canterel-… », et le tour
  // suivant rendait « incomplet — manque : locus.identity ».
  //
  // Le champ reste au schéma : §6 le définit, et l'ôter serait diverger de la spec dans un commit
  // de correction. Ce qui est acté ici est qu'**aucun code ne le lit** — ni pour nommer le worker,
  // ni pour rien d'autre. Lui donner un consommateur, ou le retirer de §6, est une décision, pas un
  // correctif ; elle est consignée au ledger plutôt que prise en passant.

  // Trois formes, et la troisième est celle que `W2.22` a ajoutée. `undefined` — personne n'a
  // assemblé, et le mot « ports » est alors exact. Un `Assembly` en échec — quelqu'un a essayé et
  // **sait pourquoi** : ses raisons remplacent le mot « ports », qui est un terme interne qu'un
  // utilisateur ne peut pas aller corriger. Des ports — il n'y a rien à signaler.
  const supplied = supply !== undefined && "ports" in supply ? supply.ports : supply
  const ports = supplied !== undefined && !("missing" in supplied) ? supplied : undefined
  if (supply === undefined) missing.push("ports")
  else if ("missing" in supply) missing.push(...supply.missing)

  // Dédoublonné : `assemblePorts` nomme `locus.endpoint` de son côté, et le lire deux fois dans la
  // même ligne ferait douter qu'il s'agisse du même champ.
  const unique = [...new Set(missing)]
  if (unique.length > 0) return { status: "inert", config: describeConfig(config), missing: unique }

  // `ports` est défini : `missing` serait non vide sinon, et on serait sorti au-dessus.
  const outcome = await runLoop(ports as WorkerPorts)
  return { status: "ran", config: describeConfig(config), outcome }
}
export * from "./composition.ts"
export * from "./model-inventory.ts"
export * from "./host-probe.ts"
export * from "./session-open.ts"
export * from "./worker-client.ts"
export * from "./worker-loop.ts"
