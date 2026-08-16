import type { CapabilityManifest } from "./lep/generated.ts"
import { buildManifest, manifestHash, type ManifestInput } from "./capability-manifest.ts"

/**
 * La surveillance des capacités — §15.3 et l'historique de manifestes de §7.1.
 *
 * Les capacités d'une machine bougent pendant qu'un worker tourne : on installe une toolchain, on
 * branche un GPU, `bwrap` cesse de démarrer après une mise à jour de la politique AppArmor. Un
 * worker qui annonce ses capacités une fois au démarrage ment ensuite jusqu'à son redémarrage.
 *
 * Deux propriétés valent d'être écrites, parce que l'inverse de chacune est un piège :
 *
 * 1. **Un changement est ce qui change le hash**, pas ce qui change l'objet. Deux inventaires
 *    égaux sortis dans un ordre de clés différent sont le même inventaire, et signaler un
 *    changement à chaque sondage ferait réenregistrer le worker en boucle.
 * 2. **Une perte de capacité se signale comme un gain.** La tentation est de ne réagir qu'aux
 *    ajouts ; mais perdre S2 — parce que `bwrap` ne démarre plus — est précisément le cas où le
 *    serveur doit cesser d'envoyer ce qui l'exige.
 */

export type CapabilityChange = {
  readonly previous: string
  readonly current: string
  /** Ce qui a changé, en clair, pour être journalisé et compris sans relire deux manifestes. */
  readonly reasons: readonly string[]
  readonly manifest: CapabilityManifest
}

/** L'état d'une surveillance. Immuable : chaque sondage rend le suivant. */
export type WatchState = {
  readonly manifest: CapabilityManifest
  readonly hash: string
}

/** Démarrer la surveillance sur un premier sondage. */
export function startWatch(input: ManifestInput): WatchState {
  const manifest = buildManifest(input)
  return { manifest, hash: manifestHash(manifest) }
}

/**
 * Sonder à nouveau et dire si quelque chose a changé.
 *
 * Rend `null` quand rien n'a bougé — le cas de loin le plus fréquent, et celui qui doit être
 * silencieux. Un watcher qui rend un objet à chaque tour oblige son appelant à comparer, ce qui
 * ramène le bug qu'on vient d'éviter chez lui.
 */
export function poll(state: WatchState, input: ManifestInput): { state: WatchState; change: CapabilityChange | null } {
  const manifest = buildManifest(input)
  const hash = manifestHash(manifest)
  if (hash === state.hash) return { state, change: null }
  return {
    state: { manifest, hash },
    change: {
      previous: state.hash,
      current: hash,
      reasons: describeChange(state.manifest, manifest),
      manifest,
    },
  }
}

/**
 * Dire ce qui a changé entre deux manifestes.
 *
 * Les pertes sont énoncées **avant** les gains : quand un opérateur lit un journal, « S2 perdu »
 * est ce qu'il doit voir en premier, pas noyé après trois toolchains installées.
 */
export function describeChange(before: CapabilityManifest, after: CapabilityManifest): readonly string[] {
  const reasons: string[] = []

  const lost = <T>(a: readonly T[], b: readonly T[]): T[] => a.filter((item) => !b.includes(item))
  const list = (values: readonly unknown[]): string => values.map(String).join(", ")

  const lostLevels = lost(before.sandbox.levels, after.sandbox.levels)
  if (lostLevels.length > 0) reasons.push(`niveaux de sandbox perdus : ${list(lostLevels)}`)
  const lostModes = lost(before.sandbox.network_modes, after.sandbox.network_modes)
  if (lostModes.length > 0) reasons.push(`modes réseau perdus : ${list(lostModes)}`)
  const lostAccel = lost(accelTypes(before), accelTypes(after))
  if (lostAccel.length > 0) reasons.push(`accélérateurs perdus : ${list(lostAccel)}`)
  const lostTools = lost(before.toolchains, after.toolchains)
  if (lostTools.length > 0) reasons.push(`toolchains perdues : ${list(lostTools)}`)

  const gainedLevels = lost(after.sandbox.levels, before.sandbox.levels)
  if (gainedLevels.length > 0) reasons.push(`niveaux de sandbox gagnés : ${list(gainedLevels)}`)
  const gainedModes = lost(after.sandbox.network_modes, before.sandbox.network_modes)
  if (gainedModes.length > 0) reasons.push(`modes réseau gagnés : ${list(gainedModes)}`)
  const gainedAccel = lost(accelTypes(after), accelTypes(before))
  if (gainedAccel.length > 0) reasons.push(`accélérateurs gagnés : ${list(gainedAccel)}`)
  const gainedTools = lost(after.toolchains, before.toolchains)
  if (gainedTools.length > 0) reasons.push(`toolchains gagnées : ${list(gainedTools)}`)

  if (before.sandbox.backend !== after.sandbox.backend) {
    reasons.push(`backend d'isolation : ${before.sandbox.backend} → ${after.sandbox.backend}`)
  }
  if (before.resources.cpu_cores !== after.resources.cpu_cores) {
    reasons.push(`cœurs : ${before.resources.cpu_cores} → ${after.resources.cpu_cores}`)
  }

  // Le hash a changé mais aucune des dimensions surveillées ne l'explique : le dire vaut mieux
  // qu'un `reasons` vide, qui laisserait croire à un faux positif du hash.
  if (reasons.length === 0) reasons.push("inventaire modifié sur une dimension non détaillée")
  return reasons
}

function accelTypes(manifest: CapabilityManifest): readonly string[] {
  return (manifest.accelerators ?? []).map((entry) => entry.type)
}

/**
 * Vrai quand le changement retire une capacité.
 *
 * C'est la question qui décide de l'urgence : un gain peut attendre le prochain enregistrement,
 * une perte doit couper l'arrivée de missions qui en dépendent (§15.3).
 */
export function isRegression(change: CapabilityChange): boolean {
  return change.reasons.some((reason) => reason.includes("perdu"))
}
