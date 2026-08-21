import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"

import { deliveredItems, inspectCoherence, invokedAsPending, localSources } from "../../src/locus/coherence.ts"

/**
 * Test de sortie de `W22.f` — **la prose du code décrit l'état courant**, ADR 0025 de `locusolus`.
 *
 * 1. Un item livré, invoqué comme condition non satisfaite, est rapporté.
 * 2. Les quatre faux positifs que la première version rendait ne se déclenchent plus.
 * 3. Citer n'est pas affirmer — le bloc de citation laisse documenter la forme interdite.
 * 4. Le dépôt lui-même est cohérent, et la garde dit sur quoi elle a conclu.
 */

const REPO = new URL("../../../..", import.meta.url).pathname

/** Un registre minimal : trois entrées, dont une qui consigne une décision. */
const LEDGER = [
  "# Ledger",
  "",
  "## 2026-08-13 — W2.4 — identité persistante, enrôlement et révocation",
  "",
  "## 2026-08-14 — W2.6 — capability-manifest et capability-watch",
  "",
  "## 2026-08-17 — W4.d.2 — le driver rootless",
  "",
  "## 2026-08-19 — W2.20 — Bloqué : la boucle attend le transport",
  "",
].join("\n")

const scratch: string[] = []

afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })))
})

/**
 * Un dépôt de fixture : un registre, et une source locale.
 *
 * Passer par `inspectCoherence` plutôt que par `invokedAsPending` est ce qui exerce le **couple**
 * — la citation d'un côté, le registre de l'autre. Une passe de mutation a montré que sans ces
 * fixtures, on pouvait retirer le constat entier, cesser de consulter le registre ou vider le
 * décompte sans qu'un seul test proteste : la reconnaissance était testée, l'intégration non.
 */
async function fixture(input: { readonly ledger: string; readonly source?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "locus-w22f-"))
  scratch.push(root)
  await writeFile(join(root, "IMPLEMENTATION_LEDGER.md"), input.ledger, "utf8")
  if (input.source !== undefined) {
    await mkdir(join(root, "backend/cli/src/locus"), { recursive: true })
    await writeFile(join(root, "backend/cli/src/locus/exemple.ts"), input.source, "utf8")
  }
  return root
}

/** Trouver l'unique identifiant d'un fragment et demander à la garde ce qu'elle en dit. */
function pending(fragment: string, item: string): boolean {
  const start = fragment.indexOf(item)
  expect(start).toBeGreaterThanOrEqual(0)
  return invokedAsPending(fragment, start, start + item.length)
}

describe("W22.f — la prose décrit l'état courant", () => {
  // -------------------------------------------------------------------------------------------
  // 1. Le défaut réel
  // -------------------------------------------------------------------------------------------

  /**
   * **Le commentaire qui a menti pendant des mois est reconnu, mot pour mot.**
   *
   * Le test qui porte l'item. C'est le texte exact qu'`index.ts` a porté, et `W2.4` est livré depuis
   * le 2026-08-13. Le worker est toujours inerte — ça, c'est vrai — mais la **raison invoquée** avait
   * cessé de l'être, et une raison fausse envoie chercher ailleurs que là où le travail manque.
   */
  test("un item livré invoqué comme condition non satisfaite est reconnu", () => {
    const fautif = "/** `inert` tant que W2.4 n'a pas donné d'identité au worker. */"

    expect(pending(fautif, "W2.4")).toBe(true)
  })

  /** **Un item **non** livré invoqué comme condition reste licite : c'est un fait vrai.** */
  test("un item non livré invoqué comme condition ne fait pas échouer la garde", () => {
    expect(deliveredItems(LEDGER).has("W2.20")).toBe(false)
    expect(deliveredItems(LEDGER).has("W2.4")).toBe(true)
  })

  /** **Une entrée qui consigne une décision n'atteste pas une livraison.** */
  test("une entrée bloquée ne compte pas comme livrée", () => {
    const items = deliveredItems(LEDGER)

    expect([...items].sort()).toEqual(["W2.4", "W2.6", "W4.d.2"])
  })

  /** **Les deux directions sont reconnues : ce qui subordonne, et ce qui nie.** */
  test("les deux formes d'invocation sont reconnues", () => {
    expect(pending("en attendant W2.4, le worker ne fait rien", "W2.4")).toBe(true)
    expect(pending("W2.4 n'existe pas encore, donc rien ne se connecte", "W2.4")).toBe(true)
    expect(pending("jusqu'à W2.4, l'inertie tient", "W2.4")).toBe(true)
    expect(pending("le manifeste que W2.6 fournira", "W2.6")).toBe(true)
  })

  /**
   * **Un item à deux points est reconnu comme les autres.**
   *
   * C'est la forme que `W22.a` a rendue visible à la garde de roadmap. Ne pas la tenir ici laisserait
   * les deux gardes diverger en silence sur ce qu'est un identifiant.
   */
  test("un item à deux points est reconnu", () => {
    expect(pending("tant que W4.d.2 n'a pas livré le driver", "W4.d.2")).toBe(true)
  })

  /**
   * **Un verbe au conditionnel n'est pas une invocation.**
   *
   * « W2.6 manquerait » énonce une hypothèse, pas l'état du système. Sans frontière de mot en fin de
   * marqueur, « manque » matcherait à l'intérieur de « manquerait » — la même faute que
   * « reviendrait » qui contient « viendra », dans l'autre sens.
   */
  test("un conditionnel n'est pas une invocation", () => {
    expect(pending("W2.6 manquerait de sens ici", "W2.6")).toBe(false)
    expect(pending("W2.6 manque encore", "W2.6")).toBe(true)
  })

  // -------------------------------------------------------------------------------------------
  // 2. Les quatre faux positifs de la première version
  // -------------------------------------------------------------------------------------------

  /**
   * **Les quatre cas réels qu'une première rédaction de la règle rendait à tort.**
   *
   * Elle cherchait des marqueurs d'attente n'importe où autour de l'identifiant, et sur l'arbre
   * réel elle a rendu cinq résultats dont **quatre faux**. Une garde qui crie sur ce qui est juste
   * se fait désactiver, et c'est ainsi qu'on perd celles qui avaient raison — la leçon de `W22.d`.
   *
   * Les quatre sont ici sous leur forme d'origine, pas paraphrasés : un test qui reformulerait ne
   * prouverait rien sur le code qui existe.
   */
  test("les quatre faux positifs de la première version ne se déclenchent plus", () => {
    // Le « pas encore » porte sur `locusd`, pas sur l'item, qui est cité en provenance.
    expect(pending("`locusd` n'existe pas encore (W2.5 apporte `connection.ts`)", "W2.5")).toBe(false)

    // Une comparaison, pas une condition.
    expect(pending("le worker n'a pas de quoi le lire […] comme le merge à blanc de W2.1", "W2.1")).toBe(false)

    // « n'a pas » porte sur la mission, pas sur l'item voisin.
    expect(pending("L'admission de W2.8 passe en premier : une mission qu'on n'a pas le droit", "W2.8")).toBe(false)

    // « reviendrait » contient « viendra » : les frontières de mot sont obligatoires.
    expect(pending("L'autoriser reviendrait à annoncer une isolation — la faute que W2.6 empêche", "W2.6")).toBe(false)
  })

  /** **La provenance reste licite, et c'est l'usage courant du dépôt.** */
  test("citer un item en provenance ne déclenche rien", () => {
    expect(pending("L'identifiant de la vue à matérialiser (W2.10)", "W2.10")).toBe(false)
    expect(pending("Enregistre `canterel worker` (W2.3) : un import et un `.command()`", "W2.3")).toBe(false)
  })

  // -------------------------------------------------------------------------------------------
  // 3. Citer n'est pas affirmer
  // -------------------------------------------------------------------------------------------

  /**
   * **Un bloc de citation rapporte les mots d'autrui, il n'affirme rien.**
   *
   * Ce fichier-là a déclenché sa propre garde au premier passage, en recopiant le commentaire fautif
   * pour l'expliquer. Dixième fois de ce chantier qu'une anti-garde mord sur la prose qui documente
   * ce qu'elle interdit — et la dixième réparation ne peut pas être « faire attention ».
   *
   * L'échappement est sémantique et sans trou : n'importe quel fichier peut exhiber la forme
   * interdite pour l'expliquer, sans exemption nominative. Même issue que `W4.c` chez `locusolus`,
   * où une garde signalait le paquet qui **écrivait** la politique de sécurité.
   */
  test("un identifiant dans un bloc de citation n'est pas une invocation", () => {
    const commentaire = [
      "/**",
      " * La raison invoquée ici a longtemps été celle-ci :",
      " *",
      " * > tant que W2.4 n'a pas donné d'identité au worker",
      " *",
      " * et elle a cessé d'être vraie.",
      " */",
    ].join("\n")

    expect(pending(commentaire, "W2.4")).toBe(false)
  })

  /** **Le même texte, sans le bloc, redevient une invocation — sinon l'échappement ne prouve rien.** */
  test("le même texte hors bloc de citation reste une invocation", () => {
    const commentaire = [
      "/**",
      " * La raison invoquée ici :",
      " * tant que W2.4 n'a pas donné d'identité au worker",
      " */",
    ].join("\n")

    expect(pending(commentaire, "W2.4")).toBe(true)
  })

  /**
   * **Une condition qui traverse un saut de ligne est vue.**
   *
   * Les commentaires du dépôt se replient à cent-dix colonnes, donc une condition traverse
   * régulièrement une fin de ligne et son `*` de continuation. Les ignorer ferait manquer une
   * condition sur deux, ce qui est la forme la plus discrète d'une garde inerte.
   */
  test("une condition repliée sur deux lignes est vue", () => {
    // La condition est **avant** l'identifiant et rien ne le nie après : seul le recollage peut la
    // voir. Une première rédaction mettait « n'a pas » juste après, et passait donc par l'autre
    // chemin — le test était vert sans rien prouver, ce qu'un mutant a montré.
    const replie = ["/**", " * `inert` en attendant", " * W2.4, rien ne bouge.", " */"].join("\n")

    expect(pending(replie, "W2.4")).toBe(true)
  })

  /**
   * **Le couple, exercé de bout en bout : la citation d'un côté, le registre de l'autre.**
   *
   * Un item **livré** invoqué comme condition produit un constat nommé ; le **même texte** avec un
   * item que le registre ne connaît pas n'en produit aucun. C'est la comparaison qui prouve que le
   * registre est réellement consulté — un seul des deux cas ne prouverait que la reconnaissance.
   */
  test("le couple citation/registre est exercé dans les deux sens", async () => {
    const fautif = "/** `inert` tant que W2.4 n'a pas donné d'identité au worker. */\nexport const a = 1\n"

    const perime = await inspectCoherence(await fixture({ ledger: LEDGER, source: fautif }))
    expect(perime.examined).toEqual(["backend/cli/src/locus/exemple.ts"])
    expect(perime.findings.length).toBe(1)
    expect(perime.findings[0]?.rule).toBe("condition-perimee")
    expect(perime.findings[0]?.where).toBe("backend/cli/src/locus/exemple.ts")
    expect(perime.findings[0]?.message).toContain("W2.4")

    const encoreVrai = await inspectCoherence(
      await fixture({ ledger: LEDGER, source: fautif.replace(/W2\.4/g, "W2.20") }),
    )
    expect(encoreVrai.findings).toEqual([])
  })

  /**
   * **Un item à deux points traverse la garde entière, motif compris.**
   *
   * Le test précédent sur `W4.d.2` passe par `invokedAsPending`, qui reçoit des positions et ne
   * touche pas au motif d'extraction — un mutant qui tronque le motif lui reste invisible. Il faut
   * donc l'exercer par `inspectCoherence` : tronqué, le motif rendrait `W4.d`, que le registre ne
   * connaît pas, et le constat disparaîtrait en silence.
   *
   * C'est la même leçon que `W22.d` : deux copies d'une forme d'identifiant peuvent diverger, et
   * seul le chemin complet le montre.
   */
  test("un item à deux points est extrait par la garde entière", async () => {
    const source = "/** `inert` tant que W4.d.2 n'a pas livré le driver. */\nexport const a = 1\n"

    const verdict = await inspectCoherence(await fixture({ ledger: LEDGER, source }))

    expect(verdict.findings.length).toBe(1)
    expect(verdict.findings[0]?.message).toContain("W4.d.2")
  })

  /**
   * **Aucune source lue est un échec, jamais un « ok ».**
   *
   * La règle de `W22.a` chez `locusolus`, portée ici : un décompte nul ne veut pas dire que tout va
   * bien, il veut dire qu'on n'a rien regardé. Sans elle, déplacer `src/locus/` rendrait la garde
   * muette et verte.
   */
  test("aucune source lue fait échouer la garde", async () => {
    const vide = await inspectCoherence(await fixture({ ledger: LEDGER }))

    expect(vide.examined).toEqual([])
    expect(vide.findings.length).toBe(1)
    expect(vide.findings[0]?.rule).toBe("aucune-source-lue")
  })

  /**
   * **L'échappement porte sur la ligne de l'identifiant, pas sur la fenêtre.**
   *
   * Élargir la recherche du `>` à toute la fenêtre ferait qu'une citation **voisine** exonérerait
   * une invocation bien réelle — un fichier qui documente la forme interdite se donnerait le droit
   * de la commettre trois lignes plus bas.
   */
  test("une citation voisine n'exonère pas l'invocation d'à côté", async () => {
    // Les deux lignes sont **adjacentes** : c'est ce qui rend la distinction visible. Une première
    // rédaction les séparait, et la fenêtre de quarante caractères n'atteignait plus le `>` — le
    // test passait quelle que soit la règle, donc il ne prouvait rien.
    const melange = [
      "/**",
      " * > une citation",
      " * tant que W2.4 n'a pas donné d'identité au worker.",
      " */",
      "export const a = 1",
      "",
    ].join("\n")

    const verdict = await inspectCoherence(await fixture({ ledger: LEDGER, source: melange }))

    expect(verdict.findings.length).toBe(1)
    expect(verdict.findings[0]?.message).toContain("W2.4")
  })

  // -------------------------------------------------------------------------------------------
  // 4. Le dépôt lui-même
  // -------------------------------------------------------------------------------------------

  /**
   * **Le dépôt est cohérent, et la garde dit sur quoi elle a conclu.**
   *
   * Les sources sont **découvertes**, jamais listées — le jour où un module local entre, il est lu
   * sans que personne y pense. `W22.a` chez `locusolus` a montré ce que coûte une liste : huit
   * lignes du plan étaient invisibles à leur garde et aucun décompte ne baissait.
   */
  test("le dépôt lui-même est cohérent, sur des sources découvertes", async () => {
    const { examined, findings } = await inspectCoherence(REPO)

    expect(findings).toEqual([])
    expect(examined.length).toBeGreaterThan(30)
    expect(examined).toContain("backend/cli/src/locus/index.ts")
    expect(examined).toContain("backend/cli/src/locus/coherence.ts")
  })

  /**
   * **Le SDK LEP épinglé est écarté, et c'est délibéré.**
   *
   * C'est une copie vérifiée contre son empreinte, pas du code que ce dépôt écrit. La muter pour
   * satisfaire une garde casserait l'intégrité qu'elle porte.
   */
  test("le SDK épinglé n'est pas lu", async () => {
    const sources = await localSources(REPO)

    expect(sources.some((path) => path.includes("/lep/"))).toBe(false)
    expect(sources.every((path) => path.endsWith(".ts"))).toBe(true)
  })
})
