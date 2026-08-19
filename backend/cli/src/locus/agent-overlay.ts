/**
 * Le choix de l'agent amont et ce que Locus ajoute par-dessus — §30.2.
 *
 * « Agent registry sépare template, overlay et instance Locus Solus. » Ce module tient la moitié
 * *overlay* : il **choisit** un agent amont existant et décrit ce qui se pose dessus. Il n'en
 * définit aucun, n'en renomme aucun, et ne touche pas `src/agent/`.
 *
 * L'overlay est **additif par construction** : il porte des instructions supplémentaires et des
 * bornes, jamais un remplacement de prompt. Un overlay qui pourrait remplacer le prompt d'un agent
 * amont serait un agent local déguisé — et le prochain merge amont l'écraserait ou le
 * contredirait sans que personne s'en aperçoive.
 */

/** Les agents amont que Locus sait cibler. Des noms, pas des définitions. */
export const UPSTREAM_AGENTS = ["research", "biology", "physics", "ml", "reviewer", "critique"] as const

export type UpstreamAgent = (typeof UPSTREAM_AGENTS)[number]

/**
 * Le choix par capacité exigée, du plus spécifique au plus général.
 *
 * L'ordre est significatif et déclaré comme donnée : une mission qui exige `biology` et `ml`
 * obtient le premier de la table, et ce choix se relit au lieu de dépendre de l'ordre d'un `if`.
 */
export const AGENT_BY_CAPABILITY: readonly { readonly capability: string; readonly agent: UpstreamAgent }[] = [
  { capability: "biology", agent: "biology" },
  { capability: "physics", agent: "physics" },
  { capability: "math-formal", agent: "physics" },
  { capability: "ml", agent: "ml" },
  { capability: "python-science", agent: "research" },
]

/**
 * Le choix par **rôle** — `SPEC_V1.md` §7.1 (`AgentTemplate.role`) et §20, tranche 1 du mineur
 * `lep/1.1` (ADR 0017 §5.1).
 *
 * Table déclarée comme donnée, pour la raison qui vaut pour `AGENT_BY_CAPABILITY` : le choix se
 * relit au lieu de dépendre de l'ordre d'un `if`. Les deux rôles sont ceux que §20 nomme dans sa
 * politique de revue, et il n'y en a pas d'autres — inventer des rôles que personne n'écrit
 * donnerait une table plus fournie et pas plus vraie.
 *
 * **Un rôle inconnu n'est pas une erreur.** Il retombe sur les capacités, puis sur le défaut. C'est
 * l'interdit 3 d'ADR 0017 côté lecteur : un mineur ajoute des champs, jamais des valeurs, donc un
 * rôle qu'un émetteur plus récent enverrait ne doit pas arrêter un worker plus ancien.
 */
export const AGENT_BY_ROLE: readonly { readonly role: string; readonly agent: UpstreamAgent }[] = [
  { role: "logical-reviewer", agent: "reviewer" },
  { role: "provenance-reviewer", agent: "reviewer" },
]

/** L'agent par défaut : celui que l'amont désigne lui-même comme harnais par défaut. */
export const DEFAULT_AGENT: UpstreamAgent = "research"

/**
 * Ce que Locus pose sur l'agent choisi. Additif seulement.
 *
 * `extraInstructions` s'ajoute, `maxSteps` et `temperature` bornent. Aucun champ ne remplace le
 * prompt amont, et il n'en existe volontairement pas : voir l'en-tête.
 */
export type AgentOverlay = {
  readonly agent: UpstreamAgent
  readonly extraInstructions: readonly string[]
  readonly maxSteps?: number
  readonly temperature?: number
}

export type OverlayInput = {
  readonly requiredCapabilities?: readonly string[]
  /** §12.4 : une revue aveugle interdit le raisonnement privé du générateur. */
  readonly reviewPolicy?: string
  /**
   * Le rôle de l'instance, absent d'un document `lep/1.0`.
   *
   * `undefined` veut dire « le document n'en portait pas », jamais « le rôle est vide » : un
   * document ancien ne demande pas un rôle par défaut, il n'en demande aucun.
   */
  readonly role?: string
  readonly maxSteps?: number
}

/**
 * Choisir l'agent et composer l'overlay.
 *
 * L'ordre est **politique de revue, puis rôle, puis capacités**, et il n'est pas négociable.
 *
 * Une revue **indépendante** vise `reviewer`, quelles que soient les capacités demandées et quel
 * que soit le rôle : c'est l'invariant 11 qui décide, pas le domaine scientifique. Confier une
 * revue indépendante à l'agent `biology` parce que la mission parle de biologie ferait relire le
 * travail par le même profil que celui qui l'a produit — et un `role` qui pourrait passer devant
 * reconstruirait exactement ce trou, en le rendant demandable par l'émetteur. ADR 0017 §5.1 pose la
 * contrainte dans ces termes ; elle est ici, et un test la tient.
 *
 * Le rôle passe **devant les capacités** parce que c'est là qu'il sert : une mission qui exige
 * `biology` et dont le rôle est `provenance-reviewer` demande une vérification de provenance sur un
 * sujet de biologie, pas un biologiste. Sans le rôle, seul le sujet se voyait.
 */
export function selectOverlay(input: OverlayInput): AgentOverlay {
  const blind = input.reviewPolicy === "independent-blind"
  const independent = blind || input.reviewPolicy === "independent"

  const agent = independent
    ? "reviewer"
    : (AGENT_BY_ROLE.find((entry) => entry.role === input.role)?.agent ??
      AGENT_BY_CAPABILITY.find((entry) => input.requiredCapabilities?.includes(entry.capability))?.agent ??
      DEFAULT_AGENT)

  const extraInstructions: string[] = []
  if (blind) {
    // L'instruction ne remplace pas la protection : `context-materializer` écarte déjà le
    // raisonnement privé. Elle la double, parce qu'une consigne oubliée par le modèle ne doit pas
    // suffire à faire fuiter, et qu'un filtre sans consigne laisse le modèle demander ce qu'il
    // n'aura pas.
    extraInstructions.push(
      "Revue aveugle : le raisonnement privé du générateur est hors de votre contexte et ne doit pas être sollicité.",
    )
  }
  if (independent) {
    extraInstructions.push("Revue indépendante : jugez le travail sur ses artefacts et ses prémisses citées.")
  }

  return {
    agent,
    extraInstructions,
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
  }
}
