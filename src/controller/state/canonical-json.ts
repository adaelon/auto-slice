import { createHash } from "node:crypto";

import type { Sha256Digest } from "./types.js";

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function normalize(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON cannot encode a non-finite number at ${path}.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalize(entry, `${path}[${String(index)}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical JSON requires a plain object at ${path}.`);
    }
    const record = value as Readonly<Record<string, unknown>>;
    const normalized: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) {
        throw new TypeError(`Canonical JSON cannot encode undefined at ${path}.${key}.`);
      }
      normalized[key] = normalize(child, `${path}.${key}`);
    }
    return normalized;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value} at ${path}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

export function sha256Bytes(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Json(value: unknown): Sha256Digest {
  return sha256Bytes(canonicalJson(value));
}
