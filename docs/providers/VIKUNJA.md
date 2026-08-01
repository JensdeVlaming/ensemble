# Vikunja Provider Guide

This guide configures Ensemble's included Vikunja API v1 adapter. Complete the
provider-neutral [Starter Guide](../STARTER_GUIDE.md) first, then use this guide
for the `provider` mapping and Vikunja task preparation.

## 1. What the adapter owns

The Vikunja adapter:

- Validates the API token, project and discovery view.
- Discovers tasks using project/view routing.
- Applies assignment, required-label, archive, done and blocker filters.
- Maps Vikunja labels to Ensemble's portable workflow statuses.
- Creates atomic execution claims and renewable leases.
- Stores durable machine-readable execution events in task comments.
- Synchronizes running, completed, failed and blocked lifecycle effects
  idempotently.
- Reconstructs active work and retry history after restart.

Provider credentials are used only by the controller and are not placed in
runtime environments, prompts or workspaces.

## 2. Create an API token

Create a Vikunja API token with access to the target project, tasks, labels,
comments and relationships. Store it in Ensemble's protected env file:

```text
VIKUNJA_API_TOKEN=replace-with-a-real-token
```

Do not use `export`, quotes, or shell interpolation. Keep the env file at the
permissions required by the Starter Guide.

The host YAML references the value without containing it:

```yaml
token: $VIKUNJA_API_TOKEN
```

## 3. Select a project and view

Choose the Vikunja project that contains work for the registered repository.
Record its numeric project ID.

Choose a view that returns a flat task list and record its numeric view ID. A
List view is recommended. Kanban views are rejected because their API response
contains buckets rather than the task-list shape required for deterministic
discovery.

Project and view IDs are not interchangeable. `ensemble validate` confirms
that the project is visible and the selected view belongs to it.

For the example below, the values are illustrative:

```yaml
projectId: 3
viewId: 9
```

Use the IDs from your own Vikunja instance.

## 4. Create lifecycle labels

The following five labels must exist in Vikunja before validation succeeds:

```text
ensemble:ready
ensemble:running
ensemble:blocked
ensemble:failed
ensemble:completed
```

Their meanings are:

| Label | Meaning |
|---|---|
| `ensemble:ready` | New work eligible for consideration |
| `ensemble:running` | Claimed work in an active or continuing workflow |
| `ensemble:blocked` | Work requiring an operator or external prerequisite |
| `ensemble:failed` | The latest execution failed |
| `ensemble:completed` | The repository workflow reached a terminal outcome |

The adapter keeps these lifecycle labels mutually exclusive when it
synchronizes task state.

Custom titles can be configured:

```yaml
statusLabels:
  ready: automation:ready
  running: automation:running
  blocked: automation:blocked
  failed: automation:failed
  completed: automation:completed
```

All configured titles must already exist in Vikunja, and all five must be
distinct.

## 5. Add the host provider block

Place this under a repository registration in host `config.yaml`:

```yaml
repositories:
  - id: my-project
    url: https://github.com/example/my-project.git
    branch: main
    configurationPath: /absolute/local/path/to/my-project
    provider:
      type: vikunja
      baseUrl: https://vikunja.example.test
      token: $VIKUNJA_API_TOKEN
      projectId: 3
      viewId: 9
      requiredLabels: []
```

`baseUrl` is the public base URL of the Vikunja installation. Replace the URL,
project ID and view ID with real values.

### Optional assignee filter

Require the exact Vikunja username:

```yaml
requiredAssignee: automation-user
```

A task without that assignee is visible to Vikunja but not dispatchable by this
registration.

### Optional permanent label filters

For a dedicated project, use:

```yaml
requiredLabels: []
```

In a shared project, permanent routing labels can narrow discovery:

```yaml
requiredLabels: [repository:my-project]
```

Every listed title must remain attached throughout the workflow.

Do not put `ensemble:ready` in `requiredLabels`. It is a lifecycle status label
that Ensemble replaces with running, completed, failed or blocked. Requiring it
permanently would make later workflow states ineligible.

## 6. Align repository status names

Vikunja lifecycle labels map to portable repository statuses. Configure the
repository's `.ensemble/config.yaml` like this:

```yaml
statuses:
  runnable: [ready, running]
  running: running
  completed: completed
  failed: failed
  blocked: blocked
```

The provider adapter understands Vikunja labels. Scheduler and runtime code see
only portable names such as `ready` and `running`.

## 7. Validate the adapter

Run:

```sh
ensemble validate
```

Validation checks:

- The token can access Vikunja.
- `projectId` exists and is visible.
- `viewId` belongs to that project.
- The view is not Kanban.
- Every configured lifecycle label exists.
- Host and repository configuration agree on the selected runtime and portable
  statuses.

Typical failures identify an invalid project/view, a missing label, an invalid
token, or an inaccessible API endpoint.

## 8. Prepare a task

For the simplest first run:

1. Create a small task in the configured project.
2. Ensure it is visible in the configured List view.
3. Leave it incomplete.
4. Remove or resolve every blocking relationship.
5. Satisfy `requiredAssignee`, if configured.
6. Attach every permanent `requiredLabels` value.
7. Attach only the lifecycle label `ensemble:ready`.

Do not attach all five lifecycle labels. Ensemble owns their transitions.

## 9. Eligibility rules

A new ordinary task is returned as a workflow candidate only when:

- Its project is the configured project and is not archived.
- The task is returned by the configured view.
- The task is not done.
- Its lifecycle status is `ready` or retryable `failed`.
- The required assignee is present, when configured.
- Every permanent required label is present.
- Every Vikunja `blocked` relationship points to resolved work.

Durable active executions are additionally inventoried across visible active
projects so Ensemble can reconcile work after routing or status drift.

### Ready does not always mean dispatchable

Lifecycle state and dispatchability are separate. A task can have
`ensemble:ready` while remaining non-dispatchable because it:

- Has an unresolved Vikunja blocker.
- Misses the required assignee.
- Misses a permanent required label.
- Is done, archived or routed outside the configured project.

For example, adding `ensemble:ready` does not override open task relationships.
Complete the blocking tasks or remove the relationships before expecting
dispatch.

## 10. Run and observe

Run in the foreground first:

```sh
ensemble run
```

When no task qualifies, a successful tick reports:

```text
candidateCount: 0
dispatchedCount: 0
```

When a task qualifies, structured logs progress through candidate discovery,
claim, dispatch, runtime start and provider synchronization.

During a successful workflow, the adapter changes the lifecycle label roughly
as follows:

```text
ensemble:ready → ensemble:running → ensemble:completed
```

Failures use `ensemble:failed`; operator-input outcomes use
`ensemble:blocked`. Durable retry timestamps and execution records remain in
provider-owned machine-readable task comments.

## 11. Troubleshooting

### `candidateCount` is zero

Check:

1. `projectId` and `viewId` identify the intended project and List view.
2. The task is in that project and appears in that view.
3. The exact label title is `ensemble:ready`, unless customized.
4. The task and project are not terminal or archived.
5. `requiredAssignee` and every `requiredLabels` value match exactly.
6. Vikunja relationships do not report unresolved blockers.
7. The task is not waiting for a durable retry time.

Set host logging to debug for candidate decision events:

```yaml
logging:
  level: debug
```

### Validation succeeds but the wrong project is empty

A project/view pair may be valid while pointing to an unintended project. Read
the project and view names in Vikunja and confirm their numeric IDs rather than
assuming that common values such as `1` refer to the desired project.

### The task has `ensemble:ready` but is not selected

Inspect assignment, permanent labels and Vikunja blocking relationships. The
adapter may normalize the task to portable status `ready` while correctly
setting `dispatchable: false`.

### A status label is missing

Create all five default labels or configure five distinct existing titles in
`statusLabels`, then rerun `ensemble validate`.

## 12. Vikunja adoption checklist

- [ ] Create an API token and store it only in protected `ensemble.env`.
- [ ] Record the intended project ID.
- [ ] Record a non-Kanban List view ID in that project.
- [ ] Create all five lifecycle labels.
- [ ] Add the Vikunja provider block to the correct repository registration.
- [ ] Leave `requiredLabels: []` for a dedicated project.
- [ ] Add `requiredAssignee` only when assignment routing is intentional.
- [ ] Align repository portable statuses with ready/running/completed/failed/blocked.
- [ ] Run `ensemble validate`.
- [ ] Test with a small, incomplete, unblocked task carrying `ensemble:ready`.
- [ ] Confirm running and terminal label transitions.
- [ ] Confirm the task contains durable execution comments after processing.
