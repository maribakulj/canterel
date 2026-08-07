import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ProjectTrustApi, ProjectTrustRequest, ProjectTrustStatus, ProjectTrustUpdate } from "./project-trust"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/ProjectTrust.tsx") as Promise<typeof import("./ProjectTrust")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []
const root = "/Users/research/Lattice Lab/assay"
const base: ProjectTrustStatus = {
  projectID: "prj_lattice",
  root,
  revision: 1,
  state: "untrusted",
  source: "default",
  canExecuteProjectCode: false,
}

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const settle = async () => {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const trigger = () => document.querySelector<HTMLButtonElement>(".project-trust__trigger")
const content = () => document.querySelector<HTMLElement>('[data-component="popover-content"].project-trust__popover')
const action = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes(label),
  )

const render = (api: ProjectTrustApi) =>
  mount(() =>
    web.createComponent(subject.ProjectTrustControl, {
      projectID: base.projectID,
      name: "Lattice assay",
      directory: root,
      api,
    }),
  )

describe("ProjectTrustControl", () => {
  test("lives inline in project context without adding a permanent pane", async () => {
    const session = await Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()
    const title = session.indexOf('class="workspace-header__project"')
    const trust = session.indexOf("<ProjectTrustControl")
    const spacer = session.indexOf('class="workspace-header__spacer"')

    expect(title).toBeGreaterThan(-1)
    expect(trust).toBeGreaterThan(title)
    expect(spacer).toBeGreaterThan(trust)
    expect(session).not.toContain('<RightPane project={sdk.scope} session={params.id ?? "new"} trust=')
  })

  test("keeps untrusted projects read-only until an explicit canonical-root consent", async () => {
    const gets: ProjectTrustRequest[] = []
    const updates: Array<ProjectTrustRequest & { body: ProjectTrustUpdate }> = []
    const waits: Array<(status: ProjectTrustStatus) => void> = []
    const api: ProjectTrustApi = {
      get: async (input) => {
        gets.push(input)
        return base
      },
      update: (input) => {
        updates.push(input)
        return new Promise((resolve) => waits.push(resolve))
      },
    }
    render(api)
    await settle()

    expect(gets).toEqual([{ projectID: base.projectID, directory: root }])
    expect(updates).toEqual([])
    expect(trigger()?.textContent).toContain("read-only")
    expect(trigger()?.getAttribute("aria-label")).toContain("Lattice assay project permissions: read-only")

    trigger()?.click()
    await settle()

    expect(content()?.textContent).toContain("Read-only project")
    expect(content()?.textContent).toContain("Lattice assay")
    expect(content()?.textContent).toContain(root)
    expect(content()?.textContent).toContain("Startup scripts and project dependency installation")
    expect(content()?.textContent).toContain("Project plugins, skills, and MCP servers")
    expect(content()?.textContent).toContain("Project formatters and language servers")
    expect(content()?.textContent).toContain("Provider modules and token commands")
    expect(content()?.textContent).toContain("Trust is never granted automatically")
    expect(content()?.textContent).not.toContain(base.projectID)
    expect(content()?.textContent).not.toContain("PUT")
    expect(updates).toEqual([])

    action("Trust this project")?.click()
    await settle()

    expect(updates).toEqual([
      {
        projectID: base.projectID,
        directory: root,
        body: { trusted: true, root },
      },
    ])
    expect(action("Trusting…")?.disabled).toBe(true)

    waits.shift()?.({
      ...base,
      state: "trusted",
      source: "persisted",
      canExecuteProjectCode: true,
    })
    await settle()

    expect(trigger()?.textContent).toContain("project code on")
    expect(content()?.textContent).toContain("Project code enabled")
    expect(content()?.textContent).toContain("disposes this project’s active caches")
    expect(content()?.textContent).toContain("Unsaved in-memory tool or language-service state may be lost")
    expect(content()?.textContent).toContain("files on disk stay intact")

    action("Revoke trust")?.click()
    await settle()
    expect(updates[1]).toEqual({
      projectID: base.projectID,
      directory: root,
      body: { trusted: false },
    })
    expect(action("Revoking…")?.disabled).toBe(true)

    waits.shift()?.({
      ...base,
      state: "revoked",
      source: "persisted",
      canExecuteProjectCode: false,
    })
    await settle()

    expect(trigger()?.textContent).toContain("read-only")
    expect(content()?.textContent).toContain("Trust revoked")
    expect(action("Trust this project")).toBeTruthy()
  })

  test("renders a compact loading state and recovers from a load error", async () => {
    const loads: Array<(status: ProjectTrustStatus) => void> = []
    const api: ProjectTrustApi = {
      get: () => new Promise((resolve) => loads.push(resolve)),
      update: async () => base,
    }
    render(api)

    trigger()?.click()
    await settle()
    expect(content()?.querySelector('[role="status"]')?.textContent).toContain("Checking project trust")

    loads.shift()?.(base)
    await settle()
    expect(content()?.textContent).toContain("Read-only project")

    cleanups.pop()?.()
    document.body.replaceChildren()

    const calls: number[] = []
    render({
      get: async () => {
        calls.push(calls.length)
        if (calls.length === 1) throw new Error("server unavailable")
        return base
      },
      update: async () => base,
    })
    await settle()
    trigger()?.click()
    await settle()

    expect(content()?.querySelector('[role="alert"]')?.textContent).toContain("server unavailable")
    action("Try again")?.click()
    await settle()
    expect(calls).toHaveLength(2)
    expect(content()?.textContent).toContain("Read-only project")
  })

  test("moves focus into the popover and closes it with Escape", async () => {
    render({
      get: async () => base,
      update: async () => base,
    })
    await settle()

    const button = trigger()
    button?.focus()
    button?.click()
    await settle()
    expect(button?.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(content()?.querySelector('[data-slot="popover-close-button"]') ?? null)

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await settle()

    expect(button?.getAttribute("aria-expanded")).toBe("false")
    expect(button?.tabIndex).toBe(0)
  })

  test("ships visible focus styles and reduced-motion loading behavior", async () => {
    const css = await Bun.file(new URL("./ProjectTrust.css", import.meta.url)).text()

    expect(css).toContain(".project-trust__trigger:focus-visible")
    expect(css).toContain(".project-trust__action:focus-visible")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  })
})
