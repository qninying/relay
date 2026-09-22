// Enforces REQ-016 (summaries must be grounded strictly in the source data pulled for
// each item) as a runtime check, not just a stated requirement: a summary is rejected
// before persisting if it doesn't lexically overlap enough with its own source, or if it
// states a number that never appears in the source. This is a cheap heuristic, not a
// second LLM call grading the first — that just moves the hallucination risk one level
// up instead of removing it. A rejection here should route the job to review, never to
// silent persistence; see docs/stories/STORY-012.md for the caller contract. Pure and
// deterministic — no I/O.

export interface GroundingCheckInput {
  sourceText: string;
  summaryText: string;
}

export type GroundingViolation =
  | "SUMMARY_EMPTY"
  | "LOW_LEXICAL_OVERLAP"
  | "UNGROUNDED_NUMBER";

export interface GroundingResult {
  allowed: boolean;
  violations: GroundingViolation[];
  overlapRatio: number;
}

const MIN_OVERLAP_RATIO = 0.4;
// Drops short, stopword-ish tokens ("the", "and", "was") without maintaining a
// stopword list — a 4+ char threshold is a coarse but dependency-free proxy.
const MIN_WORD_LENGTH = 4;

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= MIN_WORD_LENGTH)
  );
}

function numberTokens(text: string): string[] {
  return text.match(/\b\d[\d,.]*\b/g) ?? [];
}

export function checkGroundingGuardrail(input: GroundingCheckInput): GroundingResult {
  const summary = input.summaryText.trim();

  if (summary.length === 0) {
    return { allowed: false, violations: ["SUMMARY_EMPTY"], overlapRatio: 0 };
  }

  const violations: GroundingViolation[] = [];
  const sourceWords = significantWords(input.sourceText);
  const summaryWords = significantWords(summary);
  const overlapCount = [...summaryWords].filter((word) => sourceWords.has(word)).length;
  // A summary with no significant words of its own (all short tokens) has nothing to
  // check lexically, so it is treated as vacuously grounded rather than divided by zero.
  const overlapRatio = summaryWords.size === 0 ? 1 : overlapCount / summaryWords.size;

  if (overlapRatio < MIN_OVERLAP_RATIO) {
    violations.push("LOW_LEXICAL_OVERLAP");
  }

  const sourceNumbers = new Set(numberTokens(input.sourceText));
  const hasUngroundedNumber = numberTokens(summary).some((n) => !sourceNumbers.has(n));
  if (hasUngroundedNumber) {
    violations.push("UNGROUNDED_NUMBER");
  }

  return { allowed: violations.length === 0, violations, overlapRatio };
}
