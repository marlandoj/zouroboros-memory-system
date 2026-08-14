#!/usr/bin/env bun
// Promotes staged feedback entries to permanent feedback_*.md files in memory.
// Reads feedback_staged.md, uses OpenAI to synthesize rule/why/how-to-apply,
// writes individual feedback_auto_*.md files, updates MEMORY.md index, clears staging.
//
// Usage: bun feedback-promote.ts [--dry-run] [--entry N]

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import OpenAI from "openai";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

const STAGING = "/root/.claude/projects/-home-workspace/memory/feedback_staged.md";
const MEMORY_DIR = "/root/.claude/projects/-home-workspace/memory";
const MEMORY_INDEX = `${MEMORY_DIR}/MEMORY.md`;

const DRY_RUN = process.argv.includes("--dry-run");
const ENTRY_FLAG = process.argv.indexOf("--entry");
const ONLY_ENTRY = ENTRY_FLAG !== -1 ? parseInt(process.argv[ENTRY_FLAG + 1]) : null;

if (!existsSync(STAGING)) {
  console.log("No staged feedback file found. Nothing to promote.");
  process.exit(0);
}

const staged = readFileSync(STAGING, "utf-8");

// Parse entries — split on "\n---\n"
const rawEntries = staged.split(/\n---\n/).filter(e => e.includes("**Captured:**"));

if (rawEntries.length === 0) {
  console.log("No pending entries in staged file.");
  process.exit(0);
}

console.log(`Found ${rawEntries.length} staged entries.`);

async function synthesizeRule(entry: string): Promise<{ name: string; rule: string; why: string; howToApply: string } | null> {
  const resp = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You synthesize behavioral feedback rules from correction/praise pairs.
Output JSON with: name (slug, 3-6 words, hyphens), rule (1 sentence imperative), why (1 sentence reason), howToApply (1 sentence trigger condition).
Keep it tight — these become memory files that guide future AI behavior.`,
      },
      {
        role: "user",
        content: `Extract a behavioral rule from this feedback pair:\n\n${entry}\n\nRespond with JSON only.`,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 200,
  });

  try {
    return JSON.parse(resp.choices[0].message.content ?? "{}");
  } catch {
    return null;
  }
}

function existingFeedbackFiles(): string[] {
  return readdirSync(MEMORY_DIR).filter(f => f.startsWith("feedback_auto_"));
}

function nextFilename(): string {
  const existing = existingFeedbackFiles();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const todayFiles = existing.filter(f => f.includes(today));
  const n = todayFiles.length + 1;
  return `feedback_auto_${today}_${n}.md`;
}

function writeFeedbackFile(filename: string, name: string, rule: string, why: string, howToApply: string) {
  const content = `---
name: ${name}
description: Auto-captured behavioral feedback — ${rule.slice(0, 80)}
type: feedback
---

${rule}

**Why:** ${why}

**How to apply:** ${howToApply}
`;
  writeFileSync(`${MEMORY_DIR}/${filename}`, content);
}

function appendToMemoryIndex(filename: string, description: string) {
  if (!existsSync(MEMORY_INDEX)) return;
  const index = readFileSync(MEMORY_INDEX, "utf-8");
  const entry = `- [${filename}](${filename}) — ${description.slice(0, 120)}\n`;
  writeFileSync(MEMORY_INDEX, index + entry);
}

const entriesToProcess = ONLY_ENTRY !== null
  ? [rawEntries[ONLY_ENTRY - 1]].filter(Boolean)
  : rawEntries;

let promoted = 0;
for (const [i, entry] of entriesToProcess.entries()) {
  const entryNum = ONLY_ENTRY ?? i + 1;
  console.log(`\n[Entry ${entryNum}]`);
  console.log(entry.slice(0, 200).trim());

  if (DRY_RUN) {
    console.log("  → DRY RUN: would synthesize and write file");
    continue;
  }

  const rule = await synthesizeRule(entry);
  if (!rule) {
    console.log("  → Failed to synthesize rule, skipping.");
    continue;
  }

  console.log(`  → Rule: ${rule.rule}`);
  console.log(`  → Why: ${rule.why}`);

  const filename = nextFilename();
  writeFeedbackFile(filename, rule.name, rule.rule, rule.why, rule.howToApply);
  appendToMemoryIndex(filename, rule.rule);
  console.log(`  → Written: ${filename}`);
  promoted++;
}

if (!DRY_RUN && promoted > 0) {
  // Clear promoted entries from staging (reset to header only)
  const headerEnd = staged.indexOf("# Staged Feedback Entries");
  const header = headerEnd !== -1
    ? staged.slice(0, staged.indexOf("\n\n---", headerEnd + 1) || staged.length)
    : staged.split("\n---\n")[0];
  writeFileSync(STAGING, header.trim() + "\n\n");
  console.log(`\n✅ Promoted ${promoted} entries. Staging file cleared.`);
} else if (!DRY_RUN) {
  console.log("\nNo entries promoted.");
}
