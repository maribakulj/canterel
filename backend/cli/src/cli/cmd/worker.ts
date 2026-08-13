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
export const WorkerCommand = cmd({
  command: "worker",
  describe: "run this installation as a Locus Solus worker",
  builder: (yargs: Argv) =>
    yargs
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

    const outcome = locus.runWorker(config)

    UI.println(`worker: ${outcome.status}`)
    UI.println(JSON.stringify(outcome.config, null, 2))
    if (outcome.missing.length > 0) {
      UI.println(`incomplet — manque : ${outcome.missing.join(", ")}`)
    }
  },
})
