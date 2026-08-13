import z from "zod"

import { LocusConfigInvalid, LocusNotConfigured } from "./errors.ts"

/**
 * La configuration du worker Locus — `SPEC_V1.md` §6.
 *
 * Le module est un **port pur** : il ne lit ni fichier, ni réseau, et ne connaît pas l'endroit
 * d'où viennent ses couches. `docs/locus/CLAUDE.md` demande de construire les interfaces avant de
 * les brancher, et ce module est l'exemple le plus simple de ce que ça veut dire — la fusion des
 * cinq niveaux de priorité de §6 est une fonction de données vers données, testable sans disque.
 *
 * Ce qu'il ne contient pas est aussi important que ce qu'il contient : **aucun champ de secret**.
 * §6 exige que les secrets n'apparaissent jamais dans un fichier versionné, un log ou un
 * diagnostic exporté. La façon la plus sûre de tenir cette promesse est qu'il n'y ait rien à
 * omettre : le token d'enrôlement de §7.2 est un argument de commande à usage unique, pas un champ
 * de configuration, et un test le verrouille.
 */

const Reconnect = z.object({
  initial_ms: z.number().int().positive().default(500),
  max_ms: z.number().int().positive().default(30_000),
  jitter: z.boolean().default(true),
})

const Resume = z.object({
  directory: z.string().default(".canterel/locus"),
  fsync: z.boolean().default(true),
})

const Artifacts = z.object({
  cache_directory: z.string().default(".canterel/locus/artifacts"),
  cache_max_bytes: z
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
})

const Security = z.object({
  // Les défauts sont les plus stricts que §6 propose, jamais les plus commodes. Un défaut permissif
  // se propage dans toutes les installations qui n'ont rien configuré — c'est-à-dire la plupart.
  minimum_isolation_level: z.string().default("os-sandbox"),
  reject_plaintext_secrets: z.boolean().default(true),
  fail_closed_on_policy_error: z.boolean().default(true),
})

const Telemetry = z.object({
  traces: z.boolean().default(true),
  metrics: z.boolean().default(true),
  redact_prompts: z.boolean().default(true),
})

/** Le schéma complet de §6, avec ses valeurs par défaut sûres. */
export const LocusConfig = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().optional(),
  identity: z.string().optional(),
  labels: z.array(z.string()).default([]),
  max_concurrency: z.number().int().positive().default(1),
  drain_timeout_seconds: z.number().int().nonnegative().default(120),
  reconnect: Reconnect.prefault({}),
  resume: Resume.prefault({}),
  artifacts: Artifacts.prefault({}),
  security: Security.prefault({}),
  telemetry: Telemetry.prefault({}),
})

export type LocusConfig = z.infer<typeof LocusConfig>

/**
 * Une couche de configuration, dans l'ordre de priorité de §6.
 *
 * L'ordre est une donnée, pas une suite d'appels : le lire ici est ce qui permet de vérifier qu'il
 * est respecté, plutôt que de le déduire de l'ordre des lignes d'une fonction.
 */
export const LAYER_ORDER = ["cli", "env", "project", "user", "default"] as const

export type LayerName = (typeof LAYER_ORDER)[number]

/** Ce qu'une couche apporte : un fragment, jamais une configuration complète. */
export type Layer = {
  readonly name: LayerName
  readonly values: Record<string, unknown>
}

/**
 * Fusionner les couches selon l'ordre de priorité de §6.
 *
 * La fusion est **profonde** sur les objets et **remplaçante** sur les tableaux. Fusionner des
 * tableaux voudrait dire qu'on ne peut jamais retirer un label hérité d'une couche moins
 * prioritaire, seulement en ajouter — une configuration dont on ne peut pas soustraire n'est pas
 * une configuration.
 */
export function mergeLayers(layers: readonly Layer[]): Record<string, unknown> {
  const byPriority = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.name) - LAYER_ORDER.indexOf(b.name))
  // Du moins prioritaire au plus prioritaire, pour que le dernier écrit gagne.
  const ordered = byPriority.reverse()
  const out: Record<string, unknown> = {}
  for (const layer of ordered) deepAssign(out, layer.values)
  return out
}

function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isPlainObject(value)) {
      const existing = target[key]
      const nested = isPlainObject(existing) ? { ...existing } : {}
      deepAssign(nested, value)
      target[key] = nested
      continue
    }
    target[key] = value
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Valider la configuration fusionnée.
 *
 * Rend une `LocusConfigInvalid` portant le **chemin** du champ fautif, pas un message : c'est ce
 * qui permet de pointer une ligne au lieu de faire relire tout le fichier.
 */
export function parseConfig(input: Record<string, unknown>): LocusConfig {
  const result = LocusConfig.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw new LocusConfigInvalid({
    field: issue?.path.length ? issue.path.join(".") : "locus",
    reason: issue?.message ?? "configuration refusée",
  })
}

/**
 * Résoudre la configuration à partir de ses couches.
 *
 * Ne vérifie **pas** que le worker est utilisable : une configuration valide dont `enabled` est
 * faux est parfaitement légitime, et c'est même l'état de toute installation qui n'a jamais
 * entendu parler de Locus. C'est `requireConnectable` qui pose cette question, au moment où elle
 * se pose.
 */
export function resolveConfig(layers: readonly Layer[]): LocusConfig {
  return parseConfig(mergeLayers(layers))
}

/**
 * Exiger une configuration avec laquelle on peut réellement se connecter.
 *
 * Séparé de la validation : on valide toujours, on exige seulement quand on va s'en servir. Cette
 * distinction est ce qui permet à `worker status` de rendre compte d'une configuration incomplète
 * au lieu d'échouer.
 */
export function requireConnectable(config: LocusConfig): asserts config is LocusConfig & { endpoint: string } {
  if (!config.endpoint) throw new LocusNotConfigured({ missing: "locus.endpoint" })
}

/** Les variables d'environnement lues, et le champ que chacune alimente. */
export const ENV_BINDINGS: readonly {
  variable: string
  path: readonly string[]
  kind: "string" | "number" | "boolean" | "csv"
}[] = [
  { variable: "LOCUS_ENABLED", path: ["enabled"], kind: "boolean" },
  { variable: "LOCUS_ENDPOINT", path: ["endpoint"], kind: "string" },
  { variable: "LOCUS_IDENTITY", path: ["identity"], kind: "string" },
  { variable: "LOCUS_LABELS", path: ["labels"], kind: "csv" },
  { variable: "LOCUS_MAX_CONCURRENCY", path: ["max_concurrency"], kind: "number" },
  { variable: "LOCUS_DRAIN_TIMEOUT_SECONDS", path: ["drain_timeout_seconds"], kind: "number" },
]

/**
 * Construire la couche `env` à partir d'un environnement donné.
 *
 * L'environnement est un **paramètre**, pas `process.env` lu en douce : c'est ce qui rend la
 * couche testable sans muter le processus, et ce qui empêche ce module d'avoir un comportement
 * différent selon qui l'appelle.
 *
 * Une variable présente mais illisible est une `LocusConfigInvalid`, jamais un silence. Un worker
 * qui ignore `LOCUS_MAX_CONCURRENCY=beaucoup` et tourne à 1 fait quelque chose que personne n'a
 * demandé, sans le dire.
 */
export function layerFromEnv(env: Record<string, string | undefined>): Layer {
  const values: Record<string, unknown> = {}
  for (const binding of ENV_BINDINGS) {
    const raw = env[binding.variable]
    if (raw === undefined || raw === "") continue
    values[binding.path[0] as string] = readEnvValue(binding.variable, raw, binding.kind)
  }
  return { name: "env", values }
}

function readEnvValue(variable: string, raw: string, kind: "string" | "number" | "boolean" | "csv"): unknown {
  if (kind === "string") return raw
  if (kind === "csv")
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  if (kind === "boolean") {
    if (["1", "true", "yes"].includes(raw.toLowerCase())) return true
    if (["0", "false", "no"].includes(raw.toLowerCase())) return false
    throw new LocusConfigInvalid({ field: variable, reason: `attendu un booléen, reçu ${raw}` })
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new LocusConfigInvalid({ field: variable, reason: `attendu un entier, reçu ${raw}` })
  }
  return parsed
}

/**
 * Le rendu lisible d'une configuration — le seul autorisé à sortir vers un log ou un diagnostic.
 *
 * Il existe pour que la promesse de §6 (« les secrets ne doivent jamais apparaître dans un log ou
 * un diagnostic exporté ») ait **un seul endroit** où être tenue plutôt qu'autant d'endroits qu'il
 * y a d'appels à `console.log`. Aujourd'hui la configuration ne contient aucun secret, et c'est
 * exactement pour ça qu'il faut écrire ce point de passage maintenant : le jour où quelqu'un
 * ajoutera un champ sensible, il n'aura qu'un seul rendu à corriger.
 */
export function describeConfig(config: LocusConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    endpoint: config.endpoint ?? null,
    identity: config.identity ?? null,
    labels: config.labels,
    max_concurrency: config.max_concurrency,
    drain_timeout_seconds: config.drain_timeout_seconds,
    security: config.security,
    telemetry: config.telemetry,
  }
}
