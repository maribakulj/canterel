import { LocusCommitRefused } from "./errors.ts"
import { parseHash } from "./artifact-client.ts"
import { payloadHash } from "./lep/canonical.ts"
import { sign, type Identity } from "./identity.ts"
import type { EpistemicCommit, Lease } from "./lep/generated.ts"
import { isExpired } from "./lease.ts"

/**
 * Le commit épistémique — `SPEC_V1.md` §21, sous la règle de non-contournement de §2.3.
 *
 * Une ligne gouverne le fichier : « Canterel **NE DOIT PAS promouvoir un claim au-delà de
 * `staged`** ». Le schéma épinglé la rend déjà indéfaisable — `status` n'y vaut que `draft` ou
 * `staged` — mais un type ne survit pas à la frontière du processus. Ce qui traverse le fil est
 * du JSON, et du JSON ne porte aucun type. Le refus doit donc exister **à l'exécution**, sous
 * forme d'erreur structurée, et c'est ce que ce module ajoute au-dessus du schéma.
 *
 * Le reste découle. `validated`, `under_review`, `rejected` sont des **verdicts que l'institution
 * prononce** ; un worker qui les écrirait s'auto-validerait, ce qui est l'invariant 3 pris à
 * l'envers. Et §21.5 le dit encore autrement : « le champ `confidence` d'un agent ne remplace
 * jamais la validation Locus Solus » — d'où l'absence de toute fonction qui dérive un statut
 * d'une confiance.
 *
 * Invariant 12 gouverne le second versant : « les résultats négatifs et conflits ne sont jamais
 * supprimés pour rendre le graphe propre ». Objections et résultats négatifs ne s'ajoutent que ;
 * il n'existe ici aucune fonction pour en retirer un.
 */

/** Les deux seuls statuts qu'un worker a le droit d'écrire — le schéma `lep/1.0` n'en connaît pas d'autres. */
export const PROPOSAL_STATUSES = ["draft", "staged"] as const

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

/**
 * Les statuts qui appartiennent à Locus Solus, nommés pour être refusés nommément.
 *
 * Les lister coûte une constante et rend le refus lisible : « `validated` est un verdict de
 * l'institution » se corrige, là où « statut invalide » envoie relire un schéma.
 */
export const LOCUS_ONLY_STATUSES: readonly string[] = [
  "under_review",
  "validated",
  "accepted",
  "merged",
  "promoted",
  "rejected",
  "superseded",
  "canonical",
]

export function isProposalStatus(status: string): status is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(status)
}

/**
 * Refuser tout ce qui dépasse `staged`.
 *
 * Le point d'entrée unique du garde-fou : tout chemin qui pose un statut passe par ici. Une erreur
 * structurée plutôt qu'un `false`, parce qu'un appelant qui ignore un booléen produit un commit
 * promu, alors qu'un appelant qui ignore une exception ne produit rien du tout.
 */
export function assertProposable(status: string): ProposalStatus {
  if (isProposalStatus(status)) return status
  const known = LOCUS_ONLY_STATUSES.includes(status)
  throw new LocusCommitRefused({
    reason: known
      ? `\`${status}\` est un verdict que Locus Solus prononce ; un worker ne promeut pas au-delà de \`staged\` (§2.3)`
      : `statut \`${status}\` inconnu du schéma \`lep/1.0\` : seuls \`draft\` et \`staged\` sont proposables`,
    attempted: status,
  })
}

export type CommitInput = {
  readonly task_id: string
  readonly attempt: number
  readonly branch_id?: string
  readonly status?: string
  readonly claims?: EpistemicCommit["claims"]
  readonly objections?: EpistemicCommit["objections"]
  readonly inferences?: EpistemicCommit["inferences"]
  readonly local_decisions?: EpistemicCommit["local_decisions"]
  readonly negative_results?: EpistemicCommit["negative_results"]
  readonly limitations?: readonly string[]
  readonly artifact_refs?: EpistemicCommit["artifact_refs"]
  readonly next_actions?: readonly string[]
  readonly protocol: string
  readonly produced_at: string
}

/**
 * Construire un commit proposé.
 *
 * `status` par défaut vaut `draft`, pas `staged` : `staged` est ce qu'on soumet, et l'atteindre
 * doit être un geste, pas une valeur par défaut. Toute autre valeur est refusée avant construction
 * — pas nettoyée, pas ramenée à `staged`. Corriger silencieusement un statut interdit apprendrait
 * à l'appelant qu'il peut en demander un.
 */
export function buildCommit(input: CommitInput): EpistemicCommit {
  const status = assertProposable(input.status ?? "draft")
  return {
    protocol: input.protocol,
    task_id: input.task_id,
    attempt: input.attempt,
    ...(input.branch_id === undefined ? {} : { branch_id: input.branch_id }),
    status,
    ...(input.claims === undefined ? {} : { claims: input.claims }),
    ...(input.objections === undefined ? {} : { objections: input.objections }),
    ...(input.inferences === undefined ? {} : { inferences: input.inferences }),
    ...(input.local_decisions === undefined ? {} : { local_decisions: input.local_decisions }),
    ...(input.negative_results === undefined ? {} : { negative_results: input.negative_results }),
    ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
    ...(input.artifact_refs === undefined ? {} : { artifact_refs: input.artifact_refs }),
    ...(input.next_actions === undefined ? {} : { next_actions: input.next_actions }),
    produced_at: input.produced_at,
  } as EpistemicCommit
}

/**
 * Passer un commit de `draft` à `staged`.
 *
 * La seule transition qu'un worker a le droit de faire, et elle ne va que dans ce sens : `staged`
 * est soumis, et revenir à `draft` après coup laisserait croire qu'on peut retirer une proposition
 * déjà partie. Le nom dit ce que c'est — mettre en scène, pas promouvoir.
 */
export function stage(commit: EpistemicCommit): EpistemicCommit {
  if (commit.status === "staged") return commit
  return { ...commit, status: assertProposable("staged") }
}

/**
 * Ajouter des objections et des résultats négatifs.
 *
 * **Additif seulement.** Invariant 12 : « les résultats négatifs et conflits ne sont jamais
 * supprimés pour rendre le graphe propre ». Une fonction qui retirerait une objection serait le
 * moyen exact de le violer, donc elle n'existe pas — et un test vérifie qu'elle n'existe pas, ce
 * qui est la seule façon de garder vraie une phrase que personne ne relit.
 */
export function addFindings(
  commit: EpistemicCommit,
  extra: {
    readonly objections?: EpistemicCommit["objections"]
    readonly negative_results?: EpistemicCommit["negative_results"]
  },
): EpistemicCommit {
  return {
    ...commit,
    objections: [...(commit.objections ?? []), ...(extra.objections ?? [])],
    negative_results: [...(commit.negative_results ?? []), ...(extra.negative_results ?? [])],
  }
}

/** L'état d'un contrôle de §21.4 — même vocabulaire que le scanner d'artefacts. */
export type CheckStatus = "enforced" | "not-applicable" | "skipped"

export type CommitCheck = {
  readonly check: string
  readonly status: CheckStatus
  readonly findings: readonly string[]
  /** Pourquoi le contrôle n'a pas tourné. Obligatoire dès que le statut n'est pas `enforced`. */
  readonly note?: string
}

export type ValidationReport = {
  readonly checks: readonly CommitCheck[]
  readonly findings: readonly string[]
  readonly ok: boolean
  /** Faux dès qu'un contrôle n'a pas tourné : « valide » et « pas entièrement vérifié » diffèrent. */
  readonly complete: boolean
}

/** Ce que §21.4 exige avant soumission, et qui se vérifie sans réseau. */
export type ValidationInput = {
  /** Les artefacts déjà déclarés, par identifiant. Absent = le contrôle de résolution est `skipped`. */
  readonly knownArtifacts?: ReadonlyMap<string, string>
  /** La révision de base sur laquelle porte le commit — §21.4, « base revision incluse ». */
  readonly baseRevision?: string
}

/**
 * La validation locale de §21.4.
 *
 * Rend des constats plutôt que de lever : un commit se corrige mieux avec la liste complète de ce
 * qui cloche qu'une raison à la fois. `submit` lève, lui, et c'est là que le refus devient dur.
 *
 * Chaque contrôle dit son état. Un rapport `ok` avec `complete: false` veut dire « rien trouvé sur
 * ce que j'ai pu regarder » — pas « conforme ». La distinction est la même que pour le scanner
 * d'artefacts, et pour la même raison : un contrôle qui ne tourne pas ressemble à un contrôle qui
 * passe.
 */
export function validateCommit(commit: EpistemicCommit, input: ValidationInput = {}): ValidationReport {
  const checks: CommitCheck[] = []

  // Le statut. Premier, parce que c'est celui de §2.3.
  checks.push({
    check: "status",
    status: "enforced",
    findings: isProposalStatus(commit.status)
      ? []
      : [`statut \`${commit.status}\` : un worker ne propose que \`draft\` ou \`staged\` (§2.3)`],
  })

  // Les champs que le schéma rend obligatoires.
  const required = ["protocol", "task_id", "attempt", "status", "produced_at"] as const
  checks.push({
    check: "required_fields",
    status: "enforced",
    findings: required
      .filter((field) => (commit as unknown as Record<string, unknown>)[field] === undefined)
      .map((field) => `champ \`${field}\` absent`),
  })

  // Les inférences : prémisses ET conclusion. §7.6 en fait un nœud explicite ; une inférence sans
  // prémisse est une conclusion déguisée en raisonnement.
  const inferences = commit.inferences ?? []
  checks.push({
    check: "inferences",
    status: inferences.length === 0 ? "not-applicable" : "enforced",
    note: inferences.length === 0 ? "aucune inférence dans ce commit" : undefined,
    findings: inferences.flatMap((inference, index) => {
      const problems: string[] = []
      if (inference.premise_refs.length === 0) problems.push(`inférence ${index} sans prémisse`)
      if (inference.conclusion_refs.length === 0) problems.push(`inférence ${index} sans conclusion`)
      return problems
    }),
  })

  // Les hashes des références d'artefacts. Un hash nu ou tronqué ne se recalcule pas.
  const refs = commit.artifact_refs ?? []
  checks.push({
    check: "artifact_hashes",
    status: refs.length === 0 ? "not-applicable" : "enforced",
    note: refs.length === 0 ? "aucune référence d'artefact" : undefined,
    findings: refs.flatMap((ref) => {
      // Le hash est facultatif au schéma, obligatoire ici : §21.4 exige des « hashes cohérents »,
      // et une référence par identifiant seul désigne un nom, pas un contenu.
      if (ref.content_hash === undefined) return [`référence \`${ref.artifact_id}\` sans hash de contenu`]
      return parseHash(ref.content_hash) === null
        ? [`référence \`${ref.artifact_id}\` : hash \`${ref.content_hash}\` illisible`]
        : []
    }),
  })

  // La résolution des références. Sans catalogue, le contrôle ne tourne pas — et le dit.
  const known = input.knownArtifacts
  checks.push(
    known === undefined
      ? {
          check: "artifact_resolution",
          status: "skipped",
          note: "aucun catalogue d'artefacts déclarés fourni",
          findings: [],
        }
      : {
          check: "artifact_resolution",
          status: "enforced",
          findings: refs
            .filter((ref) => !known.has(ref.artifact_id))
            .map((ref) => `référence \`${ref.artifact_id}\` non résolue : aucun artefact déclaré sous cet identifiant`),
        },
  )

  // L'unicité des identifiants locaux. Deux objets de même nom rendent les relations ambiguës.
  const ids = refs.map((ref) => ref.artifact_id)
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  checks.push({
    check: "local_uniqueness",
    status: refs.length === 0 ? "not-applicable" : "enforced",
    note: refs.length === 0 ? "aucun objet local" : undefined,
    findings: duplicates.map((id) => `identifiant local \`${id}\` en double`),
  })

  // La révision de base. §21.4 l'exige : sans elle, on ne sait pas sur quoi le commit porte.
  checks.push({
    check: "base_revision",
    status: "enforced",
    findings: input.baseRevision === undefined || input.baseRevision.length === 0 ? ["révision de base absente"] : [],
  })

  // §21.4 « absence de secret ». Le scan appartient à l'admission, pas ici — mais un contrôle
  // qui n'a pas lieu doit se déclarer, sans quoi le commit paraîtrait avoir été fouillé.
  checks.push({
    check: "secrets",
    status: "skipped",
    note: "le scan de secrets appartient à l'admission (§21.8) ; ce module ne le refait pas et ne le suppose pas fait",
    findings: [],
  })

  const findings = checks.flatMap((check) => check.findings)
  return {
    checks,
    findings,
    ok: findings.length === 0,
    complete: checks.every((check) => check.status !== "skipped"),
  }
}

/** Un commit prêt à partir : le document, sa signature, et le marqueur tardif s'il y a lieu. */
export type SignedCommit = {
  readonly commit: EpistemicCommit
  readonly signature: string
  readonly commit_hash: string
  /** §21.6 : présent seulement quand le commit sort après l'échéance du lease. */
  readonly late?: true
}

/**
 * Soumettre : valider, mettre en scène, signer.
 *
 * Le refus est dur ici, contrairement à `validateCommit` : c'est le dernier point où un commit
 * peut encore ne pas partir. Les constats voyagent tous dans l'erreur, parce qu'un commit rendu
 * invalide une raison à la fois se corrige une soumission à la fois.
 *
 * La signature porte sur le **hash canonique** du document, pas sur une sérialisation quelconque :
 * deux pairs conformes n'écrivent pas les mêmes octets pour la même donnée, et signer la sortie
 * d'un sérialiseur ferait échouer la vérification sur rien.
 */
export function submitCommit(
  commit: EpistemicCommit,
  identity: Identity,
  input: ValidationInput & { readonly lease?: Lease; readonly at?: number } = {},
): SignedCommit {
  const staged = stage(commit)
  const report = validateCommit(staged, input)
  if (!report.ok) {
    throw new LocusCommitRefused({
      reason: "la validation locale de §21.4 refuse ce commit",
      findings: [...report.findings],
    })
  }

  const commit_hash = payloadHash(staged)
  const late =
    input.lease !== undefined && isExpired(input.lease, input.at ?? Date.parse(staged.produced_at))
      ? ({ late: true } as const)
      : undefined

  return {
    commit: staged,
    signature: sign(identity, commit_hash),
    commit_hash,
    ...(late ?? {}),
  }
}

/**
 * La charge d'un `epistemic_commit.submitted` — §18.2.
 *
 * Le marqueur tardif y figure. §21.6 : « un commit produit après expiration porte le statut
 * `late` » — sauf que `status` est pris par §2.3 et ne connaît que `draft` et `staged`. Le
 * marqueur vit donc à côté, comme pour un résultat tardif en §11.4. Le taire ferait traiter un
 * commit tardif comme un commit normal, ce qui est exactement le contournement que la quarantaine
 * de §12.3 existe pour empêcher.
 */
export function commitSubmittedPayload(signed: SignedCommit): Record<string, unknown> {
  return {
    commit_hash: signed.commit_hash,
    signature: signed.signature,
    status: signed.commit.status,
    ...(signed.late === undefined ? {} : { late: true }),
    claims: signed.commit.claims?.length ?? 0,
    objections: signed.commit.objections?.length ?? 0,
    negative_results: signed.commit.negative_results?.length ?? 0,
  }
}
