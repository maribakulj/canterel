import type { NetworkMode } from "./lep/generated.ts"

/**
 * Quels outils une mission a le droit d'employer — `SPEC_V1.md` §10.2 (`tool_forbidden`) et la
 * règle de sécurité du dépôt : « réseau deny-by-default pour code non fiable ».
 *
 * Ce module ne connaît **aucun outil amont**. Il raisonne sur des **catégories** — réseau, écriture
 * hors workspace, exécution — et l'appelant apparie ses outils à ces catégories. Nommer ici les
 * outils de `src/tool/` créerait une liste à maintenir au rythme de l'amont, c'est-à-dire une liste
 * fausse à la première synchronisation. C'est aussi le producteur du code `tool_forbidden` que W2.8
 * avait déclaré sans encore le lever.
 */

/** Ce qu'un outil demande à la machine. Un outil peut en cumuler plusieurs. */
export const TOOL_FACULTIES = ["network", "write-outside-workspace", "execute", "read-workspace"] as const

export type ToolFaculty = (typeof TOOL_FACULTIES)[number]

export type ToolDescriptor = {
  readonly name: string
  readonly faculties: readonly ToolFaculty[]
}

export type ToolContext = {
  readonly network: NetworkMode
  /** Vrai quand le worker sait réellement contenir les écritures (S2 effectif). */
  readonly containedWrites: boolean
  /** Outils explicitement refusés par la politique locale — §10.3, restreindre seulement. */
  readonly deniedTools?: readonly string[]
}

export type ToolVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly faculty: ToolFaculty | "local-policy"; readonly reason: string }

/**
 * Décider d'un outil.
 *
 * Deny-by-default sur les facultés, pas sur les noms : un outil inconnu qui ne demande rien passe,
 * un outil connu qui demande le réseau sous `deny` ne passe pas. Raisonner sur les noms ferait
 * qu'un outil ajouté en amont serait autorisé par défaut simplement parce que personne n'a pensé
 * à l'interdire.
 */
export function judgeTool(tool: ToolDescriptor, context: ToolContext): ToolVerdict {
  if (context.deniedTools?.includes(tool.name)) {
    return { allowed: false, faculty: "local-policy", reason: "outil refusé par la politique locale" }
  }

  if (tool.faculties.includes("network") && context.network === "deny") {
    return {
      allowed: false,
      faculty: "network",
      reason: "la mission impose `deny` : un outil réseau ne peut pas être offert",
    }
  }

  if (tool.faculties.includes("write-outside-workspace") && !context.containedWrites) {
    // Sans containment effectif, un outil qui écrit hors workspace écrit vraiment n'importe où.
    // L'autoriser reviendrait à annoncer une isolation qu'on n'applique pas — la faute que W2.6
    // existe pour empêcher, ici du côté des outils.
    return {
      allowed: false,
      faculty: "write-outside-workspace",
      reason: "aucun containment d'écriture effectif sur cette machine",
    }
  }

  return { allowed: true }
}

/** Les outils retenus et les refus, en un passage. Les refus sont rendus, jamais tus. */
export function partitionTools(
  tools: readonly ToolDescriptor[],
  context: ToolContext,
): { readonly allowed: readonly string[]; readonly forbidden: readonly { name: string; reason: string }[] } {
  const allowed: string[] = []
  const forbidden: { name: string; reason: string }[] = []
  for (const tool of tools) {
    const verdict = judgeTool(tool, context)
    if (verdict.allowed) allowed.push(tool.name)
    else forbidden.push({ name: tool.name, reason: verdict.reason })
  }
  return { allowed, forbidden }
}
