#!/usr/bin/env node
/**
 * Shared helpers for pro-flash-orchestrator hooks (v0.3).
 *
 * Design rules:
 *  - Never throw into the caller: every helper is exception-safe, so a hook can
 *    always print one valid JSON object and never block the agent loop.
 *  - Nothing here writes to stdout except `output()`; hooks must emit exactly
 *    one JSON object (a stray console.log corrupts the decision).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.dirname(SCRIPTS_DIR);
export const STATE_DIR = path.join(PLUGIN_DIR, '.state');
export const SESSION_DIR = path.join(STATE_DIR, 'sessions');
export const LOG_FILE = path.join(STATE_DIR, 'decisions.jsonl');
export const SPAWN_FILE = path.join(STATE_DIR, 'last_spawn.json');

export function markSubagentSpawn(parentConvId) {
  try {
    ensureStateDir();
    fs.writeFileSync(SPAWN_FILE, JSON.stringify({ ts: Date.now(), parent: String(parentConvId || '') }), 'utf8');
  } catch {
    /* ignore */
  }
}

const MODES = new Set(['off', 'shadow', 'enforce']);
const MAX_LOG_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ input */

export function readPayload() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getArgs(payload) {
  const args = payload && payload.toolCall && payload.toolCall.args;
  return args && typeof args === 'object' ? args : {};
}

export function toolName(payload) {
  return String((payload && payload.toolCall && payload.toolCall.name) || '');
}

export function lastUserInput(payload) {
  return String((payload && payload.lastUserInput) || '');
}

export function mentions(payload, token) {
  return lastUserInput(payload).toLowerCase().includes(String(token).toLowerCase());
}

/**
 * A hook running inside a sub-agent can be identified three ways, in order:
 *   1. `parentConversationId` / `callerContext.parentConversationId` (contract);
 *   2. the conversation transcript: a sub-agent's step 0 is a SYSTEM message
 *      carrying `[Message] ... sender=<parent>` (verified on 41 real Antigravity
 *      transcripts: main conversations start with USER_EXPLICIT/USER_INPUT);
 *   3. only when the transcript does not exist yet, a `[FLASH-WORKER]` /
 *      `[ARGON-CONTRACT]` prefix in lastUserInput.
 *
 * The transcript is authoritative when readable, because `lastUserInput` is the
 * *user's* message for a main agent and a user may paste those tokens.
 */
function transcriptVerdict(rawPath) {
  try {
    if (!rawPath || typeof rawPath !== 'string' || !fs.existsSync(rawPath)) return null;
    const fd = fs.openSync(rawPath, 'r');
    let text;
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
      text = buf.toString('utf8', 0, bytesRead);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close error */
      }
    }

    if (!text.trim()) return null;

    const lines = text.split(/\r?\n/).filter(Boolean);
    let parsedAnyStep = false;

    for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
      let step = null;
      try {
        step = JSON.parse(lines[i]);
      } catch {
        const srcMatch = lines[i].match(/"source"\s*:\s*"([^"]+)"/);
        if (srcMatch) {
          step = { source: srcMatch[1], content: '' };
        }
      }

      if (step && typeof step === 'object') {
        parsedAnyStep = true;
        const source = String(step.source || '');
        if (source === 'USER_EXPLICIT' || source === 'USER_INPUT') {
          return false;
        }
        if (source === 'SYSTEM_SDK') {
          continue;
        }
        if (source === 'SYSTEM') {
          const content = typeof step.content === 'string' ? step.content : JSON.stringify(step.content || '');
          if (
            content.includes('[Message]') ||
            content.includes('sender=') ||
            content.includes('[FLASH-WORKER]') ||
            content.includes('[PRO-CONTRACT]') ||
            content.includes('[ARGON-CONTRACT]')
          ) {
            return true;
          }
        }
      }
    }

    if (!parsedAnyStep) {
      if (text.includes('<SYSTEM_MESSAGE>') && (text.includes('[Message]') || text.includes('sender='))) {
        return true;
      }
    }

    return false;
  } catch {
    return null;
  }
}

export function isSubAgent(payload) {
  try {
    const p = payload || {};
    const convId = String((p && p.conversationId) || '');
    const isDoctor = convId === 'doctor-test';
    const sess = convId && convId !== 'unknown' ? readSession(convId) : {};

    if (!isDoctor && sess && sess.isSubAgent === true) return true;
    if (p.parentConversationId) {
      if (convId && convId !== 'unknown' && !isDoctor) {
        writeSession(convId, { ...sess, isSubAgent: true });
      }
      return true;
    }
    const ctx = p.callerContext;
    if (ctx && typeof ctx === 'object' && ctx.parentConversationId) {
      if (convId && convId !== 'unknown' && !isDoctor) {
        writeSession(convId, { ...sess, isSubAgent: true });
      }
      return true;
    }
    if (!isDoctor && sess && sess.isSubAgent === false) return false;

    const verdict = transcriptVerdict(p.transcriptPath);
    if (verdict === true) {
      if (convId && convId !== 'unknown' && !isDoctor) {
        writeSession(convId, { ...sess, isSubAgent: true });
      }
      return true;
    }
    if (verdict === false) {
      if (convId && convId !== 'unknown' && !isDoctor) {
        writeSession(convId, { ...sess, isSubAgent: false });
      }
      return false;
    }

    if (verdict === null && !p.toolCall) {
      try {
        if (fs.existsSync(SPAWN_FILE)) {
          const spawnRaw = fs.readFileSync(SPAWN_FILE, 'utf8');
          const spawn = JSON.parse(spawnRaw);
          if (
            spawn &&
            Date.now() - Number(spawn.ts || 0) < 20000 &&
            convId &&
            convId !== 'unknown' &&
            convId !== spawn.parent
          ) {
            writeSession(convId, { ...sess, isSubAgent: true, parentConversationId: spawn.parent });
            try {
              fs.unlinkSync(SPAWN_FILE);
            } catch {
              /* ignore */
            }
            return true;
          }
        }
      } catch {
        /* ignore */
      }
    }

    const input = String(p.lastUserInput || '');
    // Cold-start sub-agent: system message wrapper or prefixed/appended contract marker.
    if (input.includes('<SYSTEM_MESSAGE>') && (input.includes('[Message]') || input.includes('sender='))) {
      return true;
    }
    if (/^\s*\[(?:FLASH-WORKER|PRO-CONTRACT|ARGON-CONTRACT)\]/.test(input)) {
      return true;
    }
    if (/\n\n\[(?:PRO-CONTRACT|ARGON-CONTRACT)\]\s+(?:汇报仅限结构化摘要|完成后仅回复四列表格|保持紧凑回报)/.test(input)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- mode */

/**
 * off     -> do nothing at all (still logs nothing)
 * shadow  -> compute the decision, log it, but never change behaviour
 * enforce -> apply
 * Resolution order: PRO_MODE env > ARGON_MODE env > .state/mode.json > "enforce".
 */
export function currentMode() {
  const fromEnv = String(process.env.PRO_MODE || process.env.ARGON_MODE || '').trim().toLowerCase();
  if (MODES.has(fromEnv)) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'mode.json'), 'utf8'));
    const m = String((cfg && cfg.mode) || '').trim().toLowerCase();
    if (MODES.has(m)) return m;
  } catch {
    /* no config -> default */
  }
  return 'enforce';
}

export function ensureStateDir() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const now = Date.now();
    const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(SESSION_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(SESSION_DIR, file);
      try {
        const st = fs.statSync(fullPath);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* read-only install: logging becomes a no-op */
  }
}

/* ------------------------------------------------------------------- logs */

/** Hooks call this once so every log line carries the conversation id. */
let CTX = null;

export function setContext(payload) {
  CTX = payload || null;
}

export function logDecision(entry) {
  try {
    ensureStateDir();
    const conv = CTX && CTX.conversationId ? String(CTX.conversationId).slice(0, 8) : '';
    const record = {
      ts: new Date().toISOString(),
      ...(conv ? { conv } : {}),
      ...(process.env.ARGON_TEST === '1' ? { test: true } : {}),
      ...entry,
    };
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, path.join(STATE_DIR, 'decisions.1.jsonl'));
    } catch {
      /* first write */
    }
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* never let logging break a hook */
  }
}

export function output(obj) {
  try {
    process.stdout.write(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

export const ALLOW = Object.freeze({ decision: 'allow' });

/* -------------------------------------------------------------- file info */

/**
 * Line count + size for a file. Reads at most 512 KB: for bigger files the
 * returned `lines` is a lower bound and `truncated` is true.
 */
export function fileInfo(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { exists: false };
    const cap = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(cap);
      const n = fs.readSync(fd, buf, 0, cap, 0);
      buf = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
    let lines = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) lines += 1;
    if (buf.length > 0 && buf[buf.length - 1] !== 10) lines += 1;
    const truncated = st.size > cap;
    const avgLineBytes = lines > 0 ? Math.round(buf.length / lines) : st.size;
    const estimatedLines = truncated ? Math.round(st.size / Math.max(avgLineBytes, 35)) : lines;
    return { exists: true, bytes: st.size, lines: estimatedLines, avgLineBytes, truncated };
  } catch {
    return { exists: false };
  }
}

export function readTail(file, maxBytes = 512 * 1024) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ paths */

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

export function resolvePath(raw, payload) {
  let p = String(raw || '')
    .trim()
    .replace(/^\\?["'`]+|\\?["'`]+$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!p) return '';
  if (p.toLowerCase().startsWith('file:')) {
    p = p.replace(/^file:\/{2,3}/i, '');
    p = p.replace(/^\/([a-zA-Z]:[\\/])/, '$1');
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep raw */
    }
  }
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  if (WINDOWS_ABS.test(p) || path.isAbsolute(p)) return path.normalize(p);
  const ws = Array.isArray(payload && payload.workspacePaths) ? payload.workspacePaths[0] : '';
  return ws ? path.resolve(ws, p) : path.resolve(p);
}

export function basenameOf(file) {
  return path.basename(String(file || '')).toLowerCase();
}

/* --------------------------------------------------------------- sessions */

function sessionFile(conversationId) {
  const id = String(conversationId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(SESSION_DIR, `${id}.json`);
}

export function readSession(conversationId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(conversationId), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeSession(conversationId, data) {
  try {
    ensureStateDir();
    fs.writeFileSync(sessionFile(conversationId), JSON.stringify(data || {}), 'utf8');
  } catch {
    /* ignore */
  }
}
