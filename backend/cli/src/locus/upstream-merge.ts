import { classify, UPSTREAM_BRANCH, UPSTREAM_URL, type MergeVerdict } from "./upstream.ts"

/**
 * Le merge amont à blanc — le test de sortie de W2.1.
 *
 * Rien n'est écrit : ni index, ni répertoire de travail, ni commit. `git merge-tree --write-tree`
 * calcule l'arbre fusionné en mémoire objet, et la comparaison porte sur cet arbre. Un contrôle
 * qui laisserait le dépôt à moitié fusionné en cas d'échec serait un contrôle qu'on n'ose pas
 * lancer.
 */

export type DryRun =
  | { readonly ok: true; readonly verdict: MergeVerdict; readonly conflicts: readonly string[] }
  | { readonly ok: false; readonly reason: string }

async function git(args: readonly string[], cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, out: code === 0 ? out : `${out}${err}` }
}

/**
 * S'assurer que `upstream` pointe où il faut, sans jamais le redéfinir en silence.
 *
 * Un remote existant qui vise ailleurs est signalé plutôt que réécrit : quelqu'un l'a peut-être
 * fait exprès, et écraser sa configuration pour faire passer un contrôle serait le contraire de
 * ce que le contrôle sert à établir.
 */
export async function ensureUpstream(cwd: string): Promise<string | null> {
  const existing = await git(["remote", "get-url", "upstream"], cwd)
  if (existing.code === 0) {
    const url = existing.out.trim()
    if (url !== UPSTREAM_URL && !url.endsWith("OpenScience.git") && !url.endsWith("OpenScience")) {
      return `le remote \`upstream\` pointe vers ${url}, pas vers ${UPSTREAM_URL}`
    }
    return null
  }
  const added = await git(["remote", "add", "upstream", UPSTREAM_URL], cwd)
  return added.code === 0 ? null : `impossible d'ajouter le remote upstream : ${added.out}`
}

/**
 * Calculer ce qu'un merge amont changerait, sans le faire.
 *
 * Rend `ok: false` quand l'amont est injoignable — hors ligne, ou pare-feu. Ce n'est pas une
 * violation de la politique et le dire autrement rendrait le contrôle bruyant là où il devrait
 * être muet.
 */
export async function dryRunMerge(cwd: string): Promise<DryRun> {
  const remote = await ensureUpstream(cwd)
  if (remote) return { ok: false, reason: remote }

  const fetched = await git(["fetch", "--quiet", "upstream", UPSTREAM_BRANCH], cwd)
  if (fetched.code !== 0) {
    return { ok: false, reason: `amont injoignable : ${fetched.out.trim().split("\n")[0] ?? ""}` }
  }

  // Sans base de fusion, `merge-tree` refuse — et son message ressemble à une panne réseau. Le
  // nommer ici évite de lire « amont injoignable » là où le dépôt est simplement tronqué.
  //
  // La superficialité se constate APRÈS coup, jamais avant : un clone superficiel garde souvent
  // un ancêtre commun avec l'amont, parce que sa frontière tombe au-delà du point de fork. Court-
  // circuiter sur `--is-shallow-repository` sauterait un contrôle parfaitement exécutable — et un
  // contrôle sauté par excès de prudence ne se distingue plus d'un contrôle absent.
  const base = await git(["merge-base", "HEAD", `upstream/${UPSTREAM_BRANCH}`], cwd)
  if (base.code !== 0) {
    const shallow = await git(["rev-parse", "--is-shallow-repository"], cwd)
    const why =
      shallow.out.trim() === "true"
        ? "clone superficiel : la frontière coupe l'ancêtre commun (fetch-depth: 0)"
        : "aucun ancêtre commun avec l'amont"
    return { ok: false, reason: `base de fusion introuvable — ${why}` }
  }

  const merged = await git(["merge-tree", "--write-tree", "HEAD", `upstream/${UPSTREAM_BRANCH}`], cwd)
  // `merge-tree` sort 1 quand il y a des conflits, et l'arbre reste utilisable : la première
  // ligne est l'OID, les suivantes décrivent les conflits.
  if (merged.code > 1) return { ok: false, reason: `merge-tree a échoué : ${merged.out}` }

  const lines = merged.out.trim().split("\n")
  const tree = lines[0]?.trim()
  if (!tree) return { ok: false, reason: "merge-tree n'a pas rendu d'arbre" }
  const conflicts = lines.slice(1).filter((line) => line.trim().length > 0 && !line.startsWith("Auto-merging"))

  const diff = await git(["diff", "--name-only", "HEAD", tree], cwd)
  if (diff.code !== 0) return { ok: false, reason: `diff impossible : ${diff.out}` }

  const paths = diff.out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return { ok: true, verdict: classify(paths), conflicts }
}
