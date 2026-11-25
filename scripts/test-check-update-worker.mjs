#!/usr/bin/env node
/** Offline worker diagnostics tests; all state and fixtures stay in a temp dir. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-check-worker-test-'));
const previousStateDir = process.env.PRO_STATE_DIR;
process.env.PRO_STATE_DIR = path.join(temporaryRoot, 'default-state');
const { checkLatestRelease } = await import('./check-update-worker.mjs');
const workerPath = fileURLToPath(new URL('./check-update-worker.mjs', import.meta.url));
const secret = 'synthetic-worker-secret-DO-NOT-PERSIST';
const release = {
  tag_name: 'v0.7.3',
  html_url: 'https://example.invalid/releases/v0.7.3',
  assets: [{
    name: 'pro-flash-orchestrator-antigravity-v0.7.3.zip',
    browser_download_url: 'https://example.invalid/release.zip',
  }],
};
const successfulCache = {
  checkedAt: 1700000000000,
  currentVersion: '0.7.2',
  latestVersion: '0.7.3',
  releaseUrl: release.html_url,
  assetUrl: release.assets[0].browser_download_url,
  retainedMetadata: { keep: true },
};

function fixture(name) {
  const dir = path.join(temporaryRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, checkFile: path.join(dir, 'update-check.json'), apiFile: path.join(dir, 'release.json') };
}

function seedCache(checkFile, extra = {}) {
  fs.writeFileSync(checkFile, JSON.stringify({ ...successfulCache, ...extra }));
}

function readCache(checkFile) {
  return JSON.parse(fs.readFileSync(checkFile, 'utf8'));
}

function assertPreserved(record) {
  for (const [key, value] of Object.entries(successfulCache)) assert.deepEqual(record[key], value);
}

async function withNetworkFailure(error, action) {
  const curl = mock.method(childProcess, 'execFileSync', () => {
    throw new Error(`curl failed: https://user:${secret}@example.invalid/?token=${secret}`);
  });
  const fetch = mock.method(globalThis, 'fetch', async () => { throw error; });
  syncBuiltinESMExports();
  try {
    await action(`https://user:${secret}@example.invalid/releases?token=${secret}`);
    assert.equal(curl.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    curl.mock.restore();
    fetch.mock.restore();
    syncBuiltinESMExports();
  }
}

function runCli(stateDir, apiFile) {
  const result = childProcess.spawnSync(process.execPath, [workerPath], {
    env: { ...process.env, PRO_STATE_DIR: stateDir, PRO_UPDATE_API_URL: apiFile },
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

try {
  await test('successful local check persists release metadata', async () => {
    const { checkFile, apiFile } = fixture('success');
    fs.writeFileSync(apiFile, JSON.stringify(release));
    const before = Date.now();
    const result = await checkLatestRelease({ apiUrl: apiFile, checkFile, currentVersion: '0.7.2' });
    assert.deepEqual(readCache(checkFile), result);
    assert(result.checkedAt >= before && result.checkedAt <= Date.now());
    assert.equal(result.latestVersion, '0.7.3');
    assert.equal(result.assetUrl, release.assets[0].browser_download_url);
    assert.equal(Object.hasOwn(result, 'lastError'), false);
    assert.equal(Object.hasOwn(result, 'lastAttemptAt'), false);
  });

  await test('failed read preserves successful cache and refreshes retry timestamp', async () => {
    const { checkFile, apiFile } = fixture('missing-release');
    seedCache(checkFile, { lastAttemptAt: 1 });
    const before = Date.now();
    await assert.rejects(checkLatestRelease({ apiUrl: apiFile, checkFile }), { code: 'ENOENT' });
    const record = readCache(checkFile);
    assertPreserved(record);
    assert(record.lastAttemptAt >= before && record.lastAttemptAt <= Date.now());
    assert(record.lastAttemptAt > 1);
    assert.deepEqual(record.lastError, { code: 'ENOENT' });
  });

  await test('invalid release JSON records only a bounded code without secret snippets', async () => {
    const { checkFile, apiFile } = fixture('invalid-json');
    seedCache(checkFile);
    fs.writeFileSync(apiFile, `{"token":"${secret}",`);
    await assert.rejects(checkLatestRelease({ apiUrl: apiFile, checkFile }), SyntaxError);
    const record = readCache(checkFile);
    assertPreserved(record);
    assert.deepEqual(record.lastError, { code: 'INVALID_JSON' });
    assert.equal(fs.readFileSync(checkFile, 'utf8').includes(secret), false);
  });

  await test('offline network failure rejects the original error and records its safe cause code', async () => {
    const { checkFile } = fixture('network-failure');
    seedCache(checkFile);
    const error = new TypeError(`fetch failed with token=${secret}`, {
      cause: Object.assign(new Error(`credentials=${secret}`), { code: 'ECONNREFUSED' }),
    });
    await withNetworkFailure(error, async (apiUrl) => {
      await assert.rejects(checkLatestRelease({ apiUrl, checkFile }), (caught) => caught === error);
    });
    const record = readCache(checkFile);
    assertPreserved(record);
    assert.deepEqual(record.lastError, { code: 'ECONNREFUSED' });
    assert.equal(fs.readFileSync(checkFile, 'utf8').includes(secret), false);
    assert(JSON.stringify(record.lastError).length < 80);
  });

  await test('untrusted error codes and messages never enter diagnostic state', async () => {
    const { checkFile } = fixture('untrusted-code');
    const error = Object.assign(new Error(`credentials=${secret}`), { code: secret });
    await withNetworkFailure(error, async (apiUrl) => {
      await assert.rejects(checkLatestRelease({ apiUrl, checkFile }), (caught) => caught === error);
    });
    const record = readCache(checkFile);
    assert.deepEqual(record.lastError, { code: 'CHECK_FAILED' });
    assert.equal(fs.readFileSync(checkFile, 'utf8').includes(secret), false);
    assert.equal(Object.hasOwn(record, 'checkedAt'), false);
  });

  await test('successful recovery clears prior failure fields', async () => {
    const { checkFile, apiFile } = fixture('recovery');
    seedCache(checkFile);
    fs.writeFileSync(apiFile, '{invalid');
    await assert.rejects(checkLatestRelease({ apiUrl: apiFile, checkFile }), SyntaxError);
    assert.equal(readCache(checkFile).lastError.code, 'INVALID_JSON');
    fs.writeFileSync(apiFile, JSON.stringify(release));
    await checkLatestRelease({ apiUrl: apiFile, checkFile, currentVersion: '0.7.3' });
    const record = readCache(checkFile);
    assert.equal(record.currentVersion, '0.7.3');
    assert(record.checkedAt > successfulCache.checkedAt);
    assert.equal(Object.hasOwn(record, 'lastError'), false);
    assert.equal(Object.hasOwn(record, 'lastAttemptAt'), false);
  });

  await test('background CLI stays silent while persisting a sanitized failure', () => {
    const { dir, checkFile, apiFile } = fixture('cli-failure');
    seedCache(checkFile);
    fs.writeFileSync(apiFile, `{"credentials":"${secret}",`);
    runCli(dir, apiFile);
    const record = readCache(checkFile);
    assertPreserved(record);
    assert.deepEqual(record.lastError, { code: 'INVALID_JSON' });
    assert(record.lastAttemptAt > successfulCache.checkedAt);
    assert.equal(fs.readFileSync(checkFile, 'utf8').includes(secret), false);
  });

  await test('diagnostic persistence failure does not mask the original check error', async () => {
    const { checkFile, apiFile } = fixture('blocked-diagnostics');
    fs.mkdirSync(checkFile);
    const sentinel = path.join(checkFile, 'keep.txt');
    fs.writeFileSync(sentinel, 'keep');
    await assert.rejects(checkLatestRelease({ apiUrl: apiFile, checkFile }), { code: 'ENOENT' });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    assert.equal(fs.readdirSync(path.dirname(checkFile)).some((name) => name.endsWith('.tmp')), false);
  });

  await test('background CLI stays silent when state cannot be written', () => {
    const { dir, apiFile } = fixture('cli-blocked-state');
    fs.writeFileSync(apiFile, JSON.stringify(release));
    const stateFile = path.join(dir, 'state-file');
    fs.writeFileSync(stateFile, 'keep');
    runCli(stateFile, apiFile);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), 'keep');
  });
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (previousStateDir === undefined) delete process.env.PRO_STATE_DIR;
  else process.env.PRO_STATE_DIR = previousStateDir;
  const resolvedRoot = path.resolve(temporaryRoot);
  if (path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedRoot).startsWith('pfo-check-worker-test-')) {
    throw new Error('Refusing to clean an unexpected test directory');
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
