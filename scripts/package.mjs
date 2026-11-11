#!/usr/bin/env node
/**
 * Release archive packager for pro-flash-orchestrator.
 *
 * Ensures the generated `.zip` always contains a single top-level
 * `pro-flash-orchestrator/` folder (never loose files at archive root),
 * and verifies every ZIP central directory entry before exiting.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeEntries, readProjectFile, renderInstallReadme } from './runtime-files.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPTS_DIR);
const PREFIX = 'pro-flash-orchestrator/';

function parseArgs(argv) {
  const opts = {
    tag: '',
    ref: 'HEAD',
    outDir: path.join(ROOT_DIR, 'dist'),
    outFile: '',
    worktree: false,
    runtime: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag' || arg === '--version') {
      opts.tag = String(argv[++i] || '').trim();
    } else if (arg === '--ref') {
      opts.ref = String(argv[++i] || 'HEAD').trim() || 'HEAD';
    } else if (arg === '--out-dir') {
      opts.outDir = path.resolve(String(argv[++i] || opts.outDir));
    } else if (arg === '--out') {
      opts.outFile = path.resolve(String(argv[++i] || ''));
    } else if (arg === '--worktree') {
      opts.worktree = true;
    } else if (arg === '--runtime') {
      opts.runtime = true;
    } else if (arg === '--source') {
      opts.runtime = false;
    }
  }
  return opts;
}

export function normalizeTag(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.startsWith('v') ? s : `v${s}`;
}

export function resolveTag(explicitTag) {
  if (explicitTag) return normalizeTag(explicitTag);
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
    return normalizeTag(process.env.GITHUB_REF_NAME);
  }
  try {
    const exact = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (exact) return normalizeTag(exact);
  } catch {
    /* HEAD is not tagged */
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'plugin.json'), 'utf8'));
  return normalizeTag(pkg.version || '0.0.0');
}

export function listZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Invalid ZIP archive (missing EOCD): ${zipPath}`);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP central directory at offset ${pos}`);
    }
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push(name);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function verifyZipLayout(zipPath, allowedFiles = null) {
  const entries = listZipEntries(zipPath);
  if (entries.length === 0) {
    throw new Error(`Archive is empty: ${zipPath}`);
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) {
      throw new Error(`Loose root entry found (expected "${PREFIX}*"): ${entry}`);
    }
    if (entry.startsWith(`${PREFIX}.git/`) || entry.startsWith(`${PREFIX}.state/`)) {
      throw new Error(`Forbidden internal directory in archive: ${entry}`);
    }
  }
  for (const required of [`${PREFIX}plugin.json`, `${PREFIX}hooks.json`, `${PREFIX}scripts/lib.mjs`]) {
    if (!entries.includes(required)) {
      throw new Error(`Missing required file in archive: ${required}`);
    }
  }
  if (allowedFiles) {
    const allowed = new Set(allowedFiles.map((file) => `${PREFIX}${file}`));
    for (const entry of entries) {
      if (!entry.endsWith('/') && !allowed.has(entry)) throw new Error(`Non-runtime file in archive: ${entry}`);
    }
    for (const file of allowed) {
      if (!entries.includes(file)) throw new Error(`Missing runtime file in archive: ${file}`);
    }
  }
  return entries;
}

function packageFromWorktree(outFile, runtimeOptions = null) {
  const rawList = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT_DIR,
  });
  const relFiles = runtimeOptions ? runtimeEntries(runtimeOptions) : rawList
    .toString('utf8')
    .split('\0')
    .filter((f) => f && !f.startsWith('.git/') && !f.startsWith('.state/') && !f.startsWith('dist/') && !f.endsWith('.zip'));

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-pkg-'));
  const stageDir = path.join(stageRoot, 'pro-flash-orchestrator');
  try {
    for (const file of relFiles) {
      const rel = runtimeOptions ? file.from : file;
      const src = path.join(ROOT_DIR, rel);
      if (!runtimeOptions && (!fs.existsSync(src) || !fs.statSync(src).isFile())) continue;
      const dst = path.join(stageDir, runtimeOptions ? file.to : rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (runtimeOptions) {
        let content = readProjectFile(rel, runtimeOptions);
        if (rel === 'docs/INSTALL.md') content = renderInstallReadme(content);
        fs.writeFileSync(dst, content);
      } else fs.copyFileSync(src, dst);
    }
    if (process.platform === 'win32') {
      const esc = (s) => s.replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.IO.Compression',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$zip = [System.IO.Compression.ZipFile]::Open('${esc(outFile)}', [System.IO.Compression.ZipArchiveMode]::Create)`,
        'try {',
        `  $root = '${esc(stageRoot)}'`,
        `  foreach ($f in Get-ChildItem -LiteralPath '${esc(stageDir)}' -Recurse -File) {`,
        "    $rel = $f.FullName.Substring($root.Length).TrimStart('\\','/').Replace('\\','/')",
        '    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null',
        '  }',
        '} finally { $zip.Dispose() }',
      ].join('; ');
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit', windowsHide: true });
    } else {
      execFileSync('zip', ['-rq', outFile, 'pro-flash-orchestrator'], {
        cwd: stageRoot,
        stdio: 'inherit',
      });
    }
  } finally {
    if (path.dirname(path.resolve(stageRoot)) !== path.resolve(os.tmpdir()) ||
        !path.basename(stageRoot).startsWith('pfo-pkg-')) throw new Error('Invalid package cleanup path');
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function createReleaseZip(opts) {
  const tag = resolveTag(opts.tag);
  const outFile = opts.outFile || path.join(opts.outDir, `pro-flash-orchestrator-${tag}.zip`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  if (opts.runtime) {
    packageFromWorktree(outFile, { worktree: Boolean(opts.worktree), ref: opts.ref || 'HEAD' });
  } else if (opts.worktree) {
    packageFromWorktree(outFile);
  } else {
    execFileSync(
      'git',
      ['archive', '--format=zip', `--prefix=${PREFIX}`, `--output=${outFile}`, opts.ref],
      { cwd: ROOT_DIR, stdio: 'inherit' }
    );
  }

  const allowed = opts.runtime ? runtimeEntries({ worktree: Boolean(opts.worktree), ref: opts.ref || 'HEAD' }).map((file) => file.to) : null;
  const entries = verifyZipLayout(outFile, allowed);
  return { tag, outFile, entryCount: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const opts = parseArgs(process.argv.slice(2));
  const result = createReleaseZip(opts);
  const sizeKb = (fs.statSync(result.outFile).size / 1024).toFixed(1);
  console.log(`Packaged ${result.outFile} (${result.entryCount} entries, ${sizeKb} KB, root=${PREFIX})`);
}
