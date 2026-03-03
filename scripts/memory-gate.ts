#!/usr/bin/env bun
/**
 * memory-gate.ts — Ollama-powered memory relevance filter
 * 
 * Takes a user message, uses a local Ollama model to:
 * 1. Decide if the message needs memory context (yes/no)
 * 2. Extract search keywords if yes
 * 3. Runs memory hybrid search and outputs results
 * 
 * Exit codes:
 *   0 = memory results found and printed
 *   1 = error
 *   2 = no memory needed (message is trivial/greeting/etc)
 *   3 = memory needed but no results found
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const GATE_MODEL = process.env.ZO_GATE_MODEL || "qwen2.5:1.5b";
const MEMORY_SCRIPT = "/home/workspace/Skills/zo-memory-system/scripts/memory.ts";
const MAX_RESULTS = 5;

interface GateResponse {
  needs_memory: boolean;
  keywords: string[];
  reason: string;
}

async function callOllama(message: string): Promise<GateResponse> {
  const prompt = `You are a classifier. Given a user message, decide if it would benefit from retrieving stored memory/context from previous conversations.

Answer ONLY with valid JSON, no other text.

Rules:
- DEFAULT to "needs_memory": false. Only set true when the message CLEARLY references past work, projects, stored preferences, prior decisions, specific people/contacts, saved configurations, or ongoing tasks from previous sessions.
- "needs_memory": false for: greetings, small talk, general knowledge questions, self-contained instructions, code explanations, math, definitions, how-to questions, opinions, or anything answerable without prior conversation history.
- "keywords": 2-4 specific search terms extracted from the message (only if needs_memory is true, empty array otherwise). Never include generic words like "hello", "how", "what".
- "reason": one short sentence explaining your decision

Examples:
User: "hello"
{"needs_memory": false, "keywords": [], "reason": "Simple greeting"}

User: "hello how are you"
{"needs_memory": false, "keywords": [], "reason": "Casual greeting"}

User: "hey whats up"
{"needs_memory": false, "keywords": [], "reason": "Casual greeting"}

User: "good morning"
{"needs_memory": false, "keywords": [], "reason": "Simple greeting"}

User: "thanks!"
{"needs_memory": false, "keywords": [], "reason": "Acknowledgment"}

User: "what did we decide about the FFB pricing?"
{"needs_memory": true, "keywords": ["FFB", "pricing", "decision"], "reason": "References past decision about a project"}

User: "what's 2+2?"
{"needs_memory": false, "keywords": [], "reason": "General knowledge question"}

User: "update the supplier scorecard"
{"needs_memory": true, "keywords": ["supplier", "scorecard"], "reason": "References an existing document/workflow"}

User: "how's the portfolio doing?"
{"needs_memory": true, "keywords": ["portfolio", "performance"], "reason": "References ongoing financial tracking"}

User: "can you explain what async/await does in javascript?"
{"needs_memory": false, "keywords": [], "reason": "General programming knowledge question"}

User: "write a python function to sort a list"
{"needs_memory": false, "keywords": [], "reason": "Self-contained coding request"}

User: "what time is it?"
{"needs_memory": false, "keywords": [], "reason": "General utility question"}

User: "where did we leave off on the website review?"
{"needs_memory": true, "keywords": ["website", "review", "progress"], "reason": "References prior work status"}

User: "check the current zo resources"
{"needs_memory": false, "keywords": [], "reason": "Self-contained system command"}

Now classify this message:
User: "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GATE_MODEL,
      prompt,
      stream: false,
      keep_alive: "24h",
      options: {
        temperature: 0.1,
        num_predict: 150,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const raw = data.response.trim();

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse Ollama response as JSON: ${raw}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    needs_memory: Boolean(parsed.needs_memory),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    reason: String(parsed.reason || ""),
  };
}

async function searchMemory(keywords: string[]): Promise<string> {
  const query = keywords.join(" ");
  const proc = Bun.spawn(
    ["bun", MEMORY_SCRIPT, "hybrid", query, "--limit", String(MAX_RESULTS), "--no-hyde"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    // Fallback to FTS search
    const ftsProc = Bun.spawn(
      ["bun", MEMORY_SCRIPT, "search", query, "--limit", String(MAX_RESULTS)],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const ftsOut = await new Response(ftsProc.stdout).text();
    await ftsProc.exited;
    return ftsOut.trim();
  }

  return stdout.trim();
}

async function main() {
  const message = process.argv.slice(2).join(" ").trim();

  if (!message) {
    console.error("Usage: bun memory-gate.ts <user message>");
    process.exit(1);
  }

  try {
    const gate = await callOllama(message);

    if (!gate.needs_memory) {
      // No memory needed — exit silently
      process.exit(2);
    }

    if (gate.keywords.length === 0) {
      console.error("Gate said memory needed but extracted no keywords");
      process.exit(3);
    }

    const results = await searchMemory(gate.keywords);

    if (!results || results.includes("No results") || results.includes("Found 0 results") || results.length < 10) {
      process.exit(3);
    }

    // Output results for injection into context
    console.log(`[Memory Context — keywords: ${gate.keywords.join(", ")}]`);
    console.log(results);
    process.exit(0);

  } catch (err) {
    console.error(`memory-gate error: ${err}`);
    process.exit(1);
  }
}

main();
