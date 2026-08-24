import { describe, expect, test } from "bun:test"

import {
  ENV_BINDINGS,
  LAYER_ORDER,
  LocusConfigInvalid,
  LocusNotConfigured,
  describeConfig,
  layerFromEnv,
  loadConfig,
  mergeLayers,
  parseConfig,
  requireConnectable,
  resolveConfig,
  runWorker,
} from "../../src/locus/index.ts"

describe("priorité des couches — §6", () => {
  test("l'ordre déclaré est celui de la spec", () => {
    // L'ordre est une donnée, pas la suite des lignes d'une fonction : le lire permet de le
    // vérifier au lieu de le déduire.
    expect(LAYER_ORDER).toEqual(["cli", "env", "project", "user", "default"])
  })

  test("la couche la plus prioritaire gagne, quel que soit l'ordre d'arrivée", () => {
    const merged = mergeLayers([
      { name: "user", values: { endpoint: "http://user" } },
      { name: "cli", values: { endpoint: "http://cli" } },
      { name: "project", values: { endpoint: "http://project" } },
    ])
    expect(merged["endpoint"]).toBe("http://cli")
  })

  test("la fusion est profonde sur les objets", () => {
    const merged = mergeLayers([
      { name: "user", values: { reconnect: { initial_ms: 100, max_ms: 999 } } },
      { name: "cli", values: { reconnect: { initial_ms: 250 } } },
    ])
    // `max_ms` survit : une couche plus prioritaire qui ne parle pas d'un champ n'a pas d'avis
    // dessus, elle ne l'efface pas.
    expect(merged["reconnect"]).toEqual({ initial_ms: 250, max_ms: 999 })
  })

  test("la fusion remplace les tableaux au lieu de les concaténer", () => {
    // Concaténer voudrait dire qu'on ne peut jamais retirer un label hérité, seulement en
    // ajouter — une configuration dont on ne peut pas soustraire n'est pas une configuration.
    const merged = mergeLayers([
      { name: "user", values: { labels: ["gpu", "interactive"] } },
      { name: "cli", values: { labels: ["batch"] } },
    ])
    expect(merged["labels"]).toEqual(["batch"])
  })

  test("une couche n'écrase pas avec du vide", () => {
    const merged = mergeLayers([
      { name: "user", values: { identity: "macbook-01" } },
      { name: "cli", values: { identity: undefined } },
    ])
    expect(merged["identity"]).toBe("macbook-01")
  })
})

describe("défauts sûrs", () => {
  test("une configuration absente est valide, désactivée, et stricte", () => {
    const config = resolveConfig([])
    expect(config.enabled).toBe(false)
    // Les défauts sont les plus stricts que §6 propose, jamais les plus commodes : ils se
    // propagent dans toutes les installations qui n'ont rien configuré, c'est-à-dire la plupart.
    expect(config.security.reject_plaintext_secrets).toBe(true)
    expect(config.security.fail_closed_on_policy_error).toBe(true)
    expect(config.security.minimum_isolation_level).toBe("os-sandbox")
    expect(config.telemetry.redact_prompts).toBe(true)
    // Un worker qui n'a rien demandé ne prend pas quatre missions à la fois.
    expect(config.max_concurrency).toBe(1)
  })
})

describe("refus structurés", () => {
  test("un champ malformé porte son chemin, pas un message", () => {
    // Pointer `reconnect.max_ms` permet de pointer une ligne ; « configuration invalide » fait
    // relire tout le fichier.
    try {
      parseConfig({ reconnect: { max_ms: -1 } })
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusConfigInvalid.isInstance(error)).toBe(true)
      expect((error as InstanceType<typeof LocusConfigInvalid>).data.field).toBe("reconnect.max_ms")
    }
  })

  test("une variable d'environnement illisible est refusée, jamais ignorée", () => {
    // Un worker qui ignore `LOCUS_MAX_CONCURRENCY=beaucoup` et tourne à 1 fait quelque chose que
    // personne n'a demandé, sans le dire.
    expect(() => layerFromEnv({ LOCUS_MAX_CONCURRENCY: "beaucoup" })).toThrow()
    expect(() => layerFromEnv({ LOCUS_ENABLED: "peut-être" })).toThrow()
  })

  test("se connecter sans endpoint est une erreur distincte de la malformation", () => {
    // « Tu n'as rien configuré » et « ce que tu as configuré est faux » appellent deux gestes
    // différents de la part de qui lit l'erreur.
    const config = resolveConfig([{ name: "cli", values: { enabled: true } }])
    try {
      requireConnectable(config)
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusNotConfigured.isInstance(error)).toBe(true)
    }
  })

  test("une configuration valide mais désactivée n'est pas une erreur", () => {
    // C'est l'état de toute installation qui n'a jamais entendu parler de Locus.
    expect(() => resolveConfig([])).not.toThrow()
  })
})

describe("environnement", () => {
  test("les variables déclarées alimentent les champs annoncés", () => {
    const layer = layerFromEnv({
      LOCUS_ENDPOINT: "http://127.0.0.1:7420",
      LOCUS_IDENTITY: "canterel-macbook-01",
      LOCUS_LABELS: "local, interactive ,",
      LOCUS_MAX_CONCURRENCY: "4",
      LOCUS_ENABLED: "true",
    })
    expect(layer.name).toBe("env")
    expect(layer.values).toEqual({
      endpoint: "http://127.0.0.1:7420",
      identity: "canterel-macbook-01",
      labels: ["local", "interactive"],
      max_concurrency: 4,
      enabled: true,
    })
  })

  test("une variable vide est absente, pas vide", () => {
    // `LOCUS_ENDPOINT=` dans un shell veut dire « je n'en ai pas », pas « mon endpoint est la
    // chaîne vide ».
    expect(layerFromEnv({ LOCUS_ENDPOINT: "" }).values).toEqual({})
  })

  test("chaque liaison déclarée est réellement lue", () => {
    // Une liaison déclarée que le lecteur ignore est une variable documentée sans effet — pire
    // qu'une variable absente, parce qu'on croit l'avoir posée.
    for (const binding of ENV_BINDINGS) {
      const sample = binding.kind === "number" ? "2" : binding.kind === "boolean" ? "true" : "x"
      const layer = layerFromEnv({ [binding.variable]: sample })
      expect(Object.keys(layer.values)).toEqual([binding.path[0] as string])
    }
  })
})

describe("aucun secret dans la configuration", () => {
  test("le schéma ne comporte aucun champ sensible", () => {
    // §6 : « les secrets ne doivent jamais apparaître dans un fichier versionné, un log ou un
    // diagnostic exporté ». La façon la plus sûre de tenir la promesse est qu'il n'y ait rien à
    // omettre. Le token d'enrôlement de §7.2 est un argument à usage unique, pas un champ de
    // configuration, et ce test est là pour que l'ajouter demande de le décider explicitement.
    //
    // Le critère porte sur les champs qui pourraient **porter** un secret, pas sur les noms qui
    // en parlent : `reject_plaintext_secrets` est un drapeau de politique, un booléen ne transporte
    // pas de credential. Interdire le mot plutôt que la charge donnerait un test qu'on contourne
    // en renommant le champ — c'est-à-dire aucun test.
    const suspicious = /token|secret|password|credential|cookie|api_?key/i
    const leaks: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`))
      if (typeof value === "object" && value !== null) {
        for (const [key, nested] of Object.entries(value)) walk(nested, path ? `${path}.${key}` : key)
        return
      }
      const leaf = path.split(".").pop() ?? path
      if (suspicious.test(leaf) && typeof value === "string") leaks.push(path)
    }
    walk(describeConfig(resolveConfig([])), "")
    expect(leaks).toEqual([])
  })

  test("le rendu ne fuit rien de plus que ce qu'il annonce", () => {
    const config = resolveConfig([
      { name: "cli", values: { enabled: true, endpoint: "http://127.0.0.1:7420", identity: "w-1" } },
    ])
    expect(Object.keys(describeConfig(config)).sort()).toEqual([
      "drain_timeout_seconds",
      "enabled",
      "endpoint",
      "identity",
      "labels",
      "max_concurrency",
      "security",
      "telemetry",
    ])
  })
})

describe("le worker inerte — le test de sortie de W2.3", () => {
  test("il ne fait rien, et il le dit", async () => {
    const outcome = await runWorker(loadConfig({}))
    expect(outcome.status).toBe("inert")
    if (outcome.status !== "inert") return
    // « Vide » ne veut pas dire prêt : la liste dit ce qui manque pour se connecter. `ports` s'y
    // ajoute depuis `W2.20` — un worker à qui personne n'a donné de quoi agir ne doit pas rendre
    // « rien à faire », ce qui enverrait chercher un ordonnanceur vide.
    //
    // `locus.identity` **n'y est plus**, et l'absence est le correctif. La garde datait d'un moment
    // où l'identité d'un worker n'était qu'un champ de §6 écrit à la main ; `W2.4` a livré
    // l'enrôlement, et l'identité qui compte est la paire de clés du répertoire d'état, dont
    // `assemblePorts` nomme l'absence. La garde restée en place rendait **inerte un worker
    // correctement enrôlé** — constaté contre un `locusd` réel, pas déduit.
    expect(outcome.missing).toEqual(["locus.endpoint", "ports"])
  })

  test("un endpoint sans ports ne manque que de ports, même sans locus.identity", async () => {
    // Le pendant du test précédent, et celui qui aurait rougi **avant** le correctif : une
    // configuration qui a tout ce qui se lit réellement ne doit pas réclamer un champ que personne
    // ne lit. Sans lui, on saurait que `locus.identity` a disparu de la liste vide sans savoir
    // qu'il a disparu de la liste qui compte.
    const outcome = await runWorker(loadConfig({ LOCUS_ENDPOINT: "http://127.0.0.1:8787" }))
    expect(outcome.status).toBe("inert")
    if (outcome.status !== "inert") return
    expect(outcome.missing).toEqual(["ports"])
  })

  test("il résout ses couches réellement", async () => {
    // La commande passe `process.env` et une couche CLI ; c'est ce chemin-là qui compte.
    const config = loadConfig({ LOCUS_IDENTITY: "depuis-env", LOCUS_ENDPOINT: "http://depuis-env" }, [
      { name: "cli", values: { endpoint: "http://depuis-cli" } },
    ])
    expect(config.endpoint).toBe("http://depuis-cli")
    expect(config.identity).toBe("depuis-env")
    // Sans ports, il reste inerte — mais pour la seule raison qui reste vraie.
    const sansPorts = await runWorker(config)
    expect(sansPorts.status).toBe("inert")
    if (sansPorts.status !== "inert") return
    expect(sansPorts.missing).toEqual(["ports"])
  })

  test("il ne touche ni le réseau ni le disque", () => {
    // W2.3 dit « qui ne fait rien ». Un module de configuration qui ouvre un socket ou lit un
    // fichier au chargement rendrait le démarrage de la CLI dépendant de Locus par la bande.
    const source = require("node:fs").readFileSync(new URL("../../src/locus/config.ts", import.meta.url), "utf8")
    for (const forbidden of ["node:fs", "node:net", "fetch(", "Bun.file", "Bun.spawn"]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
