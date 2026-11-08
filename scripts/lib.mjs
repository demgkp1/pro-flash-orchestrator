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
export const STATE_DIR = process.env.PRO_STATE_DIR || process.env.ARGON_STATE_DIR
  ? path.resolve(process.env.PRO_STATE_DIR || process.env.ARGON_STATE_DIR)
  : path.join(PLUGIN_DIR, '.state');
export const SESSION_DIR = path.join(STATE_DIR, 'sessions');
export const LOG_FILE = path.join(STATE_DIR, 'decisions.jsonl');
export const SPAWN_FILE = path.join(STATE_DIR, 'last_spawn.json');
export const SPAWN_LOCK = path.join(STATE_DIR, 'last_spawn.lock');

/* ------------------------------------------------------------------- locks */

/**
 * Cross-platform spinlock using exclusive file creation ('wx').
 * If lock file is older than 3000ms, it is considered stale/deadlocked and cleaned up.
 */
export function acquireLock(lockFile, timeoutMs = 2000) {
  const start = Date.now();
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockFile);
          if (Date.now() - st.mtimeMs > 3000) {
            try {
              fs.unlinkSync(lockFile);
            } catch {
              /* ignore */
            }
            continue;
          }
        } catch {
          // lock file may have just been removed by another process
          continue;
        }
        Atomics.wait(sleepBuffer, 0, 0, 15);
      } else {
        try {
          fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        } catch {
          /* ignore */
        }
        Atomics.wait(sleepBuffer, 0, 0, 15);
      }
    }
  }
  return false;
}

export function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
}

/**
 * Safe atomic write with Windows EPERM retry and copy fallback.
 */
export function safeWriteFileSync(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, content, { encoding: 'utf8', mode: 0o600 });
    let renamed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.renameSync(tmpFile, filePath);
        renamed = true;
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    if (!renamed) {
      try {
        fs.copyFileSync(tmpFile, filePath);
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    try {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      try {
        process.stderr.write(`[pro-flash-orchestrator] state write failed: ${filePath}: ${err && err.message}\n`);
      } catch {
        /* ignore */
      }
    }
  }
}

/* -------------------------------------------------------------- spawn pool */

export function markSubagentSpawn(parentConvId) {
  try {
    ensureStateDir();
    const locked = acquireLock(SPAWN_LOCK, 2000);
    try {
      const now = Date.now();
      let pool = { pendingCount: 0, spawns: [] };
      if (fs.existsSync(SPAWN_FILE)) {
        try {
          const raw = fs.readFileSync(SPAWN_FILE, 'utf8');
          const data = JSON.parse(raw);
          if (Array.isArray(data && data.spawns)) {
            pool.spawns = data.spawns;
          } else if (data && data.parent && data.ts) {
            pool.spawns = [{ parent: String(data.parent), ts: Number(data.ts), claimedBy: null }];
          }
        } catch {
          /* ignore json parse */
        }
      }
      pool.spawns = pool.spawns.filter((s) => now - Number(s.ts || 0) < 60000);
      pool.spawns.push({
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        parent: String(parentConvId || ''),
        ts: now,
        claimedBy: null,
      });
      pool.pendingCount = pool.spawns.filter((s) => !s.claimedBy).length;
      safeWriteFileSync(SPAWN_FILE, JSON.stringify(pool, null, 2));
    } finally {
      if (locked) releaseLock(SPAWN_LOCK);
    }
  } catch {
    /* ignore */
  }
}

export function checkAndClaimSubagent(convId) {
  if (!convId || convId === 'unknown' || convId === 'doctor-test' || convId.startsWith('doctor-') || Boolean(process.env.PRO_TEST || process.env.ARGON_TEST)) return null;
  try {
    ensureStateDir();
    const locked = acquireLock(SPAWN_LOCK, 2000);
    try {
      if (!fs.existsSync(SPAWN_FILE)) return null;
      const raw = fs.readFileSync(SPAWN_FILE, 'utf8');
      const pool = JSON.parse(raw);
      if (!pool || !Array.isArray(pool.spawns)) return null;

      const now = Date.now();
      pool.spawns = pool.spawns.filter((s) => now - Number(s.ts || 0) < 60000);

      // 1. check if already claimed by this convId
      const existing = pool.spawns.find((s) => s.claimedBy === convId);
      if (existing) {
        return { isSubAgent: true, parent: existing.parent };
      }

      // 2. find first unclaimed spawn not spawned by convId
      const unclaimed = pool.spawns.find((s) => !s.claimedBy && s.parent !== convId);
      if (unclaimed) {
        unclaimed.claimedBy = convId;
        pool.pendingCount = pool.spawns.filter((s) => !s.claimedBy).length;
        safeWriteFileSync(SPAWN_FILE, JSON.stringify(pool, null, 2));
        return { isSubAgent: true, parent: unclaimed.parent };
      }

      pool.pendingCount = pool.spawns.filter((s) => !s.claimedBy).length;
      safeWriteFileSync(SPAWN_FILE, JSON.stringify(pool, null, 2));
      return null;
    } finally {
      if (locked) releaseLock(SPAWN_LOCK);
    }
  } catch {
    return null;
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
    const isDoctor = convId === 'doctor-test' || convId.startsWith('doctor-') || Boolean(process.env.PRO_TEST || process.env.ARGON_TEST);
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
        updateSession(convId, (s) => {
          s.isSubAgent = false;
        });
      }
      return false;
    }

    if (!isDoctor && verdict === null) {
      try {
        const claim = checkAndClaimSubagent(convId);
        if (claim && claim.isSubAgent) {
          updateSession(convId, (s) => {
            s.isSubAgent = true;
            s.parentConversationId = claim.parent;
          });
          return true;
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
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
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

/** Mask credentials/tokens in log strings */
export function maskSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, 'sk-***')
    .replace(/\b(ghp_[A-Za-z0-9]{20,})\b/g, 'ghp_***')
    .replace(/((?:password|passwd|secret|token|api_key|apiKey)\s*[:=]\s*)[^\s;&|'"]+/gi, '$1***');
}

/** Hooks call this once so every log line carries the conversation id. */
let CTX = null;

export function setContext(payload) {
  CTX = payload || null;
}

export function logDecision(entry) {
  try {
    ensureStateDir();
    const conv = CTX && CTX.conversationId ? String(CTX.conversationId).slice(0, 8) : '';
    const safeEntry = { ...entry };
    if (typeof safeEntry.command === 'string') {
      safeEntry.command = maskSecrets(safeEntry.command);
    }
    if (typeof safeEntry.reason === 'string') {
      safeEntry.reason = maskSecrets(safeEntry.reason);
    }
    const record = {
      ts: new Date().toISOString(),
      ...(conv ? { conv } : {}),
      ...(process.env.ARGON_TEST === '1' ? { test: true } : {}),
      ...safeEntry,
    };
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, path.join(STATE_DIR, 'decisions.1.jsonl'));
    } catch {
      /* first write */
    }
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
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

function sanitizeSessionId(conversationId) {
  const id = String(conversationId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return /^\.*$/.test(id) ? 'unknown' : id;
}

function sessionFile(conversationId) {
  return path.join(SESSION_DIR, `${sanitizeSessionId(conversationId)}.json`);
}

function sessionLockFile(conversationId) {
  return path.join(SESSION_DIR, `${sanitizeSessionId(conversationId)}.lock`);
}

function defaultSession(extra = {}) {
  return {
    currentBatchSpawns: 0,
    lastSpawnAt: 0,
    maxReadsAllowed: 3,
    activeSubagents: [],
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

export function readSession(conversationId) {
  try {
    const raw = fs.readFileSync(sessionFile(conversationId), 'utf8');
    const parsed = JSON.parse(raw);
    return defaultSession(parsed);
  } catch {
    return defaultSession();
  }
}

export function updateSession(convId, mutatorFn) {
  const lockFile = sessionLockFile(convId);
  ensureStateDir();
  const locked = acquireLock(lockFile, 2000);
  try {
    const current = readSession(convId);
    let updated = typeof mutatorFn === 'function' ? mutatorFn(current) : current;
    if (updated === undefined) {
      updated = current;
    }
    const finalData = defaultSession(updated);
    safeWriteFileSync(sessionFile(convId), JSON.stringify(finalData));
    return finalData;
  } catch {
    return defaultSession();
  } finally {
    if (locked) {
      releaseLock(lockFile);
    }
  }
}

export function writeSession(conversationId, data) {
  try {
    return updateSession(conversationId, () => data);
  } catch {
    /* ignore */
  }
}
