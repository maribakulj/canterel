import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Checkpoint } from "../../src/locus/resume-store.ts"
import type { ToolDescriptor } from "../../src/locus/tool-policy.ts"
import type { CapabilityManifest, Event, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"
import type { SessionPlan } from "../../src/locus/session-map.ts"
import { eventFieldFindings } from "../../src/locus/event-bridge.ts"
import {
  advance,
  describeOutcome,
  PHASES,
  REFUSAL_EVENTS,
  REFUSAL_PATH,
  RUN_PATH,
  runLoop,
  type LoopOutcome,
  type Offer,
  type SessionReport,
  type WorkerPorts,
} from "../../src/locus/worker-loop.ts"
import { canTransition } from "../../src/locus/attempt.ts"
import { LEP_FEATURES } from "../../src/locus/lep/generated.ts"
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
function ports(
  over: Partial<WorkerPorts> = {},
): WorkerPorts & { seen: { plans: SessionPlan[]; saved: Checkpoint[]; vues: string[] } } {
  const seen = { plans: [] as SessionPlan[], saved: [] as Checkpoint[], vues: [] as string[] }
  const mission = MISSION()
  const base: WorkerPorts = {
    now: () => 1_756_000_000_000,
    claim: async () => ({ mission, lease: lease(mission, 3) }) satisfies Offer,
    manifest: () => MANIFEST(),
    tools: () => TOOLS,
    // Le port par défaut rend une vue **qui correspond**, parce que ces tests-ci éprouvent la
    // boucle et non la vérification. Celle-ci a son test de sortie dans `context-view.test.ts`,
    // et un test d'ici la remplace quand c'est elle qu'il vise.
    contextView: async (named) => {
      seen.vues.push(named.id)
      return {
        id: named.id,
        confidentiality_ceiling: "internal",
        source_event_watermark: 0,
        content_hash: named.hash,
        generated_at: "2026-08-24T12:00:00.000Z",
      }
    },
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
   * **Un refus est rapporté au plan de contrôle — mais seulement si la feature a été accordée.**
   *
   * Le test de sortie de `W19.c.2`, et il tient les **deux** sens parce que l'ADR 0037 l'exige.
   *
   * Le sens positif : sans cet envoi, la mission reste sous bail jusqu'à expiration et « le worker a
   * refusé » se confond avec « le worker est mort ». Le sens négatif est celui qui porte la garantie :
   * `task.refused` est un membre **neuf** d'une énumération fermée, et l'ADR 0037 n'en autorise
   * l'entrée que gardée. Une garde qui ne dirait que « émis quand accordée » passerait aussi sur un
   * émetteur qui émet toujours — et un plan de contrôle plus ancien recevrait une valeur qu'il ne
   * sait pas lire, sans savoir qu'il vient de manquer un refus.
   *
   * Le troisième cas n'est pas décoratif : un port `granted` **absent** vaut « aucune feature », et
   * non « toutes ». C'est l'interdit 4 de l'ADR 0017, et c'est le défaut qu'un worker mal assemblé
   * rencontrera.
   */
  test("un refus est rapporté si et seulement si la feature a été accordée", async () => {
    const mission = fixture<MissionEnvelope>("mission-refused.json")
    const tour = async (granted?: () => readonly string[]) => {
      const emis: Event[] = []
      const verdict = await runLoop(
        ports({
          claim: async () => ({ mission, lease: lease(mission, 1) }),
          manifest: () => fixture<CapabilityManifest>("manifest-macos.json"),
          emit: async (events) => {
            emis.push(...events)
          },
          ...(granted === undefined ? {} : { granted }),
        }),
      )
      expect(verdict.status).toBe("refused")
      return emis
    }

    const accordee = await tour(() => [REFUSAL_EVENTS])
    expect(accordee).toHaveLength(1)
    expect(accordee[0]?.event_type).toBe("task.refused")
    expect(accordee[0]?.task_id).toBe(mission.task_id)
    // Le code et les détails sont canoniques ; le message est le confort humain.
    expect((accordee[0]?.payload as { code: string }).code.length).toBeGreaterThan(0)
    expect((accordee[0]?.payload as { details: unknown }).details).toBeDefined()

    expect(await tour(() => ["late-results"])).toEqual([])
    expect(await tour()).toEqual([])
  })

  /**
   * **La feature que ce module garde est celle que le registre définit.**
   *
   * Le nom est écrit ici plutôt qu'importé, parce que `LEP_FEATURES` porte ce que le **protocole**
   * définit et que ce module a besoin de celle qu'il émet. Les deux doivent rester d'accord, et une
   * confrontation vaut mieux qu'une supposition : un nom qui divergerait ne serait jamais accordé,
   * donc l'événement ne partirait jamais, **en silence**.
   */
  test("le nom de la feature gardée est celui du registre", () => {
    expect(Object.keys(LEP_FEATURES)).toContain(REFUSAL_EVENTS)
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

    const emis: (readonly Event[])[] = []
    const port = ports({
      openSession: async () => ({ sessionId: "ses_02", events: produits, output: { summary: "fait" } }),
      emit: async (events) => {
        emis.push(events)
      },
    })

    const verdict = await runLoop(port)
    expect(verdict.status).toBe("ran")

    // **Trois émissions, et leur ordre est le contrat** — `W2.27`. `attempt.started` avant la
    // session, le compte rendu ensuite, `attempt.completed` après le rapport. Un test qui ne
    // regarderait que la dernière — ce que faisait la rédaction d'avant — passerait tout aussi bien
    // si les deux premières disparaissaient.
    expect(emis.map((lot) => lot.map((event) => event.event_type))).toEqual([
      ["attempt.started"],
      // Les trois `progress` consécutifs **fusionnent** : §18.3 les range parmi les coalescibles, et
      // c'est `W2.27` qui a branché `coalesce` sur ce chemin. Avant, rien ne l'appelait et les trois
      // partaient tels quels.
      ["progress"],
      ["attempt.completed"],
    ])

    // Le survivant d'une rafale est le **dernier** : c'est lui qui porte l'état le plus récent.
    expect(emis[1]?.[0]?.idempotency_key).toBe("idem-3")

    // Le checkpoint lit le compte rendu, **pas** ce qui est parti : coalescer ne doit pas faire
    // reculer le point de reprise, sans quoi une reprise rejouerait ce qui avait été fusionné.
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

describe("la boucle émet ce qu'elle sait sans session — W2.27, §15.6", () => {
  /**
   * **Les deux événements qu'une boucle connaît d'elle-même.**
   *
   * `attempt.started` et `attempt.completed` sont les premiers de §15.6 qui appartiennent au worker
   * plutôt qu'à ce qu'il exécute : il a commencé une tentative et l'a finie, quoi que la session ait
   * produit. Tout le reste — `progress`, `tool.*`, `artifact.*` — vient de l'intérieur d'une
   * session, donc d'un modèle, et n'est pas de cette tranche.
   */
  test("les deux événements portent tous les champs que §18.2 exige d'un événement d'attempt", async () => {
    const emis: (readonly Event[])[] = []
    const port = ports({ emit: async (events) => void emis.push(events) })

    expect((await runLoop(port)).status).toBe("ran")

    const plats = emis.flat().filter((event) => event.event_type.startsWith("attempt."))
    expect(plats.map((event) => event.event_type)).toEqual(["attempt.started", "attempt.completed"])
    // `eventFieldFindings` connaît la règle — `task_id` et `attempt` en plus des cinq champs de base
    // pour un type d'attempt. La rejouer ici en dur ferait deux vérités.
    for (const event of plats) expect(eventFieldFindings(event)).toEqual([])
  })

  /**
   * **`sequence` est monotone, et la clé d'idempotence est dérivée.**
   *
   * §18.2 veut la première **par connexion** : c'est ce qui rend « rien perdu, rien dupliqué »
   * vérifiable. La seconde porte l'acte et non l'instant — une reprise qui rejoue son
   * `attempt.started` doit porter la même clé, sans quoi l'institution lirait deux tentatives là où
   * il n'y en a qu'une.
   */
  test("les séquences montent et les clés portent l'acte", async () => {
    const emis: (readonly Event[])[] = []
    const port = ports({ emit: async (events) => void emis.push(events) })

    expect((await runLoop(port)).status).toBe("ran")

    const plats = emis.flat().filter((event) => event.event_type.startsWith("attempt."))
    const [debut, fin] = plats
    expect(debut?.sequence).toBe(1)
    expect(fin?.sequence).toBe(2)
    expect(debut?.idempotency_key).toMatch(/^attempt:.+:\d+:attempt\.started$/)
    expect(fin?.idempotency_key).toMatch(/^attempt:.+:\d+:attempt\.completed$/)
    // Deux actes distincts, donc deux clés distinctes. Une clé partagée ferait prendre la fin pour
    // un rejeu du début.
    expect(debut?.idempotency_key).not.toBe(fin?.idempotency_key)
  })

  /**
   * **Une mission refusée à l'admission n'émet rien.**
   *
   * Ce n'est pas un oubli : `runLoop` rend la main avant d'atteindre le premier `emit`, et il n'y a
   * pas d'attempt à annoncer — l'admission a dit non **avant** toute exécution. Que le plan de
   * contrôle l'apprenne autrement est une question ouverte, nommée `W19.c` côté `locusolus`, et
   * elle attend une décision de protocole plutôt qu'un événement inventé ici.
   */
  test("un refus d'admission n'émet aucun événement d'attempt", async () => {
    const emis: (readonly Event[])[] = []
    const port = ports({
      // Un manifeste qui n'offre que `S1` contre la mission `S3` du corpus : `sandbox_unavailable`.
      manifest: () => ({ ...MANIFEST(), sandbox: { ...MANIFEST().sandbox, levels: ["S1"] } }),
      emit: async (events) => void emis.push(events),
    })

    expect((await runLoop(port)).status).toBe("refused")
    expect(emis).toEqual([])
  })
})
