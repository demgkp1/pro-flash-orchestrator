#!/usr/bin/env node
/** Offline update/regression tests. All installations, state, and release fixtures are disposable. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { once } from 'node:events';

import { ROOT_DIR, runtimeEntries } from './runtime-files.mjs';
import { inspectPanelInstall, runUpdate } from './update.mjs';

// Ensure test environment flags do not suppress update notices during testing
delete process.env.PRO_TEST;
delete process.env.ARGON_TEST;
delete process.env.PRO_NO_UPDATE_CHECK;

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pfo-update-test-'));
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'test-home');
process.env.PRO_STATE_DIR = path.join(TMP, 'state');
process.env.PRO_UPDATE_SPAWN = '0';
delete process.env.PLUGIN_ROOT;
process.env.PRO_UPDATE_API_URL = pathToFileURL(path.join(TMP, 'not-the-panel-feed')).href;

const { compareSemver, readUpdateNotice } = await import('./lib.mjs');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

const NAME = 'pro-flash-orchestrator';
const API = `https://api.github.com/repos/demgkp1/${NAME}/releases/latest`;
const updateScript = path.join(ROOT_DIR, 'scripts', 'update.mjs');
const versionFile = root => path.join(root, 'plugin.json');
const updateCache = root => path.join(root, '.state', 'update-check.json');
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function fixture(root, version = '0.7.7') {
  write(versionFile(root), JSON.stringify({ name: NAME, version }));
  write(path.join(root, 'hooks.json'), '{"old":true}');
  write(path.join(root, 'scripts', 'lib.mjs'), '// original\n');
  fs.copyFileSync(updateScript, path.join(root, 'scripts', 'update.mjs'));
  return root;
}
function freshPanel(root) { return import(pathToFileURL(path.join(root, 'scripts', 'update.mjs')).href); }
function entries(version = '0.8.0', prefix = `${NAME}/`) {
  // Never import this payload. Updating the running module must not execute or
  // reload even an otherwise-valid release containing executable JS.
  return Object.entries({ 'plugin.json': JSON.stringify({ name: NAME, version }), 'hooks.json': '{"new":true}',
    'scripts/lib.mjs': '// upgraded\n', 'scripts/update.mjs': 'throw new Error("remote module executed")',
    'docs/new.txt': 'new file' }).map(([name, content], i) => ({ name: prefix + name, content, method: i % 2 ? 0 : 8 }));
}

// Small independent fixture *writer*: standard ZIP local + central records and
// EOCD, including CRCs. Works on Linux/macOS/Windows without tar/zip/Python.
function zip(entries, descriptor = false) {
  const locals = [], directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name);
    const method = entry.method ?? 8, raw = Buffer.from(entry.content ?? ''), packed = method === 8 ? deflateRawSync(raw) : raw;
    let crc = -1;
    for (const b of raw) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = entry.checksum ?? (~crc >>> 0);
    const flags = descriptor ? 0x808 : 0x800;
    const local = Buffer.alloc(30), cd = Buffer.alloc(46), tail = Buffer.alloc(descriptor ? 16 : 0);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(localName.length, 26);
    if (descriptor) {
      tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(crc, 4); tail.writeUInt32LE(packed.length, 8); tail.writeUInt32LE(raw.length, 12);
    } else {
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
    }
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(entry.attributes ?? 0x81a40000, 38); cd.writeUInt32LE(offset, 42);
    locals.push(local, localName, packed, tail); directory.push(cd, name);
    offset += local.length + localName.length + packed.length + tail.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function release(version = '0.8.0', bytes = zip(entries(version))) {
  const tag = `v${version}`, name = `${NAME}-antigravity-${tag}.zip`;
  const url = `https://github.com/demgkp1/${NAME}/releases/download/${tag}/${name}`;
  const asset = { name, browser_download_url: url, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  return { tag_name: tag, draft: false, prerelease: false, assets: [
    { ...asset, name: `${NAME}-codex-${tag}.zip`, browser_download_url: 'https://invalid.test/codex.zip' }, asset] };
}
async function withFeed(metadata, bytes, action) {
  const orig = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.redirect, 'manual'); calls.push(url);
    if (url === API) return Response.json(metadata);
    assert(bytes && url === `https://github.com/demgkp1/${NAME}/releases/download/${metadata.tag_name}/${NAME}-antigravity-${metadata.tag_name}.zip`,
      'Panel must use the exact AGY asset URL, never an env override / arbitrary host');
    return new Response(bytes);
  };
  try { return await action(calls); } finally { globalThis.fetch = orig; }
}
function snapshot(dir) {
  const rows = [];
  function walk(p) {
    const st = fs.lstatSync(p);
    rows.push([path.relative(dir, p), st.mode, st.isFile() ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null]);
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
  }
  walk(dir);
  return rows;
}
function inspectInChild(root, home, hostRoot = '') {
  const code = `import {inspectPanelInstall} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'update.mjs')).href)};
console.log(JSON.stringify(inspectPanelInstall()))`;
  return JSON.parse(cp.execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: TMP, env: { ...process.env, HOME: home, USERPROFILE: home, PLUGIN_ROOT: hostRoot }, encoding: 'utf8', windowsHide: true }));
}

try {
  // --------------------------------------------------------------------------
  // Test 1: compareSemver and readUpdateNotice
  // --------------------------------------------------------------------------
  await test('compareSemver handles patch increments, v-prefix, and decrements', () => {
    assert.equal(compareSemver('0.6.2', '0.6.1'), 1);
    assert.equal(compareSemver('v0.6.1', '0.6.1'), 0);
    assert.equal(compareSemver('0.6.0', '0.6.1'), -1);
  });

  await test('readUpdateNotice returns notice when newer version exists and filters properly', () => {
    const test1Dir = path.join(TMP, 'test1');
    fs.mkdirSync(test1Dir, { recursive: true });
    const checkFile = path.join(test1Dir, 'update-check.json');

    // 1. When latestVersion is '9.9.9'
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
      releaseUrl: 'https://github.com/demgkp1/pro-flash-orchestrator/releases/latest',
    }));

    const notice = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert(notice !== null, 'notice should be returned for 9.9.9 > 0.6.1');
    assert.equal(notice.latestVersion, '9.9.9');
    assert.equal(notice.currentVersion, '0.6.1');
    assert(typeof notice.updateCommand === 'string' && notice.updateCommand.includes('update.mjs'));

    // 2. When latestVersion is '0.6.1' (same version) -> returns null
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '0.6.1',
    }));
    const noticeSame = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeSame, null, 'notice should be null when latestVersion == currentVersion');

    // 3. When PRO_NO_UPDATE_CHECK = '1' -> returns null
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
    }));
    process.env.PRO_NO_UPDATE_CHECK = '1';
    const noticeDisabled = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeDisabled, null, 'notice should be null when PRO_NO_UPDATE_CHECK is 1');
    delete process.env.PRO_NO_UPDATE_CHECK;

    // 4. When subagent or non-antigravity harness -> returns null
    const noticeSubagent = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity', is_subagent: true },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeSubagent, null, 'subagent should receive null update notice');

    const noticeClaude = readUpdateNotice(
      { conversationId: 'u1', _harness: 'claude' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeClaude, null, 'claude harness should receive null update notice');

    const noticeCodex = readUpdateNotice(
      { conversationId: 'u1', _harness: 'codex' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeCodex, null, 'codex harness should receive null update notice');

    // 5. When cache is expired (checkedAt was 5 hours ago) -> records lastAttemptAt without faking checkedAt
    const oldCheckedAt = Date.now() - 5 * 60 * 60 * 1000;
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: oldCheckedAt,
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
    }));
    const noticeExpired = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert(noticeExpired !== null, 'notice should still be returned from expired cache data');
    const refreshedCache = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    assert.equal(refreshedCache.checkedAt, oldCheckedAt, 'checkedAt must only be updated by worker on success');
    assert(refreshedCache.lastAttemptAt > oldCheckedAt, 'lastAttemptAt must be recorded on expiration');
  });

  // --------------------------------------------------------------------------
  // Test 2: session-start.mjs writes renderInfo.markdown without polluting systemMessage
  // --------------------------------------------------------------------------
  await test('session-start.mjs writes update banner to renderInfo.markdown only', () => {
    const test2Dir = path.join(TMP, 'test2-state');
    fs.mkdirSync(test2Dir, { recursive: true });
    write(path.join(test2Dir, 'capabilities.json'), JSON.stringify({ detectedAt: Date.now(), hasHydrogen: true })); // no AGY subprocess
    const checkFile = path.join(test2Dir, 'update-check.json');
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
      releaseUrl: 'https://example.com/release',
    }));

    const sessionPayload = {
      conversationId: 'main-session-update-banner',
      modelName: 'Argon',
      transcriptPath: '',
      lastUserInput: 'start conversation',
    };

    const stdout = cp.execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'session-start.mjs')], {
      input: JSON.stringify(sessionPayload),
      encoding: 'utf8',
      cwd: ROOT_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        PRO_STATE_DIR: test2Dir,
        PRO_MODE: 'enforce',
        PRO_TEST: '',
        ARGON_TEST: '',
        PRO_NO_UPDATE_CHECK: '',
      },
    });

    const parsed = JSON.parse(stdout);
    const markdown = parsed.injectSteps?.[0]?.systemMessage?.renderInfo?.markdown || '';
    const systemMessage = parsed.injectSteps?.[0]?.systemMessage?.systemMessage || '';

    assert(markdown.includes('发现新版本 v9.9.9'), 'renderInfo.markdown must contain 发现新版本 v9.9.9');
    assert(markdown.replace(/\\/g, '/').includes('scripts/update.mjs'), 'renderInfo.markdown must reference scripts/update.mjs');
    assert(!systemMessage.includes('发现新版本'), 'systemMessage must NOT contain 发现新版本 to maintain zero model tokens');
  });

  // --------------------------------------------------------------------------
  // Transactional updater: isolated installations, fetch mocks, and genuine ZIP data.
  await test('classifies the running AGY installation, not cwd/input; workspace inside Git is supported', async () => {
    const home = path.join(TMP, 'home'), project = path.join(TMP, 'project'), custom = fixture(path.join(TMP, 'custom', NAME));
    const global = fixture(path.join(home, '.gemini', 'config', 'plugins', NAME));
    const cliGlobal = fixture(path.join(home, '.gemini', 'antigravity-cli', 'plugins', NAME));
    const workspace = fixture(path.join(project, '.agents', 'plugins', NAME));
    fs.mkdirSync(path.join(project, '.git'));
    for (const [root, kind] of [[global, 'global'], [cliGlobal, 'global'], [workspace, 'workspace'], [custom, 'custom']]) {
      assert.deepEqual(inspectInChild(root, home, root), { kind, target: root, version: '0.7.7', canUpdate: true });
    }
    assert.equal(inspectInChild(custom, home, workspace).canUpdate, false, 'host root is only a veto');
    const main = path.join(custom, 'sidecars', 'panel', 'main.mjs');
    write(main, `import {inspectPanelInstall} from '../../scripts/update.mjs'; console.log(JSON.stringify(inspectPanelInstall()));`);
    assert.equal(JSON.parse(cp.execFileSync(process.execPath, [main], { cwd: TMP, encoding: 'utf8' })).canUpdate, true);
    assert.equal((await freshPanel(workspace)).inspectPanelInstall({ target: global }).target, workspace);
    write(path.join(workspace, '.git'), 'gitdir: fake-worktree');
    assert.equal(inspectInChild(workspace, home).kind, 'git');
    const git = fixture(path.join(project, 'source', NAME)); assert.equal(inspectInChild(git, home).kind, 'git');
    for (const root of [fixture(path.join(TMP, '.codex', 'plugins', NAME)), fixture(path.join(TMP, 'wrong-name'))]) {
      assert.equal(inspectInChild(root, home, root).canUpdate, false);
    }
    write(path.join(custom, '.codex-plugin', 'plugin.json'), '{}');
    assert.equal(inspectInChild(custom, home, custom).kind, 'unsupported');
    write(versionFile(global), JSON.stringify({ name: 'unrelated', version: '0.7.7' }));
    assert.equal(inspectInChild(global, home).canUpdate, false);
    await withFeed({}, null, async calls => {
      for (const [root, error] of [[global, /manifest name/], [workspace, /Git checkout/], [custom, /Codex/]]) {
        await assert.rejects((await freshPanel(root)).updateFromPanel({ allowGit: true }), error);
      }
      assert.deepEqual(calls, []);
    });
    if (fs.existsSync(path.join(ROOT_DIR, '.git'))) assert.equal(inspectPanelInstall().canUpdate, false);
  });

  await test('symlinked installation, nested symlink and dangling link never redirect writes', async () => {
    const real = fixture(path.join(TMP, 'link-real', NAME));
    const link = path.join(TMP, 'project-link', '.agents', 'plugins', NAME);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, 'junction');
    assert.equal(inspectInChild(link, TMP, link).canUpdate, false);
    assert.equal(inspectInChild(link, TMP).canUpdate, false, 'canonicalized bare import must not trust an unrelated custom path');
    const zipPath = path.join(TMP, 'linked.zip'); write(zipPath, zip(entries()));
    await assert.rejects(runUpdate({ target: link, zipPath }), /symbolic link/i);
    const outside = path.join(TMP, 'outside'); fs.mkdirSync(outside);
    const linkDir = path.join(real, 'docs'); fs.symlinkSync(outside, linkDir, 'junction');
    const before = snapshot(real); await assert.rejects(runUpdate({ target: real, zipPath }), /symbolic link/i);
    assert.deepEqual(snapshot(real), before); assert.deepEqual(fs.readdirSync(outside), []);
    fs.rmdirSync(outside);
    await assert.rejects(runUpdate({ target: real, zipPath }), /symbolic link/i);
    assert(!fs.existsSync(outside));

    const linkedState = fixture(path.join(TMP, 'linked-state', NAME));
    const foreignState = path.join(TMP, 'foreign-state'), foreignCache = path.join(foreignState, 'update-check.json');
    write(foreignCache, 'unchanged');
    fs.symlinkSync(foreignState, path.join(linkedState, '.state'), 'junction');
    assert.equal((await runUpdate({ target: linkedState, zipPath })).updated, true);
    assert.equal(fs.readFileSync(foreignCache, 'utf8'), 'unchanged');
  });

  await test('newer or equal local version: metadata only, no locks, downloads, state or cache writes', async () => {
    const target = fixture(path.join(TMP, 'current', '.agents', 'plugins', NAME));
    const panel = await freshPanel(target), before = snapshot(TMP);
    for (const version of ['0.7.6', '0.7.7']) await withFeed(release(version), null, async calls => {
      const result = await panel.updateFromPanel({ target: '/invalid', apiUrl: 'invalid', zipPath: 'invalid', allowGit: true });
      assert.deepEqual(result, { status: 'current', version: '0.7.7', previousVersion: '0.7.7' });
      assert.deepEqual(calls, [API]);
    });
    assert.deepEqual(snapshot(TMP), before);
  });

  await test('panel uses exact AGY asset, digest and manifest; duplicate clicks share one update and preserve settings', async () => {
    const root = fixture(path.join(TMP, 'online', '.agents', 'plugins', NAME)), panel = await freshPanel(root);
    const other = fixture(path.join(TMP, 'other-install', NAME));
    write(path.join(root, '.state', 'sessions', 'keep.json'), 'live session');
    write(path.join(root, 'worker-settings.json'), 'local settings');
    write(path.join(process.env.PRO_STATE_DIR, 'worker-settings.json'), 'external settings');
    const override = path.join(process.env.PRO_STATE_DIR, 'update-check.json');
    const shared = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', NAME, 'update-check.json');
    for (const file of [updateCache(root), updateCache(other), override, shared]) write(file, '{"latestVersion":"9.0.0"}');
    const bytes = zip(entries(), true), metadata = release('0.8.0', bytes);
    await withFeed(metadata, bytes, async calls => {
      const [a, b] = await Promise.all([panel.updateFromPanel(), panel.updateFromPanel({ apiUrl: 'invalid' })]);
      assert.deepEqual(a, { status: 'updated', version: '0.8.0', previousVersion: '0.7.7' }); assert.deepEqual(a, b);
      assert.deepEqual(calls, [API, metadata.assets[1].browser_download_url]);
      assert.equal((await panel.updateFromPanel()).status, 'current'); assert.equal(calls.length, 3);
    });
    assert.equal(fs.readFileSync(path.join(root, '.state', 'sessions', 'keep.json'), 'utf8'), 'live session');
    assert.equal(fs.readFileSync(path.join(root, 'worker-settings.json'), 'utf8'), 'local settings');
    assert.equal(fs.readFileSync(path.join(process.env.PRO_STATE_DIR, 'worker-settings.json'), 'utf8'), 'external settings');
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'new.txt'), 'utf8'), 'new file');
    assert.equal(panel.inspectPanelInstall().version, '0.8.0');
    const cache = JSON.parse(fs.readFileSync(updateCache(root), 'utf8'));
    assert.equal(cache.currentVersion, '0.8.0'); assert.equal(cache.latestVersion, '0.8.0');
    assert.equal(cache.assetUrl, metadata.assets[1].browser_download_url);
    for (const file of [updateCache(other), override, shared]) assert.equal(fs.readFileSync(file, 'utf8'), '{"latestVersion":"9.0.0"}');
  });

  await test('draft/prerelease, wrong/ambiguous asset, URL, size, digest or package identity fail closed', async () => {
    const root = fixture(path.join(TMP, 'mismatch', '.agents', 'plugins', NAME)), panel = await freshPanel(root);
    const before = snapshot(root), bytes = zip(entries());
    for (const [change, error] of [
      [r => { r.draft = true; }, /stable/], [r => { r.prerelease = true; }, /stable/],
      [r => { r.tag_name = 'v0.8.0-beta.1'; }, /stable/], [r => { r.tag_name = '0.8.0'; }, /tagged/],
      [r => r.assets.pop(), /exactly one/], [r => r.assets.push(r.assets[1]), /exactly one/],
      [r => { r.assets[1].name = `${NAME}-antigravity-v9.0.0.zip`; }, /exactly one/],
      [r => { r.assets[1].browser_download_url = r.assets[0].browser_download_url; }, /asset URL/],
      [r => { r.assets[1].digest = 'sha256:' + '0'.repeat(64); }, /digest mismatch/],
      [r => { r.assets[1].digest = 'md5:123'; }, /Invalid release asset digest/],
      [r => { r.assets[1].size++; }, /size mismatch/],
    ]) {
      const metadata = release('0.8.0', bytes); change(metadata);
      await withFeed(metadata, bytes, () => assert.rejects(panel.updateFromPanel(), error));
    }
    const wrongName = entries(); wrongName[0].content = JSON.stringify({ name: 'other', version: '0.8.0' });
    const fork = entries(); fork[0].content = JSON.stringify({ name: NAME, version: '0.8.0', repository: 'https://example.invalid/fork' });
    const codex = entries(); codex.push({ name: `${NAME}/.codex-plugin/plugin.json`, content: '{}' });
    for (const [list, error] of [[entries('0.7.9'), /release tag/], [wrongName, /manifest name/],
      [fork, /official Antigravity/], [entries('0.8.0', ''), /package root/],
      [entries('0.8.0', `${NAME}-codex/plugins/${NAME}/`), /package root/], [codex, /protected/],
      [entries().filter(e => !e.name.endsWith('hooks.json')), /missing hooks/]]) {
      const bad = zip(list); await withFeed(release('0.8.0', bad), bad, () => assert.rejects(panel.updateFromPanel(), error));
    }
    assert.deepEqual(snapshot(root), before);
  });

  await test('official metadata cannot redirect and asset redirects cannot leave GitHub release storage', async () => {
    const root = fixture(path.join(TMP, 'redirect', '.agents', 'plugins', NAME));
    const panel = await freshPanel(root), before = snapshot(root), metadata = release(), orig = globalThis.fetch;
    try {
      for (const atMetadata of [true, false]) {
        const seen = [];
        globalThis.fetch = async (url, options) => {
          seen.push(url); assert.equal(options.redirect, 'manual');
          if (!atMetadata && url === API) return Response.json(metadata);
          return Response.redirect('https://example.invalid/not-a-release', 302);
        };
        await assert.rejects(panel.updateFromPanel(), atMetadata ? /Release lookup failed/ : /asset redirect/);
        assert.deepEqual(seen, atMetadata ? [API] : [API, metadata.assets[1].browser_download_url]);
      }
    } finally { globalThis.fetch = orig; }
    assert.deepEqual(snapshot(root), before);
  });

  await test('explicit ZIP supports dry-run, same-version repair and the legacy user-selected downgrade', async () => {
    const target = fixture(path.join(TMP, 'offline', NAME)), zipPath = path.join(TMP, 'offline.zip');
    const bytes = zip(entries('0.8.0', '')); write(zipPath, bytes);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    const cache = updateCache(target);
    write(cache, '{"latestVersion":"9.0.0"}');
    const unrelated = path.join(process.env.PRO_STATE_DIR, 'update-check.json');
    write(unrelated, 'different installation');
    const before = snapshot(target);
    const cli = [updateScript, '--target', target, '--zip', zipPath];
    const dry = cp.execFileSync(process.execPath, [...cli, '--dry-run'], { encoding: 'utf8' });
    assert.match(dry, /dry-run/); assert.deepEqual(snapshot(target), before);
    const result = await runUpdate({ target, zipPath }); assert.equal(result.updated, true);
    assert.equal(result.currentVersion, '0.7.7'); assert.equal(result.latestVersion, '0.8.0');
    const lib = path.join(target, 'scripts', 'lib.mjs'); write(lib, 'broken');
    const repair = cp.execFileSync(process.execPath, cli, { encoding: 'utf8' });
    assert.match(repair, /from v0\.8\.0 to v0\.8\.0/); assert.equal(fs.readFileSync(lib, 'utf8'), '// upgraded\n');
    write(zipPath, zip(entries('0.7.6')));
    write(path.join(target, '.git'), 'gitdir: placeholder');
    await assert.rejects(runUpdate({ target, zipPath }), /Refusing to overwrite a Git checkout/);
    const after = snapshot(target);
    assert.equal((await runUpdate({ target, zipPath, allowGit: true, dryRun: true })).updated, true);
    assert.deepEqual(snapshot(target), after);
    assert.equal((await runUpdate({ target, zipPath, allowGit: true })).latestVersion, '0.7.6');
    assert.equal(JSON.parse(fs.readFileSync(versionFile(target), 'utf8')).version, '0.7.6');
    const refreshed = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(refreshed.currentVersion, '0.7.6'); assert.equal(refreshed.latestVersion, '0.7.6'); assert.equal(refreshed.assetUrl, '');
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'different installation');
  });

  await test('custom CLI feeds accept legacy tags, first matching asset and partial packages but still enforce ZIP safety', async () => {
    const target = fixture(path.join(TMP, 'legacy-feed', NAME));
    const apiFile = path.join(TMP, 'legacy-release.json'), apiUrl = pathToFileURL(apiFile).href;
    const zipPath = path.join(TMP, 'legacy.zip');
    const fork = 'https://example.invalid/fork';
    const partial = [
      { name: `${NAME}/plugin.json`, content: JSON.stringify({ name: NAME, version: ' V0.8.0-preview ', repository: fork }) },
      { name: `${NAME}/scripts/lib.mjs`, content: '// partial' },
      { name: 'README-mirror.txt', content: 'outside the package root; not installed' },
    ];
    const feed = { tag_name: ' V0.8.2-preview ', html_url: ` ${fork}/releases `, assets: [
      { name: 'codex.zip', browser_download_url: 'unused' },
      { name: 'Mirror-ANTIGRAVITY-portable.ZIP', browser_download_url: ` ${pathToFileURL(zipPath).href} ` },
      { ...release().assets[1], browser_download_url: 'unused' },
    ] };
    write(zipPath, zip(partial)); write(apiFile, JSON.stringify(feed));
    write(updateCache(target), '{}');
    const before = snapshot(target);
    const cli = [updateScript, '--target', target];
    const help = cp.execFileSync(process.execPath, [...cli, '--help'], { encoding: 'utf8' });
    for (const flag of ['--target', '--zip', '--dry-run', '--allow-git', '--api-url']) assert(help.includes(flag));
    const unknown = cp.spawnSync(process.execPath, [...cli, '--unknown'], { encoding: 'utf8' });
    assert.equal(unknown.status, 1); assert.match(unknown.stderr, /Unknown argument/);
    const dry = cp.execFileSync(process.execPath, [...cli, '--api-url', apiUrl, '--dry-run'], { encoding: 'utf8' });
    assert.match(dry, /to v0\.8\.0-preview/); assert.deepEqual(snapshot(target), before);
    delete feed.tag_name; feed.assets[1].browser_download_url = zipPath;
    write(apiFile, JSON.stringify(feed));
    const installed = cp.execFileSync(process.execPath, cli, { encoding: 'utf8', env: { ...process.env, PRO_UPDATE_API_URL: apiUrl } });
    assert.match(installed, /to v0\.8\.0-preview/);
    assert(!fs.existsSync(path.join(target, 'README-mirror.txt')));
    assert.equal(fs.readFileSync(path.join(target, 'hooks.json'), 'utf8'), '{"old":true}');
    const { currentVersion, latestVersion, releaseUrl, assetUrl } = JSON.parse(fs.readFileSync(updateCache(target), 'utf8'));
    assert.deepEqual([currentVersion, latestVersion, releaseUrl, assetUrl], ['0.8.0-preview', '0.8.0-preview', `${fork}/releases`, zipPath]);
    assert.equal((await runUpdate({ target, apiUrl, dryRun: true })).currentVersion, 'V0.8.0-preview');

    const after = snapshot(target);
    feed.tag_name = 'v0.7.0'; write(apiFile, JSON.stringify(feed));
    fs.unlinkSync(zipPath);
    assert.equal((await runUpdate({ target, apiUrl })).updated, false, 'older custom tag skips the ZIP download');
    delete feed.tag_name; write(apiFile, JSON.stringify(feed));
    for (const [bad, error] of [
      [[partial[0]], /missing scripts\/lib.mjs/],
      [[...partial, { name: '../escape' }], /protected ZIP entry/],
    ]) {
      write(zipPath, zip(bad));
      await assert.rejects(runUpdate({ target, apiUrl }), error);
    }
    assert.deepEqual(snapshot(target), after);
  });

  await test('rejects unsafe ZIP names/types, local-central disagreement, aliasing, corruption and non-ZIP data before touching target', async () => {
    const target = fixture(path.join(TMP, 'bad-zip', NAME)), before = snapshot(target), zipPath = path.join(TMP, 'bad.zip');
    for (const entry of [
      { name: '../outside' }, { name: `${NAME}/../escape` }, { name: '/outside' }, { name: 'C:/outside' },
      { name: `${NAME}/scripts\\escape` }, { name: `${NAME}/.state/id` }, { name: `${NAME}/worker-settings.json` },
      { name: `${NAME}/x:ads` }, { name: `${NAME}/CON.txt` }, { name: `${NAME}/PLUGin.json` },
      { name: `${NAME}/scripts` }, { name: `${NAME}/lib`, attributes: 0xa1ff0000 },
      { name: `${NAME}/docs/ok`, localName: `${NAME}/../evil` }, { name: `${NAME}/bad.txt`, checksum: 23 },
    ]) {
      write(zipPath, zip([...entries(), entry])); await assert.rejects(runUpdate({ target, zipPath }));
    }
    write(zipPath, Buffer.alloc(1024)); await assert.rejects(runUpdate({ target, zipPath }), /ZIP/);
    assert.deepEqual(snapshot(target), before); assert(!fs.existsSync(path.join(TMP, 'outside')));
  });

  await test('late commit failure restores every overwritten file and removes newly created paths', async () => {
    const target = fixture(path.join(TMP, 'rollback', NAME)), zipPath = path.join(TMP, 'rollback.zip');
    write(path.join(target, '.state', 'mode.json'), 'keep'); write(zipPath, zip(entries()));
    write(updateCache(target), '{"latestVersion":"9.0.0"}');
    const before = snapshot(path.dirname(target)), realRename = fs.renameSync;
    let committedBeforeFailure = 0;
    fs.renameSync = function (from, to) {
      if (to === versionFile(target) && path.basename(from).startsWith('new-')) {
        throw Object.assign(new Error('injected late commit failure'), { code: 'EACCES' });
      }
      if (path.basename(from).startsWith('new-')) committedBeforeFailure++;
      return realRename.call(this, from, to);
    };
    try { await assert.rejects(runUpdate({ target, zipPath }), /injected late commit failure/); }
    finally { fs.renameSync = realRename; }
    assert(committedBeforeFailure >= 3); assert.deepEqual(snapshot(path.dirname(target)), before);
    assert.equal((await runUpdate({ target, zipPath })).updated, true, 'lock released after rollback');
  });

  await test('two processes serialize at commit, re-read the installed version and release the shared lock', async () => {
    const target = fixture(path.join(TMP, 'concurrent', NAME)), zipPath = path.join(TMP, 'concurrent.zip'); write(zipPath, zip(entries()));
    const apiUrl = path.join(TMP, 'concurrent.json');
    write(apiUrl, JSON.stringify({ tag_name: 'v0.8.0', assets: [{ name: 'antigravity.zip', browser_download_url: zipPath }] }));
    const code = `import {runUpdate} from ${JSON.stringify(pathToFileURL(updateScript).href)};
      const gate = new Promise(r=>process.once('message',r)); process.send('ready'); await gate;
      process.send(await runUpdate(${JSON.stringify({ target, apiUrl })})); process.disconnect();`;
    const children = Array.from({ length: 2 }, () => cp.spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true }));
    const exits = children.map(c => once(c, 'exit'));
    try {
      const ready = await Promise.all(children.map(c => once(c, 'message'))); assert(ready.every(([msg]) => msg === 'ready'));
      const results = children.map(c => once(c, 'message')); children.forEach(c => c.send('go'));
      const reports = (await Promise.all(results)).map(([r]) => r); assert.deepEqual(reports.map(r => r.updated).sort(), [false, true]);
      assert.equal(reports.find(r => !r.updated).currentVersion, '0.8.0');
      assert((await Promise.all(exits)).every(([code]) => code === 0));
      assert.deepEqual(fs.readdirSync(path.dirname(target)), [NAME]);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  });

  // --------------------------------------------------------------------------
  // Test 4: runtime-files.json whitelist validation
  // --------------------------------------------------------------------------
  await test('runtime-files.json includes check-update-worker and update in Antigravity only', () => {
    const agyEntries = runtimeEntries({ platform: 'antigravity' }).map((e) => e.to);
    assert(agyEntries.includes('scripts/check-update-worker.mjs'), 'Antigravity runtime must contain scripts/check-update-worker.mjs');
    assert(agyEntries.includes('scripts/update.mjs'), 'Antigravity runtime must contain scripts/update.mjs');
    assert(agyEntries.includes('sidecars/panel/main.mjs'), 'AGY panel must be packaged alongside its updater');

    const codexEntries = runtimeEntries({ platform: 'codex' }).map((e) => e.to);
    assert(!codexEntries.includes('scripts/check-update-worker.mjs'), 'Codex runtime must not contain scripts/check-update-worker.mjs');
    assert(!codexEntries.includes('scripts/update.mjs'), 'Codex runtime must not contain scripts/update.mjs');
    assert.equal(codexEntries.length, 16, 'Codex runtime entries count must remain 16');
  });

  // --------------------------------------------------------------------------
  // Test 5: subagent thrashing circuit breaker blocks 3rd consecutive identical command and resets on different command
  // --------------------------------------------------------------------------
  await test('subagent thrashing circuit breaker blocks 3rd consecutive identical command and resets on different command', () => {
    const test6Dir = path.join(TMP, 'test6-thrash-state');
    fs.mkdirSync(test6Dir, { recursive: true });

    const invokeGuardCommand = (cmd) => {
      const payload = {
        is_subagent: true,
        conversationId: 'sub-thrash-1',
        tool_name: 'run_command',
        tool_input: { CommandLine: cmd },
      };
      const env = {
        ...process.env,
        PRO_STATE_DIR: test6Dir,
        PRO_MODE: 'enforce',
      };
      delete env.PRO_TEST;
      delete env.ARGON_TEST;

      const stdout = cp.execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'guard-command.mjs')], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: ROOT_DIR,
        windowsHide: true,
        env,
      });

      const parsed = JSON.parse(stdout);
      return {
        permissionDecision: parsed.hookSpecificOutput?.permissionDecision || parsed.decision,
        permissionDecisionReason: parsed.hookSpecificOutput?.permissionDecisionReason || parsed.reason || '',
        raw: parsed,
      };
    };

    // 1st invocation of test-foo: allowed
    const call1 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert(call1.permissionDecision !== 'deny', '1st invocation of test-foo must be allowed');

    // 2nd invocation of test-foo: allowed (retry after 1st failure)
    const call2 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert(call2.permissionDecision !== 'deny', '2nd invocation of test-foo must be allowed');

    // 3rd consecutive invocation of identical test-foo: physically denied
    const call3 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert.equal(call3.permissionDecision, 'deny', '3rd consecutive invocation of test-foo must be denied');
    assert(call3.permissionDecisionReason.includes('【死循环熔断拦截】'), 'denial reason must contain 【死循环熔断拦截】');

    // Different command: allowed and resets consecutive counter
    const call4 = invokeGuardCommand('node scripts/test-bar.mjs');
    assert(call4.permissionDecision !== 'deny', 'invocation of different command test-bar must be allowed');

    // Verification of counter reset: test-foo is allowed again
    const call5 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert(call5.permissionDecision !== 'deny', 'test-foo must be allowed after reset by different command');

    // Verify decisions.jsonl records rule: 'thrash-circuit-breaker' without duplicate/dirty deny rows
    const decisionsPath = path.join(test6Dir, 'decisions.jsonl');
    assert(fs.existsSync(decisionsPath), 'decisions.jsonl must exist');
    const decisions = fs.readFileSync(decisionsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const thrashRecords = decisions.filter((d) => d.rule === 'thrash-circuit-breaker');
    assert.equal(thrashRecords.length, 1, 'thrash circuit breaker must emit exactly one thrash-circuit-breaker record');
    const thrashRecord = thrashRecords[0];
    assert.equal(typeof thrashRecord.rule, 'string', 'thrash record rule must be a string');
    assert.equal(thrashRecord.rule, 'thrash-circuit-breaker');
    assert.equal(thrashRecord.action, 'deny');

    const denyRecords = decisions.filter((d) => d.action === 'deny');
    assert.equal(denyRecords.length, 1, 'thrash circuit breaker must produce only one deny record');
    for (const row of decisions) {
      if (row.action === 'deny' || 'rule' in row) {
        assert.equal(typeof row.rule, 'string', 'decision record rule must be a string, not an object');
      }
    }

    // Verify report.mjs output contains (死循环熔断)
    const reportEnv = {
      ...process.env,
      PRO_STATE_DIR: test6Dir,
    };
    delete reportEnv.PRO_TEST;
    delete reportEnv.ARGON_TEST;

    const reportStdout = cp.execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'report.mjs')], {
      encoding: 'utf8',
      cwd: ROOT_DIR,
      windowsHide: true,
      env: reportEnv,
    });
    assert(reportStdout.includes('(死循环熔断)'), 'report.mjs output must contain (死循环熔断) tag');
  });
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // cleanup
  }
}

console.log(`\nUpdate test results: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
