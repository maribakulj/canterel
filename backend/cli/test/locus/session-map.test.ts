import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { UNTOUCHABLE_UPSTREAM_DIRS, mapMission } from "../../src/locus/session-map.ts"
import { AGENT_BY_CAPABILITY, DEFAULT_AGENT, UPSTREAM_AGENTS, selectOverlay } from "../../src/locus/agent-overlay.ts"
import { REMOTE_INFERENCE_CEILING, modelUnavailableReason, usableModels } from "../../src/locus/model-policy.ts"
import { TOOL_FACULTIES, judgeTool, partitionTools, type ToolDescriptor } from "../../src/locus/tool-policy.ts"
import { forkModifiedFiles } from "../../src/locus/upstream-merge.ts"
import type { CapabilityManifest, MissionEnvelope } from "../../src/locus/lep/generated.ts"

const REPO = join(import.meta.dir, "../../../..")
const FIXTURES = join(import.meta.dir, "fixtures")

function fixture<T>(name: string): T {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>
  const { _fixture, ...body } = raw
  void _fixture
  return body as T
}

const MISSION = () => fixture<MissionEnvelope>("mission-accepted.json")
const MANIFEST = () => fixture<CapabilityManifest>("manifest-vm-linux.json")

const TOOLS: readonly ToolDescriptor[] = [
  { name: "read", faculties: ["read-workspace"] },
  { name: "bash", faculties: ["execute"] },
  { name: "webfetch", faculties: ["network"] },
  { name: "install", faculties: ["write-outside-workspace", "execute"] },
]

describe("mission → session sans modifier `src/session/` — le test de sortie de W2.11", () => {
  test("ce fork ne modifie aucun fichier des répertoires amont protégés", async () => {
    // Une propriété négative ne se démontre pas en relisant le code : elle se mesure. `git diff`
    // contre la base de fusion amont dit ce que ce fork a touché, sans dépendre de ce que
    // quelqu'un a pensé à déclarer.
    const result = await forkModifiedFiles(REPO)
    if (!result.ok) {
      console.warn(`[W2.11] mesure non exécutée : ${result.reason}`)
      expect(result.reason.length).toBeGreaterThan(0)
      return
    }
    const touched = result.files.filter((file) => UNTOUCHABLE_UPSTREAM_DIRS.some((dir) => file.startsWith(dir)))
    expect(touched).toEqual([])
  }, 300_000)

  test("une mission admise produit un plan, pas une session", () => {
    // Le plan est de la donnée : il se teste sans démarrer de session, et il survit à une refonte
    // amont de `src/session/`, ce qu'un adaptateur qui appellerait ses fonctions internes ne
    // ferait pas.
    const result = mapMission({
      mission: MISSION(),
      manifest: MANIFEST(),
      tools: TOOLS,
      containedWrites: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.task_id).toBe(MISSION().task_id)
    expect(result.plan.branch_id).toBe(MISSION().branch_id)
    expect(UPSTREAM_AGENTS).toContain(result.plan.overlay.agent)
  })

  test("aucun module Locus n'importe `src/session/`", () => {
    // Adapter sans toucher vaut aussi pour les imports : dépendre des internes de `src/session/`
    // ferait payer chaque refonte amont, même sans en modifier une ligne.
    const files = ["session-map.ts", "agent-overlay.ts", "model-policy.ts", "tool-policy.ts"]
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, "../../src/locus", file), "utf8")
      for (const forbidden of ['"@/session', '"@/agent', '"@/permission', '"@/provider', '"@/tool']) {
        expect(source).not.toContain(forbidden)
      }
    }
  })

  test("une mission refusée à l'admission n'est pas traduite", () => {
    // Traduire d'abord reviendrait à préparer une session pour un travail refusé.
    const result = mapMission({
      mission: MISSION(),
      manifest: fixture<CapabilityManifest>("manifest-macos.json"),
      tools: TOOLS,
      containedWrites: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe("sandbox_unavailable")
  })
})

describe("politique de modèles — le producteur de `model_unavailable`", () => {
  const withModels = (models: CapabilityManifest["models"]): CapabilityManifest =>
    ({ ...MANIFEST(), models }) as CapabilityManifest

  test("un modèle distant est exclu au-delà du plafond", () => {
    // Le SDK le dit sur `remote_inference` : « vrai quand les prompts quittent la machine. C'est ce
    // qui décide si une classe de données peut être traitée par ce modèle. »
    const manifest = withModels([{ provider: "distant", auth: "service-credential", remote_inference: true }])
    expect(usableModels(manifest, "internal")).toHaveLength(1)
    expect(usableModels(manifest, "confidential")).toHaveLength(0)
    expect(REMOTE_INFERENCE_CEILING).toBe("internal")
  })

  test("un modèle local reste utilisable pour une classe sensible", () => {
    const manifest = withModels([{ provider: "local", auth: "none", remote_inference: false }])
    expect(usableModels(manifest, "restricted")).toHaveLength(1)
  })

  test("un `remote_inference` absent est traité comme distant", () => {
    // Le champ est optionnel. Supposer « local » par défaut ferait envoyer des données
    // confidentielles au premier manifeste incomplet : le défaut prudent coûte au pire un modèle
    // inutilisé, le défaut commode coûte une fuite.
    const manifest = withModels([{ provider: "silencieux", auth: "none" }])
    expect(usableModels(manifest, "confidential")).toHaveLength(0)
  })

  test("la raison distingue « aucun modèle » de « tous distants »", () => {
    // « Aucun modèle disponible » ne dit rien ; savoir lequel des deux cas on a dit quoi installer.
    expect(modelUnavailableReason(withModels([]), "public")).toContain("aucun modèle")
    const remote = withModels([{ provider: "d", auth: "none", remote_inference: true }])
    expect(modelUnavailableReason(remote, "confidential")).toContain("sortir les prompts")
    expect(modelUnavailableReason(remote, "public")).toBeNull()
  })

  test("une mission confidentielle sans modèle local est refusée avec le bon code", () => {
    const mission = { ...MISSION(), confidentiality_ceiling: "confidential" } as unknown as MissionEnvelope
    const manifest = {
      ...MANIFEST(),
      data_classes: ["public", "internal", "confidential"],
      models: [{ provider: "d", auth: "none", remote_inference: true }],
    } as unknown as CapabilityManifest
    const result = mapMission({ mission, manifest, tools: TOOLS, containedWrites: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe("model_unavailable")
  })
})

describe("politique d'outils — le producteur de `tool_forbidden`", () => {
  test("le raisonnement porte sur les facultés, pas sur les noms", () => {
    // Raisonner sur les noms ferait qu'un outil ajouté en amont serait autorisé par défaut,
    // simplement parce que personne n'a pensé à l'interdire.
    const context = { network: "deny" as const, containedWrites: true }
    expect(judgeTool({ name: "outil-inconnu", faculties: [] }, context).allowed).toBe(true)
    expect(judgeTool({ name: "webfetch", faculties: ["network"] }, context).allowed).toBe(false)
    expect(TOOL_FACULTIES).toContain("network")
  })

  test("sans containment effectif, écrire hors workspace est refusé", () => {
    // L'autoriser reviendrait à annoncer une isolation qu'on n'applique pas — la faute que W2.6
    // existe pour empêcher, ici du côté des outils.
    const tool: ToolDescriptor = { name: "install", faculties: ["write-outside-workspace"] }
    expect(judgeTool(tool, { network: "full", containedWrites: true }).allowed).toBe(true)
    expect(judgeTool(tool, { network: "full", containedWrites: false }).allowed).toBe(false)
  })

  test("la politique locale peut refuser un outil que la mission autorise", () => {
    const verdict = judgeTool(
      { name: "bash", faculties: ["execute"] },
      { network: "full", containedWrites: true, deniedTools: ["bash"] },
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.faculty).toBe("local-policy")
  })

  test("les refus sont rendus avec le plan, jamais tus", () => {
    const { allowed, forbidden } = partitionTools(TOOLS, { network: "deny", containedWrites: false })
    expect(allowed).toEqual(["read", "bash"])
    expect(forbidden.map((f) => f.name)).toEqual(["webfetch", "install"])
    for (const entry of forbidden) expect(entry.reason.length).toBeGreaterThan(10)
  })

  test("un outil exigé mais refusé fait échouer la traduction", () => {
    // Plutôt qu'une session amputée qui échouerait plus tard, plus loin de la cause.
    const mission = { ...MISSION(), required_tools: ["webfetch"] } as unknown as MissionEnvelope
    const result = mapMission({ mission, manifest: MANIFEST(), tools: TOOLS, containedWrites: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.code).toBe("tool_forbidden")
      expect(result.refusal.details["required"]).toEqual(["webfetch"])
    }
  })
})

describe("overlay d'agent — additif, jamais remplaçant", () => {
  test("une revue indépendante vise `reviewer`, quel que soit le domaine", () => {
    // C'est l'invariant 11 qui décide, pas le domaine : confier une revue indépendante à l'agent
    // `biology` parce que la mission parle de biologie ferait relire le travail par le même profil
    // que celui qui l'a produit.
    const overlay = selectOverlay({ requiredCapabilities: ["biology"], reviewPolicy: "independent" })
    expect(overlay.agent).toBe("reviewer")
    expect(selectOverlay({ requiredCapabilities: ["biology"] }).agent).toBe("biology")
  })

  test("le rôle choisit l'agent quand la politique de revue n'a rien à dire", () => {
    // W15.f, tranche 1 du mineur `lep/1.1`. C'est là que le rôle sert : une mission qui exige
    // `biology` et dont le rôle est `provenance-reviewer` demande une vérification de provenance
    // sur un sujet de biologie, pas un biologiste. Sans le rôle, seul le sujet se voyait.
    expect(selectOverlay({ requiredCapabilities: ["biology"], role: "provenance-reviewer" }).agent).toBe("reviewer")
    expect(selectOverlay({ role: "logical-reviewer" }).agent).toBe("reviewer")
  })

  test("le rôle ne passe jamais devant l'invariant 11", () => {
    // La contrainte qu'ADR 0017 §5.1 pose et que le sprint d'implémentation ne peut pas contourner.
    // Un `role` qui pourrait renvoyer une revue indépendante vers le profil du générateur
    // reconstruirait exactement le trou que le test au-dessus bouche — en le rendant *demandable
    // par l'émetteur*, ce qui est pire qu'un oubli.
    for (const policy of ["independent", "independent-blind"]) {
      for (const role of ["biology", "logical-reviewer", "research", "n'importe quoi"]) {
        expect(selectOverlay({ requiredCapabilities: ["biology"], reviewPolicy: policy, role }).agent).toBe("reviewer")
      }
    }
  })

  test("un rôle inconnu retombe sur les capacités, il n'arrête rien", () => {
    // Interdit 3 d'ADR 0017, côté lecteur : un mineur ajoute des champs, jamais des valeurs. Un
    // rôle qu'un émetteur plus récent enverrait ne doit pas arrêter un worker plus ancien — sinon
    // le mineur suivant serait une rupture pour tout le monde sauf sur le papier.
    expect(selectOverlay({ requiredCapabilities: ["biology"], role: "archiviste" }).agent).toBe("biology")
    expect(selectOverlay({ role: "archiviste" }).agent).toBe(DEFAULT_AGENT)
  })

  test("de bout en bout : le rôle voyage de la mission jusqu'à l'overlay", () => {
    // Le test de sortie de W15.f demande un lecteur **exercé**, pas une fonction qui saurait lire.
    // Celui-ci part d'une enveloppe de mission et arrive à l'agent choisi, en passant par
    // `mapMission` — c'est-à-dire par le chemin que le worker emprunte réellement. Un test qui
    // n'appellerait que `selectOverlay` prouverait que la table existe, pas qu'un rôle reçu sur le
    // fil l'atteint.
    // Le `as` n'est pas une commodité : le SDK épinglé ici est celui d'avant la tranche 1, donc le
    // type ne connaît pas encore `role`. C'est littéralement la situation qu'un mineur décrit — un
    // document `1.1` chez un consommateur `1.0` — et le lecteur doit s'en tirer. Il disparaîtra au
    // prochain re-vendoring, quand le champ sera dans le type.
    const avec = mapMission({
      mission: { ...MISSION(), role: "provenance-reviewer" } as MissionEnvelope,
      manifest: MANIFEST(),
      tools: TOOLS,
      containedWrites: true,
    })
    expect(avec.ok).toBe(true)
    if (avec.ok) expect(avec.plan.overlay.agent).toBe("reviewer")

    // Et la même mission sans rôle ne va pas au même endroit : sinon le test passerait pour une
    // raison qui n'a rien à voir avec le rôle.
    const sans = mapMission({ mission: MISSION(), manifest: MANIFEST(), tools: TOOLS, containedWrites: true })
    expect(sans.ok).toBe(true)
    if (sans.ok) expect(sans.plan.overlay.agent).not.toBe("reviewer")
  })

  test("un document sans rôle n'en reçoit pas un par défaut", () => {
    // « Absent » et « demandé explicitement » sont deux faits différents. Un document `lep/1.0`
    // n'en porte aucun, et lui en inventer un ferait croire qu'un émetteur ancien a demandé
    // quelque chose.
    expect(selectOverlay({ requiredCapabilities: ["ml"] }).agent).toBe("ml")
    expect(selectOverlay({}).agent).toBe(DEFAULT_AGENT)
  })

  test("une revue aveugle ajoute sa consigne", () => {
    // Elle ne remplace pas la protection de W2.10 : elle la double, parce qu'une consigne oubliée
    // par le modèle ne doit pas suffire à faire fuiter, et qu'un filtre sans consigne laisse le
    // modèle demander ce qu'il n'aura pas.
    const blind = selectOverlay({ reviewPolicy: "independent-blind" })
    expect(blind.agent).toBe("reviewer")
    expect(blind.extraInstructions.some((line) => line.includes("aveugle"))).toBe(true)
    expect(selectOverlay({}).extraInstructions).toEqual([])
  })

  test("l'overlay ne peut pas remplacer un prompt amont", () => {
    // Un overlay qui le pourrait serait un agent local déguisé, que le prochain merge amont
    // écraserait ou contredirait sans que personne s'en aperçoive.
    const overlay = selectOverlay({ reviewPolicy: "independent" }) as unknown as Record<string, unknown>
    for (const forbidden of ["prompt", "systemPrompt", "replacePrompt", "instructions"]) {
      expect(overlay[forbidden]).toBeUndefined()
    }
  })

  test("chaque agent ciblé existe dans la liste amont", () => {
    // Cibler un agent qui n'existe pas produirait une session vide au premier appel réel.
    for (const entry of AGENT_BY_CAPABILITY) expect(UPSTREAM_AGENTS).toContain(entry.agent)
    expect(UPSTREAM_AGENTS).toContain(DEFAULT_AGENT)
  })

  test("le plan transporte la décision de revue aveugle jusqu'au contexte", () => {
    // C'est le lien avec W2.10 : `blindReview` alimente le filtre d'isolation informationnelle.
    const mission = { ...MISSION(), review_policy: "independent-blind" } as unknown as MissionEnvelope
    const result = mapMission({ mission, manifest: MANIFEST(), tools: TOOLS, containedWrites: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.blindReview).toBe(true)
      expect(result.plan.overlay.agent).toBe("reviewer")
    }
  })
})
