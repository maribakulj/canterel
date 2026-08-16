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
