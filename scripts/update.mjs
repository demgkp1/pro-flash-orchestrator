#!/usr/bin/env node
/** AGY runtime updater. Only the explicit CLI/API accepts paths or alternate release feeds. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const NAME = 'pro-flash-orchestrator';
const REPO = `https://github.com/demgkp1/${NAME}`;
const LATEST_API = `https://api.github.com/repos/demgkp1/${NAME}/releases/latest`;
const SELF = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.dirname(path.dirname(SELF));
const MAX_ZIP = 16 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_EXPANDED = 48 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;
const AGY_FILES = ['plugin.json', 'hooks.json', 'scripts/lib.mjs', 'scripts/update.mjs'];
const CODEX_MARKERS = ['.codex-plugin', 'scripts/codex-hook.mjs', 'hooks/codex-hooks.json', 'hooks/hooks.json'];
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const assetName = tag => `${NAME}-antigravity-${tag}.zip`;
const lstat = file => fs.lstatSync(file, { throwIfNoEntry: false });
const samePath = (a, b) => path.relative(a, b) === '';
const trimmed = value => typeof value === 'string' ? value.trim() : '';
const legacyVersion = value => trimmed(value).replace(/^v/i, '');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// lstat, not existsSync: even a dangling symlink or Windows junction must veto a write.
function safePath(absolute) {
  const root = path.parse(absolute).root;
  let current = root;
  let stat = lstat(root);
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    check(!stat || stat.isDirectory(), `Not a directory: ${current}`);
    current = path.join(current, part);
    stat = lstat(current);
    check(!stat?.isSymbolicLink(), `Refusing a symbolic link: ${current}`);
    if (!stat) break;
  }
  return stat;
}

function stableVersion(value) {
  check(typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) &&
    value.split('.').every(n => Number.isSafeInteger(Number(n))), 'Invalid stable release version');
  return value;
}

function newer(version, installed, legacyFeed = false) {
  const parts = value => (legacyFeed ? legacyVersion(value).match(/^\d+\.\d+\.\d+/)?.[0] : value)?.split('.').map(Number);
  const a = parts(version), b = parts(installed);
  if (!a || !b) return false; // Legacy online comparison treats unparseable versions as equal.
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function manifestVersion(bytes, legacyFeed = false) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  check(manifest?.name === NAME, 'Plugin manifest name does not match this installation');
  check((legacyFeed || manifest.repository === undefined || manifest.repository === REPO) &&
    !manifest.keywords?.includes('codex'), 'Not the official Antigravity plugin manifest');
  if (!legacyFeed) return stableVersion(manifest.version);
  const version = trimmed(manifest.version);
  check(version, 'Missing version in plugin.json');
  return version;
}

function readLocal(file, limit) {
  const stat = fs.statSync(file);
  check(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Missing, empty or oversized release file');
  const bytes = fs.readFileSync(file);
  check(bytes.length <= limit, 'Oversized release file');
  return bytes;
}

function installKind(target) {
  const gemini = path.join(os.homedir(), '.gemini');
  if (['config', 'antigravity-cli'].some(dir => samePath(target, path.join(gemini, dir, 'plugins', NAME)))) return 'global';
  const plugins = path.dirname(target);
  return path.basename(plugins) === 'plugins' && path.basename(path.dirname(plugins)) === '.agents'
    ? 'workspace' : 'custom';
}

function gitCheckout(target) {
  // A workspace install may live *inside* a user's project checkout. Its own
  // .git (including a worktree pointer), or a checkout inside .agents, is not exempt.
  const boundary = installKind(target) === 'workspace' ? path.dirname(path.dirname(path.dirname(target))) : null;
  for (let dir = target; dir !== boundary; dir = path.dirname(dir)) {
    if (lstat(path.join(dir, '.git'))) return true;
    if (dir === path.dirname(dir)) break;
  }
  return false;
}

function checkPlatform(target) {
  const segments = target.toLowerCase().split(path.sep);
  check(!segments.some(s => ['.codex', '.codex-plugin', `${NAME}-codex`].includes(s)) &&
    !CODEX_MARKERS.some(file => safePath(path.join(target, file))), 'Codex installations cannot use the AGY updater');
}

function inspectLaunchPath() {
  // Node normally realpaths ESM imports. The host's *lexical* entry point/root
  // can veto a linked installation, but neither may select a different target.
  safePath(SELF);
  const main = process.argv[1];
  const panelEntry = path.join('sidecars', 'panel', 'main.mjs');
  const fromPanel = main && path.isAbsolute(main) && path.relative(PLUGIN_DIR, main) === panelEntry;
  if (main && path.isAbsolute(main) && main.endsWith(path.sep + panelEntry)) {
    safePath(main);
    check(fromPanel, 'Sidecar and updater belong to different installations');
  } else if (main && path.isAbsolute(main) && fs.existsSync(main) && samePath(fs.realpathSync(main), SELF)) {
    safePath(main);
  }
  const hostRoot = process.env.PLUGIN_ROOT;
  if (hostRoot) {
    check(path.isAbsolute(hostRoot) && samePath(hostRoot, PLUGIN_DIR),
      'Host plugin root does not match the running installation (possibly a symbolic link)');
    safePath(hostRoot);
  }
  return Boolean(hostRoot || fromPanel);
}

export function inspectPanelInstall() {
  const result = { kind: 'unsupported', target: PLUGIN_DIR, version: '', canUpdate: false };
  try {
    const verifiedLaunch = inspectLaunchPath();
    const manifest = path.join(PLUGIN_DIR, 'plugin.json');
    check(safePath(manifest)?.isFile(), 'Missing plugin.json');
    result.version = manifestVersion(readLocal(manifest, MAX_METADATA));
    if (gitCheckout(PLUGIN_DIR)) return { ...result, kind: 'git', reason: 'Git checkout: update it with Git instead.' };
    checkPlatform(PLUGIN_DIR);
    check(path.basename(PLUGIN_DIR) === NAME && samePath(SELF, path.join(PLUGIN_DIR, 'scripts', 'update.mjs')),
      'Installation directory or updater path does not match the plugin');
    for (const rel of AGY_FILES) check(safePath(path.join(PLUGIN_DIR, rel))?.isFile(), `Incomplete AGY installation: ${rel}`);
    const kind = installKind(PLUGIN_DIR);
    // A bare import via a symlink has already lost its original spelling in
    // Node. Do not let it silently turn a global/workspace link into a custom target.
    if (kind === 'custom' && !verifiedLaunch) return { ...result, kind, reason:
      'Custom AGY install requires a matching host root or running panel entry point.' };
    return { ...result, kind, canUpdate: true };
  } catch (error) {
    return { ...result, reason: error.message };
  }
}

function installedVersion(target, panel, allowGit, legacyFeed) {
  if (panel) {
    const info = inspectPanelInstall();
    check(info.canUpdate, info.reason);
    return info.version;
  }
  const dir = safePath(target);
  check(target !== path.parse(target).root && (!dir || dir.isDirectory()), 'Invalid plugin installation directory');
  check(allowGit || !gitCheckout(target), 'Refusing to overwrite a Git checkout; use git pull');
  checkPlatform(target);
  const file = path.join(target, 'plugin.json');
  const stat = safePath(file);
  if (stat) {
    check(stat.isFile(), 'Invalid target manifest');
    return manifestVersion(readLocal(file, MAX_METADATA), legacyFeed);
  }
  check(!dir || !fs.readdirSync(target).length, 'Not an empty directory or a matching plugin installation');
  return '0.0.0'; // Explicit CLI --target can bootstrap an empty directory.
}

async function fetchBytes(url, { metadata = false, official = true } = {}) {
  const limit = metadata ? MAX_METADATA : MAX_ZIP;
  if (!official && !/^https?:\/\//i.test(url)) {
    return readLocal(url.startsWith('file:') ? fileURLToPath(url) : url, limit);
  }
  const signal = AbortSignal.timeout(metadata ? 10000 : 30000);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { signal, redirect: official ? 'manual' : 'follow',
      headers: { 'User-Agent': NAME, Accept: metadata ? 'application/vnd.github+json' : 'application/octet-stream' } });
    if (official && !metadata && [301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel();
      const next = new URL(res.headers.get('location') || '', url);
      check(next.protocol === 'https:' && !next.username && !next.password && !next.port &&
        ASSET_HOSTS.has(next.hostname), 'Unexpected release asset redirect');
      url = next.href;
      continue;
    }
    if (!res.ok || !res.body || Number(res.headers.get('content-length')) > limit) {
      await res.body?.cancel();
      throw new Error(`Release ${metadata ? 'lookup' : 'download'} failed (HTTP ${res.status}, missing or oversized body)`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      check(size <= limit, 'Release response exceeds the size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error('Too many release asset redirects');
}

function releaseVersion(release) {
  check(release && !release.draft && !release.prerelease && typeof release.tag_name === 'string' &&
    release.tag_name.startsWith('v'), 'Expected a tagged, stable (non-draft) release');
  return stableVersion(release.tag_name.slice(1));
}

async function downloadAgy(release) {
  const tag = release.tag_name, name = assetName(tag);
  const matches = Array.isArray(release.assets) ? release.assets.filter(a => a?.name === name) : [];
  check(matches.length === 1, `Expected exactly one release asset named ${name}`);
  const [asset] = matches;
  const url = asset.browser_download_url;
  check(url === `${REPO}/releases/download/${tag}/${name}`,
    'Release asset URL does not match the official repository, tag and filename');
  if (asset.size != null) check(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_ZIP, 'Invalid release asset size');
  if (asset.digest != null) check(typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest), 'Invalid release asset digest');
  const bytes = await fetchBytes(url);
  check(asset.size == null || asset.size === bytes.length, 'Release asset size mismatch');
  check(asset.digest == null || asset.digest.toLowerCase() === `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    'Release asset SHA-256 digest mismatch');
  return { bytes, assetUrl: url };
}

// Read only the small ZIP32 subset used by release tooling (Store / Deflate).
// Never pass archive names, links, permissions or extraction commands to the OS.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

const forbiddenParts = new Set(['.git', '.state', '.maintenance', '.codex', '.codex-plugin', '.claude-plugin',
  '.agents', '.gemini', '.github', 'node_modules', 'plugin_data', 'worker-settings.json', 'settings.json', 'config.json']);
function zipName(raw, directory) {
  const name = directory ? raw.slice(0, -1) : raw, parts = name.split('/');
  check(name.length <= 600 && parts.length <= 20 && parts.every(part =>
    part.length <= 180 && /^[A-Za-z0-9_.@+-]+$/.test(part) && !part.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) && !forbiddenParts.has(part.toLowerCase())),
  'Unsafe or protected ZIP entry path');
  return name;
}

function readZip(bytes) {
  const invalid = () => { throw new Error('Invalid, corrupt or unsupported ZIP archive'); };
  const requireZip = cond => { if (!cond) invalid(); };
  const u16 = pos => bytes.readUInt16LE(pos), u32 = pos => bytes.readUInt32LE(pos);
  requireZip(bytes.length >= 22 && bytes.length <= MAX_ZIP);
  let end = bytes.length - 22;
  const floor = Math.max(0, end - 65535);
  for (; end >= floor; end--) if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  requireZip(end >= floor && !u16(end + 4) && !u16(end + 6));
  const count = u16(end + 10), central = u32(end + 16);
  requireZip(count > 0 && count <= 2048 && u16(end + 8) === count && central + u32(end + 12) === end);
  const records = [], index = new Map(), dirs = new Set();
  let pos = central, total = 0;
  for (let i = 0; i < count; i++) {
    requireZip(pos + 46 <= end && u32(pos) === 0x02014b50 && !u16(pos + 34));
    const flags = u16(pos + 8), method = u16(pos + 10), checksum = u32(pos + 16);
    const compressed = u32(pos + 20), size = u32(pos + 24), n = u16(pos + 28), offset = u32(pos + 42);
    const next = pos + 46 + n + u16(pos + 30) + u16(pos + 32);
    requireZip(next <= end && (flags & ~0x80e) === 0 && (method === 0 || method === 8) && n > 0 && n <= 601);
    const rawName = bytes.subarray(pos + 46, pos + 46 + n);
    const raw = rawName.toString('latin1'), directory = raw.endsWith('/');
    const name = zipName(raw, directory);
    const attributes = u32(pos + 38), type = (attributes >>> 16) & 0xf000;
    requireZip((!type || type === (directory ? 0x4000 : 0x8000)) && !(attributes & 0x408) &&
      (!(attributes & 0x10) || directory) && (!directory || size === 0)); // no links, devices, reparse points
    total += size;
    requireZip(size <= MAX_ENTRY && total <= MAX_EXPANDED);
    requireZip(offset + 30 <= central && u32(offset) === 0x04034b50 && u16(offset + 6) === flags && u16(offset + 8) === method);
    const start = offset + 30 + n + u16(offset + 28), stop = start + compressed;
    requireZip(stop <= central && u16(offset + 26) === n && rawName.equals(bytes.subarray(offset + 30, offset + 30 + n)));
    if (!(flags & 8)) requireZip(u32(offset + 14) === checksum && u32(offset + 18) === compressed && u32(offset + 22) === size);
    requireZip(method !== 0 || compressed === size);
    records.push({ offset, stop, start, size, compressed, checksum, flags, method, name, directory });
    // Remember implicit directories too; files cannot shadow a directory or
    // alias one another via case folding on Windows/macOS.
    const parts = name.split('/');
    for (let j = 1; j <= parts.length; j++) {
      const partial = parts.slice(0, j).join('/'), key = partial.toLowerCase(), last = j === parts.length;
      const isDir = !last || directory;
      if (index.has(key)) requireZip(isDir && dirs.has(key) && index.get(key) === partial);
      index.set(key, partial);
      if (isDir) dirs.add(key);
    }
    pos = next;
  }
  requireZip(pos === end);
  let cursor = 0;
  const files = new Map();
  for (const r of records.sort((a, b) => a.offset - b.offset)) {
    requireZip(r.offset === cursor); // no hidden local headers, prepended executables or overlapping entries
    cursor = r.stop;
    if (r.flags & 8) {
      if (cursor + 4 <= central && u32(cursor) === 0x08074b50) cursor += 4;
      requireZip(cursor + 12 <= central && u32(cursor) === r.checksum && u32(cursor + 4) === r.compressed && u32(cursor + 8) === r.size);
      cursor += 12;
    }
    const packed = bytes.subarray(r.start, r.stop);
    const content = r.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, r.size) });
    requireZip(content.length === r.size && crc32(content) === r.checksum);
    if (!r.directory) files.set(r.name, content);
  }
  requireZip(cursor === central);
  return { files, paths: index.values() };
}

function packageFiles(bytes, expectedVersion, panel, legacyFeed) {
  const zip = readZip(bytes), prefix = `${NAME}/`;
  const wrapped = zip.files.has(prefix + 'plugin.json');
  check(wrapped || (!panel && zip.files.has('plugin.json')), 'Invalid AGY release: missing package root or plugin.json');
  for (const name of zip.paths) {
    check(legacyFeed || !wrapped || name === NAME || name.startsWith(prefix), 'Unexpected entry outside the AGY package root');
    const relative = wrapped && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    check(!CODEX_MARKERS.includes(relative.toLowerCase()), 'Codex files in AGY package');
  }
  const files = wrapped ? new Map([...zip.files].filter(([name]) => name.startsWith(prefix))
    .map(([name, data]) => [name.slice(prefix.length), data])) : zip.files;
  // The local ZIP and custom CLI feed may contain a partial package. Only the
  // custom feed uses legacy version/manifest rules; the panel requires the official layout.
  for (const required of (panel || expectedVersion ? AGY_FILES : ['plugin.json', 'scripts/lib.mjs'])) {
    check(legacyFeed ? files.has(required) : files.get(required)?.length, `Invalid AGY release: missing ${required}`);
  }
  const manifest = manifestVersion(files.get('plugin.json'), legacyFeed);
  const version = legacyFeed ? legacyVersion(manifest) : manifest;
  check(version, 'Missing version in plugin.json');
  check(!expectedVersion || version === expectedVersion, 'Package manifest version does not match release tag');
  return { files, version };
}

function quietRemove(file) {
  try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* Cleanup must not mask the commit outcome. */ }
}

function destination(target, rel) {
  const final = path.join(target, rel), old = safePath(final);
  check(!old || old.isFile(), `Not a regular installation file: ${rel}`);
  return { final, old };
}

function refreshUpdateCache(target, record) {
  // Refresh only the destination's existing local state. An inherited state
  // override or user-wide AGY data directory may belong to another install.
  let scratch;
  try {
    const state = path.join(target, '.state');
    if (!safePath(state)?.isDirectory()) return;
    const { final } = destination(target, path.join('.state', 'update-check.json'));
    scratch = fs.mkdtempSync(path.join(state, '.pfo-check-'));
    const staged = path.join(scratch, 'update-check.json');
    fs.writeFileSync(staged, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(staged, final);
  } catch { /* An unavailable cache must not turn a committed update into a failure. */ }
  finally { if (scratch) quietRemove(scratch); }
}

// Keep the live directory, .state and user settings in place, including during
// rollback. Prepare every new inode and backup before replacing *any* file.
// rename is deliberately never degraded to a non-atomic copy on Windows.
function deploy(target, files) {
  const tx = fs.mkdtempSync(path.join(path.dirname(target), '.pfo-update-'));
  const journal = [], created = [], applied = [];
  let keepBackups = false;
  function ensureDir(dir) {
    const stat = safePath(dir);
    if (stat) { check(stat.isDirectory(), `Not a directory: ${dir}`); return; }
    ensureDir(path.dirname(dir));
    fs.mkdirSync(dir);
    created.push(dir);
  }
  try {
    // The version marker is the last rename, never the first.
    const ordered = [...files.keys()].filter(r => r !== 'plugin.json').concat('plugin.json');
    for (const rel of ordered) {
      const { final, old } = destination(target, rel);
      const content = files.get(rel);
      if (old?.size === content.length && fs.readFileSync(final).equals(content)) continue;
      const i = journal.length, staged = path.join(tx, `new-${i}`), backup = old ? path.join(tx, `old-${i}`) : null;
      fs.writeFileSync(staged, content, { flag: 'wx', mode: old ? old.mode & 0o777 : 0o644 });
      if (old) fs.copyFileSync(final, backup, fs.constants.COPYFILE_EXCL);
      journal.push({ rel, final, old, staged, backup });
    }
    fs.writeFileSync(path.join(tx, 'journal.json'), JSON.stringify({ target,
      entries: journal.map(({ rel, backup }) => [rel, backup && path.basename(backup)]) }), { flag: 'wx', mode: 0o600 });
    for (const entry of journal) {
      ensureDir(path.dirname(entry.final));
      const current = destination(target, entry.rel).old;
      check((!current && !entry.old) || (current && entry.old && current.dev === entry.old.dev && current.ino === entry.old.ino &&
        current.size === entry.old.size && current.mtimeMs === entry.old.mtimeMs), 'Installation changed during update');
      fs.renameSync(entry.staged, entry.final);
      applied.push(entry);
    }
  } catch (error) {
    const failures = [];
    for (const entry of applied.reverse()) {
      try {
        destination(target, entry.rel);
        if (entry.backup) fs.renameSync(entry.backup, entry.final);
        else fs.unlinkSync(entry.final);
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    for (const dir of created.reverse()) {
      try { fs.rmdirSync(dir); } catch (e) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(e.code)) failures.push(e); }
    }
    if (failures.length) {
      keepBackups = true;
      throw new AggregateError([error, ...failures], `Rollback incomplete; original files retained in ${tx}`);
    }
    throw error;
  } finally {
    if (!keepBackups) quietRemove(tx);
  }
}

// No time-based stealing: a slow or suspended updater must never lose its lock.
// A stale lock after a killed process is intentionally fail-closed for inspection.
async function withInstallLock(target, fn) {
  const parent = path.dirname(target);
  safePath(parent);
  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, `.${path.basename(target)}.update-lock`);
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check(attempt < 100, `Another or interrupted update holds ${lock}`);
      await delay(50);
    }
  }
  try { return fn(); } finally {
    try { fs.rmdirSync(lock); } catch { /* A stale lock is safer than reporting a committed update as failed. */ }
  }
}

async function update({ target, zipPath, apiUrl, dryRun, allowGit }, panel) {
  const localZip = !panel && zipPath;
  const legacyFeed = !panel && !localZip && apiUrl !== LATEST_API;
  const initial = installedVersion(target, panel, allowGit, legacyFeed);
  const current = (currentVersion, latestVersion) => ({ updated: false, currentVersion, latestVersion, target });
  let bytes, latest = '', releaseUrl = `${REPO}/releases/latest`, assetUrl = '';
  if (localZip) {
    bytes = readLocal(path.resolve(localZip), MAX_ZIP);
  } else {
    const release = JSON.parse((await fetchBytes(apiUrl, { metadata: true, official: !legacyFeed })).toString('utf8'));
    latest = legacyFeed ? legacyVersion(release?.tag_name) : releaseVersion(release);
    if (latest && !newer(latest, initial, legacyFeed)) return current(initial, latest); // no temp, lock, state or ZIP download
    if (legacyFeed) {
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find(a => typeof a?.name === 'string' && /antigravity.*\.zip$/i.test(a.name));
      assetUrl = trimmed(asset?.browser_download_url);
      const link = trimmed(release?.html_url);
      check(assetUrl, `No release archive found matching antigravity*.zip. Please download manually from ${link || apiUrl}`);
      releaseUrl = link || releaseUrl;
      bytes = await fetchBytes(assetUrl, { official: false });
    } else {
      ({ bytes, assetUrl } = await downloadAgy(release));
      releaseUrl = `${REPO}/releases/tag/${release.tag_name}`;
    }
  }
  const pkg = packageFiles(bytes, legacyFeed ? '' : latest, panel, legacyFeed);
  const result = previous => ({ updated: true, currentVersion: previous, latestVersion: pkg.version,
    files: pkg.files.size, target, dryRun });
  if (dryRun) {
    for (const rel of pkg.files.keys()) destination(target, rel);
    return result(initial);
  }
  return withInstallLock(target, () => {
    const previous = installedVersion(target, panel, allowGit, legacyFeed);
    // Re-read the online tag gate under lock. Explicit --zip has no tag gate:
    // historically a user-selected archive can repair or replace any version.
    if (latest && !newer(latest, previous, legacyFeed)) return current(previous, latest);
    deploy(target, pkg.files);
    refreshUpdateCache(target, { checkedAt: Date.now(), currentVersion: pkg.version, latestVersion: pkg.version, releaseUrl, assetUrl });
    return result(previous);
  });
}

export async function runUpdate({ target = PLUGIN_DIR, zipPath = '', apiUrl = process.env.PRO_UPDATE_API_URL || LATEST_API,
  dryRun = false, allowGit = false } = {}) {
  return update({ target: path.resolve(target), zipPath, apiUrl, dryRun, allowGit }, false);
}

let panelFlight;
export async function updateFromPanel() {
  // No UI arguments, alternate feeds, cached asset URLs or version overrides.
  if (!panelFlight) {
    panelFlight = update({ target: PLUGIN_DIR, apiUrl: LATEST_API, dryRun: false, allowGit: false }, true)
      .then(r => ({ status: r.updated ? 'updated' : 'current', version: r.updated ? r.latestVersion : r.currentVersion,
        previousVersion: r.currentVersion })).finally(() => { panelFlight = undefined; });
  }
  return panelFlight;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = PLUGIN_DIR;
  let zipPath = '';
  let dryRun = false;
  let allowGit = false;
  let apiUrl = process.env.PRO_UPDATE_API_URL || LATEST_API;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--target') {
      if (!args[i + 1]) throw new Error('--target requires a directory path');
      target = args[++i];
    } else if (args[i] === '--zip') {
      if (!args[i + 1]) throw new Error('--zip requires a file path');
      zipPath = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--allow-git') {
      allowGit = true;
    } else if (args[i] === '--api-url') {
      if (!args[i + 1]) throw new Error('--api-url requires a URL');
      apiUrl = args[++i];
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`Usage: node scripts/update.mjs [options]

Options:
  --target <dir>    Target plugin installation directory (default: ${PLUGIN_DIR})
  --zip <path>      Path to local release archive (.zip)
  --dry-run         Simulate update without modifying files
  --allow-git       Allow updating even if target contains a .git directory
  --api-url <url>   Custom GitHub releases API URL
  -h, --help        Show this help message
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  try {
    const result = await runUpdate({ target, zipPath, apiUrl, dryRun, allowGit });
    if (!result.updated) {
      console.log(`[pro-flash-orchestrator] Already up to date (current: v${result.currentVersion}, latest: v${result.latestVersion}).`);
    } else {
      const mode = result.dryRun ? ' (dry-run)' : '';
      console.log(`[pro-flash-orchestrator] Successfully updated${mode} from v${result.currentVersion} to v${result.latestVersion} (${result.files} files deployed to ${result.target}).`);
    }
  } catch (err) {
    console.error(`[pro-flash-orchestrator] Update failed: ${err.message}`);
    process.exit(1);
  }
}
