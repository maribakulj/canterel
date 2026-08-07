import { describe, expect, test } from "bun:test"
import { terminalEndpointAvailable } from "@/atlas/terminal-endpoint"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("contextual project terminal", () => {
  test("permits local PTY endpoints without exposing terminals on remote servers", () => {
    expect(terminalEndpointAvailable("http://localhost:4444")).toBe(true)
    expect(terminalEndpointAvailable("https://127.0.0.1:4096")).toBe(true)
    expect(terminalEndpointAvailable("http://[::1]:3000")).toBe(true)
    expect(terminalEndpointAvailable("", "http://localhost:4444")).toBe(true)
    expect(terminalEndpointAvailable("/api", "https://science.example.com")).toBe(false)
    expect(terminalEndpointAvailable("https://science.example.com")).toBe(false)
    expect(terminalEndpointAvailable("not a URL")).toBe(false)
  })

  test("mounts the terminal only as a selected right-pane context", async () => {
    const [pane, surface, action] = await Promise.all([
      read("../atlas/RightPane.tsx"),
      read("../atlas/TerminalSurface.tsx"),
      read("../pages/session-sidebar-action.tsx"),
    ])

    expect(pane).toContain('terminal: "Terminal"')
    expect(pane).toContain('context() === "terminal"')
    expect(pane).toContain("<TerminalSurface />")
    expect(action).toContain('ariaLabel="Open project terminal"')
    expect(action).toContain('props.onContext("terminal")')
    expect(surface).toContain('aria-label="Session terminal"')
    expect(surface).toContain("useExecutionAuthority")
    expect(surface).toContain("!authority.allowed()")
    expect(surface).toContain("Session shell")
    expect(surface).toContain('role="tablist"')
    expect(surface).toContain('role="tabpanel"')
    expect(surface).toContain("active={active()?.id === pty.id}")
    expect(surface).toContain("terminal.close(pty.id)")
  })

  test("offers keyboard and palette commands while keeping PTY requests project scoped", async () => {
    const [session, context, terminal] = await Promise.all([
      read("../pages/session.tsx"),
      read("../context/terminal.tsx"),
      read("./terminal.tsx"),
    ])

    expect(session).toContain('id: "terminal.toggle"')
    expect(session).toContain('keybind: "ctrl+`"')
    expect(session).toContain('id: "terminal.new"')
    expect(session).toContain('keybind: "ctrl+shift+`"')
    expect(context).toContain("load(sdk.scope, params.id)")
    expect(context).toContain("sdk.client.pty")
    expect(terminal).toContain("sdk.request.url(`/pty/${local.pty.id}/connect`)")
  })

  test("keeps existing terminals closable while authority only gates new process creation", async () => {
    const surface = await read("../atlas/TerminalSurface.tsx")

    expect(surface).toContain('useExecutionAuthority("terminal")')
    expect(surface).toContain("disabled={!available() || starting() || !authority.allowed()}")
    expect(surface).toContain("disabled={starting() || !authority.allowed()}")
    expect(surface).toContain("terminal.close(pty.id)")
    expect(surface).not.toContain(
      "disabled={!authority.allowed()}\n                      onClick={() => void terminal.close",
    )
  })
})
