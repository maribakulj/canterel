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

## 2026-08-13 — W2.2 — non-régression standalone en CI (§28.8)

**Périmètre.** `backend/cli/src/locus/standalone.ts`, `backend/cli/test/locus/standalone.test.ts`
et `.github/workflows/locus.yml`, plus un correctif sur `upstream-merge.ts` / `upstream.test.ts`
qui solde la dette écrite en W2.1. **Un fichier hors périmètre Locus**, justifié ci-dessous.

**Tests exécutés.** `bun test test/locus/` : 28 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` sur les deux répertoires Locus et le workflow : conforme. Le test de sortie de
W2.2 — « passe sur le HEAD actuel » — passe : 386 fichiers atteints depuis `src/index.ts`, aucun
sous `src/locus/`, aucun constat.

La première poussée a fait **rougir le job `Test`**, et sur mon propre test : « chaque déclaration
porte sa raison et sert réellement ». Cause réelle, instructive. Le job `Test` construit les assets
web avant de lancer la suite ; les autres jobs non. `./assets.generated` s'y résout donc, n'est
jamais relevé comme absent, et mon assertion exigeait qu'il le soit — j'avais confondu « déclaré »
et « actuellement manquant ». Le relevé se fait désormais **avant** la résolution : ce qu'on veut
savoir est stable dans les deux états, à savoir si la déclaration correspond encore à un import
réel. Vérifié dans les deux, en fabriquant puis retirant les trois fichiers générés. Un test le
verrouille, parce que c'est exactement le genre de dépendance à l'environnement qui revient.

Vérifié par mutation sur l'arbre réel, pas sur une maquette. En ajoutant à `src/cli/logo.ts`
— un fichier amont ordinaire, à trois niveaux de l'entrée — d'abord `import { LOCAL_PATHS } from
"@/locus/upstream"`, puis, séparément, `export const late = () => import("@/locus/standalone")`,
le test de sortie rougit dans les **deux** cas. Les deux portes sont donc réellement fermées, pas
seulement celle qui se voit.

**Décisions prises.** Cinq.

_Les coutures sont décidées maintenant, à froid, et il n'y en a aucune._ `canterel worker --locus`
devra bien atteindre le worker depuis quelque part : une règle qui l'interdit sans réserve serait
desserrée sous la pression le jour où elle gênera — c'est-à-dire au prochain item. `LOCUS_SEAMS`
est donc la liste, explicite et raisonnée, des fichiers hors périmètre autorisés à désigner Locus.
Elle est **vide au HEAD**, et c'est le point : y ajouter une entrée est un acte visible en revue,
pas un assouplissement discret. Une couture dispense du balayage textuel et **jamais** du parcours
du graphe, si bien que les deux règles ensemble disent exactement la bonne chose : une couture doit
être paresseuse. Un `import` statique vers Locus dans un fichier atteignable depuis `src/index.ts`
reste rouge, déclaré couture ou non.

_Le garde-fou marche le graphe d'imports depuis `src/index.ts`._ `docs/locus/CLAUDE.md` énonce la
règle sans détour — « le mode autonome ne doit jamais charger `src/locus/**` ». C'est une propriété
du graphe, pas une intention, et la seule façon de la connaître est de le parcourir depuis le vrai
point d'entrée.

_Deux vérifications, parce qu'il y a deux portes._ Un `import` statique se voit dans le graphe. Un
`await import("./locus/…")` ne s'y voit pas : il n'existe qu'à l'exécution, sur une branche qui
peut ne jamais être prise en test, et se comporte pourtant exactement comme la dépendance que
§28.8 interdit. La seconde vérification balaie donc le texte de tout ce qui est hors périmètre à
la recherche d'un specifier désignant Locus, quelle qu'en soit la forme.

_Un import irrésolu est un constat, jamais un saut._ Le verdict d'un graphe incomplet ne vaut
rien. Trois modules d'amont ne se résolvent pas au HEAD parce qu'ils n'existent qu'après un build
(`./models-snapshot`, `./assets.generated`, `./bundled.generated`) : ils sont **déclarés** dans
`GENERATED_MODULES` avec leur raison, rapportés dans le champ `generated`, et un test exige que
chaque déclaration serve encore. Un irrésolu hors de cette liste reste rouge.

_Les alias `@/` sont suivis._ Découvert en écrivant le test d'ancrage, pas supposé : la première
version du résolveur ne suivait que le relatif et manquait 84 specifiers, soit 13 fichiers du
graphe — dont tout ce que `src/permission/next.ts` tire derrière lui. Un résolveur qui ignore une
classe d'arêtes croit parcourir le graphe, n'en voit qu'une partie, et rend un verdict rassurant
sur ce qu'il n'a pas regardé. Un test relit désormais les `paths` de `tsconfig.json` et échoue si
un alias y apparaît sans être connu du résolveur.

**Écart avec la spec.** Deux, l'un assumé, l'autre corrigeant W2.1.

_Le fichier hors périmètre._ `.github/workflows/locus.yml` est neuf, donc l'amont n'a rien du même
nom et **aucune synchronisation ne peut le conflicter** — c'est précisément pourquoi les deux jobs
vivent dans un fichier à eux plutôt qu'ajoutés à `ci.yml`, dont chaque hunk local serait payé à
chaque merge (ADR 0010). Le coût de sync est donc nul ; la justification est due quand même, et la
voici. Le job `standalone` exécute le garde-fou ; le job `upstream-sync` clone en `fetch-depth: 0`
et exécute le merge à blanc de W2.1 pour de vrai. Ce que W2.2 n'ajoute pas : la suite historique
elle-même, que le job `Test` amont exécute déjà. §28.8 demande qu'elle reste testée sans Locus —
elle l'est ; W2.2 fournit le garde-fou qui empêche que ça cesse d'être vrai.

_Une correction de W2.1, écrite ici parce que le journal ne se réécrit pas._ L'entrée précédente
annonçait un court-circuit sur clone superficiel. Il a été écrit, puis retiré : il est **faux**.
Un clone superficiel garde souvent un ancêtre commun avec l'amont, parce que sa frontière tombe
au-delà du point de fork — c'est le cas de ce dépôt même, où le merge à blanc s'exécute
réellement malgré `.git/shallow`. Court-circuiter sur `--is-shallow-repository` aurait sauté un
contrôle parfaitement exécutable, et un contrôle sauté par excès de prudence ne se distingue plus
d'un contrôle absent. La superficialité ne se constate donc qu'**après** l'échec de `merge-base`,
comme cause possible, jamais comme prédiction. Reste acquis de la dette : `LOCUS_UPSTREAM_STRICT`,
que seul le job `upstream-sync` positionne — là où le contrôle fait autorité, se dégrader n'est
plus une excuse mais une panne.

**Prochain item.** W2.3 `[R]` — `src/locus/{index,config,errors}.ts` + `canterel worker --locus`
qui ne fait rien, test de sortie « `bun run check` vert ; standalone intact ». Ses dépendances sont
satisfaites, et c'est exactement le pas que le garde-fou de W2.2 existe pour surveiller : la
commande `worker --locus` devra être atteignable sans que `src/index.ts` charge `src/locus/**`.

## 2026-08-13 — W2.3 — `src/locus/{index,config,errors}.ts` et un worker inerte

**Périmètre.** Dans le périmètre Locus : `src/locus/{index,config,errors}.ts`,
`test/locus/config.test.ts`, plus les mises à jour de `standalone.ts` et `upstream.ts` que cet item
provoque. **Deux éléments hors périmètre**, de natures différentes et justifiés séparément
ci-dessous : `src/cli/cmd/worker.ts` (fichier neuf, couture déclarée) et `src/index.ts` (deux
lignes, modification amont). `docs/locus/upstream.md` suit, parce que le test de dérive de W2.1
l'exige — et c'est exactement ce pour quoi il a été écrit.

**Tests exécutés.** `bun test test/locus/` : 46 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme. La suite complète locale rend 78 échecs, tous du jeu préexistant lié
à l'environnement (bubblewrap absent, assets web non construits, sémantique de `ps` dans ce
conteneur) : le contrôle « aucun échec ne mentionne locus, worker ou index » est vide, et la CI est
l'autorité — elle rendait 0 fail avant cet item.

Le test de sortie de W2.3 est double et les deux moitiés passent. `bun run check` : vert.
_Standalone intact_ : le garde-fou de W2.2 reste vert avec la commande enregistrée, ce qui est la
propriété intéressante — `src/locus/**` n'entre pas dans le graphe de démarrage bien que la CLI
expose désormais `canterel worker`.

Exécuté pour de vrai, pas seulement typé. `canterel worker --locus http://127.0.0.1:7420 --identity
canterel-test --labels "local, interactive"` rend la configuration résolue et `worker: inert` ;
sans options, il rend `incomplet — manque : locus.endpoint, locus.identity` ;
`LOCUS_MAX_CONCURRENCY=beaucoup` rend `configuration Locus invalide — LOCUS_MAX_CONCURRENCY :
attendu un entier, reçu beaucoup` et sort en code 1.

**Décisions prises.** Cinq.

_`config.ts` est un port pur._ Il ne lit ni fichier ni réseau et reçoit son environnement en
paramètre. La fusion des cinq niveaux de priorité de §6 est une fonction de données vers données,
donc testable sans disque — et un module qui va chercher son contexte tout seul se teste en mutant
le processus et se comporte différemment selon qui l'appelle. Un test vérifie que le fichier ne
contient ni `node:fs`, ni `fetch(`, ni `Bun.spawn`.

_Aucun champ de secret dans la configuration, et un seul rendu._ §6 exige que les secrets
n'apparaissent jamais dans un log ou un diagnostic exporté. La façon la plus sûre de tenir cette
promesse est qu'il n'y ait rien à omettre : le token d'enrôlement de §7.2 est un argument à usage
unique, pas un champ de configuration. `describeConfig` est le seul rendu autorisé à sortir, pour
que la promesse ait **un** endroit où être tenue plutôt qu'autant d'endroits qu'il y a de
`console.log`. Le test porte sur les champs qui pourraient **porter** un secret, pas sur les noms
qui en parlent : `reject_plaintext_secrets` est un booléen de politique, et interdire le mot
plutôt que la charge donnerait un test qu'on contourne en renommant le champ.

_Les défauts sont les plus stricts que §6 propose._ `enabled: false`, `max_concurrency: 1`,
`reject_plaintext_secrets`, `fail_closed_on_policy_error`, `redact_prompts`. Un défaut permissif se
propage dans toutes les installations qui n'ont rien configuré, c'est-à-dire la plupart.

_Une variable d'environnement illisible est un refus, jamais un silence._ Un worker qui ignore
`LOCUS_MAX_CONCURRENCY=beaucoup` et tourne à 1 fait quelque chose que personne n'a demandé, sans le
dire. `ENV_BINDINGS` est une table, et un test exige que chaque liaison déclarée soit réellement
lue : une variable documentée sans effet est pire qu'une variable absente, parce qu'on croit
l'avoir posée.

_Deux erreurs, et les deux sont levées._ `LocusConfigInvalid` porte le **chemin** du champ fautif,
pas un message, ce qui permet de pointer une ligne au lieu de faire relire un fichier.
`LocusNotConfigured` en est distincte parce que « tu n'as rien configuré » et « ce que tu as
configuré est faux » appellent deux gestes différents. Un catalogue d'erreurs écrit avant les
chemins de code qui les lèvent serait une liste de suppositions.

**Écart avec la spec.** Trois, dont deux sont des corrections d'items précédents.

_Le fichier amont modifié._ `src/index.ts` reçoit un import et un `.command(WorkerCommand)`. La
liste des commandes bouge en amont, donc ce hunk conflictera, et il n'a pas d'alternative : la CLI
amont n'expose aucun mécanisme d'enregistrement de commande par plugin — vérifié dans
`src/plugin/`. Le coût est deux lignes à rejouer. En regard, `src/cli/cmd/worker.ts` est un fichier
**neuf** : aucune synchronisation ne peut le conflicter, et il est déclaré dans `LOCUS_SEAMS` plutôt
que dans `JUSTIFIED_UPSTREAM_EDITS`, parce que sa nature est d'être la couture, pas une modification.
Il est mince exprès — ce qui est dedans est payé à chaque sync, ce qui n'y est pas ne l'est pas. Il
porte une seule logique au-delà du câblage : la traduction de `LocusConfigInvalid` vers le
terminal, sans quoi l'utilisateur lit « Unexpected error, check log file » là où la couche sait
quel champ est fautif. Adapter une erreur Locus au terminal est le travail d'une couture, et le
faire là évite de toucher `src/cli/error.ts`.

_Correction de W2.2, trouvée par W2.3._ Le parcours de graphe suivait les `import()` **dynamiques**
comme des arêtes. C'est faux, et ça rendait toute couture paresseuse impossible à écrire : la
première tentative de câbler `worker.ts` a fait rougir le garde-fou alors que le code était
exactement celui qu'on veut. Le graphe de démarrage est ce qui se charge au seul fait de démarrer ;
un `import()` attend qu'on prenne sa branche. Les deux sortes sont désormais **résolues** — pour
que le compte des irrésolus et des modules générés reste complet — et une seule est **suivie**. Ne
pas les résoudre du tout aurait fait qu'un garde-fou cesse de regarder une classe entière de
specifiers sans le dire à personne.

_Un piège de zod 4, à retenir._ `.default(v)` en zod 4 rend `v` **sans le parser**, contrairement à
zod 3. Les objets imbriqués déclarés `.default({})` sortaient donc littéralement `{}`, et tous les
défauts de sécurité de §6 étaient silencieusement absents — `config.security.reject_plaintext_secrets`
valait `undefined`, pas `true`. C'est `.prefault({})` qu'il faut. Le test des défauts sûrs l'a
attrapé au premier passage ; écrit après coup, il aurait constaté l'absence au lieu de la refuser.

**Prochain item.** W2.4 `[R]` — `identity.ts`, `auth.ts`, enrôlement, révocation (§7), test de
sortie « identité persistante après redémarrage ». Ses dépendances sont satisfaites : la
configuration, les erreurs structurées et la couture existent. Il apportera le premier secret réel
du dépôt (le token d'enrôlement de §7.2) — le test qui interdit un champ de secret dans la
configuration est là pour qu'il aille ailleurs qu'en configuration, et §7.1 dit où : une clé privée
locale protégée, qui ne quitte jamais la machine.
