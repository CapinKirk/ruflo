#!/usr/bin/env node
/**
 * Context Persistence Hook (ADR-051: Compaction-to-Memory Bridge)
 *
 * Archives conversation turns before compaction and restores relevant
 * context after compaction. Implements the "infinite context" pattern
 * where compaction becomes invisible because all information is already
 * persisted in the transcript archive.
 *
 * Usage:
 *   node context-persistence-hook.mjs archive   # PreCompact: archive transcript turns
 *   node context-persistence-hook.mjs restore   # SessionStart: restore context after compact
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const ARCHIVE_PATH = join(DATA_DIR, 'transcript-archive.json');
const RESTORE_BUDGET = 4000; // chars to inject after compaction
const MAX_SESSIONS = 10;     // keep last N sessions in archive
const MAX_MESSAGES = 500;    // cap transcript parsing for timeout safety

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Stdin reader (with timeout) ──────────────────────────────────────────

async function readStdin() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    }, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve({}); });
    process.stdin.resume();
  });
}

// ── Archive store ────────────────────────────────────────────────────────

function loadArchive() {
  if (!existsSync(ARCHIVE_PATH)) return { version: 1, sessions: {}, hashes: [] };
  try {
    return JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
  } catch {
    return { version: 1, sessions: {}, hashes: [] };
  }
}

function saveArchive(archive) {
  writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2), 'utf-8');
}

// ── Content hash (SHA-256, truncated to 16 hex chars) ────────────────────

function hashContent(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ── Transcript parser ────────────────────────────────────────────────────

function parseTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Parse JSONL — only keep user/assistant messages, cap for timeout safety
  const messages = [];
  for (const line of lines.slice(-MAX_MESSAGES)) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'user' || msg.type === 'assistant') {
        messages.push(msg);
      }
    } catch { /* skip unparseable lines */ }
  }

  // Group into conversation turns (user + assistant pairs)
  const turns = [];
  let currentTurn = null;

  for (const msg of messages) {
    if (msg.type === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        index: turns.length,
        userText: extractText(msg),
        assistantText: '',
        toolNames: [],
        filePaths: [],
        timestamp: new Date().toISOString(),
      };
    } else if (msg.type === 'assistant' && currentTurn) {
      currentTurn.assistantText = extractText(msg);
      const tools = extractToolUse(msg);
      currentTurn.toolNames = tools.names;
      currentTurn.filePaths = tools.filePaths;
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // Generate summaries and content hashes
  for (const turn of turns) {
    const fullContent = `${turn.userText}\n${turn.assistantText}`;
    turn.hash = hashContent(fullContent);
    turn.summary = buildSummary(turn);
  }

  return turns;
}

function extractText(msg) {
  if (!msg.message?.content) return '';
  if (typeof msg.message.content === 'string') return msg.message.content;
  if (Array.isArray(msg.message.content)) {
    return msg.message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .slice(0, 2000); // cap per-message text
  }
  return '';
}

function extractToolUse(msg) {
  const names = [];
  const filePaths = [];
  if (!msg.message?.content || !Array.isArray(msg.message.content)) return { names, filePaths };

  for (const block of msg.message.content) {
    if (block.type === 'tool_use') {
      names.push(block.name);
      if (block.input?.file_path) filePaths.push(block.input.file_path);
      if (block.input?.path) filePaths.push(block.input.path);
    }
  }
  return { names: [...new Set(names)], filePaths: [...new Set(filePaths)] };
}

function buildSummary(turn) {
  const parts = [];
  const userFirst = (turn.userText || '').split('\n')[0].slice(0, 100);
  if (userFirst) parts.push(userFirst);
  if (turn.toolNames.length) parts.push(`Tools: ${turn.toolNames.join(', ')}`);
  if (turn.filePaths.length) parts.push(`Files: ${turn.filePaths.slice(0, 5).join(', ')}`);
  const assistFirst = (turn.assistantText || '').split('\n')[0].slice(0, 100);
  if (assistFirst) parts.push(assistFirst);
  return parts.join(' | ').slice(0, 300);
}

// ── Archive command (PreCompact safety net) ──────────────────────────────

async function doArchive(input) {
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id || 'unknown';

  if (!transcriptPath) {
    console.log('[CONTEXT] No transcript_path provided, skipping archive');
    return;
  }

  const archive = loadArchive();
  const hashSet = new Set(archive.hashes || []);
  const turns = parseTranscript(transcriptPath);

  if (!archive.sessions[sessionId]) {
    archive.sessions[sessionId] = { turns: [], archivedAt: new Date().toISOString() };
  }

  let newCount = 0;
  for (const turn of turns) {
    if (!hashSet.has(turn.hash)) {
      hashSet.add(turn.hash);
      archive.sessions[sessionId].turns.push(turn);
      newCount++;
    }
  }

  archive.hashes = [...hashSet];

  // Prune old sessions to prevent unbounded growth
  const sessionIds = Object.keys(archive.sessions);
  if (sessionIds.length > MAX_SESSIONS) {
    for (const old of sessionIds.slice(0, sessionIds.length - MAX_SESSIONS)) {
      // Remove hashes for pruned sessions
      const oldHashes = new Set((archive.sessions[old].turns || []).map(t => t.hash));
      archive.hashes = archive.hashes.filter(h => !oldHashes.has(h));
      delete archive.sessions[old];
    }
  }

  saveArchive(archive);
  console.log(`[CONTEXT] Archived ${newCount} new turns (${turns.length} total parsed, session: ${sessionId})`);
}

// ── Restore command (SessionStart after compact) ─────────────────────────

async function doRestore(input) {
  const sessionId = input.session_id || 'unknown';
  const source = input.source || '';

  // Only restore after compaction, not on fresh start or resume
  if (source !== 'compact') {
    return;
  }

  const archive = loadArchive();
  const sessionData = archive.sessions[sessionId];

  if (!sessionData || !sessionData.turns.length) {
    console.log('[CONTEXT] No archived context to restore for this session');
    return;
  }

  // Build restoration text: most recent turns first, fit within budget
  const turns = sessionData.turns.slice().reverse();
  const header = `[RESTORED_CONTEXT] Recovered ${sessionData.turns.length} turns from pre-compaction archive:`;
  const lines = [header];
  let charCount = header.length;
  let restoredCount = 0;

  for (const turn of turns) {
    const entry = `- Turn ${turn.index}: ${turn.summary}`;
    if (charCount + entry.length + 1 > RESTORE_BUDGET) break;
    lines.push(entry);
    charCount += entry.length + 1;
    restoredCount++;
  }

  lines.push(`[/RESTORED_CONTEXT] (${restoredCount}/${sessionData.turns.length} turns fit in budget)`);
  console.log(lines.join('\n'));
}

// ── Main ─────────────────────────────────────────────────────────────────

const command = process.argv[2] || 'status';

// Safety timeout — hooks must never hang
const safetyTimer = setTimeout(() => {
  process.stderr.write('[WARN] context-persistence-hook timeout (6s), forcing exit\n');
  process.exit(0);
}, 6000);
safetyTimer.unref();

process.on('unhandledRejection', () => {});

try {
  const input = await readStdin();

  switch (command) {
    case 'archive': await doArchive(input); break;
    case 'restore': await doRestore(input); break;
    default:
      console.log('Usage: context-persistence-hook.mjs <archive|restore>');
      break;
  }
} catch (err) {
  // Hooks must never crash Claude Code
  try { console.log(`[WARN] Context persistence error: ${err.message}`); } catch (_) {}
}

process.exit(0);
