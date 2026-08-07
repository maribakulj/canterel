import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Terminal } from "@/components/terminal"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { IconPlus, IconTerminal, IconX } from "@/atlas/shared/Icon"
import { terminalEndpointAvailable } from "@/atlas/terminal-endpoint"
import { useExecutionAuthority } from "@/atlas/use-execution-authority"

export function TerminalSurface(): JSX.Element {
  const sdk = useSDK()
  const terminal = useTerminal()
  const authority = useExecutionAuthority("terminal")
  const [starting, setStarting] = createSignal(false)
  const [connecting, setConnecting] = createSignal(false)
  const [error, setError] = createSignal("")
  const available = createMemo(() => terminalEndpointAvailable(sdk.url))
  const active = createMemo(() => terminal.all().find((item) => item.id === terminal.active()))

  createEffect(() => {
    if (!terminal.ready() || terminal.active() || !terminal.all().length) return
    terminal.open(terminal.all()[0].id)
  })

  const launch = () => {
    if (!available() || starting()) return
    if (!authority.allowed()) {
      setError(authority.message() ?? "This session cannot start a terminal.")
      return
    }
    setStarting(true)
    setConnecting(true)
    setError("")
    void terminal
      .new()
      .then(() => setError(""))
      .catch((cause: unknown) => {
        setConnecting(false)
        setError(cause instanceof Error ? cause.message : "OpenScience could not start the terminal.")
      })
      .finally(() => setStarting(false))
  }

  const autostart = { requested: false }
  createEffect(() => {
    if (autostart.requested || !available() || !terminal.ready() || terminal.all().length || starting()) return
    if (!authority.allowed()) return
    autostart.requested = true
    launch()
  })

  return (
    <section class="terminal-surface" aria-label="Session terminal">
      <div class="terminal-surface__toolbar">
        <div class="terminal-surface__identity">
          <IconTerminal size={13} strokeWidth={1.5} />
          <span>Session shell</span>
        </div>
        <button
          type="button"
          class="terminal-surface__new"
          onClick={launch}
          disabled={!available() || starting() || !authority.allowed()}
          title={authority.message()}
          aria-label={starting() ? "Starting terminal" : "New terminal"}
        >
          <IconPlus size={12} strokeWidth={1.7} />
          <span>{starting() ? "Starting…" : "New"}</span>
        </button>
      </div>

      <Show when={error()}>
        {(message) => (
          <div class="terminal-surface__error" role="alert">
            {message()}
          </div>
        )}
      </Show>

      <Show when={available() ? authority.message() : undefined}>
        {(message) => (
          <div class="terminal-surface__authority" role={authority.decision.error ? "alert" : "status"}>
            {message()}
          </div>
        )}
      </Show>

      <Show
        when={available()}
        fallback={
          <div class="terminal-surface__empty">
            <span class="terminal-surface__empty-mark" aria-hidden="true">
              &gt;_
            </span>
            <strong>Local terminal unavailable</strong>
            <p>Connect OpenScience to a local server to run a shell inside this project.</p>
          </div>
        }
      >
        <Show
          when={terminal.ready()}
          fallback={
            <div class="terminal-surface__empty" aria-live="polite">
              <span class="terminal-surface__eyebrow">Preparing session shell…</span>
            </div>
          }
        >
          <Show
            when={terminal.all().length}
            fallback={
              <div class="terminal-surface__empty">
                <span class="terminal-surface__empty-mark" aria-hidden="true">
                  &gt;_
                </span>
                <strong>Run commands in this session</strong>
                <p>The shell opens on demand inside this session’s approved workspace.</p>
                <button
                  type="button"
                  onClick={launch}
                  disabled={starting() || !authority.allowed()}
                  title={authority.message()}
                  data-modal-initial-focus
                >
                  {starting() ? "Starting…" : "Start terminal"}
                </button>
              </div>
            }
          >
            <nav class="terminal-surface__tabs" role="tablist" aria-label="Open terminals">
              <For each={terminal.all()}>
                {(pty) => (
                  <div class="terminal-surface__tab-shell" data-active={active()?.id === pty.id ? "true" : undefined}>
                    <button
                      type="button"
                      class="terminal-surface__tab"
                      role="tab"
                      aria-selected={active()?.id === pty.id}
                      aria-controls={`terminal-wrapper-${pty.id}`}
                      onClick={() => terminal.open(pty.id)}
                    >
                      {pty.title}
                    </button>
                    <button
                      type="button"
                      class="terminal-surface__close"
                      aria-label={`Close ${pty.title}`}
                      onClick={() => void terminal.close(pty.id)}
                    >
                      <IconX size={10} strokeWidth={1.7} />
                    </button>
                  </div>
                )}
              </For>
            </nav>

            <div class="terminal-surface__viewport">
              <Show when={connecting()}>
                <div class="terminal-surface__connecting" role="status" aria-live="polite">
                  <span class="terminal-surface__connecting-mark" aria-hidden="true">
                    &gt;_
                  </span>
                  <span>Starting session shell…</span>
                </div>
              </Show>
              <For each={terminal.all()}>
                {(pty) => (
                  <div
                    id={`terminal-wrapper-${pty.id}`}
                    class="terminal-surface__terminal"
                    role="tabpanel"
                    aria-label={pty.title}
                    aria-hidden={active()?.id === pty.id ? undefined : "true"}
                    data-active={active()?.id === pty.id ? "true" : "false"}
                  >
                    <Terminal
                      pty={pty}
                      active={active()?.id === pty.id}
                      onCleanup={(next) => terminal.update(next)}
                      onConnect={() => {
                        setConnecting(false)
                        setError("")
                      }}
                      onConnectError={(cause) => {
                        setConnecting(false)
                        setError(cause.message)
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
