// STORY-011 demo: classification against the fixed, pinned industry
// taxonomy. The classifier is a deterministic keyword stand-in for the real
// LLM/vendor call (none is wired into Relay yet); everything around it, the
// taxonomy load, pin check, label validation and logging, is the real code.
// No Redis needed.

import { classifyJob, type Classifier } from "./classifyJob.js";
import { INDUSTRY_TAXONOMY_PIN, loadTaxonomy } from "./taxonomy.js";

const KEYWORDS: Array<[RegExp, string, number]> = [
  [/software|saas|platform/i, "software", 0.91],
  [/clinic|hospital|patients/i, "healthcare", 0.86],
  [/freight|shipping|warehouse/i, "logistics", 0.42],
  [/token|blockchain/i, "crypto_web3", 0.95], // not in the taxonomy: must be rejected
];

const keywordClassifier: Classifier = async ({ text, labels }) => {
  for (const [pattern, label, confidence] of KEYWORDS) if (pattern.test(text)) return { label, confidence };
  return { label: labels.find((l) => l.code === "other")!.code, confidence: 0.3 };
};

const COMPANIES = [
  "Northwind builds a SaaS platform for payroll.",
  "Riverside runs three outpatient clinics.",
  "Harbor Lane offers freight forwarding and warehouse space.",
  "Mint Labs issues a governance token on its blockchain.",
];

async function main() {
  console.log = () => {};
  console.error = () => {};
  const out = (line: string) => process.stderr.write(`${line}\n`);
  const reliability = { timeoutMs: 1000, maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 };
  const taxonomy = await loadTaxonomy(INDUSTRY_TAXONOMY_PIN);
  out(`taxonomy ${taxonomy.id} v${taxonomy.version}  sha256 ${taxonomy.sha256.slice(0, 12)}  ${taxonomy.codes.size} labels  review below ${taxonomy.reviewThreshold}\n`);

  for (const [i, text] of COMPANIES.entries()) {
    const job = { id: `co-${i + 1}`, correlationId: `demo-cls-${i + 1}`, idempotencyKey: `co-${i + 1}`, payload: { text } };
    const r = await classifyJob(job, keywordClassifier, { reliability });
    const verdict =
      r.status === "classified" ? `${r.label}  (${r.confidence})${r.needsReview ? "  -> review queue" : ""}` : `FAILED: ${r.reason}${"returnedLabel" in r ? ` "${r.returnedLabel}"` : ""}`;
    out(`${job.id}  ${text.padEnd(58)} ${verdict}`);
  }

  out("\ntaxonomy file missing:");
  const missing = await classifyJob(
    { id: "co-5", correlationId: "demo-cls-5", idempotencyKey: "co-5", payload: { text: COMPANIES[0] } },
    keywordClassifier,
    { reliability, getTaxonomy: () => loadTaxonomy({ ...INDUSTRY_TAXONOMY_PIN, path: "/nonexistent/industry.v1.json" }) }
  );
  out(`co-5  ${JSON.stringify(missing)}`);
}

main().catch((error) => {
  process.stderr.write(`classification demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
