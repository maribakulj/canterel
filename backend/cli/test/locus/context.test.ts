import { describe, expect, test } from "bun:test"

import {
  applyRedactions,
  assertViewIntegrity,
  classRank,
  materialize,
  requestExtension,
  viewContentHash,
  type ContextItem,
} from "../../src/locus/context-materializer.ts"
import type { ContextView } from "../../src/locus/lep/generated.ts"
import { LocusContextRefused } from "../../src/locus/errors.ts"
import { PROTOCOL_VERSION } from "../../src/locus/protocol.ts"

void PROTOCOL_VERSION

/** Une vue scellée : le hash est calculé, jamais écrit à la main. */
function viewOf(over: Partial<ContextView> = {}): ContextView {
  const draft = {
    id: "view-1",
    confidentiality_ceiling: "internal",
    source_event_watermark: 100,
    generated_at: "2026-08-16T10:00:00.000Z",
    ...over,
    content_hash: "sha256:placeholder",
  } as ContextView
  return { ...draft, content_hash: viewContentHash(draft) } as ContextView
}

function item(over: Partial<ContextItem> & { id: string }): ContextItem {
  return over
}

describe("isolation de branche — le test de sortie de W2.10", () => {
  test("une vue de branche A est refusée en bloc pour une mission de branche B", () => {
    // La première version de ce test filtrait élément par élément et laissait passer les éléments
    // de A « parce que A est dans la portée ». C'était faire de la portée une AUTORISATION, soit
    // l'exact inverse de son rôle — la même faute que W2.8 refuse pour la politique locale. Le
    // schéma est plus fort que ça : c'est la vue entière qui n'a rien à faire ici.
    const view = viewOf({ branch_scope: ["branch-A"] })
    try {
      materialize({
        view,
        missionBranch: "branch-B",
        items: [item({ id: "de-A", branch_id: "branch-A" })],
      })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusContextRefused.isInstance(error)).toBe(true)
      const data = (error as InstanceType<typeof LocusContextRefused>).data
      expect(data.view_id).toBe("view-1")
      expect(data.reason).toContain("branch-A")
      expect(data.reason).toContain("branch-B")
    }
  })

  test("une exclusion est rapportée, jamais silencieuse", () => {
    // Un contexte amputé sans que personne le sache produit un raisonnement dont on ne saura pas
    // qu'il était aveugle.
    const view = viewOf({ branch_scope: ["branch-A"] })
    const result = materialize({
      view,
      missionBranch: "branch-A",
      items: [item({ id: "x", branch_id: "branch-Z" })],
    })
    expect(result.excluded[0]?.reason).toBe("branch-isolation")
    expect(result.excluded[0]?.detail).toContain("branch-Z")
    expect(result.excluded[0]?.detail).toContain("branch-A")
  })

  test("sans portée déclarée, seule la branche de la mission passe", () => {
    // Le défaut sûr : une vue non rattachée à une branche ne devient pas pour autant un
    // passe-droit pour les conclusions d'une branche concurrente (§12.4).
    const result = materialize({
      view: viewOf(),
      missionBranch: "branch-A",
      items: [item({ id: "sienne", branch_id: "branch-A" }), item({ id: "voisine", branch_id: "branch-B" })],
    })
    expect(result.items.map((i) => i.id)).toEqual(["sienne"])
    expect(result.excluded[0]?.detail).toContain("aucune portée ne l'élargit")
  })

  test("un élément sans branche n'est pas autorisé d'office quand la vue en déclare une", () => {
    // Deny-by-default : un élément entre parce qu'une règle l'autorise, pas parce qu'aucune ne
    // l'a exclu. Ici l'élément sans branche passe — la vue ne le rattache à aucune —, mais un
    // élément d'une autre branche ne passe pas même si la portée est large.
    const view = viewOf({ branch_scope: ["branch-A", "branch-C"] })
    const result = materialize({
      view,
      missionBranch: "branch-A",
      items: [
        item({ id: "sans-branche" }),
        item({ id: "portee", branch_id: "branch-C" }),
        item({ id: "hors", branch_id: "branch-D" }),
      ],
    })
    expect(result.items.map((i) => i.id)).toEqual(["sans-branche", "portee"])
    expect(result.excluded.map((e) => e.id)).toEqual(["hors"])
  })
})

describe("les cinq interdits de §12.4", () => {
  const view = () => viewOf({ branch_scope: ["b"] })

  test("le raisonnement privé du générateur n'entre pas dans une revue aveugle", () => {
    // Invariant 11 du projet, énoncé mot pour mot.
    const blind = materialize({
      view: view(),
      missionBranch: "b",
      items: [item({ id: "transcript", private_reasoning: true })],
      blindReview: true,
    })
    expect(blind.excluded[0]?.reason).toBe("private-reasoning")

    // Hors revue aveugle, le même élément est légitime : l'interdit porte sur la situation, pas
    // sur l'objet.
    const open = materialize({
      view: view(),
      missionBranch: "b",
      items: [item({ id: "transcript", private_reasoning: true })],
    })
    expect(open.items.map((i) => i.id)).toEqual(["transcript"])
  })

  test("les conclusions d'une branche concurrente n'entrent pas", () => {
    const result = materialize({
      view: view(),
      missionBranch: "b",
      items: [item({ id: "concurrente", branch_id: "autre" })],
    })
    expect(result.excluded[0]?.reason).toBe("branch-isolation")
  })

  test("la mémoire utilisateur globale n'entre jamais", () => {
    const result = materialize({
      view: view(),
      missionBranch: "b",
      items: [item({ id: "memoire", global_user_memory: true })],
    })
    expect(result.excluded[0]?.reason).toBe("global-user-memory")
  })

  test("un résultat futur n'entre pas", () => {
    // Le watermark est ce qui rend « ce que l'agent pouvait connaître » vérifiable après coup.
    const result = materialize({
      view: viewOf({ source_event_watermark: 100 }),
      missionBranch: "b",
      items: [item({ id: "passe", event_position: 100 }), item({ id: "futur", event_position: 101 })],
    })
    expect(result.items.map((i) => i.id)).toEqual(["passe"])
    expect(result.excluded[0]?.reason).toBe("beyond-watermark")
  })

  test("un secret n'est jamais matérialisé en contexte", () => {
    // Le plus grave des cinq : un secret sous forme de prompt sort de la machine avec le prompt.
    const result = materialize({
      view: view(),
      missionBranch: "b",
      items: [item({ id: "token", secret: true, branch_id: "b" })],
    })
    expect(result.items).toEqual([])
    expect(result.excluded[0]?.reason).toBe("secret-as-prompt")
  })
})

describe("plafond de confidentialité — §21.9", () => {
  test("une classe au-dessus du plafond est écartée", () => {
    const view = viewOf({ confidentiality_ceiling: "internal" })
    const result = materialize({
      view,
      missionBranch: "b",
      items: [
        item({ id: "public", confidentiality: "public" }),
        item({ id: "interne", confidentiality: "internal" }),
        item({ id: "confidentiel", confidentiality: "confidential" }),
      ],
    })
    expect(result.items.map((i) => i.id)).toEqual(["public", "interne"])
    expect(result.excluded[0]?.reason).toBe("confidentiality-ceiling")
  })

  test("une classe inconnue est traitée comme au-dessus du plafond", () => {
    // Ne pas savoir classer n'autorise pas à laisser passer.
    expect(classRank("inconnue")).toBe(-1)
    const result = materialize({
      view: viewOf(),
      missionBranch: "b",
      items: [item({ id: "?", confidentiality: "top-secret" as never })],
    })
    expect(result.excluded[0]?.reason).toBe("confidentiality-ceiling")
  })
})

describe("intégrité de la vue — §12.3", () => {
  test("une vue scellée passe", () => {
    expect(() => assertViewIntegrity(viewOf())).not.toThrow()
  })

  test("une vue altérée est refusée avant tout filtrage", () => {
    // Filtrer d'abord reviendrait à faire confiance au document qui décrit ce à quoi on a droit.
    const tampered = { ...viewOf({ branch_scope: ["a"] }), branch_scope: ["a", "b"] } as ContextView
    try {
      materialize({ view: tampered, missionBranch: "a", items: [] })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusContextRefused.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusContextRefused>).data.view_id).toBe("view-1")
    }
  })

  test("le hash ne se couvre pas lui-même", () => {
    // L'inclure dans son propre calcul le rendrait invérifiable.
    const view = viewOf()
    const rehashed = viewContentHash({ ...view, content_hash: "sha256:autre-chose" } as ContextView)
    expect(rehashed).toBe(view.content_hash)
  })

  test("deux vues au contenu identique ont la même empreinte", () => {
    expect(viewContentHash(viewOf({ query: "x" }))).toBe(viewContentHash(viewOf({ query: "x" })))
    expect(viewContentHash(viewOf({ query: "x" }))).not.toBe(viewContentHash(viewOf({ query: "y" })))
  })
})

describe("rédactions et extension", () => {
  test("une rédaction laisse une trace qui porte sa raison", () => {
    // Effacer sans trace ferait lire un texte dont l'agent ne saurait pas qu'il est amputé.
    const view = viewOf({ redactions: [{ target: "SECRET-42", reason: "identifiant patient" }] })
    const out = applyRedactions("le dossier SECRET-42 montre", view)
    expect(out).not.toContain("SECRET-42")
    expect(out).toContain("identifiant patient")
  })

  test("le worker demande une extension, il ne se l'accorde pas", () => {
    // §12.4 : « tout accès additionnel nécessite `context.extension_requested` puis une décision
    // Locus Solus ». Offrir un `grantExtension()` local offrirait le moyen de contourner
    // exactement ce que ce module protège.
    const request = requestExtension({
      viewId: "view-1",
      taskId: "task-1",
      wanted: ["obj-9"],
      justification: "prémisse citée mais absente",
    })
    expect(request["event_type"]).toBe("context.extension_requested")
    expect(request["requested_ids"]).toEqual(["obj-9"])

    const module = require("../../src/locus/context-materializer.ts") as Record<string, unknown>
    for (const forbidden of ["grantExtension", "allowExtension", "extendContext"]) {
      expect(module[forbidden]).toBeUndefined()
    }
  })
})

describe("filtres de la vue", () => {
  test("les types et niveaux de validation non inclus sont écartés", () => {
    const view = viewOf({ included_types: ["claim"], validation_levels: ["validated"] })
    const result = materialize({
      view,
      missionBranch: "b",
      items: [
        item({ id: "ok", type: "claim", validation_level: "validated" }),
        item({ id: "mauvais-type", type: "rumeur", validation_level: "validated" }),
        item({ id: "non-valide", type: "claim", validation_level: "draft" }),
      ],
    })
    expect(result.items.map((i) => i.id)).toEqual(["ok"])
    expect(result.excluded.map((e) => e.reason)).toEqual(["type-not-included", "validation-level-not-included"])
  })

  test("un contexte entièrement écarté rend une liste vide, pas une erreur", () => {
    // Un contexte vide est une information exploitable ; une exception ferait perdre la liste des
    // raisons, qui est précisément ce dont l'appelant a besoin pour demander une extension.
    const result = materialize({
      view: viewOf({ branch_scope: ["a"] }),
      missionBranch: "a",
      items: [item({ id: "x", branch_id: "z" })],
    })
    expect(result.items).toEqual([])
    expect(result.excluded).toHaveLength(1)
  })
})
