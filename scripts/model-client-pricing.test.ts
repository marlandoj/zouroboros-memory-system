import { describe, expect, test } from "bun:test";
import { calculateOpenAICostUsd as canonicalCost } from "./model-client";
import { calculateOpenAICostUsd as mirrorCost } from "../../zouroboros/skills/memory/scripts/model-client";

for (const [name, calculate] of [
  ["canonical", canonicalCost],
  ["runtime mirror", mirrorCost],
] as const) {
  describe(`${name} OpenAI pricing`, () => {
    test("prices GPT-4o mini per million tokens", () => {
      expect(calculate("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 10);
      expect(calculate("gpt-4o-mini", 0, 1_000_000)).toBeCloseTo(0.6, 10);
    });

    test("prices GPT-4o per million tokens", () => {
      expect(calculate("gpt-4o", 1_000_000, 1_000_000)).toBeCloseTo(12.5, 10);
    });

    test("uses the conservative configured fallback rate", () => {
      expect(calculate("unknown-openai-model", 1_000_000, 0)).toBeCloseTo(0.15, 10);
    });
  });
}
