export const FROZEN_CONTRACT_SCHEMA_VERSION = 1 as const;

export interface WorkspaceIdentity {
  readonly canonical_root: string;
  readonly filesystem_identity: string;
}

export interface FrozenContracts {
  readonly schema_version: typeof FROZEN_CONTRACT_SCHEMA_VERSION;
  readonly context_digest: string;
  readonly design_digest: string;
  readonly adr_digests: readonly string[];
  readonly workspace_identity: WorkspaceIdentity;
}

export type ContractLoadFailureReason =
  | "duplicate_plugin_id"
  | "invalid_contract_manifest"
  | "invalid_json"
  | "invalid_utf8"
  | "plugin_id_mismatch"
  | "required_file_missing"
  | "required_path_not_file"
  | "required_path_outside_workspace"
  | "unsupported_schema"
  | "workspace_unaddressable";

export interface FrozenContractManifestV1 {
  readonly schema_version: typeof FROZEN_CONTRACT_SCHEMA_VERSION;
  readonly plugin_ids: readonly string[];
  readonly context_path: "CONTEXT.md";
  readonly design_path: "docs/auto-slice-design.md";
  readonly adr_paths: readonly string[];
}
