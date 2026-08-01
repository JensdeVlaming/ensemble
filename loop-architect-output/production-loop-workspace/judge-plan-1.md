```json
{
  "verdict": "revise",
  "blocking_issues": [
    "Define durable blocked-work resolution and restart/resume semantics.",
    "Define provider execution-ID propagation and the App Server continuation/result state machine.",
    "Define a reconstructable validated workspace identity and keep terminal decisions in Scheduler.",
    "Define provider-derived blocked and retrying diagnostics after restart.",
    "Split the workspace delivery into independently testable milestones."
  ],
  "confidence": 0.96,
  "notes": "The dependency direction is sound, but the five state-machine and milestone-isolation gaps are blocking."
}
```

The full judge response is preserved in the Codex task transcript. This compact
artifact retains every blocking issue without copying general review prose.
