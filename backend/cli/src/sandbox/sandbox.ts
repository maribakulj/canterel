import path from "path"
import os from "os"
import fs from "fs"
import { spawn, spawnSync } from "child_process"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { Shell } from "@/shell/shell"

const log = Log.create({ service: "sandbox" })

/**
 * OS-level execution sandbox for the agent's shell commands.
 *
 * The permission system decides *whether* a command runs; it is an approval
 * layer, not an isolation boundary — an approved (or auto-approved) command
 * otherwise executes with the full authority of the user running OpenScience.
 * This module adds the missing boundary: it wraps the command in a real OS
 * sandbox so that, regardless of what the command tries to do, it cannot write
 * outside the workspace (plus temp dirs) and — optionally — cannot reach the
 * network.
 *
 *   - macOS  → Seatbelt via `sandbox-exec` (an SBPL profile).
 *   - Linux  → `bubblewrap` (bwrap) mount namespaces.
 *   - other  → no backend; the caller decides whether to warn, error, or run.
 *
 * The model is deliberately *write-containment* (allow-by-default, deny writes
 * outside an allowlist, optionally deny network) rather than a deny-by-default
 * syscall jail: research workflows run arbitrary compilers, package managers and
 * interpreters, and a strict jail would break far more than it protects. Reads
 * stay open; the threat this stops is tampering with files outside the workspace
 * (`~/.ssh`, `~/.bashrc`, other projects) and, in network-deny mode, silent
 * exfiltration.
 */
export namespace Sandbox {
  /**
   * Le mécanisme de confinement, sous le nom du **registre LEP** — `schemas/lep/1.0/mechanisms.json`
   * chez `locusolus`.
   *
   * `bubblewrap` et `bubblewrap+cgroup` ne sont pas deux façons d'écrire la même garantie : le
   * premier compose des namespaces et des montages, le second borne en plus les ressources. Ils
   * échouent différemment et s'installent différemment, et l'ADR 0036 leur refuse un nom commun —
   * une attestation obtenue sous l'un ne vaut pas pour un worker qui emploie l'autre.
   */
  export type Backend = "seatbelt" | "bubblewrap" | "bubblewrap+cgroup" | "none"

  export interface Policy {
    /** Absolute paths the sandboxed process may write to. */
    writable: string[]
    /** Exact host files the sandboxed process must not be able to read. */
    unreadable?: string[]
    /** Whether the sandboxed process may reach the network. */
    network: boolean
  }

  /** A ready-to-spawn argv: `spawn(file, args)` with no shell wrapping. */
  export interface Spec {
    file: string
    args: string[]
  }

  /** User-facing config knobs (mirrors Config.Sandbox, kept dependency-free). */
  export interface Options {
    enabled?: boolean
    network?: "allow" | "deny"
    allowWrite?: string[]
    onUnavailable?: "warn" | "error" | "allow"
  }

  export interface Plan {
    /** Program to spawn. */
    file: string
    /** Args when running sandboxed; undefined when running the raw command. */
    args?: string[]
    /** `shell` option to pass to spawn (a shell path for the raw command, else false). */
    useShell: string | false
    /** True when the command is wrapped in an OS sandbox. */
    sandboxed: boolean
    backend: Backend
    /** One-time human-readable note (e.g. sandbox requested but unavailable). */
    warning?: string
  }

  /** Result of wrapping a raw argv (used by the notebook/R kernels). */
  export interface Wrapped {
    /** Program to spawn — the backend wrapper when sandboxed, else the original file. */
    file: string
    /** Args to spawn — the original argv is preserved at the tail when sandboxed. */
    args: string[]
    sandboxed: boolean
    backend: Backend
    warning?: string
  }

  export class UnavailableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SandboxUnavailableError"
    }
  }

  // ── backend detection ───────────────────────────────────────────────────────

  function probeBubblewrap(bin: string): boolean {
    // bwrap can exist yet fail at runtime when unprivileged user namespaces are
    // disabled (kernel.unprivileged_userns_clone=0, some hardened distros), and
    // --unshare-pid needs a usable PID namespace. Probe with the same namespace
    // ops the real sandbox uses so detection matches enforcement.
    try {
      const res = spawnSync(
        bin,
        ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--", "true"],
        { stdio: "ignore", timeout: 5000 },
      )
      return res.status === 0
    } catch {
      return false
    }
  }

  const detected = lazy<Backend>(() => {
    if (process.platform === "darwin") {
      return Bun.which("sandbox-exec") ? "seatbelt" : "none"
    }
    if (process.platform === "linux") {
      const bin = Bun.which("bwrap")
      if (!bin) return "none"
      if (!probeBubblewrap(bin)) return "none"
      // Le nom suit ce que la machine sait faire, et la seule façon de le savoir est d'essayer :
      // `bounds()` écrit réellement dans `cgroup.subtree_control`. L'effet de bord — le processus
      // descend d'un cran dans sa propre hiérarchie — est sans conséquence sur ses limites, et il
      // est le prix d'une réponse mesurée plutôt que devinée.
      return bounds() ? "bubblewrap+cgroup" : "bubblewrap"
    }
    return "none"
  })

  /** The sandbox backend usable on this machine right now, or "none". */
  export function backend(): Backend {
    return detected()
  }

  export function available(): boolean {
    return backend() !== "none"
  }

  /** Backend + platform summary for status output (CLI `doctor`, GUI panel). */
  export function describe(): {
    platform: NodeJS.Platform
    backend: Backend
    available: boolean
    tool?: string
    reason?: string
  } {
    const b = backend()
    if (b === "seatbelt") return { platform: process.platform, backend: b, available: true, tool: "sandbox-exec" }
    if (b === "bubblewrap" || b === "bubblewrap+cgroup")
      return { platform: process.platform, backend: b, available: true, tool: "bwrap" }
    const reason =
      process.platform === "darwin"
        ? "sandbox-exec not found on PATH"
        : process.platform === "linux"
          ? "bubblewrap (bwrap) is not installed, or unprivileged user namespaces are disabled"
          : `no sandbox backend for platform "${process.platform}"`
    return { platform: process.platform, backend: "none", available: false, reason }
  }

  // ── writable-path assembly ──────────────────────────────────────────────────

  /** Temp dirs a sandboxed command legitimately needs to write to. */
  export function tempDirs(): string[] {
    const dirs = new Set<string>()
    const add = (d?: string | null) => {
      if (d) dirs.add(d)
    }
    add(process.env.TMPDIR)
    add(process.env.TMP)
    add(process.env.TEMP)
    add(os.tmpdir())
    add("/tmp")
    if (process.platform === "darwin") add("/private/tmp")
    return [...dirs]
  }

  function dedupe(paths: string[]): string[] {
    const out = new Set<string>()
    for (const p of paths) {
      if (p) out.add(path.resolve(p))
    }
    return [...out]
  }

  /**
   * A path too broad to ever be a sandbox writable root: granting write here
   * would hand back most of the filesystem and defeat containment. Guards
   * against a project/worktree opened at "/" and against `TMPDIR`/`allowWrite`
   * pointing at `$HOME`, `/etc`, etc. Subdirectories of these (e.g. a real
   * project under `$HOME/code/foo`) are fine — only the roots themselves are
   * refused.
   */
  function tooBroadToConfine(p: string): boolean {
    if (p === "/" || p === path.parse(p).root) return true
    const home = os.homedir()
    if (p === home) return true
    if (home.startsWith(p + path.sep)) return true // ancestor of home, e.g. "/home", "/Users"
    const roots = [
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/boot",
      "/root",
      "/var",
      "/opt",
      "/dev",
      "/proc",
      "/sys",
    ]
    return roots.includes(p)
  }

  /** Assemble the writable allowlist for a policy, dropping over-broad roots. */
  function buildPolicy(input: {
    workspace: string[]
    extraWritable?: string[]
    unreadable?: string[]
    options: Options
  }): Policy {
    const candidates = dedupe([
      ...input.workspace,
      ...tempDirs(),
      ...(input.options.allowWrite ?? []),
      ...(input.extraWritable ?? []),
    ])
    const writable = candidates.filter((p) => {
      if (tooBroadToConfine(p)) {
        log.warn("refusing to grant sandbox write access to an over-broad path", { path: p })
        return false
      }
      return true
    })
    return {
      writable,
      unreadable: dedupe(input.unreadable ?? []).filter((value) => !tooBroadToConfine(value)),
      network: (input.options.network ?? "allow") !== "deny",
    }
  }

  // ── macOS: Seatbelt (sandbox-exec) ──────────────────────────────────────────

  /** Escape a path for an SBPL double-quoted string literal. */
  function sbpl(p: string): string {
    return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  }

  /** Add the macOS `/private/...` firmlink alias for /tmp,/var,/etc paths. */
  function withPrivateAliases(paths: string[]): string[] {
    const out = new Set<string>(paths)
    for (const p of paths) {
      for (const root of ["/tmp", "/var", "/etc"]) {
        if (p === root || p.startsWith(root + "/")) out.add("/private" + p)
      }
    }
    return [...out]
  }

  export function seatbeltProfile(policy: Policy): string {
    const lines = ["(version 1)", "(allow default)"]
    if (!policy.network) lines.push("(deny network*)")
    const unreadable = withPrivateAliases(dedupe(policy.unreadable ?? []))
    if (unreadable.length) {
      lines.push(`(deny file-read* ${unreadable.map((value) => `(literal "${sbpl(value)}")`).join(" ")})`)
    }
    lines.push("(deny file-write*)")

    const writable = withPrivateAliases(dedupe(policy.writable))
    if (writable.length) {
      lines.push(`(allow file-write* ${writable.map((p) => `(subpath "${sbpl(p)}")`).join(" ")})`)
    }
    // Character devices tools legitimately write (null, tty, ptys, urandom, …).
    lines.push('(allow file-write* (subpath "/dev"))')
    return lines.join("\n")
  }

  // ── Linux: bubblewrap (bwrap) ───────────────────────────────────────────────

  export function bubblewrapArgs(policy: Policy): string[] {
    // Whole fs read-only, a fresh /dev and /proc, and a throwaway writable /tmp;
    // then re-mount the bits that must be writable on top.
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    for (const p of dedupe(policy.writable)) {
      // Skip only the /tmp mount root itself — it is provided as a fresh tmpfs and
      // re-binding host /tmp would defeat it. A workspace that lives *under* /tmp
      // still needs binding on top of the tmpfs, or its writes vanish.
      if (p === "/tmp") continue
      // --bind-try: don't abort if the source path doesn't exist.
      args.push("--bind-try", p, p)
    }
    for (const value of dedupe(policy.unreadable ?? [])) {
      // bwrap's *-try only tolerates a missing source. With /dev/null as the
      // source it still attempts to create a missing destination, which fails
      // beneath our read-only root before the command can start. An absent
      // credential cannot be read and the sandbox cannot create it, so only
      // mount masks for files that exist when the namespace is assembled.
      if (!fs.existsSync(value)) continue
      args.push("--ro-bind-try", "/dev/null", value)
    }
    if (!policy.network) args.push("--unshare-net")
    // --unshare-pid: don't share the host PID namespace, so /proc/<pid>/root of a
    // same-uid host process can't be used to write through the read-only bind.
    args.push("--unshare-pid", "--die-with-parent")
    return args
  }


  // ── Linux: le cgroup qui borne, quand le déploiement en délègue un ──────────

  /**
   * Les bornes de ressources qu'un commande doit subir, quand l'appelant en connaît.
   *
   * Toutes facultatives, et une borne absente n'est **pas** une borne infinie écrite à zéro : elle
   * veut dire que personne n'a réservé cette dimension, et le fichier de contrôle correspondant
   * n'est simplement pas écrit.
   */
  export interface Limits {
    /** Millicores — `1000` vaut un cœur. */
    cpuMillicores?: number
    memoryMb?: number
    pids?: number
  }

  /** La période CFS, en microsecondes. Celle de `locus-execd`, pour que `cpu.max` se lise pareil. */
  const CPU_PERIOD_US = 100_000

  /** Où le superviseur se range pour laisser sa racine subdivisible. */
  const SUPERVISOR = "canterel-superviseur"

  /** Le préfixe des cgroups de commande — c'est aussi ce que le balayage reconnaît. */
  const COMMAND_PREFIX = "canterel-cmd-"

  /** Ce que le noyau montre à un processus qui lit ses propres bornes. */
  const CGROUP_VIEW = "/sys/fs/cgroup"

  /**
   * La racine cgroup que ce processus peut **subdiviser**, ou null.
   *
   * # Deux faits distincts, et l'un ne se déduit pas de l'autre
   *
   * Que l'hôte délègue des contrôleurs se lit dans `cgroup.controllers`. Que *ce processus-ci*
   * puisse écrire dans `cgroup.subtree_control` est autre chose : sur un `session.scope` comme sur
   * un runner CI, les contrôleurs sont délégués et l'écriture est refusée. Seule la seconde compte
   * ici, et elle ne se vérifie qu'en l'essayant.
   *
   * # Le processus descend d'un cran avant de subdiviser
   *
   * Le noyau refuse `cgroup.subtree_control` sur un cgroup qui contient des processus. Le refus est
   * `EBUSY` — « Device or resource busy » —, qui ne ressemble à rien de ce qu'on cherchait. Le
   * superviseur se range donc dans un enfant, ce qui libère la racine pour les cgroups de commande.
   *
   * Mesuré une fois par processus : la réponse ne change pas en cours de route, et la sonder à
   * chaque commande déplacerait le superviseur à chaque fois.
   */
  const delegatedRoot = lazy<string | null>(() => {
    if (process.platform !== "linux") return null
    try {
      const own = fs
        .readFileSync("/proc/self/cgroup", "utf8")
        .split("\n")
        .find((line) => line.startsWith("0::"))
        ?.slice(3)
        .trim()
      if (!own) return null
      const root = path.join("/sys/fs/cgroup", own)
      fs.mkdirSync(path.join(root, SUPERVISOR), { recursive: true })
      fs.writeFileSync(path.join(root, SUPERVISOR, "cgroup.procs"), String(process.pid))
      fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +memory +pids")
      const enabled = fs.readFileSync(path.join(root, "cgroup.subtree_control"), "utf8")
      // Écrire n'est pas activer : un contrôleur que le parent ne délègue pas est accepté en
      // silence par certains noyaux et n'apparaît pas ici. On ne borne que ce qui s'y trouve.
      if (!enabled.includes("cpu") || !enabled.includes("memory") || !enabled.includes("pids")) {
        log.info("cgroup delegated but controllers incomplete", { enabled: enabled.trim() })
        return null
      }
      log.info("cgroup delegation usable", { root })
      return root
    } catch (err) {
      log.info("no writable cgroup delegation", { reason: (err as Error).message })
      return null
    }
  })

  /** Ce processus peut-il borner les ressources d'une commande ? */
  export function bounds(): boolean {
    return delegatedRoot() !== null
  }

  /**
   * Retirer les cgroups de commande qui ne contiennent plus personne.
   *
   * # Pourquoi un balayage plutôt qu'un nettoyage à la fin
   *
   * `Sandbox` rend un argv, pas un processus : personne ne lui dit qu'une commande s'est terminée,
   * et un rappel demanderait que chacun des sept appelants s'en souvienne. Un `rmdir` sur un cgroup
   * **échoue tant qu'il reste un processus dedans** — le noyau le garantit —, donc balayer est sûr
   * par construction et se répare tout seul après un arrêt brutal.
   */
  function sweep(root: string): void {
    try {
      for (const entry of fs.readdirSync(root)) {
        if (!entry.startsWith(COMMAND_PREFIX)) continue
        try {
          fs.rmdirSync(path.join(root, entry))
        } catch {
          // Il reste quelqu'un dedans : c'est une commande qui tourne, pas une erreur.
        }
      }
    } catch {
      // La racine a disparu — le superviseur a été déplacé. Rien à balayer.
    }
  }

  /** Ce que `cpu.max` doit porter pour ce nombre de millicores. */
  function cpuMax(millicores: number): string {
    // Au moins une période : un quota nul suspendrait la commande pour toujours, ce qui se lirait
    // comme un blocage et non comme une borne mal calculée.
    const quota = Math.max(1000, Math.round((millicores * CPU_PERIOD_US) / 1000))
    return `${quota} ${CPU_PERIOD_US}`
  }

  /**
   * Poser un cgroup pour cette commande, et rendre son répertoire.
   *
   * `null` quand rien n'est délégué, quand aucune borne n'est demandée, ou quand le noyau refuse —
   * dans les trois cas la commande tourne sous `bubblewrap` nu, ce qui est plus faible et honnête.
   * Une borne qu'on croit posée est pire que pas de borne.
   */
  function place(limits?: Limits): string | null {
    const root = delegatedRoot()
    if (!root || !limits) return null
    const written: [string, string][] = []
    if (limits.cpuMillicores !== undefined) written.push(["cpu.max", cpuMax(limits.cpuMillicores)])
    if (limits.memoryMb !== undefined) written.push(["memory.max", String(limits.memoryMb * 1024 * 1024)])
    if (limits.pids !== undefined) written.push(["pids.max", String(limits.pids)])
    if (written.length === 0) return null

    sweep(root)
    const directory = path.join(root, `${COMMAND_PREFIX}${process.pid}-${counter++}`)
    try {
      fs.mkdirSync(directory)
      for (const [file, value] of written) fs.writeFileSync(path.join(directory, file), value)
      return directory
    } catch (err) {
      log.warn("cgroup placement failed; running unbounded", { reason: (err as Error).message })
      try {
        fs.rmdirSync(directory)
      } catch {
        // Il n'a peut-être jamais existé.
      }
      return null
    }
  }

  let counter = 0

  /**
   * L'enveloppeur qui **entre dans le cgroup** avant de lancer la sandbox.
   *
   * Un processus s'inscrit dans `cgroup.procs` entre le fork et l'exec : avant, ce serait le worker
   * qu'on déplacerait ; après, la commande aurait déjà tourné hors de toute borne. Un shell qui
   * s'inscrit puis `exec` fait exactement ça sans code natif.
   *
   * Le `&&` n'est pas une élégance : si l'inscription échoue, la sandbox **ne se lance pas**. Un
   * `;` la lancerait quand même, hors du cgroup, ce qui est le mode d'échec silencieux qu'on évite.
   * Le `exec` non plus : sans lui le shell resterait entre le worker et la sandbox, compterait dans
   * `pids.max` et recevrait les signaux à la place de `bwrap`.
   */
  function joined(directory: string, spec: Spec): Spec {
    const quoted = [spec.file, ...spec.args].map(shellQuote).join(" ")
    return {
      file: "/bin/sh",
      args: ["-c", `echo $$ > ${shellQuote(path.join(directory, "cgroup.procs"))} && exec ${quoted}`],
    }
  }

  /** Un argument rendu inoffensif pour un shell POSIX. */
  function shellQuote(argument: string): string {
    return `'${argument.replaceAll("'", `'\\''`)}'`
  }

  /** Wrap an arbitrary argv under the active backend, or null when unavailable. */
  function specForArgv(argv: string[], policy: Policy, limits?: Limits): Spec | null {
    switch (backend()) {
      case "seatbelt":
        return { file: "sandbox-exec", args: ["-p", seatbeltProfile(policy), ...argv] }
      case "bubblewrap":
      case "bubblewrap+cgroup": {
        const directory = place(limits)
        // Le cgroup est monté en lecture seule sur le chemin où un processus lit **ses propres**
        // bornes. Deux raisons, et la seconde n'est pas de la prudence : une commande qui pourrait
        // écrire dans son `cpu.max` lèverait la borne qu'on vient de poser ; et c'est ce répertoire
        // qui est monté, pas la hiérarchie de l'hôte, qui montrerait tous les cgroups de la machine.
        const view = directory ? ["--ro-bind", directory, CGROUP_VIEW] : []
        const spec = { file: "bwrap", args: [...bubblewrapArgs(policy), ...view, "--", ...argv] }
        return directory ? joined(directory, spec) : spec
      }
      default:
        return null
    }
  }

  // ── planning (consumed by the bash tool and the kernels) ────────────────────

  // Warn only once per process so every command doesn't repeat the same notice.
  const warned = { unavailable: false }

  function unavailableMessage(): string {
    return `Sandbox is enabled but unavailable on this machine (${describe().reason}). Running the command WITHOUT isolation. Install the backend, or set sandbox.onUnavailable to "error" to refuse instead.`
  }

  /**
   * Resolve which backend a command should use given the config. Returns
   * backend "none" (run unsandboxed) with an optional one-time warning, or the
   * active backend. Throws UnavailableError only when `onUnavailable: "error"`
   * and no backend exists.
   */
  function decide(options?: Options): { backend: Backend; warning?: string } {
    if (options?.enabled !== true) return { backend: "none" }
    const b = backend()
    if (b !== "none") return { backend: b }
    const mode = options.onUnavailable ?? "warn"
    if (mode === "error") throw new UnavailableError(unavailableMessage())
    const warning = mode === "warn" && !warned.unavailable ? unavailableMessage() : undefined
    if (warning) {
      warned.unavailable = true
      log.warn("sandbox enabled but unavailable", { platform: process.platform })
    }
    return { backend: "none", warning }
  }

  /**
   * Decide how to run a shell command given the sandbox config and the
   * workspace. Never throws unless `onUnavailable: "error"` and no backend
   * exists. The `cwd` is *not* granted write access unless it lies within the
   * workspace — an approved external working directory is a permission decision,
   * not a reason to widen the write boundary to the escape target.
   */
  export function plan(input: {
    command: string
    shell: string
    cwd: string
    /** Workspace roots (Instance.directory + worktree) that stay writable. */
    workspace: string[]
    /** Les bornes de ressources, quand l'appelant en connaît. Sans elles, rien n'est borné. */
    limits?: Limits
    options?: Options
  }): Plan {
    const { backend: b, warning } = decide(input.options)
    if (b === "none") {
      return { file: input.command, useShell: input.shell, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({ workspace: input.workspace, options: input.options! })
    const s = specForArgv([input.shell, "-c", input.command], policy, input.limits)!
    log.info("sandboxing command", { backend: b, network: policy.network, writable: policy.writable.length })
    return { file: s.file, args: s.args, useShell: false, sandboxed: true, backend: b, warning }
  }

  /**
   * Wrap a raw argv (program + args, no shell) — used by the notebook/R kernels
   * which spawn an interpreter directly. When the sandbox is off or unavailable
   * the original `file`/`args` are returned unchanged, so callers can spawn the
   * result verbatim.
   */
  export function wrapArgv(input: {
    file: string
    args: string[]
    /** Workspace roots that stay writable. */
    workspace: string[]
    /** Extra paths (e.g. a generated kernel script under /tmp) to keep writable/visible. */
    extraWritable?: string[]
    /** Exact host credential files to mask from the process. */
    unreadable?: string[]
    /** Les bornes de ressources, quand l'appelant en connaît. Sans elles, rien n'est borné. */
    limits?: Limits
    options?: Options
  }): Wrapped {
    const { backend: b, warning } = decide(input.options)
    if (b === "none") {
      return { file: input.file, args: input.args, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({
      workspace: input.workspace,
      extraWritable: input.extraWritable,
      unreadable: input.unreadable,
      options: input.options!,
    })
    const s = specForArgv([input.file, ...input.args], policy, input.limits)!
    log.info("sandboxing process", { backend: b, network: policy.network, writable: policy.writable.length })
    return { file: s.file, args: s.args, sandboxed: true, backend: b, warning }
  }

  // ── self-test (proves the boundary actually holds on this machine) ──────────

  export interface Check {
    name: string
    pass: boolean
    skipped?: boolean
    detail?: string
  }

  export interface SelfTest {
    backend: Backend
    available: boolean
    checks: Check[]
    ok: boolean
  }

  function firstLine(s?: string): string | undefined {
    const line = s?.trim().split("\n")[0]
    return line || undefined
  }

  function runAsync(file: string, args: string[], cwd: string): Promise<{ status: number; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(file, args, { cwd, stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      proc.stderr?.on("data", (d) => {
        stderr += d.toString()
      })
      const timer = setTimeout(() => proc.kill("SIGKILL"), 15000)
      proc.once("exit", (code) => {
        clearTimeout(timer)
        resolve({ status: code ?? 1, stderr })
      })
      proc.once("error", (err) => {
        clearTimeout(timer)
        resolve({ status: 1, stderr: String(err) })
      })
    })
  }

  /**
   * Empirically verify the sandbox on this machine: write inside a scratch
   * workspace (must succeed), write outside it (must be attempted-and-blocked),
   * and — when connectivity allows — confirm network-deny mode blocks egress.
   * Spawns real sandboxed commands; safe to run anytime. Async so it never
   * blocks the server event loop.
   */
  export async function selfTest(): Promise<SelfTest> {
    const b = backend()
    if (b === "none") return { backend: b, available: false, checks: [], ok: false }

    const shell = Shell.acceptable()
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-sbx-"))
    const outside = path.join(os.homedir(), `.openscience-sbx-escape-${process.pid}`)
    const checks: Check[] = []

    const run = (command: string, network: "allow" | "deny") => {
      const p = plan({ command, shell, cwd: work, workspace: [work], options: { enabled: true, network } })
      return runAsync(p.file, p.args ?? [], work)
    }

    try {
      const inside = await run(`printf hi > "${work}/probe" && cat "${work}/probe"`, "allow")
      const insideOk = inside.status === 0
      checks.push({
        name: "write inside the workspace succeeds",
        pass: insideOk,
        detail: insideOk ? undefined : firstLine(inside.stderr),
      })
      if (!insideOk) {
        // The sandbox isn't running commands correctly here; the remaining checks
        // would false-pass (an escape file simply never gets created), so don't
        // assert containment we can't stand behind.
        checks.push({
          name: "write outside the workspace is blocked",
          pass: false,
          skipped: true,
          detail: "inconclusive — inside-write failed, sandbox not functioning here",
        })
        return { backend: b, available: true, checks, ok: false }
      }

      fs.rmSync(outside, { force: true })
      const escape = await run(`printf x > "${outside}"`, "allow")
      const escaped = fs.existsSync(outside)
      checks.push({
        name: "write outside the workspace is blocked",
        // Require both: no file escaped AND the write was actually refused (not
        // silently succeeding). A missing file with exit 0 means the write went
        // somewhere unexpected, not that it was denied.
        pass: !escaped && escape.status !== 0,
        detail: escaped
          ? `a file escaped to ${outside}`
          : escape.status === 0
            ? "write outside reported success — not denied"
            : undefined,
      })

      const curlCmd = `curl -m 5 -s -o /dev/null https://example.com`
      if (Bun.which("curl")) {
        // Distinguish "sandbox blocked it" from "machine is offline" by checking
        // that egress works in allow-mode before asserting deny-mode blocks it.
        const allow = await run(curlCmd, "allow")
        if (allow.status !== 0) {
          checks.push({
            name: "network egress blocked in deny mode",
            pass: true,
            skipped: true,
            detail: "no outbound connectivity — inconclusive",
          })
        } else {
          const deny = await run(curlCmd, "deny")
          checks.push({
            name: "network egress blocked in deny mode",
            pass: deny.status !== 0,
            detail: deny.status === 0 ? "egress succeeded despite deny" : undefined,
          })
        }
      } else {
        checks.push({
          name: "network egress blocked in deny mode",
          pass: true,
          skipped: true,
          detail: "curl not available — skipped",
        })
      }
    } finally {
      try {
        fs.rmSync(outside, { force: true })
      } catch {}
      try {
        fs.rmSync(work, { recursive: true, force: true })
      } catch {}
    }

    return { backend: b, available: true, checks, ok: checks.filter((c) => !c.skipped).every((c) => c.pass) }
  }
}
