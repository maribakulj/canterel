/**
 * Budget local et mesure d'usage — `SPEC_V1.md` §17.
 *
 * Deux phrases gouvernent ce module, et elles tirent dans des directions différentes.
 *
 * §17.2 : « Locus Solus conserve le ledger canonique. Canterel émet des **observations signées**,
 * pas des écritures directes de solde. » Ce module compte donc pour **décider localement**, et ce
 * qu'il produit vers le serveur est une observation — jamais un solde. Il n'existe volontairement
 * aucune fonction qui écrive un solde, et un test vérifie l'absence de ces noms.
 *
 * §17.3 : « Les divergences sont signalées, jamais masquées. » Quand une estimation et un montant
 * facturé ne concordent pas, le module rend un écart. Le réconcilier en silence — prendre le plus
 * grand, moyenner, préférer le facturé — ferait disparaître l'information qui dit que la mesure
 * est fausse quelque part.
 */

/** Les plafonds de §17.1, dans l'ordre du texte. */
export const BUDGET_DIMENSIONS = [
  "model_calls",
  "input_tokens",
  "output_tokens",
  "cost",
  "wall_time_seconds",
  "cpu_seconds",
  "gpu_seconds",
  "storage_mb",
  "bandwidth_mb",
  "tool_calls",
  "subagents",
] as const

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number]

/** Un plafond par dimension. Une dimension absente n'est pas mesurée ici. */
export type Budget = Partial<Record<BudgetDimension, number>>

/** Une observation, avec tout ce que §17.3 exige qu'elle porte. */
export type Usage = {
  readonly dimension: BudgetDimension
  readonly observed: number
  /** D'où vient le chiffre : le fournisseur, une horloge locale, un compteur interne. */
  readonly source: string
  /** Estimé ou facturé — §17.3 les distingue, et le module aussi. */
  readonly kind: "estimated" | "billed"
  /** Devise **fournie par le fournisseur**, jamais supposée. */
  readonly currency?: string
  /** Niveau de confiance, entre 0 et 1. Absent vaut faible, voir `confidenceOf`. */
  readonly confidence?: number
  readonly provider_request_id?: string
}

/**
 * L'échelle de §17.4, dans l'ordre du texte.
 *
 * `nominal` n'y figure pas explicitement : c'est l'état avant la première marche, et le nommer
 * évite de le représenter par l'absence de marche — ce qui rendrait « rien à faire » et « je ne
 * sais pas » identiques.
 */
export const ESCALATION_STAGES = ["nominal", "reduce-optional", "checkpoint", "request-extension", "stop"] as const

export type EscalationStage = (typeof ESCALATION_STAGES)[number]

/**
 * Les seuils qui déclenchent chaque marche.
 *
 * §17.4 dit « à l'approche du plafond » sans chiffrer. Les valeurs sont donc une **politique**, pas
 * une lecture de la spec : elles vivent ici en table pour être discutées et changées d'un endroit,
 * plutôt que dispersées dans des comparaisons. Seul `stop` est imposé par le texte — « arrêt sûr
 * **au** plafond », donc exactement 1.
 */
export const STAGE_THRESHOLDS: readonly { readonly at: number; readonly stage: EscalationStage }[] = [
  { at: 1, stage: "stop" },
  { at: 0.95, stage: "request-extension" },
  { at: 0.85, stage: "checkpoint" },
  { at: 0.75, stage: "reduce-optional" },
]

/** La marche correspondant à un taux d'utilisation. */
export function stageFor(ratio: number): EscalationStage {
  return STAGE_THRESHOLDS.find((entry) => ratio >= entry.at)?.stage ?? "nominal"
}

/**
 * La confiance d'une observation.
 *
 * Absente vaut **0.5**, pas 1. Un chiffre sans confiance déclarée n'est pas un chiffre certain :
 * c'est un chiffre dont personne n'a dit ce qu'il vaut, et le traiter comme certain ferait décider
 * un arrêt sur une mesure que rien n'étaye.
 */
export function confidenceOf(usage: Usage): number {
  return typeof usage.confidence === "number" ? usage.confidence : 0.5
}

/** Un écart entre estimation et facturation — §17.3, signalé et jamais masqué. */
export type Divergence = {
  readonly dimension: BudgetDimension
  readonly estimated: number
  readonly billed: number
  readonly ratio: number
  readonly provider_request_id?: string
}

export type MeterReport = {
  readonly totals: Partial<Record<BudgetDimension, number>>
  /** La marche atteinte, celle de la dimension la plus avancée. */
  readonly stage: EscalationStage
  /** Les dimensions au plafond ou au-delà. */
  readonly exceeded: readonly BudgetDimension[]
  readonly divergences: readonly Divergence[]
}

/**
 * Le compteur d'usage.
 *
 * Il **compte** et il **décide localement** ; il n'écrit aucun solde. Ce qui sort vers le serveur
 * passe par `observations()`, et ce sont des observations au sens de §17.2.
 */
export class UsageMeter {
  private readonly usages: Usage[] = []

  constructor(private readonly budget: Budget) {}

  record(usage: Usage): void {
    this.usages.push(usage)
  }

  /**
   * Le total par dimension.
   *
   * Le **facturé remplace l'estimé** pour une même requête fournisseur : additionner les deux
   * compterait deux fois la même dépense. En l'absence d'identifiant de requête, les deux
   * s'additionnent — c'est le comportement prudent, et la divergence est signalée à part.
   */
  totals(): Partial<Record<BudgetDimension, number>> {
    const billedRequests = new Set(
      this.usages
        .filter((usage) => usage.kind === "billed" && usage.provider_request_id !== undefined)
        .map((usage) => usage.provider_request_id),
    )
    const out: Partial<Record<BudgetDimension, number>> = {}
    for (const usage of this.usages) {
      const superseded =
        usage.kind === "estimated" &&
        usage.provider_request_id !== undefined &&
        billedRequests.has(usage.provider_request_id)
      if (superseded) continue
      out[usage.dimension] = (out[usage.dimension] ?? 0) + usage.observed
    }
    return out
  }

  /** Le taux d'utilisation d'une dimension, ou `null` quand elle n'a pas de plafond. */
  ratio(dimension: BudgetDimension): number | null {
    const ceiling = this.budget[dimension]
    if (ceiling === undefined || ceiling <= 0) return null
    return (this.totals()[dimension] ?? 0) / ceiling
  }

  /**
   * Les écarts entre estimation et facturation — §17.3.
   *
   * Rapprochés par identifiant de requête fournisseur : sans lui, deux chiffres ne parlent pas
   * forcément de la même dépense, et les comparer produirait des écarts imaginaires.
   */
  divergences(tolerance = 0.05): readonly Divergence[] {
    const byRequest = new Map<string, { estimated?: Usage; billed?: Usage }>()
    for (const usage of this.usages) {
      const id = usage.provider_request_id
      if (id === undefined) continue
      const slot = byRequest.get(id) ?? {}
      slot[usage.kind] = usage
      byRequest.set(id, slot)
    }

    const out: Divergence[] = []
    for (const [id, pair] of byRequest) {
      if (!pair.estimated || !pair.billed) continue
      if (pair.estimated.dimension !== pair.billed.dimension) continue
      const estimated = pair.estimated.observed
      const billed = pair.billed.observed
      if (estimated === billed) continue
      const ratio = estimated === 0 ? Number.POSITIVE_INFINITY : billed / estimated
      if (Math.abs(ratio - 1) <= tolerance) continue
      out.push({ dimension: pair.billed.dimension, estimated, billed, ratio, provider_request_id: id })
    }
    return out
  }

  /** L'état complet, en un appel. */
  report(): MeterReport {
    const totals = this.totals()
    const exceeded: BudgetDimension[] = []
    let worst: EscalationStage = "nominal"

    for (const dimension of BUDGET_DIMENSIONS) {
      const ratio = this.ratio(dimension)
      if (ratio === null) continue
      const stage = stageFor(ratio)
      if (ESCALATION_STAGES.indexOf(stage) > ESCALATION_STAGES.indexOf(worst)) worst = stage
      if (ratio >= 1) exceeded.push(dimension)
    }

    return { totals, stage: worst, exceeded, divergences: this.divergences() }
  }

  /**
   * Ce que le worker a encore le droit de faire.
   *
   * `false` au plafond, pour tout ce qui coûte. §17.4 dit « arrêt **sûr** au plafond » : sûr veut
   * dire que ce qui est déjà engagé se termine proprement, pas que rien de nouveau ne démarre —
   * d'où la distinction entre engager une dépense et clôturer ce qui existe.
   */
  allowsNewSpend(): boolean {
    return this.report().stage !== "stop"
  }

  /**
   * Les observations à émettre — §17.2.
   *
   * Le nom compte : ce sont des **observations**, pas des écritures. Le serveur en fait ce qu'il
   * veut ; le worker n'a pas d'opinion sur le solde qui en résulte.
   */
  observations(): readonly Usage[] {
    return [...this.usages]
  }
}

/**
 * La charge d'un événement `budget.usage` — §17.4, première marche.
 *
 * Porte la marche atteinte et les divergences, parce qu'un rapport d'usage qui tairait un écart
 * entre estimé et facturé transmettrait un chiffre en laissant croire qu'il est sûr.
 */
export function budgetUsagePayload(report: MeterReport): Record<string, unknown> {
  return {
    stage: report.stage,
    totals: report.totals,
    exceeded: [...report.exceeded],
    divergences: report.divergences.map((entry) => ({ ...entry })),
  }
}
