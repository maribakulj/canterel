/**
 * La cohérence entre ce que le code invoque et ce que le registre atteste — `W22.f`, ADR 0025 de
 * `locusolus`.
 *
 * # Ce qui est interdit, et ce qui ne l'est pas
 *
 * `index.ts` a porté pendant des mois :
 *
 * >     `inert` tant que W2.4 n'a pas donné d'identité au worker.
 *
 * — dans un commentaire de documentation, dont les délimiteurs sont retirés ici : les recopier
 * fermerait celui-ci, ce que la première rédaction de ce fichier a fait.
 *
 * `W2.4` est livré depuis le 2026-08-13, et le registre le dit. Le worker est toujours inerte —
 * ça, c'est vrai — mais la **raison invoquée** avait cessé de l'être, et une raison fausse envoie
 * chercher ailleurs que là où le travail manque.
 *
 * Ce qui est interdit est donc étroit : invoquer un item **comme condition non satisfaite** alors
 * que le registre l'atteste livré. Citer un item pour dire d'où vient un morceau de code —
 * « l'identifiant de la vue à matérialiser (W2.10) » — est légitime et le restera : c'est de la
 * provenance, pas une affirmation sur l'état du système.
 *
 * # Pourquoi la règle regarde la **direction** et l'adjacence
 *
 * Une première version cherchait des marqueurs d'attente n'importe où autour de l'identifiant. Sur
 * l'arbre réel elle a rendu **cinq résultats dont quatre faux** :
 *
 * - « `locusd` n'existe pas encore (W2.5 apporte `connection.ts`) » — le « pas encore » porte sur
 *   `locusd`, pas sur `W2.5`, qui est cité en provenance ;
 * - « le worker n'a pas de quoi le lire […] comme le merge à blanc de W2.1 » — comparaison ;
 * - « une mission qu'on n'a pas le droit d'exécuter » — sans rapport avec le `W2.8` voisin ;
 * - « L'autoriser **reviendrait** à… la faute que W2.6 existe pour empêcher » — où « reviendrait »
 *   contient « viendra ».
 *
 * Quatre faux sur cinq. Une garde qui crie sur ce qui est juste se fait désactiver, et c'est ainsi
 * qu'on perd celles qui avaient raison — la leçon de `W22.d`.
 *
 * D'où deux familles séparées, et l'adjacence exigée dans les deux cas. Un marqueur qui
 * **subordonne** doit précéder l'identifiant immédiatement ; un marqueur qui **nie** ou qui met au
 * futur doit le suivre de près. Les frontières de mot sont obligatoires, sans quoi « reviendrait »
 * repasse.
 *
 * # Citer n'est pas affirmer : l'échappement par bloc de citation
 *
 * Ce fichier a déclenché sa propre garde au premier passage, en recopiant le commentaire fautif
 * pour l'expliquer. C'est la dixième fois de ce chantier qu'une anti-garde mord sur la prose qui
 * documente ce qu'elle interdit, et la dixième réparation ne peut pas être « faire attention ».
 *
 * La règle qui la résout est **sémantique, pas cosmétique** : un bloc de citation Markdown — une
 * ligne qui commence par `>` — rapporte les mots d'autrui. Il n'affirme rien sur l'état du système,
 * il dit « voici ce qui a été écrit ». La garde l'ignore donc, et n'importe quel fichier peut dès
 * lors exhiber la forme interdite pour l'expliquer, sans exemption nominative et sans trou.
 *
 * C'est la même issue que `W4.c` chez `locusolus`, où une garde de frontières signalait le paquet
 * qui **écrivait** la politique de sécurité. Écrire une règle et l'illustrer sont deux actes, et une
 * garde qui ne les distingue pas rend impossible de documenter ce qu'elle protège.
 *
 * # Ce que cette garde ne verra jamais
 *
 * Un item livré **ailleurs** que dans ce registre. Ce dépôt lit le sien ; `locusolus` porte le
 * sien. Une condition invoquée sur un item livré là-bas passera ici, et c'est la même limite que
 * la garde de roadmap de `locusolus` déclare pour ses registres voisins non lus : une absence de
 * lecture ne conclut pas.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/** Un écart, sous une forme stable et lisible en revue. */
export type Finding = {
  readonly rule: string
  readonly where: string
  readonly message: string
}

/** Un identifiant d'item, dans la forme que `W22.a` a fixée chez `locusolus`. */
const ITEM = /(?<![A-Za-z0-9])(W\d+\.[a-z0-9]+(?:\.\d+)?|R\d+)(?![A-Za-z0-9])/g

/**
 * Les trois préfixes qui font qu'une entrée de registre **consigne une décision** au lieu
 * d'attester une livraison — même liste que la garde de roadmap de `locusolus`.
 */
const DECISION = /—\s*(Bloqué|Reporté|Partiel)(?!\p{L})/u

/** Le titre d'une entrée de registre : `## 2026-08-13 — W2.4 — …`. */
const HEADING = /^## \d{4}-\d{2}-\d{2} — (W\d+\.[a-z0-9]+(?:\.\d+)?|R\d+)\b([^\n]*)$/gm

/**
 * Les marqueurs qui **subordonnent** ce qui suit : l'item est la condition.
 *
 * Ils doivent précéder l'identifiant immédiatement — au plus un caractère de ponctuation ou une
 * accolade de balisage entre les deux.
 */
const SUBORDONNE = /\b(tant que|en attendant|jusqu'à ce que|jusqu'à|avant que|dès que|une fois que)\s+[`«"']?$/iu

/**
 * Les marqueurs qui **nient** l'item ou le mettent au futur : l'item est le sujet.
 *
 * Ils doivent suivre l'identifiant de près, dans la même proposition.
 */
const NIE =
  /^[`»"']?\s+(n'a pas|n'existe pas|ne sait pas|manque|manquera|viendra|livrera|fournira|apportera|arrivera)\b/iu

/** À quelle distance un marqueur qui suit reste dans la même proposition. */
const PORTEE = 40

/** Les items que ce registre atteste **livrés** — les décisions consignées n'en sont pas. */
export function deliveredItems(ledger: string): Set<string> {
  const delivered = new Set<string>()
  for (const [, item, rest] of ledger.matchAll(HEADING)) {
    if (item !== undefined && !DECISION.test(rest ?? "")) delivered.add(item)
  }
  return delivered
}

/** Une ligne de commentaire qui rapporte les mots d'autrui : `* > …`, ou `> …` en Markdown nu. */
const CITATION = /(^|\n)\s*(\*\s*)?>/

/**
 * Vrai quand l'identifiant à cette position est invoqué comme condition non satisfaite.
 *
 * Un identifiant placé dans un bloc de citation ne l'est jamais : voir la documentation du module.
 */
export function invokedAsPending(source: string, start: number, end: number): boolean {
  const debutLigne = source.lastIndexOf("\n", start - 1) + 1
  if (CITATION.test(source.slice(debutLigne, start))) return false
  const avant = source.slice(Math.max(0, start - PORTEE), start)
  const apres = source.slice(end, Math.min(source.length, end + PORTEE))
  return SUBORDONNE.test(collapse(avant)) || NIE.test(collapse(apres))
}

/**
 * Réduire une fenêtre de commentaire à une seule ligne lisible.
 *
 * Les commentaires du dépôt se replient à cent-dix colonnes, donc une condition traverse
 * régulièrement un saut de ligne et son `*` de continuation. Les laisser ferait manquer une
 * condition sur deux, ce qui est la forme la plus discrète d'une garde inerte.
 */
function collapse(fragment: string): string {
  return fragment.replace(/\n\s*\*?/g, " ").replace(/\s+/g, " ")
}

/** Confronter le code local au registre, et dire ce qui a été lu. */
export async function inspectCoherence(
  root: string,
): Promise<{ readonly examined: readonly string[]; readonly findings: readonly Finding[] }> {
  const ledger = await readFile(join(root, "IMPLEMENTATION_LEDGER.md"), "utf8")
  const delivered = deliveredItems(ledger)
  const examined: string[] = []
  const findings: Finding[] = []

  for (const path of await localSources(root)) {
    const source = await readFile(join(root, path), "utf8")
    examined.push(path)
    for (const found of source.matchAll(ITEM)) {
      const item = found[1]
      if (item === undefined || !delivered.has(item)) continue
      if (!invokedAsPending(source, found.index, found.index + found[0].length)) continue
      findings.push({
        rule: "condition-perimee",
        where: path,
        message: `« ${item} » est invoqué comme condition non satisfaite, et le registre l'atteste livré : une raison fausse envoie chercher ailleurs que là où le travail manque`,
      })
    }
  }

  if (examined.length === 0) {
    findings.push({
      rule: "aucune-source-lue",
      where: "backend/cli/src/locus",
      message:
        "aucune source locale n'a été lue : un décompte nul ne veut pas dire que tout va bien, il veut dire que la garde n'a rien regardé",
    })
  }

  return { examined, findings }
}

/**
 * Les sources locales, découvertes et non listées.
 *
 * Le SDK LEP épinglé est écarté : c'est une copie vérifiée contre son empreinte, pas du code que ce
 * dépôt écrit, et la muter pour satisfaire une garde casserait l'intégrité qu'elle porte.
 */
export async function localSources(root: string): Promise<string[]> {
  const base = "backend/cli/src/locus"
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name !== "lep") await walk(next)
        continue
      }
      if (entry.name.endsWith(".ts")) found.push(next)
    }
  }
  await walk(base)
  return found.sort()
}
