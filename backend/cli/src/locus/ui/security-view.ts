import { UNKNOWN, bullet, field, section, shortHash } from "./format.ts"
import type { SandboxAttestation } from "../lep/generated.ts"

/**
 * La vue de sécurité — `SPEC_V1.md` §21.6 et ADR 0004.
 *
 * ADR 0004 fait des self-tests la **définition opérationnelle** du mot « sandbox » : sans eux,
 * l'attestation n'est qu'une déclaration d'intention. Cette vue est l'endroit où cette définition
 * devient lisible, et elle a une seule chose à ne pas faire — laisser un `not-run` ressembler à un
 * `blocked`.
 *
 * Les deux mots disent des choses opposées. `blocked` veut dire « j'ai essayé de sortir et je n'ai
 * pas pu » ; `not-run` veut dire « je n'ai pas essayé ». Rendus l'un comme l'autre par une coche
 * verte, ils feraient croire à une sandbox là où il n'y a qu'une absence de vérification. La vue
 * les rend donc avec des marques distinctes, et compte séparément ce qui n'a pas été exécuté.
 */

/** Les marques de rendu. Trois signes pour trois états, et aucun signe partagé. */
export const MARKS: Readonly<Record<string, string>> = {
  blocked: "✔ bloqué",
  allowed: "✘ AUTORISÉ",
  enforced: "✔ appliqué",
  unenforced: "✘ NON APPLIQUÉ",
  "not-run": "? non exécuté",
}

export function mark(result: string | undefined): string {
  if (result === undefined) return `? ${UNKNOWN}`
  return MARKS[result] ?? `? ${result}`
}

export type SecurityViewInput = {
  readonly attestation?: SandboxAttestation
  /** Les artefacts mis en quarantaine et leur raison — §19.5. */
  readonly quarantined?: readonly { readonly id: string; readonly reason: string }[]
  readonly revoked?: boolean
}

/** Les quatre self-tests d'ADR 0004, dans l'ordre du schéma. */
export const SELF_TESTS = ["write_outside_workspace", "read_host_home", "network_egress", "memory_limit"] as const

/**
 * Ce que la vue doit crier plutôt qu'afficher.
 *
 * Trois conditions, et chacune est un refus d'admission ailleurs dans le code : un self-test qui
 * n'a pas tourné, une contention qui a laissé passer, un montage du home ou du socket de runtime.
 * Les rendre au milieu des autres lignes les ferait lire au même rythme que le reste.
 */
export function alarms(attestation: SandboxAttestation | undefined): readonly string[] {
  if (attestation === undefined) return ["aucune attestation de sandbox : rien ne prouve qu'une sandbox existe"]
  const out: string[] = []
  const tests = attestation.self_tests as unknown as Record<string, string> | undefined

  for (const name of SELF_TESTS) {
    const result = tests?.[name]
    if (result === undefined || result === "not-run") {
      out.push(`self-test \`${name}\` non exécuté : « je ne l'ai pas lancé » n'est pas « il a réussi » (ADR 0004)`)
      continue
    }
    if (result === "allowed" || result === "unenforced") {
      out.push(`self-test \`${name}\` : ${result} — la contention n'a pas tenu`)
    }
  }
  if (attestation.host_home_mounted) out.push("le home de l'utilisateur est monté dans la sandbox")
  if (attestation.runtime_socket_exposed) out.push("le socket du runtime de containers est exposé dans la sandbox")
  return out
}

export function renderSecurity(input: SecurityViewInput): readonly string[] {
  const lines: string[] = []
  const attestation = input.attestation

  lines.push(...section("Sandbox attestée"))
  if (attestation === undefined) {
    // Pas de section vide : l'absence d'attestation est une information, et c'est la plus
    // importante que cette vue puisse porter.
    lines.push(bullet(`attestation : ${UNKNOWN} — rien ne prouve qu'une sandbox a été appliquée`))
  } else {
    lines.push(field("identifiant", attestation.sandbox_id))
    lines.push(field("backend", attestation.backend))
    lines.push(field("niveau d'isolation", attestation.isolation_level))
    lines.push(field("mode réseau", attestation.network_mode))
    lines.push(field("image", shortHash(attestation.image_digest)))
    lines.push(field("rootless", attestation.rootless))
    lines.push(field("rootfs en lecture seule", attestation.read_only_rootfs))
    // Ces deux-là s'affichent même quand la réponse est « non » : un champ absent se lit « je n'ai
    // pas regardé » aussi bien que « non », et seul l'un des deux est une attestation.
    lines.push(field("home utilisateur monté", attestation.host_home_mounted))
    lines.push(field("socket de runtime exposé", attestation.runtime_socket_exposed))
    lines.push(field("attestée le", attestation.attested_at))
    lines.push(field("signature", attestation.signature === undefined ? undefined : "présente"))

    lines.push("")
    lines.push(...section("Self-tests (ADR 0004)"))
    const tests = attestation.self_tests as unknown as Record<string, string> | undefined
    for (const name of SELF_TESTS) lines.push(bullet(`${name} : ${mark(tests?.[name])}`))

    lines.push("")
    lines.push(...section("Limites"))
    const limits = attestation.limits as unknown as Record<string, unknown> | undefined
    for (const name of ["cpu", "memory_mb", "pids", "disk_mb"] as const) {
      lines.push(field(name, limits?.[name]))
    }
  }

  lines.push("")
  lines.push(...section("Quarantaine"))
  const entries = input.quarantined
  if (entries === undefined) lines.push(bullet(`quarantaine : ${UNKNOWN}`))
  else if (entries.length === 0) lines.push(bullet("aucun artefact en quarantaine"))
  else for (const entry of entries) lines.push(bullet(`${entry.id} — ${entry.reason}`))

  const raised = alarms(attestation)
  if (raised.length > 0 || input.revoked === true) {
    lines.push("")
    lines.push(...section("⚠ Alertes"))
    if (input.revoked === true) lines.push(bullet("identité révoquée (§7.5)"))
    for (const alarm of raised) lines.push(bullet(alarm))
  }

  return lines
}
