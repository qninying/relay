// STORY-103 (REQ-115): which classifier the workers use, chosen by the
// RELAY_CLASSIFIER environment variable, behind classifyJob's Classifier
// interface so nothing else changes when a real model replaces the
// stand-in.
//
//   stand-in (default)  deterministic keyword matching against the fixed
//                       industry taxonomy. Free, demo-quality: results show
//                       the whole pipeline working, not real classification.
//   claude              reserved for a real model (a later, separate
//                       decision: API key as a Fly secret, per-item cost).
//                       Refused for now rather than silently falling back.
//
// Failure path (STORY-103): an unknown or unavailable value throws
// ClassifierConfigError at startup, so the server refuses to start instead
// of every worker crashing on its first job.

import type { Classifier, ClassifierInput } from "./classifyJob.js";

export class ClassifierConfigError extends Error {}

// Keyword -> taxonomy code. Order matters: the first match wins. Confidence
// is a fixed value per rule, so results are reproducible.
const RULES: Array<[RegExp, string, number]> = [
  [/\b(saas|software|platform|app|cloud|api|developer)\b/i, "software", 0.88],
  [/\b(bank|insur\w*|lend\w*|payments?|fintech|asset management|credit)\b/i, "financial_services", 0.86],
  [/\b(clinic\w*|hospital\w*|patients?|pharma\w*|biotech|medical|health\w*)\b/i, "healthcare", 0.86],
  [/\b(manufactur\w*|factory|factories|industrial|machining|fabricat\w*)\b/i, "manufacturing", 0.84],
  [/\b(retail\w*|e-?commerce|store|stores|shop|consumer brand)\b/i, "retail_ecommerce", 0.8],
  [/\b(freight|shipping|logistics|warehous\w*|trucking|fleet|supply chain)\b/i, "logistics", 0.85],
  [/\b(consult\w*|law firm|legal|accounting|staffing|agency)\b/i, "professional_services", 0.78],
  [/\b(school|university|college|edtech|training|courses?)\b/i, "education", 0.82],
  [/\b(energy|oil|gas|solar|wind|utility|utilities|power)\b/i, "energy_utilities", 0.8],
  [/\b(media|publish\w*|broadcast\w*|gaming|film|music|studio)\b/i, "media_entertainment", 0.8],
  [/\b(government|agency of|municipal|nonprofit|non-profit|charity|public sector)\b/i, "public_sector", 0.8],
];

export const standInClassifier: Classifier = async ({ text, labels }: ClassifierInput) => {
  const codes = new Set(labels.map((l) => l.code));
  for (const [pattern, code, confidence] of RULES) {
    if (pattern.test(text) && codes.has(code)) return { label: code, confidence };
  }
  // Nothing recognisable: "other", with confidence low enough to go to a
  // person for review rather than be accepted.
  return { label: "other", confidence: 0.3 };
};

export function classifierFromEnv(env: NodeJS.ProcessEnv = process.env): Classifier {
  const choice = (env.RELAY_CLASSIFIER ?? "stand-in").trim();
  if (choice === "stand-in") return standInClassifier;
  if (choice === "claude") {
    throw new ClassifierConfigError("RELAY_CLASSIFIER=claude is not available yet (needs its own decision: API key and per-item cost). Use stand-in.");
  }
  throw new ClassifierConfigError(`Unknown RELAY_CLASSIFIER "${choice}". Expected: stand-in.`);
}
