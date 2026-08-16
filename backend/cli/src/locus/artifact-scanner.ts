import type { DataClass } from "./lep/generated.ts"

/**
 * Scan et quarantaine — `SPEC_V1.md` §19.5.
 *
 * Six familles à chercher : secrets, chemins absolus sensibles, malware selon les outils
 * disponibles, données interdites, archives dangereuses, formats incohérents.
 *
 * Deux phrases gouvernent le fichier.
 *
 * La première est de §19.5 : « un échec ne supprime pas la preuve : l'artefact est mis en
 * quarantaine avec raison ». Il n'existe donc **aucune** fonction qui efface un artefact ici. La
 * quarantaine est un verdict et une raison, pas une suppression — un scanner qui détruit ce qu'il
 * n'aime pas détruit aussi la seule pièce qui permettrait de dire qu'il s'est trompé.
 *
 * La seconde est la règle « jamais silencieux » du projet : « malware **selon outils
 * disponibles** » veut dire qu'il y a des machines où ce contrôle ne tourne pas. Une passe qui
 * n'a pas eu lieu doit se distinguer d'une passe qui n'a rien trouvé, sans quoi un artefact non
 * scanné ressemble en tout point à un artefact propre. Chaque contrôle rend donc son état —
 * `enforced`, `not-applicable`, `skipped` — à côté de ses constats.
 */

/** Les six familles de §19.5, dans l'ordre du texte. */
export const SCAN_CHECKS = [
  "secrets",
  "sensitive_paths",
  "malware",
  "forbidden_data",
  "dangerous_archive",
  "format_mismatch",
] as const

export type ScanCheck = (typeof SCAN_CHECKS)[number]

/**
 * L'état d'un contrôle, indépendamment de ce qu'il a trouvé.
 *
 * `skipped` est la valeur qui compte : c'est elle qui empêche « je n'ai pas pu regarder » de se
 * lire comme « je n'ai rien vu ».
 */
export type CheckStatus = "enforced" | "not-applicable" | "skipped"

export type ScanFinding = {
  readonly check: ScanCheck
  readonly reason: string
  /** Où, quand c'est situable. Jamais le contenu trouvé — voir `redact`. */
  readonly where?: string
}

export type CheckOutcome = {
  readonly check: ScanCheck
  readonly status: CheckStatus
  /** Pourquoi le contrôle n'a pas tourné. Obligatoire dès que le statut n'est pas `enforced`. */
  readonly note?: string
}

export type ScanReport = {
  readonly outcomes: readonly CheckOutcome[]
  readonly findings: readonly ScanFinding[]
  /** `quarantined` dès qu'un constat existe — §19.5, la preuve reste. */
  readonly verdict: "clean" | "quarantined"
  /**
   * Vrai quand au moins un contrôle n'a pas tourné. Un artefact `clean` avec `complete: false`
   * n'est pas un artefact propre : c'est un artefact partiellement regardé, et l'appelant a le
   * droit de le savoir.
   */
  readonly complete: boolean
}

/** Ce que le scanner sait faire faire à la machine hôte. Injecté : rien n'est supposé présent. */
export type ScannerTools = {
  /**
   * Le scan antimalware, quand il existe. Absent veut dire absent — le contrôle sera `skipped`,
   * jamais `enforced` à vide.
   */
  readonly malware?: (bytes: Uint8Array) => readonly string[]
}

export type ScanInput = {
  readonly bytes: Uint8Array
  readonly media_type: string
  readonly filename?: string
  /** La classification déclarée. `forbidden_data` la compare à ce que la mission autorise. */
  readonly classification: DataClass
  /** Les classes que la mission autorise à sortir. Absente = aucune restriction connue. */
  readonly allowed_classes?: readonly DataClass[]
  readonly tools?: ScannerTools
}

/**
 * Les motifs de secrets.
 *
 * Volontairement courts et spécifiques : une regex large sur « key » ou « token » ferait crier le
 * scanner sur chaque fichier de code, et un scanner qui crie tout le temps finit désactivé. Les
 * formes retenues sont celles qui ne ressemblent à rien d'autre qu'à un secret.
 */
const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "clé privée PEM", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: "token d'API porteur", pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/ },
  { label: "clé AWS", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "token GitHub", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { label: "URL avec identifiants", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/ },
]

/**
 * Les chemins absolus qui trahissent la machine du développeur.
 *
 * §19.5 parle de « chemins absolus **sensibles** » : ce n'est pas tout chemin absolu. `/usr/bin`
 * dans un log est normal ; `/home/marcel/.ssh` dans un artefact publié ne l'est pas, et
 * `aucune dépendance implicite à une machine de développeur` est une règle du dépôt.
 */
const SENSITIVE_PATH_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "home utilisateur", pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+\// },
  { label: "répertoire de clés", pattern: /(?:^|[\s"'])(?:\/[^\s"']*)?\.ssh\// },
  { label: "trousseau ou secrets", pattern: /\/(?:run\/secrets|etc\/shadow|var\/run\/secrets)\b/ },
  { label: "socket de runtime de containers", pattern: /\/(?:var\/run\/)?(?:docker|podman)\.sock\b/ },
]

/** Les signatures de format, pour le contrôle `format_mismatch`. */
const MAGIC: readonly { readonly media_type: RegExp; readonly magic: readonly number[] }[] = [
  { media_type: /^image\/png$/, magic: [0x89, 0x50, 0x4e, 0x47] },
  { media_type: /^image\/jpeg$/, magic: [0xff, 0xd8, 0xff] },
  { media_type: /^application\/pdf$/, magic: [0x25, 0x50, 0x44, 0x46] },
  { media_type: /^application\/zip$/, magic: [0x50, 0x4b, 0x03, 0x04] },
  { media_type: /^application\/gzip$/, magic: [0x1f, 0x8b] },
]

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const GZIP_MAGIC = [0x1f, 0x8b]

/**
 * Le rapport d'expansion d'une archive au-delà duquel elle est suspecte.
 *
 * C'est une **politique**, pas une lecture de la spec : §19.5 dit « archives dangereuses » sans
 * chiffrer. La valeur vit ici pour être discutée d'un seul endroit.
 */
export const MAX_ARCHIVE_EXPANSION_RATIO = 200

/**
 * Scanner un artefact.
 *
 * L'ordre des contrôles suit §19.5. Aucun ne court-circuite les autres : un secret trouvé ne
 * dispense pas de regarder le format, parce que le rapport sert à décider quoi corriger, pas
 * seulement à dire non.
 */
export function scanArtifact(input: ScanInput): ScanReport {
  const outcomes: CheckOutcome[] = []
  const findings: ScanFinding[] = []
  const text = decodeText(input.bytes)

  // 1. Secrets. Sur la vue texte : un binaire n'a pas de secret lisible par regexp, et prétendre
  //    l'avoir cherché serait la fausse assurance que ce module existe pour éviter.
  if (text === null) {
    outcomes.push({ check: "secrets", status: "not-applicable", note: "contenu non textuel" })
  } else {
    outcomes.push({ check: "secrets", status: "enforced" })
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) findings.push({ check: "secrets", reason: `${label} détecté` })
    }
  }

  // 2. Chemins absolus sensibles.
  if (text === null) {
    outcomes.push({ check: "sensitive_paths", status: "not-applicable", note: "contenu non textuel" })
  } else {
    outcomes.push({ check: "sensitive_paths", status: "enforced" })
    for (const { label, pattern } of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(text)) findings.push({ check: "sensitive_paths", reason: `chemin sensible : ${label}` })
    }
  }

  // 3. Malware, « selon outils disponibles ».
  const malware = input.tools?.malware
  if (malware === undefined) {
    outcomes.push({
      check: "malware",
      status: "skipped",
      note: "aucun outil antimalware disponible sur cet hôte (§19.5)",
    })
  } else {
    outcomes.push({ check: "malware", status: "enforced" })
    for (const reason of malware(input.bytes)) findings.push({ check: "malware", reason })
  }

  // 4. Données interdites : la classification déclarée sort-elle de ce que la mission autorise.
  if (input.allowed_classes === undefined) {
    outcomes.push({
      check: "forbidden_data",
      status: "skipped",
      note: "la mission n'a pas déclaré de classes autorisées",
    })
  } else {
    outcomes.push({ check: "forbidden_data", status: "enforced" })
    if (!input.allowed_classes.includes(input.classification)) {
      findings.push({
        check: "forbidden_data",
        reason: `classification \`${input.classification}\` hors des classes autorisées (${input.allowed_classes.join(", ")})`,
      })
    }
  }

  // 5. Archives dangereuses.
  outcomes.push(...archiveOutcome(input, findings))

  // 6. Format incohérent avec le media type déclaré.
  outcomes.push(...formatOutcome(input, findings))

  return {
    outcomes,
    findings,
    verdict: findings.length > 0 ? "quarantined" : "clean",
    complete: outcomes.every((outcome) => outcome.status !== "skipped"),
  }
}

/**
 * Les archives.
 *
 * Ce module **n'extrait pas** : décompresser pour inspecter, c'est exécuter la bombe qu'on cherche.
 * Il lit l'en-tête gzip, qui déclare la taille non compressée, et compare. Une archive zip ne
 * porte pas cette information dans ses quatre premiers octets, donc le contrôle se déclare
 * `skipped` pour elle plutôt que de la déclarer saine.
 */
function archiveOutcome(input: ScanInput, findings: ScanFinding[]): readonly CheckOutcome[] {
  const bytes = input.bytes
  if (startsWith(bytes, GZIP_MAGIC)) {
    if (bytes.length < 4) {
      return [{ check: "dangerous_archive", status: "skipped", note: "en-tête gzip tronqué" }]
    }
    // Les quatre derniers octets d'un membre gzip portent la taille non compressée modulo 2^32.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const declared = view.getUint32(bytes.length - 4, true)
    const ratio = declared / Math.max(bytes.length, 1)
    if (ratio > MAX_ARCHIVE_EXPANSION_RATIO) {
      findings.push({
        check: "dangerous_archive",
        reason: `expansion déclarée ×${Math.round(ratio)} au-delà de ×${MAX_ARCHIVE_EXPANSION_RATIO}`,
      })
    }
    return [{ check: "dangerous_archive", status: "enforced" }]
  }
  if (startsWith(bytes, ZIP_MAGIC)) {
    return [
      {
        check: "dangerous_archive",
        status: "skipped",
        note: "zip : l'expansion ne se lit pas sans parcourir le répertoire central, et extraire pour vérifier serait exécuter la bombe",
      },
    ]
  }
  return [{ check: "dangerous_archive", status: "not-applicable", note: "pas une archive connue" }]
}

/**
 * Le format déclaré contre les octets.
 *
 * Le media type décide du viewer et du traitement ; un `image/png` qui est en réalité une archive
 * fait ouvrir la mauvaise chose par le bon outil.
 */
function formatOutcome(input: ScanInput, findings: ScanFinding[]): readonly CheckOutcome[] {
  const entry = MAGIC.find(({ media_type }) => media_type.test(input.media_type))
  if (entry === undefined) {
    return [
      {
        check: "format_mismatch",
        status: "skipped",
        note: `aucune signature connue pour \`${input.media_type}\``,
      },
    ]
  }
  if (!startsWith(input.bytes, entry.magic)) {
    findings.push({
      check: "format_mismatch",
      reason: `les octets ne correspondent pas au media type déclaré \`${input.media_type}\``,
    })
  }
  return [{ check: "format_mismatch", status: "enforced" }]
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

/**
 * La vue texte d'un contenu, ou `null` s'il n'en a pas.
 *
 * Un octet nul suffit à trancher : les formats textuels n'en contiennent pas, et décoder un binaire
 * en UTF-8 produirait un texte de remplacement où les motifs de secrets ne veulent plus rien dire.
 * Seul le début est examiné — un artefact peut peser des gigaoctets, et le scanner ne doit pas
 * devenir la raison pour laquelle on ne scanne pas.
 */
export const TEXT_SNIFF_BYTES = 4 * 1024 * 1024

function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, Math.min(bytes.length, TEXT_SNIFF_BYTES))
  if (head.includes(0)) return null
  return new TextDecoder("utf-8", { fatal: false }).decode(head)
}

/**
 * La raison de quarantaine, en une phrase lisible.
 *
 * Les constats **et** les contrôles manquants y figurent : mettre en quarantaine sans dire ce qui
 * n'a pas pu être vérifié laisserait croire que la liste des problèmes est complète.
 */
export function quarantineReason(report: ScanReport): string {
  const constats = report.findings.map((finding) => finding.reason)
  const skipped = report.outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.check)
  const tail = skipped.length > 0 ? ` ; contrôles non exécutés : ${skipped.join(", ")}` : ""
  return `${constats.join(" ; ")}${tail}`
}
