#!/usr/bin/env bun
/**
 * P2-4: Remote MCP trust verification.
 *
 * Fetches the Consensus MCP server manifest, diffs it against the last
 * known-good copy, and alerts on changes — particularly new/removed tools
 * (rug-pull detection on remote MCP dependencies).
 *
 * Usage:
 *   bun mcp-trust-check.ts              # check, store baseline on first run
 *   bun mcp-trust-check.ts --json       # machine-readable output
 *
 * Scheduled: run daily via [SYS] MCP Trust Check automation.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const MANIFEST_URL = "https://mcp.consensus.app/mcp";
const STATE_DIR = join(import.meta.dir || ".", ".mcp-trust");
const MANIFEST_FILE = join(STATE_DIR, "consensus-manifest.json");
const HISTORY_FILE = join(STATE_DIR, "manifest-history.jsonl");

interface ManifestChange {
  type: "added" | "removed" | "modified";
  tool: string;
  details?: string;
}

interface ManifestEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface CheckResult {
  status: "unchanged" | "changed" | "baseline";
  changes: ManifestChange[];
  hash: string;
  toolCount: number;
}

async function fetchManifest(): Promise<ManifestEntry[] | null> {
  try {
    const resp = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      console.error(`[mcp-trust] HTTP ${resp.status} fetching manifest`);
      return null;
    }
    const data: unknown = await resp.json();
    const manifest = data && typeof data === "object" ? data as Record<string, unknown> : null;
    const tools = manifest?.tools ?? manifest?.functions ?? data ?? [];
    return Array.isArray(tools) ? tools : [];
  } catch (err) {
    console.error(`[mcp-trust] Manifest fetch failed: ${err}`);
    return null;
  }
}

function hashManifest(tools: ManifestEntry[]): string {
  const normalized = tools
    .map(t => ({ name: t.name, schema: t.inputSchema ?? {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

function buildToolMap(tools: ManifestEntry[]): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  for (const t of tools) {
    map.set(t.name, t);
  }
  return map;
}

function diffManifests(
  current: ManifestEntry[],
  previous: ManifestEntry[],
): ManifestChange[] {
  const changes: ManifestChange[] = [];
  const prevMap = buildToolMap(previous);
  const currMap = buildToolMap(current);

  for (const [name] of prevMap) {
    if (!currMap.has(name)) {
      changes.push({ type: "removed", tool: name });
    }
  }

  for (const [name, entry] of currMap) {
    if (!prevMap.has(name)) {
      changes.push({ type: "added", tool: name, details: entry.description });
    } else {
      const prevEntry = prevMap.get(name)!;
      if (JSON.stringify(entry.inputSchema) !== JSON.stringify(prevEntry.inputSchema)) {
        changes.push({
          type: "modified",
          tool: name,
          details: "inputSchema changed",
        });
      }
    }
  }

  return changes;
}

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });

  const current = await fetchManifest();
  if (!current) {
    console.error("[mcp-trust] Could not fetch manifest — skipping check");
    process.exit(2);
  }

  const hash = hashManifest(current);

  if (!existsSync(MANIFEST_FILE)) {
    writeFileSync(MANIFEST_FILE, JSON.stringify(current, null, 2));
    writeFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), hash, toolCount: current.length, event: "baseline" }) + "\n");
    console.log(`[mcp-trust] Baseline stored: ${current.length} tools, hash=${hash}`);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ status: "baseline", hash, toolCount: current.length }));
    }
    return;
  }

  const previous: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
  const changes = diffManifests(current, previous);
  const result: CheckResult = {
    status: changes.length === 0 ? "unchanged" : "changed",
    changes,
    hash,
    toolCount: current.length,
  };

  if (changes.length > 0) {
    console.error(`\n⚠️  [mcp-trust] MANIFEST CHANGED — ${changes.length} change(s) detected!`);
    for (const c of changes) {
      console.error(`  ${c.type === "added" ? "➕" : c.type === "removed" ? "➖" : "✏️"}  ${c.tool}${c.details ? ` — ${c.details}` : ""}`);
    }
    writeFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...result, event: "changed" }) + "\n");
    // Update stored manifest to track the new state
    writeFileSync(MANIFEST_FILE, JSON.stringify(current, null, 2));
    process.exit(1);
  } else {
    console.error(`[mcp-trust] No changes detected: ${current.length} tools, hash=${hash}`);
    writeFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), hash, toolCount: current.length, event: "unchanged" }) + "\n");
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  }
}

main().catch((err) => {
  console.error(`[mcp-trust] Fatal: ${err}`);
  process.exit(2);
});
