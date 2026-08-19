import { admit, type Refusal } from "./admission.ts"
import { selectOverlay, type AgentOverlay } from "./agent-overlay.ts"
import { modelUnavailableReason, usableModels, type ModelChoice } from "./model-policy.ts"
import { partitionTools, type ToolDescriptor } from "./tool-policy.ts"
import type { CapabilityManifest, DataClass, MissionEnvelope } from "./lep/generated.ts"

/**
 * De la mission à la session — `SPEC_V1.md` §30.2, la couche d'adaptation vers l'amont.
 *
 * Le test de sortie de W2.11 tient en cinq mots : **sans modifier `src/session/`**. Ce module rend
 * donc un **plan**, pas une session. C'est de la donnée : quel agent amont viser, quel overlay
 * poser dessus, quels modèles et quels outils sont permis. Rien ici n'instancie quoi que ce soit,
 * et rien n'importe `src/session/`.
 *
 * Ce n'est pas de la timidité, c'est ce qui rend la couche mince au sens d'ADR 0010 : un plan se
 * teste sans démarrer de session, et surtout il survit à une refonte amont de `src/session/` — ce
 * qu'un adaptateur qui appellerait ses fonctions internes ne ferait pas.
 */

export type SessionPlan = {
  readonly task_id: string
  /**
   * `attempt_id`, pas le rang `attempt` — §11.1 : « aucune de ces identités ne doit être
   * substituée aux autres ». Le typecheck a attrapé la substitution que je m'apprêtais à faire.
   */
  readonly attempt_id: string
  readonly branch_id: string
  readonly overlay: AgentOverlay
  readonly models: readonly ModelChoice[]
  readonly tools: readonly string[]
  /** Les outils écartés, avec leur raison. Rendus, jamais tus. */
  readonly forbiddenTools: readonly { name: string; reason: string }[]
  /** §12.4 : vrai quand le contexte doit exclure le raisonnement privé du générateur. */
  readonly blindReview: boolean
  /** L'identifiant de la vue à matérialiser (W2.10). Le plan ne la matérialise pas. */
  readonly contextViewId: string | undefined
}

export type MapInput = {
  readonly mission: MissionEnvelope
  readonly manifest: CapabilityManifest
  readonly tools: readonly ToolDescriptor[]
  readonly containedWrites: boolean
  readonly deniedTools?: readonly string[]
}

export type MapResult =
  | { readonly ok: true; readonly plan: SessionPlan }
  | { readonly ok: false; readonly refusal: Refusal }

/**
 * Traduire une mission admise en plan de session.
 *
 * L'admission de W2.8 passe **en premier** : une mission qu'on n'a pas le droit d'exécuter n'a pas
 * à être traduite, et traduire d'abord reviendrait à préparer une session pour un travail refusé.
 * Les refus propres à cette couche — `model_unavailable`, `tool_forbidden` — réutilisent les codes
 * de §10.2 plutôt que d'en inventer : ce sont les deux que W2.8 avait déclarés sans producteur.
 */
export function mapMission(input: MapInput): MapResult {
  const admission = admit({ mission: input.mission, manifest: input.manifest })
  if (!admission.accepted) return { ok: false, refusal: admission }

  const mission = input.mission as unknown as Record<string, unknown>
  const klass = readClass(mission["confidentiality_ceiling"] ?? mission["data_class"])

  const modelReason = modelUnavailableReason(input.manifest, klass)
  if (modelReason !== null) {
    return {
      ok: false,
      refusal: {
        accepted: false,
        code: "model_unavailable",
        details: { confidentiality: klass ?? null },
        message: modelReason,
      },
    }
  }

  const network = input.mission.sandbox.network ?? "deny"
  const { allowed, forbidden } = partitionTools(input.tools, {
    network,
    containedWrites: input.containedWrites,
    ...(input.deniedTools === undefined ? {} : { deniedTools: input.deniedTools }),
  })

  // Une mission qui exige un outil que la politique refuse n'est pas exécutable : `tool_forbidden`
  // plutôt qu'une session amputée qui échouerait plus tard, plus loin de la cause.
  const requiredTools = readStrings(mission["required_tools"])
  const missing = requiredTools.filter((name) => !allowed.includes(name))
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: {
        accepted: false,
        code: "tool_forbidden",
        details: { required: missing, forbidden: forbidden.map((entry) => entry.name) },
        message: `outils exigés mais refusés : ${missing.join(", ")}`,
      },
    }
  }

  const reviewPolicy = typeof mission["review_policy"] === "string" ? (mission["review_policy"] as string) : undefined
  // `role` est absent d'un document `lep/1.0`, et absent le reste : aucune valeur par défaut ne se
  // substitue à ce qu'un émetteur n'a pas demandé (ADR 0017 §5.1).
  const role = typeof mission["role"] === "string" ? (mission["role"] as string) : undefined

  return {
    ok: true,
    plan: {
      task_id: input.mission.task_id,
      attempt_id: input.mission.attempt_id,
      branch_id: input.mission.branch_id,
      overlay: selectOverlay({
        requiredCapabilities: readStrings(mission["required_capabilities"]),
        ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
        ...(role === undefined ? {} : { role }),
      }),
      models: usableModels(input.manifest, klass),
      tools: allowed,
      forbiddenTools: forbidden,
      blindReview: reviewPolicy === "independent-blind",
      contextViewId: readViewId(mission["context_view"]),
    },
  }
}

function readClass(value: unknown): DataClass | undefined {
  return typeof value === "string" ? (value as DataClass) : undefined
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function readViewId(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const id = (value as Record<string, unknown>)["id"] ?? (value as Record<string, unknown>)["view_id"]
    if (typeof id === "string") return id
  }
  return undefined
}

/**
 * Les répertoires amont que cette couche ne doit pas modifier — le test de sortie, en données.
 *
 * `docs/locus/CLAUDE.md` prévient qu'ils existent déjà avec un sens **local** et qu'il ne faut ni
 * les reconstruire ni les confondre avec leurs homonymes Locus. La liste est ici pour que le test
 * la lise plutôt que de la réécrire.
 */
export const UNTOUCHABLE_UPSTREAM_DIRS: readonly string[] = [
  "backend/cli/src/session/",
  "backend/cli/src/agent/",
  "backend/cli/src/permission/",
  "backend/cli/src/provider/",
  "backend/cli/src/tool/",
]
