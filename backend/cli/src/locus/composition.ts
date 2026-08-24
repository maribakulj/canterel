/**
 * Le composition root du worker — `W2.22`, `docs/locus/SPEC_V1.md` §15.
 *
 * # Ce que `W2.21` avait livré, et ce qui manquait
 *
 * `W2.21` a câblé le binaire : `src/cli/cmd/worker.ts` assemble les ports et les passe à
 * `runWorker`. Le chemin existe donc, contrairement à ce que la roadmap de `locusolus` en dit —
 * elle décrit un constat antérieur à la livraison de `W2.21`. Ce qui manquait est plus discret et
 * bien réel : **rien ne l'atteste**. La fonction d'assemblage était privée dans un module de
 * commande, donc hors d'atteinte d'un test, et les trois clauses du test de sortie de `W2.22` —
 * ça tourne, ça reste inerte en nommant ce qui manque, ça n'ouvre aucune connexion au démarrage —
 * n'avaient aucun sujet exécutable.
 *
 * # Pourquoi l'assemblage vit ici et non dans la commande
 *
 * Deux raisons, et la seconde est la vraie.
 *
 * La première : `backend/cli/src/locus/**` est le périmètre local (ADR 0010), donc ce qui s'y
 * trouve ne se paie pas à la synchronisation amont.
 *
 * La seconde : une fonction privée dans un module de commande **ne se teste pas**. Elle va chercher
 * son contexte elle-même — le répertoire de données du processus, `globalThis.fetch`, le module de
 * session amont — et un test qui voudrait l'éprouver devrait muter le processus. Ici, l'entourage
 * est un **paramètre** ([`Surroundings`]) : la commande le remplit avec le vrai monde, un test avec
 * un répertoire temporaire et un `fetch` qui refuse d'être appelé. C'est la même raison qui fait que
 * `loadConfig` prend `env` plutôt que de lire `process.env`.
 *
 * # Assembler n'ouvre rien
 *
 * §15 veut qu'un worker démarre sans réseau. La règle tient **par construction** et non par
 * vigilance : [`assemblePorts`] ne lit que le disque, et tout ce qui parlerait au dehors —
 * `claim`, `emit`, `report` — est une fermeture que `workerPorts` fabrique sans l'appeler. Le
 * manifeste lui-même est un *thunk* : sonder l'hôte est du travail, et le faire à l'assemblage le
 * ferait payer à `canterel worker status`, qui ne veut qu'un constat.
 */

import { loadCredential } from "./auth.ts"
import type { LocusConfig } from "./config.ts"
import { buildManifest } from "./capability-manifest.ts"
import { realProbe } from "./host-probe.ts"
import type { FetchLike } from "./connection.ts"
import { loadIdentity } from "./identity.ts"
import { locusStateDir } from "./registration.ts"
import { ResumeStore } from "./resume-store.ts"
import { sessionOpener, type SessionCreator } from "./session-open.ts"
import { workerPorts } from "./worker-client.ts"
import type { CapabilityManifestModelsItem } from "./lep/generated.ts"
import type { WorkerPorts } from "./worker-loop.ts"

/**
 * Ce que l'assemblage ne peut pas inventer, et qu'un appelant lui donne.
 *
 * Trois choses, et pas une de plus : où l'installation range son état, comment elle parle au réseau,
 * et comment elle ouvre une session amont. Tout le reste, ce module le construit.
 *
 * `fetch` en est un parce qu'un test doit pouvoir en fournir un qui **refuse** d'être appelé —
 * c'est ainsi que « le démarrage n'ouvre aucune connexion » devient une propriété vérifiable plutôt
 * qu'une intention écrite en commentaire.
 */
export type Surroundings = {
  /** La racine des données de l'installation — `locusStateDir` en dérive le sous-répertoire. */
  readonly dataDir: string
  /** Le transport. Jamais appelé pendant l'assemblage. */
  readonly fetch: FetchLike
  /** Le répertoire de travail d'une session, tel que l'amont le calcule. */
  readonly directory: string
  /** Ouvrir une session amont. */
  readonly create: SessionCreator
  /**
   * Les outils déclarés par cette installation.
   *
   * Optionnel, et son défaut est **la liste vide**, pas une liste inventée : annoncer un outil que
   * cette installation ne sait pas exécuter ferait admettre des missions qu'elle ne peut pas
   * honorer, et §15.4 fait de l'admission un refus argumenté — pas une promesse.
   */
  readonly tools?: WorkerPorts["tools"]
  /**
   * Les modèles que cette installation peut faire tourner — la porte `model_unavailable` de §10.2.
   *
   * Optionnel, et son absence **n'est pas** une liste vide : un manifeste sans champ `models` n'a
   * jamais été interrogé, un manifeste qui annonce `[]` l'a été et n'en a aucun.
   *
   * Ce que l'appelant fournit ici décide si le worker peut accepter quoi que ce soit : l'admission
   * refuse toute mission avec `model_unavailable` tant qu'aucun modèle n'est annoncé, et elle a
   * raison. Voir la note de [`assemblePorts`] sur ce que la couture ne fournit pas encore.
   */
  readonly models?: readonly CapabilityManifestModelsItem[]
}

/**
 * Le résultat d'un assemblage : des ports, ou ce qui a empêché de les faire.
 *
 * # Pourquoi `missing` et non `undefined`
 *
 * `W2.21` rendait `undefined`, et `runWorker` disait alors `inert` avec `missing: ["ports"]`. C'est
 * exact et inutilisable : l'utilisateur dont la créance a expiré lit le mot « ports », qui est un
 * terme interne, là où il devrait lire « la créance de cette installation est absente ». Un refus
 * qui nomme sa cause interne plutôt que la chose à corriger envoie lire le code source.
 */
export type Assembly =
  | { readonly ports: WorkerPorts }
  | {
      /** Ce qu'il faut fournir, sous les noms que l'utilisateur peut aller chercher. */
      readonly missing: readonly string[]
    }

/** Vrai quand cet assemblage a produit des ports. */
export function assembled(assembly: Assembly): assembly is { readonly ports: WorkerPorts } {
  return "ports" in assembly
}

/**
 * Assembler les ports du worker à partir d'une configuration et d'un entourage.
 *
 * # Ce qui est lu, et rien d'autre
 *
 * Le disque : l'identité (`W2.4`) et la créance (`W2.4`). Ce sont les deux seules choses qu'une
 * installation possède et qu'une configuration ne porte pas — la première dit qui elle est, la
 * seconde qu'elle a le droit de le dire.
 *
 * # Les manques sont cumulés, pas rendus un par un
 *
 * Une installation neuve manque des trois à la fois. Les rendre un par un obligerait à relancer la
 * commande trois fois pour apprendre trois choses qui étaient toutes connues au premier appel.
 *
 * # Ce que l'assemblage produit aujourd'hui, et ce qu'il refusera
 *
 * Un worker assemblé sans `models` **refuse toute mission**, avec le code `model_unavailable` de
 * §10.2 et le message « ce worker n'annonce aucun modèle ». C'est exact et c'est délibéré : la
 * couture ne sait pas encore dire, pour chaque fournisseur configuré en amont, si ses prompts
 * quittent la machine. Annoncer un modèle sans le savoir serait la faute la plus chère du dépôt —
 * un modèle marqué local alors qu'il est distant fait sortir un contexte confidentiel de l'hôte,
 * ce que §12.4 et l'invariant 11 interdisent, et l'admission n'aurait plus rien pour l'arrêter.
 *
 * Le refus, lui, ne coûte qu'une mission non prise. C'est `W2.23` qui lèvera cela, en **lisant**
 * l'adresse de chaque fournisseur plutôt qu'en la supposant : une base d'inférence sur la boucle
 * locale ne fait pas sortir les prompts, tout le reste si, et ce qui ne se lit pas est distant.
 */
export async function assemblePorts(config: LocusConfig, surroundings: Surroundings): Promise<Assembly> {
  const missing: string[] = []
  if (!config.endpoint) missing.push("locus.endpoint")

  const stateDir = locusStateDir(surroundings.dataDir)
  const identity = await loadIdentity(stateDir)
  if (!identity) missing.push("identité de worker (`canterel worker enroll`)")

  const credential = await loadCredential(stateDir)
  if (!credential) missing.push("créance de worker (`canterel worker enroll`)")

  if (!config.endpoint || !identity || !credential) return { missing }

  return {
    ports: workerPorts({
      endpoint: config.endpoint,
      fetch: surroundings.fetch,
      credential,
      store: new ResumeStore(stateDir),
      // Un *thunk* : sonder l'hôte est du travail, et le faire ici le ferait payer à qui ne demande
      // qu'un constat. `W20.q` veut de toute façon un manifeste **frais à chaque réclamation** — un
      // inventaire figé à l'assemblage ferait placer une mission sur un disque déjà plein.
      manifest: () =>
        buildManifest({
          probe: realProbe(),
          workerId: identity.public.worker_id,
          ...(surroundings.models === undefined ? {} : { models: surroundings.models }),
        }),
      tools: surroundings.tools ?? (() => []),
      openSession: sessionOpener({
        directory: surroundings.directory,
        create: surroundings.create,
      }),
    }),
  }
}
