export const CONTROL_COMMAND_DTO_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://auto-slice.local/schema/control-command-v1.json",
  title: "Auto Slice ControlCommandRequest v1",
  type: "object",
  additionalProperties: false,
  required: ["command", "envelope"],
  properties: {
    command: {
      enum: ["start", "status", "pause", "resume", "abort", "override"],
    },
    envelope: { $ref: "#/$defs/envelope" },
  },
  $defs: {
    digest: {
      type: "string",
      pattern: "^sha256:[0-9a-f]{64}$",
    },
    envelope: {
      type: "object",
      additionalProperties: false,
      required: ["command_id", "payload"],
      properties: {
        command_id: { type: "string", minLength: 1, maxLength: 512 },
        run_id: { type: "string", minLength: 1, maxLength: 512 },
        expected_state_version: { type: "integer", minimum: 0 },
        payload: { type: "object" },
      },
    },
    recovery_resolution: {
      enum: [
        "retry_continuation_start",
        "supply_model_policy",
        "resolve_protected_changes",
        "release_stale_project_lock",
        "abort_run",
      ],
    },
    recovery_evidence: {
      type: "object",
      additionalProperties: false,
      required: ["evidence_path", "evidence_digest"],
      properties: {
        evidence_path: { type: "string", minLength: 1 },
        evidence_digest: { $ref: "#/$defs/digest" },
      },
    },
  },
} as const);
