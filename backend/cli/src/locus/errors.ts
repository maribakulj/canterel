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

/**
 * La vue de contexte n'est pas utilisable — §12.3.
 *
 * Une vue dont l'empreinte ne correspond pas n'est pas un contexte appauvri : c'est un contexte
 * dont on ne sait pas ce qu'il est. Filtrer son contenu reviendrait à appliquer une politique
 * d'isolation à un document qu'on n'a pas authentifié.
 */
export const LocusContextRefused = NamedError.create(
  "LocusContextRefused",
  z.object({
    view_id: z.string(),
    reason: z.string(),
  }),
)

/**
 * L'artefact ne franchit pas la vérification de §19.1.
 *
 * Le hash déclaré est une **promesse** faite avant l'upload ; le hash reçu est la preuve. Quand
 * les deux diffèrent, il n'y a rien à réparer localement : ni renvoyer, ni redéclarer avec le
 * nouveau hash, ni « prendre celui du serveur ». §24.5 le dit pour tout le système — une
 * incohérence déclenche quarantaine et diagnostic, jamais réparation silencieuse.
 *
 * Les deux hashes voyagent dans l'erreur parce que la première question qu'on se pose est laquelle
 * des deux moitiés a bougé.
 */
export const LocusArtifactRejected = NamedError.create(
  "LocusArtifactRejected",
  z.object({
    artifact_id: z.string(),
    reason: z.string(),
    declared_hash: z.string().optional(),
    received_hash: z.string().optional(),
  }),
)

/**
 * Le commit épistémique refuse ce qu'on lui demande — §2.3, §21.4.
 *
 * Le refus qui compte est celui de la promotion : « Canterel NE DOIT PAS promouvoir un claim
 * au-delà de `staged` ». `attempted` porte le statut demandé plutôt qu'un message, parce que la
 * question qu'on se pose en lisant l'erreur est **lequel** a été tenté — un `validated` écrit par
 * un worker est une auto-validation, un `late` est une confusion entre un statut et un marqueur.
 *
 * Sert aussi aux échecs de la validation locale de §21.4 : `findings` les porte tous d'un coup,
 * parce qu'un commit rendu invalide une raison à la fois se corrige une soumission à la fois.
 */
export const LocusCommitRefused = NamedError.create(
  "LocusCommitRefused",
  z.object({
    reason: z.string(),
    attempted: z.string().optional(),
    findings: z.array(z.string()).optional(),
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

/**
 * Une grandeur d'inventaire que la sonde n'a pas su mesurer.
 *
 * Le manifeste ne se construit pas sans elle. Le protocole exige `disk_free_mb`, donc l'absence ne
 * peut pas partir sur le fil : reste à choisir entre inventer un nombre et refuser d'annoncer.
 * Inventer ferait lire « plus de place » là où il faut lire « pas de mesure », et une seule des deux
 * causes se répare en libérant du disque.
 */
export const LocusInventoryUnmeasured = NamedError.create(
  "LocusInventoryUnmeasured",
  z.object({ quantity: z.string() }),
)

/**
 * Un checkpoint mis en quarantaine, rencontré au moment de reprendre — §24.5, `W2.21`.
 *
 * # Pourquoi lever plutôt que repartir de zéro
 *
 * `ResumeStore` distingue trois états : reprise possible, **absent**, **en quarantaine**. Un premier
 * démarrage n'a pas de checkpoint, et c'est normal ; un checkpoint illisible veut dire qu'un travail
 * était en cours et que son état est perdu.
 *
 * Les fondre en un seul « rien à reprendre » ferait repartir sous un rang de tentative neuf, c'est
 *-à-dire produire pour l'institution un **doublon** de ce que §15.5 existe pour empêcher. Une
 * ignorance n'est pas une absence : c'est la même règle que `W22.e` a posée pour les sondes d'hôte,
 * et que `W21.m` a posée pour une écriture non classée.
 */
export const LocusResumeUnreadable = NamedError.create(
  "LocusResumeUnreadable",
  z.object({ reason: z.string(), movedTo: z.string().optional() }),
)

/**
 * La boucle a tenté un cran que §11.2 n'autorise pas — `W2.21`.
 *
 * # Pourquoi lever, plutôt que garder l'état précédent
 *
 * Une première rédaction rendait l'état inchangé sur une transition refusée. C'était silencieux, et
 * le silence coûtait cher : le tour continuait, écrivait un checkpoint portant un état que la boucle
 * n'avait pas atteint, et une reprise repartait d'un endroit où rien ne s'était passé. Un compteur
 * qui n'a rien lu ne vaut pas zéro, et un état qu'on n'a pas su changer ne vaut pas l'ancien.
 *
 * Aucun chemin de la boucle ne peut la lever aujourd'hui — `RUN_PATH` et `REFUSAL_PATH` sont
 * parcourus par `canTransition` dans les tests. C'est précisément ce qui la rend utile : elle garde
 * cette propriété vraie pour le prochain cran qu'on ajoutera.
 */
export const LocusAttemptPathBroken = NamedError.create(
  "LocusAttemptPathBroken",
  z.object({ from: z.string(), to: z.string() }),
)
