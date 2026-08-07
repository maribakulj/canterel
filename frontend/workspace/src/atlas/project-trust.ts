import type { OpenScienceClient, ProjectTrustGetResponse } from "@synsci/sdk/v2/client"

export type ProjectTrustStatus = ProjectTrustGetResponse
export type ProjectTrustUpdate = { trusted: true; root: string } | { trusted: false }
export type ProjectTrustRequest = {
  projectID: string
  directory: string
}

export interface ProjectTrustApi {
  get(input: ProjectTrustRequest): Promise<ProjectTrustStatus>
  update(input: ProjectTrustRequest & { body: ProjectTrustUpdate }): Promise<ProjectTrustStatus>
}

export function projectTrustApi(client: OpenScienceClient): ProjectTrustApi {
  return {
    get(input) {
      return client.project.trust
        .get({
          projectID: input.projectID,
          directory: input.directory,
        })
        .then((response) => {
          if (response.data) return response.data
          throw new Error("The project trust response was empty.")
        })
    },
    update(input) {
      return client.project.trust
        .update({
          projectID: input.projectID,
          directory: input.directory,
          body: input.body,
        })
        .then((response) => {
          if (response.data) return response.data
          throw new Error("The updated project trust response was empty.")
        })
    },
  }
}
