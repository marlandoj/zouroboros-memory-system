#!/usr/bin/env bun
/**
 * P0-1 migration — dedup-merge + write-gate + ACT-R recency.
 *
 * Idempotent. For every DB file referenced in backends.json that already
 * exists on disk:
 *   1. back it up once per run (cp to *.backup-pre-p0-1-<ts>)
 *   2. add facts.merged_count + facts.gate_status (column-exists guarded)
 *   3. add idx_facts_gate_status
 *   4. ensure the actr_activation table exists (mimir/financial lack it)
 *
 * Lazy DBs that don't exist yet are skipped — they inherit the new columns
 * from initDb's inline CREATE TABLE when first opened.
 *
 * Re-running is a no-op (exit 0, no error) apart from writing fresh backups.
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, copyFileSync } from "fs";
import { ensureActrSchema } from "./actr";

const BACKENDS_PATH =
  process.env.ZO_MEMORY_BACKENDS || "/home/workspace/.zo/memory/backends.json";

function resolveDbPaths(): string[] {
  const raw = JSON.parse(readFileSync(BACKENDS_PATH, "utf8")) as {
    default?: string;
    personas?: Record<string, string | null>;
  };
  const paths = new Set<string>();
  if (raw.default) paths.add(raw.default);
  for (const p of Object.values(raw.personas ?? {})) {
    if (p) paths.add(p);
  }
  return [...paths];
}

function columnNames(db: Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function migrateDb(path: string, ts: string): void {
  const backup = `${path}.backup-pre-p0-1-${ts}`;
  copyFileSync(path, backup);

  const db = new Database(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");

    const cols = columnNames(db, "facts");
    if (!cols.has("merged_count")) {
      db.exec("ALTER TABLE facts ADD COLUMN merged_count INTEGER NOT NULL DEFAULT 0");
      console.log(`  + merged_count`);
    }
    if (!cols.has("gate_status")) {
      db.exec("ALTER TABLE facts ADD COLUMN gate_status TEXT NOT NULL DEFAULT 'allow'");
      console.log(`  + gate_status`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_facts_gate_status ON facts(gate_status)");

    const hadActr = columnNames(db, "actr_activation").size > 0;
    ensureActrSchema(db);
    if (!hadActr) console.log(`  + actr_activation table`);
  } finally {
    db.close();
  }
}

function main(): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const paths = resolveDbPaths();
  let migrated = 0;
  let skipped = 0;

  for (const path of paths) {
    if (!existsSync(path)) {
      console.log(`skip (absent): ${path}`);
      skipped++;
      continue;
    }
    console.log(`migrate: ${path}`);
    migrateDb(path, ts);
    migrated++;
  }

  console.log(`\nP0-1 migration complete: ${migrated} migrated, ${skipped} skipped (lazy).`);
}

main();
