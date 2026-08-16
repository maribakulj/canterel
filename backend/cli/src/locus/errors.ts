import { NamedError } from "@synsci/util/error"
import z from "zod"

/**
 * Les erreurs de la couche Locus — structurées, jamais des chaînes.
 *
 * `NamedError` est l'idiome du dépôt amont : un nom stable, une charge typée par zod, un
 * `toObject()` sérialisable. S'en écarter donnerait des erreurs que le serveur amont ne sait pas
 * transporter, et §10.2 exigera plus tard des refus lisibles par la machine, pas des messages.
 *
 * Deux erreurs seulement, et les deux sont réellement levées par `config.ts`. Un catalogue
 * d'erreurs écrit avant les chemins de code qui les lèvent est une liste de suppositions : les
 * suivantes arriveront avec l'enrôlement (W2.4) et l'admission (W2.8), qui sauront ce qu'elles
 * doivent dire.
 */

/**
 * La configuration existe mais elle est malformée.
 *
 * `field` porte le chemin exact (`locus.reconnect.max_ms`) plutôt qu'un message : c'est ce qui
 * permet à un appelant de pointer la ligne fautive au lieu de faire relire tout le fichier.
 */
export const LocusConfigInvalid = NamedError.create(
  "LocusConfigInvalid",
  z.object({
    field: z.string(),
    reason: z.string(),
  }),
)

/**
 * Le worker a été lancé en mode Locus sans savoir où se connecter.
 *
 * Distinct de `LocusConfigInvalid` exprès : « tu n'as rien configuré » et « ce que tu as configuré
 * est faux » appellent deux gestes différents de la part de qui lit l'erreur.
 */
export const LocusNotConfigured = NamedError.create(
  "LocusNotConfigured",
  z.object({
    missing: z.string(),
  }),
)

/**
 * L'identité locale existe mais ne se laisse pas utiliser.
 *
 * Toujours une demande d'intervention, jamais une invitation à repartir de zéro : régénérer
 * perdrait le `worker_id` et tout ce que `locusd` a enregistré dessous. `path` dit lequel des
 * fichiers pose problème.
 */
export const LocusIdentityUnusable = NamedError.create(
  "LocusIdentityUnusable",
  z.object({
    path: z.string(),
    reason: z.string(),
  }),
)

/** L'enrôlement a été refusé — par nous avant l'envoi, ou par le serveur (§7.2). */
export const LocusEnrollmentRefused = NamedError.create(
  "LocusEnrollmentRefused",
  z.object({
    reason: z.string(),
  }),
)

/**
 * Le protocole annoncé par le serveur n'est pas utilisable — §8.2.
 *
 * Porte ce qui était offert, parce que « version refusée » sans la liste ne se diagnostique pas :
 * savoir que le serveur n'annonçait que `2.0` est ce qui distingue une mise à jour à faire d'une
 * mauvaise adresse.
 */
export const LocusProtocolRefused = NamedError.create(
  "LocusProtocolRefused",
  z.object({
    offered: z.array(z.string()),
    reason: z.string(),
  }),
)

/**
 * La copie locale du SDK LEP ne correspond plus à son épinglage — §8.1.
 *
 * Parler LEP avec un SDK retouché produirait des messages qu'un serveur conforme refuserait, en se
 * plaignant du contenu plutôt que de la cause.
 */
export const LocusPinBroken = NamedError.create(
  "LocusPinBroken",
  z.object({
    files: z.array(z.string()),
    commit: z.string(),
  }),
)

/** Le serveur n'est pas acceptable : schéma, origine, TLS (§7.3). */
export const LocusServerRejected = NamedError.create(
  "LocusServerRejected",
  z.object({
    endpoint: z.string(),
    reason: z.string(),
  }),
)
