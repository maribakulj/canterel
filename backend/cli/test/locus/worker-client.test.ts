import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

import type { Credential } from "../../src/locus/auth.ts"
import { LocusResumeUnreadable, LocusServerRejected } from "../../src/locus/errors.ts"
import { ResumeStore, type Checkpoint } from "../../src/locus/resume-store.ts"
import type { CapabilityManifest, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"
import { CLAIM_PATH, EVENTS_PATH, lepCall, RESULT_PATH, workerPorts } from "../../src/locus/worker-client.ts"
import { runLoop, type SessionReport } from "../../src/locus/worker-loop.ts"
import { loadConfig, runWorker } from "../../src/locus/index.ts"
import { runConformance } from "./harness/index.ts"
import type { WorkerUnderTest } from "./harness/worker.ts"

const FIXTURES = join(import.meta.dir, "fixtures")

function fixture<T>(name: string): T {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>
  const { _fixture, ...body } = raw
  void _fixture
  return body as T
}

const MISSION = () => fixture<MissionEnvelope>("mission-accepted.json")
const MANIFEST = () => fixture<CapabilityManifest>("manifest-vm-linux.json")

const CREDENTIAL: Credential = {
  worker_id: "wk_01",
  credential: "secret-de-worker",
  issued_at: "2026-08-24T12:00:00.000Z",
  expires_at: null,
  scope: ["worker"],
  labels: [],
}

function lease(mission: MissionEnvelope, attempt: number): Lease {
  return {
    protocol: mission.protocol,
    lease_id: "lease-1",
    task_id: mission.task_id,
    attempt,
    worker_id: CREDENTIAL.worker_id,
    issued_at: "2026-08-24T12:00:00.000Z",
    expires_at: "2026-08-24T12:05:00.000Z",
    heartbeat_interval_seconds: 30,
    ttl_seconds: 300,
  }
}

function store(): ResumeStore {
  return new ResumeStore(mkdtempSync(join(osTmpdir(), "locus-resume-")))
}

/** Un magasin **et** son répertoire : `ResumeStore` garde le sien privé, et c'est bien ainsi. */
function storeAt(): { store: ResumeStore; directory: string } {
  const directory = mkdtempSync(join(osTmpdir(), "locus-resume-"))
  return { store: new ResumeStore(directory), directory }
}

function client(
  fetchLike: Parameters<typeof workerPorts>[0]["fetch"],
  over: Partial<Parameters<typeof workerPorts>[0]> = {},
) {
  return workerPorts({
    endpoint: "https://locus.example",
    fetch: fetchLike,
    credential: CREDENTIAL,
    store: store(),
    manifest: () => MANIFEST(),
    tools: () => [],
    openSession: async (): Promise<SessionReport> => ({ sessionId: "ses_01", events: [], output: {} }),
    ...over,
  })
}

describe("le client de réclamation — le test de sortie de W2.21", () => {
  /**
   * **« Rien pour toi » et « je n'ai pas pu demander » restent deux issues distinctes.**
   *
   * Les deux envoient chercher à des endroits opposés : un ordonnanceur qui n'a rien à donner, ou un
   * lien cassé. C'est la séparation que l'ADR 0028 décision 4 tient pour le broker de `locusolus`, et
   * elle vaut ici pour la même raison. Tenu par le **type** — `null` d'un côté, une exception de
   * l'autre — et non par la lecture d'un message.
   */
  test("un 204 est du calme, une panne est une panne", async () => {
    const calme = client(async () => new Response(null, { status: 204 }))
    expect(await calme.claim()).toBeNull()

    const casse = client(async () => new Response("nope", { status: 503 }))
    await expect(casse.claim()).rejects.toThrow()
    try {
      await casse.claim()
    } catch (error) {
      expect(LocusServerRejected.isInstance(error)).toBe(true)
    }
  })

  /**
   * **Aucune redirection n'est suivie** — §7.3.
   *
   * La leçon vient de `xiiif` : suivre une redirection laisse le serveur choisir la destination
   * **après** que la politique a été appliquée à l'URL d'origine. Un jeton de worker suit ce chemin.
   */
  test("une redirection est un refus, pas un détour", async () => {
    const raison = async (reponse: () => Response): Promise<string> => {
      try {
        await client(async () => reponse()).claim()
        expect.unreachable("le refus doit lever")
        return ""
      } catch (error) {
        expect(LocusServerRejected.isInstance(error)).toBe(true)
        return LocusServerRejected.isInstance(error) ? error.data.reason : ""
      }
    }

    // Une première rédaction n'exigeait que « la raison contient 302 ». C'était vrai des **deux**
    // branches — un `302` non intercepté tombe dans « réponse non-ok » et dit aussi « 302 » —, donc
    // la branche dédiée aux redirections n'était éprouvée nulle part. Une passe de mutation l'a
    // montrée en rétrécissant la plage `3xx` sans faire rougir le test.
    const detour = await raison(() => new Response(null, { status: 302, headers: { location: "https://ailleurs" } }))
    const panne = await raison(() => new Response("nope", { status: 503 }))

    expect(detour).toContain("redirection")
    expect(detour).toContain("302")
    expect(panne).not.toContain("redirection")
  })

  /**
   * **Le jeton part en en-tête, et le chemin est celui de §15.2.**
   *
   * L'URL attendue est écrite **en toutes lettres**, et non composée depuis `CLAIM_PATH`. Une
   * première rédaction faisait la seconde chose : la constante apparaissait des deux côtés de
   * l'égalité, donc la changer changeait aussi l'attente, et le test passait pour n'importe quel
   * chemin. Une passe de mutation l'a établi en remplaçant `/lep/v1/claim` par `/lep/v1/claimx`
   * sans faire rougir quoi que ce soit. C'est le même défaut que la vérification des permissions du
   * socket de `locusolus` a eu contre `SOCKET_MODE`.
   */
  test("la réclamation porte la créance et vise le chemin LEP", async () => {
    let vu: { url: string; auth: string | null } | undefined
    const port = client(async (url, init) => {
      vu = { url, auth: new Headers(init?.headers).get("authorization") }
      return new Response(null, { status: 204 })
    })

    await port.claim()

    expect(vu?.url).toBe("https://locus.example/lep/v1/claim")
    expect(vu?.auth).toBe(`Bearer ${CREDENTIAL.credential}`)
  })

  /**
   * **La réclamation annonce ce que cet hôte sait faire** — §15.3, `W20.q`.
   *
   * Sans manifeste, le plan de contrôle n'a rien à placer : il servirait la première mission venue à
   * un hôte dont il ne sait rien, et c'est exactement ce que `W20.q` corrige côté serveur. La moitié
   * cliente est ici, et elle envoie le manifeste **à chaque tour** plutôt qu'une fois au handshake —
   * un inventaire vieillit, `capability-watch` existe pour cette raison.
   *
   * Ce que le test tient est le **contenu**, pas la présence d'une clé : un client qui enverrait un
   * objet vide, ou le manifeste d'un autre worker, passerait une assertion d'existence.
   */
  test("la réclamation annonce le manifeste de cet hôte", async () => {
    let corps: Record<string, unknown> | undefined
    const port = client(async (_url, init) => {
      corps = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(null, { status: 204 })
    })

    await port.claim()

    expect(corps?.manifest).toEqual(MANIFEST())
    expect(corps?.worker_id).toBe(CREDENTIAL.worker_id)
  })

  /**
   * **Le manifeste est relu à chaque réclamation, jamais figé.**
   *
   * Un client qui l'aurait capturé une fois — au moment de construire les ports — enverrait
   * indéfiniment l'inventaire d'un disque qui s'est rempli depuis. Le port est appelé, donc ce que
   * l'hôte annonce suit ce que l'hôte est.
   */
  test("un manifeste qui change est celui qui part au tour suivant", async () => {
    const vus: unknown[] = []
    let disque = 400_000
    const port = client(
      async (_url, init) => {
        vus.push((JSON.parse(String(init?.body)) as { manifest: CapabilityManifest }).manifest.resources.disk_free_mb)
        return new Response(null, { status: 204 })
      },
      { manifest: () => ({ ...MANIFEST(), resources: { ...MANIFEST().resources, disk_free_mb: disque } }) },
    )

    await port.claim()
    disque = 12
    await port.claim()

    expect(vus).toEqual([400_000, 12])
  })

  /**
   * **Les trois chemins de §15.2, littéralement.**
   *
   * Ce ne sont pas des détails d'implémentation mais la moitié cliente d'un contrat : les changer
   * casse un `locusd` qu'on ne recompile pas en même temps. Écrits ici en clair, pour que la
   * modification soit visible dans un diff plutôt que silencieuse.
   */
  test("les chemins LEP sont ceux que §15.2 nomme", () => {
    expect(CLAIM_PATH).toBe("/lep/v1/claim")
    expect(EVENTS_PATH).toBe("/lep/v1/events")
    expect(RESULT_PATH).toBe("/lep/v1/result")
  })

  /**
   * **Un « chemin » qui est en fait une URL absolue ne déplace pas l'appel.**
   *
   * Les trois chemins de §15.2 sont relatifs et constants, donc la garde d'origine ne peut pas se
   * déclencher pour eux — une passe de mutation l'a confirmé en la neutralisant sans faire rougir
   * quoi que ce soit. Mais [`lepCall`] est **exportée** : `new URL(path, base)` ignore la base dès
   * que `path` est absolu, et c'est là que la garde compte. La supprimer parce qu'aucun appelant
   * interne ne la déclenche ferait de la première configuration lisible un aller simple pour la
   * créance du worker.
   */
  test("un chemin absolu vers un autre hôte est refusé avant tout appel", async () => {
    let appels = 0
    await expect(
      lepCall({
        endpoint: "https://locus.example",
        path: "https://ailleurs.example/lep/v1/claim",
        fetch: async () => {
          appels += 1
          return new Response("{}", { status: 200 })
        },
        credential: CREDENTIAL,
      }),
    ).rejects.toThrow()
    expect(appels).toBe(0)
  })

  /**
   * **Rien à dire n'est pas un appel.**
   *
   * Un `POST` vide à chaque tour ferait du bruit pour rien et rendrait un journal de serveur
   * illisible.
   */
  test("aucun événement ne produit aucune requête", async () => {
    let appels = 0
    const port = client(async () => {
      appels += 1
      return new Response("{}", { status: 200 })
    })

    await port.emit([])
    expect(appels).toBe(0)
  })

  /**
   * **Un checkpoint en quarantaine n'est pas une absence.**
   *
   * `null` veut dire « pas de checkpoint », jamais « je n'ai pas su le lire ». Les fondre ferait
   * repartir sous un rang de tentative neuf, c'est-à-dire produire le doublon que §15.5 existe pour
   * empêcher. Une ignorance n'est pas une absence — la règle de `W22.e` pour les sondes d'hôte, et
   * de `W21.m` pour une écriture non classée.
   */
  test("un checkpoint illisible lève au lieu de se lire « rien à reprendre »", async () => {
    const { store: magasin, directory: repertoire } = storeAt()
    const propre = client(async () => new Response(null, { status: 204 }), { store: magasin })
    expect(await propre.resume()).toBeNull()

    const valide: Checkpoint = {
      task_id: MISSION().task_id,
      attempt: 4,
      state: "running",
      session: {},
      context_hash: MISSION().context_view.hash,
      worktree: {},
      partial_artifacts: [],
      budget_spent: {},
      next_operations: [],
      unserializable: [],
      through_sequence: 0,
      taken_at: "2026-08-24T11:00:00.000Z",
    }
    magasin.save(valide)
    expect((await propre.resume())?.attempt).toBe(4)

    // Un contenu corrompu : `ResumeStore` le met en quarantaine, et le port doit le **dire**.
    const { writeFileSync } = await import("node:fs")
    writeFileSync(join(repertoire, "checkpoint.json"), "{ ceci n'est pas du json")
    try {
      await propre.resume()
      expect.unreachable("un checkpoint illisible doit lever")
    } catch (error) {
      expect(LocusResumeUnreadable.isInstance(error)).toBe(true)
    }
  })

  /**
   * **Le tour aboutit de bout en bout contre un serveur qui répond.**
   *
   * Ce n'est pas un test de transport : c'est la chaîne complète — réclamer, admettre, planifier,
   * ouvrir la session, faire remonter, rendre — sur les ports réels de `W2.21`. Le serveur est un
   * `fetch` d'épreuve — la surface §15.2 réelle est éprouvée chez `locusolus`, contre un vrai socket
   * (`W20.k`, `W20.q`) ; ce qui est éprouvé ici est que le client parle ce que la boucle attend, et
   * l'inverse.
   */
  test("un tour complet aboutit sur les ports HTTP réels", async () => {
    const mission = MISSION()
    const rendus: string[] = []
    const port = client(async (url) => {
      if (url.endsWith(CLAIM_PATH)) {
        return new Response(JSON.stringify({ mission, lease: lease(mission, 5) }), { status: 200 })
      }
      rendus.push(url)
      return new Response("{}", { status: 200 })
    })

    const verdict = await runLoop(port)

    expect(verdict.status).toBe("ran")
    if (verdict.status !== "ran") return
    expect(verdict.attempt).toBe(5)
    expect(verdict.state).toBe("completed")
    expect(rendus.some((url) => url.endsWith(RESULT_PATH))).toBe(true)
  })
})

/**
 * La politique de transport, éprouvée contre **de vrais serveurs** — §7.3.
 *
 * Les tests ci-dessus emploient un `fetch` d'épreuve : ils vérifient ce que le client fait d'une
 * réponse, jamais ce que `fetch` fait de la requête. Or `redirect: "manual"` est une consigne donnée
 * à `fetch`, pas au code appelant — un `fetch` d'épreuve rend un `302` quelle que soit l'option, et
 * une passe de mutation l'a montré en remplaçant `"manual"` par `"follow"` sans faire rougir un seul
 * test. Ce qui suit exerce donc la vraie pile HTTP, sur la boucle locale.
 */
describe("la politique de transport tient contre un vrai serveur — §7.3", () => {
  /**
   * **La destination d'une redirection n'est jamais contactée.**
   *
   * La propriété que §7.3 protège n'est pas « une erreur est levée » : c'est que le jeton de worker
   * ne part pas vers un hôte choisi par le serveur **après** que la politique a été appliquée à
   * l'URL d'origine. Ce test l'énonce comme telle — un compteur sur la cible, à zéro.
   *
   * Deux ports d'écoute, donc deux origines : la leçon vient de `xiiif`, où suivre un saut laissait
   * la chaîne échapper à la politique.
   */
  test("un serveur qui redirige ne fait pas voyager la créance", async () => {
    let touchee = 0
    const cible = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        touchee += 1
        return new Response(JSON.stringify({ mission: MISSION(), lease: lease(MISSION(), 1) }), { status: 200 })
      },
    })
    const renvoi = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${cible.port}/lep/v1/claim` } }),
    })

    try {
      const port = client(fetch as Parameters<typeof client>[0], {
        endpoint: `http://127.0.0.1:${renvoi.port}`,
      })

      await expect(port.claim()).rejects.toThrow()
      // Ce qui compte : la cible n'a rien vu. Une politique qui lèverait *après* le saut aurait
      // déjà laissé partir l'en-tête `authorization`.
      expect(touchee).toBe(0)
    } finally {
      renvoi.stop(true)
      cible.stop(true)
    }
  })

  /**
   * **Un serveur qui ne répond jamais ne bloque pas le worker indéfiniment.**
   *
   * Sans borne, un worker se fige sur sa réclamation et cesse silencieusement de travailler — ce
   * qu'aucun de ses journaux ne dit, puisqu'il n'y a pas d'erreur. Une passe de mutation a montré
   * que remplacer `controller.abort()` par un no-op ne faisait rougir aucun test : la borne était
   * écrite et éprouvée nulle part.
   *
   * Éprouvé par le **temps écoulé** et par le type de l'erreur, pas par la lecture d'un message.
   */
  test("un serveur muet expire dans le délai imparti", async () => {
    const muet = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) })

    try {
      const port = client(fetch as Parameters<typeof client>[0], {
        endpoint: `http://127.0.0.1:${muet.port}`,
        timeoutMs: 120,
      })

      const depart = Date.now()
      let leve: unknown
      try {
        await port.claim()
      } catch (error) {
        leve = error
      }
      const ecoule = Date.now() - depart

      expect(LocusServerRejected.isInstance(leve)).toBe(true)
      expect(ecoule).toBeLessThan(3_000)
    } finally {
      muet.stop(true)
    }
  }, 10_000)
})

describe("la boucle passe la conformance de W0.9", () => {
  /**
   * **Le harnais de `W0.9` ne teste pas un transport, il teste une séquence.**
   *
   * Il **pousse** une offre là où le client de `W2.21` **tire** ; §15.2 autorise les deux, et c'est
   * pourquoi `WorkerUnderTest` est sans transport. Brancher la boucle dessus est donc l'usage prévu :
   * ce qui est vérifié reste vrai quel que soit le tuyau, et la réclamation n'est qu'un port de plus
   * qu'on remplace.
   */
  test("un worker bâti sur la boucle satisfait les vérifications", async () => {
    const mission = MISSION()
    const bail = lease(mission, 1)
    let sortie: Awaited<ReturnType<typeof runLoop>> | undefined

    const ports = client(async () => new Response("{}", { status: 200 }), {
      openSession: async () => ({ sessionId: "ses_conformance", events: [], output: {} }),
    })

    const worker: WorkerUnderTest = {
      register: () => MANIFEST(),
      offer: async (proposee) => {
        // Le harnais pousse : la réclamation rend ce qu'il a proposé. Tout le reste des ports est
        // celui de `W2.21`, sans adaptation.
        sortie = await runLoop({ ...ports, claim: async () => ({ mission: proposee, lease: bail }) })
        return sortie.status === "ran"
      },
      events: () => [],
    }

    const { findings, ran } = await runConformance(worker, mission, bail)

    expect(ran.length).toBeGreaterThan(0)
    expect(sortie?.status).toBe("ran")

    // Le harnais rend des constats. Ceux qui portent sur les **événements** sont attendus : `W2.12`
    // a livré la coalescence, mais aucun fil réel ne produit encore d'événement, et le compte rendu
    // de session en rend une liste vide — ce qui est exact. Les autres seraient des fautes de
    // séquence, et il n'y en a aucune : le worker a enregistré, accepté, et rendu.
    const horsEvenements = findings.filter((finding) => !finding.rule.includes("event"))
    expect(horsEvenements).toEqual([])
  })
})

describe("`runWorker` cesse d'être inerte quand on lui donne de quoi agir — W2.21", () => {
  /**
   * **Le test de sortie, pris au mot.**
   *
   * `W2.20` avait livré la boucle sans appelant, donc `runWorker` rendait `inert` avec `ports` dans
   * `missing`. Avec les ports de `W2.21`, `ports` en sort — et le worker rend ce qu'il a fait.
   */
  test("une installation configurée et outillée rend un tour, pas un constat", async () => {
    const mission = MISSION()
    const config = loadConfig({ LOCUS_ENDPOINT: "https://locus.example", LOCUS_IDENTITY: "wk_01" })

    const inerte = await runWorker(config)
    expect(inerte.status).toBe("inert")
    if (inerte.status === "inert") expect(inerte.missing).toEqual(["ports"])

    const actif = await runWorker(
      config,
      client(async (url) =>
        url.endsWith(CLAIM_PATH)
          ? new Response(JSON.stringify({ mission, lease: lease(mission, 2) }), { status: 200 })
          : new Response("{}", { status: 200 }),
      ),
    )
    expect(actif.status).toBe("ran")
    if (actif.status !== "ran") return
    expect(actif.outcome.status).toBe("ran")
  })

  /**
   * **Et « rien pour toi » reste un tour, pas une panne.**
   *
   * Un serveur qui n'a rien à donner rend `idle` — le worker a bien tourné. Le confondre avec
   * l'inertie de configuration ferait chercher un réglage manquant là où il n'y a que du calme.
   */
  test("un serveur sans travail rend un tour à vide, pas un constat d'inertie", async () => {
    const config = loadConfig({ LOCUS_ENDPOINT: "https://locus.example", LOCUS_IDENTITY: "wk_01" })
    const verdict = await runWorker(
      config,
      client(async () => new Response(null, { status: 204 })),
    )

    expect(verdict.status).toBe("ran")
    if (verdict.status !== "ran") return
    expect(verdict.outcome.status).toBe("idle")
  })
})
