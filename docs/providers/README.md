# Task-provider guides

Task providers own task discovery, native routing and status mapping, atomic
claims, leases, durable execution history, comments, artifacts and lifecycle
synchronization. Select the guide for the adapter configured by the Ensemble
host:

- [Vikunja](VIKUNJA.md)
- [Azure DevOps Services](AZURE_DEVOPS.md)

Provider-specific fields belong in the host configuration. Provider secrets
belong only in the protected env file. Repository `.ensemble` configuration
uses portable status names and must not interpret provider metadata.
