/**
 * SDK LEP : les types générés depuis `schemas/`, et la négociation de features du handshake.
 *
 * `generated.ts` est produit par `tooling/sdk/generate.ts` et n'est jamais édité à la main ;
 * `npm run check:generated` le vérifie. Ce qui suit — la négociation — est écrit à la main,
 * parce que c'est de la logique et non une lecture des schémas.
 */
export * from "./generated.ts";

import { LEP_FEATURES, type LepFeature } from "./generated.ts";

/** Ce sur quoi deux pairs se sont mis d'accord au handshake. */
export type Negotiated = {
  /** Les features que les deux pairs annoncent, triées, sans doublon. */
  readonly features: readonly LepFeature[];
  /** Ce qu'un pair a demandé et que l'autre ne tient pas. */
  readonly declined: readonly LepFeature[];
  /** Ce qu'un pair a demandé et que ce protocole ne connaît pas du tout. */
  readonly unknown: readonly string[];
};

/**
 * Négocier les features à partir de ce que chaque pair annonce.
 *
 * Trois issues, et les distinguer est tout l'intérêt : une feature que les deux tiennent est
 * **accordée** ; une que ce protocole connaît mais que l'autre ne tient pas est **refusée**, ce
 * qui est une information exploitable — le demandeur sait qu'il doit se replier ; une que le
 * protocole ne connaît pas est **inconnue**, et c'est un signal différent, celui d'un pair plus
 * récent ou mal configuré.
 *
 * Les fondre en un seul « non » ferait qu'un client venu d'un mineur ultérieur serait
 * indiscernable d'un client qui a mal orthographié son besoin.
 */
export function negotiate(local: readonly string[], remote: readonly string[]): Negotiated {
  const features: LepFeature[] = [];
  const declined: LepFeature[] = [];
  const unknown: string[] = [];
  for (const name of local) {
    if (!isFeature(name)) unknown.push(name);
    else if (remote.includes(name)) features.push(name);
    else declined.push(name);
  }
  return {
    features: unique(features),
    declined: unique(declined),
    unknown: unique(unknown),
  };
}

/** Le mineur qui introduit FEATURE, ou `undefined` si ce protocole ne la connaît pas. */
export function featureSince(feature: string): string | undefined {
  return isFeature(feature) ? LEP_FEATURES[feature] : undefined;
}

function isFeature(name: string): name is LepFeature {
  return Object.hasOwn(LEP_FEATURES, name);
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
