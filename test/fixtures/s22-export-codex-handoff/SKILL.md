---
name: export-codex-handoff
description: Hermetic S22 export fixture that publishes a deterministic Handoff pair through the real helper command boundary.
---

# S22 Hermetic Export

Run the bundled helper directly with Node:

1. `node scripts/export-handoff.mjs prepare <source-thread-uuid> --map-result-mode continuation-map-v2 --output <markdown-path> --evidence-index <evidence-path>`
2. Read the single JSON response and run `node scripts/export-handoff.mjs publish <workDir>`.

Do not combine commands, change paths, or synthesize receipt fields in the final response.
