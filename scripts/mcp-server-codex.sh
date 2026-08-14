#!/bin/bash
# Wrapper for Codex CLI: sources secrets before launching the stdio MCP server
source /root/.zo_secrets 2>/dev/null
exec bun /home/workspace/Skills/zo-memory-system/scripts/mcp-server.ts
