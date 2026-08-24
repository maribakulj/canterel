/**
 * Le test de sortie de `W2.23` — l'inventaire des modèles, lu et non supposé.
 *
 * # Ce que `W2.22` avait laissé, et pourquoi
 *
 * `buildManifest` portait un champ `models`, `Surroundings.models` le traversait, et **la couture
 * n'en déclarait aucun** : le worker assemblé tournait et ne pouvait prendre aucune mission. Ce
 * n'était pas un oubli mais une abstention — la couture ne savait pas dire si les prompts d'un
 * fournisseur quittent la machine, et un modèle marqué local alors qu'il est distant fait sortir un
 * contexte confidentiel de l'hôte (§12.4, invariant 11).
 *
 * # Les deux sens, et pourquoi un seul ne suffit pas
 *
 * Une garde qui ne dirait que « distant » serait **exacte et inutile** : elle refuserait tout, y
 * compris ce qui ne sort pas de la machine, et personne ne pourrait plus exécuter une mission
 * confidentielle sur un modèle local. Les tests tiennent donc les deux :
 *
 * - ce qui est configuré sur la boucle locale est **local** ;
 * - tout le reste — y compris ce qui ne se lit pas — est **distant**.
 *
 * Les deux erreurs ne sont pas symétriques : la première coûte une mission non prise, la seconde
 * fait fuir un contexte. C'est pour cela que l'ignorance penche d'un seul côté.
 */

import { describe, expect, test } from "bun:test"

import { localityOf, modelInventory, providerLocality, type ProviderReading } from "../../src/locus/model-inventory.ts"

function fournisseur(patch: Partial<ProviderReading> = {}): ProviderReading {
  return { id: "ollama", models: ["qwen2.5-coder"], authenticated: false, ...patch }
}

// ---------------------------------------------------------------------------------------------
// 1. Ce qui est sur la boucle locale ne sort pas.
// ---------------------------------------------------------------------------------------------

describe("l'adresse d'inférence est lue, pas supposée — W2.23", () => {
  /**
   * **Le sens qui rend le refus utile.**
   *
   * Sans lui, `remote_inference` serait `true` partout et §12.4 refuserait toute mission
   * confidentielle, y compris sur un modèle qui ne fait rien sortir. Un inventaire qui ne saurait
   * dire que « distant » n'aurait pas besoin d'être lu.
   */
  test("une base sur la boucle locale est locale", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "https://localhost:8080/v1",
      "http://[::1]:1337/v1",
      // Toute la boucle, pas seulement sa première adresse : un serveur sur `127.0.0.2` est aussi
      // local, et une garde qui ne connaîtrait que `127.0.0.1` le déclarerait distant.
      "http://127.0.0.2:8000/v1",
      "http://LOCALHOST:11434/v1",
    ]) {
      expect(localityOf(url)).toEqual({ remote: false, because: "loopback" })
    }
  })

  /**
   * **Tout le reste sort.**
   *
   * Y compris une adresse privée : `192.168.1.10` est une autre machine, et les prompts y vont par
   * le réseau. « Sur mon réseau » n'est pas « sur ma machine », et §12.4 parle de la seconde.
   */
  test("une base ailleurs que sur la boucle est distante", () => {
    for (const url of [
      "https://api.anthropic.com/v1",
      "http://192.168.1.10:11434/v1",
      "http://10.0.0.5:8000/v1",
      "https://gpu-box.interne:8080/v1",
      // `0.0.0.0` désigne « toutes les interfaces » côté écoute ; comme destination il dépend de la
      // pile réseau. Un cas ambigu se range du côté sûr.
      "http://0.0.0.0:1234/v1",
    ]) {
      expect(localityOf(url)).toEqual({ remote: true, because: "hors-machine" })
    }
  })

  /**
   * **Un nom qui résoudrait vers la boucle reste distant.**
   *
   * Résoudre demanderait une requête DNS, et `W2.22` a fait de « l'assemblage n'ouvre aucune
   * connexion » une propriété testée. Une résolution est de surcroît **datée** : elle vaut à
   * l'instant où on la fait, et un manifeste vit plus longtemps.
   */
  test("un nom d'hôte n'est pas résolu, donc il est distant", () => {
    expect(localityOf("http://mon-serveur-local:11434/v1")).toEqual({
      remote: true,
      because: "hors-machine",
    })
  })

  // -------------------------------------------------------------------------------------------
  // 2. Ce qui ne se lit pas est distant, et le dit sous son propre nom.
  // -------------------------------------------------------------------------------------------

  /**
   * **Trois ignorances, un seul verdict — et trois raisons.**
   *
   * Le verdict est binaire parce que le protocole veut un booléen. Les raisons ne le sont pas :
   * « aucune adresse configurée » se répare en en configurant une, « adresse illisible » se répare
   * en corrigeant une coquille. Les fondre en un « distant » commun ferait chercher au mauvais
   * endroit.
   */
  test("l'absence et l'illisible sont distants, chacun sous son nom", () => {
    expect(localityOf(undefined)).toEqual({ remote: true, because: "sans-adresse" })
    expect(localityOf("")).toEqual({ remote: true, because: "sans-adresse" })
    expect(localityOf("   ")).toEqual({ remote: true, because: "sans-adresse" })
    expect(localityOf("pas une url")).toEqual({ remote: true, because: "adresse-illisible" })
    expect(localityOf("://cassé")).toEqual({ remote: true, because: "adresse-illisible" })
  })

  /**
   * **Les quatre raisons sont distinctes.**
   *
   * Un test qui vérifierait seulement `remote` passerait encore si les trois raisons distantes se
   * fondaient en une seule — et c'est exactement la simplification qu'un lecteur pressé ferait.
   */
  test("les quatre raisons ne se confondent pas", () => {
    const raisons = [
      localityOf("http://localhost:1234").because,
      localityOf("https://api.exemple.com").because,
      localityOf(undefined).because,
      localityOf("pas une url").because,
    ]
    expect(new Set(raisons).size).toBe(4)
  })

  // -------------------------------------------------------------------------------------------
  // 3. Un fournisseur est local seulement si tout l'est.
  // -------------------------------------------------------------------------------------------

  /**
   * **Un seul modèle qui pointe ailleurs rend le fournisseur distant.**
   *
   * Le manifeste ne porte qu'un booléen par fournisseur. Le rabattre sur « la plupart sont locaux »
   * ferait sortir les prompts du modèle qui ne l'est pas — et c'est précisément celui dont personne
   * ne se méfie, puisque son fournisseur est réputé local.
   */
  test("un fournisseur dont un seul modèle sort est distant", () => {
    const mixte = fournisseur({
      baseURL: "http://localhost:11434/v1",
      modelURLs: [undefined, "https://api.exemple.com/v1"],
    })

    expect(providerLocality(mixte)).toEqual({ remote: true, because: "hors-machine" })
  })

  test("un fournisseur dont toutes les adresses sont sur la boucle est local", () => {
    const local = fournisseur({
      baseURL: "http://localhost:11434/v1",
      modelURLs: [undefined, "http://127.0.0.1:11434/v1"],
    })

    expect(providerLocality(local)).toEqual({ remote: false, because: "loopback" })
  })

  /**
   * **La raison rendue est celle de la première adresse distante.**
   *
   * C'est celle qu'un exploitant doit aller regarder. Rendre « loopback » pour un fournisseur mixte
   * serait exact pour la majorité de ses modèles et faux pour celui qui compte.
   */
  test("un fournisseur sans adresse du tout est distant, et le dit", () => {
    expect(providerLocality(fournisseur())).toEqual({ remote: true, because: "sans-adresse" })
  })

  // -------------------------------------------------------------------------------------------
  // 4. L'inventaire, tel que le manifeste le portera.
  // -------------------------------------------------------------------------------------------

  test("l'inventaire porte la localité lue, fournisseur par fournisseur", () => {
    const inventaire = modelInventory([
      fournisseur({ id: "ollama", baseURL: "http://localhost:11434/v1", models: ["qwen"] }),
      fournisseur({
        id: "anthropic",
        baseURL: undefined,
        models: ["claude"],
        authenticated: true,
      }),
    ])

    expect(inventaire).toEqual([
      { provider: "ollama", auth: "none", remote_inference: false, models: ["qwen"] },
      { provider: "anthropic", auth: "service-credential", remote_inference: true, models: ["claude"] },
    ])
  })

  /**
   * **`oauth-local` n'est jamais annoncé, et ce n'est pas un oubli.**
   *
   * Le schéma le dit : « `oauth-local` n'est admissible que sur un worker local de confiance ; le
   * schéma ne peut pas le vérifier, l'admission le peut ». L'annoncer est une **revendication** de
   * confiance, pas la description d'un mécanisme, et un module qui lit une configuration n'est pas
   * en position de revendiquer ce qu'un hôte mérite.
   */
  test("aucune entrée ne revendique `oauth-local`", () => {
    const inventaire = modelInventory([
      fournisseur({ authenticated: true, baseURL: "http://localhost:1234/v1" }),
      fournisseur({ id: "autre", authenticated: false }),
    ])

    expect(inventaire.map((entry) => entry.auth)).toEqual(["service-credential", "none"])
  })

  /**
   * **Un fournisseur sans modèle n'entre pas dans l'inventaire.**
   *
   * Il ne peut honorer aucune mission. L'admission ne s'en trouverait pas trompée — elle regarde
   * les modèles — mais un exploitant qui lit le manifeste, si.
   */
  test("un fournisseur sans modèle n'est pas annoncé", () => {
    expect(modelInventory([fournisseur({ models: [] })])).toEqual([])
  })

  /**
   * **Un inventaire vide reste un inventaire.**
   *
   * `[]` veut dire « on a regardé et il n'y a rien », que `W2.22` distingue déjà de l'absence du
   * champ. La distinction est refaite ici parce qu'elle se perdrait si `modelInventory` rendait
   * `undefined` pour une liste vide.
   */
  test("aucun fournisseur rend une liste vide, pas une absence", () => {
    expect(modelInventory([])).toEqual([])
  })
})
