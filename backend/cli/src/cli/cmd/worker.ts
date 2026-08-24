import type { Argv } from "yargs"

import { cmd } from "./cmd"
import { UI } from "../ui"

/**
 * `canterel worker` — la couture entre la CLI historique et la couche Locus.
 *
 * C'est le seul fichier hors de `src/locus/**` autorisé à désigner Locus, et il est déclaré comme
 * tel dans `src/locus/standalone.ts` (`LOCUS_SEAMS`). Deux conséquences tenues par la CI de §28.8 :
 *
 * 1. l'import de `@/locus` est **dynamique**, dans le handler. Statique, il mettrait toute la
 *    couche Locus dans le graphe de démarrage de la CLI autonome — précisément ce que
 *    `docs/locus/CLAUDE.md` interdit, et le garde-fou rougirait ;
 * 2. ce fichier reste **mince**. La logique vit sous `src/locus/**` ; ce qui est ici sera payé à
 *    chaque synchronisation amont, ce qui n'est pas là ne le sera pas.
 *
 * L'idiome n'est pas une invention locale : `src/index.ts` charge déjà ses routes de credentials
 * par import dynamique, avec la même raison écrite au-dessus.
 */
/**
 * `canterel worker enroll` — §7.2, l'enrôlement explicite.
 *
 * Sous-commande séparée exprès : §7.2 dit « le premier enrôlement doit être explicite ». Le fondre
 * dans `worker` ferait qu'un simple démarrage pourrait enrôler la machine, ce qui est exactement
 * ce que « explicite » exclut.
 */
export const WorkerEnrollCommand = cmd({
  command: "enroll",
  describe: "enroll this installation with a Locus Solus control plane (§7.2)",
  builder: (yargs: Argv) =>
    yargs
      .option("locus", { type: "string", describe: "URL of the control plane", demandOption: true })
      .option("enrollment-token", {
        type: "string",
        describe: "short-lived, single-use enrollment token (§7.2)",
        demandOption: true,
      }),
  handler: async (args) => {
    const locus = await import("@/locus")
    const { Global } = await import("@/global")

    const endpoint = String(args.locus)
    const stateDir = locus.locusStateDir(Global.Path.data)

    try {
      // Le transport valide l'endpoint (§7.3) à sa construction. Le construire **avant** de
      // charger l'identité évite qu'une commande refusée laisse une identité derrière elle : un
      // effet de bord sur un refus est une surprise, même bénigne.
      const transport = locus.httpEnrollmentTransport({ endpoint, fetch: globalThis.fetch })
      const identity = await locus.loadOrCreateIdentity(stateDir)
      const credential = await locus.enroll({
        identity,
        endpoint,
        // Le token vient de la ligne de commande et n'est jamais écrit : §7.2 dit qu'il « ne
        // devient pas le secret permanent du worker ».
        token: String(args["enrollment-token"]),
        transport,
      })
      await locus.saveCredential(stateDir, credential)
      UI.println(`enrôlé : ${identity.public.worker_id}`)
      UI.println(`scope : ${credential.scope.join(", ") || "(aucun)"}`)
    } catch (error) {
      if (!reportLocusError(locus, error)) throw error
      process.exitCode = 1
    }
  },
})

/** `canterel worker status` — ce que cette installation est, sans rien contacter. */
export const WorkerStatusCommand = cmd({
  command: "status",
  describe: "show this worker's identity and advertised capabilities (§5.2)",
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    const locus = await import("@/locus")
    const { Global } = await import("@/global")

    const stateDir = locus.locusStateDir(Global.Path.data)
    const identity = await locus.loadIdentity(stateDir)
    if (!identity) {
      UI.println("aucune identité : cette installation n'est pas enrôlée")
      return
    }
    const manifest = locus.buildManifest({ probe: locus.realProbe(), workerId: identity.public.worker_id })
    UI.println(JSON.stringify({ identity: locus.describeIdentity(identity), manifest }, null, 2))
  },
})

/** Rendre une erreur Locus lisible. Vrai quand elle a été reconnue et affichée. */
function reportLocusError(locus: typeof import("@/locus"), error: unknown): boolean {
  if (locus.LocusConfigInvalid.isInstance(error)) {
    UI.error(`configuration Locus invalide — ${error.data.field} : ${error.data.reason}`)
    return true
  }
  if (locus.LocusEnrollmentRefused.isInstance(error)) {
    UI.error(`enrôlement refusé — ${error.data.reason}`)
    return true
  }
  if (locus.LocusServerRejected.isInstance(error)) {
    UI.error(`serveur refusé — ${error.data.endpoint} : ${error.data.reason}`)
    return true
  }
  if (locus.LocusIdentityUnusable.isInstance(error)) {
    UI.error(`identité inutilisable — ${error.data.path} : ${error.data.reason}`)
    return true
  }
  return false
}

/**
 * Assembler les ports du worker, ou rendre `undefined` quand l'installation n'a pas de quoi agir.
 *
 * Rendre `undefined` plutôt que de lever : `runWorker` sait déjà dire « inerte, et voici ce qui
 * manque ». Lever ici transformerait une installation incomplète en panne, alors que c'est une
 * information — la distinction que `W2.3` a posée et que cet item ne défait pas.
 */
async function workerPortsFor(
  locus: typeof import("@/locus"),
  config: Awaited<ReturnType<typeof locus.loadConfig>>,
): Promise<Parameters<typeof locus.runWorker>[1]> {
  if (!config.endpoint) return undefined
  const { Global } = await import("@/global")
  const stateDir = locus.locusStateDir(Global.Path.data)

  const identity = await locus.loadIdentity(stateDir)
  const credential = await locus.loadCredential(stateDir)
  if (!identity || !credential) return undefined

  const { Session } = await import("@/session")
  const { Instance } = await import("@/project/instance")

  return locus.workerPorts({
    endpoint: config.endpoint,
    fetch: globalThis.fetch,
    credential,
    store: new locus.ResumeStore(stateDir),
    manifest: () => locus.buildManifest({ probe: locus.realProbe(), workerId: identity.public.worker_id }),
    // Aucun outil déclaré tant que l'inventaire d'outils n'est pas branché : une liste inventée
    // ferait admettre des missions que cette installation ne sait pas honorer.
    tools: () => [],
    openSession: locus.sessionOpener({
      directory: Instance.directory,
      create: async (input) => Session.createNext({ title: input.title, directory: input.directory }),
    }),
  })
}

export const WorkerCommand = cmd({
  command: "worker",
  describe: "run this installation as a Locus Solus worker",
  builder: (yargs: Argv) =>
    yargs
      .command(WorkerEnrollCommand)
      .command(WorkerStatusCommand)
      .option("locus", {
        type: "string",
        describe: "URL of the Locus Solus control plane (locus.endpoint)",
      })
      .option("identity", {
        type: "string",
        describe: "stable worker identity (locus.identity)",
      })
      .option("labels", {
        type: "string",
        describe: "comma-separated scheduling labels (locus.labels)",
      }),
  handler: async (args) => {
    // Import dynamique : c'est lui qui garde `src/locus/**` hors du graphe de démarrage.
    const locus = await import("@/locus")

    // Les options de ligne de commande forment la couche la plus prioritaire de §6. Les champs
    // absents sont omis plutôt que mis à `undefined` : une couche qui pose `undefined` écraserait
    // ce que les couches moins prioritaires ont légitimement fourni.
    const values: Record<string, unknown> = { enabled: true }
    if (args.locus) values["endpoint"] = args.locus
    if (args.identity) values["identity"] = args.identity
    if (args.labels)
      values["labels"] = String(args.labels)
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0)

    // Une erreur de configuration est structurée (`LocusConfigInvalid`), et le formateur d'erreurs
    // amont ne la connaît pas : sans ce catch, l'utilisateur lit « Unexpected error, check log
    // file » là où la couche Locus sait exactement quel champ est fautif. Adapter une erreur Locus
    // au terminal est précisément le travail d'une couture — et le faire ici évite de toucher
    // `src/cli/error.ts`, qui serait un hunk amont de plus à payer à chaque synchronisation.
    let config
    try {
      config = locus.loadConfig(process.env, [{ name: "cli", values }])
    } catch (error) {
      if (locus.LocusConfigInvalid.isInstance(error)) {
        UI.error(`configuration Locus invalide — ${error.data.field} : ${error.data.reason}`)
        process.exitCode = 1
        return
      }
      throw error
    }

    // `W2.21` : la couture assemble ce que la boucle ne peut pas aller chercher elle-même. C'est ici,
    // et seulement ici, que `Session.createNext` de l'amont est nommé — `src/locus/**` n'importe rien
    // de `src/session/`, et c'est ce qui fait qu'une refonte amont ne casse rien là-bas. Ce qui
    // traverse dans les deux sens est de la donnée : un plan à l'aller, un compte rendu au retour.
    const outcome = await locus.runWorker(config, await workerPortsFor(locus, config))

    UI.println(`worker: ${outcome.status}`)
    UI.println(JSON.stringify(outcome.config, null, 2))
    if (outcome.status === "inert" && outcome.missing.length > 0) {
      UI.println(`incomplet — manque : ${outcome.missing.join(", ")}`)
    }
  },
})
