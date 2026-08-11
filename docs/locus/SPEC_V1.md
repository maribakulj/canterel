# Canterel — Spécification du runtime scientifique et worker Locus Solus V1

**Dépôt cible :** `maribakulj/canterel`  
**Rôle architectural :** principal runtime cognitif et instrumental de l’execution plane Locus Solus  
**Interface inter-système :** Locus Execution Protocol — LEP v1  
**Statut :** spécification normative V1, remplaçant les anciennes spécifications OpenScienceDH/Canterel worker

---

## 0. Statut et conventions normatives

Les termes **DOIT**, **NE DOIT PAS**, **DEVRAIT**, **PEUT** sont normatifs.

La V1 visée n’est pas un prototype de démonstration. Elle doit permettre à Canterel :

- de rester une application scientifique autonome complète ;
- de devenir un worker Locus Solus durable, observable et vérifiable ;
- d’exécuter plusieurs missions concurrentes sans mélange de contexte ;
- de produire des artefacts et commits épistémiques reproductibles ;
- de survivre aux déconnexions, redémarrages et résultats tardifs ;
- de faire appliquer réellement les politiques de sandbox, réseau, outils, modèles, secrets et budget ;
- de ne jamais devenir une seconde source de vérité concurrente de Locus Solus.

Cette spécification suppose que Locus Solus possède le control plane et l’evidence plane canoniques. Canterel reste le principal composant généraliste de l’execution plane.

---

## 0.1 Position architecturale mise à jour

Canterel est le nouveau nom du dépôt et produit historiquement appelé `openscienceDH`. Locus Solus est le laboratoire/orchestrateur. Canterel est un worker scientifique majeur, mais LEP accepte aussi des workers non-LLM spécialisés.

Canterel peut fonctionner :

- standalone sur un poste ;
- comme worker local de Locus Solus ;
- dans une VM ou container ;
- sur un nœud CPU/GPU distant ;
- en plusieurs instances spécialisées.

En mode Locus, l’environnement d’exécution, les limites de ressources et les capacités accordées sont décidés par Locus Solus/Execution Fabric. Canterel ne peut pas augmenter unilatéralement ses privilèges.

## 1. Vision du produit

Canterel doit être utilisable selon deux modes également soutenus.

### 1.1 Mode autonome

Canterel continue d’offrir :

- workspace Web local ;
- sessions et conversations ;
- agents généraux et disciplinaires ;
- routage multi-fournisseurs et modèles locaux ;
- outils, skills, MCP, LSP et connecteurs ;
- édition, shell, notebooks et calcul ;
- sandbox locale ;
- compaction et handoffs ;
- provenance locale ;
- revues et critiques locales.

Aucune instance Locus Solus, Temporal, PostgreSQL ou MinIO ne doit être requise.

### 1.2 Mode worker Locus Solus

Canterel devient une infrastructure d’exécution enregistrée auprès de `locusd`.

Dans ce mode :

1. Locus Solus crée et gouverne les missions ;
2. Canterel accepte ou refuse une mission selon ses capacités et politiques locales ;
3. Canterel matérialise un environnement isolé ;
4. il exécute une ou plusieurs sessions d’agents ;
5. il émet progression, coûts, alertes et artefacts ;
6. il soumet un `EpistemicCommit` signé ;
7. Locus Solus décide de la validation, de la revue, de la fusion et de la suite.

### 1.3 Proposition de valeur

Canterel ne doit pas être réduit à « appeler un LLM ». Sa valeur dans Locus Solus est l’assemblage cohérent de :

- raisonnement agentique ;
- instruments scientifiques ;
- environnements de calcul ;
- accès aux sources ;
- production documentaire ;
- contrôle d’exécution ;
- traçabilité fine ;
- adaptation disciplinaire.

---

## 2. Frontières de responsabilité

### 2.1 Canterel possède

- le cycle de vie des sessions locales ;
- la boucle modèle-outils ;
- le routage des fournisseurs et modèles effectivement disponibles ;
- la résolution des agents natifs et overlays autorisés ;
- l’exécution des tools et skills ;
- la gestion des processus, notebooks, fichiers et terminaux ;
- l’application locale des permissions ;
- l’application locale de la sandbox et des politiques réseau ;
- la matérialisation du `ContextView` reçu ;
- la collecte de télémétrie d’exécution ;
- le calcul des consommations observées ;
- la production et le hashage des artefacts ;
- la construction du commit épistémique proposé ;
- le cache local temporaire et les files d’événements non acquittés.

### 2.2 Locus Solus possède

Canterel NE DOIT PAS posséder en mode worker :

- l’état canonique des projets, programmes, workstreams ou branches ;
- le registre canonique des tâches, équipes ou agents ;
- la vérité sur les budgets et autorisations ;
- les politiques globales de revue ;
- les niveaux canoniques de validation ;
- le graphe épistémique canonique ;
- l’event store canonique ;
- les décisions de fork, merge, promotion, publication ou arrêt ;
- la mémoire collective inter-branches ;
- l’identité canonique d’un objet scientifique.

### 2.3 Règle de non-contournement

Canterel :

- NE DOIT PAS écrire directement dans PostgreSQL, Temporal ou les projections Locus Solus ;
- NE DOIT PAS modifier directement le graphe canonique ;
- NE DOIT PAS considérer un texte de session comme une décision institutionnelle ;
- NE DOIT PAS promouvoir un claim au-delà de `staged` ;
- NE DOIT PAS masquer à Locus Solus une violation de budget, sandbox ou politique ;
- NE DOIT PAS réutiliser un contexte d’une branche dans une autre sans `ContextView` explicite.

### 2.4 Autonomie locale et autorité globale

Le runtime peut choisir localement comment accomplir une mission : ordre des lectures, appels d’outils, scripts, sous-agents locaux, stratégies de recherche. Il ne peut pas modifier silencieusement l’objectif, les contrats de succès, les capacités autorisées ou la politique de confidentialité.

---

## 3. Architecture cible

```text
                       CANTEREL CONTROL PLANE
                              locusd
                                  │
                      LEP v1 / WebSocket sécurisé
                                  │
┌─────────────────────────────────▼─────────────────────────────────┐
│                    Canterel Locus Solus Worker                    │
│ identity · capabilities · admission · leases · recovery · events │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
┌─────────────────────────────────▼─────────────────────────────────┐
│                      Canterel Runtime                          │
│ sessions · agents · providers · tools · skills · compaction      │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
┌─────────────────────────────────▼─────────────────────────────────┐
│                         Execution Fabric                          │
│ worktree · sandbox · process · notebook · connectors · secrets   │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
                      artefacts + attestations
                                  │
                         CANTEREL EVIDENCE PLANE
```

Le worker adapter constitue une couche anti-corruption : les détails internes des sessions Canterel ne doivent pas devenir l’API publique de Locus Solus.

---

## 4. Structure du dépôt

**Cette liste de fichiers est une annexe indicative, pas un gabarit à instancier.** Ce qui est
normatif, ce sont les garanties, pas les noms de fichiers :

- le code local vit **entièrement** sous `backend/cli/src/locus/**` et
  `backend/cli/test/locus/**` — répertoires neufs, donc zéro conflit avec l'amont (ADR 0010) ;
- le namespace canonique est `locus` ; le nom `lab/` de la spécification précédente est abandonné ;
- la couche d'adaptation vers l'amont (`session-map`, `agent-overlay`, `model-policy`,
  `tool-policy`, `sandbox-policy`) reste **mince** : c'est la surface de couplage, et donc la
  surface de casse à chaque sync amont ;
- aucun module de `src/locus/**` n'importe `src/scheduler`, `src/session/review` ou
  `src/artifact` — les usages passent par `scheduler-local.ts` et `artifact-client.ts`.

Ne crée pas les fichiers ci-dessous en stubs vides. Chaque item de `docs/10_V1_ROADMAP.md` §W2
livre une garantie testée ; les fichiers apparaissent quand ils portent du comportement.

```text
backend/cli/src/locus/
├── index.ts
├── command.ts
├── config.ts
├── identity.ts
├── auth.ts
├── protocol.ts
├── schema-registry.ts
├── connection.ts
├── resume-store.ts
├── registration.ts
├── capability-manifest.ts
├── capability-watch.ts
├── admission.ts
├── worker.ts
├── lease.ts
├── scheduler-local.ts
├── executor.ts
├── attempt.ts
├── session-map.ts
├── context-materializer.ts
├── agent-overlay.ts
├── model-policy.ts
├── tool-policy.ts
├── secret-client.ts
├── sandbox-policy.ts
├── event-bridge.ts
├── event-spool.ts
├── artifact-client.ts
├── artifact-scanner.ts
├── usage-meter.ts
├── epistemic-commit.ts
├── human-input.ts
├── recovery.ts
├── quarantine.ts
├── diagnostics.ts
└── errors.ts

backend/cli/src/locus/ui/
├── worker-status.ts
├── mission-view.ts
└── security-view.ts

backend/cli/test/locus/
├── unit/
├── contract/
├── consumer-driven/
├── integration/
├── recovery/
├── security/
├── sandbox/
├── endurance/
└── fixtures/

docs/locus/
├── worker-mode.md
├── lep-conformance.md
├── security-model.md
├── operations.md
└── migration.md
```



---

## 5. Interfaces CLI

### 5.1 Démarrage du worker

```bash
canterel worker \
  --locus http://127.0.0.1:7420 \
  --identity canterel-macbook-01 \
  --token-env CANTEREL_WORKER_TOKEN \
  --labels local,interactive,dh \
  --max-concurrency 4
```

Options normatives :

```text
--locus URL
--identity ID
--token VALUE
--token-env NAME
--name LABEL
--labels CSV
--max-concurrency N
--drain-timeout DURATION
--resume-dir PATH
--artifact-cache PATH
--artifact-cache-max-size BYTES
--require-sandbox LEVEL
--allow-model GLOB
--deny-model GLOB
--allow-agent GLOB
--deny-agent GLOB
--allow-tool GLOB
--deny-tool GLOB
--data-locality TAG
--log-format pretty|json
--telemetry-endpoint URL
```

### 5.2 Sous-commandes

```bash
canterel worker status
canterel worker capabilities --format json
canterel worker doctor
canterel worker drain
canterel worker resume
canterel worker revoke-local-identity
canterel worker inspect-mission <mission-id>
canterel worker export-diagnostics <destination>
```

### 5.3 Arrêt contrôlé

À la réception de SIGTERM ou d’une commande `drain` :

1. ne plus accepter de mission ;
2. signaler `worker.draining` ;
3. laisser finir les attempts compatibles avec le délai ;
4. demander une extension ou checkpoint pour les autres ;
5. flusher l’event spool ;
6. persister les resume tokens ;
7. fermer les secrets et URLs temporaires ;
8. terminer sans déclarer faussement les missions accomplies.

---

## 6. Configuration

```yaml
locus:
  enabled: true
  endpoint: http://127.0.0.1:7420
  identity: canterel-macbook-01
  labels: [local, interactive]
  max_concurrency: 4
  drain_timeout_seconds: 120
  reconnect:
    initial_ms: 500
    max_ms: 30000
    jitter: true
  resume:
    directory: .canterel/locus
    fsync: true
  artifacts:
    cache_directory: .canterel/locus/artifacts
    cache_max_bytes: 2147483648
  security:
    minimum_isolation_level: os-sandbox
    reject_plaintext_secrets: true
    fail_closed_on_policy_error: true
  telemetry:
    traces: true
    metrics: true
    redact_prompts: true
```

Ordre de priorité :

1. options CLI ;
2. variables d’environnement ;
3. configuration du projet ;
4. configuration utilisateur ;
5. valeurs par défaut sûres.

Les secrets ne doivent jamais apparaître dans un fichier versionné, un log ou un diagnostic exporté.

---

## 7. Identité du worker et authentification

### 7.1 Identité persistante

Chaque installation worker possède :

- un `worker_id` stable ;
- une clé privée locale protégée ;
- un certificat ou token d’enrôlement renouvelable ;
- un état de révocation ;
- une empreinte de runtime ;
- un historique de manifestes de capacités.

La clé privée ne quitte jamais la machine. Les commits et attestations sont signés.

### 7.2 Enrôlement

Le premier enrôlement doit être explicite :

```bash
canterel worker enroll --locus ... --enrollment-token ...
```

Un token d’enrôlement :

- est court-terme ;
- possède un scope ;
- ne peut être réutilisé ;
- peut imposer des labels ou restrictions ;
- ne devient pas le secret permanent du worker.

### 7.3 Authentification du serveur

Le worker vérifie l’identité de `locusd`. En mode non local, TLS est obligatoire. Les certificats invalides, les redirections et changements d’origine sont refusés par défaut.

### 7.4 Révocation

Un worker révoqué :

- ne reçoit plus de mission ;
- ne peut plus renouveler ses leases ;
- peut uniquement uploader les journaux de clôture autorisés ;
- voit ses commits non validés placés en quarantaine.

---

## 8. Conformité LEP v1

### 8.1 Règle générale

Canterel implémente LEP v1 via le SDK publié par Locus Solus. Il NE DOIT PAS redéfinir un schéma divergent dans son dépôt.

Les types générés sont importés depuis une version verrouillée du SDK LEP produit par `locusolus/packages/protocol`. Pendant la construction de la V1, épingler par commit Git plutôt que par version npm publiée.

### 8.2 Handshake

Le premier message est `worker.hello` avec :

- versions de protocole supportées ;
- identité et version runtime ;
- hash du `CapabilityManifest` ;
- resume token éventuel ;
- dernière séquence serveur acquittée ;
- nonce et signature.

Le worker refuse une version inconnue plutôt que de poursuivre en compatibilité implicite.

### 8.3 Séquences et acquittements

Le worker persiste :

- `server_sequence` acquittée ;
- `worker_sequence` émise ;
- messages non acquittés ;
- mapping mission/attempt/session ;
- leases actifs ;
- uploads incomplets.

Les messages sont idempotents et dédupliqués par `message_id`.

### 8.4 Reprise

Après reconnexion, le worker :

1. présente son resume token ;
2. reçoit la séquence reconnue par le serveur ;
3. retransmet les messages manquants ;
4. réconcilie les leases ;
5. ne relance une mission que sur instruction explicite ;
6. marque les sessions locales sans mission active comme orphelines.

### 8.5 Compatibilité

La CI exécute les tests de conformité LEP fournis par Locus Solus. Toute modification du protocole nécessite :

- mise à jour de dépendance explicite ;
- fixtures actualisées ;
- test de compatibilité ascendante ;
- note de migration.

---

## 9. CapabilityManifest

### 9.1 Construction

Le manifeste doit être dérivé de l’état effectif du runtime, pas d’une configuration déclarative non vérifiée.

```yaml
worker_id: wrk_...
runtime:
  name: canterel
  version: 1.x
platform:
  os: darwin
  architecture: arm64
labels: [local, interactive, dh]
agents: []
models: []
tools: []
skills: []
connectors: []
sandbox:
  backends: [seatbelt]
  isolation_levels: [logical, os-sandbox]
  network_modes: [deny, allowlisted]
resources:
  cpu: 8
  memory_bytes: 17179869184
  gpu: []
  disk_bytes: 100000000000
max_parallel_tasks: 4
data_locality: [local-user-data]
artifact_upload_modes: [presigned-http]
features:
  context_isolation: true
  checkpoint: true
  human_input: true
  nested_agents: true
attestation: {}
```

### 9.2 Agents

Pour chaque agent :

- identifiant stable ;
- version du prompt/template ;
- mode principal ou subagent ;
- capacités attendues ;
- outils requis ;
- restrictions ;
- schéma de sortie ;
- statut expérimental ou stable.

### 9.3 Modèles

Pour chaque modèle disponible :

- fournisseur ;
- identifiant exact ;
- familles de capacités déclarées ;
- context window connue ;
- supports structurés/tool calls ;
- local ou distant ;
- politiques de données ;
- coût estimable ou inconnu ;
- région d’exécution si pertinente.

Une clé présente ne suffit pas à déclarer le modèle disponible : un health check borné doit confirmer l’accès, sans consommer inutilement des crédits.

### 9.4 Outils et skills

Chaque outil expose :

```yaml
id:
version:
input_schema:
output_schema:
capabilities:
determinism:
side_effects:
network_requirements:
sandbox_requirements:
secret_requirements:
provenance_support:
```

### 9.5 Changement de capacités

Tout changement significatif produit :

- un nouveau manifeste signé ;
- `worker.capabilities_changed` ;
- une réévaluation des missions en attente ;
- le refus des missions devenues inexécutables.

---

## 10. Admission d’une MissionEnvelope

### 10.1 Validation préalable

Avant `mission.accepted`, le worker vérifie :

- schéma et signature ;
- version LEP ;
- identité de workspace ;
- disponibilité des capacités ;
- compatibilité modèle/agent/outils ;
- niveau d’isolation ;
- politique réseau ;
- classification des données ;
- espace disque et ressources ;
- budget local plafonné ;
- deadline ;
- absence de conflit de mission ;
- capacité à matérialiser le contexte.

### 10.2 Refus structuré

Le refus possède un code stable :

```text
unsupported_protocol
invalid_signature
capability_missing
model_unavailable
tool_forbidden
sandbox_unavailable
network_policy_unsupported
data_locality_violation
confidentiality_unsupported
resource_exhausted
budget_unenforceable
deadline_impossible
worker_draining
local_policy_denied
```

Le message humain est secondaire ; le code et les détails structurés sont canoniques.

### 10.3 Politique locale plus restrictive

Le propriétaire de la machine peut imposer des restrictions supérieures à celles de Locus Solus. Le worker peut donc refuser une mission pourtant autorisée globalement. Il ne peut jamais assouplir localement une politique reçue.

### 10.4 Réservation locale

Une mission acceptée réserve :

- un slot de concurrence ;
- une allocation mémoire/disque indicative ;
- un workspace ;
- un lease local ;
- une plage de séquences d’événements ;
- un budget d’exécution local.

---

## 11. Leases, attempts et concurrence

### 11.1 Identités distinctes

- `task_id` identifie la tâche métier Locus Solus ;
- `mission_id` identifie l’enveloppe distribuée ;
- `attempt` identifie une tentative ;
- `session_id` identifie une session Canterel locale ;
- `run_id` identifie une exécution instrumentale ;
- `commit_id` identifie le résultat proposé.

Aucune de ces identités ne doit être substituée aux autres.

### 11.2 Cycle d’un attempt

```text
offered → accepted → preparing → running
                    ↘ rejected
running → waiting_human | checkpointing | completing
completing → completed | failed
running → cancelled | lease_lost | security_stopped
```

### 11.3 Heartbeats

Le heartbeat contient :

- état de mission ;
- progression bornée et non trompeuse ;
- état des sous-agents ;
- consommation ;
- pression ressources ;
- lease deadline observée ;
- dernier événement significatif ;
- alertes.

Un heartbeat n’est pas un log libre.

### 11.4 Perte de lease

Après perte de lease :

- les nouveaux appels coûteux sont arrêtés ;
- les secrets sont révoqués ;
- les écritures externes sont bloquées ;
- un checkpoint peut être produit si autorisé ;
- les artefacts déjà produits peuvent être déclarés comme late result ;
- aucun commit ne doit être présenté comme applicable implicitement.

### 11.5 Concurrence

Chaque mission possède un environnement logique séparé. Les caches globaux ne peuvent contenir que des données explicitement partageables et adressées par contenu.

---

## 12. Matérialisation de la mission

### 12.1 Workspace d’attempt

```text
.canterel/locus/attempts/<mission-id>/<attempt>/
├── mission.json
├── context/
├── worktree/
├── artifacts/
├── scratch/
├── checkpoints/
├── events/
├── manifests/
└── quarantine/
```

Les chemins reçus de Locus Solus ne sont jamais utilisés sans normalisation.

### 12.2 Git et worktrees

Si la mission porte sur du code ou des documents versionnés :

- Locus Solus fournit une référence Git et un `base_branch_revision` ;
- le worker crée un worktree dédié ;
- les modifications sont commitées localement ou empaquetées en patch ;
- le hash du commit Git est inclus dans l’artefact ;
- le worker ne pousse pas directement sur une branche canonique sans capacité explicite ;
- les conflits sont signalés, jamais écrasés.

### 12.3 ContextView

Le worker reçoit une référence immuable vers un `ContextView` et matérialise :

- objets épistémiques autorisés ;
- relations et inférences sélectionnées ;
- sources et artefacts ;
- instructions de visibilité ;
- exclusions ;
- empreinte du contexte ;
- politique de citation ;
- niveau de confidentialité.

Le hash de la vue doit être vérifié avant démarrage.

### 12.4 Isolation informationnelle

Le worker NE DOIT PAS injecter :

- le transcript d’un générateur dans une revue aveugle ;
- les conclusions d’une branche concurrente dans une exploration indépendante ;
- une mémoire utilisateur globale non incluse dans la vue ;
- des résultats futurs ou non validés ;
- des secrets sous forme de prompt.

Tout accès additionnel nécessite `context.extension_requested` puis une décision Locus Solus.

### 12.5 Contenu non fiable

Les sources, pages Web, documents, notebooks et messages d’agents sont des données non fiables. Les instructions qu’ils contiennent ne modifient jamais la politique de mission.

---

## 13. Traduction MissionEnvelope → session Canterel

### 13.1 Session racine

L’executor crée une session racine avec :

- `task_id`, `mission_id`, `attempt` dans les métadonnées ;
- agent résolu ;
- modèle sélectionné ;
- permissions calculées ;
- contexte matérialisé ;
- workspace d’attempt ;
- budget local ;
- contrat de sortie ;
- policy overlays ;
- corrélation OpenTelemetry.

### 13.2 Prompt système

Le prompt système est composé de couches identifiables :

1. règles de sécurité Canterel ;
2. contrat LEP ;
3. définition de l’agent ;
4. objectif de mission ;
5. succès/échec ;
6. outils et sandbox ;
7. contexte scientifique ;
8. format de sortie ;
9. état d’exécution.

Chaque couche est hashée et sa provenance enregistrée. Les contenus de sources ne sont jamais concaténés comme règles système.

### 13.3 Agent overlay

Un overlay éphémère peut définir :

- spécialité ;
- méthodes autorisées ;
- exclusions ;
- style de coordination ;
- outils ;
- modèle policy ;
- max steps ;
- schéma de sortie.

Il NE PEUT PAS :

- élever ses permissions ;
- modifier le budget ;
- désactiver la sandbox ;
- accéder à un autre contexte ;
- changer la classification ;
- contourner les critères de succès ;
- écrire directement dans le graphe.

### 13.4 Résolution du modèle

Le worker sélectionne un modèle compatible avec `model_policy` :

- allowlist/denylist ;
- fournisseur distinct pour indépendance ;
- localité et confidentialité ;
- capacités ;
- plafond de coût ;
- disponibilité ;
- fallback autorisé.

Tout fallback est déclaré dans `model.resolved`. Aucun remplacement silencieux n’est permis.

---

## 14. Sous-agents locaux et équipes

### 14.1 Deux catégories

- **Sous-agent local d’exécution** : créé à l’intérieur d’un attempt pour une opération bornée.
- **Agent Locus Solus durable** : instance canonique créée par le control plane avec identité, budget, mission et réputation.

Canterel ne doit pas confondre les deux.

### 14.2 Sous-agents locaux

Ils sont autorisés lorsque la mission le permet. Ils doivent :

- hériter d’un sous-ensemble de permissions ;
- recevoir une vue de contexte dérivée ;
- avoir un budget enfant ;
- produire événements et lineage ;
- être annulables ;
- ne pas devenir une branche durable implicite.

### 14.3 Escalade vers Locus Solus

Lorsqu’une piste mérite une branche ou un spécialiste durable, Canterel émet une proposition :

```yaml
action: agent.spawn | branch.fork | task.create
reason:
expected_information_gain:
required_capabilities:
context_requirements:
estimated_budget:
```

Locus Solus décide. Le runtime ne crée pas durablement la ressource de sa propre autorité.

### 14.4 Indépendance

Pour les revues aveugles et expériences comparatives, le scheduler local doit respecter :

- sessions séparées ;
- caches de conversation séparés ;
- prompts et contextes conformes au dossier ;
- absence de transcript partagé ;
- fournisseurs/modèles distincts si demandé ;
- randomisation contrôlée lorsque spécifiée.

---

## 15. Outils, skills et connecteurs

### 15.1 Enforcement

La politique effective est l’intersection de :

```text
capabilités réelles
∩ politique locale
∩ MissionEnvelope
∩ restrictions de l’agent
∩ classification des données
```

### 15.2 Tool broker

Tout appel d’outil produit :

- tool id/version ;
- arguments redacted/hashés selon politique ;
- environnement ;
- début/fin ;
- code de sortie ;
- ressources ;
- artefacts ;
- statut de sandbox ;
- provenance.

### 15.3 Side effects

Les outils ayant des effets externes — envoi, publication, écriture distante, modification de dépôt, achat, suppression — exigent une capacité explicite et, si la politique le demande, une `ApprovalRequest` humaine.

### 15.4 MCP et plugins

Les serveurs MCP et plugins sont inventoriés comme dépendances non fiables :

- identité et version ;
- permissions ;
- origine ;
- schéma ;
- réseau ;
- secrets ;
- statut de confiance.

Leur texte de réponse ne peut modifier les règles système.

### 15.5 IIIF et visualisation documentaire

Canterel ne dépend pas de `xiiif.el` pour les missions agentiques. Les missions IIIF utilisent des clients headless, Image/Presentation/Search APIs, parseurs ALTO/PageXML/annotations et outils VLM disponibles dans la toolchain `dh`.

Les sorties doivent être des artefacts standards : manifest snapshot, Content State, annotation JSON-LD, région image, fragment OCR, rapport. Ces artefacts peuvent ensuite être ouverts par xiiif, Mirador, OpenSeadragon ou le workspace Web.

Un navigateur automatisé n’est employé que si l’API ne suffit pas ou si le comportement du frontend est lui-même l’objet de l’expérience.

### 15.6 Modèles distants et calcul local

Le runtime DOIT distinguer l’inférence du modèle de l’exécution des outils. Pour Claude/OpenAI via API ou OAuth, l’inférence a lieu chez le fournisseur ; le CPU/GPU du worker exécute les scripts, navigateurs, compilateurs, OCR et modèles locaux.

Le `CapabilityManifest` indique donc séparément :

- providers/models distants accessibles ;
- mode d’authentification (`oauth-local`, `api-key`, gateway) ;
- toolchains locales ;
- accélérateurs (`mps`, `cuda`, etc.) ;
- ressources CPU/RAM/disque ;
- restrictions de classification des données.

Les tokens LLM sont budgétés indépendamment des secondes CPU/GPU. Une tâche purement Python peut coûter zéro token tant que son contenu n’est pas renvoyé au modèle.

## 16. Sandbox, environnement, réseau et secrets

### 16.1 Autorité

En mode Locus, le worker reçoit un `EnvironmentBlueprint`, un `SandboxSpec` et un `ResourceSpec`. Il DOIT exécuter la mission dans l’environnement accordé ou refuser proprement. Il ne peut pas monter le home, augmenter CPU/RAM, ouvrir le réseau ou obtenir un secret supplémentaire sans nouvelle autorisation.

### 16.2 Backends

Canterel peut s’exécuter :

- directement dans une sandbox fournie par `locus-execd` ;
- comme processus de confiance contrôlant des sous-sandboxes ;
- dans un container/VM cloud ;
- en standalone avec sa sandbox OS existante comme niveau de compatibilité.

La sandbox Seatbelt/Bubblewrap existante reste utile mais n’est pas considérée équivalente à une VM/container avec quotas complets. Le `CapabilityManifest` annonce le niveau réel.

### 16.3 Toolchains

Canterel consomme les toolchains exposées dans l’environnement : Python science, PyTorch CPU/MPS/CUDA, Lean/mathlib, SMT, SageMath, browser/Playwright, DH, etc. Il ne présume pas qu’elles soient installées sur l’hôte.

### 16.4 Installation dynamique

Une dépendance absente produit `environment.extension.requested`. Locus Solus peut déclencher un build séparé et fournir ensuite une nouvelle image/blueprint. Aucun `sudo`, package manager système privilégié ni `curl | bash` arbitraire dans une mission normale.

### 16.5 Réseau

Profils : `deny`, `allowlist`, `connector-only`, `full` selon politique. Toute tentative de dépassement est un événement de sécurité.

### 16.6 Secrets

OAuth personnel n’est admissible que sur un worker local/de confiance explicitement marqué `oauth-local`. Les workers distants utilisent de préférence credentials de service courts et scopes minimaux. Les secrets ne sont jamais injectés dans les prompts et ne sont pas visibles des sous-processus non autorisés.

### 16.7 Ressources

Canterel publie utilisation observée CPU/RAM/disque/GPU et tokens. Un OOM, timeout ou throttling est remonté comme cause structurée afin que Locus puisse réessayer sur un worker plus adapté.

## 17. Budget et mesure d’usage

### 17.1 Budget local

Le worker applique localement les plafonds :

- appels modèle ;
- tokens entrée/sortie ;
- coût monétaire estimé ;
- temps mur ;
- CPU/GPU ;
- stockage ;
- bande passante ;
- appels d’outils ;
- sous-agents.

### 17.2 Source de vérité

Locus Solus conserve le ledger canonique. Canterel émet des observations signées, pas des écritures directes de solde.

### 17.3 Estimation et rapprochement

Les usages portent :

- valeur observée ;
- source de mesure ;
- estimation ou montant facturé ;
- devise fournie par le fournisseur ;
- niveau de confiance ;
- identifiant de requête fournisseur si disponible.

Les divergences sont signalées, jamais masquées.

### 17.4 Dépassement

À l’approche du plafond :

1. événement `budget.usage` ;
2. réduction des opérations facultatives ;
3. checkpoint ;
4. demande d’extension si pertinente ;
5. arrêt sûr au plafond.

---

## 18. Event bridge

### 18.1 Catégories

Le bridge normalise :

- cycle worker ;
- cycle mission ;
- sessions et agents ;
- outils ;
- modèles ;
- fichiers et artefacts ;
- claims, objections, résultats négatifs ;
- usage ;
- attente humaine ;
- sécurité ;
- diagnostics.

### 18.2 Règles

Chaque événement LEP contient :

- `message_id` ;
- `worker_sequence` ;
- `mission_id` ;
- `task_id` ;
- `attempt` ;
- `occurred_at` ;
- `correlation_id` ;
- payload versionné ;
- hash et signature si requis.

### 18.3 Coalescence

Peuvent être coalescés : tokens streaming, progression très fréquente, logs répétitifs.

Ne peuvent pas être coalescés :

- transitions d’état ;
- appels d’outil à effet ;
- coûts ;
- déclarations d’artefact ;
- changements de modèle ;
- alertes ;
- demandes humaines ;
- propositions épistémiques.

### 18.4 Event spool

Le spool local est :

- durable ;
- ordonné ;
- borné ;
- chiffrable ;
- redacted ;
- nettoyé seulement après acquittement.

En cas de saturation, le worker passe en backpressure plutôt que de perdre les événements canoniques.

---

## 19. Artefacts et reproductibilité

### 19.1 Déclaration avant upload

```text
artifact.declared → URL temporaire → upload → vérification → artifact.uploaded
```

### 19.2 ArtifactManifest

Chaque artefact inclut :

- hash cryptographique ;
- taille et MIME ;
- type scientifique ;
- producteur ;
- mission/attempt/run ;
- chemins logiques ;
- classification ;
- droits/licence lorsque connus ;
- environnement ;
- dépendances ;
- parents de dérivation ;
- résultat de scan ;
- statut incomplet/complet.

### 19.3 EnvironmentManifest

Le worker capture au minimum :

- OS/architecture ;
- runtime et versions ;
- dépendances verrouillées ;
- image/container si utilisé ;
- variables non secrètes pertinentes ;
- locale/timezone ;
- seed ;
- ressources ;
- versions outils/modèles ;
- politique sandbox/réseau attestée.

### 19.4 RunManifest

Une exécution calculatoire produit :

- command/entrypoint ;
- inputs hashés ;
- outputs ;
- environment ;
- timestamps ;
- code de sortie ;
- logs ;
- mesures ;
- déterminisme attendu ;
- divergences.

### 19.5 Scan et quarantaine

Les artefacts sont scannés pour :

- secrets ;
- chemins absolus sensibles ;
- malware selon outils disponibles ;
- données interdites ;
- archives dangereuses ;
- formats incohérents.

Un échec ne supprime pas la preuve : l’artefact est mis en quarantaine avec raison.

### 19.6 Cache

Le cache local est content-addressed. La suppression ne concerne que les copies locales non requises par un attempt actif. Le worker ne décide pas de la conservation canonique.

---

## 20. Provenance locale et migration

### 20.1 Graphe local existant

Le graphe local Canterel reste disponible en standalone. En mode Locus Solus :

- il peut servir de journal de travail local ;
- ses nœuds et arêtes ne deviennent pas canoniques automatiquement ;
- un export produit des objets proposés dans l’EpistemicCommit ;
- les identités locales sont conservées comme aliases/provenance.

### 20.2 Mapping

```text
local artifact → Artifact
local run      → Run
local source   → Source
local claim    → Claim
produced       → produced_by
derived-from   → derived_from
supports       → supports
refutes        → refutes
```

### 20.3 Sessions standalone

Une session autonome peut être promue explicitement :

```bash
canterel session propose-to-locus <session-id> --branch <branch-id>
```

Le processus :

1. gèle le transcript sélectionné ;
2. extrait artefacts et provenance ;
3. construit un dossier de proposition ;
4. demande à l’utilisateur les éléments manquants ;
5. soumet un commit `staged` ;
6. ne réécrit pas rétrospectivement la session comme mission LEP.

### 20.4 `research-state.md`

Le fichier peut être importé comme source et proposition structurée. Il n’est plus l’état canonique d’une mission Locus Solus.

---

## 21. EpistemicCommit

### 21.1 Principe

Le résultat d’une mission est un paquet structuré et vérifiable, pas une simple réponse finale.

### 21.2 Construction

Le commit est construit à partir :

- sortie structurée de l’agent ;
- événements ;
- artefacts ;
- provenance ;
- citations ;
- manifests ;
- mesures ;
- erreurs et limitations ;
- état de budget ;
- attestation sécurité.

### 21.3 Schéma LEP

```yaml
commit_id:
task_id:
attempt:
base_branch_revision:
status: staged
summary:
objects: []
relations: []
inferences: []
objections: []
negative_results: []
failures: []
assumptions: []
artifacts: []
citations: []
resource_usage:
reproducibility:
security_attestation:
proposed_next_actions: []
worker_signature:
```

### 21.4 Validation locale

Avant soumission :

- conformité JSON Schema ;
- références d’artefacts résolues ;
- hashes cohérents ;
- objets locaux uniques ;
- relations aux extrémités valides ;
- inférences avec prémisses/conclusion ;
- citations adressables ;
- absence de secret ;
- usage rapproché ;
- base revision incluse ;
- signature valide.

### 21.5 Limites et incertitude

Le commit doit représenter explicitement :

- hypothèses ;
- méthodes échouées ;
- lacunes ;
- résultats négatifs ;
- incertitude ;
- contradictions ;
- problèmes de reproductibilité ;
- parties non vérifiées.

Le champ `confidence` d’un agent ne remplace jamais la validation Locus Solus.

### 21.6 Commit tardif

Un commit produit après expiration :

- porte le statut `late` ;
- reste signé et consultable ;
- n’est jamais automatiquement fusionné ;
- peut être réévalué par une commande explicite.

---

## 22. Questions humaines et approvals

### 22.1 Catégories

- précision scientifique indispensable ;
- choix entre stratégies incompatibles ;
- autorisation d’un effet externe ;
- extension de budget ;
- accès à une source classifiée ;
- résolution d’un conflit de définition ;
- décision éthique ou juridique.

### 22.2 Format

Une question contient :

- décision demandée ;
- contexte minimal ;
- options concrètes ;
- conséquences ;
- recommandation éventuelle ;
- deadline ;
- comportement par défaut sûr.

### 22.3 Attente

La mission passe à `waiting_human`, produit un checkpoint et libère les ressources coûteuses si possible. Le worker ne garde pas un modèle ou processus actif pendant une longue attente sans nécessité.

### 22.4 Réponse

La réponse revient via LEP, est corrélée à la demande et injectée comme décision externe, pas comme message de source non fiable.

---

## 23. Workspace Web Canterel

### 23.1 Rôle

Le workspace Web reste une surface de debug et de travail agentique : sessions, outils, fichiers, traces et previews. Il n’est pas la source de vérité du programme Locus Solus.

### 23.2 Visualisations

Canterel peut produire et prévisualiser des artefacts HTML/SVG/PNG/notebook/IIIF/3D, mais les artefacts doivent rester portables. Les visualisations riches sont ouvertes dans le meilleur viewer disponible, pas réimplémentées dans le chat.

### 23.3 Actions locales

Actions de session, retry local et inspection sont admises ; toute mutation durable de branche, budget, validation ou review passe par Locus Solus en mode connecté.

### 23.4 Transparence

L’UI affiche task/attempt IDs, environnement, sandbox, ressources, provider/modèle et coûts afin que l’utilisateur distingue clairement l’inférence distante du calcul local.

## 24. Résilience et récupération

### 24.1 Redémarrage du worker

Après redémarrage :

- reconstruire les attempts locaux ;
- ne pas supposer les leases valides ;
- reconnecter et réconcilier ;
- reprendre uniquement sur autorisation ;
- préserver les artefacts et événements ;
- détecter les sessions impossibles à restaurer.

### 24.2 Checkpoints

Un checkpoint contient :

- état de session sérialisable ;
- contexte hashé ;
- fichiers/worktree ;
- artefacts partiels ;
- budget consommé ;
- prochaines opérations ;
- dépendances non sérialisables signalées.

### 24.3 Offline

Le worker peut poursuivre hors ligne uniquement si la MissionEnvelope l’autorise et jusqu’au plafond de lease/offline budget. Sinon il checkpoint et suspend.

### 24.4 Résultats partiels

En cas d’échec, le worker soumet si possible :

- artefacts valides ;
- résultats négatifs ;
- diagnostics ;
- état de progression ;
- causes ;
- commit partiel explicitement marqué.

### 24.5 Corruption locale

Les manifests, événements et artefacts sont hashés. Une incohérence déclenche quarantaine et diagnostic, jamais réparation silencieuse.

---

## 25. Observabilité

### 25.1 Corrélation

Tous les logs/traces/metrics utilisent :

- workspace ;
- program ;
- branch ;
- task ;
- mission ;
- attempt ;
- worker ;
- session ;
- run ;
- correlation id.

### 25.2 Métriques système

- connexions/reconnexions ;
- latence LEP ;
- event spool ;
- leases ;
- missions par état ;
- slots ;
- erreurs ;
- CPU/mémoire/disque ;
- temps sandbox ;
- uploads ;
- checkpoint/recovery.

### 25.3 Métriques scientifiques

- claims proposés ;
- objections ;
- résultats négatifs ;
- artefacts reproductibles ;
- taux de commit rejeté ;
- divergence de reproduction ;
- coût par mission ;
- proportion de conclusions non étayées détectées localement.

### 25.4 Confidentialité

Prompts, sources et sorties ne sont pas exportés par défaut dans la télémétrie. Les logs utilisent identifiants et hashes, avec redaction configurable.

---

## 26. Erreurs structurées

```yaml
error_id:
code:
category:
retryable:
mission_id:
attempt:
component:
message:
details:
caused_by:
security_sensitive:
occurred_at:
```

Catégories minimales :

```text
protocol
authentication
authorization
admission
capability
model
tool
sandbox
network
secret
budget
artifact
context
session
lease
security
internal
```

Une erreur `retryable` doit préciser les conditions de retry. Les erreurs de politique ou sécurité ne sont jamais réessayées aveuglément.

---

## 27. Sécurité et modèle de menace

### 27.1 Menaces couvertes

- prompt injection dans sources ;
- exfiltration de secrets ;
- worker compromis ;
- faux manifeste de capacités ;
- contournement de sandbox ;
- SSRF via outils ;
- artefact malveillant ;
- résultat falsifié ;
- confusion entre branches ;
- replay de message ;
- dépendance/plugin compromis ;
- coût incontrôlé.

### 27.2 Défense en profondeur

- identité signée ;
- schémas stricts ;
- least privilege ;
- sandbox ;
- egress ;
- secret broker ;
- content addressing ;
- attestation ;
- event log ;
- review Locus Solus ;
- quarantaine ;
- révocation.

### 27.3 Supply chain

La release fournit :

- lockfiles ;
- SBOM ;
- signatures d’artefacts ;
- provenance de build ;
- scans de dépendances ;
- versions de runtime supportées ;
- politique de mise à jour.

---

## 28. Tests et assurance qualité

### 28.1 Tests unitaires

- mapping MissionEnvelope/session ;
- admission ;
- intersection de politiques ;
- modèle fallback ;
- budget ;
- event normalization ;
- commit builder ;
- redaction ;
- recovery state ;
- manifest hashing/signing.

### 28.2 Contract tests LEP

- handshake ;
- version negotiation ;
- resume ;
- duplicate messages ;
- sequence gaps ;
- leases ;
- late results ;
- artifact upload ;
- human input ;
- revocation ;
- capability change.

### 28.3 Consumer-driven contracts

La CI vérifie la compatibilité avec une version publiée de Locus Solus et avec les fixtures LEP de référence. Les tests ne doivent pas dépendre d’un dépôt Locus Solus local mutable.

### 28.4 Intégration

Scénarios :

- mission littérature ;
- mission calcul Python ;
- mission multi-agent ;
- revue aveugle ;
- artefacts IIIF standards ;
- commit avec artefacts ;
- question humaine ;
- cancellation ;
- budget atteint ;
- fallback modèle autorisé/refusé.

### 28.5 Recovery et fault injection

- crash avant acceptation ;
- crash après outil à effet ;
- perte réseau ;
- expiration de lease ;
- serveur redémarré ;
- worker redémarré ;
- upload interrompu ;
- message dupliqué ;
- disque plein ;
- secret révoqué ;
- session non restaurable.

### 28.6 Sandbox et sécurité

- écriture hors workspace ;
- lecture de secret ;
- DNS/HTTP interdit ;
- processus enfant ;
- fork bomb ;
- archive malveillante ;
- prompt injection ;
- MCP hostile ;
- artefact contenant token ;
- confusion de ContextView.

### 28.7 Endurance

Un test de sept jours simule :

- missions longues et courtes ;
- 4+ concurrents ;
- reconnexions ;
- rotations de token ;
- changements de capacités ;
- backpressure ;
- drainage ;
- redémarrages ;
- absence de fuite progressive de mémoire ou disque.

### 28.8 Non-régression standalone

Toutes les fonctions historiques essentielles d’Canterel restent testées sans Locus Solus installé.

---

## 29. Performance et SLO worker

Cibles V1 sur machine locale raisonnable, hors latence modèle :

- démarrage du worker < 5 s ;
- reconnexion nominale < 10 s ;
- admission d’une mission < 500 ms hors téléchargement du contexte ;
- événement critique persisté localement avant émission ;
- aucune perte d’événement acquitté ;
- mémoire idle additionnelle du mode worker bornée ;
- backpressure avant saturation du disque ;
- arrêt drain propre démontré.

Les objectifs ne justifient jamais de contourner la durabilité ou la sécurité.

---

## 30. Migration depuis l’implémentation actuelle

### 30.1 Éléments à préserver

- registres d’agents ;
- providers et routage ;
- tools/skills/MCP ;
- sessions ;
- compaction/handoff ;
- workspace Web ;
- provenance locale ;
- reviewer ;
- sandbox Seatbelt/Bubblewrap ;
- système de permissions.

### 30.2 Éléments à refactorer

- `TaskTool` devient adaptateur de sous-tâches locales ; les missions durables passent par LEP ;
- agent registry sépare template, overlay et instance Locus Solus ;
- sorties d’agents majeures deviennent structurées ;
- event bus expose un bridge stable ;
- provenance exportable vers EpistemicCommit ;
- sandbox produit une attestation exploitable ;
- coûts et modèles sont mesurés explicitement.

### 30.3 Éléments à ne pas dupliquer

- scheduler global ;
- graph DB ;
- policy engine global ;
- budget ledger ;
- review institution ;
- Temporal workflows ;
- API Locus Solus ;
- client Emacs Locus Solus.

---

## 31. Documentation obligatoire

- installation et enrôlement ;
- modèle de sécurité ;
- fonctionnement LEP ;
- capacités et limitations ;
- politique de données des modèles ;
- sandbox et réseau ;
- outils à effet ;
- récupération ;
- migration standalone → Locus Solus ;
- développement d’un agent compatible ;
- diagnostic ;
- runbook opérateur ;
- compatibilité des versions.

---

## 32. Critères d’acceptation V1

Canterel V1 Locus Solus est accepté uniquement si :

### 32.1 Autonomie

- le mode standalone reste fonctionnel et testé ;
- aucune dépendance Locus Solus n’est obligatoire au démarrage normal ;
- une session historique peut être proposée explicitement à Locus Solus.

### 32.2 LEP

- worker conforme LEP v1 ;
- identité, handshake, resume et signatures ;
- manifestes de capacités effectifs ;
- messages idempotents ;
- reconnexion sans perte ;
- lease et late results correctement traités.

### 32.3 Exécution

- missions multi-modèles et multi-agents ;
- environnements séparés ;
- worktrees ;
- ContextViews immuables ;
- questions humaines ;
- cancellation et checkpoint ;
- quatre missions concurrentes sur configuration adaptée.

### 32.4 Sécurité

- politiques outils/modèles/réseau réellement appliquées ;
- sandbox attestée ;
- secret grants courts ;
- prompt injection testée ;
- artefacts scannés ;
- refus fail-closed lorsqu’une politique ne peut être appliquée.

### 32.5 Evidence

- ArtifactManifest, EnvironmentManifest et RunManifest ;
- EpistemicCommit structuré et signé ;
- assumptions, failures et résultats négatifs préservés ;
- aucun écrit direct dans le graphe canonique ;
- bundle IIIF/Content State standard transmissible.

### 32.6 Résilience

- crash/restart/reconnect ;
- reprise par séquences ;
- uploads résumables ;
- spool borné ;
- test d’endurance ;
- aucune fausse complétion après perte de lease.

### 32.7 Observabilité

- traces corrélées ;
- métriques usage/coût ;
- statuts worker/mission visibles ;
- diagnostics exportables sans secrets.

---

## 33. Non-objectifs

- remplacer `locusd` ;
- devenir une base de données épistémique ;
- piloter directement le portefeuille global ;
- valider seul la vérité d’un claim ;
- imposer Temporal au mode standalone ;
- permettre des effets externes implicites ;
- rendre publics les transcripts ou données privées ;
- entraîner un modèle fondation ;
- garantir qu’une mission scientifique réussira.

---

## 34. Audit de la spécification précédente

### 34.1 Naming et contrat

La précédente version utilisait `Canterel Lab`, `lab/`, `LabTask` et un protocole ad hoc. Cette version aligne entièrement le dépôt sur **Locus Solus**, le namespace `locus/`, `MissionEnvelope` et LEP v1.

### 34.2 Trust boundary

L’ancienne spec présentait le worker comme relativement coopératif, sans expliciter qu’il est non fiable du point de vue du control plane. La nouvelle version ajoute identité, signature, attestation, révocation, quarantaine et validation serveur.

### 34.3 Durabilité

La reconnexion était décrite, mais pas le stockage des séquences, event spool, resume tokens, réconciliation des attempts ou comportement après perte de lease. Ces mécanismes sont désormais normatifs.

### 34.4 Contexte et indépendance

L’ancien « contexte matérialisé » ne suffisait pas à garantir les revues aveugles et l’isolation inter-branches. La nouvelle spec impose `ContextView` immuable, hash, exclusions, extensions contrôlées et interdiction de mémoire implicite.

### 34.5 Exécution

La première version sous-spécifiait worktrees, checkpoints, sous-agents locaux, overlays, politiques effectives et effets externes. Ces mécanismes sont maintenant séparés et testables.

### 34.6 Evidence

Les artefacts et commits étaient décrits sans EnvironmentManifest, RunManifest, scan, quarantaine, signature ni gestion complète des late results. La nouvelle version les ajoute.

### 34.7 Sécurité

La précédente spec évoquait sandbox et secrets sans modèle de menace complet ni niveaux d’isolation. La nouvelle version couvre prompt injection, MCP hostile, egress, supply chain, secret broker et fail-closed.

### 34.8 Exploitation

Les métriques, SLO, endurance, fault injection, drainage et migration des sessions standalone étaient insuffisants. Ils font désormais partie des critères d’acceptation.

---

## 35. Définition finale

> **Canterel V1 est le runtime scientifique autonome qui, lorsqu’il est enrôlé dans Locus Solus, exécute des missions LEP dans des contextes et environnements isolés, produit des preuves et artefacts attestés, et soumet des commits épistémiques structurés sans jamais usurper l’autorité du control plane ou du graphe canonique.**
