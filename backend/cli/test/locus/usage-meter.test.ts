import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  BUDGET_DIMENSIONS,
  ESCALATION_STAGES,
  STAGE_THRESHOLDS,
  UsageMeter,
  budgetUsagePayload,
  confidenceOf,
  stageFor,
  type Budget,
  type Usage,
} from "../../src/locus/usage-meter.ts"

function usage(over: Partial<Usage> & Pick<Usage, "dimension" | "observed">): Usage {
  return { source: "fournisseur", kind: "estimated", ...over }
}

const BUDGET: Budget = { model_calls: 10, cost: 100, output_tokens: 1000 }

describe("arrêt propre au dépassement — le test de sortie de W2.13", () => {
  test("au plafond, le worker n'engage plus de dépense", () => {
    const meter = new UsageMeter(BUDGET)
    for (let i = 0; i < 9; i += 1) meter.record(usage({ dimension: "model_calls", observed: 1 }))
    expect(meter.allowsNewSpend()).toBe(true)

    meter.record(usage({ dimension: "model_calls", observed: 1 }))
    // §17.4 : « arrêt sûr AU plafond » — donc exactement 1, pas au-delà.
    expect(meter.ratio("model_calls")).toBe(1)
    expect(meter.report().stage).toBe("stop")
    expect(meter.allowsNewSpend()).toBe(false)
    expect(meter.report().exceeded).toEqual(["model_calls"])
  })

  test("l'échelle de §17.4 est montée dans l'ordre, sans marche sautée", () => {
    const meter = new UsageMeter({ cost: 100 })
    const seen: string[] = []
    for (let spent = 0; spent <= 100; spent += 5) {
      const stage = meter.report().stage
      if (seen[seen.length - 1] !== stage) seen.push(stage)
      meter.record(usage({ dimension: "cost", observed: 5 }))
    }
    // L'échelle entière, dans l'ordre du texte et sans marche sautée — `stop` compris, puisque la
    // dernière lecture a lieu une fois le plafond atteint.
    expect(seen).toEqual([...ESCALATION_STAGES])
    expect(meter.report().stage).toBe("stop")
  })

  test("une dimension sans plafond ne déclenche rien, et ne masque pas les autres", () => {
    // `ratio` rend `null` : « pas de plafond » et « taux nul » ne doivent pas se ressembler.
    const meter = new UsageMeter({ cost: 10 })
    meter.record(usage({ dimension: "bandwidth_mb", observed: 10_000 }))
    expect(meter.ratio("bandwidth_mb")).toBeNull()
    expect(meter.report().stage).toBe("nominal")

    meter.record(usage({ dimension: "cost", observed: 10 }))
    expect(meter.report().stage).toBe("stop")
  })

  test("la marche retenue est celle de la dimension la plus avancée", () => {
    // Le budget le plus contraint décide : moyenner ou prendre la première laisserait dépasser
    // celle qui compte.
    const meter = new UsageMeter({ model_calls: 100, cost: 10 })
    meter.record(usage({ dimension: "model_calls", observed: 1 }))
    meter.record(usage({ dimension: "cost", observed: 10 }))
    expect(meter.report().stage).toBe("stop")
  })
})

describe("les onze plafonds de §17.1", () => {
  test("les dimensions du texte sont là, sans doublon", () => {
    expect(BUDGET_DIMENSIONS.length).toBe(11)
    expect(new Set(BUDGET_DIMENSIONS).size).toBe(11)
    for (const dimension of ["model_calls", "input_tokens", "cost", "wall_time_seconds", "subagents"] as const) {
      expect(BUDGET_DIMENSIONS).toContain(dimension)
    }
  })

  test("les seuils sont ordonnés et `stop` vaut exactement 1", () => {
    // Seul `stop` est imposé par le texte : « arrêt sûr AU plafond ». Le reste est une politique,
    // et elle vit en table pour être discutée d'un seul endroit.
    expect(STAGE_THRESHOLDS[0]?.stage).toBe("stop")
    expect(STAGE_THRESHOLDS[0]?.at).toBe(1)
    for (let i = 1; i < STAGE_THRESHOLDS.length; i += 1) {
      expect(STAGE_THRESHOLDS[i]!.at).toBeLessThan(STAGE_THRESHOLDS[i - 1]!.at)
    }
    expect(stageFor(0)).toBe("nominal")
    expect(stageFor(0.8)).toBe("reduce-optional")
    expect(stageFor(2)).toBe("stop")
  })

  test("`nominal` est un état nommé, pas une absence", () => {
    // Le représenter par l'absence de marche rendrait « rien à faire » et « je ne sais pas »
    // identiques.
    expect(ESCALATION_STAGES[0]).toBe("nominal")
    expect(ESCALATION_STAGES).toContain("stop")
  })
})

describe("estimation et rapprochement — §17.3", () => {
  test("le facturé remplace l'estimé sur une même requête", () => {
    // Les additionner compterait deux fois la même dépense.
    const meter = new UsageMeter({ cost: 100 })
    meter.record(usage({ dimension: "cost", observed: 10, kind: "estimated", provider_request_id: "req-1" }))
    meter.record(usage({ dimension: "cost", observed: 12, kind: "billed", provider_request_id: "req-1" }))
    expect(meter.totals().cost).toBe(12)
  })

  test("sans identifiant de requête, les deux s'additionnent", () => {
    // Comportement prudent : deux chiffres sans lien ne parlent pas forcément de la même dépense,
    // et sous-compter un budget est pire que le sur-compter.
    const meter = new UsageMeter({ cost: 100 })
    meter.record(usage({ dimension: "cost", observed: 10, kind: "estimated" }))
    meter.record(usage({ dimension: "cost", observed: 12, kind: "billed" }))
    expect(meter.totals().cost).toBe(22)
  })

  test("une divergence est signalée, jamais masquée", () => {
    // §17.3 : « les divergences sont signalées, jamais masquées ». Les réconcilier en silence —
    // prendre le plus grand, moyenner — ferait disparaître l'information qui dit que la mesure est
    // fausse quelque part.
    const meter = new UsageMeter({ cost: 100 })
    meter.record(usage({ dimension: "cost", observed: 10, kind: "estimated", provider_request_id: "req-1" }))
    meter.record(usage({ dimension: "cost", observed: 25, kind: "billed", provider_request_id: "req-1" }))

    const divergences = meter.divergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]?.estimated).toBe(10)
    expect(divergences[0]?.billed).toBe(25)
    expect(divergences[0]?.ratio).toBe(2.5)
  })

  test("un écart dans la tolérance n'est pas un signal", () => {
    // Signaler chaque centime d'arrondi noierait les vraies divergences.
    const meter = new UsageMeter({ cost: 100 })
    meter.record(usage({ dimension: "cost", observed: 100, kind: "estimated", provider_request_id: "r" }))
    meter.record(usage({ dimension: "cost", observed: 102, kind: "billed", provider_request_id: "r" }))
    expect(meter.divergences()).toEqual([])
  })

  test("une confiance absente vaut faible, pas certaine", () => {
    // Un chiffre sans confiance déclarée est un chiffre dont personne n'a dit ce qu'il vaut ; le
    // traiter comme certain ferait décider un arrêt sur une mesure que rien n'étaye.
    expect(confidenceOf(usage({ dimension: "cost", observed: 1 }))).toBe(0.5)
    expect(confidenceOf(usage({ dimension: "cost", observed: 1, confidence: 0.9 }))).toBe(0.9)
  })

  test("le rapport `budget.usage` transporte les divergences", () => {
    // Un rapport qui tairait un écart transmettrait un chiffre en laissant croire qu'il est sûr.
    const meter = new UsageMeter({ cost: 100 })
    meter.record(usage({ dimension: "cost", observed: 10, kind: "estimated", provider_request_id: "r" }))
    meter.record(usage({ dimension: "cost", observed: 40, kind: "billed", provider_request_id: "r" }))
    const payload = budgetUsagePayload(meter.report())
    expect(payload["stage"]).toBe("nominal")
    expect((payload["divergences"] as unknown[]).length).toBe(1)
  })
})

describe("source de vérité — §17.2", () => {
  test("le worker émet des observations, pas des soldes", () => {
    const meter = new UsageMeter(BUDGET)
    meter.record(usage({ dimension: "cost", observed: 3, source: "anthropic", currency: "USD" }))
    const observations = meter.observations()
    expect(observations).toHaveLength(1)
    expect(observations[0]?.source).toBe("anthropic")
    // La devise vient du fournisseur, jamais supposée.
    expect(observations[0]?.currency).toBe("USD")
  })

  test("aucune fonction n'écrit un solde", () => {
    // « Locus Solus conserve le ledger canonique. Canterel émet des observations signées, pas des
    // écritures directes de solde. » Offrir une telle fonction offrirait le moyen de contourner
    // exactement ce que §17.2 protège.
    const module = require("../../src/locus/usage-meter.ts") as Record<string, unknown>
    for (const forbidden of ["setBalance", "writeBalance", "debit", "credit", "applyLedger"]) {
      expect(module[forbidden]).toBeUndefined()
    }
    const source = readFileSync(join(import.meta.dir, "../../src/locus/usage-meter.ts"), "utf8")
    expect(source).not.toContain("balance =")
  })
})
