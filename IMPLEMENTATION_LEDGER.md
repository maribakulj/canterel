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

## 2026-08-13 — W2.4 — identité persistante, enrôlement et révocation (§7)

**Périmètre.** Entièrement dans le périmètre Locus : `src/locus/{identity,auth}.ts`,
`test/locus/identity.test.ts`, quatre erreurs ajoutées à `errors.ts` et les réexports d'`index.ts`.
**Aucun fichier amont touché** : aucune justification ADR 0010 n'est due pour cet item.

**Tests exécutés.** `bun test test/locus/` : 71 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme. Le test de sortie de W2.4 — « identité persistante après
redémarrage » — passe, et il vérifie la clé plutôt que les octets : une signature produite après
relecture se vérifie avec la clé publique d'avant. Comparer les chaînes n'aurait prouvé que
l'égalité des fichiers.

**Décisions prises.** Quatre.

_La clé privée vit dans un fichier `0600`, pas dans un trousseau système._ Un trousseau serait
mieux gardé sur macOS et inexistant ailleurs ; `docs/locus/CLAUDE.md` interdit « toute dépendance
implicite à une machine de développeur », et un worker doit s'enrôler identiquement sur un runner
Linux sans session graphique. Le fichier est créé en `wx` avec le mode `0600` puis synchronisé —
exactement ce que `src/util/secret-file.ts` fait déjà en amont, dont la posture (« refusing to
replace it ») est reprise telle quelle.

_Jamais de régénération silencieuse._ C'est la propriété la plus importante du module. Une identité
qu'on remplace parce qu'on n'a pas su la relire est une identité perdue, et avec elle tout ce que
`locusd` a enregistré sous ce `worker_id`. Clé illisible, couple incohérent, fichier tronqué,
moitié d'identité présente : tous produisent une `LocusIdentityUnusable` qui demande une
intervention.

_Un worker révoqué garde son identité._ §7.4 : il ne l'oublie pas, il la sait révoquée. L'effacer
le ferait repartir avec un `worker_id` neuf au prochain démarrage — c'est-à-dire contourner la
révocation en redémarrant. Ce qui reste permis est **énuméré** (`REVOKED_ALLOWED_ACTIONS`) plutôt
que ce qui est interdit : une liste d'interdits oublie toujours l'action ajoutée le mois suivant,
et l'oubli penche du mauvais côté.

_Le transport d'enrôlement est un port injecté._ `locusd` n'existe pas encore et
`docs/locus/CLAUDE.md` demande les interfaces avant le branchement. Conséquence utile : tout le
module se teste sans réseau, refus compris. §7.3 est appliqué avant tout envoi — TLS obligatoire
hors boucle locale, et « localhost » n'est **pas** une boucle locale, parce qu'un nom résolu par
DNS peut désigner autre chose que la machine locale. Seuls les littéraux de bouclage passent.

**Écart avec la spec.** Un manque assumé et une découverte.

_`canterel worker enroll` n'existe pas encore._ §7.2 écrit la commande, et elle demande un
transport HTTP réel que W2.5 apporte avec `connection.ts`. Une commande qui ne peut pas aboutir
serait pire qu'une commande absente. Le module est prêt et testé ; il lui manque son appelant.
Dans le même esprit, rien ne calcule encore **où** vit le répertoire d'identité : `loadOrCreateIdentity`
prend son chemin en paramètre, et c'est W2.5 qui le dérivera de la configuration. C'est écrit ici
plutôt que laissé à découvrir.

_Un trou dans mes propres tests, trouvé par mutation._ En mutant `loadOrCreateIdentity` pour qu'il
retombe sur la création en cas d'erreur de lecture — la régression exacte que le module existe pour
empêcher — la suite est **restée verte**. Cause : je testais la moitié d'identité dans un seul
sens, métadonnées effacées et clé conservée, où la création échoue de toute façon sur `EEXIST`. Le
sens inverse, clé effacée et métadonnées conservées, est le dangereux : rien n'empêche
techniquement d'écrire une clé neuve à côté, ce qui écraserait le `worker_id` enregistré. Le test
couvre désormais les deux sens et la même mutation le fait rougir. La seconde mutation — persister
le token d'enrôlement avec la créance — était bien attrapée du premier coup.

**Prochain item.** W2.5 `[R]` — `protocol.ts`, `schema-registry.ts`, `connection.ts` sur le SDK de
W0.8, test de sortie « contract tests contre le harness ». Ses dépendances sont satisfaites : le
SDK LEP et le harnais de conformance sont mergés côté `locusolus` (W0.8, W0.9), et l'identité que
§8.2 demande de signer dans le `worker.hello` existe depuis cet item. §8.1 impose d'épingler le SDK
**par commit Git** pendant la V1, pas par version npm publiée.

## 2026-08-16 — W2.5 — protocole, SDK épinglé et transport

**Périmètre.** Dans le périmètre Locus : `src/locus/{protocol,schema-registry,connection}.ts`,
la copie épinglée `src/locus/lep/{generated,negotiate,vendor}.ts` + `PINNED.json`, le harnais copié
`test/locus/harness/*`, et `test/locus/{contract,pin,connection}.test.ts`. **Un fichier amont
touché** : `.prettierignore`, déjà justifié depuis W0.1, dont la raison est étendue.

**Tests exécutés.** `bun test test/locus/` : 102 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme. Suite complète : 1885 pass / 79 fail, tous du jeu préexistant lié à
l'environnement, aucun ne mentionne Locus.

La CI a rougi une fois sur `Migration (windows-latest)`, et **ce n'était pas cet item**. Quatre
`ENOENT` sur des répertoires temporaires disparaissant en cours de test, dans
`test/global/data-dir.test.ts` — un fichier amont que ce diff ne touche pas, dans un job qui
n'exécute que ce fichier, dont le preload vise un préfixe temporaire différent. Aucun rerun n'étant
possible avec les permissions disponibles, un commit vide a produit un second échantillon : 15/15
vert sur le même contenu. Premier flake observé sur ce job en quatorze exécutions enregistrées ;
écrit ici pour que le prochain qui le rencontre n'ait pas à refaire l'enquête.

Le test de sortie de W2.5 — « contract tests contre le harnais » — passe : un worker Canterel bâti
sur la couche protocole traverse `runConformance` sans constat. Et il ne vaut que parce que le test
voisin rougit : le même worker qui accepte une mission S2 en n'offrant que S1 se fait prendre par
la règle `admission`. Un harnais qui ne trouve jamais rien valide n'importe quoi.

**Décisions prises.** Cinq.

_Le SDK est copié et épinglé, pas déclaré en dépendance._ §8.1 impose d'épingler par commit Git
plutôt que par version npm publiée. `@locus/lep` et `@locus/testing` vivent dans des
sous-répertoires d'un monorepo et sont `private` : ni npm ni bun ne savent tirer un sous-répertoire
d'un dépôt Git, et publier contredirait §8.1. Restait à toucher `package.json` et `bun.lock`, deux
fichiers amont, donc un conflit à chaque synchronisation pour une dépendance dont seul Locus a
besoin. La copie épinglée ne coûte rien à l'amont. Ce n'est **pas** une duplication du contrat : le
contrat, ce sont les schémas JSON de `locusolus/schemas/` ; ceci en est une lecture générée,
épinglée, vérifiée par empreinte, jamais retouchée.

_La réécriture d'imports est déclarée et rejouable._ Deux fichiers copiés référencent `@locus/lep`,
qui ne se résout pas ici. Plutôt que de corriger à la main — ce qui rendrait toute vérification
circulaire — la règle vit dans `vendor.ts` avec sa raison, et le test la rejoue. Une copie retouchée
puis réépinglée serait cohérente avec elle-même ; c'est exactement ce que la double vérification
empêche : empreinte locale hors ligne d'un côté, reproduction depuis la source de l'autre.

_Un mineur supérieur s'accepte, un majeur différent se refuse._ §8.2 dit « refuse une version
inconnue plutôt que de poursuivre en compatibilité implicite », et `docs/06` fait du mineur un ajout
de champs optionnels compatibles. Un worker `1.0` doit donc accepter un serveur `1.1` et ignorer ce
qu'il ne connaît pas, tout en refusant `2.0`. Refuser trop large fige le protocole ; accepter trop
large est la compatibilité implicite interdite. Le refus porte la liste de ce qui était offert —
savoir que le serveur n'annonçait que `2.0` distingue une mise à jour à faire d'une mauvaise
adresse.

_La signature du `worker.hello` couvre les features et la séquence, pas seulement l'identité._
Signer la seule identité laisserait un intermédiaire retirer une feature du message sans invalider
la signature : le worker tiendrait un accord qu'il n'a pas passé. Le test le vérifie en altérant
chacun des deux champs.

_La gigue de reconnexion tire vers le bas seulement._ §6 donne `max_ms` ; giguer vers le haut le
dépasserait, c'est-à-dire ignorer la seule limite que l'opérateur a écrite. Sans gigue du tout, un
parc entier revient en même temps et remet le serveur par terre au moment où il se relève — le test
le dit explicitement plutôt que de le supposer connu.

**Écart avec la spec.** Trois, tous écrits plutôt que laissés à découvrir.

_`schema-registry.ts` ne revalide pas les documents contre les schémas JSON._ Cela demanderait
`ajv`, absent de ce dépôt, donc une dépendance ajoutée à `package.json` et payée à chaque
synchronisation pour un besoin propre à Locus. Les schémas sont déjà validés là où ils sont le
contrat : la CI de `locusolus` valide son corpus de fixtures à chaque commit (W0.7). Ici les types
du SDK portent la forme, et ce que l'admission de W2.8 devra refuser se contrôle champ par champ —
un schéma dirait « objet valide » d'une mission qu'on ne peut pas tenir.

_La vérification contre la source amont sera toujours dégradée en CI._ `maribakulj/locusolus` est
privé et la CI de ce fork n'a pas de quoi le lire. Elle le **dit** au lieu de passer en silence,
comme le merge à blanc de W2.1. Ce qui tourne partout est l'empreinte locale, et c'est le contrôle
qui compte tous les jours : personne n'a retouché la copie à la main.

_`canterel worker enroll` n'est toujours pas exposé._ W2.4 disait qu'il attendait le transport ;
le transport existe maintenant. Ce qui manque désormais est la dérivation du répertoire d'identité
depuis la configuration, et la place naturelle de la surface CLI de §5.2 est W2.7
(`registration.ts`, handshake complet), qui en aura besoin de toute façon. Le déplacer est une
décision, pas un oubli.

**Prochain item.** W2.6 `[R]` — `capability-manifest.ts` et `capability-watch.ts`, détection réelle
des toolchains, modèles, accélérateurs **et du niveau de sandbox effectif**, test de sortie « sur
macOS : annonce `["S1","S2"]` et `mps`, jamais plus ». Ses dépendances sont satisfaites. Attention
signalée par `docs/locus/CLAUDE.md` : `src/sandbox/sandbox.ts` en amont est du containment en
écriture, allow-by-default, sans cgroups ni quota — c'est S1/S2 au sens de `docs/03`, jamais S3/S4,
et le manifeste doit annoncer le niveau réel et rien de plus.

## 2026-08-16 — W2.6 — manifeste de capacités et surveillance

**Périmètre.** Dans le périmètre Locus : `src/locus/{capability-manifest,capability-watch}.ts`,
`test/locus/capability.test.ts`, et un déplacement de la copie épinglée — `canonical.ts` passe de
`test/locus/harness/` à `src/locus/lep/`, parce que le hash du manifeste en a besoin côté `src`.
**Un fichier amont touché** : `.prettierignore`, déjà justifié, qui gagne le nouveau chemin épinglé.

**Tests exécutés.** `bun test test/locus/` : 123 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.6 — « sur macOS : annonce `["S1","S2"]` et `mps`, jamais plus » — passe, et
il tourne **en CI Linux**, ce qui est tout l'intérêt de la sonde injectée : un test qui n'aurait pu
s'exécuter que sur un Mac ne se serait jamais exécuté.

Vérifié par mutation dans les deux sens du mensonge. Faire annoncer `S3` : quatre tests rouges dont
le test de sortie. Faire annoncer `cuda` sur un Mac : deux rouges, dont le test de sortie. La faute
que ce module existe pour empêcher est donc réellement attrapée.

**Décisions prises.** Quatre.

_La détection passe par une sonde injectée._ Deux raisons, et la seconde est la vraie : ça rend le
module testable, et surtout ça rend **macOS testable depuis Linux**. Le reste du module est une
fonction de données vers données ; seule `hostProbe` touche à l'extérieur.

_S2 exige un backend qui **démarre**, pas un binaire présent._ Sur Ubuntu 24.04 la politique
AppArmor de l'hôte bloque les namespaces utilisateur non privilégiés et `bwrap` échoue à
l'exécution — le workflow amont le contourne explicitement pour ses propres tests. Annoncer S2 sur
la seule présence du binaire promettrait une isolation que la machine refuse.

_`allowlist` n'est jamais annoncé, et `deny` seulement avec isolation._ Ni Seatbelt tel que l'amont
l'écrit, ni bubblewrap ne filtrent par hôte : couper le réseau, oui ; le filtrer, non. Sans backend,
le worker n'annonce que `full` — une mauvaise nouvelle honnête plutôt qu'un `deny` qui ne dénierait
rien. Une restriction qu'on croit appliquée est pire que pas de restriction du tout.

_Les classes de données sont une politique, pas une détection._ Le défaut s'arrête à `internal` ;
`confidential` et `restricted` demandent qu'on les écrive. Un worker qui les annonce par défaut se
verra confier des données que personne n'a décidé de lui confier.

**Écart avec la spec.** Deux notes.

_Le hash du manifeste passe par la canonicalisation épinglée._ Il fallait donc `canonical.ts` sous
`src/`, alors que W2.5 l'avait copié sous `test/` avec le harnais. Plutôt que d'en garder deux
copies — ou pire, d'écrire un second canonicaliseur — la règle de réécriture pointe les deux
consommateurs vers une copie unique. Une seule source, toujours épinglée, toujours vérifiée.

_Le garde-fou d'intégrité a servi le jour même où il a été écrit._ En déplaçant `canonical.ts`,
`prettier --write` l'a reformaté avant que `.prettierignore` ne le couvre, et le test d'empreinte
de W2.5 est passé au rouge immédiatement. C'est exactement le cas qu'il existe pour attraper, et il
l'a attrapé sur son auteur.

**Prochain item.** W2.7 `[R]` — `registration.ts`, handshake complet, test de sortie « conformance
§8.2 ». Ses dépendances sont satisfaites : identité (W2.4), `worker.hello` signé et négociation
(W2.5), manifeste et son hash (W2.6). C'est aussi là qu'atterrit la surface CLI de §5.2 —
`canterel worker enroll` — reportée depuis W2.4 puis W2.5, avec la dérivation du répertoire
d'identité depuis la configuration qui lui manque encore.

## 2026-08-16 — W2.7 — enregistrement et handshake complet

**Périmètre.** Dans le périmètre Locus : `src/locus/registration.ts`,
`test/locus/registration.test.ts`, réexports d'`index.ts`. **Un fichier hors périmètre** :
`src/cli/cmd/worker.ts`, la couture déjà déclarée, qui gagne les sous-commandes `enroll` et
`status` de §5.2. Aucun fichier amont modifié.

**Tests exécutés.** `bun test test/locus/` : 136 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme. Le garde-fou de §28.8 reste vert alors que la couture a grossi de
deux sous-commandes : `src/locus/**` n'entre toujours pas dans le graphe de démarrage.

Le test de sortie de W2.7 — « conformance §8.2 » — passe. Exécuté aussi pour de vrai :
`canterel worker status` rend « aucune identité : cette installation n'est pas enrôlée », et
`canterel worker enroll --locus http://…` rend « serveur refusé — TLS obligatoire hors boucle
locale (§7.3) » en code 1.

**Décisions prises.** Trois.

_L'ordre des étapes de l'enregistrement n'est pas indifférent, et il est écrit._ L'identité se
charge avant le manifeste parce que le manifeste porte le `worker_id` ; le manifeste se hache avant
le hello parce que le hello porte ce hash ; la version s'accepte avant que quoi que ce soit soit
tenu pour acquis de la réponse, parce que §8.2 refuse une version inconnue plutôt que de poursuivre.

_La liste des champs obligatoires de §8.2 vit dans le module, pas dans le test._ Un test qui porte
sa propre liste finit par vérifier ce qu'il a écrit plutôt que ce que la spec demande.

_`enroll` est une sous-commande séparée._ §7.2 dit « le premier enrôlement doit être explicite ».
Le fondre dans `worker` ferait qu'un simple démarrage pourrait enrôler la machine, ce qui est
exactement ce que « explicite » exclut. Le token reste un argument de ligne de commande et n'est
jamais écrit.

**Écart avec la spec.** Trois notes, dont deux corrections trouvées en écrivant les tests.

_La signature du serveur rend trois valeurs, pas un booléen._ « Absente » et « invalide » appellent
des décisions différentes : un déploiement local peut légitimement ne pas signer — `signed-events`
se négocie — tandis qu'une signature présente et fausse n'est jamais un choix. Le corps signé lie
les **deux** nonces, sans quoi une signature capturée sur un autre handshake se rejouerait ; un
test l'établit en rejouant précisément cette capture.

_`checkHelloConformance` levait au lieu de rendre un constat._ `verify` lève sur une clé publique
illisible, et la fonction promet pourtant de rendre des constats. Elle mentait donc sur le worker
le plus cassé, celui dont on a le plus besoin du rapport. Trouvé parce qu'un test lui a passé une
clé vide.

_Un enrôlement refusé ne laisse plus d'identité derrière lui._ La première version chargeait
l'identité avant de valider l'endpoint : `worker enroll` vers une URL non TLS créait donc une
identité puis refusait. Le transport valide à sa construction, il se construit maintenant en
premier. Vérifié en exécutant la commande et en constatant qu'aucun répertoire n'est créé.

**Prochain item.** W2.8 `[R]` — `admission.ts` : validation, refus structuré (§10.2), politique
locale plus restrictive. Test de sortie : « la fixture de refus de W0.7 produit le bon code
d'erreur ». Ses dépendances sont satisfaites — le manifeste de W2.6 dit ce que le worker offre, et
le corpus de fixtures de W0.7 est mergé côté `locusolus`. À noter : la fixture de refus vit dans
`locusolus/schemas/examples/`, hors de ce dépôt ; il faudra soit l'épingler comme le SDK, soit
reconstruire le cas depuis les types — la première voie est cohérente avec W2.5 et sera préférée
sauf raison contraire.

## 2026-08-16 — W2.8 — admission et refus structuré (§10.2/§10.3)

**Périmètre.** Dans le périmètre Locus : `src/locus/admission.ts`, `test/locus/admission.test.ts`,
quatre fixtures du corpus de W0.7 épinglées sous `test/locus/fixtures/`, réexports d'`index.ts`.
**Un fichier amont touché** : `.prettierignore`, déjà justifié, qui gagne le répertoire de fixtures.

**Tests exécutés.** `bun test test/locus/` : 155 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.8 — « la fixture de refus de W0.7 produit le bon code d'erreur » — passe :
la paire `mission-envelope.json` × `capability-manifest.json` rend `sandbox_unavailable`, avec
`required_level: "S3"` et `offered_levels: ["S1","S2"]` en détails structurés.

Vérifié par mutation. Neutraliser le contrôle de sandbox : le test de sortie rougit, ainsi que le
test croisé. Laisser la politique locale élargir : le test de §10.3 rougit.

**Décisions prises.** Quatre.

_Les fixtures du corpus sont épinglées, pas réécrites._ Même mécanisme et même raison qu'en W2.5 :
ce sont les cas que `locusolus` a écrits pour définir ce qu'admettre veut dire. En produire une
seconde version ici la ferait diverger le jour où l'originale changerait — et un test d'admission
qui teste sa propre idée de l'admission ne teste rien. Un test vérifie en plus que la fixture porte
toujours son marqueur `expect: "refused"` et son `pairs_with` : sans lui, le test de sortie
passerait sur une fixture renommée ou remplacée.

_L'ordre des contrôles est celui du coût de l'erreur, pas celui du texte._ Le protocole d'abord —
ce qui rend le document ininterprétable ; puis la sécurité — sandbox, réseau, confidentialité ;
puis ce qui n'engage que le succès — ressources, budget, délai. Un worker qui refuserait d'abord
sur les ressources dirait « pas assez de CPU » d'une mission qu'il n'avait de toute façon pas le
droit d'exécuter.

_Le non-assouplissement de §10.3 est rendu impossible, pas vérifié._ `clampPolicy` intersecte la
politique locale avec ce que le manifeste offre. Vérifier après coup qu'une politique n'élargit
rien suppose que quelqu'un pense à vérifier ; l'intersection le garantit par construction. Le test
le montre sur le cas gênant : une politique qui prétend autoriser `restricted` ne l'autorise pas,
**et** le refus reste `confidentiality_unsupported` plutôt que `local_policy_denied`, parce que
c'est le manifeste qui refuse — l'inverse laisserait croire qu'assouplir la politique suffirait.

_Les champs facultatifs sont lus défensivement._ Le schéma est ouvert (docs/06) : une mission `1.0`
peut ne pas porter ce que ce code sait lire, une `1.1` peut porter ce qu'il ignore. Supposer la
présence ferait refuser une mission parfaitement valide.

**Écart avec la spec.** Deux notes.

_Quatre des quatorze codes ne sont pas encore produits._ `invalid_signature`, `model_unavailable`,
`tool_forbidden` et `data_locality_violation` sont déclarés — ils sont le contrat — mais aucun
chemin ne les lève : la vérification de signature appartient à la connexion, les modèles et outils
à la couche d'adaptation de W2.11, la localité des données à une politique que §21.9 n'a pas encore
donnée à ce worker. Les déclarer sans les produire est volontaire : la liste est le contrat de
§10.2, et l'amputer la rendrait fausse. Écrit ici pour que leur absence soit un manque connu et non
une découverte.

_Une erreur de ma part dans le test, corrigée._ Le cas « mode réseau inapplicable » avait choisi
`connector-only`, que le worker VM Linux annonce bel et bien : le test vérifiait donc un refus qui
n'avait pas lieu d'être, et c'est le code qui avait raison. `full` est le seul mode absent de ce
manifeste.

**Prochain item.** W2.9 `[R]` — `lease.ts`, `attempt.ts`, heartbeats, perte de lease (§11). Test de
sortie : « expiration et reprise contre le harness ». Ses dépendances sont satisfaites : le harnais
épinglé vérifie déjà la règle de §12.3 que le schéma ne savait pas exprimer — battre à intervalle
strictement inférieur au tiers du TTL — et l'admission de W2.8 dit maintenant quelles missions
arrivent jusqu'à une lease.

## 2026-08-16 — W2.9 — leases, attempts, heartbeats et perte de lease (§11)

**Périmètre.** Entièrement dans le périmètre Locus : `src/locus/{lease,attempt}.ts`,
`test/locus/lease.test.ts`, réexports d'`index.ts`. **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 176 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.9 — « expiration et reprise contre le harness » — passe, et il passe
**contre le harnais épinglé**, pas contre une reformulation locale de ses règles : un attempt qui
rend 100 s après son échéance traverse `runConformance` sans constat parce qu'il se déclare
tardif ; une reprise qui rejoue un événement à l'identique passe aussi.

Vérifié par mutation. Supprimer le marqueur tardif : le test de sortie rougit. Autoriser toute
transition d'état : les deux tests de §11.2 rougissent.

**Décisions prises.** Cinq.

_L'horloge est un paramètre, jamais lue._ `isExpired`, `heartbeatDue`, `remainingMs` et
`lateMarker` reçoivent l'instant. Sans ça, ces règles ne se testeraient qu'en dormant — et un test
qui dort finit désactivé.

_Une échéance illisible est traitée comme expirée._ « Je ne sais pas lire la date, donc je
continue » est exactement la posture qui fait produire un résultat après la fin d'un droit
d'exécuter.

_Le premier battement est dû immédiatement._ Traiter « jamais battu » comme « battu à l'instant »
ferait attendre un intervalle complet avant le premier signe de vie, soit un cinquième de TTL de
retard pour rien.

_La machine à états de §11.2 est une **donnée**._ Une table, pas une suite de `if` : c'est ce qui
permet de répondre « depuis `running`, où peut-on aller ? », et surtout de refuser une transition
que personne n'a autorisée au lieu de la laisser passer parce qu'aucun `if` ne la mentionnait. Le
refus **nomme les sorties possibles** — dire seulement « transition invalide » obligerait à relire
le diagramme alors que la réponse est déjà dans la table. Deux tests de structure interdisent qu'un
état existe sans entrée, ou qu'une entrée pointe vers un état inexistant.

_Une perte de lease donne `lease_lost`, jamais `failed`._ Un attempt échoué a produit un verdict ;
un attempt qui a perdu sa lease a perdu le **droit** d'en produire un. Les confondre ferait passer
une panne d'infrastructure pour un résultat scientifique négatif, ce que l'invariant 12 interdit
précisément de brouiller. Côté protocole il devient `orphaned`, pas `failed`.

**Écart avec la spec.** Deux notes.

_Le vocabulaire d'états est traduit, pas aligné._ `Attempt.state` du SDK est un sous-ensemble des
états de tâche de §5, et son commentaire généré dit pourquoi : `accepted`, `rejected` et
`superseded` en sont absents exprès, parce que ce sont des **verdicts de Locus Solus** sur un
attempt terminé, pas des états qu'un worker s'attribue. `toProtocolState` rend donc `null` pour
`offered`, `accepted` et `rejected` : un worker ne s'auto-décerne pas un verdict.

_Les gestes de §11.4 sont rendus comme données, pas exécutés._ `LEASE_LOST_ACTIONS` énumère ce que
le texte impose — arrêter les appels coûteux, révoquer les secrets, bloquer les écritures externes,
checkpointer si permis, déclarer les artefacts tardifs — mais ce module ne sait ni révoquer un
secret ni arrêter un appel. Prétendre le contraire mettrait la politique et sa mise en œuvre au
même endroit ; l'exécution appartient aux items qui possèdent ces ressources (W2.13 pour les coûts,
W2.14 pour les artefacts). Ce qui est acquis ici est que la liste se relit et se teste, et que
`present-commit-as-applicable` n'est **pas** dans ce qui reste permis — §11.4 est catégorique.

**Prochain item.** W2.10 `[R]` — `context-materializer.ts` et isolation informationnelle (§12.4).
Test de sortie : « un contexte de branche A n'atteint jamais une mission de branche B ». Ses
dépendances sont satisfaites. C'est l'item qui porte l'invariant 11 du projet — les reviewers
indépendants ne reçoivent pas le raisonnement privé du générateur — et §12.3 y ajoute que le hash
de la vue doit être vérifié **avant** démarrage.

## 2026-08-16 — W2.10 — matérialisation du contexte et isolation informationnelle (§12.4)

**Périmètre.** Entièrement dans le périmètre Locus : `src/locus/context-materializer.ts`,
`test/locus/context.test.ts`, une erreur ajoutée à `errors.ts`, réexports d'`index.ts`. **Aucun
fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 195 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.10 — « un contexte de branche A n'atteint jamais une mission de branche
B » — passe. Vérifié par mutation : neutraliser la garde de branche le fait rougir, laisser passer
un secret fait rougir l'interdit correspondant.

**Décisions prises.** Quatre.

_L'isolation de branche est une propriété de la **vue entière**, pas de chacun de ses éléments._
C'est la correction la plus importante de cet item, et elle a été trouvée par le test de sortie
lui-même. Ma première version filtrait élément par élément avec la règle « l'élément passe s'il est
de la branche de la mission **ou** dans la portée déclarée » — ce qui faisait de `branch_scope` une
**autorisation**, l'exact inverse de son rôle. C'est la même faute que W2.8 refuse pour la
politique locale : une portée restreint, elle n'ouvre jamais. Le schéma est plus fort que ma
première lecture — « une vue construite pour la branche A ne doit jamais atteindre une mission de
la branche B » parle de la vue, pas de son contenu. `assertBranchScope` refuse donc la vue **en
bloc**, et le filtrage élément par élément ne s'applique qu'à une vue déjà reconnue comme
légitime.

_Le défaut sans portée est la branche de la mission, et rien d'autre._ Une vue non rattachée à une
branche ne devient pas un passe-droit pour les conclusions d'une branche concurrente (§12.4).

_L'intégrité est vérifiée avant tout filtrage._ §12.3 dit « avant démarrage ». Filtrer d'abord
reviendrait à appliquer une politique d'isolation à un document qu'on n'a pas authentifié —
c'est-à-dire à faire confiance au document qui décrit ce à quoi on a droit. Le hash se calcule sur
la vue **privée de son propre champ de hash** : l'y inclure le rendrait invérifiable.

_Il n'existe aucune fonction qui accorde une extension._ §12.4 : « tout accès additionnel nécessite
`context.extension_requested` puis une décision Locus Solus ». Le module produit la **demande** ;
offrir un `grantExtension()` local offrirait le moyen de contourner exactement ce qu'il protège. Un
test vérifie l'absence de ces noms dans le module — une garantie qui vaut mieux qu'une intention.

**Écart avec la spec.** Deux notes.

_Ce qui n'est pas classable est refusé._ Une classe de confidentialité inconnue est traitée comme
au-dessus du plafond : ne pas savoir classer n'autorise pas à laisser passer. Même posture pour un
élément dont la position dépasse le watermark — il n'existait pas encore pour l'agent.

_Rien n'est écarté en silence._ Chaque exclusion porte un code stable et un détail lisible, et le
rapport est rendu même vide. Un contexte amputé sans que personne le sache produit un raisonnement
dont on ne saura pas qu'il était aveugle — et c'est cette liste qui permet à l'appelant de demander
une extension plutôt que de deviner ce qui lui manque. Pour la même raison, un contexte
intégralement écarté rend une liste vide et non une exception : l'exception ferait perdre les
raisons.

**Prochain item.** W2.11 `[R]` — `session-map.ts`, `agent-overlay.ts`, `model-policy.ts`,
`tool-policy.ts`, la couche d'adaptation vers l'amont. Test de sortie : « mission → session **sans
modifier `src/session/`** », ce qui en fait l'item le plus exposé au périmètre d'ADR 0010 de tout
W2 : toute la difficulté est d'adapter sans toucher. `docs/locus/CLAUDE.md` prévient déjà que
`src/session/`, `src/agent/` et `src/permission/` existent en amont avec un sens local, et
`model_unavailable` / `tool_forbidden` — deux des quatre codes déclarés sans être levés en W2.8 —
y trouveront leur producteur.

## 2026-08-16 — W2.11 — couche d'adaptation vers l'amont

**Périmètre.** Entièrement dans le périmètre Locus : `src/locus/{session-map,agent-overlay,
model-policy,tool-policy}.ts`, `forkModifiedFiles` ajouté à `upstream-merge.ts`,
`test/locus/session-map.test.ts`, réexports. **Aucun fichier amont touché** — ce qui est
précisément l'objet de l'item.

**Tests exécutés.** `bun test test/locus/` : 214 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.11 — « mission → session **sans modifier `src/session/`** » — passe, et il
s'exécute réellement plutôt que de se dégrader : `git diff` contre la base de fusion amont rend
**53 fichiers** modifiés par ce fork, dont **0** sous `src/session/`, `src/agent/`,
`src/permission/`, `src/provider/` ou `src/tool/`. Vérifié par mutation : déclarer `src/cli/`
intouchable — un répertoire que le fork touche réellement — fait rougir le test.

**Décisions prises.** Cinq.

_Une propriété négative se **mesure**, elle ne se relit pas._ « Sans modifier `src/session/` » ne
se démontre pas en inspectant le code : `forkModifiedFiles` demande à git ce que ce fork a changé
depuis son point de fork, sans dépendre de ce que quelqu'un a pensé à déclarer. Même posture de
dégradation qu'en W2.1 quand la mesure est impossible.

_Le module rend un **plan**, pas une session._ De la donnée : quel agent amont viser, quel overlay
poser, quels modèles et outils sont permis. Rien n'instancie, rien n'importe `src/session/`. Ce
n'est pas de la timidité — un plan se teste sans démarrer de session, et il survit à une refonte
amont de `src/session/`, ce qu'un adaptateur appelant ses fonctions internes ne ferait pas. Un test
vérifie qu'aucun des quatre modules n'importe `@/session`, `@/agent`, `@/permission`, `@/provider`
ni `@/tool` : adapter sans toucher vaut aussi pour les imports.

_L'overlay est additif par construction._ Il choisit un agent amont et pose des instructions
supplémentaires ; aucun champ ne remplace un prompt, et il n'en existe volontairement pas. Un
overlay qui le pourrait serait un agent local déguisé, que le prochain merge amont écraserait ou
contredirait sans que personne s'en aperçoive. Une revue **indépendante** vise `reviewer` quel que
soit le domaine : c'est l'invariant 11 qui décide, pas la discipline scientifique — confier une
revue indépendante à l'agent `biology` parce que la mission parle de biologie ferait relire le
travail par le même profil que celui qui l'a produit.

_`remote_inference` absent vaut **distant**._ Le champ est optionnel dans le schéma. Supposer
« local » par défaut ferait envoyer des données confidentielles à un fournisseur au premier
manifeste incomplet : le défaut prudent coûte au pire un modèle inutilisé, le défaut commode coûte
une fuite. La raison du refus distingue « aucun modèle » de « tous distants », parce que la seconde
dit à l'opérateur quoi installer.

_La politique d'outils raisonne sur des **facultés**, pas sur des noms._ Réseau, écriture hors
workspace, exécution. Nommer les outils de `src/tool/` créerait une liste à maintenir au rythme de
l'amont, donc fausse dès la première synchronisation — et un outil ajouté en amont serait autorisé
par défaut simplement parce que personne n'a pensé à l'interdire.

**Écart avec la spec.** Deux notes.

_Les deux derniers codes orphelins de W2.8 ont trouvé leur producteur._ `model_unavailable` et
`tool_forbidden` sont désormais levés. Restent `invalid_signature` — qui appartient à la connexion
— et `data_locality_violation`, qui attend la politique de localité que §21.9 n'a pas encore donnée
à ce worker. Deux orphelins sur quatorze, et leur absence reste écrite.

_Une substitution d'identité rattrapée par le typecheck._ Mon `SessionPlan` portait `attempt`
(le rang) là où `MissionEnvelope` porte `attempt_id` (l'identité). §11.1 est explicite : « aucune de
ces identités ne doit être substituée aux autres ». Le compilateur a refusé avant que le test ne
puisse le faire — c'est exactement le genre d'erreur que les types stricts existent pour attraper,
et je l'ai notée dans le code plutôt que corrigée en silence.

**Prochain item.** W2.12 `[R]` — `event-bridge.ts`, `event-spool.ts`, coalescence (§18). Test de
sortie : « perte de connexion : rien perdu, rien dupliqué ». Ses dépendances sont satisfaites : le
harnais épinglé vérifie déjà la monotonie des séquences et la déduplication par clé d'idempotence,
et §8.3 énumère ce que le worker doit persister — séquence serveur acquittée, séquence worker
émise, messages non acquittés, leases actifs, uploads incomplets.

## 2026-08-16 — W2.12 — event bridge, spool et coalescence (§18)

**Périmètre.** Entièrement dans le périmètre Locus : `src/locus/{event-spool,event-bridge}.ts`,
`test/locus/event-spool.test.ts`, réexports. **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 230 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.12 — « perte de connexion : rien perdu, rien dupliqué » — passe, et la
reprise traverse le harnais épinglé sans constat. Vérifié par mutation : purger le spool au
redémarrage fait rougir quatre tests dont celui de sortie ; rendre tout coalescible fait rougir la
règle de §18.3.

**Décisions prises.** Cinq.

_Le nettoyage n'a lieu qu'à l'acquittement, et nulle part ailleurs._ §18.4 le dit littéralement. Un
spool qui purge sur l'âge, la place ou un redémarrage perd exactement ce qu'il existe pour ne pas
perdre, et le perd au moment où ça compte — quand la connexion vient de tomber. Trois redémarrages
successifs sans acquittement laissent le spool intact.

_L'écriture disque précède l'ajout mémoire._ Dans l'autre ordre, un plantage entre les deux
laisserait un événement que le processus croit avoir spoolé et que le disque ignore : la perte
silencieuse que §18.4 interdit.

_La séquence est attribuée par le spool, jamais par l'appelant._ La lui laisser rendrait possibles
deux événements de même rang, ce que le harnais de conformance refuse à juste titre. Un test passe
une séquence forcée et vérifie qu'elle est ignorée.

_À saturation, le spool refuse ; il ne jette pas._ « Backpressure plutôt que de perdre les
événements canoniques » : refuser est bruyant, perdre est silencieux. Acquitter libère la place,
puisque c'est le seul mécanisme de nettoyage.

_La coalescence est écrite en deny-by-default._ §18.3 donne deux listes ; c'est la seconde qui
compte. Un type est coalescible seulement s'il figure dans la courte liste des coalescibles.
Prendre le problème par l'autre bout — « tout sauf ceci » — ferait qu'un type ajouté demain serait
fusionnable par défaut, et un coût ou une alerte perdus dans une fusion sont perdus pour de bon. Un
test vérifie que les deux listes ne se recoupent pas : c'est la seule façon de s'apercevoir qu'un
type a été rangé du mauvais côté.

**Écart avec la spec.** Trois notes.

_§18.2 cite deux champs que `lep/1.0` ne définit pas._ `message_id` et `correlation_id` n'existent
pas sur `Event` dans le schéma épinglé, qui porte `idempotency_key` comme identité de message et
aucun champ de corrélation. Les ajouter côté worker serait **dupliquer le contrat cross-repo**, ce
que `docs/locus/CLAUDE.md` interdit : un champ inventé ici ne serait ni validé ni reconnu par un
pair conforme. La vérification porte donc sur ce que le schéma définit réellement, et un test
garantit qu'aucun de ces deux noms n'est fabriqué dans le spool. **C'est un écart à porter côté
`locusolus`** — soit le schéma les ajoute en `1.1`, soit §18.2 s'aligne sur le schéma ; le worker
ne peut pas trancher seul.

_Une coalescence ne franchit jamais un événement non coalescible._ Sans cette coupure, deux
`progress` encadrant un `tool.completed` fusionneraient et feraient passer l'appel d'outil **après**
une progression qui le précédait. L'ordre est ce que le harnais vérifie, et une coalescence qui
réordonne est pire qu'une absence de coalescence. Deux attempts ne fusionnent pas non plus : ils
racontent deux histoires, et les fondre en ferait une troisième qui n'a eu lieu nulle part.

_Le scénario du test de sortie a été refait._ Ma première version rejouait la totalité du flux
**après** l'événement terminal, et le harnais l'a refusée à raison — c'est un flux que personne
n'émet. Le cas réaliste n'est pas « les événements se perdent » mais « l'acquittement se perd » :
le serveur a reçu les trois premiers, son ack n'est jamais arrivé, le worker retransmet un préfixe
déjà vu. C'est là que « rien dupliqué » se joue vraiment, et c'est ce que le test exerce désormais.

**Prochain item.** W2.13 `[R]` — `usage-meter.ts`, budget local, dépassement (§17). Test de sortie :
« arrêt propre au dépassement ». Ses dépendances sont satisfaites : l'admission de W2.8 refuse déjà
un budget non borné (`budget_unenforceable`), et §11.4 a établi en W2.9 ce qu'« arrêter les appels
coûteux » veut dire — la liste existe, il lui manquait un module qui sache compter.

## 2026-08-16 — W2.13 — budget local et mesure d'usage (§17)

**Périmètre.** Entièrement dans le périmètre Locus : `src/locus/usage-meter.ts`,
`test/locus/usage-meter.test.ts`, réexports. **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 245 pass, 0 fail. `bun run typecheck` : 7/7.
`prettier --check` : conforme.

Le test de sortie de W2.13 — « arrêt propre au dépassement » — passe : au plafond exactement,
`allowsNewSpend()` rend faux et l'échelle de §17.4 est montée marche par marche, sans saut.
Vérifié par mutation : supprimer l'arrêt fait rougir le test de sortie, masquer les divergences
fait rougir §17.3.

**Décisions prises.** Cinq.

_Le worker n'écrit aucun solde._ §17.2 : « Locus Solus conserve le ledger canonique. Canterel émet
des observations signées, pas des écritures directes de solde. » Il n'existe donc aucune fonction
qui écrive un solde, et un test vérifie l'absence de `setBalance`, `debit`, `credit`,
`applyLedger`. Ce module compte pour **décider localement** ; ce qui sort vers le serveur s'appelle
`observations()`, et le nom n'est pas décoratif.

_Une divergence est rendue, jamais réconciliée._ §17.3 : « les divergences sont signalées, jamais
masquées ». Prendre le plus grand, moyenner ou préférer le facturé ferait disparaître
l'information qui dit que la mesure est fausse quelque part. Le rapport `budget.usage` les
transporte, parce qu'un rapport qui tairait un écart transmettrait un chiffre en laissant croire
qu'il est sûr.

_Le facturé remplace l'estimé sur une même requête fournisseur, et seulement là._ Les additionner
compterait deux fois la même dépense. Sans identifiant de requête, les deux s'additionnent : deux
chiffres sans lien ne parlent pas forcément de la même dépense, et sous-compter un budget est pire
que le sur-compter.

_Une confiance absente vaut 0.5, pas 1._ Un chiffre sans confiance déclarée est un chiffre dont
personne n'a dit ce qu'il vaut ; le traiter comme certain ferait décider un arrêt sur une mesure
que rien n'étaye.

_`nominal` est un état nommé._ Le représenter par l'absence de marche rendrait « rien à faire » et
« je ne sais pas » identiques — la même raison qui fait rendre `null` plutôt que `0` au taux d'une
dimension sans plafond.

**Écart avec la spec.** Deux notes.

_Les seuils intermédiaires sont une politique, pas une lecture._ §17.4 dit « à l'approche du
plafond » sans chiffrer. `STAGE_THRESHOLDS` pose 0,75 / 0,85 / 0,95 et vit en table pour être
discutée et changée d'un seul endroit plutôt que dispersée dans des comparaisons. **Seul `stop` est
imposé par le texte** — « arrêt sûr **au** plafond », donc exactement 1, et un test le verrouille.
C'est un détail d'implémentation dans le cadre : tranché, écrit, non bloquant.

_« Arrêt sûr » ne veut pas dire « rien ne bouge plus »._ `allowsNewSpend()` gouverne ce qui
**engage** une dépense ; ce qui est déjà engagé doit se terminer proprement, et §11.4 a déjà défini
en W2.9 ce qui reste permis après une perte de droit d'exécuter. Les deux listes se rejoignent :
clôturer, checkpointer, déclarer tardif — jamais démarrer.

**Prochain item.** W2.14 `[R]` — `artifact-client.ts`, `artifact-scanner.ts`, déclaration avant
upload (§19.1). Test de sortie : « hash déclaré ≠ hash reçu → rejet ». Ses dépendances sont
satisfaites : le canonicaliseur épinglé sait déjà produire un `ContentHash` préfixé par son
algorithme, et le SDK impose ce préfixe — « un hash nu ne dit pas comment le recalculer, et une
vérification d'intégrité qui devine son algorithme n'en est pas une ».

## 2026-08-16 — W2.14 — artefacts : déclaration avant upload, scan et quarantaine (§19)

**Périmètre.** Dans le périmètre Locus : `src/locus/artifact-client.ts`,
`src/locus/artifact-scanner.ts`, `test/locus/artifact.test.ts`, une erreur ajoutée à
`src/locus/errors.ts`, réexports dans `src/locus/index.ts`, plus une correction dans
`src/locus/event-bridge.ts` et son test (voir « Correction »). **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 278 pass, 0 fail (16 fichiers). `bun run typecheck` :
7/7. `prettier --check` : conforme.

Le test de sortie de W2.14 — « hash déclaré ≠ hash reçu → rejet » — passe. Vérifié par mutation,
trois fois : neutraliser la comparaison du hash reçu fait rougir le test de sortie ; neutraliser le
blocage d'upload en quarantaine fait rougir §19.5 × §19.1 ; faire passer le contrôle antimalware
absent pour `enforced` fait rougir deux tests de §19.5.

**Décisions prises.** Six.

_Le rejet est une erreur levée, pas une valeur de retour._ Les deux autres issues de `publish`
laissent une suite possible — un artefact en quarantaine attend une revue, un upload non vérifié
attend un nouvel essai — alors qu'un hash qui ne correspond pas ne laisse rien à tenter. Le rendre
comme une valeur inviterait un appelant à l'ignorer d'un `if (!result.ok) continue`. §24.5 le dit
pour tout le système : « une incohérence déclenche quarantaine et diagnostic, jamais réparation
silencieuse ».

_Aucun chemin ne réécrit le hash déclaré._ Il n'existe ni `redeclare`, ni `acceptServerHash`, ni
`forceUpload`, et un test verrouille ces absences. Hasher ce que le serveur confirme avoir reçu
produirait une vérification qui ne peut jamais échouer, donc pas une vérification.

_Le contenu est re-hashé avant l'envoi, et le refus a lieu avant de demander l'URL temporaire._
C'est le cas ordinaire d'un worker qui écrit encore dans le fichier qu'il vient de déclarer. Le
test vérifie que `requestUpload` n'a pas été appelé : rien n'est sorti de la machine.

_Sans hash de réception, `artifact.uploaded` n'est pas atteint._ §19.1 place la vérification
**avant** l'événement ; l'émettre quand même transformerait « je crois » en « c'est fait ». L'issue
s'appelle `unverified` et l'état reste `declared`, ce qui est exactement vrai.

_L'URL temporaire subit la politique d'endpoint de §7.3._ Le ticket vient du serveur, donc c'est
une entrée distante : `assertEndpointAcceptable` s'y applique comme à l'endpoint d'enrôlement. Un
ticket en clair ou vers un hôte interne ferait sortir l'artefact par un chemin que personne n'a
autorisé. Une date d'expiration illisible vaut expirée — des deux choix, c'est le seul qui ne
puisse pas faire fuiter l'artefact.

_Chaque contrôle de scan rend son état, et le scanner n'efface rien._ §19.5 dit « malware **selon
outils disponibles** » : il y a des machines où ce contrôle ne tourne pas, et une passe qui n'a pas
eu lieu doit se distinguer d'une passe qui n'a rien trouvé. D'où `enforced` / `not-applicable` /
`skipped` par contrôle, et un `complete` global : un rapport `clean` avec `complete: false` n'est
pas un artefact propre, c'est un artefact partiellement regardé. Et « un échec ne supprime pas la
preuve » : aucune fonction n'efface ici, un test verrouille l'absence de `rmSync` / `unlinkSync`.

**Écart avec la spec.** Trois notes, toutes dans le cadre.

_Le seuil d'expansion d'archive est une politique._ §19.5 dit « archives dangereuses » sans
chiffrer. `MAX_ARCHIVE_EXPANSION_RATIO` vaut 200 et vit en constante pour être discutée d'un seul
endroit. Le scanner **n'extrait pas** : il lit l'en-tête gzip, qui déclare la taille non
compressée. Décompresser pour inspecter, ce serait exécuter la bombe qu'on cherche. Un zip ne porte
pas cette information en tête, donc son contrôle se déclare `skipped` plutôt que sain.

_Le contrôle `forbidden_data` s'appuie sur les classes autorisées de la mission._ La politique de
localité de §21.9 n'existe pas encore côté worker ; sans liste déclarée, le contrôle est `skipped`
et le dit. C'est aussi le producteur manquant du code de refus `data_locality_violation` relevé en
W2.8 — il attend toujours §21.9.

_`RunManifest` et `EnvironmentManifest` (§19.3, §19.4) ne sont pas remplis ici._ Le SDK épinglé les
définit ; ce sont les modules `executor.ts` et `sandbox-policy.ts` qui sauront ce qu'ils
contiennent. Les remplir depuis le client d'artefacts reviendrait à deviner l'environnement d'un
run qu'il n'a pas observé.

**Correction — §18.2, entrée de W2.12.** L'entrée de W2.12 affirmait que `lep/1.0` ne définit
« ni `message_id` ni `correlation_id` ». **C'est faux pour `correlation_id`** : le schéma
`event.schema.json` le définit, avec `causation_id`, tous deux facultatifs. Seul `message_id` est
réellement absent — `idempotency_key` y tient ce rôle, et l'arbitrage cross-repo sur ce nom reste
ouvert pour `locusolus`. Le commentaire de `event-bridge.ts` est corrigé ; `correlation_id` n'entre
pas dans `REQUIRED_EVENT_FIELDS` parce qu'il est facultatif au schéma et que c'est la couche qui
émet qui le pose — l'exiger de ce qui ne le pose pas encore ferait crier la vérification sur chaque
événement conforme.

Corrigé du même coup : `REQUIRED_EVENT_FIELDS` exigeait `task_id` et `attempt` de **tout**
événement, ce qui faisait passer `worker.registered` pour non conforme alors qu'il précède toute
tâche. Ces deux champs ne sont désormais exigés que des types listés dans `ATTEMPT_SCOPED_TYPES`.
Vérifié par mutation : réexiger `task_id` partout fait rougir le nouveau test.

**Note d'outillage.** Les appâts du scanner — en-tête de clé privée PEM, identifiant AWS — sont
assemblés à l'exécution dans le test. Écrits en clair, ils feraient rougir le job `Gitleaks`, à
juste titre : son travail est de crier sur ces formes dans le dépôt, et il n'a pas à savoir
lesquelles sont des décors. Les ajouter à `.gitleaksignore` aurait appris au garde-fou à ignorer
une forme réelle ; les assembler ne change rien à ce que le scanner d'artefacts voit.

**Prochain item.** W2.15 `[R]` — `epistemic-commit.ts`, jamais au-delà de `staged` (§2.3). Test de
sortie : « tentative de promotion → erreur structurée ». Ses dépendances sont satisfaites : le SDK
épinglé définit déjà `EpistemicCommit` avec ses claims, objections, inférences, décisions locales
et résultats négatifs, et l'invariant 12 — « les résultats négatifs et conflits ne sont jamais
supprimés pour rendre le graphe propre » — dit déjà ce que le module n'a pas le droit de faire.

## 2026-08-16 — W2.15 — commit épistémique : jamais au-delà de `staged` (§2.3, §21)

**Périmètre.** Dans le périmètre Locus : `src/locus/epistemic-commit.ts`,
`test/locus/epistemic-commit.test.ts`, une erreur ajoutée à `src/locus/errors.ts`, réexports dans
`src/locus/index.ts`. **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 296 pass, 0 fail (17 fichiers). `bun run typecheck` :
7/7. `prettier --check` : conforme.

Le test de sortie de W2.15 — « tentative de promotion → erreur structurée » — passe. Vérifié par
mutation, trois fois : ramener silencieusement un statut interdit à `staged` fait rougir trois
tests du groupe de sortie ; supprimer le marqueur tardif fait rougir §21.6 ; laisser la validation
locale ne plus bloquer fait rougir §21.4.

**Décisions prises.** Cinq.

_Le refus existe à l'exécution, pas seulement dans le type._ Le schéma épinglé rend déjà la
promotion indéfaisable — `status` n'y vaut que `draft` ou `staged`. Mais un type ne survit pas à la
frontière du processus : ce qui traverse le fil est du JSON, et du JSON ne porte aucun type.
`assertProposable` est le point d'entrée unique, et tout chemin qui pose un statut y passe.

_Une erreur structurée plutôt qu'un booléen._ Un appelant qui ignore un `false` produit un commit
promu ; un appelant qui ignore une exception ne produit rien du tout. `attempted` porte le statut
demandé, parce que la question qu'on se pose en lisant l'erreur est lequel a été tenté.

_Les verdicts de l'institution sont nommés._ `LOCUS_ONLY_STATUSES` liste `validated`,
`under_review`, `merged`, `promoted`… Les nommer coûte une constante et rend le refus lisible :
« `validated` est un verdict de l'institution » se corrige, là où « statut invalide » envoie relire
un schéma. Un statut inconnu du schéma reçoit un message distinct — ce n'est pas la même erreur.

_`draft` est le défaut, `stage` est la seule transition, et elle ne revient pas._ `staged` est ce
qu'on soumet : l'atteindre doit être un geste, pas une valeur par défaut. Il n'existe pas
d'`unstage` — revenir à `draft` laisserait croire qu'on peut retirer une proposition déjà partie.

_Objections et résultats négatifs ne font que s'ajouter._ Invariant 12 : « les résultats négatifs
et conflits ne sont jamais supprimés pour rendre le graphe propre ». Une fonction qui retirerait
une objection serait le moyen exact de le violer, donc elle n'existe pas, et un test verrouille
l'absence de `dropObjection`, `clearNegativeResults`, `pruneObjections` — la seule façon de garder
vraie une phrase que personne ne relit. De même, aucune fonction ne dérive un statut d'une
confiance : §21.5 dit que « le champ `confidence` d'un agent ne remplace jamais la validation
Locus Solus ».

**Écart avec la spec.** Trois notes, toutes dans le cadre.

_`late` n'est pas un statut._ §21.6 dit qu'« un commit produit après expiration porte le statut
`late` », mais `status` est déjà pris par §2.3 et ne connaît que `draft` et `staged`. Le marqueur
vit donc à côté du document, exactement comme le `lateMarker` d'un résultat tardif en §11.4 (W2.9),
et il voyage dans la charge de `epistemic_commit.submitted`. Le taire ferait traiter un commit
tardif comme un commit normal, ce qui est le contournement que la quarantaine de §12.3 existe pour
empêcher.

_La validation locale de §21.4 rend des constats ; seule la soumission lève._ Un commit se corrige
mieux avec la liste complète de ce qui cloche qu'une raison à la fois. `submitCommit` fait porter
tous les constats par l'erreur, pour la même raison.

_Deux des dix contrôles de §21.4 ne tournent pas ici, et le disent._ « Absence de secret »
appartient à l'admission (§21.8) et n'est pas refait ; la résolution des références exige un
catalogue d'artefacts déclarés, absent en l'absence d'appelant. Chaque contrôle rend son état —
`enforced` / `not-applicable` / `skipped` — et un rapport `ok` avec `complete: false` veut dire
« rien trouvé sur ce que j'ai pu regarder », pas « conforme ». Même vocabulaire et même raison que
le scanner d'artefacts de W2.14 : un contrôle qui ne tourne pas ressemble à un contrôle qui passe.

**Prochain item.** W2.16 `[R]` — `recovery.ts`, `resume-store.ts`, offline et résultats partiels
(§24). Test de sortie : « redémarrage du worker en cours de mission ». Ses dépendances sont
satisfaites : le spool de W2.12 sait déjà survivre à un redémarrage sans rien perdre ni dupliquer,
et §24.5 — « une incohérence déclenche quarantaine et diagnostic, jamais réparation silencieuse » —
a déjà servi deux fois, en W2.14 et ici.

## 2026-08-16 — W2.16 — redémarrage, offline et résultats partiels (§24)

**Périmètre.** Dans le périmètre Locus : `src/locus/resume-store.ts`, `src/locus/recovery.ts`,
`test/locus/recovery.test.ts`, réexports dans `src/locus/index.ts`. **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 316 pass, 0 fail (18 fichiers). `bun run typecheck` :
7/7. `prettier --check` : conforme.

Le test de sortie de W2.16 — « redémarrage du worker en cours de mission » — passe : après
redémarrage, les événements non acquittés sont là, l'attempt est reconstruit depuis son
checkpoint, et **rien ne reprend**. Vérifié par mutation, trois fois : traiter un lease relu comme
valide fait rougir le test de sortie ; laisser passer une empreinte incohérente fait rougir §24.5 ;
autoriser l'offline par défaut fait rougir §24.3.

**Décisions prises.** Quatre.

_Un lease relu sur disque vaut `unconfirmed`, et `unconfirmed` n'autorise rien._ C'est la deuxième
obligation de §24.1 — « ne pas supposer les leases valides » — et c'est celle qui coûte cher quand
elle manque. La tentation est évidente : le lease est sur le disque, son échéance est dans le
futur, l'horloge locale est d'accord. Sauf que pendant l'arrêt, le serveur a très bien pu constater
les heartbeats manquants, déclarer l'attempt orphelin et le réattribuer. Reprendre sur cette foi,
c'est deux workers qui exécutent la même mission en croyant chacun être seul. `unconfirmed` n'est
donc pas un état d'erreur : c'est l'état **normal** après un redémarrage, et le nommer empêche de
le confondre avec `valid`. Seul `expired` se lit localement — une échéance dépassée l'est pour tout
le monde.

_L'ordre des questions au démarrage est l'ordre du coût d'une erreur._ Ce qui rend la reprise
impossible d'abord, ce qui la rend inutile ensuite, l'autorisation en dernier. Demander
l'autorisation avant de savoir si l'état est restaurable ferait autoriser une reprise qui ne peut
pas avoir lieu.

_Une dépendance non sérialisable et non reconstructible rend la session irrécupérable._ §24.2 range
« dépendances non sérialisables signalées » en septième position, et c'est le champ qui décide si
les six autres valent quelque chose. Un checkpoint qui laisse tomber en silence un sous-processus
vivant ou un contexte GPU a exactement l'air d'un checkpoint complet ; la reprise repart alors d'un
état qui n'a jamais existé, et elle repart avec confiance. Une dépendance **reconstructible**, en
revanche, n'est pas bloquante : c'est du travail pour la reprise.

_Un checkpoint corrompu est déplacé, jamais réparé ni supprimé._ §24.5 : « une incohérence
déclenche quarantaine et diagnostic, jamais réparation silencieuse ». L'empreinte porte sur le JSON
canonique — deux exécutions conformes n'ordonnent pas forcément les clés pareil — et l'écriture
passe par un fichier temporaire puis un renommage, la seule opération que le système de fichiers
rende indivisible. Un checkpoint à moitié écrit est précisément ce qu'une coupure de courant
produit, et c'est aussi ce qu'un lecteur confiant traiterait comme un état valide.

**Écart avec la spec.** Deux notes.

_§24.3 exige une permission que `lep/1.0` ne porte pas._ « Le worker peut poursuivre hors ligne
uniquement si la MissionEnvelope l'autorise » — or `MissionEnvelope` n'a aucun champ de permission
offline. Comme pour `message_id` en §18.2, le champ n'est **pas inventé côté worker** : ce serait
dupliquer le contrat cross-repo, et un champ inventé ici ne serait ni validé ni reconnu par un pair
conforme. La lecture locale est **deny-by-default** — une mission qui n'autorise rien n'autorise
pas — et la permission entre par un paramètre distinct en attendant que `locusolus` tranche : soit
le schéma ajoute le champ en 1.1, soit §24.3 s'aligne. Deuxième arbitrage cross-repo ouvert, après
celui de §18.2.

_Le plafond offline ne dépasse jamais le lease._ §24.3 dit « jusqu'au plafond de lease/**offline
budget** » ; le plus contraignant des deux gagne. Un budget offline plus long que le lease donnerait
le droit de travailler après la fin du droit de travailler.

**Une règle, trois endroits.** `partial: true` de §24.4 rejoint le `lateMarker` de §11.4 (W2.9) et
le marqueur tardif du commit de §21.6 (W2.15) : ce qui est diminué le dit. Un commit partiel qui ne
se déclare pas partiel est lu comme un commit complet dont les résultats manquants n'existent pas ;
`lost` nomme les artefacts déclarés que la vérification n'a pas atteints, plutôt que de les laisser
déduire d'une absence.

**Prochain item.** W2.17 `[R]` — `human-input.ts` (§22). Test de sortie : « suspension sans
processus coûteux maintenu ». Ses dépendances sont satisfaites : `waiting_human` est déjà un état
de la table de transitions de W2.9, le checkpoint de W2.16 sait ce qu'il faut geler avant de
suspendre, et §22.3 dit explicitement que « le worker ne garde pas un modèle ou processus actif
pendant une longue attente sans nécessité ».

## 2026-08-16 — W2.17 — questions humaines et approvals (§22)

**Périmètre.** Dans le périmètre Locus : `src/locus/human-input.ts`,
`test/locus/human-input.test.ts`, réexports dans `src/locus/index.ts`. **Aucun fichier amont
touché.**

**Tests exécutés.** `bun test test/locus/` : 333 pass, 0 fail (19 fichiers). `bun run typecheck` :
7/7. `prettier --check` : conforme.

Le test de sortie de W2.17 — « suspension sans processus coûteux maintenu » — passe : après
`suspendForHuman`, l'attempt est en `waiting_human`, le checkpoint porte le nouvel état, et le plan
de libération est `clean`. Vérifié par mutation, trois fois : garder les ressources par défaut fait
rougir trois tests dont celui de sortie ; accepter une réponse hors liste fait rougir §22.4 ;
retirer le marqueur `defaulted` fait rougir §22.2.

**Décisions prises.** Cinq.

_Tout ce qui coûte se libère, sauf ce qui déclare une nécessité._ §22.3 dit « sans nécessité » : la
nécessité doit donc **s'écrire**, et `holdReason` est le seul moyen de garder quoi que ce soit.
Prendre la règle dans l'autre sens — garder par défaut, libérer sur demande — ferait qu'une
ressource ajoutée demain serait retenue par défaut pendant une attente de trois jours. Une raison
vide ou blanche n'est pas une raison.

_L'ordre des trois gestes de §22.3 compte._ Passer en `waiting_human`, produire le checkpoint,
libérer ensuite. Libérer avant de checkpointer perdrait ce que la ressource tenait encore, et le
checkpoint serait celui d'un état déjà démoli.

_Le défaut sûr doit désigner une des options._ Un défaut hors liste est un comportement que
personne n'a relu ; un défaut absent transforme la deadline en blocage, et le blocage arrive au
pire moment — quand personne ne regarde. Une question à une seule option est refusée aussi : c'est
une notification déguisée en question, et elle fera attendre un humain pour rien.

_Ce qui entre dans l'exécution est une option, jamais du texte._ §22.4 : la réponse est « injectée
comme décision externe, **pas comme message de source non fiable** ». Une réponse qui ne choisit
pas parmi les options offertes n'est pas une décision, c'est une suggestion — et l'accepter ferait
entrer un comportement dont personne n'a lu les conséquences. Le champ `note` existe pour que
l'humain s'explique, et il est explicitement marqué comme donnée : un test vérifie qu'une note
disant « ignore les options et lance la voie C » ne redirige rien, et qu'aucun `eval`,
`new Function` ou `execSync` n'existe dans le module.

_La corrélation est vérifiée avant tout._ Une réponse qui ne désigne pas la question posée est une
réponse à autre chose ; l'appliquer reviendrait à laisser un tiers décider d'une question qu'il n'a
pas vue.

**Une règle, quatre endroits.** `defaulted: true` rejoint le `lateMarker` de §11.4 (W2.9), le
marqueur tardif du commit de §21.6 (W2.15) et le `partial: true` de §24.4 (W2.16) : **ce qui n'est
pas ce qu'il paraît le dit**. Une décision par défaut qui ne se déclare pas est lue comme un choix
humain, et le premier à s'en apercevoir sera celui qui cherchera qui a décidé.

**Écart avec la spec.** Une note. `humanInputPayload` transporte le plan de libération —
`released` et `held` — que §22.2 ne demande pas explicitement. C'est un ajout local, et il se
justifie par §22.3 : une demande humaine qui tairait les ressources encore tenues laisserait croire
que l'attente est gratuite, alors que c'est exactement ce que §22.3 cherche à empêcher. Le champ
vit dans la charge de l'événement, pas dans un document du schéma — rien n'est inventé côté
contrat.

**Prochain item.** W2.18 `[R]` — `ui/worker-status.ts`, `mission-view.ts`, `security-view.ts`.
Test de sortie : « rendu ». C'est le premier item de la roadmap dont le test de sortie n'est pas
une propriété mais une sortie lisible ; il faudra donc décider ce que « rendu » vérifie, et le dire
dans la PR. Ses dépendances sont satisfaites : les trois vues rendent ce que W2.6 à W2.17 ont
produit — manifeste de capacités, mission admise, attestation sandbox, budget, lease, quarantaines.

## 2026-08-16 — W2.18 — les trois vues (§23.4, §25.4, ADR 0004)

**Périmètre.** Dans le périmètre Locus : `src/locus/ui/format.ts`, `src/locus/ui/mission-view.ts`,
`src/locus/ui/worker-status.ts`, `src/locus/ui/security-view.ts`, `test/locus/ui.test.ts`,
réexports dans `src/locus/index.ts`. **Aucun fichier amont touché.**

**Tests exécutés.** `bun test test/locus/` : 350 pass, 0 fail (20 fichiers). `bun run typecheck` :
7/7. `prettier --check` : conforme.

**Ce que « rendu » vérifie — l'arbitrage de ce sprint.** C'est le premier item dont le test de
sortie de `docs/10` n'est pas une propriété mais un mot : « rendu ». Pris au pied de la lettre, il
serait satisfait par une fonction qui renvoie une chaîne vide. Le critère retenu est donc : **le
rendu conserve les distinctions que le code a payé cher à établir**. Trois, chacune vérifiée et
chacune mutée :

1. `not-run` ne ressemble pas à `blocked` (ADR 0004) ;
2. l'inférence distante se distingue du calcul local (§23.4) ;
3. une valeur inconnue se rend `inconnu`, jamais par un défaut plausible.

Vérifié par mutation, trois fois : rendre `not-run` avec la marque de `blocked` fait rougir la
première ; supprimer l'étiquette de provenance fait rougir la deuxième ; rendre `undefined` par
`0` fait rougir la troisième.

**Décisions prises.** Quatre.

_Une vue est de la télémétrie qui s'affiche._ §25.4 : « prompts, sources et sorties ne sont pas
exportés par défaut dans la télémétrie. Les logs utilisent identifiants et hashes ». Ce qui ne doit
pas sortir dans un log ne doit pas non plus finir dans un terminal partagé, un ticket ou une copie
d'écran. Les vues rendent donc des identifiants, des hashes tronqués et des états — jamais du
contenu. `leakFindings` est un **filet**, pas la politique : la politique est de ne pas mettre de
secret dans une vue, et le filet existe pour le jour où quelqu'un en met un quand même. Un test
vérifie que le filet attrape — sans lui, une fonction rendant toujours la liste vide passerait.

_La troncature d'un hash conserve son préfixe d'algorithme._ Un digest abrégé sans son algorithme
n'identifie plus rien. La troncature est un confort de lecture, pas une permission d'oublier quoi
recalculer.

_`unconfirmed` ne se rend pas « oui »._ Le rendre ainsi parce que l'échéance n'est pas passée
redirait à l'écran exactement l'erreur que `recovery.ts` refuse de faire dans le code. Quatre états
de lease, quatre phrases, aucune abrégeable en « ok ».

_Une section vide se lit comme une section sans problème._ D'où « aucun artefact en quarantaine »
plutôt qu'une absence de ligne, et `inconnu` plutôt qu'un blanc. C'est la même famille de règle que
`not-applicable` face à `skipped` dans le scanner d'artefacts : l'absence d'information et
l'absence de problème ont la même apparence si on ne les écrit pas.

**Écart avec la spec.** Une note. §23.4 énumère ce que l'UI affiche sans dire comment ; les marques
`✔ / ✘ / ?`, les seuils de troncature et l'ordre des sections sont une **présentation**, pas une
lecture de la spec. Elles vivent en constantes (`MARKS`, `shortHash(keep)`) pour être changées d'un
seul endroit. Ce qui n'est pas négociable et qui est verrouillé par des tests, c'est que trois
états distincts aient trois marques distinctes.

**Prochain item.** W2.19 `[R]` — suite de conformance complète + consumer-driven contracts
(§28.2/28.3). Test de sortie : « verte contre le harness ». C'est le **dernier item de W2**. Ses
dépendances sont satisfaites : le harnais épinglé de W0.9 est en place depuis W2.5, et les dix-sept
modules de `src/locus/` qu'il doit exercer sont écrits.

## 2026-08-17 — W2.19 — suite de conformance complète et consumer-driven contracts (§28.2, §28.3)

**Périmètre.** Dans le périmètre Locus : `src/locus/conformance.ts`,
`test/locus/conformance.test.ts`, réexports dans `src/locus/index.ts`. **Aucun fichier amont
touché.** Dernier item de W2.

**Tests exécutés.** `bun test test/locus/` : 368 pass, 0 fail (21 fichiers). `bun run typecheck` :
7/7. `prettier --check` : conforme.

Le test de sortie de W2.19 — « verte contre le harness » — passe : les onze contract tests de §28.2
s'exécutent, le harnais épinglé ne rend aucun constat sur les cas conformes et en rend sur les cas
fautifs. Vérifié par mutation, trois fois : neutraliser le compteur d'items manquants fait rougir
§28.2 ; laisser passer une entrée hors du pin fait rougir §28.3 ; retirer l'enregistrement d'un des
onze cas fait rougir le test de sortie.

**Décisions prises.** Quatre.

_L'absence d'un contract test est un échec, pas une absence._ §28.2 énumère onze noms, et une liste
dans une spécification ne teste rien par elle-même. Les cas s'enregistrent donc eux-mêmes, et un
dernier test relit le compte : une suite à laquelle il manquerait « revocation » serait verte, et
sa vertu serait un artefact de ce qu'elle ne fait pas. C'est la règle « jamais silencieux » du
projet retournée vers la suite elle-même.

_Le compteur signale les deux sens._ Un item **manquant** est un pan de §28.2 non couvert ; un cas
**inconnu** est un nom qui a dérivé, ou une spec qui a bougé. Dans les deux cas la correspondance
entre suite et spec a cessé d'être vérifiable, et c'est ce que la fonction existe pour dire. Un
test vérifie que le compteur attrape — sans lui, une fonction rendant toujours la liste vide
passerait le test principal. Même précaution que pour `leakFindings` en W2.18.

_Toutes les entrées LEP viennent du pin._ §28.3 : « les tests ne doivent pas dépendre d'un dépôt
Locus Solus local mutable ». La liste des entrées autorisées est **lue depuis `PINNED.json`**
plutôt qu'énumérée à la main — une liste écrite deux fois se désynchronise une fois. Un fichier LEP
lu hors du pin porte une version que rien ne dit : la suite passerait ou échouerait selon l'état
d'un répertoire voisin, ce qui n'est plus une conformance mais une coïncidence.

_Un constat attendu est nommé, pas compté._ Les cas fautifs — séquence qui recule, résultat tardif
muet — vérifient la **règle** du constat (`sequence`, `late-result`) et non son nombre. « Il y a des
constats » passerait sur n'importe quel autre problème, y compris un que le test n'a pas voulu
provoquer.

**Écart avec la spec.** Une note. §28.3 parle de vérifier la compatibilité « avec une version
publiée de Locus Solus » ; il n'y en a pas encore, le monorepo est privé et non publié. Le mode
nominal est donc `pinned` — hors ligne, reproductible, empreintes dans le dépôt — et
`verified-against-source` reste un bonus quand le dépôt d'origine est joignable. `SourceStanding`
nomme les trois états pour que « la vérification croisée n'a pas eu lieu » soit dicible plutôt que
supposé. Rien n'est bloqué : la suite est valide en `pinned`, simplement moins étayée.

**État de W2.** Les dix-neuf items de W2 sont faits. La couche `src/locus/` compte vingt-deux
modules et 368 tests. Trois arbitrages cross-repo restent ouverts pour `locusolus`, tous trois
écrits ici et aucun bloquant : `message_id` de §18.2 absent de `lep/1.0` ; la permission offline de
§24.3 absente de `MissionEnvelope` ; le code de refus `data_locality_violation` sans producteur en
attente de la politique de localité de §21.9.

**Prochain item.** W1 (locusolus) — domain, event store, ports purs. Ouvert et débloqué depuis le
début, jamais commencé, et c'est désormais le seul chantier ouvert de la roadmap.

---

## 2026-08-19 — W15.f — Partiel : le lecteur du rôle, avant l'opération qui l'écrit

**Périmètre.** `backend/cli/src/locus/agent-overlay.ts` (la table `AGENT_BY_ROLE` et l'ordre de
choix), `backend/cli/src/locus/session-map.ts` (la lecture du champ), `backend/cli/test/locus/
session-map.test.ts` (cinq tests), `IMPLEMENTATION_LEDGER.md`. Rien hors de `src/locus/**` ni de
`test/locus/**`.

**Pourquoi ce dépôt d'abord.** `W15.f` traverse `locusolus` et `canterel`, et l'ordre n'est pas
libre. ADR 0016 décision 4 dit qu'une opération attributaire n'entre dans l'énumération que lorsque
son consommateur existe : livrer `SET_ROLE` avant ce lecteur laisserait, le temps d'un merge, une
opération que rien n'honore — exactement ce que la décision refuse. Le pin du SDK impose le même
sens dans l'autre direction : `PINNED.json` référence un **commit** de `locusolus`, qui doit exister
avant d'être épinglé. D'où trois pas : le lecteur ici, le champ et l'opération là-bas, le
re-vendoring ici ensuite.

**L'ordre de choix, et la contrainte qu'il porte.** `selectOverlay` choisit désormais par
**politique de revue, puis rôle, puis capacités**. La première place n'est pas négociable et ADR
0017 §5.1 le dit : « un `role` qui pourrait renvoyer une revue indépendante vers le profil du
générateur reconstruirait exactement le trou que ce test bouche ». Il le reconstruirait en pire,
puisqu'il le rendrait **demandable par l'émetteur**. Un test parcourt les deux politiques
indépendantes contre quatre rôles, dont un qui vise `biology`, et exige `reviewer` dans les huit cas.

**Pourquoi le rôle passe devant les capacités.** C'est là qu'il sert : une mission qui exige
`biology` et dont le rôle est `provenance-reviewer` demande une vérification de provenance sur un
sujet de biologie, pas un biologiste. Derrière les capacités, il n'aurait jamais rien changé, et
l'item aurait été livré sans effet.

**Un rôle inconnu ne casse rien.** Il retombe sur les capacités, puis sur le défaut. C'est
l'interdit 3 d'ADR 0017 vu du lecteur : un mineur ajoute des champs, jamais des valeurs, donc un
rôle qu'un émetteur plus récent enverrait ne doit pas arrêter un worker plus ancien — sinon le
mineur suivant serait une rupture pour tout le monde sauf sur le papier.

**Deux rôles dans la table, pas dix.** `logical-reviewer` et `provenance-reviewer` sont ceux que
`SPEC_V1.md` §20 nomme. En inventer d'autres donnerait une table plus fournie et pas plus vraie.

**Tests exécutés.** `bun test test/locus/` — 372 conformes, et **une** défaillance :
`pin.test.ts` constate que le SDK épinglé a dérivé de la copie de travail de `locusolus`, où le
champ `role` vient d'être généré. C'est le pas 3, pas une régression : le pin ne peut pas référencer
un commit qui n'existe pas encore. `bun run typecheck` — sept paquets, verts. Le test de sortie
côté worker, nommément : un rôle voyage **de la mission jusqu'à l'agent choisi** par `mapMission`,
et la même mission sans rôle ne va pas au même endroit — sinon le test passerait pour une raison
étrangère au rôle.

**Ce qui n'a pas été fait passer pour vert, et comment ça a été vérifié.** La suite complète rend
80 défaillances **dans ce conteneur** (`test/science/**`, mesures de mémoire et de CPU) et **une**
en CI : `Truncate > cleanup > deletes files older than 7 days`. Une première « vérification » les a
attribuées à la base en remisant les modifications — mais l'arbre était déjà commité, donc le
remisage n'a rien remisé et la comparaison portait sur le même arbre. Elle ne valait rien.

La vérification qui vaut est **mécanique** : `git diff origin/main...HEAD --name-only` rend quatre
fichiers, dont trois sous `src/locus/**` et `test/locus/**`. Le test qui échoue importe
`src/tool/truncation` et `src/id/id`, qui importent `global`, `id`, `permission`, `agent` et
`scheduler`. Aucune intersection : ce diff n'est pas atteignable depuis ce test, qui échoue d'ailleurs
**exécuté seul**.

**Et la cause, trouvée en la cherchant.** `Identifier.create` empaquette `timestamp * 0x1000` —
environ 53 bits — dans **six octets**. Les bits de poids fort tombent, et l'horodatage relu se replie
tous les 2^36 ms, soit **795 jours**. Le dernier repli date du 14 août 2026, cinq jours avant ce
sprint : c'est pourquoi le test était vert le 17 et rouge le 19, à graphe d'import identique au
bit près. Vérifié en rejouant l'arithmétique sur les deux dates du test — « il y a 3 jours » se relit
comme vieux de vingt mille jours, donc le fichier « récent » est supprimé, ce qu'affirme la ligne 156.

C'est un défaut **amont**, dans `src/id/id.ts`. Le corriger d'ici serait payé à chaque
synchronisation (ADR 0010), et rien de ce sprint ne le touche.

**Écart avec la spec.** Aucun.

**Ce que ce titre dit.** « Partiel » n'est pas une coquetterie : la garde de roadmap de `locusolus`
lit les titres du registre, et une entrée nommée `W15.f` sans plus la compterait comme la livraison
de l'item entier — le tableau porterait **fait** sur un tiers de travail. Le préfixe range cette
entrée où elle doit être, à côté de `Bloqué` et `Reporté`.

**Prochain item.** `W15.f` (2/3), dans `locusolus` : le champ `role` avec `x-since: "1.1"`,
`SET_ROLE` dans `packages/coordination`, et les deux tests qui définissent « mineur ».

---

## 2026-08-19 — W15.f — Le SDK épinglé rattrape la tranche 1

**Périmètre.** `backend/cli/src/locus/lep/PINNED.json` (commit et empreintes),
`backend/cli/src/locus/lep/generated.ts` et `backend/cli/test/locus/harness/harness.ts` (recopiés),
`backend/cli/test/locus/session-map.test.ts` (un `as` retiré), `IMPLEMENTATION_LEDGER.md`.

**Le troisième et dernier pas.** `PINNED.json` référence un commit de `locusolus` : il ne pouvait
pas être mis à jour avant que la tranche 1 y soit mergée. Elle l'est (`9ea9f0d`), donc le SDK
épinglé porte désormais `role?: string`, et le test de bout en bout n'a plus besoin de forcer le
type. Le `as MissionEnvelope` qu'il portait décrivait littéralement la situation d'un mineur — un
document `1.1` chez un consommateur `1.0` — et il disparaît maintenant que le consommateur a
rattrapé.

**Ce que le re-vendoring a révélé au passage.** Deux fichiers avaient dérivé, pas un :
`generated.ts` à cause de la tranche 1, et `harness.ts` d'une modification amont **antérieure** que
personne n'avait recopiée. Le pin était donc déjà périmé avant ce sprint, et le seul test qui
l'aurait dit — `verifyAgainstSource` — ne tourne qu'avec une copie de travail de `locusolus` à côté,
ce que la CI de ce fork n'a jamais. Le contrôle est dégradé par construction et son propre
commentaire le dit ; ce sprint est la première fois qu'il a servi.

**Tests exécutés.** `bun test test/locus/` — **373 conformes, zéro échec**, dont
`verifyAgainstSource`, qui rejoue la réécriture déclarée et confirme que rien n'a été retouché à la
main. `bun run typecheck` — sept paquets, verts.

**Ce qui reste rouge, et pourquoi ce n'est pas ce sprint.** `Truncate > cleanup` échoue toujours :
`Identifier.create` empaquette environ 53 bits dans six octets, l'horodatage relu se replie tous les
795 jours, et le dernier repli date du 14 août 2026 — le test redeviendra vert seul le 24. Défaut
**amont**, arbitré : on avance par-dessus plutôt que de retoucher `src/id/id.ts`, qui serait payé à
chaque synchronisation (ADR 0010).

**Écart avec la spec.** Aucun.

**Prochain item.** `W19.a` dans `locusolus` — les motifs de refus d'admission sur le fil. Instruit :
le générateur de SDK ne sait pas produire d'union discriminée, ce qui en fait un item préalable.

---

## 2026-08-19 — W19.b — La permission hors ligne vient de l'enveloppe, et de nulle part ailleurs

**Périmètre.** `backend/cli/src/locus/recovery.ts` (`offlineVerdict` perd son quatrième paramètre),
`backend/cli/test/locus/recovery.test.ts` (deux tests de plus, les autres réécrits),
`backend/cli/src/locus/lep/{generated.ts,PINNED.json}` (re-vendorés sur `08c68ab`),
`IMPLEMENTATION_LEDGER.md`. Rien hors de `src/locus/**` ni `test/locus/**`.

**Le sujet n'est pas d'ajouter une lecture, c'est d'en retirer une.** `offlineVerdict` prenait la
permission en **quatrième paramètre**, faute de champ sur le fil — un compromis honnête, écrit et
consigné par `W2.16`. Mais un paramètre hors bande laisse un appelant accorder une dispense que la
mission n'a jamais donnée, et c'est exactement le trou que le refus par défaut protégeait. La
tranche 3 du mineur ayant posé `offline_allowed` sur l'enveloppe, le paramètre disparaît : la
permission vient d'un seul endroit, celui que l'émetteur signe.

**Un test compte les arités.** `offlineVerdict.length === 3` dit mieux qu'un commentaire qu'aucune
quatrième source ne peut revenir, et une lecture du corps refuse le mot `permission` — la même
technique que `W18.a`, qui lit le source pour prouver une absence.

**Les quatre combinaisons, côté lecteur cette fois.** `W19.b` les a testées sur le schéma ; elles le
sont maintenant sur le verdict. `deny` sans dispense refuse, `deny` avec dispense autorise, `full`
sans dispense refuse, `full` avec dispense autorise. Si le lecteur dérivait l'une de l'autre, la
mission en `full` qui **doit** échouer quand le réseau tombe disparaîtrait — c'est celle qui se perd
toujours en premier quand on confond le confinement et l'autorisation.

**Un budget n'est pas une permission**, et un test le tient : `offline_budget_ms` seul n'autorise
rien. Le lire autrement ferait d'une borne une dispense.

**Le pin a failli désigner le mauvais commit.** `git rev-parse HEAD` dans `locusolus` rendait le
commit de **branche**, pas celui que le squash a posé sur `main`. L'arbre est le même, donc les
empreintes auraient été justes et la référence fausse — un pin qui désigne un commit absent de
`main` est un pin qu'on ne peut pas rejouer. Corrigé sur `08c68ab`.

**Tests exécutés.** `bun test test/locus/` — **376 conformes, zéro échec**, dont `pin.test.ts` et
`verifyAgainstSource`, qui rejoue la réécriture déclarée. `bun run typecheck` — sept paquets, verts.

**Ce qui reste rouge, et pourquoi ce n'est pas ce sprint.** `Truncate > cleanup`, défaut amont daté :
`Identifier.create` empaquette environ 53 bits dans six octets, l'horodatage relu se replie tous les
795 jours, et le dernier repli date du 14 août 2026. Le test redeviendra vert seul le 24. Arbitré :
on avance par-dessus plutôt que de retoucher `src/id/id.ts`, payé à chaque synchronisation
(ADR 0010).

**Écart avec la spec.** Aucun. `SPEC_V1.md` §1.2 pose l'invariant, §24.3 décrit le verdict, et le
worker les relie désormais sans intermédiaire.

**Prochain item.** `W20.a` dans `locusolus` — le `CommandEnvelope` de §22.2 et les huit familles
d'erreurs typées de §22.5, sans transport. Premier item d'un `apps/locusd` encore vide.
