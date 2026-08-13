/**
 * La politique de synchronisation amont, exécutable.
 *
 * Ce dépôt est un fork **non divergé** de `synthetic-sciences/OpenScience` (ADR 0010). Tout le
 * travail Locus vit dans des répertoires neufs, ce qui doit rendre chaque `git merge upstream/main`
 * sans conflit. « Doit » est une intention tant que rien ne la vérifie : ce module la vérifie.
 *
 * Le contrôle est un merge **à blanc**. `git merge-tree --write-tree` calcule l'arbre fusionné
 * sans toucher ni l'index ni le répertoire de travail — donc sans laisser le dépôt à moitié
 * fusionné si le contrôle échoue, et sans exiger un arbre propre pour tourner.
 */

/**
 * Les chemins qui appartiennent à Locus et qu'un merge amont ne doit jamais toucher.
 *
 * La liste est ici plutôt que dans le script parce qu'elle est le contrat : la modifier est une
 * décision, pas un détail d'implémentation.
 */
export const LOCAL_PATHS: readonly string[] = [
  "backend/cli/src/locus/",
  "backend/cli/test/locus/",
  "docs/locus/",
  "IMPLEMENTATION_LEDGER.md",
]

/**
 * Les fichiers amont que ce fork modifie malgré tout, avec la raison.
 *
 * ADR 0010 ne les interdit pas : il exige qu'ils soient justifiés, « parce qu'ils seront payés à
 * chaque synchronisation ». Les lister ici est ce qui rend ce prix visible — un conflit sur l'un
 * d'eux est attendu et se résout à la main, un conflit ailleurs est une régression de la
 * politique.
 */
export const JUSTIFIED_UPSTREAM_EDITS: readonly { path: string; reason: string }[] = [
  {
    path: "CLAUDE.md",
    reason: "En-tête additif qui oriente vers docs/locus/ ; le document amont suit, conservé intact.",
  },
  {
    path: ".prettierignore",
    reason:
      "Exclut docs/locus/, placé byte-identique et vérifié contre ses checksums ; reformater une spec normative la mute en silence.",
  },
  {
    path: "backend/cli/src/index.ts",
    reason:
      "Enregistre `canterel worker` (W2.3) : un import et un `.command()`. La liste des commandes bouge en amont, donc ce hunk conflictera ; il se rejoue en deux lignes et n'a pas d'alternative — la CLI amont n'expose aucun mécanisme d'enregistrement de commande par plugin.",
  },
]

export type MergeVerdict = {
  /** Chemins locaux que le merge toucherait — toujours vide quand la politique tient. */
  readonly localTouched: readonly string[]
  /** Chemins amont justifiés que le merge toucherait : attendus, à résoudre à la main. */
  readonly justifiedTouched: readonly string[]
  /** Tout le reste : du fork qui avance, ce qui est le comportement normal. */
  readonly upstreamTouched: readonly string[]
}

/** Vrai quand `path` tombe dans le périmètre Locus. */
export function isLocal(path: string): boolean {
  return LOCAL_PATHS.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix))
}

/** Vrai quand `path` est un fichier amont que ce fork modifie avec une justification écrite. */
export function isJustifiedUpstreamEdit(path: string): boolean {
  return JUSTIFIED_UPSTREAM_EDITS.some((entry) => entry.path === path)
}

/**
 * Classer les chemins qu'un merge amont modifierait.
 *
 * Séparer les trois catégories est tout l'intérêt : un merge qui touche du code amont est un
 * merge normal, un merge qui touche un fichier justifié est un coût connu, et un merge qui touche
 * du code Locus veut dire que le périmètre a fui — c'est le seul des trois qui soit une faute.
 */
export function classify(paths: readonly string[]): MergeVerdict {
  const localTouched: string[] = []
  const justifiedTouched: string[] = []
  const upstreamTouched: string[] = []
  for (const path of paths) {
    if (isLocal(path)) localTouched.push(path)
    else if (isJustifiedUpstreamEdit(path)) justifiedTouched.push(path)
    else upstreamTouched.push(path)
  }
  return { localTouched, justifiedTouched, upstreamTouched }
}

/** L'URL du dépôt amont. Le remote `upstream` n'est pas versionné ; celle-ci l'est. */
export const UPSTREAM_URL = "https://github.com/synthetic-sciences/OpenScience"
export const UPSTREAM_BRANCH = "main"
