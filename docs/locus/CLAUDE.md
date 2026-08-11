# CLAUDE.md — canterel

## Ce que ce dépôt est réellement

**Un fork non divergé de `synthetic-sciences/OpenScience`** (Apache-2.0), pas un codebase dont ce
projet hérite. Le seul commit local est le merge de synchronisation amont. Le produit s'appelle
OpenScience, les packages sont `@synsci/*`, le `NOTICE` est au nom de Synthetic Sciences.

Le rename GitHub `openscienceDH` → `canterel` est **déjà fait**. « Canterel » nomme le worker, son
mode de déploiement et son identité LEP (`worker_kind: "canterel"`).

## Règle dure — lis-la avant d'écrire quoi que ce soit

**Aucun rebrand.** Ne renomme pas `@synsci/*`, ni les import paths, ni les fichiers amont, ni le
`NOTICE`. Voir ADR 0010. Un rebrand toucherait 498 fichiers et ferait de chaque
`git merge upstream/main` un conflit de masse — ce qui détruirait précisément ce que §30.1 demande
de préserver.

**Tout le code local vit sous `backend/cli/src/locus/**` et `backend/cli/test/locus/**.**
C'est un répertoire neuf : zéro conflit de merge. Toute modification hors de ce périmètre est
justifiée dans `IMPLEMENTATION_LEDGER.md`, parce qu'elle sera payée à chaque sync.

## À préserver, existe déjà, ne pas reconstruire

`src/agent/`, `src/provider/`, `src/tool/`, `src/skill/`, `src/mcp/`, `src/lsp/`, `src/session/`
(avec `compaction.ts`, `review.ts`, `trace.ts`), `src/permission/`, `src/sandbox/`,
`src/worktree/`, `src/science/`, `frontend/workspace`. Les dix éléments de `SPEC_V1.md` §30.1
existent tous.

## Homonymies à ne pas confondre

`src/scheduler/`, `src/artifact/`, `src/session/review.ts` et `src/permission/` existent déjà avec
un sens **local**. Ce ne sont pas le scheduler global, l'artifact registry, l'institution de revue
ni le policy engine de Locus — que §30.3 interdit de dupliquer ici. Aucun module de `src/locus/**`
n'importe `src/scheduler`, `src/session/review` ou `src/artifact` : passe par `scheduler-local.ts`
et `artifact-client.ts`.

## Non-régression standalone

Le mode autonome ne doit jamais charger `src/locus/**`. Ce test s'écrit **avant** le premier
module `locus/` et tourne en CI (`SPEC_V1.md` §28.8). `bun run check` passe avant et après chaque
commit.

## Sur la sandbox

`src/sandbox/sandbox.ts` est du containment en écriture, allow-by-default, lectures ouvertes, sans
cgroups ni quota. C'est **S1/S2 au sens de `docs/03`, jamais S3/S4**, et c'est un choix délibéré
documenté dans le module. Le `CapabilityManifest` doit annoncer le niveau réel et rien de plus.

---

## Identité

- Locus Solus = laboratoire/control plane.
- Canterel = runtime scientifique agentique.
- LEP = protocole générique d’exécution.
- `locusd` = daemon Locus Solus.
- `locus-execd` = broker d’exécution privilégié lorsque nécessaire.
- `locus` = CLI.
- `locusolus/apps/emacs` = client Emacs produit, dans le monorepo (ADR 0009).
- xiiif = viewer IIIF humain.

## Invariants non négociables

1. Le domaine ne dépend pas du backend de déploiement.
2. PostgreSQL/event store et graphe Locus sont la vérité institutionnelle, pas les transcripts.
3. Un worker ne modifie jamais directement la base canonique.
4. Tout résultat scientifique majeur est artifact-first et provenance-first.
5. L’exécution non fiable se fait dans une sandbox réelle avec limites et attestation.
6. Les ressources sont réservées avant exécution ; elles ne sont pas supposées illimitées.
7. Temporal est un backend, pas une abstraction métier.
8. Le GPU est une capability, pas une dépendance globale.
9. Emacs commande et inspecte ; le web rend les visualisations riches.
10. xiiif n’est pas requis par les agents.
11. Les reviewers indépendants ne reçoivent pas le raisonnement privé ou le contexte non autorisé du générateur.
12. Les résultats négatifs et conflits ne sont jamais supprimés pour rendre le graphe “propre”.

## Qualité du code

- simplicité avant abstraction spéculative ;
- types stricts ;
- schémas versionnés ;
- pas de fonctions géantes ;
- pas de duplication cross-repo des contrats ;
- erreurs structurées ;
- timeouts et cancellation ;
- logs corrélés sans secrets ;
- tests unitaires + contract + integration selon couche ;
- aucune dépendance implicite à une machine de développeur.

## Git

Un commit = objectif cohérent et testable. Ne mélange pas rename massif, refactor, nouvelle fonctionnalité et bugfix sans nécessité. Les migrations importantes ont un ADR et un plan de rollback.

## Sécurité

Ne monte jamais le home utilisateur, le socket Docker/Podman ou un répertoire de secrets dans une sandbox par défaut. Ne logge ni OAuth token, API key, cookie ni contenu classifié. Réseau deny-by-default pour code non fiable.

---

## Note d'origine du handoff

Ce repo est l’ancien openscienceDH. Préserver les fonctions existantes. Ajouter LEP comme mode worker, sans déplacer le domaine Locus ici. Distinguer inference provider et compute local. Respecter EnvironmentBlueprint/SandboxSpec/ResourceSpec. Toute incompatibilité avec le standalone est une régression sauf décision explicite.
