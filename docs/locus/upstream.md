# Politique de synchronisation amont

Ce dépôt est un fork **non divergé** de `synthetic-sciences/OpenScience` (ADR 0010). Il reçoit le
travail amont indéfiniment, et le travail Locus vit à côté sans jamais entrer en collision avec
lui.

Ce document dit comment cette propriété est tenue, et surtout **comment elle est vérifiée** —
parce qu'une politique de non-divergence que personne ne mesure devient fausse silencieusement, un
fichier à la fois, et ne se découvre qu'au premier merge douloureux.

## Le remote

```sh
git remote add upstream https://github.com/synthetic-sciences/OpenScience
git fetch upstream main
```

Le remote n'est pas versionné : il vit dans `.git/config`, donc sur chaque machine séparément.
L'URL et la branche, elles, le sont — dans `backend/cli/src/locus/upstream.ts`
(`UPSTREAM_URL`, `UPSTREAM_BRANCH`). Le contrôle décrit plus bas ajoute le remote s'il manque.
Il ne le **réécrit jamais** s'il pointe ailleurs : il le signale. Quelqu'un l'a peut-être fait
exprès, et écraser sa configuration pour faire passer un contrôle serait le contraire de ce que le
contrôle sert à établir.

## Le périmètre

Trois catégories, et une seule est une faute.

### 1. Locus — `LOCAL_PATHS`

```
backend/cli/src/locus/
backend/cli/test/locus/
docs/locus/
IMPLEMENTATION_LEDGER.md
```

Des chemins **neufs** : l'amont n'en a aucun. C'est pour ça qu'un merge ne peut pas les toucher, et
c'est toute la raison pour laquelle le code Locus est là plutôt qu'éparpillé dans `src/`. Un merge
amont qui modifie l'un d'eux veut dire que l'amont a créé un chemin de même nom, ou que du code
Locus a fui hors du périmètre. Dans les deux cas la politique est cassée et il faut la réparer
avant de merger.

### 2. Amont modifié avec justification — `JUSTIFIED_UPSTREAM_EDITS`

| Fichier          | Raison                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`      | En-tête additif qui oriente vers `docs/locus/` ; le document amont suit, conservé intact.                                        |
| `.prettierignore` | Exclut `docs/locus/`, placé byte-identique et vérifié contre ses checksums ; reformater une spec normative la mute en silence.   |

ADR 0010 ne les interdit pas. Il exige que le prix soit écrit, « parce qu'il sera payé à chaque
synchronisation ». Un conflit sur l'un d'eux est **attendu** : on le résout à la main, en gardant
le bloc local et le texte amont à jour. Un conflit ailleurs ne l'est pas.

La liste vit dans le code, pas seulement ici, et chaque entrée porte sa raison — une entrée sans
raison rendrait la liste décorative. Toute addition à cette liste appelle une entrée de ledger.

### 3. Tout le reste

Du fork qui reçoit l'amont. C'est le comportement normal et le contrôle n'en dit rien.

## Le contrôle : un merge à blanc

`backend/cli/src/locus/upstream-merge.ts`, exercé par `backend/cli/test/locus/upstream.test.ts`.

```sh
bun test test/locus/upstream.test.ts   # depuis backend/cli
```

Il calcule ce qu'un `git merge upstream/main` changerait, **sans le faire** :

```sh
git merge-tree --write-tree HEAD upstream/main   # → l'OID d'un arbre fusionné
git diff --name-only HEAD <arbre>                # → les chemins que le merge toucherait
```

Rien n'est écrit — ni index, ni répertoire de travail, ni commit. Deux conséquences voulues : le
contrôle tourne sur un arbre sale, et un échec ne laisse pas le dépôt à moitié fusionné. Un
contrôle qu'on n'ose pas lancer n'est pas lancé.

Le verdict classe les chemins dans les trois catégories ci-dessus. Le test de sortie de W2.1 est
`localTouched === []`.

### Quand le contrôle ne peut pas tourner

Il le **dit**, au lieu de passer en silence — un contrôle qu'on croit avoir tourné est pire qu'un
contrôle absent. Trois cas, tous distincts d'une violation :

| Situation                            | Ce qui est rendu                                                       |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Hors ligne, pare-feu, amont injoignable | `amont injoignable : …`                                              |
| Remote `upstream` pointant ailleurs  | `le remote upstream pointe vers …`                                     |
| Clone superficiel                    | `base de fusion introuvable — clone superficiel …`                     |

Le dernier mérite un mot : `actions/checkout` clone à `fetch-depth: 1` par défaut, et la frontière
du clone coupe l'ancêtre commun avec l'amont. `merge-tree` refuse alors avec un message qui
ressemble à une panne réseau. Un job CI qui exécute ce contrôle a besoin de `fetch-depth: 0`.

## Résoudre un conflit

1. Conflit dans la catégorie 3 : c'est un merge ordinaire, il se résout comme tel.
2. Conflit dans la catégorie 2 : garder le bloc Locus, prendre la version amont autour. Le bloc de
   `CLAUDE.md` est trivialement déplaçable ; l'entrée de `.prettierignore` est une ligne.
3. Conflit dans la catégorie 1 : **s'arrêter**. Ça ne devrait pas arriver. Comprendre pourquoi
   avant de merger, et écrire le constat au ledger.

## Ce que ce document n'autorise pas

Aucun rebrand. Ni `@synsci/*`, ni les import paths, ni les fichiers amont, ni le `NOTICE`
(ADR 0010). Le fork reste identifiable comme OpenScience ; « Canterel » est le rôle qu'il tient
dans Locus Solus, pas un nouveau nom pour le produit.
