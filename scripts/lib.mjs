#!/usr/bin/env node
/**
 * Shared helpers for pro-flash-orchestrator hooks (v0.7.0).
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
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.dirname(SCRIPTS_DIR);
export const STATE_DIR = process.env.PRO_STATE_DIR || process.env.ARGON_STATE_DIR
  ? path.resolve(process.env.PRO_STATE_DIR || process.env.ARGON_STATE_DIR)
  : process.env.PLUGIN_DATA ? path.resolve(process.env.PLUGIN_DATA)
  : process.env.PRO_HARNESS === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugin-data', 'pro-flash-orchestrator')
  : path.join(PLUGIN_DIR, '.state');
export const SESSION_DIR = path.join(STATE_DIR, 'sessions');
export const LOG_FILE = path.join(STATE_DIR, 'decisions.jsonl');
export const SPAWN_FILE = path.join(STATE_DIR, 'last_spawn.json');
export const SPAWN_LOCK = path.join(STATE_DIR, 'last_spawn.lock');
const SPAWN_TTL_MS = 10 * 60 * 1000;
export const CAPABILITIES_FILE = path.join(STATE_DIR, 'capabilities.json');
const CAPABILITIES_LOCK = `${CAPABILITIES_FILE}.lock`;
export const UPDATE_CHECK_FILE = path.join(STATE_DIR, 'update-check.json');
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_VERSION = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
    return typeof manifest?.version === 'string' && manifest.version.trim() ? manifest.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/* ------------------------------------------------------------------- locks */

/**
 * Cross-platform spinlock using exclusive file creation ('wx').
 * Reap old locks only when their owner has exited. Never steal a live lock.
 */
const ownedLocks = new Map();

export function acquireLock(lockFile, timeoutMs = 2000) {
  const start = Date.now();
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        ownedLocks.set(lockFile, token);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockFile);
          if (Date.now() - st.mtimeMs > 3000) {
            let liveOwner = false;
            try {
              const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
              if (Number.isInteger(owner.pid) && owner.pid > 0) {
                try {
                  process.kill(owner.pid, 0);
                  liveOwner = true;
                } catch (error) {
                  liveOwner = error.code !== 'ESRCH';
                }
              }
            } catch {
              /* Legacy/empty abandoned locks can still be reaped. */
            }
            if (liveOwner) {
              Atomics.wait(sleepBuffer, 0, 0, 15);
              continue;
            }
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
    const token = ownedLocks.get(lockFile);
    if (token && JSON.parse(fs.readFileSync(lockFile, 'utf8')).token === token) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    /* ignore */
  } finally {
    ownedLocks.delete(lockFile);
  }
}

/**
 * Safe atomic write with Windows EPERM retry and copy fallback.
 */
export function safeWriteFileSync(filePath, content) {
  let tmpFile;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
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
    return true;
  } catch {
    try {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (err) {
      try {
        process.stderr.write(`[pro-flash-orchestrator] state write failed: ${filePath}: ${err && err.message}\n`);
      } catch {
        /* ignore */
      }
      return false;
    }
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
  }
}

/* -------------------------------------------------------------- spawn pool */

function isRecentSpawn(spawn, now) {
  const age = now - Number(spawn?.ts);
  return Number.isFinite(age) && age >= 0 && age < SPAWN_TTL_MS;
}

export function markSubagentSpawn(parentConvId) {
  try {
    ensureStateDir();
    const locked = acquireLock(SPAWN_LOCK, 2000);
    if (!locked) return false;
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
      pool.spawns = pool.spawns.filter((spawn) => isRecentSpawn(spawn, now));
      pool.spawns.push({
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        parent: String(parentConvId || ''),
        ts: now,
        claimedBy: null,
      });
      pool.pendingCount = pool.spawns.filter((s) => !s.claimedBy).length;
      return safeWriteFileSync(SPAWN_FILE, JSON.stringify(pool, null, 2));
    } finally {
      if (locked) releaseLock(SPAWN_LOCK);
    }
  } catch {
    /* ignore */
  }
}

export function checkAndClaimSubagent(convId, verifiedParentId) {
  if (!convId || convId === 'unknown' || convId === 'doctor-test' || convId.startsWith('doctor-') || Boolean(process.env.PRO_TEST || process.env.ARGON_TEST)) return null;
  // A recent spawn is not identity evidence: another main session may start too.
  if (!verifiedParentId || verifiedParentId === convId) return null;
  try {
    ensureStateDir();
    const locked = acquireLock(SPAWN_LOCK, 2000);
    if (!locked) return null;
    try {
      if (!fs.existsSync(SPAWN_FILE)) return null;
      const raw = fs.readFileSync(SPAWN_FILE, 'utf8');
      const pool = JSON.parse(raw);
      if (!pool || !Array.isArray(pool.spawns)) return null;

      const now = Date.now();
      pool.spawns = pool.spawns.filter((spawn) => isRecentSpawn(spawn, now));

      // 1. check if already claimed by this convId
      const existing = pool.spawns.find((s) => s.claimedBy === convId && s.parent === verifiedParentId);
      if (existing) {
        return { isSubAgent: true, parent: existing.parent };
      }

      // Claim only a spawn belonging to the explicitly identified parent.
      const unclaimed = pool.spawns.find((s) => !s.claimedBy && s.parent === verifiedParentId);
      if (unclaimed) {
        unclaimed.claimedBy = convId;
        pool.pendingCount = pool.spawns.filter((s) => !s.claimedBy).length;
        if (!safeWriteFileSync(SPAWN_FILE, JSON.stringify(pool, null, 2))) return null;
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

// Recover a parent only after transcript/contract evidence establishes the role.
// Claim under the spawn lock so concurrent children do not reuse another child.
function recoverSubagentParent(convId) {
  if (!convId || convId === 'unknown') return '';
  try {
    ensureStateDir();
    if (!acquireLock(SPAWN_LOCK, 2000)) return '';
    try {
      const pool = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8'));
      if (!Array.isArray(pool?.spawns)) {
        if (!pool?.parent || !pool.ts) return '';
        pool.spawns = [{ parent: pool.parent, ts: pool.ts, claimedBy: null }];
      }
      const now = Date.now();
      const recent = pool.spawns.filter((spawn) => {
        return typeof spawn?.parent === 'string' && spawn.parent && spawn.parent !== convId &&
          isRecentSpawn(spawn, now);
      }).sort((a, b) => Number(b.ts) - Number(a.ts));
      const pending = recent.filter((entry) => !entry.claimedBy);
      // Timing cannot distinguish simultaneous parent sessions.
      const spawn = recent.find((entry) => entry.claimedBy === convId) ||
        (new Set(pending.map((entry) => entry.parent)).size === 1 ? pending[0] : null);
      if (!spawn) return '';
      if (!spawn.claimedBy) {
        spawn.claimedBy = convId;
        pool.spawns = recent;
        pool.pendingCount = recent.filter((entry) => !entry.claimedBy).length;
        if (!safeWriteFileSync(SPAWN_FILE, JSON.stringify(pool, null, 2))) return '';
      }
      return spawn.parent;
    } finally {
      releaseLock(SPAWN_LOCK);
    }
  } catch {
    return '';
  }
}

const MODES = new Set(['off', 'shadow', 'enforce']);
const MAX_LOG_BYTES = 1024 * 1024;

let CTX = null;
let HARNESS = 'antigravity';

/* ---------------------------------------------------------- harness adapter */

export function detectHarness(rawPayload) {
  const raw = rawPayload && typeof rawPayload === 'object' ? rawPayload : null;
  if (!raw) return 'antigravity';
  if (['codex', 'claude', 'antigravity'].includes(process.env.PRO_HARNESS)) return process.env.PRO_HARNESS;
  if (raw.hook_event_name || raw.session_id || raw.tool_name) {
    const model = String(raw.model || '');
    if (/claude|^(?:haiku|sonnet|opus)\b/i.test(model)) return 'claude';
    if (/gpt|codex|^o\d\b/i.test(model) || 'turn_id' in raw ||
        /^(?:spawn_agent|exec_command|shell)$/.test(String(raw.tool_name || ''))) {
      return 'codex';
    }
    return 'claude';
  }
  return 'antigravity';
}

export function getHarness() {
  return HARNESS;
}

export function compareSemver(a, b) {
  const parse = (val) => {
    if (typeof val !== 'string') return null;
    const match = val.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }
  return 0;
}

export function readUpdateNotice(payload = CTX, {
  currentVersion = PLUGIN_VERSION,
  checkFile = UPDATE_CHECK_FILE,
  spawnWorker = true,
  now = Date.now(),
} = {}) {
  try {
    if (process.env.PRO_NO_UPDATE_CHECK === '1') return null;
    const convId = String(payload?.conversationId || payload?.session_id || '');
    if (process.env.PRO_TEST === '1' || process.env.ARGON_TEST === '1' || /^doctor-/i.test(convId)) {
      return null;
    }
    const harness = payload?._harness || (payload && Object.keys(payload).length > 0 ? detectHarness(payload) : getHarness());
    if (harness !== 'antigravity') return null;
    if (capabilitySubagent(payload)) return null;

    let data = null;
    if (fs.existsSync(checkFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
        if (parsed && typeof parsed === 'object') data = parsed;
      } catch {
        data = null;
      }
    }

    const checkedAt = Number(data?.checkedAt || 0);
    const expired = !checkedAt || now - checkedAt > UPDATE_CHECK_TTL_MS;
    if (expired) {
      fs.mkdirSync(path.dirname(checkFile), { recursive: true });
      const stamp = {
        ...(data || {}),
        checkedAt: now,
        currentVersion,
      };
      safeWriteFileSync(checkFile, JSON.stringify(stamp, null, 2));
      const tmpRoot = path.resolve(os.tmpdir()).toLowerCase();
      const isTmpState = path.resolve(checkFile).toLowerCase().startsWith(tmpRoot);
      if (spawnWorker && process.env.PRO_UPDATE_SPAWN !== '0' && (!isTmpState || process.env.PRO_ALLOW_UPDATE_WORKER === '1')) {
        try {
          const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, 'check-update-worker.mjs')], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, PRO_STATE_DIR: path.dirname(checkFile) },
          });
          child.unref();
        } catch {
          // Never block hook execution if background worker fails to spawn.
        }
      }
    }

    if (data && typeof data.latestVersion === 'string' && compareSemver(data.latestVersion, currentVersion) > 0) {
      const latestVersion = data.latestVersion.trim().replace(/^v/i, '');
      const releaseUrl = typeof data.releaseUrl === 'string' && data.releaseUrl.trim()
        ? data.releaseUrl.trim()
        : 'https://github.com/demgkp1/pro-flash-orchestrator/releases/latest';
      const assetUrl = typeof data.assetUrl === 'string' ? data.assetUrl.trim() : '';
      return {
        currentVersion: String(currentVersion).replace(/^v/i, ''),
        latestVersion,
        releaseUrl,
        assetUrl,
        updateCommand: `node "${path.join(PLUGIN_DIR, 'scripts', 'update.mjs')}"`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const INVOCABLE_SUBAGENT_MODELS = new Set(['inherit', 'flash_lite', 'flash', 'pro']);

function validAntigravitySubagentModel(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return INVOCABLE_SUBAGENT_MODELS.has(normalized) ? normalized : '';
}

export function targetWorkerModel(harness = HARNESS, taskType = '', payload = CTX) {
  const envCandidate = (taskType === 'research' && process.env.PRO_RESEARCH_MODEL)
    ? process.env.PRO_RESEARCH_MODEL
    : (taskType === 'self' && process.env.PRO_SELF_MODEL)
      ? process.env.PRO_SELF_MODEL
      : process.env.PRO_WORKER_MODEL || '';
  if (harness === 'antigravity') {
    const validEnv = validAntigravitySubagentModel(envCandidate);
    if (validEnv) return validEnv;
    const validHydrogenEnv = process.env.PRO_HYDROGEN_ID && readCapabilities(payload).hasHydrogen === true
      ? validAntigravitySubagentModel(process.env.PRO_HYDROGEN_ID)
      : '';
    if (validHydrogenEnv) return validHydrogenEnv;
    // The host currently accepts only inherit/flash_lite/flash/pro. Hydrogen
    // main sessions must inherit to avoid silently running a Gemini 3.8 worker.
    if (modelNames(payload).some((name) => /hydrogen/i.test(name))) return 'inherit';
    return 'flash';
  }
  if (envCandidate) return envCandidate;
  if (harness === 'claude') return 'haiku';
  if (harness === 'codex') return 'gpt-5-mini';
  return 'flash';
}


/* --------------------------------------------------------- AGY capabilities */

function modelNames(payload) {
  return [payload?.modelName, payload?.model].filter((name) => typeof name === 'string' && name.trim());
}

function hasGemini4Model(payload) {
  return modelNames(payload).some((name) => /argon|carbon|hydrogen|orchestrator/i.test(name));
}

// Unlike isSubAgent(), this role check never persists identity. Capability
// readers are read-only even when called before the role guard has run.
function capabilitySubagent(payload) {
  const p = payload || {};
  if (p.parentConversationId || p.callerContext?.parentConversationId || p.is_subagent ||
      (p.agent_id && p.agent_id !== p.session_id)) return true;
  const verdict = (p._harness || detectHarness(p)) === 'antigravity' ? transcriptVerdict(p.transcriptPath) : null;
  if (verdict !== null) return verdict;
  const state = p.conversationId ? readSession(p.conversationId) : {};
  if (state.isSubAgent === true && state.subagentEvidence) return true;
  const input = String(p.lastUserInput || '');
  return /^\s*\[(?:FLASH-WORKER|PRO-CONTRACT|ARGON-CONTRACT)\]/.test(input) ||
    /\n\n\[(?:PRO-CONTRACT|ARGON-CONTRACT)\]\s+(?:汇报仅限结构化摘要|完成后仅回复四列表格|保持紧凑回报)/.test(input) ||
    (input.includes('<SYSTEM_MESSAGE>') && (input.includes('[Message]') || input.includes('sender=')));
}

function capabilityStrategy(payload, capabilities) {
  if ((payload?._harness || detectHarness(payload)) === 'antigravity' &&
      modelNames(payload).some((name) => /hydrogen/i.test(name)) &&
      !capabilitySubagent(payload)) return 'hydrogen-main';
  if ((payload?._harness || detectHarness(payload)) === 'antigravity' &&
      modelNames(payload).some((name) => /flash/i.test(name)) && !hasGemini4Model(payload) &&
      !capabilitySubagent(payload)) return 'flash-main-relaxed';
  return capabilities.hasHydrogen ? 'hydrogen-worker' : 'flash-fallback';
}

function cachedCapabilities() {
  try {
    const data = JSON.parse(fs.readFileSync(CAPABILITIES_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || typeof data.hasHydrogen !== 'boolean') return null;
    return {
      ...data,
      hasArgon: data.hasArgon === true,
      hasCarbon: data.hasCarbon === true,
      hasFlash: data.hasFlash === true,
      availableModels: Array.isArray(data.availableModels)
        ? data.availableModels.filter((name) => typeof name === 'string').slice(0, 128) : [],
    };
  } catch { return null; }
}

function inferredCapabilities(payload) {
  const names = modelNames(payload);
  return {
    detectedAt: 0,
    agyPpid: process.ppid,
    hasHydrogen: hasGemini4Model(payload),
    hasArgon: names.some((name) => /argon|orchestrator/i.test(name)),
    hasCarbon: names.some((name) => /carbon/i.test(name)),
    hasFlash: true,
    availableModels: [...new Set(names)],
    cliProbeSucceeded: false,
    source: 'payload',
  };
}

/** Cheap, read-only routing: no command, cache write, or identity update. */
export function readCapabilities(payload = CTX) {
  const cached = cachedCapabilities();
  const capabilities = cached || inferredCapabilities(payload);
  // Payload inference cannot overrule an explicit CLI denial. A failed probe
  // may be upgraded when a later session provides Gemini 4 model evidence.
  if (cached?.cliProbeSucceeded === false && hasGemini4Model(payload)) capabilities.hasHydrogen = true;
  return { ...capabilities, strategy: capabilityStrategy(payload, capabilities) };
}

function reusableCapabilities(cached, now) {
  if (!cached || !Number.isFinite(cached.detectedAt)) return false;
  const age = now - cached.detectedAt;
  return age >= 0 && (age < 60 * 60 * 1000 ||
    (cached.agyPpid === process.ppid && age < 12 * 60 * 60 * 1000));
}

function parseAvailableModels(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  let rows;
  try {
    const data = JSON.parse(clean);
    rows = Array.isArray(data) ? data : data.models || data.availableModels;
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.filter((row) => typeof row === 'string' || (row &&
      row.available !== false && row.enabled !== false && row.accessible !== false && row.entitled !== false))
      .map((row) => typeof row === 'string' ? row : row.id || row.modelId || row.name || '')
      .filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))].slice(0, 128);
  } catch {
    return [...new Set(clean.split(/\r?\n/)
      .filter((line) => !/unavailable|not available|disabled|denied|no access|无权限|不可用|未授权/i.test(line))
      .flatMap((line) => line.match(/\b[a-z0-9][a-z0-9._:/-]*\b/gi) || [])
      .filter((name) => /hydrogen|argon|carbon|orchestrator|flash/i.test(name)))].slice(0, 128);
  }
}

/** SessionStart-only probe, shared across AGY sessions with bounded caching. */
export function detectModelCapabilities(payload = CTX, force = false) {
  if ((payload?._harness || detectHarness(payload)) !== 'antigravity' || capabilitySubagent(payload)) {
    return readCapabilities(payload);
  }
  if (!force && reusableCapabilities(cachedCapabilities(), Date.now())) return readCapabilities(payload);
  ensureStateDir();
  const locked = acquireLock(CAPABILITIES_LOCK, 2500);
  if (!locked) return readCapabilities(payload);
  try {
    const cached = cachedCapabilities();
    if (!force && reusableCapabilities(cached, Date.now())) return readCapabilities(payload);
    let capabilities;
    const started = Date.now();
    const probeTimeoutMs = 5500;
    const options = { timeout: probeTimeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 256 * 1024 };
    try {
      let text;
      try {
        text = process.platform === 'win32'
          ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'agy.cmd models'], options)
          : execFileSync('agy', ['models'], options);
      }
      catch (error) {
        if (process.platform !== 'win32' || error.code === 'ETIMEDOUT' || Date.now() - started >= probeTimeoutMs) throw error;
        // Windows cannot execute a .cmd shim directly through execFileSync.
        text = execFileSync('agy', ['models'],
          { ...options, timeout: Math.max(1, probeTimeoutMs - (Date.now() - started)) });
      }
      const models = parseAvailableModels(text);
      if (models.length === 0) throw new Error('No models parsed from agy output');
      capabilities = {
        hasHydrogen: models.some((name) => /hydrogen/i.test(name)),
        hasArgon: models.some((name) => /argon|orchestrator/i.test(name)),
        hasCarbon: models.some((name) => /carbon/i.test(name)),
        hasFlash: models.some((name) => /flash/i.test(name)),
        availableModels: models, cliProbeSucceeded: true, source: 'cli',
      };
    } catch {
      // Retain a previously successful ACL result when a later CLI is missing.
      capabilities = cached && cached.cliProbeSucceeded !== false
        ? { ...cached, source: 'cli-cache' } : inferredCapabilities(payload);
    }
    const result = { ...capabilities, detectedAt: Date.now(), agyPpid: process.ppid };
    result.strategy = capabilityStrategy(payload, result);
    safeWriteFileSync(CAPABILITIES_FILE, JSON.stringify(result, null, 2));
    return result;
  } finally { releaseLock(CAPABILITIES_LOCK); }
}

/** Native Orchestrator owns dispatch and file-count policy; retain other guards. */
export function isNativeOrchestrator(payload) {
  return process.env.PRO_NATIVE_ORCHESTRATOR === '1' ||
    /orchestrator/i.test(String(payload?.modelName || '')) ||
    /orchestrator/i.test(String(payload?.model || ''));
}

function splitArgsCommand(cmd) {
  if (Array.isArray(cmd)) {
    return cmd
      .map((part) => {
        const s = String(part ?? '');
        return /\s/.test(s) ? JSON.stringify(s) : s;
      })
      .join(' ');
  }
  return String(cmd || '');
}

export function extractApplyPatchPaths(input) {
  const text = typeof input === 'string' ? input : String((input && (input.command || input.patch || input.input)) || '');
  const paths = [];
  for (const match of text.matchAll(/^\*\*\* (?:Update File:|Add File:|Delete File:|Move to:) (.+)\r?$/gm)) {
    paths.push(match[1].trim());
  }
  return [...new Set(paths)];
}

export function normalizeIncomingPayload(raw, harness = HARNESS) {
  if (!raw || typeof raw !== 'object') return {};
  if (harness !== 'claude' && harness !== 'codex') return raw;

  raw._harness = harness;
  if (raw.tool_name !== undefined && raw._rawToolName === undefined) {
    raw._rawToolName = raw.tool_name;
  }
  if (raw._rawToolInput === undefined) {
    raw._rawToolInput =
      raw.tool_input && typeof raw.tool_input === 'object' ? { ...raw.tool_input } : {};
  }

  const subId = raw.agent_id || raw.parent_tool_use_id || (raw.is_subagent ? 'sub' : '');
  if (!raw.conversationId) {
    raw.conversationId = subId
      ? `${raw.session_id || 'unknown'}:sub:${subId}`
      : raw.session_id || 'unknown';
  }
  if (subId && !raw.parentConversationId) {
    raw.parentConversationId = String(raw.session_id || 'parent');
  }
  if (!raw.workspacePaths) {
    raw.workspacePaths = raw.cwd ? [raw.cwd] : [process.cwd()];
  }
  if (raw.transcriptPath === undefined) {
    raw.transcriptPath = raw.transcript_path || '';
  }
  if (raw.modelName === undefined) {
    raw.modelName = raw.model || '';
  }
  if (raw.lastUserInput === undefined) {
    raw.lastUserInput = raw.prompt || raw.user_prompt || '';
  }
  if (!raw.lastUserInput && raw.conversationId && raw.conversationId !== 'unknown') {
    const sess = readSession(raw.session_id || raw.conversationId);
    if (sess && sess.lastUserInput) {
      raw.lastUserInput = sess.lastUserInput;
    }
  }

  if (!raw.toolCall && raw.tool_name) {
    const rawTool = String(raw.tool_name);
    const input = raw.tool_input && typeof raw.tool_input === 'object'
      ? raw.tool_input
      : rawTool === 'apply_patch' && typeof raw.tool_input === 'string' ? { input: raw.tool_input } : {};

    if (rawTool === 'Read' || rawTool === 'read_file' || rawTool === 'view_file') {
      const filePath = input.file_path || input.path || input.AbsolutePath || input.Path || input.FilePath || '';
      const args = {
        ...input,
        ...(filePath ? { AbsolutePath: filePath, Path: filePath, filePath } : {}),
      };
      if (input.offset !== undefined || input.limit !== undefined) {
        const startLine = Number(input.offset || 1);
        if (Number.isFinite(startLine)) {
          args.StartLine = startLine;
          if (input.limit !== undefined && input.limit !== null && Number(input.limit) > 0) {
            args.EndLine = startLine + Number(input.limit) - 1;
          }
        }
      }
      raw.toolCall = { name: 'read_file', args };
    } else if (
      rawTool === 'Write' ||
      rawTool === 'Edit' ||
      rawTool === 'MultiEdit' ||
      rawTool === 'apply_patch' ||
      rawTool === 'write_file' ||
      rawTool === 'edit_file'
    ) {
      const patchPaths = rawTool === 'apply_patch' ? extractApplyPatchPaths(input) : [];
      if (rawTool === 'apply_patch') raw._patchPaths = patchPaths;
      const targetPath =
        patchPaths[0] ||
        input.file_path ||
        input.path ||
        input.Path ||
        input.AbsolutePath ||
        input.TargetFile ||
        '';
      raw.toolCall = {
        name: 'write_file',
        args: {
          ...input,
          ...(targetPath ? { Path: targetPath } : {}),
        },
      };
    } else if (
      rawTool === 'Bash' ||
      rawTool === 'shell' ||
      rawTool === 'exec_command' ||
      rawTool === 'run_command'
    ) {
      const cmd = splitArgsCommand(input.command || input.cmd || input.CommandLine || input.Command || '');
      raw.toolCall = {
        name: 'run_command',
        args: { ...input, CommandLine: cmd },
      };
    } else if (
      rawTool === 'Task' ||
      rawTool === 'Agent' ||
      rawTool === 'spawn_agent' ||
      rawTool === 'invoke_subagent'
    ) {
      const subType = String(input.subagent_type || input.agent_type || input.TypeName || 'self').toLowerCase();
      const typeName =
        subType.includes('explore') || subType.includes('research') || subType.includes('plan')
          ? 'research'
          : 'self';
      const model = input.model || input.Model || 'inherit';
      const prompt = input.message !== undefined ? input.message : input.prompt !== undefined ? input.prompt : input.Prompt !== undefined ? input.Prompt : '';
      raw.toolCall = {
        name: 'invoke_subagent',
        args: {
          ...input,
          TypeName: typeName,
          Model: model,
          Prompt: String(prompt || ''),
        },
      };
    } else {
      raw.toolCall = { name: rawTool, args: { ...input } };
    }
  }

  return raw;
}

/* ------------------------------------------------------------------ input */

export function readPayload() {
  HARNESS = 'antigravity';
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    HARNESS = detectHarness(parsed);
    return normalizeIncomingPayload(parsed, HARNESS);
  } catch {
    HARNESS = 'antigravity';
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
const PARENT_SENDER_RE = /\bsender=([a-zA-Z0-9._:-]+)/;
const PARENT_MARKER_RE = /\[PRO-PARENT:([a-zA-Z0-9._:-]+)\]/;
const workerParentId = (text) => text.match(PARENT_MARKER_RE)?.[1] || text.match(PARENT_SENDER_RE)?.[1] || '';

function transcriptIdentity(rawPath) {
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
          // Preserve markers when the first SYSTEM line exceeds the 64 KB read.
          step = { source: srcMatch[1], content: lines[i] };
        }
      }

      if (step && typeof step === 'object') {
        parsedAnyStep = true;
        const source = String(step.source || '');
        if (source === 'USER_EXPLICIT' || source === 'USER_INPUT') {
          return { verdict: false, parentId: '' };
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
            return { verdict: true, parentId: workerParentId(content) };
          }
        }
      }
    }

    if (!parsedAnyStep) {
      if ((text.includes('<SYSTEM_MESSAGE>') && (text.includes('[Message]') || text.includes('sender='))) ||
          /\[(?:FLASH-WORKER|PRO-CONTRACT|ARGON-CONTRACT)\]/.test(text)) {
        return { verdict: true, parentId: workerParentId(text) };
      }
    }

    return { verdict: false, parentId: '' };
  } catch {
    return null;
  }
}

function transcriptVerdict(rawPath) {
  return transcriptIdentity(rawPath)?.verdict ?? null;
}

export function isSubAgent(payload) {
  try {
    const p = payload || {};
    const convId = String((p && p.conversationId) || '');
    const isDoctor = convId === 'doctor-test' || convId.startsWith('doctor-') || Boolean(process.env.PRO_TEST || process.env.ARGON_TEST);
    const sess = convId && convId !== 'unknown' ? readSession(convId) : {};
    const ctx = p.callerContext;
    const parent = p.parentConversationId || (ctx && typeof ctx === 'object' && ctx.parentConversationId);
    const remember = (evidence, parentId = '') => {
      const resolvedParent = parentId || sess.parentConversationId ||
        (!isDoctor && HARNESS === 'antigravity' ? recoverSubagentParent(convId) : '');
      if (sess.isSubAgent === true && sess.subagentEvidence === evidence &&
          (!resolvedParent || sess.parentConversationId === String(resolvedParent))) return;
      if (convId && convId !== 'unknown' && !isDoctor && HARNESS === 'antigravity') {
        if (parentId && !sess.subagentEvidence) checkAndClaimSubagent(convId, String(parentId));
        updateSession(convId, (state) => {
          state.isSubAgent = true;
          state.subagentEvidence = evidence;
          if (resolvedParent) state.parentConversationId = String(resolvedParent);
        });
      }
    };

    if (parent) {
      remember('parent', parent);
      return true;
    }

    const identity = HARNESS === 'antigravity' ? transcriptIdentity(p.transcriptPath) : null;
    const verdict = identity?.verdict ?? null;
    if (verdict === true) {
      remember('transcript', identity.parentId);
      return true;
    }
    if (verdict === false) {
      if (convId && convId !== 'unknown' && !isDoctor && (sess.isSubAgent !== false || sess.subagentEvidence)) {
        updateSession(convId, (s) => {
          s.isSubAgent = false;
          delete s.subagentEvidence;
          delete s.parentConversationId;
        });
      }
      return false;
    }

    // Ignore legacy cached positives: they may have come from the global spawn
    // heuristic. Newly cached roles carry their actual source of evidence.
    const input = String(p.lastUserInput || '');
    const senderParent = workerParentId(input);
    const contractInput =
      (input.includes('<SYSTEM_MESSAGE>') && (input.includes('[Message]') || input.includes('sender='))) ||
      /^\s*\[(?:FLASH-WORKER|PRO-CONTRACT|ARGON-CONTRACT)\]/.test(input) ||
      /\n\n\[(?:PRO-CONTRACT|ARGON-CONTRACT)\]\s+(?:汇报仅限结构化摘要|完成后仅回复四列表格|保持紧凑回报)/.test(input);
    if (!isDoctor && sess.isSubAgent === true && sess.subagentEvidence) {
      remember(sess.subagentEvidence, sess.parentConversationId || (contractInput ? senderParent : ''));
      return true;
    }

    // Cold-start sub-agent: system message wrapper or prefixed/appended contract marker.
    if (contractInput) {
      remember('contract', senderParent);
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

let initializedStateDir = '';

export function ensureStateDir() {
  if (initializedStateDir === STATE_DIR) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    initializedStateDir = STATE_DIR;
  } catch {
    /* read-only install: logging becomes a no-op */
  }
}

export function pruneStaleSessions() {
  try {
    ensureStateDir();
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
    /* ignore */
  }
}

/* ------------------------------------------------------------------- exemptions & path */

export const EXEMPT_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', 'vendor', '__pycache__',
  'venv', '.venv', '.tox', 'target', '.yarn', '.pnpm-store',
]);
export const EXEMPT_BASENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock',
  'changelog.md', 'license', 'license.md', 'notice',
]);
export const EXEMPT_SUFFIXES = ['.min.js', '.min.css', '.map', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'];

export function pickPath(args) {
  const keys = ['AbsolutePath', 'AbsolutePathUri', 'Path', 'FilePath', 'TargetFile', 'TargetFileUri', 'Uri', 'absolutePath'];
  for (const key of keys) {
    const value = args && args[key];
    if (value && typeof value === 'string') return value;
  }
  return '';
}

export function isExemptPath(file, payload) {
  if (!file || typeof file !== 'string') return false;
  const lower = file.toLowerCase();
  const segments = lower.split(/[\\/]+/);
  if (segments.some((segment) => EXEMPT_SEGMENTS.has(segment))) return true;
  const unified = lower.replace(/\\/g, '/');
  if (
    unified.includes('/.gemini/antigravity/') ||
    unified.includes('/.gemini/antigravity-cli/') ||
    unified.includes('/.gemini/antigravity-ide/') ||
    unified.includes('/.system_generated/')
  ) {
    return true;
  }
  try {
    const normState = path.resolve(STATE_DIR);
    const normFile = path.resolve(file);
    const rel = path.relative(normState, normFile);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (basenameOf(file) === 'mode.json') return false;
      return true;
    }
  } catch {
    /* ignore */
  }
  const rawArtifactDir = String((payload && payload.artifactDirectoryPath) || '').trim();
  if (rawArtifactDir) {
    try {
      const normArtifact = path.resolve(rawArtifactDir);
      const normFile = path.resolve(file);
      const rel = path.relative(normArtifact, normFile);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    } catch {
      /* ignore */
    }
  }
  const base = basenameOf(file);
  if (EXEMPT_BASENAMES.has(base)) return true;
  return EXEMPT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/* ------------------------------------------------------------------- logs */

/** Mask credentials/tokens in log strings */
export function maskSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, 'sk-***')
    .replace(/\b(ghp_[A-Za-z0-9]{20,})\b/g, 'ghp_***')
    .replace(/((?:password|passwd|secret|token|api_key|apiKey)\s*[:=]\s*)(["'])([^"']*)\2/gi, '$1$2***$2')
    .replace(/((?:password|passwd|secret|token|api_key|apiKey)\s*[:=]\s*)[^\s;&|'"]+/gi, '$1***');
}

/** Hooks call this once so every log line carries the conversation id. */

export function setContext(payload) {
  CTX = payload || null;
  if (payload && typeof payload === 'object') {
    HARNESS = payload._harness || detectHarness(payload);
  } else {
    HARNESS = 'antigravity';
  }
}

export function logDecision(entry) {
  if (entry && entry.action === 'pass' && entry.mode !== 'shadow' && !process.env.PRO_LOG_PASS) return;
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
      ...((process.env.PRO_TEST === '1' || process.env.ARGON_TEST === '1') ? { test: true } : {}),
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

export function translateOutput(obj) {
  if (HARNESS !== 'claude' && HARNESS !== 'codex') {
    return obj;
  }

  const out = obj && typeof obj === 'object' ? obj : {};
  const ctx = CTX && typeof CTX === 'object' ? CTX : {};
  const eventName = String(ctx.hook_event_name || '');
  const isPreToolUse =
    eventName === 'PreToolUse' ||
    out.decision === 'deny' ||
    out.decision === 'allow' ||
    Boolean(!eventName && (ctx._rawToolName || ctx.tool_name));

  if (isPreToolUse) {
    if (out.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: String(out.reason || ''),
        },
      };
    }

    if (out.decision === 'allow' && out.overwrite && typeof out.overwrite === 'object') {
      const rawInput =
        ctx._rawToolInput && typeof ctx._rawToolInput === 'object' ? ctx._rawToolInput : {};
      const rawTool = String(ctx._rawToolName || ctx.tool_name || '');
      const updatedInput = { ...rawInput };

      if (
        rawTool === 'Read' ||
        rawTool === 'read_file' ||
        rawTool === 'view_file' ||
        'file_path' in rawInput
      ) {
        const hasStart = out.overwrite.StartLine !== undefined;
        const hasEnd = out.overwrite.EndLine !== undefined;
        if (hasStart || hasEnd) {
          const start = hasStart
            ? Number(out.overwrite.StartLine)
            : Number(
                rawInput.offset ??
                  (ctx.toolCall && ctx.toolCall.args && ctx.toolCall.args.StartLine) ??
                  1
              );
          if (Number.isFinite(start)) {
            updatedInput.offset = start;
          }
          if (hasEnd) {
            const end = Number(out.overwrite.EndLine);
            if (Number.isFinite(end) && Number.isFinite(start)) {
              updatedInput.limit = Math.max(1, end - start + 1);
            }
          }
        }
      } else if (
        rawTool === 'Task' ||
        rawTool === 'Agent' ||
        rawTool === 'spawn_agent' ||
        rawTool === 'invoke_subagent'
      ) {
        if (out.overwrite.Model !== undefined) {
          updatedInput.model = out.overwrite.Model;
        }
        const nextPrompt =
          out.overwrite.Prompt !== undefined ? out.overwrite.Prompt : out.overwrite.prompt;
        if (nextPrompt !== undefined) {
          const promptField = rawTool === 'spawn_agent' && 'message' in rawInput ? 'message' : 'prompt';
          updatedInput[promptField] = nextPrompt;
        }
      } else {
        Object.assign(updatedInput, out.overwrite);
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput,
        },
      };
    }

    return {};
  }

  if (Array.isArray(out.injectSteps) && out.injectSteps.length > 0) {
    const parts = [];
    for (const step of out.injectSteps) {
      if (!step || typeof step !== 'object') continue;
      if (typeof step.ephemeralMessage === 'string' && step.ephemeralMessage.trim()) {
        parts.push(step.ephemeralMessage.trim());
      } else if (step.systemMessage && typeof step.systemMessage === 'object') {
        const sysMsg =
          typeof step.systemMessage.systemMessage === 'string' &&
          step.systemMessage.systemMessage.trim()
            ? step.systemMessage.systemMessage.trim()
            : step.systemMessage.renderInfo &&
                typeof step.systemMessage.renderInfo.markdown === 'string'
              ? step.systemMessage.renderInfo.markdown.trim()
              : '';
        if (sysMsg) parts.push(sysMsg);
      }
    }
    const text = parts.join('\n\n');
    if (text) {
      return {
        hookSpecificOutput: {
          hookEventName: eventName || 'UserPromptSubmit',
          additionalContext: text,
        },
      };
    }
  }

  return {};
}

export function output(obj) {
  try {
    process.stdout.write(JSON.stringify(translateOutput(obj)));
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

export function sessionExists(conversationId) {
  if (!conversationId) return false;
  return fs.existsSync(sessionFile(conversationId));
}

function defaultSession(extra = {}) {
  return {
    currentBatchSpawns: 0,
    lastSpawnAt: 0,
    maxReadsAllowed: 3,
    phase: 'explore',
    auditSliceQuota: 0,
    auditPendingWakeup: false,
    subagentCommands: [],
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
  // Never run a mutator against an unlocked snapshot. Callers can retry a
  // rejected update instead of silently overwriting another process's work.
  if (!locked) return null;
  try {
    let current;
    try {
      const parsed = JSON.parse(fs.readFileSync(sessionFile(convId), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      current = defaultSession(parsed);
    } catch (error) {
      // A corrupt or unreadable file must not erase another worker's claims.
      if (error.code !== 'ENOENT') return null;
      current = defaultSession();
    }
    let updated = typeof mutatorFn === 'function' ? mutatorFn(current) : current;
    if (updated === undefined) {
      updated = current;
    }
    const finalData = defaultSession(updated);
    return safeWriteFileSync(sessionFile(convId), JSON.stringify(finalData)) ? finalData : null;
  } catch {
    return null;
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
