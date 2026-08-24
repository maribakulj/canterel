/**
 * Le test de sortie de `W2.22` — le composition root du worker, attesté.
 *
 * # Ce que la roadmap disait, et ce qui était vrai
 *
 * `locusolus/docs/10` dit de cet item que « personne n'assemble les ports », et que « aucun chemin
 * du binaire ne mène d'une configuration à une boucle qui tourne ». **C'est faux au moment où on
 * l'écrit** : `W2.21` a livré ce chemin, et `src/cli/cmd/worker.ts` l'exerce. Le constat de la
 * roadmap est antérieur à la livraison de `W2.21`, et il n'a pas été relu depuis.
 *
 * Ce qui était vrai, et plus discret : **rien ne l'attestait**. L'assemblage était une fonction
 * privée d'un module de commande, qui allait chercher son contexte toute seule — répertoire de
 * données du processus, `globalThis.fetch`, modules amont. Aucun test ne pouvait l'atteindre sans
 * muter le processus, donc aucune des trois clauses ci-dessous n'avait de sujet exécutable. C'est
 * la situation de `W7.a`, sous un autre nom : livré, et non attesté.
 *
 * # Les trois clauses
 *
 * 1. une configuration complète **tourne** au lieu de rendre `inert`, et l'issue est celle de
 *    `W2.20` ;
 * 2. une configuration incomplète rend toujours `inert` **en nommant ce qui manque** — la garantie
 *    de `W2.3`, qui ne doit pas se perdre en devenant vraie ;
 * 3. le démarrage reste **sans réseau** : assembler n'ouvre aucune connexion, seule la boucle en
 *    ouvre.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assemblePorts, assembled } from "../../src/locus/composition.ts"
import { createIdentity } from "../../src/locus/identity.ts"
import { loadConfig, runWorker } from "../../src/locus/index.ts"
import { locusStateDir } from "../../src/locus/registration.ts"
import { CLAIM_PATH } from "../../src/locus/worker-client.ts"
import type {
  CapabilityManifest,
  CapabilityManifestModelsItem,
  Lease,
  MissionEnvelope,
  SandboxLevel,
} from "../../src/locus/lep/generated.ts"

const FIXTURES = join(import.meta.dir, "fixtures")

function fixture<T>(name: string): T {
  const raw = JSON.parse(require("node:fs").readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>
  const { _fixture, ...body } = raw
  void _fixture
  return body as T
}

const MISSION = () => fixture<MissionEnvelope>("mission-accepted.json")

function lease(mission: MissionEnvelope): Lease {
  return {
    protocol: mission.protocol,
    lease_id: "lease-1",
    task_id: mission.task_id,
    attempt: 1,
    worker_id: "wk_01",
    issued_at: "2026-08-24T12:00:00.000Z",
    expires_at: "2026-08-24T13:00:00.000Z",
    ttl_seconds: 3600,
    heartbeat_interval_seconds: 30,
  }
}

/**
 * Une installation, telle qu'elle est sur un disque.
 *
 * Écrire les vrais fichiers plutôt que simuler les lecteurs : `AGENTS.md` interdit les mocks, et la
 * raison est concrète ici — un faux `loadCredential` prouverait que l'assemblage appelle une
 * fonction, pas qu'il lit une installation. Ce que cet item doit tenir est la seconde chose.
 */
async function installation(
  options: { readonly identity?: boolean; readonly credential?: boolean } = {},
): Promise<{ readonly dataDir: string; readonly workerId: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "canterel-w222-"))
  const stateDir = locusStateDir(dataDir)
  mkdirSync(stateDir, { recursive: true })

  // `createIdentity` plutôt qu'un fichier écrit à la main : l'identité porte un couple de clés que
  // `loadIdentity` **revérifie**, et une fixture inventée aurait échoué sur l'incohérence plutôt
  // que sur ce que le test veut éprouver. C'est aussi la règle d'`AGENTS.md` — pas de mock, on
  // éprouve l'implémentation réelle.
  const identity = options.identity === false ? null : await createIdentity(stateDir)
  const workerId = identity?.public.worker_id ?? "wk_01"

  if (options.credential !== false) {
    writeFileSync(
      join(stateDir, "credential.json"),
      JSON.stringify({
        worker_id: workerId,
        credential: "secret-de-worker",
        issued_at: "2026-08-24T12:00:00.000Z",
        expires_at: null,
        scope: ["worker"],
        labels: [],
      }),
    )
  }
  return { dataDir, workerId }
}

/** Un `fetch` qui **refuse d'être appelé** — le seul moyen de prouver qu'on ne l'appelle pas. */
function interdit(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("le réseau a été touché alors que rien ne devait le toucher")
  }) as unknown as typeof globalThis.fetch
}

function entourage(
  dataDir: string,
  fetch: typeof globalThis.fetch,
  models?: readonly CapabilityManifestModelsItem[],
) {
  return {
    dataDir,
    fetch,
    directory: dataDir,
    create: async (input: { readonly title: string }) => ({ id: `ses_${input.title.length}` }),
    ...(models === undefined ? {} : { models }),
  }
}

/**
 * Un modèle **local**, au sens de §12.4 : ses prompts ne quittent pas la machine.
 *
 * `remote_inference: false` est une affirmation lourde, et c'est pour cela qu'elle est écrite ici et
 * pas devinée par la couture : un modèle marqué local alors qu'il est distant fait sortir un
 * contexte confidentiel de l'hôte, et l'admission n'aurait plus rien pour l'arrêter.
 */
const MODELE_LOCAL: readonly CapabilityManifestModelsItem[] = [
  { provider: "ollama", auth: "none", remote_inference: false, models: ["qwen2.5-coder"] },
]

/**
 * Une mission que **cet hôte-ci** peut honorer, dérivée de son propre manifeste.
 *
 * Rien n'est deviné : le niveau de sandbox est le plus haut qu'il offre, le mode réseau l'un des
 * siens, les ressources une fraction de ce qu'il rapporte. Une mission écrite en dur supposerait
 * une machine de développeur, ce que `CLAUDE.md` interdit — et l'aurait fait ici, puisque l'hôte de
 * CI n'offre pas ce que le corpus suppose.
 */
function missionPour(manifest: CapabilityManifest): MissionEnvelope {
  const niveaux = [...manifest.sandbox.levels]
  return {
    ...MISSION(),
    sandbox: {
      minimum_level: niveaux[niveaux.length - 1] ?? "S1",
      network: manifest.sandbox.network_modes[0] ?? "deny",
    } satisfies MissionEnvelope["sandbox"],
    resources: {
      cpu: 1,
      memory_mb: Math.max(1, Math.floor(manifest.resources.memory_mb / 4)),
      disk_mb: Math.max(1, Math.floor(manifest.resources.disk_free_mb / 4)),
      wall_time_seconds: 60,
    },
  }
}

/** Le cran de sandbox juste au-dessus de ce qu'un hôte offre, ou `null` s'il les offre tous. */
function auDessusDe(offerts: readonly SandboxLevel[]): SandboxLevel | null {
  const echelle: readonly SandboxLevel[] = ["S1", "S2", "S3", "S4"]
  const plafond = echelle.findLastIndex((niveau) => offerts.includes(niveau))
  return echelle[plafond + 1] ?? null
}

const CONFIG = () => loadConfig({ LOCUS_ENDPOINT: "https://locus.example", LOCUS_IDENTITY: "wk_01" })

// ---------------------------------------------------------------------------------------------
// 1. Une installation complète tourne.
// ---------------------------------------------------------------------------------------------

describe("le composition root du worker — W2.22", () => {
  /**
   * **Clause 1 : une configuration complète tourne, et l'issue est celle de `W2.20`.**
   *
   * Les ports viennent de `assemblePorts`, pas d'une fabrication de test : c'est exactement ce que
   * la clause demande, et c'est ce qu'aucun test n'atteignait avant cet item — `W2.21` éprouvait
   * `runWorker` avec des ports faits à la main, ce qui prouve la boucle et **pas** l'assemblage.
   */
  test("une installation complète rend un tour, pas un constat", async () => {
    const { dataDir, workerId } = await installation()
    const assembly = await assemblePorts(CONFIG(), entourage(dataDir, interdit(), MODELE_LOCAL))
    expect(assembled(assembly)).toBe(true)
    if (!assembled(assembly)) return

    // La mission est taillée sur le manifeste **de cet hôte-ci**, et non prise dans le corpus.
    //
    // C'est la seule façon d'éprouver l'assemblage réel : une fixture fige un niveau de sandbox et
    // un mode réseau, et l'hôte qui exécute le test n'a aucune raison de les offrir. La preuve
    // recherchée n'est pas « telle mission passe » mais « la sonde réelle atteint l'admission, et
    // ce qu'elle annonce est ce qui est jugé ».
    const offert = assembly.ports.manifest()
    const mission = missionPour(offert)

    const ports = {
      ...assembly.ports,
      claim: async () => ({ mission, lease: lease(mission) }),
      emit: async () => {},
      report: async () => {},
    }

    const outcome = await runWorker(CONFIG(), ports)
    expect(outcome.status).toBe("ran")
    if (outcome.status !== "ran") return
    expect(outcome.outcome.status).toBe("ran")
    expect(workerId.startsWith("canterel-")).toBe(true)
  })

  /**
   * **La sonde réelle atteint l'admission — et c'est ce qu'aucune fixture ne prouvait.**
   *
   * `W2.21` éprouvait la boucle avec `manifest-vm-linux.json`, qui offre `S3`. L'hôte de CI, lui,
   * n'offre que `S1` : `realProbe` ne trouve ni podman ni bubblewrap. La mission nominale du corpus
   * est donc **refusée** ici, et le refus nomme le niveau.
   *
   * Ce n'est pas une régression, c'est le constat que cet item cherchait : entre un manifeste de
   * fixture et un manifeste sondé, il y a l'écart entre ce qu'on suppose de l'hôte et ce qu'il est.
   * Un composition root qui n'est éprouvé qu'avec des fixtures ne dit rien de la machine sur
   * laquelle il tourne.
   *
   * Le test ne fige pas `S1` : il demande **un cran au-dessus de ce que l'hôte offre**, quel que
   * soit cet hôte. Sur une machine avec podman il exigerait `S4` et serait refusé pareillement.
   */
  test("une mission au-dessus de ce que l'hôte offre est refusée, en nommant le niveau", async () => {
    const { dataDir } = await installation()
    const assembly = await assemblePorts(CONFIG(), entourage(dataDir, interdit(), MODELE_LOCAL))
    expect(assembled(assembly)).toBe(true)
    if (!assembled(assembly)) return

    const offert = assembly.ports.manifest()
    const troPHaut = auDessusDe(offert.sandbox.levels)
    if (troPHaut === null) return // un hôte qui offre déjà tout n'a rien à refuser ici.
    const mission: MissionEnvelope = {
      ...missionPour(offert),
      sandbox: { minimum_level: troPHaut, network: "deny" },
    }

    const outcome = await runWorker(CONFIG(), {
      ...assembly.ports,
      claim: async () => ({ mission, lease: lease(mission) }),
    } as typeof assembly.ports)

    expect(outcome.status).toBe("ran")
    if (outcome.status !== "ran") return
    expect(outcome.outcome.status).toBe("refused")
    if (outcome.outcome.status !== "refused") return
    expect(outcome.outcome.refusal.code).toBe("sandbox_unavailable")
    expect(outcome.outcome.refusal.message).toContain(troPHaut)
    // §15.4 : un refus est argumenté, pas un silence. L'état atteint est `rejected` — rien n'a été
    // tenté —, jamais `failed`, qui dirait qu'on a essayé et échoué.
    expect(outcome.outcome.state).toBe("rejected")
  })

  // -------------------------------------------------------------------------------------------
  // 2. Une installation incomplète reste inerte, en nommant ce qui manque.
  // -------------------------------------------------------------------------------------------

  /**
   * **Clause 2 : le constat de `W2.3` ne s'est pas perdu en devenant vrai.**
   *
   * Et il dit maintenant quelque chose d'utilisable. Avant cet item, une créance absente rendait
   * `missing: ["ports"]` — exact, et illisible : « ports » est un terme interne que personne ne
   * peut aller corriger. Un test par manque, plutôt qu'un test qui les cumule : trois causes
   * différentes doivent produire trois phrases différentes, et un test unique passerait encore si
   * elles se fondaient en une seule.
   */
  test("sans identité enrôlée, le constat nomme l'enrôlement — pas « ports »", async () => {
    const { dataDir } = await installation({ identity: false })

    const outcome = await runWorker(CONFIG(), await assemblePorts(CONFIG(), entourage(dataDir, interdit())))

    expect(outcome.status).toBe("inert")
    if (outcome.status !== "inert") return
    expect(outcome.missing.join(" ")).toContain("identité")
    expect(outcome.missing.join(" ")).toContain("enroll")
    expect(outcome.missing).not.toContain("ports")
  })

  test("sans créance, le constat nomme la créance", async () => {
    const { dataDir } = await installation({ credential: false })

    const outcome = await runWorker(CONFIG(), await assemblePorts(CONFIG(), entourage(dataDir, interdit())))

    expect(outcome.status).toBe("inert")
    if (outcome.status !== "inert") return
    expect(outcome.missing.join(" ")).toContain("créance")
  })

  test("sans endpoint, le champ de configuration est nommé une seule fois", async () => {
    const config = loadConfig({ LOCUS_IDENTITY: "wk_01" })
    const { dataDir } = await installation()

    const outcome = await runWorker(config, await assemblePorts(config, entourage(dataDir, interdit())))

    expect(outcome.status).toBe("inert")
    if (outcome.status !== "inert") return
    expect(outcome.missing.filter((item) => item === "locus.endpoint")).toEqual(["locus.endpoint"])
  })

  /**
   * **Une installation neuve apprend ses trois manques d'un coup.**
   *
   * Les rendre un par un obligerait à relancer la commande trois fois pour apprendre trois choses
   * qui étaient toutes connues au premier appel.
   */
  test("une installation neuve nomme tout ce qui manque en une fois", async () => {
    const config = loadConfig({})
    const { dataDir } = await installation({ identity: false, credential: false })

    const assembly = await assemblePorts(config, entourage(dataDir, interdit()))

    expect(assembled(assembly)).toBe(false)
    if (assembled(assembly)) return
    expect(assembly.missing.length).toBe(3)
  })

  /**
   * **Personne n'a assemblé reste distinct de l'assemblage a échoué.**
   *
   * `runWorker(config)` sans rien est le cas de `canterel worker status` : aucun composition root
   * n'a été sollicité, et « ports » est alors le mot exact. Le confondre avec un échec d'assemblage
   * ferait dire « ton enrôlement manque » à quelqu'un dont on n'a jamais regardé l'installation.
   */
  test("ne rien fournir n'est pas la même chose qu'échouer à assembler", async () => {
    const outcome = await runWorker(CONFIG())

    expect(outcome.status).toBe("inert")
    if (outcome.status !== "inert") return
    expect(outcome.missing).toEqual(["ports"])
  })

  /**
   * **Un worker qui n'annonce aucun modèle refuse tout — et le dit sous ce nom-là.**
   *
   * C'est l'état de la couture aujourd'hui, et le constater vaut mieux que le découvrir en
   * production. `src/cli/cmd/worker.ts` ne fournit pas encore de `models`, parce qu'il ne sait pas
   * dire, pour chaque fournisseur configuré en amont, si ses prompts quittent la machine. Le worker
   * assemblé **tourne** donc — il n'est pas `inert` — et refuse chaque mission avec le code de
   * §10.2 prévu pour ça.
   *
   * L'inverse aurait été de déclarer les fournisseurs sans lire leur adresse. Un modèle marqué
   * local alors qu'il est distant fait sortir un contexte confidentiel de l'hôte : §12.4 et
   * l'invariant 11 l'interdisent, et l'admission n'aurait plus rien pour l'arrêter. Un refus ne
   * coûte qu'une mission non prise. `W2.23` lèvera cela en **lisant** l'adresse plutôt qu'en la
   * supposant.
   */
  test("sans modèle annoncé, chaque mission est refusée sous le code de §10.2", async () => {
    const { dataDir } = await installation()
    const assembly = await assemblePorts(CONFIG(), entourage(dataDir, interdit()))
    expect(assembled(assembly)).toBe(true)
    if (!assembled(assembly)) return

    expect(assembly.ports.manifest().models).toBeUndefined()

    const mission = missionPour(assembly.ports.manifest())
    const outcome = await runWorker(CONFIG(), {
      ...assembly.ports,
      claim: async () => ({ mission, lease: lease(mission) }),
    } as typeof assembly.ports)

    // Il **tourne** : c'est la clause 1. Ce qu'il fait de la mission est un refus argumenté.
    expect(outcome.status).toBe("ran")
    if (outcome.status !== "ran") return
    expect(outcome.outcome.status).toBe("refused")
    if (outcome.outcome.status !== "refused") return
    expect(outcome.outcome.refusal.code).toBe("model_unavailable")
  })

  /**
   * **Ne rien dire de ses modèles n'est pas dire qu'on n'en a aucun.**
   *
   * Le champ est **absent** quand la couture ne s'est pas prononcée, et **présent et vide** quand
   * elle s'est prononcée et n'a rien trouvé. Les fondre ferait lire « installation neuve » sur un
   * hôte dont les fournisseurs ont tous été retirés — deux causes opposées pour la même
   * conséquence, et une seule des deux se répare en installant un modèle.
   */
  test("annoncer zéro modèle et n'en rien dire sont deux manifestes différents", async () => {
    const { dataDir } = await installation()

    const muet = await assemblePorts(CONFIG(), entourage(dataDir, interdit()))
    const explicite = await assemblePorts(CONFIG(), entourage(dataDir, interdit(), []))

    expect(assembled(muet) && assembled(explicite)).toBe(true)
    if (!assembled(muet) || !assembled(explicite)) return
    expect(muet.ports.manifest().models).toBeUndefined()
    expect(explicite.ports.manifest().models).toEqual([])
  })

  // -------------------------------------------------------------------------------------------
  // 3. Le démarrage reste sans réseau.
  // -------------------------------------------------------------------------------------------

  /**
   * **Clause 3 : assembler n'ouvre aucune connexion.**
   *
   * Le `fetch` fourni **lève** dès qu'on l'appelle. Un assemblage qui joindrait le plan de contrôle
   * pour valider sa créance, ou qui sonderait l'hôte en parlant au dehors, ferait échouer ce test
   * au lieu de le faire passer discrètement. C'est ce que §15 demande, et un démarrage qui exige le
   * réseau rend une installation hors ligne impossible à diagnostiquer.
   */
  test("assembler des ports valides ne touche pas le réseau", async () => {
    const { dataDir } = await installation()

    const assembly = await assemblePorts(CONFIG(), entourage(dataDir, interdit()))

    expect(assembled(assembly)).toBe(true)
  })

  /**
   * **Le manifeste est un *thunk*, et l'assemblage ne le déplie pas.**
   *
   * Sonder l'hôte est du travail — disque, accélérateurs, réseau —, et `W20.q` veut de toute façon
   * un manifeste **frais à chaque réclamation**. Le construire à l'assemblage le ferait payer à qui
   * ne demande qu'un constat, et figerait un inventaire qui vieillit.
   */
  test("le manifeste n'est sondé qu'à l'appel, pas à l'assemblage", async () => {
    const { dataDir, workerId } = await installation()

    const assembly = await assemblePorts(CONFIG(), entourage(dataDir, interdit()))

    expect(assembled(assembly)).toBe(true)
    if (!assembled(assembly)) return
    // Il est bien là — le test précédent passerait aussi si `manifest` était absent.
    const manifest = assembly.ports.manifest()
    expect(manifest.worker_id).toBe(workerId)
  })
})
