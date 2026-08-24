/**
 * L'inventaire des modèles, **lu** et non supposé — `W2.23`, `docs/locus/SPEC_V1.md` §10.2 et §12.4.
 *
 * # La question à laquelle ce module répond
 *
 * Pour chaque fournisseur configuré : **les prompts quittent-ils cette machine ?** C'est
 * `remote_inference` dans le manifeste, et c'est la donnée sur laquelle §12.4 décide qu'une classe
 * de données peut être traitée. Se tromper dans un sens coûte une mission non prise ; se tromper
 * dans l'autre fait sortir un contexte confidentiel de l'hôte, et l'admission n'a plus rien pour
 * l'arrêter.
 *
 * Les deux erreurs ne sont donc pas symétriques, et rien ici ne les traite comme si elles
 * l'étaient.
 *
 * # Ce qui est lu, et pourquoi ce n'est pas résolu
 *
 * L'**adresse d'inférence configurée**, telle qu'elle est écrite. Une base sur la boucle locale ne
 * fait pas sortir les prompts ; tout le reste si.
 *
 * Un nom d'hôte qui *résoudrait* vers la boucle locale — une entrée dans `/etc/hosts` — est traité
 * comme **distant**. Deux raisons, et la seconde suffirait :
 *
 * - résoudre demanderait une requête DNS, et `W2.22` a fait de « l'assemblage n'ouvre aucune
 *   connexion » une propriété testée ;
 * - une résolution est **datée**. Elle vaut à l'instant où on la fait, et un manifeste vit plus
 *   longtemps que ça. Déclarer local d'après une résolution, c'est promettre pour un futur qu'on
 *   n'a pas lu.
 *
 * # Trois ignorances, un seul verdict
 *
 * Le verdict est binaire — le protocole veut un booléen. La **raison** ne l'est pas : « configuré
 * sur la boucle locale », « configuré ailleurs », « aucune adresse configurée » et « adresse
 * illisible » sont quatre situations différentes, et les trois dernières donnent le même verdict
 * pour des motifs qu'un exploitant ne répare pas de la même façon. [`Locality`] les garde séparées,
 * comme `xiiif-locus` garde ses deux verdicts plutôt que d'en résumer un.
 */

import type { CapabilityManifestModelsItem } from "./lep/generated.ts"

/** Pourquoi un fournisseur est local ou distant. */
export type Reason =
  /** L'adresse d'inférence est sur la boucle locale : les prompts ne sortent pas. */
  | "loopback"
  /** L'adresse d'inférence est ailleurs : les prompts sortent. */
  | "hors-machine"
  /** Aucune adresse n'est configurée — le SDK ira chez le fournisseur, donc dehors. */
  | "sans-adresse"
  /** L'adresse ne se lit pas comme une URL. */
  | "adresse-illisible"

/** Ce qu'on a lu de l'adresse d'un fournisseur, et ce qu'on en conclut. */
export type Locality = {
  /** Vrai quand les prompts quittent la machine. */
  readonly remote: boolean
  /** Ce qui a été lu. Trois raisons différentes mènent à `remote: true`. */
  readonly because: Reason
}

/**
 * Ce qu'on sait d'un fournisseur configuré, réduit à ce qui décide.
 *
 * Une **lecture**, pas le fournisseur amont lui-même : ce module ne connaît ni `Provider.Info` ni
 * la forme de la configuration, et c'est la couture qui traduit. Le faire lire `Provider.Info`
 * directement l'attacherait à un type amont, donc à un hunk à rejouer à chaque synchronisation.
 */
export type ProviderReading = {
  /** L'identifiant du fournisseur, tel que le manifeste le portera. */
  readonly id: string
  /**
   * L'adresse d'inférence du fournisseur, telle qu'elle est **écrite** dans la configuration.
   *
   * `undefined` veut dire « rien n'est configuré », ce qui n'est pas « rien ne sort » : le SDK ira
   * alors chez le fournisseur, c'est-à-dire dehors.
   */
  readonly baseURL?: string | undefined
  /**
   * Les adresses que des modèles particuliers **surchargent**, s'il y en a.
   *
   * `undefined` pour un modèle veut dire « celui-ci n'écrase rien », donc il part à l'adresse du
   * fournisseur — et non « ce modèle n'a pas d'adresse ». Les confondre déclarerait distant tout
   * fournisseur local correctement configuré, puisque ses modèles ne surchargent précisément rien ;
   * l'inventaire entier serait alors distant, et la lecture n'aurait servi à rien. Un test le tient.
   *
   * Un fournisseur dont **un seul** modèle pointe ailleurs que la boucle locale est distant : le
   * manifeste ne porte qu'un booléen par fournisseur, et le rabattre sur « la plupart sont locaux »
   * ferait sortir les prompts du modèle qui ne l'est pas.
   */
  readonly modelURLs?: readonly (string | undefined)[]
  /** Les modèles offerts. */
  readonly models: readonly string[]
  /** Vrai quand une clé ou une créance est configurée pour ce fournisseur. */
  readonly authenticated: boolean
}

/**
 * Les hôtes qui **sont** la boucle locale, littéralement.
 *
 * `0.0.0.0` n'y est pas : il désigne « toutes les interfaces » côté écoute, et comme destination il
 * dépend de la pile réseau. Un cas ambigu se range du côté sûr, c'est-à-dire distant.
 */
const BOUCLE = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/** Vrai quand cet hôte est la boucle locale, sans rien résoudre. */
function boucleLocale(hostname: string): boolean {
  const nu = hostname.toLowerCase()
  if (BOUCLE.has(nu)) return true
  // Tout `127.0.0.0/8` est la boucle, pas seulement `127.0.0.1` : `127.0.0.2` l'est aussi, et un
  // test qui ne connaîtrait que la première adresse déclarerait distant un serveur local.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(nu)
}

/**
 * Lire une adresse d'inférence, et dire si elle fait sortir les prompts.
 *
 * # Ce qui ne se lit pas est distant, jamais local
 *
 * Une adresse absente, malformée, ou dont l'hôte n'est pas un littéral de boucle locale rend
 * `remote: true`. C'est la direction sûre, et c'est la seule : un défaut qui pencherait vers
 * « local » transformerait chaque coquille de configuration en fuite de contexte confidentiel.
 */
export function localityOf(baseURL: string | undefined): Locality {
  if (baseURL === undefined || baseURL.trim() === "") {
    return { remote: true, because: "sans-adresse" }
  }
  try {
    const hote = new URL(baseURL).hostname
    return boucleLocale(hote) ? { remote: false, because: "loopback" } : { remote: true, because: "hors-machine" }
  } catch {
    return { remote: true, because: "adresse-illisible" }
  }
}

/**
 * La localité d'un fournisseur, toutes ses adresses confondues.
 *
 * Local **seulement si toutes** ses adresses le sont. Le manifeste ne porte qu'un booléen par
 * fournisseur : un fournisseur dont un seul modèle pointe ailleurs ne peut pas être annoncé local
 * sans mentir sur ce modèle-là.
 *
 * La raison rendue est celle de la **première adresse distante** rencontrée, parce que c'est celle
 * qu'un exploitant doit aller regarder. Rendre « loopback » pour un fournisseur mixte serait exact
 * pour la majorité de ses modèles et faux pour celui qui compte.
 */
export function providerLocality(reading: ProviderReading): Locality {
  // Un modèle qui ne surcharge rien part à l'adresse du fournisseur. Le lire comme « sans adresse »
  // rendrait distant tout fournisseur local correctement configuré — ses modèles ne surchargent
  // précisément rien.
  const surcharges = (reading.modelURLs ?? []).map((url) => url ?? reading.baseURL)
  const lues = [reading.baseURL, ...surcharges].map(localityOf)
  const distante = lues.find((locality) => locality.remote)
  return distante ?? { remote: false, because: "loopback" }
}

/**
 * Comment ce worker s'authentifie auprès d'un fournisseur — §10.2.
 *
 * # `oauth-local` n'est jamais annoncé, et ce n'est pas un oubli
 *
 * Le schéma le dit : « `oauth-local` n'est admissible que sur un worker local de confiance ; le
 * schéma ne peut pas le vérifier, l'admission le peut ». L'annoncer est donc une **revendication**
 * de confiance, pas la description d'un mécanisme. Ce module lit une configuration ; il n'est pas
 * en position de revendiquer quoi que ce soit sur la confiance qu'un hôte mérite.
 *
 * Reste la distinction lisible : une clé configurée est une créance de service, son absence est
 * l'absence d'authentification. C'est le cas d'un serveur local qui ignore la clé qu'on lui envoie.
 */
function authOf(reading: ProviderReading): CapabilityManifestModelsItem["auth"] {
  return reading.authenticated ? "service-credential" : "none"
}

/**
 * Traduire ce qui a été lu en entrées de manifeste.
 *
 * # Un fournisseur sans modèle n'entre pas
 *
 * Il ne peut honorer aucune mission, et l'annoncer ferait croire à une capacité que rien ne porte.
 * L'admission ne s'en trouverait pas trompée — elle regarde les modèles —, mais un exploitant qui
 * lit le manifeste, si.
 */
export function modelInventory(readings: readonly ProviderReading[]): readonly CapabilityManifestModelsItem[] {
  return readings
    .filter((reading) => reading.models.length > 0)
    .map((reading) => ({
      provider: reading.id,
      auth: authOf(reading),
      remote_inference: providerLocality(reading).remote,
      models: [...reading.models],
    }))
}
