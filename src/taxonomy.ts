// STORY-011 (REQ-017): classification runs against a fixed, pre-defined
// taxonomy. "Fixed" is enforced, not just intended: the taxonomy is a
// versioned file in the repo, and the loader refuses any file whose SHA-256
// doesn't match the pin below. Editing the file without bumping its version
// and this pin fails loudly instead of silently reclassifying everything
// against labels nobody agreed to.
//
// Failure paths: missing file (TaxonomyNotFoundError), unreadable or
// malformed file (TaxonomyInvalidError), changed file (TaxonomyMismatchError).
// All three mean "no taxonomy", and the classification task fails gracefully
// rather than guessing (classifyJob.ts).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface TaxonomyLabel {
  code: string;
  name: string;
  description: string;
}

export interface Taxonomy {
  id: string;
  version: string;
  sha256: string;
  // Confidence below this goes to the review queue (STORY-007). Owned by the
  // taxonomy because what counts as "sure enough" depends on the labels.
  reviewThreshold: number;
  labels: TaxonomyLabel[];
  codes: ReadonlySet<string>;
}

export interface TaxonomyPin {
  path: string;
  version: string;
  sha256: string;
}

export const INDUSTRY_TAXONOMY_PIN: TaxonomyPin = {
  path: fileURLToPath(new URL("../taxonomies/industry.v1.json", import.meta.url)),
  version: "1.0.0",
  sha256: "98f6373f6575025476bc251d536463b9cf3d868192da41b03a9acd8d052edd83",
};

export class TaxonomyNotFoundError extends Error {}
export class TaxonomyInvalidError extends Error {}
export class TaxonomyMismatchError extends Error {}

export async function loadTaxonomy(pin: TaxonomyPin): Promise<Taxonomy> {
  let raw: Buffer;
  try {
    raw = await readFile(pin.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TaxonomyNotFoundError(`Taxonomy file not found: ${pin.path}`);
    }
    throw new TaxonomyInvalidError(`Taxonomy file unreadable: ${(error as Error).message}`);
  }

  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== pin.sha256) {
    throw new TaxonomyMismatchError(`Taxonomy at ${pin.path} has sha256 ${sha256}, pinned ${pin.sha256}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new TaxonomyInvalidError(`Taxonomy file is not valid JSON: ${pin.path}`);
  }
  return validate(parsed, pin, sha256);
}

function validate(parsed: unknown, pin: TaxonomyPin, sha256: string): Taxonomy {
  const t = parsed as Partial<Taxonomy> & { labels?: unknown };
  if (typeof t !== "object" || t === null || typeof t.id !== "string" || typeof t.version !== "string") {
    throw new TaxonomyInvalidError("Taxonomy needs a string id and version");
  }
  if (t.version !== pin.version) {
    throw new TaxonomyMismatchError(`Taxonomy version ${t.version} does not match pinned ${pin.version}`);
  }
  if (typeof t.reviewThreshold !== "number" || t.reviewThreshold <= 0 || t.reviewThreshold >= 1) {
    throw new TaxonomyInvalidError("Taxonomy reviewThreshold must be a number between 0 and 1");
  }
  if (!Array.isArray(t.labels) || t.labels.length === 0) {
    throw new TaxonomyInvalidError("Taxonomy needs at least one label");
  }
  const codes = new Set<string>();
  for (const label of t.labels as Partial<TaxonomyLabel>[]) {
    if (typeof label?.code !== "string" || !/^[a-z][a-z0-9_]*$/.test(label.code) || typeof label.name !== "string") {
      throw new TaxonomyInvalidError(`Invalid taxonomy label: ${JSON.stringify(label)}`);
    }
    if (codes.has(label.code)) throw new TaxonomyInvalidError(`Duplicate taxonomy code: ${label.code}`);
    codes.add(label.code);
  }
  return {
    id: t.id,
    version: t.version,
    sha256,
    reviewThreshold: t.reviewThreshold,
    labels: t.labels as TaxonomyLabel[],
    codes,
  };
}
