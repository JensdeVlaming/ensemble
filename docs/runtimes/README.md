# Runtime guides

Runtimes own how one selected Ensemble role is executed. They translate the
portable runtime context into a native prompt or request, start and resume
sessions, normalize runtime events, return a structured result, and implement
cancellation.

Select the guide for the runtime registered by the Ensemble host:

- [Codex App Server](CODEX_APP_SERVER.md)

Runtime-specific executable paths, authentication, child environments,
arguments and repository `runtime.config` fields belong in the runtime guide.
Provider credentials must never be passed to a runtime.
