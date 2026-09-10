import { describe, expect, test } from "bun:test"
import { UsageMeter } from "../../src/locus/usage-meter.ts"
import { budgetOf } from "../../src/locus/session-map.ts"
import { usagesOf, question } from "../../src/cli/cmd/worker-run.ts"
import type { MessageV2 } from "../../src/session/message-v2.ts"

/**
 * **Le test de sortie : un budget dépassé s'oppose, il ne se constate pas.**
 *
 * Le point de contrôle du worker écrivait `budget_spent: {}` en dur, et `UsageMeter` — complet,
 * testé — n'était construit nulle part. Les trois bornes d'une mission voyageaient donc jusqu'au
 * worker, qui les acquittait et renvoyait zéro : un plafond ne pouvait pas se déclencher, quel que
 * soit ce qui avait été dépensé.
 *
 * Ce qui est éprouvé ici est la chaîne entière **sans modèle** : les bornes de l'enveloppe
 * deviennent celles du compteur, un message assistant devient des observations, et le compteur
 * franchit `stop` au plafond. Ce qui ne peut pas l'être ici est l'annulation elle-même, qui demande
 * une session vivante ; elle est mesurée contre un vrai fournisseur, pas simulée — une simulation
 * dirait seulement que j'ai écrit `cancel` là où je crois l'avoir écrit.
 */

function assistant(over: { input?: number; output?: number; reasoning?: number; cost?: number; id?: string }) {
  return {
    id: over.id ?? "msg_01",
    role: "assistant",
    sessionID: "ses_01",
    providerID: "mistral",
    modelID: "mistral-small",
    tokens: {
      input: over.input ?? 0,
      output: over.output ?? 0,
      reasoning: over.reasoning ?? 0,
      cache: { read: 0, write: 0 },
    },
    cost: over.cost ?? 0,
  } as unknown as MessageV2.Assistant
}

const BORNES = { max_model_calls: 3, max_input_tokens: 1000, max_output_tokens: 500 }

describe("le budget d'une mission est opposable", () => {
  test("les trois bornes de l'enveloppe deviennent celles du compteur", () => {
    // Les noms diffèrent des deux côtés — `max_model_calls` contre `model_calls` — et la traduction
    // vit en un seul endroit. Deux vocabulaires qui se rencontreraient au point d'usage
    // divergeraient au premier appelant qui oublierait un champ.
    expect(budgetOf(BORNES)).toEqual({ model_calls: 3, input_tokens: 1000, output_tokens: 500 })
  })

  test("un coût facultatif absent ne devient pas un plafond inventé", () => {
    // `max_cost_micros` est optionnel dans l'enveloppe. Lui donner une valeur par défaut créerait
    // une borne que personne n'a demandée — et, selon le sens de l'arrondi, un arrêt surprise ou un
    // plafond qui ne se déclenche jamais.
    expect(budgetOf(BORNES).cost).toBeUndefined()
    expect(budgetOf({ ...BORNES, max_cost_micros: 2_500_000 }).cost).toBe(2.5)
  })

  test("un message assistant rend quatre observations, pas une", () => {
    // §17.1 borne les dimensions séparément : un budget épuisé côté entrée pendant que la sortie a
    // de la marge ne se répare pas comme un budget épuisé partout.
    const usages = usagesOf(assistant({ input: 120, output: 30, reasoning: 10, cost: 0.004 }))
    expect(usages.map((u) => u.dimension)).toEqual(["model_calls", "input_tokens", "output_tokens", "cost"])
    // Le raisonnement compte avec la sortie : il est produit et facturé comme tel, et le ranger
    // ailleurs ferait un plafond de sortie qu'un modèle « thinking » ne toucherait jamais.
    expect(usages.find((u) => u.dimension === "output_tokens")?.observed).toBe(40)
  })

  test("les observations viennent du payeur, et le disent", () => {
    // `confidenceOf` vaut 0,5 par défaut — « personne n'a dit ce que ce chiffre vaut ». Ces
    // chiffres-là viennent du fournisseur ; les laisser au défaut prudent ferait décider un arrêt
    // sur une mesure qu'on tient pourtant de qui facture.
    for (const usage of usagesOf(assistant({ input: 1 }))) {
      expect(usage.kind).toBe("billed")
      expect(usage.confidence).toBe(1)
      expect(usage.provider_request_id).toBe("msg_01")
    }
  })

  test("**le test de sortie** : au plafond, le compteur dit `stop`", () => {
    const meter = new UsageMeter(budgetOf(BORNES))
    // Deux appels sous le plafond : rien ne s'oppose encore.
    for (const [i, jetons] of [200, 200].entries()) {
      for (const usage of usagesOf(assistant({ id: `msg_0${i}`, input: jetons }))) meter.record(usage)
    }
    expect(meter.report().stage).not.toBe("stop")
    expect(meter.allowsNewSpend()).toBe(true)

    // Le troisième atteint `max_model_calls`. §17.4 : « arrêt sûr **au** plafond », donc à 3 sur 3
    // et non à 4.
    for (const usage of usagesOf(assistant({ id: "msg_02", input: 200 }))) meter.record(usage)
    const rapport = meter.report()
    expect(rapport.stage).toBe("stop")
    expect(rapport.exceeded).toContain("model_calls")
    expect(meter.allowsNewSpend()).toBe(false)
  })

  test("une dimension dépassée suffit, même si les autres ont de la marge", () => {
    // C'est le cas qui compte pour une mission longue : les appels restent rares et les jetons
    // d'entrée explosent, parce que le contexte grossit à chaque tour.
    const meter = new UsageMeter(budgetOf(BORNES))
    for (const usage of usagesOf(assistant({ input: 1200 }))) meter.record(usage)
    const rapport = meter.report()
    expect(rapport.exceeded).toEqual(["input_tokens"])
    expect(rapport.stage).toBe("stop")
  })

  test("la question posée porte les conditions de succès", () => {
    // §15.4 en fait une partie de l'objectif : les taire demanderait à l'agent de deviner à quoi on
    // reconnaîtra que la mission est traitée.
    const texte = question({ objective: { statement: "Trouver X", successConditions: ["X est daté", "X est cité"] } })
    expect(texte).toContain("Trouver X")
    expect(texte).toContain("- X est daté")
    expect(texte).toContain("- X est cité")
  })

  test("sans condition de succès, la question reste la question", () => {
    // Pas de section vide : un titre « Conditions de succès : » suivi de rien se lit comme une
    // consigne perdue, et c'est le genre de bruit qu'un modèle interprète.
    expect(question({ objective: { statement: "Trouver X", successConditions: [] } })).toBe("Trouver X")
  })
})
