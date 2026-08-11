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

**Sur ce dépôt : toute modification hors de `backend/cli/src/locus/**` et
`backend/cli/test/locus/**` est justifiée ici, parce qu'elle sera payée à chaque synchronisation
amont (ADR 0010).**

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
