/**
 * A single violation reported by a repository check.
 *
 * `rule` is stable and machine-readable; `where` is repo-relative so findings can be compared
 * across checkouts and quoted in review.
 */
export type Finding = {
  readonly rule: string;
  readonly where: string;
  readonly message: string;
};

/**
 * Render findings for a terminal, grouped by rule and sorted for a stable diff.
 *
 * Returns the process exit code so callers stay a one-liner.
 */
export function report(check: string, findings: readonly Finding[]): number {
  if (findings.length === 0) {
    process.stdout.write(`${check}: ok\n`);
    return 0;
  }
  const lines = [`${check}: ${findings.length} violation(s)`, ""];
  for (const rule of [...new Set(findings.map((finding) => finding.rule))].sort()) {
    lines.push(`  [${rule}]`);
    for (const finding of findings.filter((candidate) => candidate.rule === rule).sort(byWhere)) {
      lines.push(`    ${finding.where}: ${finding.message}`);
    }
    lines.push("");
  }
  process.stderr.write(`${lines.join("\n")}\n`);
  return 1;
}

function byWhere(left: Finding, right: Finding): number {
  return left.where.localeCompare(right.where) || left.message.localeCompare(right.message);
}
