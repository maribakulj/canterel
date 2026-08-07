const titlecase = (s: string) =>
  s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

// There's no reliable signal to distinguish a first-party multi-word tool id
// (e.g. "science_list_dbs") from an MCP "namespace_tool" id, so titlecase both.
export function humanizeToolName(tool: string): string {
  return titlecase(tool)
}

// OpenRouter (and some providers) return encrypted reasoning as a "[REDACTED]"
// placeholder appended to — or standing in for — the readable summary; the real
// payload is the encrypted blob carried in the part's metadata for model
// continuity, never meant for display. Strip the placeholder from reasoning text.
// (Tool output keeps its own "[REDACTED]" secret masking; this is reasoning-only.)
export function stripRedactedReasoning(text: string): string {
  return (text ?? "").replaceAll("[REDACTED]", "").trim()
}

/**
 * Files a turn actually wrote, from its completed tool parts. write/edit/
 * multiedit carry the target in input.filePath; apply_patch lists every
 * changed file (with moves resolved and deletes skipped) in its completed
 * metadata. The notebook tool takes only code — kernel-side writes carry no
 * path in the part — so it is deliberately not guessed at here.
 */
export function writtenFiles(
  parts: ReadonlyArray<{
    type: string
    tool?: string
    state?: { status?: string; input?: unknown; metadata?: unknown }
  }>,
): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown) => {
    if (typeof value !== "string" || !value || seen.has(value)) return
    seen.add(value)
    files.push(value)
  }
  for (const part of parts) {
    if (part.type !== "tool" || part.state?.status !== "completed") continue
    const input = (part.state.input ?? {}) as Record<string, unknown>
    if (part.tool === "write" || part.tool === "edit" || part.tool === "multiedit") push(input.filePath)
    if (part.tool !== "apply_patch") continue
    const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
    const changes = Array.isArray(metadata.files) ? metadata.files : []
    for (const change of changes) {
      if (!change || typeof change !== "object") continue
      const record = change as Record<string, unknown>
      if (record.type === "delete") continue
      push(record.movePath ?? record.filePath)
    }
  }
  return files
}

/**
 * End-of-turn "Save as artifact" affordance: a single written file gets the
 * bare action, several written files get one labeled action per path.
 */
export function artifactActions(files: readonly string[]): Array<{ path: string; label: string }> {
  if (files.length === 1) return [{ path: files[0], label: "Save as artifact…" }]
  return files.map((file) => ({
    path: file,
    label: `Save as artifact… ${file.split("/").pop() || file}`,
  }))
}

export function skillName(source: {
  metadata?: Record<string, unknown>
  input?: Record<string, unknown>
  title?: string
}): string {
  const meta = source.metadata?.name
  if (typeof meta === "string" && meta) return meta
  const input = source.input?.name
  if (typeof input === "string" && input) return input
  const title = source.title
  if (typeof title === "string" && title.startsWith("Loaded skill: ")) return title.slice("Loaded skill: ".length)
  return "skill"
}
