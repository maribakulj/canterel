// Généré depuis schemas/ par tooling/sdk/generate.ts — ne pas éditer à la main.
//
// `npm run check:generated` régénère et compare : une retouche manuelle fait échouer la CI.
// Ce qui doit changer, ce sont les schémas ; ils sont le contrat, ceci n'en est qu'une lecture.

/**
 * Version du protocole portée par chaque enveloppe. Le motif accepte toute la ligne 1.x, pas seulement 1.0 : docs/06 fait du mineur un ajout de champs optionnels compatibles, donc un consommateur 1.0 doit accepter un document 1.1 et ignorer ce qu'il ne connaît pas. Un `const` ici transformerait chaque ajout mineur en rupture.
 */
export type ProtocolVersion = string;

/**
 * SPEC_V1 §21.6. L'ordre est significatif : S0 < S1 < ... < S5. Un downgrade est interdit sauf approbation explicite et événement de sécurité.
 */
export type SandboxLevel = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";

/**
 * SPEC_V1 §21.7. `deny` par défaut pour du code non fiable. Voir schemas/README.md pour la graphie de `connector-only`, qui diffère de celle du texte de la spec.
 */
export type NetworkMode = "deny" | "connector-only" | "allowlist" | "full";

export type AcceleratorType = "cuda" | "rocm" | "mps" | "tpu" | "none";

export type Os = "linux" | "macos" | "windows";

export type Arch = "x86_64" | "arm64";

/**
 * Classification. Les missions ne peuvent pas l'abaisser (SPEC_V1 §21.9) ; l'ordre est croissant en sensibilité.
 */
export type DataClass = "public" | "internal" | "confidential" | "restricted";

/**
 * Hash adressant un contenu immuable, préfixé par son algorithme. Le préfixe est obligatoire : un hash nu ne dit pas comment le recalculer, et une vérification d'intégrité qui devine son algorithme n'en est pas une. La longueur est vérifiée par algorithme plutôt que par une borne commode — un digest tronqué est la forme que prend une intégrité cassée.
 */
export type ContentHash = string;

export type ContainmentResult = "blocked" | "allowed" | "not-run";

export type LimitResult = "enforced" | "unenforced" | "not-run";

/**
 * Références à des artefacts, par identifiant et hash — la provenance passe par le contenu, pas par le nom.
 */
export type Refs = readonly RefsItem[];

export type Hash = string;

export type Reason =
  /**
   * L'hôte ne sait pas confiner aussi fort que la mission l'exige. **Distinct de `level_not_attested`** : « l'hôte ne sait pas faire » envoie chercher une autre machine ; « l'hôte l'annonce sans l'avoir prouvé » envoie faire tourner une campagne de self-tests. Les fondre ferait acheter du matériel pour un problème d'attestation.
   */
  | {
      readonly code: "level_unavailable";
      readonly required: SandboxLevel;
      readonly best: SandboxLevel;
    }
  /**
   * La réservation dépasse la capacité de l'hôte. Le seul motif sans donnée : ce qui manque est du volume, et la réservation refusée est déjà dans la mission.
   */
  | { readonly code: "capacity_exceeded" }
  /**
   * L'accélérateur demandé n'est pas sur cet hôte.
   */
  | { readonly code: "accelerator_unavailable"; readonly kind: string }
  /**
   * L'hôte ne sait pas **borner** l'espace disque, quel qu'il en reste. Distinct de `capacity_exceeded`, et la distinction n'est pas cosmétique : « la capacité manque » envoie libérer de la place ou réduire la réservation ; « la borne n'est pas applicable ici » envoie changer de système de fichiers, ou de machine. Les fondre ferait réduire une réservation qui aurait échoué de la même façon à un octet. Né avec W5.g et W5.j, après l'écriture d'ADR 0017 §5.2 — qui en nommait six.
   */
  | {
      readonly code: "disk_quota_not_enforceable";
      readonly requested: number;
      readonly why: string;
    }
  /**
   * L'hôte ne sait pas appliquer ce mode réseau.
   */
  | { readonly code: "network_mode_unsupported"; readonly mode: NetworkMode }
  /**
   * L'hôte annonce ce niveau mais ne l'a jamais prouvé — §12.2 demande une sandbox « disponible **et attestée** ». `proven` est **absent** quand aucune campagne n'a conclu, et ce n'est pas la même ignorance qu'un niveau prouvé trop bas : l'une envoie lancer les self-tests, l'autre dit que l'hôte a échoué à les passer.
   */
  | {
      readonly code: "level_not_attested";
      readonly required: SandboxLevel;
      readonly proven?: SandboxLevel | undefined;
    }
  /**
   * L'accélérateur **est** sur cet hôte, mais pas là où la mission veut être confinée. Distinct d'`accelerator_unavailable` : le dire « absent » enverrait chercher du matériel au lieu de choisir entre le conteneur et l'accélérateur.
   */
  | {
      readonly code: "accelerator_outside_sandbox";
      readonly kind: string;
      readonly required: SandboxLevel;
      readonly native_level: SandboxLevel;
    };

/**
 * Le GPU est une capability, pas une dépendance globale (invariant 8) : absent veut dire « aucun n'est requis », jamais « n'importe lequel fera l'affaire ».
 */
export type ResourceSpecAccelerator = {
  readonly type: AcceleratorType;
  readonly count: number;
  readonly memory_mb?: number | undefined;
};

/**
 * Ce qu'une mission réserve avant de s'exécuter. C'est une demande, pas un inventaire : voir la note dans schemas/README.md sur la raison de ne pas partager cette forme avec les ressources annoncées par un worker. Invariant 6 : les ressources sont réservées avant exécution, elles ne sont pas supposées illimitées — chaque borne est donc obligatoire, aucune n'a de défaut implicite.
 */
export type ResourceSpec = {
  /**
   * Cœurs réservés. Fractionnaire parce qu'un ordonnanceur de conteneurs sait allouer moins d'un cœur.
   */
  readonly cpu: number;
  readonly memory_mb: number;
  readonly disk_mb: number;
  /**
   * Borne de temps réel. Un attempt qui la dépasse est arrêté, pas prolongé.
   */
  readonly wall_time_seconds: number;
  /**
   * Le GPU est une capability, pas une dépendance globale (invariant 8) : absent veut dire « aucun n'est requis », jamais « n'importe lequel fera l'affaire ».
   */
  readonly accelerator?: ResourceSpecAccelerator | undefined;
};

/**
 * L'isolation qu'une mission EXIGE. Ce n'est pas ce qu'un worker offre, et les deux formes restent distinctes exprès : une exigence porte un plancher (`minimum_level`), une offre porte une liste (`levels`). Les confondre est la façon dont un ordonnanceur finit par comparer un plancher à un inventaire et par accorder S1 à une mission qui demandait S3.
 */
export type SandboxSpec = {
  /**
   * Plancher, jamais un souhait. Le worker atteste le niveau réellement appliqué et un downgrade est interdit sauf approbation explicite et événement de sécurité (SPEC_V1 §21.6).
   */
  readonly minimum_level: SandboxLevel;
  readonly network: NetworkMode;
  /**
   * Domaines joignables quand `network` vaut `allowlist`. Le schéma impose sa présence dans ce cas : une allowlist implicite est une autorisation totale qui n'ose pas dire son nom.
   */
  readonly network_allowlist?: readonly string[] | undefined;
  /**
   * Profil V1 (SPEC_V1 §21.6). Il nomme une intention ; c'est `minimum_level` qui engage.
   */
  readonly profile?:
    | "interactive-local"
    | "readonly-review"
    | "network-allowlisted"
    | "math-compute"
    | "dh-corpus"
    | "untrusted-repository"
    | "microvm-high-risk"
    | undefined;
  /**
   * Exige du worker une SandboxAttestation (W0.6) plutôt qu'une déclaration.
   */
  readonly attestation_required?: boolean | undefined;
};

export type ContextViewTimeRange = {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
};

export type ContextViewRedactionsItem = {
  readonly target: string;
  readonly reason: string;
};

/**
 * Ce que l'agent pouvait connaître, arrêté et adressé par hash (SPEC_V1 §16.2). Immuable : `content_hash` et `source_event_watermark` sont obligatoires parce qu'une vue de contexte sans eux ne permet plus de répondre à la question qui la justifie — que savait-on, et à quel instant du journal.
 */
export type ContextView = {
  readonly id: string;
  readonly query?: string | undefined;
  readonly root_ids?: readonly string[] | undefined;
  readonly included_types?: readonly string[] | undefined;
  readonly included_relations?: readonly string[] | undefined;
  readonly max_depth?: number | undefined;
  readonly time_range?: ContextViewTimeRange | undefined;
  /**
   * Invariant 11 et §12.4 : l'isolation informationnelle se décide ici. Une vue construite pour la branche A ne doit jamais atteindre une mission de la branche B.
   */
  readonly branch_scope?: readonly string[] | undefined;
  readonly validation_levels?: readonly string[] | undefined;
  readonly confidentiality_ceiling: DataClass;
  readonly artifact_policy?: string | undefined;
  /**
   * Invariant 12 : les résultats négatifs ne sont jamais supprimés pour rendre le graphe propre. Une vue peut les cadrer, pas les effacer — d'où `include` par défaut et l'absence de toute valeur signifiant « supprimer ».
   */
  readonly negative_result_policy?: "include" | "include-weighted" | "summarize" | undefined;
  readonly diversity_policy?: string | undefined;
  readonly token_budget?: number | undefined;
  readonly redactions?: readonly ContextViewRedactionsItem[] | undefined;
  /**
   * Position dans le journal jusqu'à laquelle la vue a été construite. C'est ce qui rend « ce que l'agent pouvait connaître » vérifiable après coup.
   */
  readonly source_event_watermark: number;
  readonly content_hash: ContentHash;
  readonly generated_at: string;
};

export type EnvironmentBlueprintPlatform = {
  readonly os: Os;
  readonly arch: Arch;
};

/**
 * Par digest, jamais par tag (§21.8). Un tag est mutable, et un environnement dont l'image peut changer sous lui n'est pas verrouillé.
 */
export type EnvironmentBlueprintImage = {
  readonly reference?: string | undefined;
  readonly digest: ContentHash;
};

export type EnvironmentBlueprintLockfilesItem = {
  readonly path: string;
  readonly hash: ContentHash;
};

export type EnvironmentBlueprintResources = {
  readonly minimum: ResourceSpec;
  readonly preferred?: ResourceSpec | undefined;
};

export type EnvironmentBlueprintMountsItem = {
  readonly source: string;
  readonly target: string;
  readonly mode: "ro" | "rw";
};

export type EnvironmentBlueprintHealthChecksItem = {
  readonly name: string;
  readonly command: readonly string[];
  readonly timeout_seconds?: number | undefined;
};

export type EnvironmentBlueprintAccelerator = {
  readonly type: AcceleratorType;
  readonly minimum_memory_mb?: number | undefined;
};

/**
 * Ce qu'un environnement déclare (SPEC_V1 §19.3) : OS/arch, profils de toolchain, images par digest, lockfiles, variables non secrètes, ressources, réseau, mounts, health checks et exigences d'accélérateur. Il vit sous `environments/` et non `lep/` parce qu'une mission le référence par identifiant : c'est un contrat de reproductibilité, pas une trame de fil.
 */
export type EnvironmentBlueprint = {
  readonly environment_id: string;
  /**
   * Deux blueprints qui diffèrent portent des versions différentes. Le niveau R2 de reproductibilité (§19.7) est « environnement verrouillé » : il ne l'est que si l'identifiant l'est aussi.
   */
  readonly version: string;
  readonly platform: EnvironmentBlueprintPlatform;
  readonly toolchains: readonly string[];
  /**
   * Par digest, jamais par tag (§21.8). Un tag est mutable, et un environnement dont l'image peut changer sous lui n'est pas verrouillé.
   */
  readonly image: EnvironmentBlueprintImage;
  readonly lockfiles?: readonly EnvironmentBlueprintLockfilesItem[] | undefined;
  /**
   * Variables NON secrètes. Le schéma ne peut pas empêcher d'y mettre un token, mais il peut refuser de prévoir une place pour en mettre un : il n'y a pas de champ `secrets`, et il n'y en aura pas.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly resources: EnvironmentBlueprintResources;
  readonly network?: NetworkMode | undefined;
  readonly mounts?: readonly EnvironmentBlueprintMountsItem[] | undefined;
  readonly health_checks?: readonly EnvironmentBlueprintHealthChecksItem[] | undefined;
  readonly accelerator?: EnvironmentBlueprintAccelerator | undefined;
};

export type ArtifactManifestProducedBy = {
  readonly task_id: string;
  readonly attempt: number;
  readonly agent_id?: string | undefined;
  readonly worker_id?: string | undefined;
  readonly run_id?: string | undefined;
};

export type ArtifactManifestRights = {
  readonly license?: string | undefined;
  readonly holder?: string | undefined;
  readonly note?: string | undefined;
};

export type ArtifactManifestDerivedFromItem = {
  readonly artifact_id: string;
  readonly content_hash?: ContentHash | undefined;
  /**
   * Sous-ensemble des relations typées de §7.5 qui portent une dérivation d'artefact.
   */
  readonly relation: "derived_from" | "produced_by" | "consumes" | "supersedes" | "reproduces";
};

/**
 * Indications d'affichage. Facultatives par construction : xiiif n'est pas requis par les agents (invariant 10), et un artefact sans hint reste un artefact complet.
 */
export type ArtifactManifestViewerHints = {
  readonly kind?: string | undefined;
  readonly iiif_manifest_url?: string | undefined;
  readonly preview_artifact_id?: string | undefined;
};

export type ArtifactManifestIntegrity = {
  readonly verified_at?: string | undefined;
  readonly verified_hash_matches?: boolean | undefined;
  readonly scanner?: string | undefined;
};

/**
 * Ce que porte chaque artefact (SPEC_V1 §19.2) : hash de contenu, media type, taille, créateur/attempt, provenance, classification, droits, relations de dérivation, viewer hints, intégrité et état de quarantaine.
 *
 * Invariant 4 : tout résultat scientifique majeur est artifact-first et provenance-first. Le hash, la taille et le créateur sont donc obligatoires — un artefact dont on ne sait ni ce qu'il contient, ni combien il pèse, ni qui l'a produit n'est pas un artefact, c'est un fichier.
 *
 * §19.1 : le hash est déclaré AVANT l'upload, et un hash reçu qui diffère du hash déclaré fait rejeter l'envoi. Le même champ sert donc de promesse puis de preuve.
 */
export type ArtifactManifest = {
  readonly artifact_id: string;
  readonly content_hash: ContentHash;
  /**
   * Type MIME. Il décide du viewer et du traitement, donc il n'a pas de valeur par défaut : deviner « application/octet-stream » revient à décider de ne rien afficher.
   */
  readonly media_type: string;
  readonly size_bytes: number;
  readonly filename?: string | undefined;
  readonly produced_by: ArtifactManifestProducedBy;
  readonly classification: DataClass;
  readonly rights?: ArtifactManifestRights | undefined;
  /**
   * Relations de dérivation, par hash et non par nom : un chemin change, un contenu non.
   */
  readonly derived_from?: readonly ArtifactManifestDerivedFromItem[] | undefined;
  /**
   * Indications d'affichage. Facultatives par construction : xiiif n'est pas requis par les agents (invariant 10), et un artefact sans hint reste un artefact complet.
   */
  readonly viewer_hints?: ArtifactManifestViewerHints | undefined;
  /**
   * §19 : quarantaine et promotion. Un artefact issu de données non fiables entre en `quarantined` et n'en sort que par une revue (§21.7) — d'où l'absence de toute valeur signifiant « promu automatiquement ».
   */
  readonly state: "declared" | "uploaded" | "quarantined" | "verified" | "promoted" | "rejected";
  readonly integrity?: ArtifactManifestIntegrity | undefined;
  readonly declared_at?: string | undefined;
  readonly uploaded_at?: string | undefined;
};

export type RunManifestEnvironment = {
  readonly environment_id: string;
  readonly image_digest: ContentHash;
  readonly toolchains: readonly string[];
};

export type RunManifestCodeRevision = {
  readonly repository?: string | undefined;
  readonly commit?: string | undefined;
  /**
   * Vrai quand l'arbre de travail portait des modifications non commitées. Un run dirty ne peut pas prétendre à R1, et cacher le champ ne le rendrait pas reproductible.
   */
  readonly dirty?: boolean | undefined;
};

export type RunManifestInputsItem = {
  readonly artifact_id?: string | undefined;
  readonly content_hash: ContentHash;
  readonly role?: string | undefined;
};

export type RunManifestCommandsItem = {
  readonly argv: readonly string[];
  readonly cwd?: string | undefined;
  readonly exit_code?: number | undefined;
  readonly started_at?: string | undefined;
  readonly duration_seconds?: number | undefined;
};

export type RunManifestResourcesObserved = {
  readonly cpu_seconds?: number | undefined;
  readonly memory_peak_mb?: number | undefined;
  readonly disk_peak_mb?: number | undefined;
  readonly wall_time_seconds?: number | undefined;
};

/**
 * Réservé face à observé. C'est l'écart entre les deux que le rapprochement de coûts exploite, et le garder dans un seul document évite d'avoir à le reconstituer.
 */
export type RunManifestResources = {
  readonly reserved: ResourceSpec;
  readonly observed?: RunManifestResourcesObserved | undefined;
};

export type RunManifestOutputsItem = {
  readonly artifact_id: string;
  readonly content_hash: ContentHash;
};

/**
 * Ce qu'un run consigne (SPEC_V1 §19.6) : image digest, toolchains, révision du code, inputs, ressources réservées ET observées, variables pertinentes, commandes, seeds, sorties et attestations de sandbox.
 *
 * C'est le document qui décide du niveau de reproductibilité atteint (§19.7) : R1 demande inputs et code identifiés, R2 un environnement verrouillé. Les champs obligatoires ici sont exactement ceux sans lesquels on ne dépasse pas R0 — « narration uniquement ».
 */
export type RunManifest = {
  readonly run_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly environment: RunManifestEnvironment;
  readonly code_revision?: RunManifestCodeRevision | undefined;
  /**
   * Par hash. Nommer un input par son chemin ne dit pas ce qu'il contenait au moment du run.
   */
  readonly inputs: readonly RunManifestInputsItem[];
  /**
   * Le tableau d'arguments, pas une ligne de shell : une chaîne à réinterpréter par un shell n'est pas reproductible, et c'est aussi par là que passe une injection.
   */
  readonly commands: readonly RunManifestCommandsItem[];
  /**
   * Variables pertinentes, NON secrètes. Il n'y a pas de champ pour un secret, et il n'y en aura pas.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * Sans les seeds, un run stochastique n'est pas reproductible même avec la même image et les mêmes inputs.
   */
  readonly seeds?: Readonly<Record<string, number>> | undefined;
  /**
   * Réservé face à observé. C'est l'écart entre les deux que le rapprochement de coûts exploite, et le garder dans un seul document évite d'avoir à le reconstituer.
   */
  readonly resources: RunManifestResources;
  readonly outputs?: readonly RunManifestOutputsItem[] | undefined;
  readonly sandbox_attestation?: SandboxAttestation | undefined;
  /**
   * §19.7. Déclaré par le producteur et vérifiable depuis le reste du manifeste — c'est précisément ce qui le rend contestable.
   */
  readonly reproducibility_level?: "R0" | "R1" | "R2" | "R3" | "R4" | undefined;
  readonly started_at: string;
  readonly completed_at?: string | undefined;
};

export type CapabilityManifestPlatform = {
  readonly os: Os;
  readonly arch: Arch;
  readonly release?: string | undefined;
};

export type CapabilityManifestModelsItem = {
  readonly provider: string;
  /**
   * `oauth-local` n'est admissible que sur un worker local de confiance (docs/08) ; le schéma ne peut pas le vérifier, l'admission le peut.
   */
  readonly auth: "oauth-local" | "service-credential" | "none";
  /**
   * Vrai quand les prompts quittent la machine. C'est ce qui décide si une classe de données peut être traitée par ce modèle.
   */
  readonly remote_inference?: boolean | undefined;
  readonly models?: readonly string[] | undefined;
};

/**
 * Inventaire, pas réservation — d'où `cpu_cores` et `disk_free_mb` plutôt que le `cpu`/`disk_mb` de ResourceSpec. Deux noms différents pour deux grandeurs différentes valent mieux qu'un nom commun qui invite à les soustraire l'une de l'autre sans y penser.
 */
export type CapabilityManifestResources = {
  readonly cpu_cores: number;
  readonly memory_mb: number;
  readonly disk_free_mb: number;
};

export type CapabilityManifestAcceleratorsItem = {
  readonly type: AcceleratorType;
  readonly count: number;
  readonly memory_mb?: number | undefined;
};

/**
 * L'offre d'isolation. `levels` énumère ce qui est réellement applicable ; un worker macOS sous Seatbelt annonce S1/S2 et jamais S3.
 */
export type CapabilityManifestSandbox = {
  readonly levels: readonly SandboxLevel[];
  readonly network_modes: readonly NetworkMode[];
  readonly backend?: string | undefined;
  /**
   * Vrai quand le worker sait produire une SandboxAttestation (W0.6) et non une simple déclaration.
   */
  readonly attestation?: boolean | undefined;
};

/**
 * Ce qu'un worker ANNONCE au handshake (SPEC_V1 §15.3). C'est un inventaire, pas une demande : les formes ne sont volontairement pas partagées avec MissionEnvelope. Un worker annonce les niveaux de sandbox qu'il sait réellement appliquer — jamais ceux qu'il aimerait offrir.
 */
export type CapabilityManifest = {
  readonly protocol: ProtocolVersion;
  readonly worker_id: string;
  /**
   * Ouvert exprès : LEP est un protocole d'exécution générique (docs/00), et un worker qui n'est pas Canterel doit pouvoir parler la même langue.
   */
  readonly worker_kind: string;
  readonly platform: CapabilityManifestPlatform;
  readonly models?: readonly CapabilityManifestModelsItem[] | undefined;
  /**
   * Profils de docs/SPEC_V1 §19.4. Ouvert : la liste des profils évolue plus vite que le protocole.
   */
  readonly toolchains: readonly string[];
  /**
   * Inventaire, pas réservation — d'où `cpu_cores` et `disk_free_mb` plutôt que le `cpu`/`disk_mb` de ResourceSpec. Deux noms différents pour deux grandeurs différentes valent mieux qu'un nom commun qui invite à les soustraire l'une de l'autre sans y penser.
   */
  readonly resources: CapabilityManifestResources;
  readonly accelerators?: readonly CapabilityManifestAcceleratorsItem[] | undefined;
  /**
   * L'offre d'isolation. `levels` énumère ce qui est réellement applicable ; un worker macOS sous Seatbelt annonce S1/S2 et jamais S3.
   */
  readonly sandbox: CapabilityManifestSandbox;
  /**
   * Classes que ce worker est autorisé à traiter. Le plafond d'une mission ne peut pas les dépasser.
   */
  readonly data_classes: readonly DataClass[];
  readonly max_concurrency?: number | undefined;
  readonly mission_kinds?: readonly string[] | undefined;
  readonly trust_level?: string | undefined;
};

export type MissionEnvelopeObjective = {
  readonly statement: string;
  /**
   * Au moins une, et énoncée avant l'exécution. Un critère de succès écrit après coup ne prouve rien.
   */
  readonly success_conditions: readonly string[];
  readonly failure_conditions?: readonly string[] | undefined;
};

/**
 * Référence, pas contenu : la mission porte l'identité et le hash de la vue, le worker la matérialise. Le hash est obligatoire — sans lui, « ce que l'agent pouvait connaître » n'est plus vérifiable.
 */
export type MissionEnvelopeContextView = {
  readonly id: string;
  readonly hash: ContentHash;
};

export type MissionEnvelopeEnvironment = {
  readonly environment_id: string;
  readonly image_digest?: ContentHash | undefined;
  readonly toolchains?: readonly string[] | undefined;
};

/**
 * Invariant 6 appliqué au coût du modèle. Les trois bornes sont obligatoires : une seule d'entre elles laissée libre suffit à rendre le dépassement impossible à constater.
 */
export type MissionEnvelopeBudget = {
  readonly max_model_calls: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_cost_micros?: number | undefined;
};

/**
 * Ce qu'une mission DEMANDE (SPEC_V1 §15.4). Rien ici n'est optionnel par commodité : objectif, contexte, sandbox, ressources, budget et contrat de sortie sont ce qui rend une mission admissible ou refusable, et une mission qui en omet un ne peut pas être jugée — elle serait acceptée par défaut, ce qui est exactement le contraire de l'admission.
 */
export type MissionEnvelope = {
  readonly protocol: ProtocolVersion;
  readonly task_id: string;
  /**
   * Une tâche durable connaît plusieurs attempts (§15.5). L'identifiant d'attempt est ce qui distingue un résultat tardif d'un doublon.
   */
  readonly attempt_id: string;
  readonly branch_id: string;
  readonly objective: MissionEnvelopeObjective;
  /**
   * Référence, pas contenu : la mission porte l'identité et le hash de la vue, le worker la matérialise. Le hash est obligatoire — sans lui, « ce que l'agent pouvait connaître » n'est plus vérifiable.
   */
  readonly context_view: MissionEnvelopeContextView;
  readonly environment: MissionEnvelopeEnvironment;
  readonly sandbox: SandboxSpec;
  readonly resources: ResourceSpec;
  /**
   * Invariant 6 appliqué au coût du modèle. Les trois bornes sont obligatoires : une seule d'entre elles laissée libre suffit à rendre le dépassement impossible à constater.
   */
  readonly budget: MissionEnvelopeBudget;
  readonly required_capabilities?: readonly string[] | undefined;
  readonly confidentiality_ceiling?: DataClass | undefined;
  /**
   * Invariant 11 : un reviewer indépendant ne reçoit pas le raisonnement privé du générateur. `independent` est ce qui l'engage.
   */
  readonly review_policy?: "none" | "self" | "independent" | "independent-blind" | undefined;
  /**
   * Le rôle de l'instance d'agent, au sens de `SPEC_V1.md` §7.1 (`AgentTemplate.role`) et §20 (`- role: logical-reviewer`). Optionnel : un document `1.0` le laisse absent, et absent ne se remplit pas d'un défaut. Chaîne libre et non énumération, parce qu'un mineur ajoute des champs et jamais des valeurs (ADR 0017, interdit 3) — un rôle nouveau dans une énumération fermée ferait échouer la désérialisation chez tout consommateur `1.0`. Ne prend jamais le pas sur `review_policy` : l'invariant 11 décide avant le rôle.
   */
  readonly role?: string | undefined;
  /**
   * La permission de poursuivre **hors ligne** — `SPEC_V1.md` §1.2 (dernier invariant) et §24.3. Distincte de `sandbox.network_mode`, et les deux ne se dérivent jamais l'une de l'autre : `network_mode: deny` est une **contrainte** imposée au worker, qui lui retire le réseau ; cette permission est une **dispense**, qui l'autorise à ne pas échouer quand le réseau manque. Une mission peut exiger `full` et n'avoir aucune dispense — elle échoue si le réseau tombe ; une autre peut être en `deny` sans dispense — elle n'a jamais eu de réseau à perdre. Les confondre ferait d'un confinement une autorisation, ce qu'ADR 0004 sépare partout ailleurs. Absente, elle ne s'accorde pas : un document `1.0` ne demande pas cette dispense, il n'en parle pas.
   */
  readonly offline_allowed?: boolean | undefined;
  /**
   * Le plafond de travail hors ligne, en millisecondes. Sans effet sans `offline_allowed` : un budget n'est pas une permission. Le lecteur retient de toute façon le plus contraignant de ce budget et du lease restant — un budget plus long que le lease donnerait le droit de travailler après la fin du droit de travailler.
   */
  readonly offline_budget_ms?: number | undefined;
  /**
   * Ce que l'attempt doit rendre. `epistemic-commit/1` n'a aucune autorité de validation avant traitement par Locus Solus (§15.7).
   */
  readonly output_contract: string;
  readonly deadline?: string | undefined;
};

/**
 * Invariant 6 : les ressources sont réservées, pas supposées illimitées. Une limite absente est une limite absente.
 */
export type SandboxAttestationLimits = {
  readonly cpu: number;
  readonly memory_mb: number;
  readonly pids: number;
  readonly disk_mb: number;
};

/**
 * Les quatre self-tests d'ADR 0004. Tous obligatoires : un self-test qu'on peut omettre est un self-test qu'on omettra le jour où il échoue. `not-run` existe pour que « je ne l'ai pas exécuté » soit dicible — et distinct de « il a réussi ».
 */
export type SandboxAttestationSelfTests = {
  readonly write_outside_workspace: ContainmentResult;
  readonly read_host_home: ContainmentResult;
  readonly network_egress: ContainmentResult;
  readonly memory_limit: LimitResult;
};

/**
 * Ce que le worker atteste avoir RÉELLEMENT appliqué, face au plancher qu'une SandboxSpec exigeait (SPEC_V1 §21.6). ADR 0004 fait des self-tests la définition opérationnelle du mot « sandbox » : l'attestation les porte, sans quoi elle n'est qu'une déclaration d'intention.
 *
 * Une attestation doit pouvoir décrire une MAUVAISE sandbox. `host_home_mounted: true` est un document valide — refusé par l'admission, jamais par le schéma. Interdire de l'écrire ne rendrait pas le montage impossible : ça rendrait seulement le worker incapable de l'avouer, et un worker non conforme mais muet est pire qu'un worker non conforme qui le dit.
 */
export type SandboxAttestation = {
  readonly sandbox_id: string;
  readonly backend: string;
  readonly isolation_level: SandboxLevel;
  readonly image_digest?: ContentHash | undefined;
  readonly rootless?: boolean | undefined;
  readonly read_only_rootfs?: boolean | undefined;
  readonly network_mode: NetworkMode;
  /**
   * Obligatoire, et obligatoire même quand la réponse est `false`. Un champ absent se lit « je n'ai pas regardé » aussi bien que « non » ; seul l'un des deux est une attestation.
   */
  readonly host_home_mounted: boolean;
  readonly runtime_socket_exposed: boolean;
  /**
   * Invariant 6 : les ressources sont réservées, pas supposées illimitées. Une limite absente est une limite absente.
   */
  readonly limits: SandboxAttestationLimits;
  /**
   * Les quatre self-tests d'ADR 0004. Tous obligatoires : un self-test qu'on peut omettre est un self-test qu'on omettra le jour où il échoue. `not-run` existe pour que « je ne l'ai pas exécuté » soit dicible — et distinct de « il a réussi ».
   */
  readonly self_tests: SandboxAttestationSelfTests;
  readonly attested_at?: string | undefined;
  readonly signature?: string | undefined;
};

/**
 * L'enveloppe que porte tout événement worker → serveur (SPEC_V1 §15.2 : « toutes les enveloppes portent version de protocole, sequence, correlation IDs et idempotency key »). Les types minimaux sont ceux de §15.6.
 *
 * À ne pas confondre avec l'enveloppe du journal institutionnel de §10.1, qui vit sous `schemas/events/` et appartient à W1 : celle-ci traverse le fil, celle-là est écrite dans l'event store. Un worker ne modifie jamais directement la base canonique (invariant 3), donc les deux ne peuvent pas être le même objet.
 */
export type Event = {
  readonly protocol: ProtocolVersion;
  /**
   * Fermé exprès, contrairement aux documents. Un type d'événement inconnu n'est pas un champ qu'on peut ignorer : le consommateur ne saura ni quoi en faire ni s'il vient de rater quelque chose. Un nouveau type est un ajout mineur qui met à jour cette liste.
   */
  readonly event_type:
    | "worker.registered"
    | "task.offered"
    | "task.accepted"
    | "attempt.started"
    | "heartbeat"
    | "progress"
    | "tool.started"
    | "tool.completed"
    | "artifact.declared"
    | "artifact.uploaded"
    | "resource.sampled"
    | "human.input.requested"
    | "attempt.completed"
    | "attempt.failed"
    | "attempt.orphaned"
    | "epistemic_commit.submitted";
  /**
   * Monotone par connexion. C'est ce qui permet l'acquittement et la reprise de stream (§12.4) : sans lui, « rien perdu, rien dupliqué » n'est pas vérifiable.
   */
  readonly sequence: number;
  readonly occurred_at: string;
  /**
   * Un événement rejoué après reconnexion porte la même clé. C'est ce qui rend la reprise sûre plutôt que dupliquante.
   */
  readonly idempotency_key: string;
  readonly task_id?: string | undefined;
  readonly attempt?: number | undefined;
  readonly lease_id?: string | undefined;
  readonly worker_id?: string | undefined;
  readonly correlation_id?: string | undefined;
  readonly causation_id?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly payload_hash?: ContentHash | undefined;
};

/**
 * Présente quand l'état est `failed`. La forme suit l'enveloppe d'erreur structurée de `packages/protocol` (W0.4).
 */
export type AttemptError = {
  readonly category: string;
  readonly message: string;
  readonly retryable?: boolean | undefined;
  readonly retry_after_seconds?: number | undefined;
};

/**
 * Ce qui a réellement été consommé, face à ce que ResourceSpec avait réservé. L'écart est ce que le rapprochement de coûts (§4) exploite.
 */
export type AttemptResourcesObserved = {
  readonly cpu_seconds?: number | undefined;
  readonly memory_peak_mb?: number | undefined;
  readonly disk_peak_mb?: number | undefined;
  readonly wall_time_seconds?: number | undefined;
};

/**
 * Une tentative d'exécution d'une tâche (SPEC_V1 §15.5). Un attempt ne produit jamais directement un état canonique : il soumet des artefacts et un EpistemicCommit. `succeeded` veut dire que le worker a rempli son contrat technique — jamais que ses claims sont validés, et les deux mots restent séparés partout ici.
 */
export type Attempt = {
  readonly protocol: ProtocolVersion;
  readonly task_id: string;
  readonly attempt: number;
  readonly lease_id?: string | undefined;
  readonly worker_id: string;
  readonly agent_id?: string | undefined;
  /**
   * Sous-ensemble des états de tâche de §5 qu'un attempt peut porter côté worker. `accepted`, `rejected` et `superseded` en sont absents exprès : ce sont des verdicts de Locus Solus sur un attempt terminé, pas des états que le worker s'attribue.
   */
  readonly state:
    | "running"
    | "waiting_for_tool"
    | "waiting_for_human"
    | "waiting_for_review"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "orphaned";
  readonly started_at: string;
  readonly completed_at?: string | undefined;
  /**
   * Vrai quand le résultat arrive après l'expiration de la lease. §12.3 : un résultat tardif est stocké en quarantaine et ne peut committer sans arbitrage. Le champ existe pour que le worker puisse le dire lui-même plutôt que de le laisser deviner.
   */
  readonly late?: boolean | undefined;
  /**
   * Présente quand l'état est `failed`. La forme suit l'enveloppe d'erreur structurée de `packages/protocol` (W0.4).
   */
  readonly error?: AttemptError | undefined;
  /**
   * Ce qui a réellement été consommé, face à ce que ResourceSpec avait réservé. L'écart est ce que le rapprochement de coûts (§4) exploite.
   */
  readonly resources_observed?: AttemptResourcesObserved | undefined;
};

/**
 * Le droit, borné dans le temps, d'exécuter un attempt (SPEC_V1 §12.3). Une lease expire ; c'est ce qui distingue un worker en panne d'un worker lent, et ce qui permet à `task.orphaned` d'exister sans qu'on interroge personne.
 *
 * Une contrainte de §12.3 n'est PAS exprimable ici : « le worker envoie un heartbeat à intervalle inférieur au tiers du TTL » est une relation entre deux champs, que Draft 7 ne sait pas énoncer. Elle est vérifiée par le harnais de conformance (W0.9), et le dire ici vaut mieux que laisser croire que le schéma la couvre.
 */
export type Lease = {
  readonly protocol: ProtocolVersion;
  readonly lease_id: string;
  readonly task_id: string;
  /**
   * Rang, pas identifiant : une tâche réattribuée conserve son numéro d'attempt (§12.3). Le compter à partir de 1 rend « attempt 0 » impossible à confondre avec « pas encore tenté ».
   */
  readonly attempt: number;
  readonly worker_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  /**
   * Courte et renouvelable (§12.3). Aucune borne haute ici : c'est une politique de scheduler, pas une propriété du protocole.
   */
  readonly ttl_seconds: number;
  readonly heartbeat_interval_seconds: number;
  readonly renewal_count?: number | undefined;
  /**
   * Les side effects utilisent des clés d'idempotence indépendantes de l'attempt (§12.3) : rejouer un attempt ne doit pas rejouer ses effets.
   */
  readonly idempotency_key?: string | undefined;
};

export type RefsItem = {
  readonly artifact_id: string;
  readonly content_hash?: ContentHash | undefined;
  readonly note?: string | undefined;
};

export type EpistemicCommitClaimsItem = {
  readonly statement: string;
  /**
   * Une claim sans confiance déclarée se lit comme certaine. Obligatoire, donc, et bornée.
   */
  readonly confidence: number;
  readonly evidence_refs?: Refs | undefined;
  readonly assumptions?: readonly string[] | undefined;
};

export type EpistemicCommitObjectionsItem = {
  readonly statement: string;
  readonly targets?: readonly string[] | undefined;
  readonly evidence_refs?: Refs | undefined;
};

export type EpistemicCommitInferencesItem = {
  readonly rule: string;
  readonly inference_kind?: string | undefined;
  readonly premise_refs: readonly string[];
  readonly conclusion_refs: readonly string[];
  readonly assumption_refs?: readonly string[] | undefined;
};

export type EpistemicCommitLocalDecisionsItem = {
  readonly decision: string;
  readonly rationale: string;
};

export type EpistemicCommitNegativeResultsItem = {
  readonly statement: string;
  readonly attempted?: string | undefined;
  readonly evidence_refs?: Refs | undefined;
};

/**
 * Ce qu'un attempt PROPOSE (SPEC_V1 §15.7) : claims, objections, inférences, décisions locales, résultats négatifs, limitations, références d'artefacts et prochaines actions.
 *
 * Il n'a AUCUNE autorité de validation avant traitement par Locus Solus, et le schéma le rend indéfaisable plutôt que de le répéter : `status` ne peut valoir que `draft` ou `staged`. `validated`, `under_review` et le reste du cycle de vie de §7.4 existent, mais ce sont des verdicts que l'institution prononce — un worker qui les écrirait s'auto-validerait, ce qui est exactement l'invariant 3.
 *
 * Un commit ne peut pas contenir de secret (§21.8). Le schéma n'a aucun champ pour en loger un ; le scan, lui, appartient à l'admission.
 */
export type EpistemicCommit = {
  readonly protocol: ProtocolVersion;
  readonly task_id: string;
  readonly attempt: number;
  readonly branch_id?: string | undefined;
  /**
   * Jamais au-delà de `staged` (§2.3). C'est la garantie la plus forte de ce schéma, et la seule que sa violation rende un document littéralement invalide.
   */
  readonly status: "draft" | "staged";
  readonly claims?: readonly EpistemicCommitClaimsItem[] | undefined;
  /**
   * Invariant 12 : les conflits ne sont jamais supprimés pour rendre le graphe propre. Une objection est un contenu de premier plan, pas une note de bas de page.
   */
  readonly objections?: readonly EpistemicCommitObjectionsItem[] | undefined;
  /**
   * Une inférence est un nœud explicite (§7.6), avec ses prémisses et ses hypothèses — pas une flèche implicite entre deux claims.
   */
  readonly inferences?: readonly EpistemicCommitInferencesItem[] | undefined;
  readonly local_decisions?: readonly EpistemicCommitLocalDecisionsItem[] | undefined;
  /**
   * Invariant 12, encore : un résultat négatif est un résultat. Le champ existe pour qu'il ait un endroit où aller, sans quoi il finit dans un commentaire libre et disparaît.
   */
  readonly negative_results?: readonly EpistemicCommitNegativeResultsItem[] | undefined;
  readonly limitations?: readonly string[] | undefined;
  readonly artifact_refs?: Refs | undefined;
  readonly next_actions?: readonly string[] | undefined;
  readonly produced_at: string;
};

/**
 * Ce que le run a constaté. Le hash du snapshot est ce qui prouve la reproduction ; celui de la ressource live, quand il est connu, ne sert qu'à constater l'évolution.
 */
export type RemoteArtifactRefExpected = {
  readonly snapshot_hash: Hash;
  readonly live_hash_at_run?: Hash | undefined;
  readonly captured_at?: string | undefined;
};

/**
 * Comment atteindre la ressource. §19 en nomme cinq et n'en autorise qu'un : deux locators laisseraient au viewer le soin de choisir, donc de choisir différemment d'une fois sur l'autre.
 */
export type RemoteArtifactRefLocator = {
  readonly manifest_url?: string | undefined;
  readonly canvas_id?: string | undefined;
  readonly content_state?: string | undefined;
  readonly annotation_target?: string | undefined;
  readonly local_snapshot?: string | undefined;
};

export type RemoteArtifactRef = {
  /**
   * L'identité canonique de l'artefact côté Locus. §19 exige qu'elle s'affiche séparément de la ressource distante : c'est elle qui ne bouge pas.
   */
  readonly artifact_id: string;
  readonly media_type: string;
  /**
   * Ce que le run a constaté. Le hash du snapshot est ce qui prouve la reproduction ; celui de la ressource live, quand il est connu, ne sert qu'à constater l'évolution.
   */
  readonly expected: RemoteArtifactRefExpected;
  /**
   * Comment atteindre la ressource. §19 en nomme cinq et n'en autorise qu'un : deux locators laisseraient au viewer le soin de choisir, donc de choisir différemment d'une fois sur l'autre.
   */
  readonly locator: RemoteArtifactRefLocator;
  /**
   * Ce que l'artefact suggère, jamais ce qu'il impose : xiiif n'est pas requis par les agents (invariant 10).
   */
  readonly viewer_hint?: "iiif" | "image" | "pdf" | "none" | undefined;
};

export type DeploymentAdaptersItem = {
  readonly role: string;
  readonly implementation: string;
};

export type DeploymentSecretRefsItem = {
  readonly name: string;
  readonly reference: string;
};

export type Deployment = {
  /**
   * Lequel des cinq profils obligatoires de §27.1.
   */
  readonly profile:
    "personal-local" | "personal-node" | "single-node-vm" | "cloud-platform" | "distributed-hybrid";
  /**
   * L'URL Locus à laquelle les clients se connectent. C'est tout ce qu'ils voient de la topologie.
   */
  readonly endpoint: string;
  /**
   * Quel rôle est tenu par quelle implémentation. Une liste plutôt qu'un objet : le domaine refuse un rôle déclaré deux fois, ce qu'un objet JSON rendrait indétectable — le second écraserait le premier en silence.
   */
  readonly adapters: readonly DeploymentAdaptersItem[];
  /**
   * Les limites du déploiement, déclarées plutôt que contournées (§27.1).
   */
  readonly capabilities?: readonly string[] | undefined;
  /**
   * Où trouver un secret, jamais le secret. Le motif refuse une valeur en clair : `hunter2` n'est pas une référence.
   */
  readonly secret_refs?: readonly DeploymentSecretRefsItem[] | undefined;
};

export type ViewNodesItem = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
};

export type ViewEdgesItem = {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
};

export type View = {
  /**
   * Laquelle des huit projections de §23.3.
   */
  readonly kind:
    | "graph_2d"
    | "argument_map"
    | "provenance"
    | "dependencies"
    | "disagreements"
    | "semantic_space"
    | "branch_landscape"
    | "agent_society";
  /**
   * Le point du journal auquel la vue a été prise. Un viewer qui l'ignore ne peut pas dire s'il montre l'état d'aujourd'hui.
   */
  readonly watermark: number;
  /**
   * Le condensat de la vue dont celle-ci est un cadrage ou un filtre. Absent pour une projection ; présent sans exception pour une vue dérivée, y compris quand le filtre n'a rien retiré.
   */
  readonly derived_from?: string | undefined;
  /**
   * Le condensat de la forme canonique. Le consommateur la reconstruit et compare : ce qui prouve ne peut pas être ce qui est demandé.
   */
  readonly digest: string;
  readonly nodes: readonly ViewNodesItem[];
  readonly edges: readonly ViewEdgesItem[];
};

export type HumanReviewFinding = {
  /**
   * Le ReviewDossier auquel ce finding s'attache. §20 : la revue humaine « produit un finding attachable à un ReviewDossier », donc elle en nomme un.
   */
  readonly dossier_id: string;
  /**
   * La révision revue. Le domaine refuse une cible que le dossier ne couvre pas : sans cela une revue humaine élargirait le dossier en silence.
   */
  readonly target: string;
  /**
   * Qui a regardé. Une identité humaine, pas un agent : elle ne passe pas par l'attestation d'indépendance de §17.4, parce que ce n'est pas une revue indépendante.
   */
  readonly reviewer: string;
  /**
   * L'un des quatre de §20, sous son nom. `accept` ne dit pas que la revendication tient : il dit que le relecteur humain n'a pas d'objection, ce qui n'est pas une preuve.
   */
  readonly verdict?: "accept" | "needs-correction" | "wrong-target" | "source-changed" | undefined;
  /**
   * Le commentaire libre, cinquième forme d'enregistrement de §20. Un finding qui ne porte ni verdict ni commentaire ne dit rien, et `anyOf` le refuse.
   */
  readonly comment?: string | undefined;
  /**
   * Les révisions sur lesquelles le relecteur s'appuie. §17.5 : un finding sans preuve concrète est un commentaire non bloquant — la règle vaut pour un humain comme pour un agent, et c'est elle, pas la qualité du relecteur, qui décide si le finding est opposable.
   */
  readonly evidence?: readonly string[] | undefined;
  readonly recorded_at?: string | undefined;
};

/**
 * Pourquoi une mission n'a pas été admise sur un hôte — SPEC_V1 §10.2, ADR 0017 §5.2, tranche 2 du mineur `lep/1.1`. Document **nouveau** : aucune énumération existante ne gagne un membre, ce que l'interdit 3 de l'ADR refuse. Il porte des données et pas seulement des codes — le niveau exigé, le meilleur niveau prouvé, le genre d'accélérateur — donc un membre de plus sur une énumération n'aurait de toute façon pas suffi.
 */
export type AdmissionRefusal = {
  readonly protocol: ProtocolVersion;
  readonly task_id: string;
  readonly attempt_id: string;
  /**
   * **Toutes** les conditions manquantes, jamais la première seule. `admit` les accumule et rend `Refused { reasons }` au pluriel ; un fil qui n'en transmettrait qu'une ferait corriger une condition pour retomber aussitôt sur la suivante, autant de fois qu'il en manque. `minItems: 1` parce qu'un refus sans motif n'est pas un refus.
   */
  readonly reasons: readonly Reason[];
};

/**
 * Les documents qu'un pair peut envoyer ou recevoir, dans l'ordre du registre.
 */
export const LEP_DOCUMENTS = [
  "ArtifactManifest",
  "RunManifest",
  "CapabilityManifest",
  "MissionEnvelope",
  "SandboxAttestation",
  "Event",
  "Attempt",
  "Lease",
  "EpistemicCommit",
  "RemoteArtifactRef",
  "Deployment",
  "View",
  "HumanReviewFinding",
  "AdmissionRefusal",
] as const;

export type LepDocument = (typeof LEP_DOCUMENTS)[number];

/**
 * Les features négociables au handshake. `since` est le mineur qui introduit la feature :
 * un pair plus ancien la refuse au lieu de l'accepter sans savoir la tenir.
 */
export const LEP_FEATURES = {
  /**
   * Le worker sait rendre un résultat après l'expiration de sa lease, et le serveur sait le conserver comme late candidate au lieu de l'écraser. Sans elle, un résultat tardif est perdu — ce qui est une perte de travail, pas une erreur de protocole.
   */
  "late-results": "1.0",
  /**
   * Le worker peut demander une entrée humaine structurée et se suspendre. Facultative parce qu'elle suppose que le backend sache suspendre sans garder un processus coûteux vivant.
   */
  "human-input": "1.0",
  /**
   * Mode pull/queue au lieu du WebSocket de référence, pour les plateformes serverless qui ne peuvent pas tenir une connexion.
   */
  "pull-queue": "1.0",
  /**
   * Les artefacts volumineux transitent par HTTP/object storage plutôt que par le canal de contrôle. Un pair qui ne l'annonce pas reçoit les artefacts en ligne, ce qui borne leur taille.
   */
  "artifact-streaming": "1.0",
  /**
   * Signature des événements : facultative en local, obligatoire en fédération. La négocier permet à un déploiement local de ne pas la payer sans que le code de fédération ait à la redemander.
   */
  "signed-events": "1.0",
} as const;

export type LepFeature = keyof typeof LEP_FEATURES;
