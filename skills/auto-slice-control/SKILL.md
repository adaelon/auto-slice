---
name: auto-slice-control
description: Control a local Auto Slice Run with start, status, pause, resume, abort, or per-Slice commit-mode override commands. Use when the user asks to operate an Auto Slice Run or explicitly recover one from NEEDS_USER.
---

# Auto Slice Control

Use the local controller command whose name matches the requested operation:

```text
auto-slice-controller <start|status|pause|resume|abort|override> <request_json_path> [storage_root]
```

## Safety contract

- Read `status` before every mutating command and copy its `state_version` into `expected_state_version`.
- Never infer a `NEEDS_USER` recovery. Present `snapshot.error.recovery_options` and use only the resolution the user explicitly selects.
- Non-abort recovery must include a workspace-relative `evidence_path` and its exact SHA-256 `evidence_digest`.
- Do not push, silently change models, broaden Slice ownership, or include raw provider/tool output in command envelopes.
- A `REJECTED` receipt is terminal for that `command_id`; use a fresh ID only after correcting the request.

## Status-only monitoring

When the user says “继续监控”, “continue monitoring”, or otherwise asks to keep watching an existing Run, every poll performs exactly one control-plane operation:

```text
auto-slice-controller status <request_json_path> [storage_root]
```

Use a fresh `command_id` for each poll, retain the same `run_id`, and use the existing read-only envelope:

```json
{
  "command_id": "status-unique-id",
  "run_id": "run-id",
  "payload": {}
}
```

- Report only `run_id`, `current_slice_id`, enumerated `status`, `state_version`, and, when present, `error.code` plus listed `recovery_options`.
- For a non-terminal Run, wait until the next poll without inspecting any other surface. Stop polling after `DONE`, `ABORTED`, `NEEDS_USER`, or a rejected status receipt.
- At `NEEDS_USER`, present the listed recovery options and wait until the user explicitly selects one. Never automatically resume or abort.
- Never use Worker Task or Thread tools while monitoring, including `list_threads`, `read_thread`, `wait_threads`, `send_message_to_thread`, `thread/list`, or `thread/read`, and do not use equivalent APIs to inspect a Development, Source, or Continuation Task.
- Never run Git diagnostics or read the Run workspace, checkpoint, Controller logs, Worker task command output, or other work-product state to explain progress.
- Do not implement Compaction Content Probe behavior in this Skill. The Controller owns that isolated fallback and exposes only its bounded status projection.

## Commit option and task input

Ask whether each Slice should commit when starting a Run, then encode the answer as the existing `commit_mode` field:

- `none` → `设定goal：阅读checkpoint，实现<SliceId>，完成后刷新checkpoint`
- `after_slice` → `设定goal：阅读checkpoint，实现<SliceId>，完成后commit，刷新checkpoint`

Do not paste the Production Plan, Slice contract, exclusions, checks, or controller invariants into the task input. Checkpoint is the authority for a new Slice; a verified Handoff Markdown file is the authority for a continuation. A pre-`VERIFYING` `override` changes the same wording for that Slice.

## Envelope shapes

`status` is read-only:

```json
{
  "command_id": "status-unique-id",
  "run_id": "run-id",
  "payload": {}
}
```

Mutating commands require optimistic concurrency:

```json
{
  "command_id": "pause-unique-id",
  "run_id": "run-id",
  "expected_state_version": 7,
  "payload": {}
}
```

Resume from `NEEDS_USER` only with a listed resolution:

```json
{
  "command_id": "resume-unique-id",
  "run_id": "run-id",
  "expected_state_version": 8,
  "payload": {
    "resolution": "supply_model_policy",
    "evidence": {
      "evidence_path": "artifacts/recovery/model-policy.json",
      "evidence_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }
  }
}
```

`abort_run` is the only resolution that does not require evidence. `override` payload is `{ "slice_id": "S11", "mode": "after_slice" }` or `{ "slice_id": "S11", "mode": "none" }`; it is rejected after that Slice enters `VERIFYING`.
