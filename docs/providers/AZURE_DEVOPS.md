# Azure DevOps Services Provider Guide

This guide configures Ensemble's Azure DevOps Services REST 7.1 adapter. It
supports the cloud service at `https://dev.azure.com`; Azure DevOps Server is not
supported. Complete the provider-neutral [Starter Guide](../STARTER_GUIDE.md)
first.

The adapter uses Azure Boards work items as its task provider. The repository
URL remains an independent host registration used to materialize workspaces.
Ensemble does not manage Azure Repos, Pipelines, builds, releases, or deployments.

## 1. What the adapter owns

The adapter:

- Executes one saved flat work-item query as the registration's managed namespace.
- Maps configured Azure work-item states to portable Ensemble states.
- Applies optional tag and assignee routing, priority, acceptance-criteria, and
  blocker-relation mappings.
- Stores claims, renewable leases, history, comments, artifacts, retries, and
  next-role state in a configured custom work-item field.
- Uses revision-tested JSON Patch writes so competing controllers cannot silently
  overwrite durable state.
- Recovers active executions through a separate state-field WIQL query even when
  an item has drifted outside the saved query.
- Exposes bounded runtime tools for reading the current task, comments, and
  artifact references, and for adding an idempotent work-item comment.
- Polls continuously and can accept authenticated Azure Service Hook wake hints.

Provider credentials remain in the controller. They are not added to runtime
prompts, workspaces, or child-process environments.

## 2. Create the PAT

Create a Personal Access Token in the same Azure DevOps organization as the
configured project. The minimum likely PAT scope for the implemented operations
is **Work Items: Read & write**, corresponding to `vso.work_write`. It covers
reading and updating work items, comments, queries, and work-item metadata. The
PAT's identity must also have project permissions to read the saved query and
work items and to edit every managed work item's state, history, comments, and
custom state field.

Store the PAT in the protected Ensemble env file:

```text
AZURE_DEVOPS_PAT=replace-with-a-real-pat
```

The controller sends it using Azure DevOps PAT Basic authentication, equivalent
to an HTTP `Authorization: Basic base64(":" + PAT)` header. Host YAML references
the secret without containing it:

```yaml
pat: $AZURE_DEVOPS_PAT
```

## 3. Create the custom state field

Create a custom work-item field and add it to every work-item type that the
saved query can return. It is required and must have Azure DevOps field type
`plainText`. The examples use this reference name:

```text
Custom.EnsembleState
```

Do not edit this field manually. It contains the adapter's versioned JSON event
journal, scoped by the host repository registration ID. Claims and lifecycle
updates begin with a `/rev` test and are not retried as blind writes. A revision
conflict is reconciled as a competing claim or surfaced as a provider failure.

`ensemble validate` verifies that the field exists and reports `plainText`.

## 4. Create the saved query

Create a shared saved query in the configured project and record its query ID.
The query must be a **flat list of work items**, not a tree or direct-links
query. Treat it as the complete managed namespace for this repository
registration:

- Include every work-item type, area, iteration, or permanent routing category
  that Ensemble is expected to inventory.
- Include terminal items as well as ready, running, blocked, and failed items.
- Do not make the query a ready-only queue.
- Keep its result bounded; the adapter rejects a saved query, state-field query,
  or combined managed set above 10,000 items.

Including terminal items allows authoritative lifecycle reconciliation and
terminal workspace cleanup. Candidate selection remains narrower: ordinary work
must map to `ready` or retryable `failed` and pass all routing and blocker checks.

In addition to the saved query, the adapter executes provider-owned WIQL
equivalent to:

```sql
SELECT [System.Id] FROM WorkItems WHERE [Custom.EnsembleState] <> ''
```

It then accepts only state journals belonging to this repository registration.
This state-field read is for durable inventory and active recovery after query
or status drift; it does not turn unrelated work items into ordinary candidates.

## 5. Configure states and fields

Map all five portable lifecycle states to distinct native state names valid for
every returned work-item type:

```yaml
nativeStates:
  ready: New
  running: Active
  blocked: Blocked
  failed: Failed
  completed: Closed
```

The names above are illustrative. Process templates differ, so use states that
actually exist for all managed types. Any unconfigured native state normalizes
to `unmanaged`; an active durable execution in such a state can still normalize
to `running` for recovery.

Optional field mappings are:

```yaml
priorityField: Microsoft.VSTS.Common.Priority
acceptanceCriteriaField: Microsoft.VSTS.Common.AcceptanceCriteria
blockerRelation: System.LinkTypes.Dependency-Reverse
```

These are also the defaults for acceptance criteria and blocker relation when
omitted. `priorityField` has no default; omit it to leave portable priority
absent. The default blocker relation treats predecessor/dependency work items as
blockers and considers one resolved only when its native state exactly matches
`nativeStates.completed`.

## 6. Configure optional routing

`requiredTags` defaults to an empty list and may be stated explicitly:

```yaml
requiredTags: []
```

For a shared Azure Boards namespace, require permanent tags:

```yaml
requiredTags: [ensemble, repository:ensemble]
```

Every configured tag must be present. Tag matching uses Azure's semicolon-
separated values and exact configured text. Do not use a transient lifecycle tag
as a required tag.

An optional assignee filter accepts the normalized Azure identity name, normally
the identity's `uniqueName`, with case-insensitive comparison:

```yaml
requiredAssignee: ensemble@example.test
```

A work item may remain inside the saved query while being non-dispatchable
because it misses a required tag or assignee, has an unresolved blocker, or is
in an unmanaged or terminal state.

## 7. Add the host provider block

Use the complete example at
[`examples/host-config.azure-devops.yaml`](../../examples/host-config.azure-devops.yaml),
or place this mapping under one repository registration:

```yaml
provider:
  type: azure-devops
  organization: example-organization
  project: Example Project
  pat: $AZURE_DEVOPS_PAT
  queryId: 00000000-0000-0000-0000-000000000000
  stateField: Custom.EnsembleState
  nativeStates:
    ready: New
    running: Active
    blocked: Blocked
    failed: Failed
    completed: Closed
  priorityField: Microsoft.VSTS.Common.Priority
  requiredTags: [ensemble]
  requiredAssignee: ensemble@example.test
  blockerRelation: System.LinkTypes.Dependency-Reverse
  acceptanceCriteriaField: Microsoft.VSTS.Common.AcceptanceCriteria
```

`organization` and `project` are Azure DevOps Services URL segments. `queryId`
is the saved query GUID. Field settings use Azure reference names, not display
labels.

## 8. Optional Service Hook wake hints

Polling remains required and authoritative. A Service Hook only asks Ensemble
to run the repository's normal poll sooner. The ingress does not parse or trust
the event body, make scheduling decisions, or replace provider reads. Repeated
hints are safe and are coalesced while a tick is running.

Add a shared listener under `service`:

```yaml
service:
  startupTimeoutMs: 30000
  stopTimeoutSeconds: 60
  webhooks:
    publicBaseUrl: https://ensemble.example.test
    listenHost: 0.0.0.0
    listenPort: 8787
    maxBodyBytes: 65536
    requestTimeoutMs: 10000
    closeTimeoutMs: 5000
```

`publicBaseUrl` is required whenever any provider webhook is configured. It must
be an absolute HTTPS URL without embedded credentials. The built-in listener is
plain HTTP; terminate TLS in a reverse proxy or load balancer outside Ensemble
and forward to it. Defaults are `listenHost: 0.0.0.0`, `listenPort: 8787`, a
65,536-byte body limit, a 10-second request timeout, and a 5-second close bound.
Restrict network access to the listener at the deployment boundary.

Add a route and separate Basic credentials to each Azure provider registration:

```yaml
provider:
  type: azure-devops
  # Other required Azure fields omitted here.
  webhook:
    routeId: ensemble
    username: $AZURE_DEVOPS_WEBHOOK_USERNAME
    password: $AZURE_DEVOPS_WEBHOOK_PASSWORD
```

`routeId` is an opaque 1-128 character value containing only letters, digits,
underscore, or hyphen and must be unique across the host. The resulting route is:

```text
https://ensemble.example.test/webhooks/v1/repositories/ensemble
```

At startup, the JSON log event `webhook.server_started` contains the exact
public route in `data.endpoint`. Configure two Azure DevOps **Web Hooks** Service
Hook subscriptions for that URL:

- `workitem.created`
- `workitem.updated`

Set each subscription's Basic authentication username and password to that
route's values. Azure filters such as project, area path, work-item type, tag,
or changed field may reduce noise, but they are only wake filtering; the saved
query and adapter still decide the managed namespace and eligibility.

Ingress responses are deliberately empty: authenticated exact-path `POST`
requests receive `202`; bad credentials receive `401`; unknown routes `404`;
other methods `405`; malformed requests `400`; oversized bodies `413`; and a
controller that cannot accept a wake receives `503`. Azure DevOps retries
transient `408`, `502`, `503`, and `504` failures up to eight times with backoff.
Other failures are enduring and can place the Service Hook subscription on
probation, so monitor both Azure hook history and Ensemble JSON logs.

## 9. Runtime tools

For the active claimed execution, the adapter exposes these host-executed tools:

| Tool | Behavior |
|---|---|
| `task_read` | Reads the current normalized work item. |
| `task_comments_read` | Reads bounded recent work-item and durable terminal comments. |
| `task_artifacts_read` | Reads bounded artifact references from durable state. |
| `task_comment_add` | Adds an idempotent work-item comment using an execution-scoped key. |

Each call rechecks the active execution and owner. Tool credentials stay inside
the adapter. Read collections and text are bounded, and duplicate comment keys
must resolve to the same content.

## 10. Validate and operate

Run:

```sh
ensemble validate
ensemble doctor
```

Validation checks PAT access, saved-query executability and flat shape, custom
field existence and `plainText` type, state-map shape, host schema, and the
repository's portable configuration. `doctor` exercises provider reads but does
not prove write permission, claim a work item, or emit a Service Hook.

For the first task:

1. Put it inside the complete saved-query namespace.
2. Set its native state to `nativeStates.ready`.
3. Satisfy every configured tag and assignee filter.
4. Resolve every configured blocker relation.
5. Leave `Custom.EnsembleState` empty; Ensemble initializes it when claiming.
6. Run `ensemble run` and inspect structured logs and the work-item history.

Safe provider reads retry transport errors, timeouts, HTTP 429, and HTTP 5xx up
to three times after the first attempt, honoring `Retry-After` when present and
otherwise using bounded exponential backoff. Work-item writes are never blindly
retried. They are revision guarded and any uncertain terminal side effects are
reconciled by execution and comment idempotency markers.

Use read-only diagnostics when needed:

```sh
ensemble inspect task 123
ensemble inspect task 123 --journal
```

## 11. Adoption checklist

- [ ] Use Azure DevOps Services cloud, not Azure DevOps Server.
- [ ] Create a PAT with Work Items read/write access and project permissions.
- [ ] Create and attach a `plainText` custom state field to every managed type.
- [ ] Create a bounded flat saved query covering the complete namespace,
      including terminal items.
- [ ] Configure five distinct valid native states.
- [ ] Configure only intentional permanent tag and assignee filters.
- [ ] Align repository portable statuses with `ready`, `running`, `blocked`,
      `failed`, and `completed`.
- [ ] Run `ensemble validate` and `ensemble doctor`.
- [ ] Optionally terminate TLS externally and configure authenticated
      `workitem.created` and `workitem.updated` wake hooks.
- [ ] Confirm startup logs show the expected public webhook route.
- [ ] Test a small unblocked ready work item and restart recovery.
