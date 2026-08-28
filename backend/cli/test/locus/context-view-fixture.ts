import { viewContentHash } from "../../src/locus/context-materializer.ts"
import type { ContextView, MissionEnvelope } from "../../src/locus/lep/generated.ts"

/**
 * Une `ContextView` **scellée**, et la mission qui la nomme — `W20.ac`.
 *
 * # Pourquoi les deux se fabriquent ensemble
 *
 * Depuis `W20.ac`, la boucle récupère la vue que sa mission nomme et la vérifie deux fois : que le
 * document est cohérent avec lui-même, et que c'est **celui-là**. Une fixture qui figerait un
 * `content_hash` à la main échouerait au premier contrôle, et une mission qui annoncerait un autre
 * hash que celui du document échouerait au second — dans les deux cas en accusant la boucle d'un
 * défaut de la fixture.
 *
 * Le hash est donc **calculé**, par la même fonction que le worker emploie pour vérifier, et la
 * mission le reçoit. Les deux ne peuvent pas diverger parce qu'aucune des deux valeurs n'est écrite.
 *
 * Ce que ce module ne fabrique pas : le cas **adverse**. Une vue qui ne correspond pas se construit
 * dans le test qui l'éprouve, sous ses yeux — `context-view.test.ts` — parce qu'une fixture
 * « mauvaise » rangée à côté d'une « bonne » finit toujours par être prise pour l'autre.
 */
export function vueScellee(id = "ctx_1"): ContextView {
  const brouillon = {
    id,
    query: "ce que l'agent pouvait connaître",
    confidentiality_ceiling: "internal",
    source_event_watermark: 0,
    generated_at: "2026-08-24T12:00:00.000Z",
    // Retiré avant le calcul par `viewContentHash` : sa valeur d'entrée n'entre pas dans le
    // résultat, ce qu'un test de `locusolus` vérifie du côté qui scelle.
    content_hash: "",
  } satisfies ContextView
  return { ...brouillon, content_hash: viewContentHash(brouillon) }
}

/** La mission, renommée sur cette vue-là. */
export function avecVue(mission: MissionEnvelope, vue: ContextView): MissionEnvelope {
  return { ...mission, context_view: { id: vue.id, hash: vue.content_hash } }
}

/** Vrai quand cette URL est celle d'une vue de contexte. */
export function estUneVue(url: string): boolean {
  return new URL(url, "https://locus.example").pathname.startsWith("/context-views/")
}
