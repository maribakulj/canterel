import { payloadHash } from "./lep/canonical.ts"
import type { ContextView, DataClass } from "./lep/generated.ts"
import { LocusContextRefused } from "./errors.ts"

/**
 * La matérialisation du contexte et l'isolation informationnelle — `SPEC_V1.md` §12.3 et §12.4.
 *
 * C'est l'item qui porte l'**invariant 11** du projet : « les reviewers indépendants ne reçoivent
 * pas le raisonnement privé ou le contexte non autorisé du générateur ». Le schéma lui-même le dit
 * sur `branch_scope` — « une vue construite pour la branche A ne doit jamais atteindre une mission
 * de la branche B ».
 *
 * Le module est un **filtre**, et sa posture est deny-by-default. Un élément entre dans le contexte
 * parce qu'une règle l'autorise, jamais parce qu'aucune règle ne l'a exclu : c'est la différence
 * entre une isolation et une liste d'oublis. Chaque exclusion est **rapportée**, jamais silencieuse
 * — un contexte amputé sans que personne le sache produit un raisonnement dont on ne saura pas
 * qu'il était aveugle.
 */

/** Un élément candidat au contexte. LEP ne le décrit pas : c'est une notion locale de matérialisation. */
export type ContextItem = {
  readonly id: string
  /** Le type d'objet épistémique, filtré par `included_types` quand la vue en déclare. */
  readonly type?: string
  /** La branche dont l'élément provient. Son absence n'est pas une autorisation. */
  readonly branch_id?: string
  readonly confidentiality?: DataClass
  /** Position dans le journal. Au-delà du watermark, l'élément est un résultat futur. */
  readonly event_position?: number
  /** Niveau de validation, filtré par `validation_levels`. */
  readonly validation_level?: string
  /** Vrai pour le raisonnement privé d'un générateur — invariant 11. */
  readonly private_reasoning?: boolean
  /** Vrai pour une mémoire utilisateur globale, hors vue par construction. */
  readonly global_user_memory?: boolean
  /** Vrai pour un secret. §12.4 : jamais sous forme de prompt. */
  readonly secret?: boolean
  readonly content?: string
}

/** Pourquoi un élément a été écarté. Le code est stable ; le message ne l'est pas. */
export type ExclusionReason =
  | "branch-isolation"
  | "confidentiality-ceiling"
  | "beyond-watermark"
  | "private-reasoning"
  | "global-user-memory"
  | "secret-as-prompt"
  | "type-not-included"
  | "validation-level-not-included"

export type Exclusion = {
  readonly id: string
  readonly reason: ExclusionReason
  readonly detail: string
}

export type Materialized = {
  readonly view_id: string
  readonly items: readonly ContextItem[]
  /** Ce qui a été écarté, et pourquoi. Toujours rendu, même vide. */
  readonly excluded: readonly Exclusion[]
  /** L'empreinte vérifiée de la vue — §12.3, « vérifié avant démarrage ». */
  readonly content_hash: string
}

/** L'ordre de sensibilité de §21.9. Une mission ne peut pas abaisser le plafond. */
const CLASS_ORDER: readonly DataClass[] = ["public", "internal", "confidential", "restricted"]

export function classRank(klass: string): number {
  return CLASS_ORDER.indexOf(klass as DataClass)
}

/**
 * Le hash du contenu de la vue, calculé sur tout **sauf** le champ qui le porte.
 *
 * Inclure `content_hash` dans son propre calcul le rendrait invérifiable ; l'omettre est la seule
 * définition possible, et l'écrire ici évite que chaque appelant en invente une autre.
 */
export function viewContentHash(view: ContextView): string {
  const { content_hash, ...rest } = view as Record<string, unknown> & { content_hash: string }
  void content_hash
  return payloadHash(rest)
}

/**
 * Vérifier que cette vue a été construite **pour cette mission** — invariant 11.
 *
 * Le schéma le dit sur `branch_scope` : « une vue construite pour la branche A ne doit jamais
 * atteindre une mission de la branche B ». C'est une propriété de la **vue entière**, pas de
 * chacun de ses éléments — et la distinction n'est pas académique. Traiter la portée élément par
 * élément en ferait une **autorisation** (« cet élément est de la branche A, et A est dans la
 * portée, donc il passe »), c'est-à-dire l'exact inverse de son rôle. La portée restreint ; elle
 * n'ouvre jamais.
 *
 * Une vue sans portée déclarée n'est pas rattachée à une branche : elle passe ce contrôle, et
 * l'isolation se joue alors élément par élément contre la branche de la mission.
 */
export function assertBranchScope(view: ContextView, missionBranch: string): void {
  const scope = view.branch_scope
  if (scope && !scope.includes(missionBranch)) {
    throw new LocusContextRefused({
      view_id: view.id,
      reason:
        `vue construite pour ${scope.join(", ")}, mission sur ${missionBranch} : ` +
        "une vue d'une branche n'atteint jamais la mission d'une autre (invariant 11)",
    })
  }
}

/**
 * Vérifier l'intégrité de la vue — §12.3, « le hash de la vue doit être vérifié **avant**
 * démarrage ».
 *
 * Lève plutôt que de rendre un constat, comme `assertBranchScope` : une vue dont
 * l'empreinte ne correspond pas n'est pas un contexte appauvri, c'est un contexte dont on ne sait
 * pas ce qu'il est. Continuer en filtrant son contenu reviendrait à appliquer une politique
 * d'isolation à un document qu'on n'a pas authentifié.
 */
export function assertViewIntegrity(view: ContextView): void {
  const expected = viewContentHash(view)
  if (view.content_hash !== expected) {
    throw new LocusContextRefused({
      view_id: view.id,
      reason: `empreinte de la vue invalide : annoncée ${view.content_hash}, calculée ${expected}`,
    })
  }
}

export type MaterializeInput = {
  readonly view: ContextView
  readonly items: readonly ContextItem[]
  /** La branche de la mission. C'est elle qui décide, pas la vue seule. */
  readonly missionBranch: string
  /** Vrai pour une revue aveugle : le raisonnement privé du générateur est alors exclu (invariant 11). */
  readonly blindReview?: boolean
}

/**
 * Matérialiser le contexte autorisé.
 *
 * L'intégrité est vérifiée **en premier**, avant tout filtrage : §12.3 dit « avant démarrage », et
 * filtrer d'abord reviendrait à faire confiance au document qui décrit ce à quoi on a droit.
 */
export function materialize(input: MaterializeInput): Materialized {
  assertViewIntegrity(input.view)
  assertBranchScope(input.view, input.missionBranch)

  const view = input.view
  const kept: ContextItem[] = []
  const excluded: Exclusion[] = []

  for (const item of input.items) {
    const reason = excludedBecause(item, view, input)
    if (reason) excluded.push({ id: item.id, ...reason })
    else kept.push(item)
  }

  return { view_id: view.id, items: kept, excluded, content_hash: view.content_hash }
}

function excludedBecause(
  item: ContextItem,
  view: ContextView,
  input: MaterializeInput,
): { reason: ExclusionReason; detail: string } | null {
  // §12.4, cinquième interdit, en tête parce que c'est le plus grave : un secret sous forme de
  // prompt sort de la machine avec le prompt.
  if (item.secret === true) {
    return { reason: "secret-as-prompt", detail: "un secret ne se matérialise jamais en contexte" }
  }

  // Invariant 11 et §12.4 : une vue construite pour la branche A ne doit jamais atteindre une
  // mission de la branche B. Un élément sans branche n'est pas pour autant autorisé d'office —
  // il l'est seulement si la vue ne déclare aucune portée.
  if (item.branch_id !== undefined) {
    const scope = view.branch_scope
    // La portée **restreint**. Quand elle est déclarée, la vue a déjà été reconnue comme
    // construite pour cette mission (`assertBranchScope`), et un élément doit y appartenir.
    // Sans portée, la seule branche admissible est celle de la mission : c'est le défaut sûr,
    // et il refuse les conclusions d'une branche concurrente (§12.4).
    const allowed = scope ? scope.includes(item.branch_id) : item.branch_id === input.missionBranch
    if (!allowed) {
      return {
        reason: "branch-isolation",
        detail:
          `branche ${item.branch_id} hors de la mission (${input.missionBranch})` +
          (scope ? ` et de la portée déclarée (${scope.join(", ")})` : " et aucune portée ne l'élargit"),
      }
    }
  }

  if (item.private_reasoning === true && input.blindReview === true) {
    return {
      reason: "private-reasoning",
      detail: "raisonnement privé du générateur dans une revue aveugle (invariant 11)",
    }
  }

  if (item.global_user_memory === true) {
    return {
      reason: "global-user-memory",
      detail: "mémoire utilisateur globale non incluse dans la vue",
    }
  }

  // §12.4 : ni résultats futurs, ni non validés. Le watermark est ce qui rend « ce que l'agent
  // pouvait connaître » vérifiable après coup ; un élément au-delà n'existait pas encore pour lui.
  if (item.event_position !== undefined && item.event_position > view.source_event_watermark) {
    return {
      reason: "beyond-watermark",
      detail: `position ${item.event_position} au-delà du watermark ${view.source_event_watermark}`,
    }
  }

  const ceiling = classRank(view.confidentiality_ceiling)
  if (item.confidentiality !== undefined) {
    const rank = classRank(item.confidentiality)
    // Un niveau inconnu est traité comme au-dessus du plafond : ne pas savoir classer n'autorise
    // pas à laisser passer.
    if (rank === -1 || rank > ceiling) {
      return {
        reason: "confidentiality-ceiling",
        detail: `classe ${item.confidentiality} au-dessus du plafond ${view.confidentiality_ceiling}`,
      }
    }
  }

  if (view.included_types && item.type !== undefined && !view.included_types.includes(item.type)) {
    return { reason: "type-not-included", detail: `type ${item.type} hors de la vue` }
  }

  if (
    view.validation_levels &&
    item.validation_level !== undefined &&
    !view.validation_levels.includes(item.validation_level)
  ) {
    return {
      reason: "validation-level-not-included",
      detail: `niveau de validation ${item.validation_level} hors de la vue`,
    }
  }

  return null
}

/**
 * Appliquer les rédactions de la vue à un texte.
 *
 * Chaque cible est remplacée par un marqueur qui **porte sa raison**. Effacer sans trace ferait
 * lire à l'agent un texte dont il ne saurait pas qu'il est amputé, et un raisonnement mené sur un
 * texte tronqué à son insu est pire qu'un raisonnement qui sait ce qui lui manque.
 */
export function applyRedactions(text: string, view: ContextView): string {
  let out = text
  for (const redaction of view.redactions ?? []) {
    out = out.split(redaction.target).join(`[rédigé : ${redaction.reason}]`)
  }
  return out
}

/**
 * Demander une extension de contexte — §12.4, dernière phrase.
 *
 * « Tout accès additionnel nécessite `context.extension_requested` puis une décision Locus
 * Solus. » Ce module produit donc la **demande**, et il n'existe volontairement aucune fonction
 * qui l'accorde : la décision n'appartient pas au worker, et offrir un `grantExtension()` local
 * serait offrir le moyen de contourner exactement ce que §12.4 protège.
 */
export function requestExtension(input: {
  readonly viewId: string
  readonly taskId: string
  readonly wanted: readonly string[]
  readonly justification: string
}): Record<string, unknown> {
  return {
    event_type: "context.extension_requested",
    view_id: input.viewId,
    task_id: input.taskId,
    requested_ids: [...input.wanted],
    justification: input.justification,
  }
}
