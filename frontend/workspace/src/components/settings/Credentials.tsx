import { type Component } from "solid-js"
import { CredentialServices } from "./CredentialServices"

export const Credentials: Component = () => (
  <div class="flex h-full flex-col overflow-y-auto no-scrollbar">
    <header class="settings-page-header">
      <h2>Credentials</h2>
      <p>Connect research services that do not belong to Models or Compute.</p>
    </header>
    <div class="settings-page-body">
      <CredentialServices
        category="integration"
        title="Integrations"
        description="These encrypted values are available to the tools and agents that need them."
        custom
      />
    </div>
  </div>
)

export default Credentials
