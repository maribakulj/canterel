import type { CapabilityManifest, DataClass, MissionEnvelope, SandboxLevel } from "./lep/generated.ts"
import { majorOf, PROTOCOL_MAJOR } from "./protocol.ts"

/**
 * L'admission d'une mission — `SPEC_V1.md` §10.2 et §10.3.
 *
 * « Le message humain est secondaire ; le code et les détails structurés sont canoniques. » Tout ce
 * module découle de cette phrase : un refus est un **code stable** plus des détails exploitables
 * par une machine, et la phrase française qui l'accompagne n'est qu'un confort.
 *
 * Le refus n'est pas une malformation. Une mission refusée est un document parfaitement valide que
 * ce worker-ci ne peut pas tenir ; c'est le corpus de W0.7 qui le dit le plus clairement en
 * marquant sa fixture `refused` et non `invalid`. Confondre les deux rendrait le refus
 * indistinguable d'un bug de sérialisation.
 */

/** Les codes de §10.2, dans l'ordre du texte. Ils sont le contrat ; les messages ne le sont pas. */
export const REFUSAL_CODES = [
  "unsupported_protocol",
  "invalid_signature",
  "capability_missing",
  "model_unavailable",
  "tool_forbidden",
  "sandbox_unavailable",
  "network_policy_unsupported",
  "data_locality_violation",
  "confidentiality_unsupported",
  "resource_exhausted",
  "budget_unenforceable",
  "deadline_impossible",
  "worker_draining",
  "local_policy_denied",
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

export type Refusal = {
  readonly accepted: false
  readonly code: RefusalCode
  /** Les détails structurés : ce qui était demandé, ce qui est offert. Jamais une phrase. */
  readonly details: Record<string, unknown>
  /** Le confort humain, explicitement secondaire. */
  readonly message: string
}

/**
 * Une mission admise, et **le niveau qui la confinera**.
 *
 * `appliedLevel` n'est pas toujours `mission.sandbox.minimum_level` : c'est un plancher, et un
 * worker qui n'offre pas ce niveau exact mais mieux applique le plus bas qui suffit. Le porter dans
 * le verdict plutôt que le laisser déduire est ce qui rend l'écart **lisible** : une acceptation nue
 * dirait « oui » sans dire à quoi la mission aura effectivement droit, et deux missions confinées
 * différemment se ressembleraient trait pour trait dans un journal.
 */
export type Accepted = {
  readonly accepted: true
  /** Le niveau réellement appliqué — jamais inférieur au plancher de la mission. */
  readonly appliedLevel: SandboxLevel
}

export type Admission = Accepted | Refusal

/**
 * La politique locale — §10.3.
 *
 * « Le propriétaire de la machine peut imposer des restrictions supérieures à celles de Locus
 * Solus. Il ne peut jamais assouplir localement une politique reçue. » C'est une **intersection**
 * avec ce que le manifeste offre, jamais une union : `clampPolicy` le garantit par construction,
 * pour que la règle ne dépende pas de la discipline de qui écrit la configuration.
 */
export type LocalPolicy = {
  /** Niveau minimal exigé localement, au-delà de ce que la mission demande. */
  readonly minimumSandboxLevel?: SandboxLevel
  /** Sous-ensemble des classes de données du manifeste que cette machine accepte. */
  readonly dataClasses?: readonly DataClass[]
  /** Modes réseau refusés localement, même si le worker sait les appliquer. */
  readonly deniedNetworkModes?: readonly string[]
  /** Le worker se vide : il n'accepte plus rien (§5.3). */
  readonly draining?: boolean
  /** Durée maximale qu'une mission peut demander sur cette machine. */
  readonly maxWallTimeSeconds?: number
}

const LEVEL_ORDER: readonly SandboxLevel[] = ["S0", "S1", "S2", "S3", "S4", "S5"]

/** L'ordre de §21.6 : S0 < S1 < … < S5. Rend `-1` pour un niveau inconnu. */
export function levelRank(level: string): number {
  return LEVEL_ORDER.indexOf(level as SandboxLevel)
}

/**
 * Le niveau que ce worker **appliquera** pour une mission qui exige au moins `required`.
 *
 * `undefined` quand aucun niveau offert n'y suffit — le seul cas de `sandbox_unavailable`.
 *
 * # Ce que le champ dit, et ce que ce module en lisait
 *
 * Il s'appelle `minimum_level`. C'est un **plancher**, et un worker qui offre plus le franchit :
 * confiner davantage que demandé est ce que §10.3 autorise explicitement à une machine, dans la
 * même phrase où elle lui interdit de confiner moins.
 *
 * L'admission testait pourtant l'**appartenance** — `levels.includes(required)` —, ce qui refuse
 * une mission `S0` sur un worker qui offre `S1/S2`. Le cas ne s'était jamais présenté parce que
 * les trois paires du corpus de W0.7 exigent toutes **au-dessus** du plafond offert, où
 * appartenance et ordre coïncident ; il s'est présenté en tentant la quatrième clause de `W12.d`,
 * dont la mission ne peut viser que `S0` — le seul niveau que `Candidate::shortfall` place sans
 * attestation, côté plan de contrôle.
 *
 * Les deux moitiés d'une même décision lisaient donc le champ différemment : `locusd` place par
 * l'ordre (`SandboxLevel::satisfies`, littéralement `self >= required`), le worker refusait par
 * l'égalité. Une mission `S0` était **placée puis refusée**, et les deux comportements étaient
 * défendables séparément.
 *
 * # Pourquoi le **plus bas** qui suffit, et non le plus haut
 *
 * Le plus haut serait une politique que personne n'a demandée : sur ce worker, `S2` coûte une
 * sandbox réelle là où la mission n'exigeait rien. Le plus bas qui suffit honore la demande sans
 * inventer de restriction — et quand le niveau exigé est offert, c'est lui, donc rien ne change
 * pour aucune mission qui passait déjà.
 */
export function levelApplied(offered: readonly SandboxLevel[], required: SandboxLevel): SandboxLevel | undefined {
  const floor = levelRank(required)
  // Un niveau offert que l'échelle ne connaît pas rend `-1` et ne satisfait donc jamais un plancher
  // connu. C'est voulu : un manifeste qui annonce un niveau inventé n'a rien prouvé, et le lire
  // comme « au moins autant » lui accorderait le bénéfice de sa propre faute.
  return offered
    .filter((level) => levelRank(level) >= floor && floor >= 0)
    .sort((left, right) => levelRank(left) - levelRank(right))[0]
}

/**
 * Restreindre une politique locale à ce que le manifeste offre réellement.
 *
 * §10.3 interdit d'assouplir. Plutôt que de vérifier après coup qu'une politique n'élargit rien —
 * ce qui suppose que quelqu'un pense à vérifier — l'élargissement est rendu **impossible** :
 * les classes de données sont intersectées avec celles du manifeste, et un niveau minimal local
 * plus bas que rien n'a aucun effet puisqu'il ne fait que s'ajouter aux exigences.
 */
export function clampPolicy(policy: LocalPolicy, manifest: CapabilityManifest): LocalPolicy {
  const clamped: LocalPolicy = {
    ...policy,
    ...(policy.dataClasses
      ? { dataClasses: policy.dataClasses.filter((klass) => manifest.data_classes.includes(klass)) }
      : {}),
  }
  return clamped
}

export type AdmissionInput = {
  readonly mission: MissionEnvelope
  readonly manifest: CapabilityManifest
  readonly policy?: LocalPolicy
}

/**
 * Décider si ce worker peut tenir cette mission.
 *
 * L'ordre des contrôles est celui du coût de l'erreur, pas celui du texte de §10.2 : ce qui rend le
 * reste du document ininterprétable passe d'abord (le protocole), puis ce qui engage la sécurité
 * (sandbox, réseau, confidentialité), puis ce qui n'engage que le succès (ressources, budget,
 * délai). Un worker qui refuserait d'abord sur les ressources dirait « pas assez de CPU » d'une
 * mission qu'il n'avait de toute façon pas le droit d'exécuter.
 */
export function admit(input: AdmissionInput): Admission {
  const { mission, manifest } = input
  const policy = input.policy ? clampPolicy(input.policy, manifest) : {}

  if (majorOf(mission.protocol) !== PROTOCOL_MAJOR) {
    return refuse("unsupported_protocol", `protocole ${mission.protocol} hors de la ligne ${PROTOCOL_MAJOR}.x`, {
      requested: mission.protocol,
      supported_major: PROTOCOL_MAJOR,
    })
  }

  if (policy.draining === true) {
    return refuse("worker_draining", "le worker se vide et n'accepte plus de mission", {})
  }

  const required = mission.sandbox.minimum_level
  const applied = levelApplied(manifest.sandbox.levels, required)
  if (applied === undefined) {
    // Le refus du corpus de W0.7 : mission S3, worker macOS Seatbelt qui n'offre que S1/S2.
    return refuse(
      "sandbox_unavailable",
      `niveau ${required} exigé, le worker offre ${manifest.sandbox.levels.join("/")}`,
      {
        required_level: required,
        offered_levels: [...manifest.sandbox.levels],
      },
    )
  }

  if (policy.minimumSandboxLevel && levelRank(required) < levelRank(policy.minimumSandboxLevel)) {
    // §10.3 : la machine peut exiger plus que la mission. Elle ne peut jamais exiger moins.
    return refuse(
      "local_policy_denied",
      `la politique locale exige au moins ${policy.minimumSandboxLevel}, la mission demande ${required}`,
      { required_level: required, local_minimum: policy.minimumSandboxLevel },
    )
  }

  const network = mission.sandbox.network
  if (network !== undefined && !manifest.sandbox.network_modes.includes(network)) {
    return refuse("network_policy_unsupported", `mode réseau ${network} non applicable par ce worker`, {
      requested_mode: network,
      offered_modes: [...manifest.sandbox.network_modes],
    })
  }
  if (network !== undefined && policy.deniedNetworkModes?.includes(network)) {
    return refuse("local_policy_denied", `mode réseau ${network} refusé par la politique locale`, {
      requested_mode: network,
    })
  }

  const klass = missionDataClass(mission)
  if (klass !== undefined) {
    if (!manifest.data_classes.includes(klass)) {
      return refuse("confidentiality_unsupported", `classe ${klass} au-delà de ce que ce worker traite`, {
        requested_class: klass,
        allowed_classes: [...manifest.data_classes],
      })
    }
    if (policy.dataClasses && !policy.dataClasses.includes(klass)) {
      return refuse("local_policy_denied", `classe ${klass} refusée par la politique locale`, {
        requested_class: klass,
        allowed_classes: [...policy.dataClasses],
      })
    }
  }

  const missing = missingCapabilities(mission, manifest)
  if (missing.length > 0) {
    return refuse("capability_missing", `capacités absentes : ${missing.join(", ")}`, {
      missing,
      offered: [...manifest.toolchains],
    })
  }

  const short = insufficientResources(mission, manifest)
  if (short) {
    return refuse("resource_exhausted", `ressource ${short.what} insuffisante`, short)
  }

  if (!hasBoundedBudget(mission)) {
    // §17 : un budget non borné est inapplicable, donc inacceptable. C'est ce que la fixture
    // `invalid-mission-unbounded-budget` du corpus démontre côté schéma.
    return refuse("budget_unenforceable", "budget non borné : rien à faire respecter", {})
  }

  const wall = missionWallTime(mission)
  if (wall !== undefined && policy.maxWallTimeSeconds !== undefined && wall > policy.maxWallTimeSeconds) {
    return refuse("deadline_impossible", `durée demandée ${wall}s au-delà du plafond local`, {
      requested_seconds: wall,
      local_maximum: policy.maxWallTimeSeconds,
    })
  }

  return { accepted: true, appliedLevel: applied }
}

function refuse(code: RefusalCode, message: string, details: Record<string, unknown>): Refusal {
  return { accepted: false, code, details, message }
}

/**
 * Les champs facultatifs de `MissionEnvelope` sont lus défensivement.
 *
 * Le schéma est ouvert (docs/06 : un mineur ajoute des champs optionnels), donc un document `1.1`
 * peut porter ce que ce code ne connaît pas — et un document `1.0` peut ne pas porter ce qu'il
 * connaît. Supposer la présence ferait échouer l'admission sur une mission parfaitement valide.
 */
function record(mission: MissionEnvelope): Record<string, unknown> {
  return mission as unknown as Record<string, unknown>
}

function missionDataClass(mission: MissionEnvelope): DataClass | undefined {
  const value = record(mission)["data_class"]
  return typeof value === "string" ? (value as DataClass) : undefined
}

function missionWallTime(mission: MissionEnvelope): number | undefined {
  const resources = record(mission)["resources"]
  if (typeof resources !== "object" || resources === null) return undefined
  const value = (resources as Record<string, unknown>)["wall_time_seconds"]
  return typeof value === "number" ? value : undefined
}

/** Les capacités exigées que le worker n'annonce pas. */
export function missingCapabilities(mission: MissionEnvelope, manifest: CapabilityManifest): readonly string[] {
  const wanted = record(mission)["required_capabilities"]
  if (!Array.isArray(wanted)) return []
  return wanted.filter((item): item is string => typeof item === "string" && !manifest.toolchains.includes(item))
}

/** La première ressource insuffisante, ou `null`. */
export function insufficientResources(
  mission: MissionEnvelope,
  manifest: CapabilityManifest,
): { what: string; requested: number; available: number } | null {
  const resources = record(mission)["resources"]
  if (typeof resources !== "object" || resources === null) return null
  const asked = resources as Record<string, unknown>

  // Les noms diffèrent des deux côtés exprès (`cpu` contre `cpu_cores`) : le manifeste est un
  // inventaire, la mission une demande, et un nom commun inviterait à les soustraire sans y penser.
  const pairs: readonly { what: string; requested: unknown; available: number }[] = [
    { what: "cpu", requested: asked["cpu"], available: manifest.resources.cpu_cores },
    { what: "memory_mb", requested: asked["memory_mb"], available: manifest.resources.memory_mb },
    { what: "disk_mb", requested: asked["disk_mb"], available: manifest.resources.disk_free_mb },
  ]
  for (const pair of pairs) {
    if (typeof pair.requested === "number" && pair.requested > pair.available) {
      return { what: pair.what, requested: pair.requested, available: pair.available }
    }
  }
  return null
}

/** Vrai quand la mission borne son budget — §17. */
export function hasBoundedBudget(mission: MissionEnvelope): boolean {
  const budget = record(mission)["budget"]
  if (typeof budget !== "object" || budget === null) return true
  const values = Object.values(budget as Record<string, unknown>).filter((value) => typeof value === "number")
  // Un budget déclaré mais sans aucune borne numérique est un budget décoratif.
  return values.length > 0
}
