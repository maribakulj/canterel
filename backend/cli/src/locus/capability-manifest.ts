import { LocusInventoryUnmeasured } from "./errors.ts"
import { payloadHash } from "./lep/canonical.ts"
import type {
  CapabilityManifest,
  CapabilityManifestAcceleratorsItem,
  CapabilityManifestModelsItem,
  DataClass,
  NetworkMode,
  SandboxLevel,
} from "./lep/generated.ts"
import { PROTOCOL_VERSION } from "./protocol.ts"

/**
 * Le `CapabilityManifest` — `SPEC_V1.md` §15.3, et la règle qui gouverne tout ce fichier.
 *
 * « Un worker annonce les niveaux de sandbox qu'il sait réellement appliquer — jamais ceux qu'il
 * aimerait offrir. » Annoncer trop est la seule faute qui compte ici : le serveur planifie sur
 * cette annonce, et un worker qui a promis S3 se verra confier du code hostile qu'il exécutera
 * dans un containment en écriture.
 *
 * Tout passe par un **`HostProbe` injecté** plutôt que par des appels directs à `process` et
 * `Bun.which`. Deux raisons, et la seconde est la vraie : ça rend le module testable, et surtout
 * ça rend testable **macOS depuis Linux**. Le test de sortie de W2.6 porte sur ce que ce worker
 * annonce sur un Mac ; sans injection, il ne pourrait tourner que sur un Mac, c'est-à-dire jamais
 * en CI.
 */

/** Ce que le module a besoin de savoir de la machine. Rien de plus, et rien qui vienne d'ailleurs. */
export type HostProbe = {
  readonly platform: "darwin" | "linux" | "win32" | string
  readonly arch: "x64" | "arm64" | string
  readonly release?: string
  /** Le chemin d'un exécutable du PATH, ou `null`. */
  which(binary: string): string | null
  /**
   * Vrai quand `bwrap` démarre réellement — l'existence du binaire ne suffit pas.
   *
   * `undefined` quand la sonde **n'a pas pu conclure**. Ce n'est ni un oui ni un non, et l'absence
   * ne donne jamais la capacité : une sonde non exécutée n'est pas une sonde réussie. Le type porte
   * la distinction parce que le premier adaptateur réel l'avait perdue — il rendait `true` dès que
   * le binaire existait, ce qui, `sandboxBackend` appelant `which` avant lui, en faisait une
   * tautologie incapable de refuser.
   */
  bubblewrapWorks(): boolean | undefined
  readonly cpuCores: number
  readonly memoryMb: number
  /**
   * L'espace libre mesuré, ou `undefined` quand la mesure n'a pas abouti.
   *
   * **Zéro n'est pas l'absence.** Un disque plein et un disque non mesuré mènent au même refus de
   * placement, et pas au même geste de réparation ; les confondre fait chercher de la place là où
   * il fallait réparer une sonde. Le premier adaptateur réel écrivait `0` en dur.
   */
  readonly diskFreeMb: number | undefined
}

/**
 * Les profils de toolchain de §19.4, et le binaire qui prouve leur présence.
 *
 * Une table plutôt qu'une suite de `if` : la liste évolue plus vite que le code qui la lit, et
 * l'ordre d'un `if` finit par porter du sens que personne n'a voulu.
 */
export const TOOLCHAIN_PROBES: readonly { readonly profile: string; readonly binary: string }[] = [
  { profile: "python", binary: "python3" },
  { profile: "node", binary: "node" },
  { profile: "bun", binary: "bun" },
  { profile: "r", binary: "R" },
  { profile: "julia", binary: "julia" },
  { profile: "rust", binary: "cargo" },
  { profile: "c-cpp", binary: "cc" },
  { profile: "java", binary: "java" },
  { profile: "git", binary: "git" },
]

/**
 * Les niveaux d'isolation réellement applicables — `docs/03`.
 *
 * S0 process de confiance, S1 permissions/logical, S2 OS sandbox, S3 conteneur rootless en
 * boundary forte, S4 micro-VM. `docs/locus/CLAUDE.md` tranche déjà pour ce dépôt : la sandbox
 * amont est du containment en écriture, allow-by-default, lectures ouvertes, sans cgroups ni
 * quota — **S1/S2, jamais S3/S4**.
 *
 * S1 est toujours là parce que le système de permissions amont existe toujours. S2 dépend d'un
 * backend réellement disponible, et sur Linux d'un `bwrap` qui **démarre** : le binaire présent
 * mais bloqué par AppArmor est le cas courant sur Ubuntu 24.04, et l'annoncer serait promettre une
 * isolation que la machine refuse.
 */
export function sandboxLevels(probe: HostProbe): readonly SandboxLevel[] {
  return sandboxBackend(probe) === "none" ? ["S1"] : ["S1", "S2"]
}

/** Le backend d'isolation effectif, ou `"none"`. */
export function sandboxBackend(probe: HostProbe): "seatbelt" | "bubblewrap" | "none" {
  if (probe.platform === "darwin") return probe.which("sandbox-exec") ? "seatbelt" : "none"
  if (probe.platform === "linux") {
    if (!probe.which("bwrap")) return "none"
    // Le binaire existe ; reste à savoir s'il démarre. Sur Ubuntu 24.04 la politique AppArmor de
    // l'hôte bloque les namespaces utilisateur non privilégiés, et bwrap échoue à l'exécution.
    //
    // La comparaison est stricte : `undefined` — la sonde n'a pas conclu — ne donne pas la capacité.
    // Écrit `probe.bubblewrapWorks() ? …`, une ignorance se rangerait du bon côté par accident,
    // ce qui est vrai aujourd'hui et cesserait de l'être au premier changement de convention.
    return probe.bubblewrapWorks() === true ? "bubblewrap" : "none"
  }
  return "none"
}

/**
 * Les modes réseau que ce worker sait **faire respecter**.
 *
 * Sans backend d'isolation, il ne sait pas couper le réseau d'une commande : il n'annonce donc que
 * `full`, ce qui est une mauvaise nouvelle honnête plutôt qu'un `deny` qui ne dénierait rien.
 *
 * `allowlist` n'est jamais annoncé. Ni Seatbelt tel que l'amont l'écrit, ni bubblewrap ne filtrent
 * par hôte : couper le réseau, oui ; le filtrer, non. L'annoncer ferait accepter des missions dont
 * la restriction ne serait jamais appliquée — et une restriction qu'on croit appliquée est pire
 * que pas de restriction du tout.
 */
export function networkModes(probe: HostProbe): readonly NetworkMode[] {
  return sandboxBackend(probe) === "none" ? ["full"] : ["deny", "full"]
}

/**
 * Les accélérateurs réellement présents.
 *
 * `mps` sur Apple Silicon seulement : un Mac Intel n'a pas de Metal Performance Shaders utilisable
 * comme accélérateur de calcul, et l'annoncer ferait échouer les missions qui le demandent.
 */
export function accelerators(probe: HostProbe): readonly CapabilityManifestAcceleratorsItem[] {
  if (probe.platform === "darwin") {
    return probe.arch === "arm64" ? [{ type: "mps", count: 1 }] : []
  }
  if (probe.platform === "linux") {
    const found: CapabilityManifestAcceleratorsItem[] = []
    if (probe.which("nvidia-smi")) found.push({ type: "cuda", count: 1 })
    if (probe.which("rocm-smi")) found.push({ type: "rocm", count: 1 })
    return found
  }
  return []
}

/** Les toolchains détectées, triées pour que deux inventaires égaux aient le même hash. */
export function toolchains(probe: HostProbe): readonly string[] {
  return TOOLCHAIN_PROBES.filter((entry) => probe.which(entry.binary) !== null)
    .map((entry) => entry.profile)
    .sort()
}

/**
 * Les classes de données que ce worker est autorisé à traiter.
 *
 * Ce n'est **pas** une détection : c'est une politique, et elle ne peut donc venir que d'une
 * décision explicite. Le défaut s'arrête à `internal` — `confidential` et `restricted` demandent
 * qu'on les écrive, parce qu'un worker qui les annonce par défaut se verra confier des données
 * que personne n'a décidé de lui confier.
 */
export const DEFAULT_DATA_CLASSES: readonly DataClass[] = ["public", "internal"]

export type ManifestInput = {
  readonly probe: HostProbe
  readonly workerId: string
  readonly maxConcurrency?: number
  readonly dataClasses?: readonly DataClass[]
  /**
   * Les modèles que cette installation peut faire tourner — §10.2, et la porte `model_unavailable`
   * de l'admission.
   *
   * **Omis** quand l'appelant ne dit rien, et présent — fût-ce vide — quand il dit quelque chose.
   * La distinction porte : un manifeste sans champ `models` n'a jamais été interrogé sur ses
   * modèles, un manifeste qui annonce `[]` a été interrogé et n'en a aucun. Confondre les deux
   * ferait lire « installation neuve » sur un hôte dont les fournisseurs ont tous été retirés.
   */
  readonly models?: readonly CapabilityManifestModelsItem[]
}

/**
 * Construire le manifeste. Aucune valeur n'y entre sans venir de la sonde ou d'une décision écrite.
 *
 * # Une ressource non mesurée fait **refuser**, elle ne devient pas zéro
 *
 * `disk_free_mb` est requis par le protocole : l'absence ne peut donc pas partir sur le fil, et il
 * faut choisir entre inventer un nombre et ne pas annoncer. Inventer `0` ferait lire « ce worker n'a
 * plus de place » là où il fallait lire « ce worker ne sait pas mesurer sa place » — deux causes
 * opposées pour la même conséquence, et une seule des deux se répare en libérant du disque.
 *
 * Le refus nomme la grandeur, ce qui est la différence entre un exploitant qui corrige en une
 * minute et un exploitant qui cherche.
 *
 * @throws {LocusInventoryUnmeasured}
 */
export function buildManifest(input: ManifestInput): CapabilityManifest {
  const probe = input.probe
  if (probe.diskFreeMb === undefined) {
    throw new LocusInventoryUnmeasured({ quantity: "disk_free_mb" })
  }
  return {
    protocol: PROTOCOL_VERSION,
    worker_id: input.workerId,
    worker_kind: "canterel",
    platform: {
      os: osOf(probe.platform),
      arch: archOf(probe.arch),
      ...(probe.release ? { release: probe.release } : {}),
    },
    toolchains: toolchains(probe),
    resources: {
      cpu_cores: probe.cpuCores,
      memory_mb: probe.memoryMb,
      disk_free_mb: probe.diskFreeMb,
    },
    accelerators: accelerators(probe),
    sandbox: {
      levels: sandboxLevels(probe),
      network_modes: networkModes(probe),
      backend: sandboxBackend(probe),
      // §21.x : vrai seulement quand le worker sait produire une SandboxAttestation, ce qui
      // arrivera avec les self-tests. Annoncer `true` avant de savoir attester serait le même
      // mensonge que d'annoncer S3.
      attestation: false,
    },
    ...(input.models === undefined ? {} : { models: [...input.models] }),
    data_classes: [...(input.dataClasses ?? DEFAULT_DATA_CLASSES)],
    max_concurrency: input.maxConcurrency ?? 1,
  }
}

function osOf(platform: string): "linux" | "macos" | "windows" {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return "linux"
}

function archOf(arch: string): "x86_64" | "arm64" {
  return arch === "arm64" ? "arm64" : "x86_64"
}

/**
 * Le hash du manifeste, celui que `worker.hello` transporte (§8.2).
 *
 * Il passe par la canonicalisation épinglée, pas par `JSON.stringify` : deux inventaires égaux
 * dont les clés sortent dans un ordre différent produiraient deux hashes, et le serveur croirait
 * à un changement de capacités à chaque reconnexion.
 */
export function manifestHash(manifest: CapabilityManifest): string {
  return payloadHash(manifest as unknown as Record<string, unknown>)
}

/**
 * La sonde réelle, construite depuis le processus courant.
 *
 * Le seul endroit du module qui touche à l'extérieur, isolé exprès pour que tout le reste reste
 * une fonction de données vers données.
 */
export function hostProbe(deps: {
  readonly which: (binary: string) => string | null
  readonly bubblewrapWorks: () => boolean
  readonly cpuCores: number
  readonly memoryMb: number
  readonly diskFreeMb: number
  readonly platform?: string
  readonly arch?: string
  readonly release?: string
}): HostProbe {
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    ...(deps.release ? { release: deps.release } : {}),
    which: deps.which,
    bubblewrapWorks: deps.bubblewrapWorks,
    cpuCores: deps.cpuCores,
    memoryMb: deps.memoryMb,
    diskFreeMb: deps.diskFreeMb,
  }
}
