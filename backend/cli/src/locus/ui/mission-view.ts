import { UNKNOWN, bullet, field, render, section, shortHash } from "./format.ts"
import type { ModelChoice } from "../model-policy.ts"
import type { MeterReport } from "../usage-meter.ts"
import type { MissionEnvelope } from "../lep/generated.ts"

/**
 * La vue de mission — `SPEC_V1.md` §23.4.
 *
 * « L'UI affiche task/attempt IDs, environnement, sandbox, ressources, provider/modèle et coûts
 * afin que l'utilisateur **distingue clairement l'inférence distante du calcul local**. »
 *
 * Cette dernière proposition est la raison d'être du fichier. Tout le reste — identifiants,
 * environnement, budget — se lit ailleurs si besoin ; ce qui ne se lit nulle part ailleurs, c'est
 * où sont parties les données. Un modèle rendu sans cette mention laisse l'utilisateur supposer
 * ce qui l'arrange, et ce qui arrange est toujours « c'est resté chez moi ».
 *
 * La vue applique donc la même règle que `model-policy.ts` : un modèle dont le manifeste ne dit
 * pas qu'il est local est affiché **distant**. Le défaut prudent coûte au pire une mention en trop ;
 * le défaut commode fait croire qu'une donnée confidentielle n'a pas bougé.
 */

export type MissionViewInput = {
  readonly mission: MissionEnvelope
  readonly attemptState?: string
  readonly models?: readonly ModelChoice[]
  readonly budget?: MeterReport
  /** Le nom d'affichage de l'environnement, quand il est connu autrement que par son identifiant. */
  readonly environmentLabel?: string
}

/** L'étiquette d'un modèle. Deux mots, et jamais un troisième qui ferait douter. */
export function inferenceLabel(choice: ModelChoice): string {
  return choice.remote ? "inférence distante" : "calcul local"
}

/**
 * Rendre une mission.
 *
 * Rend un tableau de lignes plutôt qu'une chaîne : un appelant qui veut paginer, colorer ou
 * réordonner n'a pas à redécouper un bloc de texte, et un test peut viser une ligne.
 */
export function renderMission(input: MissionViewInput): readonly string[] {
  const { mission } = input
  const lines: string[] = []

  lines.push(...section("Mission"))
  lines.push(field("task", mission.task_id))
  // `attempt_id` et non un rang : §11.1 en fait deux choses distinctes, et les confondre à
  // l'affichage ferait chercher un doublon là où il y a un résultat tardif.
  lines.push(field("attempt", mission.attempt_id))
  lines.push(field("branche", mission.branch_id))
  lines.push(field("état", input.attemptState))
  lines.push(field("objectif", mission.objective?.statement))
  lines.push(field("contrat de sortie", mission.output_contract))
  lines.push(field("échéance", mission.deadline))

  lines.push("")
  lines.push(...section("Contexte et environnement"))
  lines.push(field("vue de contexte", mission.context_view?.id))
  // Le hash, pas le contenu : §25.4. Et le préfixe d'algorithme survit à la troncature.
  lines.push(field("empreinte de vue", shortHash(mission.context_view?.hash)))
  lines.push(field("environnement", input.environmentLabel ?? mission.environment?.environment_id))
  lines.push(field("image", shortHash(mission.environment?.image_digest)))
  lines.push(field("outils", mission.environment?.toolchains))

  lines.push("")
  lines.push(...section("Sandbox et ressources"))
  const sandbox = mission.sandbox as unknown as Record<string, unknown> | undefined
  lines.push(field("niveau minimal", sandbox?.["minimum_level"]))
  lines.push(field("réseau", sandbox?.["network"]))
  const resources = mission.resources as unknown as Record<string, unknown> | undefined
  lines.push(field("cpu", resources?.["cpu"]))
  lines.push(field("mémoire (Mo)", resources?.["memory_mb"]))
  lines.push(field("accélérateur", (resources?.["accelerator"] as Record<string, unknown> | undefined)?.["type"]))
  lines.push(field("plafond de confidentialité", mission.confidentiality_ceiling))

  lines.push("")
  lines.push(...section("Modèles"))
  lines.push(...renderModels(input.models))

  lines.push("")
  lines.push(...section("Budget"))
  lines.push(...renderBudget(input.budget))

  return lines
}

/**
 * Les modèles, chacun avec sa provenance — le cœur de §23.4.
 *
 * Une liste vide se dit « aucun modèle déclaré », pas rien : une section muette se lit comme une
 * section sans problème.
 */
export function renderModels(models: readonly ModelChoice[] | undefined): readonly string[] {
  if (models === undefined) return [bullet(`modèles : ${UNKNOWN}`)]
  if (models.length === 0) return [bullet("aucun modèle déclaré utilisable pour cette classe de données")]
  return models.map((choice) => bullet(`${choice.provider} — ${render(choice.models)} — ${inferenceLabel(choice)}`))
}

/**
 * Le budget — §17.
 *
 * La marche d'escalade est affichée telle quelle, y compris `nominal`, parce que « tout va bien »
 * et « je n'ai pas mesuré » doivent se distinguer à l'écran comme dans le code. Les divergences de
 * §17.3 y figurent : un budget rendu sans elles transmet un chiffre en laissant croire qu'il est
 * sûr.
 */
export function renderBudget(report: MeterReport | undefined): readonly string[] {
  if (report === undefined) return [bullet(`budget : ${UNKNOWN} — aucune mesure disponible`)]
  const lines = [field("marche", report.stage)]
  const totals = Object.entries(report.totals)
  lines.push(
    ...(totals.length === 0
      ? [bullet("aucune dimension mesurée")]
      : totals.map(([k, v]) => bullet(`${k} : ${render(v)}`))),
  )
  if (report.exceeded.length > 0) lines.push(field("au plafond", [...report.exceeded]))
  for (const divergence of report.divergences) {
    lines.push(
      bullet(
        `divergence sur ${divergence.dimension} : estimé ${divergence.estimated}, facturé ${divergence.billed} (×${divergence.ratio.toFixed(2)})`,
      ),
    )
  }
  return lines
}
