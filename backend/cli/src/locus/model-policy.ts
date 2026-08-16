import type { CapabilityManifest, CapabilityManifestModelsItem, DataClass } from "./lep/generated.ts"
import { classRank } from "./context-materializer.ts"

/**
 * Quels modèles une mission a le droit d'employer — `SPEC_V1.md` §21.9 et docs/08.
 *
 * La règle qui gouverne ce module est écrite dans le SDK lui-même, sur `remote_inference` :
 * « vrai quand les prompts quittent la machine. C'est ce qui décide si une classe de données peut
 * être traitée par ce modèle. » Le reste en découle mécaniquement — et c'est le producteur du code
 * `model_unavailable` que W2.8 avait déclaré sans encore le lever.
 */

/** Au-delà de cette classe, un modèle dont les prompts sortent de la machine est exclu. */
export const REMOTE_INFERENCE_CEILING: DataClass = "internal"

export type ModelChoice = {
  readonly provider: string
  readonly models: readonly string[]
  readonly remote: boolean
}

/**
 * Les modèles utilisables pour une classe de données donnée.
 *
 * Un modèle sans `remote_inference` déclaré est traité comme **distant**. Le champ est optionnel
 * dans le schéma, et supposer « local » par défaut ferait envoyer des données confidentielles à un
 * fournisseur au premier manifeste incomplet. Le défaut prudent coûte au pire un modèle inutilisé ;
 * le défaut commode coûte une fuite.
 */
export function usableModels(manifest: CapabilityManifest, klass: DataClass | undefined): readonly ModelChoice[] {
  const declared = manifest.models ?? []
  const ceiling = classRank(REMOTE_INFERENCE_CEILING)
  const rank = klass === undefined ? -1 : classRank(klass)

  return declared
    .filter((entry) => rank <= ceiling || !isRemote(entry))
    .map((entry) => ({
      provider: entry.provider,
      models: [...(entry.models ?? [])],
      remote: isRemote(entry),
    }))
}

function isRemote(entry: CapabilityManifestModelsItem): boolean {
  return entry.remote_inference !== false
}

/**
 * Pourquoi aucun modèle n'est utilisable, quand c'est le cas.
 *
 * Distingue « ce worker n'a aucun modèle » de « ses modèles sont tous distants et la mission est
 * trop sensible ». Le second est une information exploitable — l'opérateur sait quoi installer —
 * alors qu'un « aucun modèle disponible » commun ne dit rien.
 */
export function modelUnavailableReason(manifest: CapabilityManifest, klass: DataClass | undefined): string | null {
  if (usableModels(manifest, klass).length > 0) return null
  const declared = manifest.models ?? []
  if (declared.length === 0) return "ce worker n'annonce aucun modèle"
  return (
    `classe ${klass} : tous les modèles annoncés font sortir les prompts de la machine ` +
    `(plafond ${REMOTE_INFERENCE_CEILING})`
  )
}
