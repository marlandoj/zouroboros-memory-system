#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

type OpenLoopStatus = "open" | "resolved" | "stale" | "superseded";
type OpenLoopKind = "task" | "bug" | "incident" | "approval" | "commitment" | "other";

type EpisodeOutcome = "success" | "failure" | "resolved" | "ongoing";

export interface EpisodeRecordInput {
  summary: string;
  outcome: EpisodeOutcome;
  happenedAt: number;
  durationMs?: number;
  procedureId?: string;
  entities: string[];
  metadata?: Record<string, unknown>;
}

export interface OpenLoopInput {
  persona?: string;
  title: string;
  summary?: string;
  kind?: OpenLoopKind;
  status?: OpenLoopStatus;
  priority?: number;
  entity?: string | null;
  source?: string;
  relatedEpisodeId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OpenLoopRecord extends OpenLoopInput {
  id: string;
  persona: string;
  summary: string;
  kind: OpenLoopKind;
  status: OpenLoopStatus;
  priority: number;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number | null;
}

export interface ContinuationDetection {
  needsMemory: boolean;
  score: number;
  keywords: string[];
  reason: string;
}

export interface RankedContinuationItem {
  kind: "fact" | "episode" | "open_loop";
  id: string;
  title: string;
  summary: string;
  entity?: string | null;
  score: number;
  source: string;
  metadata?: Record<string, unknown>;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do", "for", "from", "get", "got",
  "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "my", "of", "on",
  "or", "our", "so", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up",
  "use", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your"
]);

const CONTINUATION_PHRASES = [
  "continue", "left off", "leave off", "pick up", "resume", "earlier", "before", "still", "again", "status", "progress", "result",
  "we were", "last time", "few days", "yesterday", "last week", "follow up", "next step", "open loop"
];

const ACTION_HINTS = [
  "update", "fix", "finish", "review", "check", "resume", "continue", "revisit", "investigate", "follow", "compare"
];

const GREETING_ONLY = /^(hi|hello|hey|yo|good morning|good afternoon|good evening|thanks|thank you|ok|okay|yes|no)[!. ]*$/i;

function safeJson(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !STOPWORDS.has(s));
}

function makeFtsQuery(text: string): string {
  const terms = Array.from(new Set(tokenize(text))).slice(0, 8);
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function buildFingerprint(kind: OpenLoopKind, entity: string | null | undefined, title: string): string {
  return `${kind}::${(entity || "").toLowerCase()}::${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

function normalizePriority(priority?: number): number {
  return Math.max(0, Math.min(1, priority ?? 0.6));
}

function loopKindFromText(text: string): OpenLoopKind {
  const lower = text.toLowerCase();
  if (/\b(bug|error|broken|fail|failing|issue|fix)\b/.test(lower)) return "bug";
  if (/\b(incident|outage|downtime|502|521|alert)\b/.test(lower)) return "incident";
  if (/\b(approve|approval|confirm|decision needed|pending decision)\b/.test(lower)) return "approval";
  if (/\b(next step|follow up|commitment|need to|should|must|todo|to-do)\b/.test(lower)) return "commitment";
  return "task";
}

function looksResolved(text: string): boolean {
  return /\b(resolved|fixed|done|completed|closed|approved|shipped|finished)\b/i.test(text);
}

function inferEntity(text: string): string | null {
  const match = text.match(/\b([a-z]+(?:[._-][a-z0-9]+)+)\b/i);
  return match ? match[1] : null;
}

function recencyBoost(unixSeconds: number, windowDays: number): number {
  const ageDays = Math.max(0, (Date.now() / 1000 - unixSeconds) / 86400);
  return Math.max(0, 1 - ageDays / windowDays);
}

export function ensureContinuationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_documents (
      episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
      episode_id UNINDEXED,
      text
    );

    CREATE TABLE IF NOT EXISTS open_loops (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','bug','incident','approval','commitment','other')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','stale','superseded')),
      priority REAL DEFAULT 0.6,
      entity TEXT,
      source TEXT,
      related_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      fingerprint TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_loops_active_fingerprint
      ON open_loops(fingerprint, status);
    CREATE INDEX IF NOT EXISTS idx_open_loops_status_updated
      ON open_loops(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_open_loops_entity
      ON open_loops(entity);
    CREATE INDEX IF NOT EXISTS idx_open_loops_persona
      ON open_loops(persona);

    CREATE VIRTUAL TABLE IF NOT EXISTS open_loops_fts USING fts5(
      loop_id UNINDEXED,
      text
    );
  `);
}

export function syncEpisodeDocument(
  db: Database,
  episodeId: string,
  summary: string,
  metadata: Record<string, unknown> | undefined,
  entities: string[]
): void {
  ensureContinuationSchema(db);
  const metadataText = metadata ? JSON.stringify(metadata) : "";
  const searchText = [summary, entities.join(" "), metadataText].filter(Boolean).join("\n");

  db.prepare(`
    INSERT INTO episode_documents (episode_id, text, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(episode_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
  `).run(episodeId, searchText);

  db.prepare("DELETE FROM episode_documents_fts WHERE episode_id = ?").run(episodeId);
  db.prepare("INSERT INTO episode_documents_fts (episode_id, text) VALUES (?, ?)").run(episodeId, searchText);
}

export function createEpisodeRecord(db: Database, episode: EpisodeRecordInput): string {
  ensureContinuationSchema(db);
  const id = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO episodes (id, summary, outcome, happened_at, duration_ms, procedure_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    episode.summary,
    episode.outcome,
    episode.happenedAt,
    episode.durationMs || null,
    episode.procedureId || null,
    safeJson(episode.metadata),
    nowSec
  );

  const insertEntity = db.prepare("INSERT OR IGNORE INTO episode_entities (episode_id, entity) VALUES (?, ?)");
  for (const entity of episode.entities) {
    insertEntity.run(id, entity);
  }

  syncEpisodeDocument(db, id, episode.summary, episode.metadata, episode.entities);
  return id;
}

export function upsertOpenLoop(db: Database, input: OpenLoopInput): OpenLoopRecord {
  ensureContinuationSchema(db);
  const persona = input.persona || "shared";
  const title = input.title.trim();
  const summary = (input.summary || input.title).trim();
  const kind = input.kind || loopKindFromText(`${title} ${summary}`);
  const status = input.status || "open";
  const entity = input.entity || inferEntity(summary);
  const fingerprint = buildFingerprint(kind, entity, title);
  const priority = normalizePriority(input.priority);
  const nowSec = Math.floor(Date.now() / 1000);

  const existing = db.prepare(`
    SELECT * FROM open_loops
    WHERE fingerprint = ? AND status IN ('open','stale')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(fingerprint) as Record<string, unknown> | null;

  if (existing) {
    db.prepare(`
      UPDATE open_loops
      SET summary = ?, priority = ?, entity = ?, source = ?, related_episode_id = ?, metadata = ?, updated_at = ?, status = ?
      WHERE id = ?
    `).run(
      summary,
      priority,
      entity,
      input.source || existing.source || null,
      input.relatedEpisodeId || existing.related_episode_id || null,
      safeJson(input.metadata) || (existing.metadata as string) || null,
      nowSec,
      status,
      existing.id
    );

    syncOpenLoopFts(db, existing.id as string, title, summary, kind, status, entity);

    return {
      id: existing.id as string,
      persona,
      title,
      summary,
      kind,
      status,
      priority,
      entity,
      source: (input.source || existing.source) as string | undefined,
      relatedEpisodeId: (input.relatedEpisodeId || existing.related_episode_id) as string | null | undefined,
      metadata: input.metadata,
      fingerprint,
      createdAt: existing.created_at as number,
      updatedAt: nowSec,
      resolvedAt: existing.resolved_at as number | null | undefined,
    };
  }

  const id = randomUUID();
  const resolvedAt = status === "resolved" ? nowSec : null;

  db.prepare(`
    INSERT INTO open_loops (
      id, persona, title, summary, kind, status, priority, entity, source,
      related_episode_id, fingerprint, metadata, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    persona,
    title,
    summary,
    kind,
    status,
    priority,
    entity,
    input.source || null,
    input.relatedEpisodeId || null,
    fingerprint,
    safeJson(input.metadata),
    nowSec,
    nowSec,
    resolvedAt
  );

  syncOpenLoopFts(db, id, title, summary, kind, status, entity);

  return {
    id,
    persona,
    title,
    summary,
    kind,
    status,
    priority,
    entity,
    source: input.source,
    relatedEpisodeId: input.relatedEpisodeId,
    metadata: input.metadata,
    fingerprint,
    createdAt: nowSec,
    updatedAt: nowSec,
    resolvedAt,
  };
}

export function resolveMatchingOpenLoops(db: Database, text: string): number {
  ensureContinuationSchema(db);
  if (!looksResolved(text)) return 0;

  const keywords = tokenize(text).slice(0, 6);
  if (keywords.length === 0) return 0;

  const candidates = db.prepare(`
    SELECT * FROM open_loops
    WHERE status IN ('open','stale')
    ORDER BY updated_at DESC
    LIMIT 25
  `).all() as Array<Record<string, unknown>>;

  let resolved = 0;
  for (const row of candidates) {
    const haystack = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
    const matches = keywords.filter((k) => haystack.includes(k)).length;
    if (matches >= 2) {
      db.prepare(`
        UPDATE open_loops
        SET status = 'resolved', resolved_at = ?, updated_at = ?
        WHERE id = ?
      `).run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), row.id);
      syncOpenLoopFts(db, row.id as string, row.title as string, row.summary as string, row.kind as OpenLoopKind, "resolved", row.entity as string | null);
      resolved++;
    }
  }

  return resolved;
}

function syncOpenLoopFts(
  db: Database,
  id: string,
  title: string,
  summary: string,
  kind: OpenLoopKind,
  status: OpenLoopStatus,
  entity: string | null | undefined
): void {
  const text = [title, summary, kind, status, entity || ""].join("\n");
  db.prepare("DELETE FROM open_loops_fts WHERE loop_id = ?").run(id);
  db.prepare("INSERT INTO open_loops_fts (loop_id, text) VALUES (?, ?)").run(id, text);
}

export function extractOpenLoopsFromText(text: string, source: string): OpenLoopInput[] {
  const chunks = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 12)
    .slice(0, 200);

  const results: OpenLoopInput[] = [];
  const seen = new Set<string>();

  for (const line of chunks) {
    const lower = line.toLowerCase();
    const isCandidate = /\b(todo|to-do|next step|follow up|need to|needs to|should|must|pending|waiting on|unresolved|bug|issue|fix|investigate|approval|approve|confirm)\b/.test(lower);
    if (!isCandidate) continue;

    const title = line.length > 110 ? `${line.slice(0, 107).trim()}...` : line;
    const kind = loopKindFromText(line);
    const status: OpenLoopStatus = looksResolved(line) ? "resolved" : "open";
    const entity = inferEntity(line);
    const fingerprint = buildFingerprint(kind, entity, title);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    results.push({
      title,
      summary: line,
      kind,
      status,
      entity,
      priority: /\bmust|urgent|blocker|critical|outage\b/i.test(line) ? 0.9 : 0.6,
      source,
      metadata: { extractedFrom: source },
    });

    if (results.length >= 8) break;
  }

  return results;
}

export function detectContinuation(message: string): ContinuationDetection {
  const trimmed = message.trim();
  if (!trimmed) {
    return { needsMemory: false, score: 0, keywords: [], reason: "Empty message" };
  }
  if (GREETING_ONLY.test(trimmed)) {
    return { needsMemory: false, score: 0, keywords: [], reason: "Greeting or acknowledgement" };
  }

  const lower = trimmed.toLowerCase();
  let score = 0;

  for (const phrase of CONTINUATION_PHRASES) {
    if (lower.includes(phrase)) score += 2;
  }

  const tokens = tokenize(trimmed);
  const firstWord = lower.split(/\s+/)[0];
  if (ACTION_HINTS.includes(firstWord)) score += 1;
  if (/\b(this|that|it|them|those|again|still)\b/.test(lower)) score += 1;
  if (/\b(yesterday|earlier|before|ago|last)\b/.test(lower)) score += 2;
  if (trimmed.split(/\s+/).length <= 8) score += 1;
  if (/[A-Z]{2,}|[./_-]/.test(trimmed)) score += 1;
  if (/\b(what did we decide|where did we leave off|where did we stop|what was the result|what happened)\b/.test(lower)) score += 3;
  if (/\b(next step|tracking|track|focus|status|progress|review|dashboard|supplier|scorecard|risk dashboard)\b/.test(lower)) score += 2;
  if (/\b(what were we|what are we|is there still|are we still)\b/.test(lower)) score += 2;

  if (/^(write|explain|define|what is|how do i|create a new|build a new)\b/.test(lower)) score -= 2;

  const keywords = Array.from(new Set(tokens)).slice(0, 6);
  const needsMemory = score >= 2 && keywords.length > 0;

  return {
    needsMemory,
    score,
    keywords,
    reason: needsMemory ? "Likely continuation or follow-on work" : "Message appears self-contained",
  };
}

export function searchEpisodesForContinuation(
  db: Database,
  query: string,
  options: { limit?: number; windowDays?: number } = {}
): RankedContinuationItem[] {
  ensureContinuationSchema(db);
  const limit = options.limit || 5;
  const windowDays = options.windowDays || 14;
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const ftsQuery = makeFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = db.prepare(`
    SELECT e.id, e.summary, e.happened_at, e.outcome, ed.text
    FROM episode_documents_fts fts
    JOIN episode_documents ed ON ed.episode_id = fts.episode_id
    JOIN episodes e ON e.id = ed.episode_id
    WHERE episode_documents_fts MATCH ?
      AND e.happened_at >= ?
    LIMIT ${limit * 2}
  `).all(ftsQuery, since) as Array<Record<string, unknown>>;

  return rows.map((row, idx) => ({
    kind: "episode",
    id: row.id as string,
    title: `Episode: ${String(row.summary).slice(0, 60)}`,
    summary: row.summary as string,
    score: (1 / (1 + idx)) * 0.7 + recencyBoost(row.happened_at as number, windowDays) * 0.3,
    source: "episode-fts",
    metadata: { outcome: row.outcome },
  }));
}

export function searchOpenLoopsForContinuation(
  db: Database,
  query: string,
  options: { limit?: number; persona?: string; includeResolved?: boolean } = {}
): RankedContinuationItem[] {
  ensureContinuationSchema(db);
  const limit = options.limit || 5;
  const ftsQuery = makeFtsQuery(query);
  if (!ftsQuery) return [];

  const personaClause = options.persona ? "AND ol.persona = ?" : "";
  const statusClause = options.includeResolved ? "" : "AND ol.status IN ('open','stale')";
  const params = [ftsQuery, ...(options.persona ? [options.persona] : [])];

  const rows = db.prepare(`
    SELECT ol.*
    FROM open_loops_fts fts
    JOIN open_loops ol ON ol.id = fts.loop_id
    WHERE open_loops_fts MATCH ?
      ${personaClause}
      ${statusClause}
    ORDER BY ol.updated_at DESC
    LIMIT ${limit * 2}
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row, idx) => ({
    kind: "open_loop",
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    entity: row.entity as string | null,
    score: (1 / (1 + idx)) * 0.6 + ((row.priority as number) || 0.6) * 0.25 + recencyBoost(row.updated_at as number, 14) * 0.15,
    source: "open-loop-fts",
    metadata: {
      status: row.status,
      kind: row.kind,
      priority: row.priority,
    },
  }));
}

export function renderContinuationContext(results: RankedContinuationItem[], maxItems: number = 6): string {
  const top = results.slice(0, maxItems);
  if (top.length === 0) return "";

  const lines = ["[Continuation Context]"];
  for (const item of top) {
    if (item.kind === "fact") {
      lines.push(`- fact: ${item.summary}`);
    } else if (item.kind === "episode") {
      lines.push(`- episode: ${item.summary}`);
    } else {
      lines.push(`- open loop: ${item.title} — ${item.summary}`);
    }
  }
  return lines.join("\n");
}
