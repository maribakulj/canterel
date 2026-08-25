import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Checkpoint } from "../../src/locus/resume-store.ts"
import type { ToolDescriptor } from "../../src/locus/tool-policy.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"
import type { SessionPlan } from "../../src/locus/session-map.ts"
import {
  advance,
  describeOutcome,
  PHASES,
  REFUSAL_PATH,
  RUN_PATH,
  runLoop,
  type LoopOutcome,
  type Offer,
  type SessionReport,
  type WorkerPorts,
} from "../../src/locus/worker-loop.ts"
import { canTransition } from "../../src/locus/attempt.ts"
import { LocusAttemptPathBroken } from "../../src/locus/errors.ts"
import { sessionOpener, sessionTitle } from "../../src/locus/session-open.ts"

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
]

function lease(mission: MissionEnvelope, attempt: number): Lease {
  return {
    protocol: mission.protocol,
    lease_id: "lease-1",
    task_id: mission.task_id,
    attempt,
    worker_id: "worker-1",
    issued_at: "2026-08-24T12:00:00.000Z",
    expires_at: "2026-08-24T12:05:00.000Z",
    heartbeat_interval_seconds: 30,
    ttl_seconds: 300,
  }
}

/** Ce que la session amont a rendu — des données, comme la couture l'exige. */
function report(sessionId: string): SessionReport {
  return {
    sessionId,
    events: [],
    output: { summary: "fait" },
  }
}

/** Un jeu de ports complet, dont chaque test ne remplace que ce qu'il éprouve. */
function ports(over: Partial<WorkerPorts> = {}): WorkerPorts & { seen: { plans: SessionPlan[]; saved: Checkpoint[] } } {
  const seen = { plans: [] as SessionPlan[], saved: [] as Checkpoint[] }
  const mission = MISSION()
  const base: WorkerPorts = {
    now: () => 1_756_000_000_000,
    claim: async () => ({ mission, lease: lease(mission, 3) }) satisfies Offer,
    manifest: () => MANIFEST(),
    tools: () => TOOLS,
    openSession: async (plan) => {
      seen.plans.push(plan)
      return report("ses_01")
    },
    emit: async () => {},
    report: async () => {},
    checkpoint: async (checkpoint) => {
      seen.saved.push(checkpoint)
    },
    resume: async () => null,
  }
  return { ...base, ...over, seen }
}

describe("la boucle du worker — le test de sortie de W2.20", () => {
  /**
   * **`runLoop` ne rend plus `inert` : elle traverse la chaîne.**
   *
   * Les étapes sont une **valeur** et non un journal. Un tour qui n'aurait laissé qu'un log serait
   * indiscernable d'un tour qui n'a rien fait — c'est le remède que `W22.c` a posé pour `main.rs`
   * de `locus-execd`.
   */
  test("un tour complet traverse les cinq étapes et rend ce qu'il a fait", async () => {
    const verdict = await runLoop(ports())

    expect(verdict.status).toBe("ran")
    if (verdict.status !== "ran") return
    expect(verdict.phases).toEqual([...PHASES])
    expect(verdict.sessionId).toBe("ses_01")
    expect(verdict.state).toBe("completed")
    expect(verdict.resumed).toBe(false)
  })

  /**
   * **Rien à faire n'est pas une panne, et un refus d'admission n'est pas « rien à faire ».**
   *
   * Les trois issues envoient chercher à trois endroits : un ordonnanceur qui n'a pas de travail, un
   * hôte incapable, un travail exécuté. Les fondre ferait lire « rien à faire » sur un refus.
   */
  test("l'absence d'offre et le refus d'admission sont deux issues distinctes", async () => {
    const rien = await runLoop(ports({ claim: async () => null }))
    expect(rien.status).toBe("idle")

    // La **paire** de refus de `W0.7`, plutôt qu'un manifeste bricolé pour l'occasion : une mission
    // qui exige `S3` contre un hôte macOS qui ne prouve que `S1`/`S2`. La fixture porte cette
    // intention dans son propre champ `_fixture`, et employer la mission sans son manifeste — ce
    // qu'une première rédaction a fait — la rend simplement acceptable.
    const mission = fixture<MissionEnvelope>("mission-refused.json")
    const refuse = await runLoop(
      ports({
        claim: async () => ({ mission, lease: lease(mission, 1) }),
        manifest: () => fixture<CapabilityManifest>("manifest-macos.json"),
      }),
    )
    expect(refuse.status).toBe("refused")
    if (refuse.status !== "refused") return
    expect(refuse.state).toBe("rejected")
    expect(refuse.phases).toEqual(["claim"])
    expect(refuse.refusal.code.length).toBeGreaterThan(0)
  })

  /**
   * **Aucun handle ne traverse la couture** — ADR 0010.
   *
   * Le plan part et le compte rendu revient ; les deux doivent survivre à un aller-retour JSON. Un
   * objet vivant — une fonction, une classe, une promesse — ne survivrait pas, et c'est exactement
   * ce qu'on refuse : il rendrait `src/locus/**` solidaire d'une refonte amont de `src/session/`.
   *
   * Vérifié par **égalité après aller-retour** plutôt qu'en cherchant des fonctions : chercher
   * suppose de savoir quoi chercher, alors que la sérialisation, elle, ne laisse rien passer.
   */
  test("le plan et le compte rendu franchissent la couture comme des données", async () => {
    const port = ports()
    const verdict = await runLoop(port)
    expect(verdict.status).toBe("ran")

    const [plan] = port.seen.plans
    expect(plan).toBeDefined()
    if (!plan) return
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)

    const rendu = report("ses_01")
    expect(JSON.parse(JSON.stringify(rendu))).toEqual(rendu)
  })

  /**
   * **Une reprise garde son numéro d'attempt.**
   *
   * §11.1 : « aucune de ces identités ne doit être substituée aux autres ». Un résultat rendu sous
   * un autre numéro serait un doublon pour l'institution, ce que §15.5 existe pour empêcher — et
   * c'est ce que ferait une boucle qui redemanderait un rang au bail après une interruption.
   *
   * Le bail annonce ici un rang **différent** de celui du checkpoint, exprès : si les deux étaient
   * égaux, le test passerait quelle que soit la source retenue.
   */
  test("une interruption reprend sous le même numéro de tentative", async () => {
    const mission = MISSION()
    const interrompu: Checkpoint = {
      task_id: mission.task_id,
      attempt: 2,
      state: "running",
      session: {},
      context_hash: mission.context_view.hash,
      worktree: {},
      partial_artifacts: [],
      budget_spent: {},
      next_operations: [],
      unserializable: [],
      through_sequence: 0,
      taken_at: "2026-08-24T11:00:00.000Z",
    }

    const verdict = await runLoop(
      ports({
        claim: async () => ({ mission, lease: lease(mission, 7) }),
        resume: async () => interrompu,
      }),
    )

    expect(verdict.status).toBe("ran")
    if (verdict.status !== "ran") return
    expect(verdict.resumed).toBe(true)
    expect(verdict.attempt).toBe(2)
  })

  /**
   * **Un checkpoint d'une autre tâche ne se prend pas pour le sien.**
   *
   * Le pendant du test précédent, et celui qui l'empêche de passer pour de mauvaises raisons : une
   * boucle qui relirait n'importe quel checkpoint reprendrait le rang d'un travail sans rapport.
   */
  test("un checkpoint d'une autre tâche n'est pas une reprise", async () => {
    const mission = MISSION()
    const etranger: Checkpoint = {
      task_id: "task_dune_autre_mission",
      attempt: 2,
      state: "running",
      session: {},
      context_hash: mission.context_view.hash,
      worktree: {},
      partial_artifacts: [],
      budget_spent: {},
      next_operations: [],
      unserializable: [],
      through_sequence: 0,
      taken_at: "2026-08-24T11:00:00.000Z",
    }

    const verdict = await runLoop(
      ports({ claim: async () => ({ mission, lease: lease(mission, 7) }), resume: async () => etranger }),
    )

    expect(verdict.status).toBe("ran")
    if (verdict.status !== "ran") return
    expect(verdict.resumed).toBe(false)
    expect(verdict.attempt).toBe(7)
  })

  /**
   * **Le chemin d'états est celui de §11.2, et la machine le confirme.**
   *
   * Écrire les états à la main ferait exister deux vérités sur les mêmes transitions. Ce test lit
   * `canTransition` de `W2.9` plutôt que de recopier le tableau — si §11.2 change, il rougit ici
   * avant que la boucle ne mente.
   */
  test("les deux chemins parcourus sont autorisés par la machine à états", () => {
    for (const chemin of [RUN_PATH, REFUSAL_PATH]) {
      expect(chemin.length).toBeGreaterThan(0)
      let from: (typeof chemin)[number] = "offered"
      for (const to of chemin) {
        expect(canTransition(from, to)).toBe(true)
        from = to
      }
    }
  })

  /**
   * **Le checkpoint porte le rang et l'état réellement atteints.**
   *
   * Un point de reprise qui annoncerait un état que la boucle n'a pas atteint enverrait la reprise
   * repartir d'ailleurs — et `§24.2` exige que `unserializable` dise ce qu'on sait plutôt que d'être
   * laissé de côté. Vide veut ici dire « rien d'insérialisable », ce qui est vrai puisque la couture
   * ne fait traverser que des données.
   */
  test("le checkpoint écrit ce que le tour a réellement atteint", async () => {
    const port = ports()
    await runLoop(port)

    const [saved] = port.seen.saved
    expect(saved).toBeDefined()
    if (!saved) return
    expect(saved.attempt).toBe(3)
    expect(saved.state).toBe("completing")
    expect(saved.unserializable).toEqual([])
    expect(saved.context_hash).toBe(MISSION().context_view.hash)
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved)
  })

  /**
   * **Ce que la session a produit remonte tel quel, et le checkpoint le compte.**
   *
   * Deux propriétés que le tour « complet » ci-dessus laissait entièrement libres, parce que son
   * compte rendu ne porte aucun événement : une boucle qui aurait appelé `emit([])` et écrit
   * `through_sequence: 0` passait tous les tests. Une passe de mutation l'a montré en faisant
   * exactement ces deux substitutions sans faire rougir quoi que ce soit.
   *
   * `through_sequence` est ce sur quoi §12.4 fait reposer « rien perdu, rien dupliqué » : le
   * figer à zéro ferait rejouer depuis le début à chaque reprise, donc dupliquer.
   */
  test("les événements du compte rendu remontent, et le checkpoint dit jusqu'où", async () => {
    const evenement = (sequence: number): Event => ({
      protocol: MISSION().protocol,
      event_type: "progress",
      sequence,
      occurred_at: `2026-08-24T12:00:0${sequence}.000Z`,
      idempotency_key: `idem-${sequence}`,
    })
    const produits: readonly Event[] = [evenement(1), evenement(2), evenement(3)]

    let remontes: readonly Event[] | undefined
    const port = ports({
      openSession: async () => ({ sessionId: "ses_02", events: produits, output: { summary: "fait" } }),
      emit: async (events) => {
        remontes = events
      },
    })

    const verdict = await runLoop(port)
    expect(verdict.status).toBe("ran")

    expect(remontes).toEqual(produits)
    const [saved] = port.seen.saved
    expect(saved?.through_sequence).toBe(3)
  })

  /**
   * **Un cran interdit par §11.2 lève ; il ne se tait pas.**
   *
   * `advance` existe pour qu'aucun état ne soit écrit sans passer par la machine de `W2.9`. Une
   * passe de mutation a montré que remplacer son corps par `return to` ne faisait rougir aucun
   * test : la garantie était affirmée et vérifiée nulle part — le motif exact de l'ADR 0025.
   *
   * Le cran choisi est vrai dans la spec : §11.2 n'autorise `rejected` que depuis `offered`, donc
   * `completed → rejected` est interdit, et on ne rejette pas ce qu'on a déjà mené à terme.
   */
  test("advance refuse un cran que §11.2 n'autorise pas", () => {
    expect(advance("offered", "accepted")).toBe("accepted")
    expect(() => advance("completed", "rejected")).toThrow()
    try {
      advance("completed", "rejected")
    } catch (error) {
      expect(LocusAttemptPathBroken.isInstance(error)).toBe(true)
      if (LocusAttemptPathBroken.isInstance(error)) {
        expect(error.data).toEqual({ from: "completed", to: "rejected" })
      }
    }
  })

  /**
   * **Les étapes sont franchies dans l'ordre, et une étape non atteinte n'est pas rapportée.**
   *
   * Un vecteur d'étapes complété jusqu'au bout quoi qu'il arrive laisserait croire que tout a été
   * tenté — la même faute que `submit_batch` de `locusolus` évite en rendant un verdict par commande
   * **exécutée**.
   */
  test("une étape qui échoue arrête le tour là où il en était", async () => {
    const mission = MISSION()
    const casse = ports({
      claim: async () => ({ mission, lease: lease(mission, 1) }),
      openSession: async () => {
        throw new Error("la session amont n'a pas démarré")
      },
    })

    let verdict: LoopOutcome | undefined
    try {
      verdict = await runLoop(casse)
    } catch {
      verdict = undefined
    }

    expect(verdict).toBeUndefined()
    expect(casse.seen.saved).toEqual([])
  })
})

/**
 * La couture, exercée contre **l'amont réel** — le cœur du test de sortie de `W2.20`.
 *
 * Les tests ci-dessus prouvent que la boucle enchaîne ; ils ne prouvent pas qu'une session amont
 * s'ouvre, puisqu'ils lui donnent un ouvreur d'épreuve. Sans ce qui suit, « session amont réellement
 * initialisée » serait une affirmation que rien ne vérifie — exactement ce que l'ADR 0025 de
 * `locusolus` rend coûteux.
 *
 * `Session.createNext` est **local** : il écrit un enregistrement, initialise le système de fichiers
 * de session et publie sur le bus. Aucun provider, aucun modèle, aucun réseau — donc éprouvable en
 * CI, ce qui a été vérifié en le lisant avant d'écrire ce test.
 */
describe("la couture ouvre une vraie session amont — W2.20, ADR 0010", () => {
  test("un tour de boucle crée une session que l'amont retrouve", async () => {
    const { Instance } = await import("../../src/project/instance")
    const { Session } = await import("../../src/session")
    const { tmpdir } = await import("../fixture/fixture")

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ouvreur = sessionOpener({
          directory: Instance.directory,
          create: async (input) => Session.createNext({ title: input.title, directory: input.directory }),
        })

        const verdict = await runLoop(ports({ openSession: ouvreur }))

        expect(verdict.status).toBe("ran")
        if (verdict.status !== "ran") return

        // Ce qui prouve l'ouverture : l'amont retrouve la session par son identifiant. Un
        // identifiant fabriqué localement passerait le test précédent et échouerait ici.
        const retrouvee = await Session.get(verdict.sessionId)
        expect(retrouvee.id).toBe(verdict.sessionId)
        expect(retrouvee.title).toContain(MISSION().task_id)
      },
    })
  }, 60_000)

  /**
   * **Le titre distingue deux tentatives d'une même tâche.**
   *
   * Un titre qui ne porterait que la tâche rendrait deux tentatives indiscernables dans une liste —
   * ce qu'on regarde précisément quand une reprise s'est mal passée.
   */
  test("le titre de session nomme la tâche et la tentative", () => {
    const plan = {
      task_id: "task_01",
      attempt_id: "att_02",
      branch_id: "br_01",
      overlay: { agent: "research", prompt_overlay_ref: undefined },
      models: [],
      tools: [],
      forbiddenTools: [],
      blindReview: false,
      contextViewId: undefined,
    } as unknown as SessionPlan

    const titre = sessionTitle(plan)
    expect(titre).toContain("task_01")
    expect(titre).toContain("att_02")
  })
})

/**
 * Ce qu'un tour a fait, rendu lisible — le défaut trouvé en montant la chaîne réelle.
 *
 * `runLoop` rend un `LoopOutcome` complet depuis `W2.20`, et son commentaire dit pourquoi : « un
 * tour qui n'aurait laissé qu'un log serait indiscernable d'un tour qui n'a rien fait ». Le type
 * `WorkerOutcome` le répète — « un tour a eu lieu, et voici ce qu'il a fait ». La valeur existait
 * donc, exacte, et **la commande la jetait** : elle imprimait `worker: ${status}` et la
 * configuration, jamais l'issue.
 *
 * Constaté en montant les trois processus du harnais `locusolus` : un worker qui n'avait **rien**
 * réclamé — file vide — affichait `worker: ran`, mot qui dit le contraire de ce qui s'est passé.
 */
describe("un tour dit ce qu'il a fait — le rendu de LoopOutcome", () => {
  /**
   * **La ligne qui manquait le plus.**
   *
   * « Rien à réclamer » est un état parfaitement normal — une file vide — et le confondre avec un
   * tour complet envoie chercher un défaut d'exécution là où il n'y a qu'une file vide, ou
   * l'inverse. C'est le cas qu'un `worker: ran` seul rendait invisible.
   */
  test("un tour qui n'a rien réclamé le dit, au lieu de se lire « ran »", () => {
    expect(describeOutcome({ status: "idle" })).toEqual(["tour : aucune mission à réclamer"])
  })

  /**
   * **Un refus porte son code, son motif et ses détails structurés.**
   *
   * §10.3 dit que ce qui décide sont les détails, la phrase étant « le confort humain, explicitement
   * secondaire ». N'imprimer que la phrase ferait discuter une formulation là où il y a une valeur.
   */
  test("un refus d'admission porte son code et ses détails, pas seulement sa phrase", () => {
    const lignes = describeOutcome({
      status: "refused",
      refusal: {
        accepted: false,
        code: "sandbox_unavailable",
        details: { requested: "S3", offered: "S2" },
        message: "cet hôte ne tient pas S3",
      },
      phases: ["claim"],
      state: "rejected",
    })

    expect(lignes[0]).toBe("tour : mission refusée à l'admission — sandbox_unavailable")
    expect(lignes.join("\n")).toContain("cet hôte ne tient pas S3")
    // Les détails **structurés**, sous leur forme : c'est ce qui distingue « on m'a demandé S3 » de
    // « on m'a demandé autre chose », et une phrase ne le porte pas.
    expect(lignes.join("\n")).toContain('"requested":"S3"')
    expect(lignes.join("\n")).toContain('"offered":"S2"')
    expect(lignes.join("\n")).toContain("état : rejected")
  })

  /**
   * **Un tour complet nomme la mission, le rang, la session et les étapes.**
   *
   * Les étapes sont ce qui distingue un tour qui a ouvert une session d'un tour qui s'est arrêté à
   * la planification — et c'est précisément ce que la valeur portait sans que personne ne le lise.
   */
  test("un tour exécuté nomme la mission, le rang, la session et les étapes", () => {
    const lignes = describeOutcome({
      status: "ran",
      phases: ["claim", "plan", "session", "emit", "report"],
      attempt: 3,
      taskId: "task_01HF7YAT000000000000000005",
      sessionId: "ses_42",
      resumed: false,
      state: "completed",
    })

    expect(lignes[0]).toContain("task_01HF7YAT000000000000000005")
    expect(lignes.join("\n")).toContain("attempt : 3")
    expect(lignes.join("\n")).toContain("session : ses_42")
    expect(lignes.join("\n")).toContain("claim, plan, session, emit, report")
    // Pas de « (reprise) » sur un tour neuf : l'annoter partout ferait perdre l'information le jour
    // où elle compte, exactement comme l'empreinte que `W5.w` n'imprime que là où elle sert.
    expect(lignes.join("\n")).not.toContain("reprise")
  })

  /**
   * **Une reprise se voit.**
   *
   * Un rang relu d'un checkpoint et un rang neuf donnent le même nombre ; ce qui les distingue est
   * l'origine, et c'est elle qui dit à un lecteur si l'institution va y voir un doublon ou une suite.
   */
  test("une reprise est annotée, et un tour neuf ne l'est pas", () => {
    const lignes = describeOutcome({
      status: "ran",
      phases: ["claim", "plan", "session", "emit", "report"],
      attempt: 2,
      taskId: "task_x",
      sessionId: "ses_1",
      resumed: true,
      state: "completed",
    })

    expect(lignes.join("\n")).toContain("attempt : 2 (reprise)")
  })
})
