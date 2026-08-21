/**
 * La sonde réelle de la machine — `W22.e`, ADR 0025 de `locusolus`.
 *
 * # Ce que l'adaptateur de production faisait, et pourquoi c'était pire qu'une imprécision
 *
 * `capability-manifest.ts` déclare son contrat sans ambiguïté :
 *
 * > « Vrai quand `bwrap` **démarre réellement** — l'existence du binaire ne suffit pas. »
 *
 * L'adaptateur de production, lui, écrivait `bubblewrapWorks: () => Bun.which("bwrap") !== null`,
 * soixante lignes sous ce contrat, avec un arbitrage écrit à côté : « l'appel direct suffit pour
 * l'inventaire ».
 *
 * Ce n'est pas seulement plus faible que le contrat. `sandboxBackend` appelle `which("bwrap")`
 * **puis** `bubblewrapWorks()` : avec cet adaptateur, la seconde barrière ne pouvait être atteinte
 * que si la première était passée, donc elle rendait toujours vrai. **Elle ne pouvait pas refuser.**
 * Le contrat annonçait deux vérifications ; il n'y en avait qu'une, et le port était impeccablement
 * testé contre une sonde injectée pendant que son unique implémentation réelle était inerte.
 *
 * C'est le seul des quatre défauts de l'audit qui porte sur un **niveau d'isolation** : le manifeste
 * remonte jusqu'à l'admission, où `place` choisit un hôte sur ce qu'il a **prouvé**. Une preuve qui
 * n'en est pas une y devient une décision de placement.
 *
 * # Trois issues, pas deux
 *
 * `true` — la sandbox démarre. `false` — elle ne démarre pas, soit que le binaire manque, soit que
 * l'hôte le refuse : sur Ubuntu 24.04, AppArmor bloque les namespaces utilisateur non privilégiés et
 * `bwrap` échoue alors qu'il est là. `undefined` — **on n'a pas pu essayer**, ce qui n'est ni l'un
 * ni l'autre.
 *
 * L'absence ne donne jamais la capacité. C'est la règle de `W4.b` chez `locusolus` : une sonde non
 * exécutée n'est pas une sonde réussie — et ici, annoncer trop est la seule faute qui compte.
 *
 * # Aucun accès direct : des capteurs, injectés
 *
 * Tout ce qui touche la machine passe par [`Sensors`]. C'est ce qui permet à un test d'exercer le
 * cas « le binaire est là et ne démarre pas » — celui que l'ancien adaptateur rendait inatteignable —
 * sans avoir besoin d'un hôte cassé sous la main.
 */

import type { HostProbe } from "./capability-manifest.ts"

/** Le résultat d'un lancement : abouti, refusé, ou pas tenté. */
export type Launch = "started" | "refused" | "untried"

/**
 * Ce que la sonde a besoin de la machine, et rien d'autre.
 *
 * `freeBytes` rend `undefined` plutôt que zéro quand la mesure échoue : un disque plein et un
 * disque non mesuré ne sont pas le même fait, et c'est le second qu'un exploitant doit voir pour
 * savoir quoi réparer.
 */
export type Sensors = {
  which(binary: string): string | null
  launch(command: readonly string[]): Launch
  freeBytes(path: string): number | undefined
  readonly cpuCores: number
  readonly memoryMb: number
  readonly platform: string
  readonly arch: string
  readonly release?: string
}

/** Le délai au-delà duquel un lancement de sonde est abandonné. */
export const LAUNCH_BUDGET_MS = 5_000

/**
 * L'invocation qui décide, et pourquoi celle-là.
 *
 * `--unshare-user` est le point : c'est le namespace utilisateur non privilégié qu'AppArmor refuse,
 * donc une invocation qui ne le demanderait pas réussirait sur la machine même où la sandbox échoue.
 * `--ro-bind / /` donne de quoi exécuter, et la commande est `true`, qui ne fait rien et le fait
 * vite.
 */
export function bubblewrapCommand(truePath: string): readonly string[] {
  return ["bwrap", "--unshare-user", "--ro-bind", "/", "/", truePath]
}

/**
 * `bwrap` démarre-t-il **vraiment** sur cette machine ?
 *
 * `false` quand le binaire manque : c'est une conclusion, pas une ignorance. `undefined` quand on
 * n'a pas su faire l'essai — faute de `true` à exécuter, ou parce que le lancement lui-même n'a pas
 * abouti à un verdict.
 */
export function bubblewrapStarts(sensors: Sensors): boolean | undefined {
  if (sensors.which("bwrap") === null) return false
  const truePath = sensors.which("true")
  if (truePath === null) return undefined
  const launch = sensors.launch(bubblewrapCommand(truePath))
  if (launch === "untried") return undefined
  return launch === "started"
}

/** L'espace libre en mégaoctets, ou `undefined` quand la mesure n'a pas abouti. */
export function freeDiskMb(sensors: Sensors, path: string): number | undefined {
  const bytes = sensors.freeBytes(path)
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  return Math.floor(bytes / 1024 / 1024)
}

/** Assembler une sonde à partir de capteurs, réels ou simulés. */
export function probeFrom(sensors: Sensors, path: string): HostProbe {
  const disk = freeDiskMb(sensors, path)
  const bwrap = bubblewrapStarts(sensors)
  return {
    platform: sensors.platform,
    arch: sensors.arch,
    ...(sensors.release ? { release: sensors.release } : {}),
    which: (binary) => sensors.which(binary),
    bubblewrapWorks: () => bwrap,
    cpuCores: sensors.cpuCores,
    memoryMb: sensors.memoryMb,
    diskFreeMb: disk,
  }
}

/**
 * Les capteurs réels — le seul endroit de ce module qui touche la machine.
 *
 * Un lancement qui lève est `untried` et non `refused` : une exception dit que l'essai n'a pas eu
 * lieu, et la ranger avec « la sandbox refuse » perdrait la distinction que tout ce module existe
 * pour tenir.
 */
export function realSensors(): Sensors {
  return {
    which: (binary) => Bun.which(binary),
    launch: (command) => {
      try {
        const result = Bun.spawnSync({
          cmd: [...command],
          stdout: "ignore",
          stderr: "ignore",
          timeout: LAUNCH_BUDGET_MS,
        })
        return result.exitCode === 0 ? "started" : "refused"
      } catch {
        return "untried"
      }
    },
    freeBytes: (path) => {
      try {
        const stats = require("node:fs").statfsSync(path)
        const free = Number(stats.bavail) * Number(stats.bsize)
        return Number.isFinite(free) ? free : undefined
      } catch {
        return undefined
      }
    },
    cpuCores: navigator.hardwareConcurrency,
    memoryMb: Math.round(Number(require("node:os").totalmem()) / 1024 / 1024),
    platform: process.platform,
    arch: process.arch,
  }
}

/** La sonde de production, mesurée sur le répertoire courant. */
export function realProbe(path = "."): HostProbe {
  return probeFrom(realSensors(), path)
}
