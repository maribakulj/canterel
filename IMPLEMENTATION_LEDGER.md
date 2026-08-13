# IMPLEMENTATION_LEDGER

Un exemplaire par dépôt, à la racine. Ajout en fin de fichier, jamais de réécriture d'une entrée
passée : c'est un journal, pas un état.

Une session de code se termine en ajoutant une entrée. Une session qui n'en produit pas n'a rien
livré, quoi qu'elle ait écrit.

## Format

<!-- prettier-ignore -->
```markdown
## AAAA-MM-JJ — <id roadmap> — <titre>

**Périmètre.** Fichiers touchés, une ligne. Si le périmètre a débordé de l'item, dire pourquoi.
**Tests exécutés.** Commande et résultat. Le test de sortie de l'item, nommément.
**Décisions prises.** Seulement celles qui contraignent la suite. Une décision qui mérite un ADR
reçoit un ADR et est référencée ici, pas décrite ici.
**Écart avec la spec.** Ce qui a été fait autrement, et pourquoi. « Aucun » est fréquent et valide.
**Prochain item.** Identifiant + vérification que ses dépendances sont satisfaites.
```

## Règles

Le périmètre déclaré doit correspondre au diff. Un débordement signale soit un découpage trop fin,
soit un couplage non anticipé — les deux méritent une ligne.

Sur ce dépôt, toute modification hors de `backend/cli/src/locus/` et `backend/cli/test/locus/` est
justifiée ici, parce qu'elle sera payée à chaque synchronisation amont (ADR 0010).

Une migration `[M]` inscrit son plan de rollback dans l'entrée.

Un test de sortie qui ne passe pas laisse l'item ouvert. On peut committer du code incomplet ; on
n'écrit pas « terminé ».

## Entrées

## 2026-08-10 — W0.1 — placement de la doc Locus

**Périmètre.** `docs/locus/{CLAUDE,SPEC_V1,MIGRATION_FROM_OPENSCIENCEDH}.md`, placés à l'octet
près depuis le paquet de handoff. **Deux fichiers amont touchés**, justifiés ci-dessous :
`CLAUDE.md` (bloc ajouté après le titre) et `.prettierignore` (une entrée). Aucun fichier de code
amont modifié, aucun rebrand, aucun `@synsci/*` renommé.

**Tests exécutés.** `sha256sum` des trois documents placés contre le paquet : identiques.
`prettier --check` sur le diff : conforme, et `docs/locus/` est bien ignoré. Le test de sortie de
W0.1 passe sur ce dépôt : l'ancien nom du projet n'y apparaît nulle part.

**Décisions prises.** Le `CLAUDE.md` amont est **conservé intact et complété**, pas remplacé,
alors que le paquet de handoff prévoyait un `CLAUDE.md` de Locus « à la racine ». Motif : ADR 0010
prescrit exactement ce motif pour le `NOTICE` (« conservé intact ; toute addition locale
substantielle est signalée en section séparée »), et le document amont porte l'architecture de
prompts, le guide de RCA et le style guide dont une session travaillant sur le code amont a
besoin. Le remplacer les aurait perdus. Le bloc est placé **après le titre** et non en fin de
fichier : la règle qu'il porte est « lis-la avant d'écrire quoi que ce soit », et une règle en bas
de page n'est pas lue. Coût assumé : un hunk en tête de `CLAUDE.md` peut conflicter lors d'une
synchronisation amont. Il est trivialement déplaçable.

`.prettierignore` reçoit `docs/locus/` parce que la CI amont exécute `bun run format:check` :
sans cette entrée, Prettier reflowe les tableaux et les blocs de spec, ce qui est une mutation
silencieuse d'un document normatif. L'entrée suit la convention déjà présente dans le fichier
pour le contenu consommé verbatim (`backend/cli/skills/`).

**Écart avec la spec.** Deux. Le placement de `CLAUDE.md`, ci-dessus. Et la création de ce
fichier, qui appartient formellement à W0.10 : ADR 0010 exige que toute modification hors de
`src/locus/**` soit justifiée dans l'`IMPLEMENTATION_LEDGER.md`, et cette entrée en est une —
il fallait donc que le fichier existe. W0.10 garde `xiiif` et `emacs-config`.

**Prochain item.** W2.1 — remote `upstream`, `docs/locus/upstream.md`, politique de sync. Ses
dépendances sont satisfaites : W2 ne dépend pas de W1, et ADR 0010 déclare déjà le remote
`upstream` comme conséquence. À noter cependant que le premier item réellement bloquant du
chantier est W0.4 à W0.9 côté `locusolus` : W2.5 et suivants consomment le SDK et le harness de
conformance qui en sortent.

## 2026-08-13 — W2.1 — remote `upstream` et politique de synchronisation

**Périmètre.** Trois fichiers neufs, tous dans le périmètre Locus : `docs/locus/upstream.md`
(la politique écrite), `backend/cli/src/locus/{upstream,upstream-merge}.ts` (la même politique,
exécutable) et `backend/cli/test/locus/upstream.test.ts`. **Aucun fichier amont modifié** pour cet
item : aucune justification ADR 0010 n'est due. Le remote `upstream` lui-même n'est pas versionné —
il vit dans `.git/config` — mais son URL et sa branche le sont, dans `upstream.ts`.

**Tests exécutés.** `bun test test/locus/upstream.test.ts` depuis `backend/cli` : 9 pass, 0 fail.
Le test de sortie de W2.1 — « un merge amont à blanc ne touche aucun fichier local » — s'exécute
réellement ici, pas dans sa branche dégradée : `dryRunMerge` rend `ok: true` avec
`localTouched: []`, `justifiedTouched: []` et 60+ chemins amont. `bun run typecheck` : 7/7.
`prettier --check` sur les deux répertoires Locus : conforme.

Les deux garde-fous ont été vérifiés par mutation, pas seulement observés verts. En ajoutant
`backend/cli/src/tool/bash.ts` — un fichier que l'amont modifie réellement — à `LOCAL_PATHS`, le
test de sortie **et** le test de dérive de la doc passent au rouge. Un test de sortie qui ne peut
pas rougir ne mesure rien : celui-ci pouvait passer par vacuité si `isLocal` était cassé, et la
mutation établit qu'il ne le fait pas.

**Décisions prises.** Trois.

_Le contrôle est un merge à blanc, pas un merge._ `git merge-tree --write-tree HEAD upstream/main`
calcule l'arbre fusionné en mémoire objet ; la comparaison porte sur cet arbre via
`git diff --name-only`. Rien n'est écrit — ni index, ni répertoire de travail, ni commit. Deux
conséquences voulues : le contrôle tourne sur un arbre sale, et un échec ne laisse pas le dépôt à
moitié fusionné. Un contrôle qu'on n'ose pas lancer n'est pas lancé.

_Le verdict a trois catégories, pas deux._ `localTouched` / `justifiedTouched` /
`upstreamTouched`. Un merge qui touche du code amont est un merge normal ; un merge qui touche
`CLAUDE.md` ou `.prettierignore` est le coût connu et écrit de W0.1 ; un merge qui touche du code
Locus veut dire que le périmètre a fui. Seul le troisième est une faute, et les confondre rendrait
le contrôle soit bruyant soit muet.

_Le remote n'est jamais réécrit en silence._ `ensureUpstream` ajoute `upstream` s'il manque, mais
un remote existant qui pointe ailleurs est **signalé**, pas corrigé. Quelqu'un l'a peut-être fait
exprès, et écraser sa configuration pour faire passer un contrôle serait le contraire de ce que le
contrôle sert à établir.

**Écart avec la spec.** Aucun sur le périmètre de l'item. Deux ajouts au-delà de sa lettre, tous
deux dans le périmètre Locus.

Le premier : un test de **dérive** entre `docs/locus/upstream.md` et le code. Deux endroits disent
le périmètre — le code, qui l'applique, et la doc, qu'un humain lit avant de résoudre un conflit.
Le second qui dérive du premier est pire qu'absent : on résout un conflit en croyant une liste qui
n'est plus la bonne. Le test exige que la doc énumère chaque `LOCAL_PATHS` et chaque
`JUSTIFIED_UPSTREAM_EDITS`.

Le second : le cas du **clone superficiel**, nommé explicitement. Sans base de fusion, `merge-tree`
refuse avec un message qui ressemble à une panne réseau. `dryRunMerge` teste donc `git merge-base`
d'abord et distingue « amont injoignable » de « clone superficiel : la frontière coupe l'ancêtre
commun (fetch-depth: 0) ». Ce n'est pas cosmétique : `actions/checkout` clone à `fetch-depth: 1`
par défaut, donc **un job CI qui exécuterait ce contrôle tel quel tomberait toujours dans la
branche dégradée** et déclarerait un contrôle qui n'a jamais tourné. Le test le dit sur
`console.warn` au lieu de passer en silence, et c'est W2.2 qui devra donner `fetch-depth: 0` au job
qui l'exécute. La dette est ici, écrite, plutôt que découverte au premier merge.

**Prochain item.** W2.2 `[R]` — non-régression standalone en CI (§28.8), avant tout code `locus/`,
test de sortie « passe sur le HEAD actuel ». Ses dépendances sont satisfaites : elle ne dépend que
du HEAD amont. Elle hérite de la dette ci-dessus, le `fetch-depth: 0` du job qui exécute le merge à
blanc.
