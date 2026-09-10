/**
 * Ce qui fait **travailler** une session ouverte pour une mission, et compte ce qu'elle dépense.
 *
 * # Pourquoi ce fichier est du côté `cli/` et pas du côté `locus/`
 *
 * ADR 0010 : `src/locus/**` n'importe rien de `src/session/**`. La couture est une frontière de
 * données — un plan à l'aller, des observations au retour —, et c'est ce qui permet à une refonte
 * amont de ne rien casser dans la couche protocolaire. Ce module est du côté qui **connaît les
 * deux**, comme `surroundingsFor` l'est déjà pour `Session.createNext`.
 *
 * # Le budget s'oppose ici, parce que c'est ici qu'on voit passer les appels
 *
 * `SessionPrompt.prompt` est un tour d'agent : il peut faire dix appels de modèle avant de rendre
 * la main. Décider avant l'appel ne bornerait donc qu'une chose sur dix, et décider après le tour
 * ne bornerait rien du tout — le dépassement serait constaté une fois payé.
 *
 * Chaque appel de modèle produit un message assistant, publié sur le bus avec ses jetons et son
 * coût. On les compte à mesure, et on **annule la session** dès que le compteur atteint le plafond.
 *
 * Ce que cela ne peut pas faire, et qu'il faut savoir : le dépassement se constate **après** l'appel
 * qui le cause. On ne connaît le coût d'un appel qu'une fois fait, et prétendre l'estimer avant
 * ferait décider un arrêt sur un chiffre inventé. La borne est donc « au plus un appel au-delà »,
 * et c'est une propriété du monde, pas de ce code.
 */

import { Bus } from "@/bus"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"

/**
 * Les types de la couche Locus, désignés **en position de type** plutôt qu'importés.
 *
 * §28.8 veut qu'une couture soit paresseuse : elle désigne Locus dynamiquement, jamais
 * statiquement, et `import type { … } from "@/locus/…"` compte comme statique — la garde lit un
 * `from "…"`, pas une intention. La forme `import("…").T` est effacée à la compilation **et** ne
 * met rien dans le graphe de démarrage, ce qui est exactement ce que la règle demande.
 */
type Usage = import("@/locus/usage-meter").Usage
type SessionRunner = import("@/locus/session-open").SessionRunner

const log = Log.create({ service: "locus-run" })

/**
 * Ce qu'un message assistant apprend au compteur.
 *
 * Quatre observations d'une même requête, et non une seule : §17.1 borne les dimensions
 * séparément, et un budget épuisé côté entrée pendant que la sortie a de la marge se répare
 * autrement qu'un budget épuisé partout.
 *
 * `provider_request_id` porte l'identifiant du **message**, qui est ce que cette installation a de
 * plus proche d'un identifiant de requête fournisseur. Il sert au compteur à ne pas additionner
 * deux fois la même dépense si une observation facturée arrivait plus tard pour la même requête.
 *
 * Les jetons de raisonnement comptent avec la sortie : ils sont produits par le modèle et facturés
 * comme tels ; les ranger ailleurs ferait un plafond de sortie qu'un modèle « thinking » ne
 * toucherait jamais.
 *
 * `kind: "billed"` parce que ces chiffres viennent du fournisseur par le SDK, pas d'une estimation
 * locale — et `confidence: 1` le dit, plutôt que de laisser le défaut prudent de 0,5 décider d'un
 * arrêt sur une mesure qu'on tient pourtant du payeur.
 */
export function usagesOf(message: MessageV2.Assistant): readonly Usage[] {
  const source = `${message.providerID}/${message.modelID}`
  const commun = { source, kind: "billed", confidence: 1, provider_request_id: message.id } as const
  return [
    { dimension: "model_calls", observed: 1, ...commun },
    { dimension: "input_tokens", observed: message.tokens.input, ...commun },
    { dimension: "output_tokens", observed: message.tokens.output + message.tokens.reasoning, ...commun },
    { dimension: "cost", observed: message.cost, ...commun },
  ]
}

/**
 * Le pilote de session — l'implémentation de [`SessionRunner`] pour cette installation.
 *
 * # Un seul tour, et c'est délibéré
 *
 * La mission entre comme une question, et ce module ne relance pas. Une boucle qui redemanderait
 * jusqu'à satisfaction des `success_conditions` serait un orchestrateur, ce qui est un autre item
 * et une autre décision — notamment sur ce qui l'arrête quand le modèle n'y arrive pas.
 */
export function sessionRunner(): SessionRunner {
  return async ({ sessionId, plan }) => {
    const { UsageMeter } = await import("@/locus/usage-meter")
    const meter = new UsageMeter(plan.budget)
    // Le premier choix utilisable du plan : `usableModels` les a déjà filtrés par classe de
    // données, et le premier est celui que la politique préfère. En choisir un autre ici
    // reviendrait à décider à sa place, hors de l'endroit qui porte la règle.
    const choix = plan.models.find((entree) => entree.models.length > 0)

    // Un plan sans modèle utilisable ne s'exécute pas, et `mapMission` refuse déjà la mission dans
    // ce cas (`model_unavailable`). Arriver ici sans modèle serait donc un défaut d'ici ; le dire
    // vaut mieux que d'appeler un fournisseur par défaut, qui dépenserait sur un compte que
    // personne n'a choisi.
    if (!choix) {
      return { output: { refused: "aucun modèle utilisable dans le plan" }, usages: [] }
    }

    // # Le mode réseau de la mission, appliqué à cette session
    //
    // La politique de bac à sable de l'installation est machine-globale ; la mission, elle, porte
    // la sienne, et le manifeste annonce que ce worker sait appliquer les deux. Sans cette ligne,
    // l'annonce était fausse : le mode voyageait du daemon jusqu'au plan et s'arrêtait là.
    //
    // `finally` rend la contrainte : elle ne doit pas survivre à la mission qui l'a demandée.
    const { ExecutionAuthority } = await import("@/project/execution")
    ExecutionAuthority.constrainSession(sessionId, plan.network === "deny" ? "deny" : "allow")

    let arrete = false
    const desabonner = Bus.subscribe(MessageV2.Event.Updated, (event) => {
      const info = event.properties.info
      if (info.role !== "assistant" || info.sessionID !== sessionId) return
      // Un message assistant est republié à chaque fragment. On ne compte qu'une fois **terminé** :
      // les jetons d'un message en cours sont partiels, et les additionner à chaque republication
      // compterait la même requête autant de fois qu'elle a de fragments.
      if (info.time.completed === undefined) return
      for (const usage of usagesOf(info)) meter.record(usage)

      const rapport = meter.report()
      if (rapport.stage === "stop" && !arrete) {
        arrete = true
        log.warn("budget atteint, session annulée", {
          sessionId,
          exceeded: rapport.exceeded.join(", "),
          totals: JSON.stringify(rapport.totals),
        })
        SessionPrompt.cancel(sessionId)
      }
    })

    try {
      await SessionPrompt.prompt({
        sessionID: sessionId,
        model: { providerID: choix.provider, modelID: choix.models[0]! },
        agent: plan.overlay.agent,
        parts: [{ type: "text", text: question(plan) }],
      })
    } finally {
      desabonner()
      ExecutionAuthority.releaseSession(sessionId)
    }

    const rapport = meter.report()
    return {
      output: {
        // **Ce que la session a répondu**, et c'est le champ qui compte.
        //
        // Sans lui, le résultat d'une mission ne portait que l'état de son budget : `locusd` le
        // stockait, la route `GET /tasks/{id}/result` le resservait fidèlement, et une étape
        // d'orchestration qui relisait la précédente y trouvait « budget_stage: nominal » — donc
        // rien d'utilisable. Le relais était complet de bout en bout et vide de substance.
        summary: await derniereReponse(sessionId),
        stopped_on_budget: arrete,
        budget_stage: rapport.stage,
        budget_exceeded: rapport.exceeded,
      },
      usages: meter.observations(),
    }
  }
}

/**
 * Le texte de la dernière réponse de l'assistant, ou une chaîne vide.
 *
 * # Relu du stockage plutôt que retenu du bus
 *
 * Les fragments arrivent sur le bus, et les assembler à la volée demanderait de suivre l'ordre des
 * parties, les révisions, et les messages abandonnés. Le stockage a déjà fait ce travail : après
 * `prompt`, la session **est** son état final, et le relire est exact par construction.
 *
 * Vide quand la session n'a rien produit — un budget épuisé au premier appel, par exemple. Une
 * chaîne vide dit « rien à relayer » ; inventer un texte dirait le contraire.
 */
async function derniereReponse(sessionId: string): Promise<string> {
  try {
    const messages = await Session.messages({ sessionID: sessionId })
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.info.role !== "assistant") continue
      const texte = message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim()
      if (texte.length > 0) return texte
    }
  } catch (err) {
    log.warn("réponse illisible", { sessionId, reason: (err as Error).message })
  }
  return ""
}

/**
 * La question posée à la session.
 *
 * Les conditions de succès y figurent parce que §15.4 en fait une partie de l'objectif : une
 * mission dit à quoi on reconnaîtra qu'elle est traitée, et les taire demanderait à l'agent de le
 * deviner. Rien d'autre n'est ajouté — pas de consignes de style, pas de rappel de confinement :
 * ce qui contraint l'exécution est appliqué par le plan, pas demandé poliment au modèle.
 */
export function question(plan: {
  readonly objective: { readonly statement: string; readonly successConditions: readonly string[] }
}): string {
  const conditions = plan.objective.successConditions.map((ligne) => `- ${ligne}`).join("\n")
  return conditions.length > 0
    ? `${plan.objective.statement}\n\nConditions de succès :\n${conditions}`
    : plan.objective.statement
}
