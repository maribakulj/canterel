import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { Credential } from "../../src/locus/auth.ts"
import { LocusContextRefused, LocusServerRejected } from "../../src/locus/errors.ts"
import { assertNamedByMission, viewContentHash } from "../../src/locus/context-materializer.ts"
import type { CapabilityManifest, ContextView, Lease, MissionEnvelope } from "../../src/locus/lep/generated.ts"
import { runLoop } from "../../src/locus/worker-loop.ts"
import { CLAIM_PATH, contextViewPath, workerPorts } from "../../src/locus/worker-client.ts"
import { ResumeStore } from "../../src/locus/resume-store.ts"
import { avecVue, estUneVue, vueScellee } from "./context-view-fixture.ts"

/**
 * Le test de sortie de `W20.ac.3` — le worker récupère la vue que sa mission nomme, et refuse celle
 * qu'on lui échange.
 *
 * # Pourquoi deux vérifications, et pourquoi une seule ne suffit pas
 *
 * `assertViewIntegrity` dit qu'un document est cohérent **avec lui-même**. Une vue échangée l'est
 * aussi : c'est une vraie vue, scellée par le même plan de contrôle, simplement pas celle que la
 * mission nomme. Le champ `hash` de §15.4 n'existe que pour cette confrontation-là, et sans elle il
 * serait un champ obligatoire que personne ne lit.
 *
 * # Ce que le refus n'est pas
 *
 * Ce n'est pas une **admission** refusée. §10.2 énumère quatorze codes, et aucun ne dit « ce
 * contexte n'est pas celui-là » ; en ajouter un serait une valeur d'énumération de plus dans un
 * mineur, ce que l'ADR 0017 interdit — un consommateur `1.0` cesserait de désérialiser. C'est un
 * refus de contexte, `LocusContextRefused`, comme les deux autres que ce module lève déjà.
 */

const FIXTURES = join(import.meta.dir, "fixtures")

function fixture<T>(nom: string): T {
  const brut = JSON.parse(readFileSync(join(FIXTURES, nom), "utf8")) as Record<string, unknown>
  const { _fixture, ...corps } = brut
  void _fixture
  return corps as T
}

const MISSION = () => fixture<MissionEnvelope>("mission-accepted.json")
const MANIFEST = () => fixture<CapabilityManifest>("manifest-vm-linux.json")

const CREDENTIAL: Credential = {
  worker_id: "worker-1",
  credential: "secret-de-worker",
  issued_at: "2026-08-24T12:00:00.000Z",
  expires_at: null,
  scope: ["worker"],
  labels: [],
}

function bail(mission: MissionEnvelope): Lease {
  return {
    protocol: mission.protocol,
    lease_id: "lease-1",
    task_id: mission.task_id,
    attempt: 1,
    worker_id: "worker-1",
    issued_at: "2026-08-24T12:00:00.000Z",
    expires_at: "2026-08-24T12:05:00.000Z",
    heartbeat_interval_seconds: 30,
    ttl_seconds: 300,
  }
}

/**
 * Un worker branché sur un serveur d'épreuve, et **ce qu'il a fait** : les URL demandées, et si la
 * session s'est ouverte.
 *
 * L'ouverture de session est observée plutôt que déduite : « le tour a échoué » ne dit pas si la
 * session avait déjà démarré, et c'est exactement ce que §12.3 demande — « vérifié **avant**
 * démarrage ».
 */
function worker(
  mission: MissionEnvelope,
  servir: (url: string) => Response,
): {
  readonly tour: () => ReturnType<typeof runLoop>
  readonly vu: { urls: string[]; methodes: string[]; sessions: number }
} {
  const vu = { urls: [] as string[], methodes: [] as string[], sessions: 0 }
  const ports = workerPorts({
    endpoint: "https://locus.example",
    fetch: async (url, init) => {
      vu.urls.push(String(url))
      vu.methodes.push(String(init?.method ?? "GET"))
      if (String(url).endsWith(CLAIM_PATH)) {
        return new Response(JSON.stringify({ mission, lease: bail(mission) }), { status: 200 })
      }
      return servir(String(url))
    },
    credential: CREDENTIAL,
    store: new ResumeStore(mkdtempSync(join(osTmpdir(), "locus-vue-"))),
    manifest: () => MANIFEST(),
    tools: () => [],
    openSession: async () => {
      vu.sessions += 1
      return { sessionId: "ses_01", events: [], output: {} }
    },
  })
  return { tour: () => runLoop(ports), vu }
}

/** Le serveur qui sert cette vue-là, et `{}` pour le reste. */
function sert(vue: ContextView): (url: string) => Response {
  return (url) =>
    estUneVue(url) ? new Response(JSON.stringify(vue), { status: 200 }) : new Response("{}", { status: 200 })
}

describe("le worker récupère la vue que sa mission nomme — W20.ac", () => {
  /**
   * **La vue est demandée, en `GET`, sur le chemin que `locusd` sert, et avant la session.**
   *
   * Les quatre affirmations d'un coup, parce qu'elles se cassent séparément : un `POST` sur une route
   * de lecture rendrait `405`, un chemin composé autrement rendrait `404`, et une récupération après
   * l'ouverture de session ne vérifierait plus rien.
   */
  test("la vue est demandée avant la session, en GET, sur le chemin servi", async () => {
    const vue = vueScellee()
    const mission = avecVue(MISSION(), vue)
    const { tour, vu } = worker(mission, sert(vue))

    const verdict = await tour()

    expect(verdict.status).toBe("ran")
    const rang = vu.urls.findIndex((url) => estUneVue(url))
    expect(rang).toBeGreaterThanOrEqual(0)
    expect(vu.urls[rang]).toBe(`https://locus.example${contextViewPath(vue.id)}`)
    expect(vu.methodes[rang]).toBe("GET")
    expect(vu.sessions).toBe(1)
  })

  /**
   * **Une vue échangée est refusée, et la session ne s'ouvre pas.**
   *
   * La vue servie est **parfaitement cohérente** — scellée par la même fonction, son empreinte est
   * bien celle de son contenu. Elle n'est simplement pas celle que la mission nomme.
   * `assertViewIntegrity` la laisserait passer sans rien remarquer ; c'est le cas que cet item
   * existe pour attraper.
   */
  test("une vue cohérente mais échangée est refusée avant la session", async () => {
    const attendue = vueScellee("ctx_attendue")
    // Servie sous le **nom** attendu, pour que seul le contenu diffère : sans ça, le refus viendrait
    // de l'identifiant, et la clause qui compte — l'empreinte — ne serait pas exercée.
    //
    // Le watermark bouge, et la vue est **rescellée** : c'est une vue parfaitement valide, arrêtée à
    // un autre instant du journal, donc décrivant autre chose que ce que l'agent pouvait connaître.
    // La première rédaction de ce test ne changeait que l'identifiant puis le remettait, ce qui
    // produisait le même document — le test passait sans rien éprouver, et c'est lui qui l'a dit.
    const echangee: ContextView = { ...attendue, source_event_watermark: attendue.source_event_watermark + 7 }
    const scellee: ContextView = { ...echangee, content_hash: viewContentHash(echangee) }
    expect(scellee.content_hash).not.toBe(attendue.content_hash)
    const mission = avecVue(MISSION(), attendue)
    const { tour, vu } = worker(mission, sert(scellee))

    await expect(tour()).rejects.toThrow(LocusContextRefused)
    expect(vu.sessions).toBe(0)
  })

  /**
   * **Une vue servie sous un autre nom est refusée aussi.**
   *
   * L'identifiant n'est pas décoratif : c'est lui qui rattache la vue à ce que le journal en dit. Un
   * document servi sous un autre nom mais de contenu identique décrirait le bon contexte sous une
   * provenance fausse.
   */
  test("un identifiant qui n'est pas celui de la mission est refusé", async () => {
    const vue = vueScellee("ctx_servie")
    const mission = avecVue(MISSION(), vueScellee("ctx_demandee"))
    const { tour, vu } = worker(mission, sert(vue))

    await expect(tour()).rejects.toThrow(LocusContextRefused)
    expect(vu.sessions).toBe(0)
  })

  /**
   * **Un document incohérent avec lui-même est refusé — et c'est l'autre contrôle.**
   *
   * Les deux vérifications ne font pas double emploi : celle-ci attrape un document altéré en
   * transit, celle du dessus un document intact mais étranger.
   */
  test("un document dont l'empreinte ne décrit pas son contenu est refusé", async () => {
    const vue = vueScellee()
    const mission = avecVue(MISSION(), vue)
    // Le contenu bouge, l'empreinte reste : exactement ce qu'une altération en transit produit.
    const altere: ContextView = { ...vue, source_event_watermark: vue.source_event_watermark + 1 }
    const { tour, vu } = worker(mission, sert(altere))

    await expect(tour()).rejects.toThrow(LocusContextRefused)
    expect(vu.sessions).toBe(0)
  })

  /**
   * **Une vue introuvable est une panne de transport, pas un refus de contexte.**
   *
   * Les deux envoient chercher à des endroits opposés : l'un un plan de contrôle qui n'a pas la vue
   * que sa propre mission nomme, l'autre un document qu'on a examiné et rejeté. Les fondre ferait
   * lire « contexte refusé » sur un `404`.
   */
  test("une vue absente lève un refus de serveur, pas un refus de contexte", async () => {
    const mission = avecVue(MISSION(), vueScellee())
    const { tour, vu } = worker(mission, (url) =>
      estUneVue(url) ? new Response("{}", { status: 404 }) : new Response("{}", { status: 200 }),
    )

    await expect(tour()).rejects.toThrow(LocusServerRejected)
    expect(vu.sessions).toBe(0)
  })
})

describe("les deux confrontations de assertNamedByMission", () => {
  /** **Elle passe quand les deux valeurs correspondent, et seulement alors.** */
  test("l'identifiant et l'empreinte sont confrontés tous les deux", () => {
    const vue = vueScellee("ctx_1")
    expect(() => assertNamedByMission(vue, { id: vue.id, hash: vue.content_hash })).not.toThrow()
    expect(() => assertNamedByMission(vue, { id: "ctx_2", hash: vue.content_hash })).toThrow(LocusContextRefused)
    expect(() => assertNamedByMission(vue, { id: vue.id, hash: "sha256:" + "ab".repeat(32) })).toThrow(
      LocusContextRefused,
    )
  })

  /** **Le refus nomme les deux valeurs**, sans quoi il faut rejouer la requête pour savoir laquelle. */
  test("le refus dit ce qui était attendu et ce qui est arrivé", () => {
    const vue = vueScellee("ctx_1")
    try {
      assertNamedByMission(vue, { id: vue.id, hash: "sha256:" + "cd".repeat(32) })
      throw new Error("le refus devait être levé")
    } catch (erreur) {
      expect(LocusContextRefused.isInstance(erreur)).toBe(true)
      const raison = String((erreur as { data: { reason: string } }).data.reason)
      expect(raison).toContain("cdcd")
      expect(raison).toContain(vue.content_hash)
    }
  })
})
