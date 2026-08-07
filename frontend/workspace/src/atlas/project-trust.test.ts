import { describe, expect, test } from "bun:test"
import type { OpenScienceClient } from "@synsci/sdk/v2/client"
import { projectTrustApi, type ProjectTrustStatus } from "./project-trust"

const status: ProjectTrustStatus = {
  projectID: "prj_lattice",
  root: "/Users/research/lattice",
  revision: 1,
  state: "untrusted",
  source: "default",
  canExecuteProjectCode: false,
}

describe("project trust API", () => {
  test("uses the generated GET and PUT contract with the canonical root", async () => {
    const calls: unknown[] = []
    const client = {
      project: {
        trust: {
          get: async (input: unknown) => {
            calls.push(["get", input])
            return { data: status }
          },
          update: async (input: unknown) => {
            calls.push(["update", input])
            return {
              data: {
                ...status,
                state: "trusted",
                source: "persisted",
                canExecuteProjectCode: true,
              },
            }
          },
        },
      },
    } as unknown as OpenScienceClient
    const api = projectTrustApi(client)

    expect(await api.get({ projectID: status.projectID, directory: status.root })).toEqual(status)
    expect(
      await api.update({
        projectID: status.projectID,
        directory: status.root,
        body: { trusted: true, root: status.root },
      }),
    ).toMatchObject({ state: "trusted", canExecuteProjectCode: true })
    expect(calls).toEqual([
      [
        "get",
        {
          projectID: status.projectID,
          directory: status.root,
        },
      ],
      [
        "update",
        {
          projectID: status.projectID,
          directory: status.root,
          body: { trusted: true, root: status.root },
        },
      ],
    ])
  })

  test("fails closed when a successful SDK response has no trust data", async () => {
    const client = {
      project: {
        trust: {
          get: async () => ({}),
          update: async () => ({}),
        },
      },
    } as unknown as OpenScienceClient
    const api = projectTrustApi(client)

    await expect(api.get({ projectID: status.projectID, directory: status.root })).rejects.toThrow(
      "project trust response was empty",
    )
    await expect(
      api.update({
        projectID: status.projectID,
        directory: status.root,
        body: { trusted: false },
      }),
    ).rejects.toThrow("updated project trust response was empty")
  })
})
