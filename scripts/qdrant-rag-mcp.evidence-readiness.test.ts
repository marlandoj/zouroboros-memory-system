import { describe, expect, test } from "bun:test";
import type { Hit } from "./rag-pipeline";
import {
  applyAiEngineerEvidenceReadiness,
  evidenceReadinessRuntimeAvailable,
  formatHit,
} from "./qdrant-rag-mcp";

const otherCollectionHit: Hit = {
  id: "other-1",
  score: 0.91,
  collection: "zouroboros-code",
  payload: { source: "repo/file.ts", content: "Other collection content" },
};

const aiEngineerHit: Hit = {
  id: "ai-1",
  score: 0.87,
  collection: "ai-engineer-videos",
  payload: {
    video_id: "abcdefghijk",
    content: "Metadata-only video result",
    has_transcript: false,
  },
};

describe("qdrant-rag MCP evidence readiness", () => {
  test("off mode preserves the original array, hits, order, and formatted bytes", () => {
    const hits = [otherCollectionHit, aiEngineerHit];
    const before = hits.map((hit) => formatHit(hit, hit.collection ?? ""));
    const result = applyAiEngineerEvidenceReadiness(hits, {
      EVIDENCE_GATE_MODE: "off",
      EVIDENCE_GATE_MIN_TIER: "transcript_staged",
    });

    expect(result.hits).toBe(hits);
    expect(result.hits[0]).toBe(otherCollectionHit);
    expect(result.hits[1]).toBe(aiEngineerHit);
    expect(result.hits.map((hit) => formatHit(hit, hit.collection ?? ""))).toEqual(before);
  });

  test("annotate mode changes only ai-engineer-videos positions without reordering", () => {
    const hits = [aiEngineerHit, otherCollectionHit, { ...aiEngineerHit, id: "ai-2" }];
    if (!evidenceReadinessRuntimeAvailable) {
      expect(() => applyAiEngineerEvidenceReadiness(hits, {
        EVIDENCE_GATE_MODE: "annotate",
        EVIDENCE_GATE_MIN_TIER: "transcript_staged",
      })).toThrow("canonical evidence-readiness runtime unavailable");
      return;
    }
    const otherBefore = formatHit(otherCollectionHit, otherCollectionHit.collection ?? "");
    const result = applyAiEngineerEvidenceReadiness(hits, {
      EVIDENCE_GATE_MODE: "annotate",
      EVIDENCE_GATE_MIN_TIER: "transcript_staged",
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["ai-1", "other-1", "ai-2"]);
    expect(result.hits[1]).toBe(otherCollectionHit);
    expect(formatHit(result.hits[1], result.hits[1].collection ?? "")).toBe(otherBefore);
    expect((result.hits[0] as any).readiness).toMatchObject({
      contractVersion: "evidence-readiness/v1",
      stage: "catalog_only",
      validity: "valid",
      meetsThreshold: false,
    });
    expect(formatHit(result.hits[0], result.hits[0].collection ?? "")).toContain(
      "readiness: stage=catalog_only; meets_transcript_staged=no; contract=evidence-readiness/v1",
    );
    expect(result.gate?.cohort.total).toBe(2);
  });

  test("malformed and enforcement configuration fail closed", () => {
    expect(() =>
      applyAiEngineerEvidenceReadiness([aiEngineerHit], { EVIDENCE_GATE_MODE: "enforce" }),
    ).toThrow(evidenceReadinessRuntimeAvailable ? "not authorized" : "canonical evidence-readiness runtime unavailable");
    expect(() =>
      applyAiEngineerEvidenceReadiness([aiEngineerHit], { EVIDENCE_GATE_MODE: "invalid" }),
    ).toThrow("invalid EVIDENCE_GATE_MODE");
  });
});
