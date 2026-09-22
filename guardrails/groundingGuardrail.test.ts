import { describe, it, expect } from "vitest";
import { checkGroundingGuardrail } from "./groundingGuardrail.js";

const SOURCE = `Acme Robotics raised a $12 million Series A in March 2026 led by
Frontier Capital. The company builds warehouse picking robots and has 45 employees
based in Austin, Texas. Acme is currently evaluating three vendors for its
inventory management software.`;

describe("checkGroundingGuardrail", () => {
  it("allows a summary whose claims are drawn from the source (happy path)", () => {
    const result = checkGroundingGuardrail({
      sourceText: SOURCE,
      summaryText:
        "Acme Robotics is a warehouse robotics company based in Austin that raised a $12 million Series A.",
    });
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects an empty summary", () => {
    const result = checkGroundingGuardrail({ sourceText: SOURCE, summaryText: "   " });
    expect(result).toEqual({ allowed: false, violations: ["SUMMARY_EMPTY"], overlapRatio: 0 });
  });

  it("rejects a summary with low lexical overlap with its own source (likely fabricated)", () => {
    const result = checkGroundingGuardrail({
      sourceText: SOURCE,
      summaryText: "This vendor specializes in blockchain payment infrastructure for retail banks.",
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("LOW_LEXICAL_OVERLAP");
  });

  it("rejects a summary that states a number absent from the source", () => {
    const result = checkGroundingGuardrail({
      sourceText: SOURCE,
      summaryText: "Acme Robotics is a warehouse robotics company that raised a $50 million Series A round.",
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("UNGROUNDED_NUMBER");
  });

  it("does not flag a number that does appear in the source (boundary)", () => {
    const result = checkGroundingGuardrail({
      sourceText: "The contract is valued at 45000 dollars.",
      summaryText: "This deal is worth 45000 dollars per the filing.",
    });
    expect(result.violations).not.toContain("UNGROUNDED_NUMBER");
  });

  it("reports every simultaneous violation, not just the first", () => {
    const result = checkGroundingGuardrail({
      sourceText: SOURCE,
      summaryText: "This unrelated vendor raised $999 million in a completely different industry.",
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining(["LOW_LEXICAL_OVERLAP", "UNGROUNDED_NUMBER"])
    );
  });

  it("is pure: identical input twice yields identical output", () => {
    const input = { sourceText: SOURCE, summaryText: "Acme Robotics raised a $12 million Series A." };
    const first = checkGroundingGuardrail(input);
    const second = checkGroundingGuardrail(input);
    expect(first).toEqual(second);
  });
});
