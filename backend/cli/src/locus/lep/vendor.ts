/**
 * Le SDK LEP épinglé, et la règle qui l'a produit — `SPEC_V1.md` §8.1.
 *
 * « Les types générés sont importés depuis une version verrouillée du SDK LEP produit par
 * `locusolus/packages/protocol`. Pendant la construction de la V1, épingler par commit Git plutôt
 * que par version npm publiée. »
 *
 * Pourquoi une copie plutôt qu'une dépendance : `@locus/lep` et `@locus/testing` vivent dans des
 * sous-répertoires d'un monorepo et sont `private`. Ni npm ni bun ne savent tirer un
 * sous-répertoire d'un dépôt Git, et publier contredirait §8.1. Restait à toucher `package.json`
 * et `bun.lock` — deux fichiers amont, donc un conflit à chaque synchronisation, pour une
 * dépendance dont seul Locus a besoin. La copie épinglée ne coûte rien à l'amont.
 *
 * Ce n'est **pas** une duplication du contrat. Le contrat, ce sont les schémas JSON de
 * `locusolus/schemas/` ; ceci en est une lecture générée, épinglée à un commit, vérifiée par
 * empreinte, et jamais retouchée à la main.
 *
 * Deux fichiers doivent voir leurs imports réécrits, parce que `@locus/lep` ne se résout pas ici.
 * La réécriture est **déclarée et déterministe** : c'est ce module qui l'a produite, et le test
 * d'intégrité la rejoue. Une retouche manuelle serait indétectable si la règle vivait dans la tête
 * de qui a fait la copie.
 */

/** Le dépôt d'origine. L'URL est versionnée ici ; le commit vit dans `PINNED.json`. */
export const SOURCE_REPO = "https://github.com/maribakulj/locusolus"

/** Une réécriture d'import, appliquée à un fichier copié. */
export type Rewrite = {
  readonly from: string
  readonly to: string
  readonly reason: string
}

/** Ce que la copie transforme, fichier par fichier. Vide = copié à l'octet près. */
export const REWRITES: Readonly<Record<string, readonly Rewrite[]>> = {
  "backend/cli/src/locus/lep/generated.ts": [],
  "backend/cli/src/locus/lep/negotiate.ts": [],
  "backend/cli/src/locus/lep/canonical.ts": [],
  "backend/cli/test/locus/harness/worker.ts": [
    {
      from: '"@locus/lep"',
      to: '"../../../src/locus/lep/generated.ts"',
      reason: "`@locus/lep` est un nom de workspace du monorepo amont ; ici le SDK est le fichier copié.",
    },
  ],
  "backend/cli/test/locus/harness/harness.ts": [
    {
      from: '"@locus/lep"',
      to: '"../../../src/locus/lep/generated.ts"',
      reason: "`@locus/lep` est un nom de workspace du monorepo amont ; ici le SDK est le fichier copié.",
    },
    {
      from: '"../../../tooling/lib/findings.ts"',
      to: '"./findings.ts"',
      reason:
        "`tooling/lib` est l'outillage de dépôt de locusolus, hors du SDK ; seul le type `Finding` sert, copié à côté.",
    },
    {
      from: '"./canonical.ts"',
      to: '"../../../src/locus/lep/canonical.ts"',
      reason:
        "Le canonicaliseur sert aussi au hash du CapabilityManifest (W2.6) : une seule copie, sous src/, plutôt qu'une par consommateur.",
    },
  ],
  "backend/cli/test/locus/harness/index.ts": [
    {
      from: '"./canonical.ts"',
      to: '"../../../src/locus/lep/canonical.ts"',
      reason:
        "Le canonicaliseur sert aussi au hash du CapabilityManifest (W2.6) : une seule copie, sous src/, plutôt qu'une par consommateur.",
    },
  ],
  "backend/cli/test/locus/harness/findings.ts": [],
  // Le corpus de fixtures de W0.7. Épinglé comme le SDK, et pour la même raison : ce sont les cas
  // que `locusolus` a écrits pour définir ce qu'admettre veut dire. Les réécrire ici en produirait
  // une seconde version, qui divergerait le jour où l'originale changerait — et un test d'admission
  // qui teste sa propre idée de l'admission ne teste rien.
  "backend/cli/test/locus/fixtures/mission-refused.json": [],
  "backend/cli/test/locus/fixtures/manifest-macos.json": [],
  "backend/cli/test/locus/fixtures/mission-accepted.json": [],
  "backend/cli/test/locus/fixtures/manifest-vm-linux.json": [],
}

/**
 * Appliquer les réécritures d'un fichier.
 *
 * Remplacement littéral, pas d'expression régulière : ce qui est réécrit est un specifier
 * d'import entier, guillemets compris, et une regex sur un tel motif inviterait à réécrire plus
 * que ce qui a été décidé.
 */
export function applyRewrites(target: string, source: string): string {
  let out = source
  for (const rewrite of REWRITES[target] ?? []) {
    out = out.split(rewrite.from).join(rewrite.to)
  }
  return out
}

/** Les fichiers de la copie, dans l'ordre où ils sont déclarés. */
export function vendoredFiles(): readonly string[] {
  return Object.keys(REWRITES)
}
