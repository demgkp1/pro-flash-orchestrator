#!/usr/bin/env node
/**
 * Background release update checker (v0.7.0)
 *
 * Checks GitHub Releases for new plugin versions asynchronously.
 * Caches release metadata into update-check.json so SessionStart can display
 * an update banner with 0 network latency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  UPDATE_CHECK_FILE,
  PLUGIN_VERSION,
  ensureStateDir,
} from './lib.mjs';

const ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EROFS',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'HTTP_ERROR',
]);

function summarizeError(error) {
  if (error instanceof SyntaxError) return { code: 'INVALID_JSON' };
  for (const code of [error?.code, error?.cause?.code]) {
    if (ERROR_CODES.has(code)) return { code };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: 'TIMEOUT' };
  }
  return { code: 'CHECK_FAILED' };
}

// Keep both cache writes and failed diagnostic writes silent. Rename protects
// the last successful cache if the replacement cannot be persisted.
function writeCheckRecord(checkFile, record) {
  const temporary = `${checkFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(checkFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporary, checkFile);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or unavailable */ }
  }
}

function recordFailure(checkFile, lastAttemptAt, error) {
  try {
    let cached = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cached = parsed;
    } catch { /* No usable successful cache yet. */ }
    writeCheckRecord(checkFile, {
      ...cached,
      lastAttemptAt,
      lastError: summarizeError(error),
    });
  } catch {
    // Diagnostics are best-effort and must never mask the original failure.
  }
}

/**
 * Checks the latest release from GitHub API or local mock, caching the result.
 *
 * @param {object} [options]
 * @param {string} [options.apiUrl]
 * @param {string} [options.checkFile]
 * @param {string} [options.currentVersion]
 * @returns {Promise<{checkedAt: number, currentVersion: string, latestVersion: string, releaseUrl: string, assetUrl: string}>}
 */
export async function checkLatestRelease({
  apiUrl = process.env.PRO_UPDATE_API_URL || 'https://api.github.com/repos/demgkp1/pro-flash-orchestrator/releases/latest',
  checkFile = UPDATE_CHECK_FILE,
  currentVersion = PLUGIN_VERSION,
} = {}) {
  const lastAttemptAt = Date.now();
  try {
    return await checkAndCacheRelease({ apiUrl, checkFile, currentVersion });
  } catch (error) {
    recordFailure(checkFile, lastAttemptAt, error);
    throw error;
  }
}

async function checkAndCacheRelease({ apiUrl, checkFile, currentVersion }) {
  let rawJson = '';

  if (typeof apiUrl === 'string' && apiUrl.startsWith('file://')) {
    rawJson = fs.readFileSync(fileURLToPath(apiUrl), 'utf8');
  } else if (typeof apiUrl === 'string' && !/^https?:\/\//i.test(apiUrl)) {
    rawJson = fs.readFileSync(apiUrl, 'utf8');
  } else {
    try {
      rawJson = execFileSync('curl', [
        '-fsSL',
        '--max-time', '3',
        '-H', 'Accept: application/vnd.github+json',
        '-H', 'User-Agent: pro-flash-orchestrator-updater',
        apiUrl,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 3500,
      });
    } catch {
      const res = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'pro-flash-orchestrator-updater',
        },
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}: ${res.statusText}`);
        error.code = 'HTTP_ERROR';
        throw error;
      }
      rawJson = await res.text();
    }
  }

  const release = JSON.parse(rawJson);
  const rawTag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  const latestVersion = rawTag.trim().replace(/^v/i, '');
  const releaseUrl = typeof release?.html_url === 'string' && release.html_url.trim()
    ? release.html_url.trim()
    : 'https://github.com/demgkp1/pro-flash-orchestrator/releases/latest';

  let assetUrl = '';
  if (Array.isArray(release?.assets)) {
    const asset = release.assets.find((item) => {
      const name = typeof item?.name === 'string' ? item.name.toLowerCase() : '';
      return name.includes('antigravity') && name.endsWith('.zip');
    });
    if (asset && typeof asset.browser_download_url === 'string') {
      assetUrl = asset.browser_download_url.trim();
    }
  }

  ensureStateDir();
  fs.mkdirSync(path.dirname(checkFile), { recursive: true });

  const record = {
    checkedAt: Date.now(),
    currentVersion,
    latestVersion,
    releaseUrl,
    assetUrl,
  };

  writeCheckRecord(checkFile, record);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkLatestRelease();
  } catch {
    // Silently ignore all exceptions when running as background worker
  }
  process.exit(0);
}
