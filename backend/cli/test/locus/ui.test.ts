import { describe, expect, test } from "bun:test"

import { UNKNOWN, leakFindings, render, shortHash } from "../../src/locus/ui/format.ts"
import { inferenceLabel, renderBudget, renderMission, renderModels } from "../../src/locus/ui/mission-view.ts"
import { renderLease, renderWorkerStatus } from "../../src/locus/ui/worker-status.ts"
import { SELF_TESTS, alarms, mark, renderSecurity } from "../../src/locus/ui/security-view.ts"
import { PROTOCOL_VERSION } from "../../src/locus/protocol.ts"
import type { CapabilityManifest, MissionEnvelope, SandboxAttestation } from "../../src/locus/lep/generated.ts"
import type { MeterReport } from "../../src/locus/usage-meter.ts"

const HASH = `sha256:${"ab".repeat(32)}`

const MISSION = {
  protocol: PROTOCOL_VERSION,
  task_id: "task-1",
  attempt_id: "attempt-7",
  branch_id: "branch-1",
  objective: { statement: "mesurer l'écart de rendement", success_conditions: ["écart mesuré à ±2 %"] },
  context_view: { id: "view-1", hash: HASH },
  environment: { environment_id: "env-1", image_digest: HASH, toolchains: ["python-3.12"] },
  sandbox: { minimum_level: "S2", network: "deny" },
  resources: { cpu: 4, memory_mb: 8192, accelerator: { type: "none" } },
  budget: { max_model_calls: 100, max_input_tokens: 1000, max_output_tokens: 1000 },
  confidentiality_ceiling: "internal",
  output_contract: "epistemic-commit/1",
} as unknown as MissionEnvelope

const MANIFEST = {
  protocol: PROTOCOL_VERSION,
  worker_id: "canterel-1",
  worker_kind: "canterel",
  sandbox: { levels: ["S1", "S2"], network_modes: ["deny", "full"] },
  models: [
    { provider: "anthropic", auth: "oauth-local", remote_inference: true, models: ["claude"] },
    { provider: "ollama", auth: "none", remote_inference: false, models: ["llama"] },
  ],
} as unknown as CapabilityManifest

const ATTESTATION = {
  sandbox_id: "box-1",
  backend: "bubblewrap",
  isolation_level: "S2",
  network_mode: "deny",
  host_home_mounted: false,
  runtime_socket_exposed: false,
  limits: { cpu: 4, memory_mb: 8192, pids: 256, disk_mb: 10_240 },
  self_tests: {
    write_outside_workspace: "blocked",
    read_host_home: "blocked",
    network_egress: "blocked",
    memory_limit: "enforced",
  },
  attested_at: "2026-08-16T10:00:00.000Z",
} as unknown as SandboxAttestation

describe("rendu — le test de sortie de W2.18", () => {
  // « Rendu » ne peut pas vouloir dire « la fonction a produit du texte » : ce serait vrai d'une
  // fonction qui rend une chaîne vide. Ce que le rendu doit prouver, c'est qu'il conserve les
  // distinctions que le code a payé cher à établir. Trois propriétés, donc — et chacune est une
  // règle du projet qui vit ou meurt à l'affichage.

  test("les trois vues rendent, et rien n'y sort vide", () => {
    const views = [
      renderMission({ mission: MISSION, attemptState: "running", models: [], budget: undefined }),
      renderWorkerStatus({ connection: "connected", lease: "valid", manifest: MANIFEST }),
      renderSecurity({ attestation: ATTESTATION, quarantined: [] }),
    ]
    for (const lines of views) {
      expect(lines.length).toBeGreaterThan(5)
      // Une ligne `clé : ` sans rien après serait une absence qui se lit comme une valeur.
      for (const line of lines) expect(line.endsWith(" : ")).toBe(false)
    }
  })

  test("l'inférence distante se distingue du calcul local — §23.4", () => {
    // C'est la seule chose que cette vue rend et qu'on ne peut lire nulle part ailleurs : où sont
    // parties les données. Un modèle rendu sans cette mention laisse supposer « c'est resté chez
    // moi », parce que c'est ce qui arrange.
    const rendered = renderModels([
      { provider: "anthropic", models: ["claude"], remote: true },
      { provider: "ollama", models: ["llama"], remote: false },
    ]).join("\n")
    expect(rendered).toContain("inférence distante")
    expect(rendered).toContain("calcul local")
    expect(inferenceLabel({ provider: "x", models: [], remote: true })).toBe("inférence distante")

    // Et la vue du worker porte la même distinction : ce n'est pas le privilège d'un seul écran.
    const status = renderWorkerStatus({ connection: "connected", lease: "valid", manifest: MANIFEST }).join("\n")
    expect(status).toContain("distant")
    expect(status).toContain("local")
  })

  test("`not-run` ne ressemble pas à `blocked` — ADR 0004", () => {
    // « J'ai essayé de sortir et je n'ai pas pu » et « je n'ai pas essayé » sont opposés. Rendus
    // par la même coche, ils feraient croire à une sandbox là où il n'y a qu'une absence de
    // vérification.
    expect(mark("blocked")).not.toBe(mark("not-run"))
    expect(mark("enforced")).not.toBe(mark("not-run"))
    expect(mark("not-run")).toContain("non exécuté")
    expect(mark("allowed")).toContain("AUTORISÉ")

    const degraded = {
      ...ATTESTATION,
      self_tests: { ...ATTESTATION.self_tests, network_egress: "not-run" },
    } as unknown as SandboxAttestation
    const rendered = renderSecurity({ attestation: degraded }).join("\n")
    expect(rendered).toContain("non exécuté")
    // Et ça ne se lit pas seulement dans la ligne du test : ça remonte en alerte.
    expect(rendered).toContain("Alertes")
  })

  test("une valeur inconnue se rend `inconnu`, jamais par un défaut plausible", () => {
    // Un budget non mesuré affiché `0` ne dit pas « rien dépensé » : il dit « rien mesuré », et les
    // deux se ressemblent exactement à l'écran.
    expect(render(undefined)).toBe(UNKNOWN)
    expect(render(null)).toBe(UNKNOWN)
    expect(render("   ")).toBe(UNKNOWN)
    expect(render(Number.NaN)).toBe(UNKNOWN)
    // Mais zéro reste zéro : c'est une mesure.
    expect(render(0)).toBe("0")

    const rendered = renderBudget(undefined).join("\n")
    expect(rendered).toContain(UNKNOWN)
    expect(rendered).not.toContain(" 0")
  })
})

describe("ce qu'une vue ne montre pas — §25.4", () => {
  test("aucune forme de secret ne traverse un rendu", () => {
    // Une vue est de la télémétrie qui s'affiche : ce qui ne doit pas sortir dans un log ne doit
    // pas non plus finir dans une copie d'écran ou un ticket.
    const rendered = [
      ...renderMission({ mission: MISSION, models: [], budget: undefined }),
      ...renderWorkerStatus({
        connection: "connected",
        lease: "unconfirmed",
        manifest: MANIFEST,
        publicKeyHash: HASH,
      }),
      ...renderSecurity({ attestation: ATTESTATION }),
    ].join("\n")
    expect(leakFindings(rendered)).toEqual([])
  })

  test("le filet attrape un secret glissé dans un rendu", () => {
    // Un filet qui n'attrape rien n'est pas un filet : sans ce test, le précédent passerait aussi
    // sur une fonction `leakFindings` qui rendrait toujours la liste vide.
    const bait = `Authorization: ${"Bearer"} ${"x".repeat(40)}`
    expect(leakFindings(bait).length).toBeGreaterThan(0)
  })

  test("un hash s'affiche tronqué mais garde son algorithme", () => {
    // Un digest abrégé sans son algorithme n'identifie plus rien : la troncature est un confort de
    // lecture, pas une permission d'oublier quoi recalculer.
    const short = shortHash(HASH)
    expect(short.startsWith("sha256:")).toBe(true)
    expect(short.length).toBeLessThan(HASH.length)
    expect(shortHash(undefined)).toBe(UNKNOWN)
  })

  test("la vue de mission rend l'empreinte de contexte, pas le contexte", () => {
    const rendered = renderMission({ mission: MISSION, models: [], budget: undefined }).join("\n")
    expect(rendered).toContain("empreinte de vue")
    expect(rendered).toContain("view-1")
    // Le hash complet n'y est pas non plus : ce qui compte est qu'il soit identifiable.
    expect(rendered).not.toContain(HASH)
  })
})

describe("le droit d'exécuter, en toutes lettres — §24.1", () => {
  test("`unconfirmed` ne se rend pas comme « oui »", () => {
    // Le rendre par « lease : oui » parce que l'échéance n'est pas passée redirait à l'écran
    // exactement l'erreur que `recovery.ts` refuse de faire dans le code.
    const rendered = renderLease("unconfirmed")
    expect(rendered).toContain("non reconfirmé")
    expect(rendered).toContain("§24.1")
    expect(rendered).not.toContain("oui")
    expect(renderLease("valid")).toContain("valide")
    expect(renderLease("expired")).toContain("expiré")
    expect(renderLease("none")).toContain("aucun")
  })

  test("une révocation se voit", () => {
    // Une révocation qui ne se voit pas se découvre par un refus incompréhensible.
    const rendered = renderWorkerStatus({ connection: "connected", lease: "valid", revoked: true }).join("\n")
    expect(rendered).toContain("RÉVOQUÉE")
  })

  test("un spool saturé se voit aussi", () => {
    const rendered = renderWorkerStatus({
      connection: "connected",
      lease: "valid",
      spoolUnacked: 10_000,
      spoolSaturated: true,
    }).join("\n")
    expect(rendered).toContain("backpressure")
  })
})

describe("alertes de sécurité — §21.6", () => {
  test("une attestation absente est la plus importante des informations", () => {
    const raised = alarms(undefined)
    expect(raised).toHaveLength(1)
    expect(raised[0]).toContain("rien ne prouve")
    expect(renderSecurity({}).join("\n")).toContain(UNKNOWN)
  })

  test("un home monté ou un socket exposé remontent en alerte", () => {
    // Les deux interdits de la règle de sécurité du dépôt, précisément.
    const bad = {
      ...ATTESTATION,
      host_home_mounted: true,
      runtime_socket_exposed: true,
    } as unknown as SandboxAttestation
    const raised = alarms(bad).join("\n")
    expect(raised).toContain("home de l'utilisateur")
    expect(raised).toContain("socket du runtime")
  })

  test("une attestation propre ne lève rien, et les quatre self-tests sont rendus", () => {
    expect(alarms(ATTESTATION)).toEqual([])
    const rendered = renderSecurity({ attestation: ATTESTATION, quarantined: [] }).join("\n")
    for (const name of SELF_TESTS) expect(rendered).toContain(name)
    expect(rendered).not.toContain("Alertes")
    expect(rendered).toContain("aucun artefact en quarantaine")
  })

  test("une quarantaine dit sa raison", () => {
    const rendered = renderSecurity({
      attestation: ATTESTATION,
      quarantined: [{ id: "artifact-3", reason: "clé AWS détectée" }],
    }).join("\n")
    expect(rendered).toContain("artifact-3")
    expect(rendered).toContain("clé AWS détectée")
  })
})

describe("budget rendu — §17.3", () => {
  test("une divergence est affichée, jamais lissée", () => {
    const report: MeterReport = {
      totals: { cost: 40 },
      stage: "nominal",
      exceeded: [],
      divergences: [{ dimension: "cost", estimated: 10, billed: 40, ratio: 4 }],
    }
    const rendered = renderBudget(report).join("\n")
    expect(rendered).toContain("divergence")
    expect(rendered).toContain("estimé 10")
    expect(rendered).toContain("facturé 40")
  })

  test("`nominal` s'affiche, parce que « tout va bien » n'est pas « je n'ai pas mesuré »", () => {
    const report: MeterReport = { totals: {}, stage: "nominal", exceeded: [], divergences: [] }
    const rendered = renderBudget(report).join("\n")
    expect(rendered).toContain("nominal")
    expect(rendered).toContain("aucune dimension mesurée")
  })
})
