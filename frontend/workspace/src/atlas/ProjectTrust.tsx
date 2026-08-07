import { For, Show, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { Popover } from "@synsci/ui/popover"
import { IconChevronDown } from "@/atlas/shared/Icon"
import type { ProjectTrustApi, ProjectTrustStatus, ProjectTrustUpdate } from "./project-trust"
import "./ProjectTrust.css"

const CAPABILITIES = [
  "Startup scripts and project dependency installation",
  "Project plugins, skills, and MCP servers",
  "Project formatters and language servers",
  "Provider modules and token commands",
] as const

export function ProjectTrustControl(props: {
  projectID?: string
  name: string
  directory: string
  api: ProjectTrustApi
}) {
  const [store, setStore] = createStore({
    open: false,
    action: undefined as "trust" | "revoke" | undefined,
    error: undefined as string | undefined,
  })
  const [trust, { mutate, refetch }] = createResource(
    () => props.projectID,
    (projectID) =>
      props.api.get({
        projectID,
        directory: props.directory,
      }),
  )

  const state = createMemo(() => {
    if (trust.error || store.error) return "error"
    return trust()?.state ?? "loading"
  })
  const label = createMemo(() => {
    if (state() === "trusted") return "project code on"
    if (state() === "untrusted" || state() === "revoked") return "read-only"
    if (state() === "error") return "trust unavailable"
    return "checking trust"
  })
  const error = createMemo(() => {
    const value = store.error ?? trust.error
    if (!value) return
    return value instanceof Error ? value.message : String(value)
  })

  const update = (body: ProjectTrustUpdate, action: "trust" | "revoke") => {
    const projectID = props.projectID
    if (!projectID || store.action) return
    setStore({ action, error: undefined })
    void props.api
      .update({
        projectID,
        directory: props.directory,
        body,
      })
      .then((next) => mutate(next))
      .catch((cause: unknown) => {
        setStore("error", cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setStore("action", undefined))
  }

  const retry = () => {
    setStore("error", undefined)
    void refetch()
  }

  return (
    <div class="project-trust">
      <Popover
        open={store.open}
        onOpenChange={(open) => setStore("open", open)}
        placement="bottom-start"
        gutter={7}
        title="Project permissions"
        class="project-trust__popover"
        triggerAs="button"
        triggerProps={{
          type: "button",
          class: `project-trust__trigger project-trust__trigger--${state()}`,
          "aria-label": `${props.name} project permissions: ${label()}`,
        }}
        trigger={
          <>
            <span class="project-trust__dot" aria-hidden="true" />
            <span>{label()}</span>
            <IconChevronDown class="project-trust__chevron" size={10} strokeWidth={1.5} />
          </>
        }
      >
        <div class="project-trust__body">
          <Show
            when={!trust.loading && !trust.error ? trust() : undefined}
            fallback={
              <Show
                when={error()}
                fallback={
                  <div class="project-trust__loading" role="status" aria-live="polite">
                    <span>Checking project trust…</span>
                    <span class="project-trust__loading-line" aria-hidden="true" />
                    <span class="project-trust__loading-line" aria-hidden="true" />
                  </div>
                }
              >
                {(message) => (
                  <div class="project-trust__error" role="alert">
                    <p>Couldn’t load project trust. {message()}</p>
                    <button type="button" class="project-trust__retry" disabled={trust.loading} onClick={retry}>
                      Try again
                    </button>
                  </div>
                )}
              </Show>
            }
          >
            {(status) => (
              <TrustContent
                name={props.name}
                status={status()}
                action={store.action}
                error={store.error}
                onTrust={() => update({ trusted: true, root: status().root }, "trust")}
                onRevoke={() => update({ trusted: false }, "revoke")}
              />
            )}
          </Show>
        </div>
      </Popover>
    </div>
  )
}

function TrustContent(props: {
  name: string
  status: ProjectTrustStatus
  action?: "trust" | "revoke"
  error?: string
  onTrust: () => void
  onRevoke: () => void
}) {
  const trusted = () => props.status.canExecuteProjectCode
  return (
    <div class="project-trust__content" data-state={props.status.state}>
      <div class="project-trust__state">
        <span class="project-trust__state-mark" aria-hidden="true" />
        <strong>
          {trusted()
            ? "Project code enabled"
            : props.status.state === "revoked"
              ? "Trust revoked"
              : "Read-only project"}
        </strong>
        <p>
          {trusted()
            ? "This project may run its local automation."
            : "Project context is available, but project-local code cannot run."}
        </p>
      </div>

      <dl class="project-trust__identity">
        <dt>Project</dt>
        <dd title={props.name}>{props.name}</dd>
        <dt>Canonical root</dt>
        <dd title={props.status.root}>
          <code>{props.status.root}</code>
        </dd>
      </dl>

      <div class="project-trust__capabilities">
        <span>{trusted() ? "Executable capabilities enabled" : "Trusting this project enables"}</span>
        <ul>
          <For each={CAPABILITIES}>{(capability) => <li>{capability}</li>}</For>
        </ul>
      </div>

      <Show
        when={trusted()}
        fallback={
          <>
            <p class="project-trust__note">
              Review the canonical root and project-controlled files first. Trust is never granted automatically.
            </p>
            <button
              type="button"
              class="project-trust__action"
              disabled={props.action !== undefined}
              onClick={props.onTrust}
            >
              {props.action === "trust" ? "Trusting…" : "Trust this project"}
            </button>
          </>
        }
      >
        <p class="project-trust__note">
          Revoking immediately blocks project code and disposes this project’s active caches. Unsaved in-memory tool or
          language-service state may be lost; files on disk stay intact. You can trust it again later.
        </p>
        <button
          type="button"
          class="project-trust__action project-trust__action--revoke"
          disabled={props.action !== undefined}
          onClick={props.onRevoke}
        >
          {props.action === "revoke" ? "Revoking…" : "Revoke trust"}
        </button>
      </Show>

      <Show when={props.error}>
        <div class="project-trust__error" role="alert">
          <p>Couldn’t update project trust. {props.error}</p>
        </div>
      </Show>
    </div>
  )
}
