import crypto from "crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Config } from "@/config/config"
import { Sandbox } from "@/sandbox/sandbox"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "./instance"
import { Project } from "./project"
import { ProjectTrust } from "./trust"

/**
 * The single process-execution authority for a project session.
 *
 * Permission prompts answer whether one requested action is approved. This
 * decision answers whether the owning project/session may create a process at
 * all, and captures the exact trust, filesystem, and sandbox revisions applied
 * to that process.
 */
export namespace ExecutionAuthority {
  export const Capability = z.enum([
    "terminal",
    "kernel",
    "shell",
    "local_job",
    "remote_job",
    "package_install",
    "project_plugin",
    "project_mcp",
    "project_formatter",
    "project_lsp",
    "provider_token_command",
  ])
  export type Capability = z.infer<typeof Capability>

  export const Decision = z.object({
    allowed: z.boolean(),
    reason: z.enum(["allowed", "project_untrusted", "sandbox_unavailable"]),
    capability: Capability,
    mode: z.enum(["read_only", "sandboxed", "host"]),
    projectID: z.string(),
    sessionID: z.string(),
    trustRevision: z.number().int().positive(),
    grantRevision: z.number().int().positive(),
    generation: z.string(),
    workspace: z.string(),
    writable: z.array(z.string()),
    sandbox: z.object({
      enabled: z.boolean(),
      network: z.enum(["allow", "deny"]),
      allowWrite: z.array(z.string()),
      onUnavailable: z.enum(["warn", "error", "allow"]),
      backend: z.enum(["seatbelt", "bubblewrap", "bubblewrap+cgroup", "none"]),
      available: z.boolean(),
      enforced: z.boolean(),
    }),
    remediation: ProjectTrust.Status.shape.remediation,
  })
  export type Decision = z.infer<typeof Decision>

  export const DeniedError = NamedError.create("ExecutionAuthorityDeniedError", Decision)

  /**
   * Per-session network constraints, keyed by session id.
   *
   * # Why a session may override a machine-wide setting
   *
   * The sandbox policy is deliberately machine-wide: it is a safety setting of the installation,
   * and a project-scoped value would be silently ignored (see `Config.setSandbox`). A Locus
   * mission is a different thing — an institutional decision, admitted by this worker, which
   * states the network mode the attempt must run under. §15.4 carries it, and the capability
   * manifest advertises that this worker can enforce *both* `deny` and `full`.
   *
   * Without this, that advertisement was false: the mode travelled from the daemon to the plan and
   * stopped there, and every attempt ran under whatever the installation happened to be
   * configured for. Measured: a mission declaring `full` whose `curl` returned nothing, and a
   * model that fabricated numbers rather than report the empty response.
   *
   * # In memory, and deliberately so
   *
   * A persisted override would outlive the mission that asked for it. The worker process handles
   * one attempt and exits; an override that survived it would apply to whatever ran next, which is
   * the failure mode this exists to prevent.
   */
  const sessionNetwork = new Map<string, "allow" | "deny">()

  /**
   * Bind SESSION to NETWORK for as long as this process lives.
   *
   * Called by the Locus seam once a mission is admitted, from the mode the mission declares. Not
   * exposed to tools or to the model: a session that could widen its own network boundary would
   * make the declaration meaningless.
   */
  export function constrainSession(sessionID: string, network: "allow" | "deny") {
    sessionNetwork.set(sessionID, network)
  }

  /** Forget SESSION's constraint. */
  export function releaseSession(sessionID: string) {
    sessionNetwork.delete(sessionID)
  }

  export async function decide(input: {
    projectID?: string
    sessionID: string
    capability: Capability
  }): Promise<Decision> {
    if (input.projectID !== undefined && input.projectID !== Instance.project.id) {
      throw new Project.MismatchError({
        projectID: input.projectID,
        directory: Instance.directory,
      })
    }

    const [trust, filesystem, policy] = await Promise.all([
      ProjectTrust.status(Instance.project),
      SessionFilesystem.snapshot(input.sessionID),
      Config.trustedSandbox(),
    ])
    const backend = Sandbox.describe()
    const sandbox = {
      enabled: policy.enabled ?? true,
      // The mission's mode wins when there is one. Absent, the installation's setting applies —
      // which is what every non-Locus session gets, unchanged.
      network: sessionNetwork.get(input.sessionID) ?? policy.network ?? "deny",
      allowWrite: policy.allowWrite ?? [],
      onUnavailable: policy.onUnavailable ?? "error",
      backend: backend.backend,
      available: backend.available,
      enforced: (policy.enabled ?? true) && backend.available,
    }
    const untrusted = !trust.canExecuteProjectCode
    const unavailable = sandbox.enabled && !sandbox.available && sandbox.onUnavailable === "error"
    const reason = untrusted ? "project_untrusted" : unavailable ? "sandbox_unavailable" : "allowed"
    const mode = untrusted || unavailable ? "read_only" : sandbox.enabled ? "sandboxed" : "host"
    const writable = await SessionFilesystem.processWriteRoots(input.sessionID)
    const workspace = await SessionFilesystem.workspace(input.sessionID)
    const generation = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          trustRevision: trust.revision,
          grantRevision: filesystem.revision,
          sandbox,
        }),
      )
      .digest("hex")

    return {
      allowed: reason === "allowed",
      reason,
      capability: input.capability,
      mode,
      projectID: Instance.project.id,
      sessionID: input.sessionID,
      trustRevision: trust.revision,
      grantRevision: filesystem.revision,
      generation,
      workspace,
      writable,
      sandbox,
      remediation: trust.remediation,
    }
  }

  export async function require(input: {
    projectID?: string
    sessionID: string
    capability: Capability
  }): Promise<Decision> {
    const result = await decide(input)
    if (result.allowed) return result
    throw new DeniedError(result)
  }
}
