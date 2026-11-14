#!/usr/bin/env node
/**
 * In-place runtime updater for pro-flash-orchestrator.
 *
 * Downloads and applies official release archives, strictly protecting
 * runtime state and rejecting git working copies unless explicitly allowed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DIR,
  PLUGIN_VERSION,
  UPDATE_CHECK_FILE,
  compareSemver,
  safeWriteFileSync,
} from './lib.mjs';

function checkParents(baseDir, relativeFilePath) {
  let current = baseDir;
  const parts = relativeFilePath.split(/[/\\]/);
  for (const part of parts) {
    if (!part) continue;
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to deploy through a symbolic link: ${current}`);
    }
  }
}

function collectPackageFiles(rootDir) {
  const files = [];
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.state' || entry.name === '.git' || entry.name === '.maintenance') {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(rootDir, fullPath);
        files.push({ fullPath, rel });
      }
    }
  }
  walk(rootDir);
  return files;
}

export async function runUpdate(options = {}) {
  const {
    target = PLUGIN_DIR,
    zipPath = '',
    apiUrl = process.env.PRO_UPDATE_API_URL || 'https://api.github.com/repos/demgkp1/pro-flash-orchestrator/releases/latest',
    dryRun = false,
    allowGit = false,
  } = options;

  const installDir = path.resolve(target);
  if (!allowGit && fs.existsSync(path.join(installDir, '.git'))) {
    throw new Error('Refusing to overwrite a Git checkout; use git pull or pass --target <installDir>');
  }

  let currentVersion = PLUGIN_VERSION;
  const targetManifestPath = path.join(installDir, 'plugin.json');
  if (fs.existsSync(targetManifestPath)) {
    let targetManifest;
    try {
      targetManifest = JSON.parse(fs.readFileSync(targetManifestPath, 'utf8'));
    } catch {
      targetManifest = null;
    }
    if (targetManifest && targetManifest.name && targetManifest.name !== 'pro-flash-orchestrator') {
      throw new Error(`Target contains a different plugin: ${targetManifest.name}`);
    }
    if (typeof targetManifest?.version === 'string' && targetManifest.version.trim()) {
      currentVersion = targetManifest.version.trim();
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-update-'));
  try {
    let archivePath = '';
    let latestVersion = '';
    let releaseUrl = '';
    let assetUrl = '';

    if (zipPath) {
      const resolvedZip = path.resolve(zipPath);
      if (!fs.existsSync(resolvedZip) || !fs.statSync(resolvedZip).isFile() || fs.statSync(resolvedZip).size <= 0) {
        throw new Error(`Specified zip file does not exist or is empty: ${zipPath}`);
      }
      archivePath = resolvedZip;
    } else {
      let releaseRaw = '';
      try {
        releaseRaw = execFileSync('curl', ['-fsSL', '--max-time', '10', apiUrl], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        const res = await fetch(apiUrl, {
          headers: {
            'User-Agent': 'pro-flash-orchestrator',
            Accept: 'application/vnd.github.v3+json',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new Error(`Failed to query release info from ${apiUrl}: HTTP ${res.status}`);
        }
        releaseRaw = await res.text();
      }

      let release;
      try {
        release = JSON.parse(releaseRaw);
      } catch (err) {
        throw new Error(`Failed to parse release response from ${apiUrl}: ${err.message}`);
      }

      latestVersion = typeof release?.tag_name === 'string'
        ? release.tag_name.trim().replace(/^v/i, '')
        : '';
      releaseUrl = typeof release?.html_url === 'string' ? release.html_url.trim() : '';

      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((a) => typeof a?.name === 'string' && /antigravity.*\.zip$/i.test(a.name));
      assetUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url.trim() : '';

      if (latestVersion && compareSemver(latestVersion, currentVersion) <= 0) {
        return { updated: false, currentVersion, latestVersion, target: installDir };
      }

      if (!assetUrl) {
        throw new Error(`No release archive found matching antigravity*.zip. Please download manually from ${releaseUrl || apiUrl}`);
      }

      archivePath = path.join(tmpDir, 'release.zip');
      if (assetUrl.startsWith('file://')) {
        const localFile = fileURLToPath(assetUrl);
        fs.copyFileSync(localFile, archivePath);
      } else if (fs.existsSync(assetUrl)) {
        fs.copyFileSync(assetUrl, archivePath);
      } else {
        let downloaded = false;
        try {
          execFileSync('curl', ['-fL', '--max-time', '30', '-o', archivePath, assetUrl], {
            windowsHide: true,
            stdio: 'ignore',
          });
          downloaded = true;
        } catch {
          // curl failed
        }
        if (!downloaded) {
          const res = await fetch(assetUrl, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) {
            throw new Error(`Failed to download release archive from ${assetUrl}: HTTP ${res.status}`);
          }
          const arrayBuf = await res.arrayBuffer();
          fs.writeFileSync(archivePath, Buffer.from(arrayBuf));
        }
      }

      if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size <= 0) {
        throw new Error(`Downloaded release archive is empty or missing: ${archivePath}`);
      }
    }

    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    let extracted = false;
    try {
      execFileSync('tar', ['-xf', archivePath, '-C', extractDir], {
        stdio: 'ignore',
        windowsHide: true,
      });
      extracted = true;
    } catch {
      // tar failed
    }

    if (!extracted) {
      if (process.platform === 'win32') {
        const safeArchive = archivePath.replace(/'/g, "''");
        const safeExtract = extractDir.replace(/'/g, "''");
        execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${safeArchive}' -DestinationPath '${safeExtract}' -Force`,
        ], { stdio: 'ignore', windowsHide: true });
        extracted = true;
      } else {
        throw new Error(`Failed to extract release archive: ${archivePath}`);
      }
    }

    let packageRoot = '';
    if (fs.existsSync(path.join(extractDir, 'pro-flash-orchestrator', 'plugin.json'))) {
      packageRoot = path.join(extractDir, 'pro-flash-orchestrator');
    } else if (fs.existsSync(path.join(extractDir, 'plugin.json'))) {
      packageRoot = extractDir;
    } else {
      throw new Error('Invalid release archive: missing plugin.json');
    }

    const packageManifestFile = path.join(packageRoot, 'plugin.json');
    let packageManifest;
    try {
      packageManifest = JSON.parse(fs.readFileSync(packageManifestFile, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse plugin.json in release archive: ${err.message}`);
    }

    if (packageManifest?.name !== 'pro-flash-orchestrator') {
      throw new Error(`Invalid release archive: manifest name is "${packageManifest?.name}", expected "pro-flash-orchestrator"`);
    }

    if (!fs.existsSync(path.join(packageRoot, 'scripts', 'lib.mjs'))) {
      throw new Error('Invalid release archive: missing scripts/lib.mjs');
    }

    const newVersion = typeof packageManifest?.version === 'string' && packageManifest.version.trim()
      ? packageManifest.version.trim().replace(/^v/i, '')
      : '';
    if (!newVersion) {
      throw new Error('Invalid release archive: missing version in plugin.json');
    }
    if (!latestVersion) {
      latestVersion = newVersion;
    }

    const files = collectPackageFiles(packageRoot);
    let copiedCount = 0;

    for (const file of files) {
      checkParents(installDir, file.rel);
      const targetFile = path.join(installDir, file.rel);
      copiedCount += 1;

      if (dryRun) continue;

      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      const content = fs.readFileSync(file.fullPath);
      const temporary = `${targetFile}.${process.pid}.${Math.random().toString(36).slice(2)}.update-tmp`;
      try {
        fs.writeFileSync(temporary, content, { flag: 'wx' });
        let renamed = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            fs.renameSync(temporary, targetFile);
            renamed = true;
            break;
          } catch {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
          }
        }
        if (!renamed) {
          fs.copyFileSync(temporary, targetFile);
        }
      } finally {
        if (fs.existsSync(temporary)) {
          try {
            fs.unlinkSync(temporary);
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (!dryRun) {
      const updateCheckData = {
        checkedAt: Date.now(),
        currentVersion: newVersion,
        latestVersion: newVersion,
        releaseUrl: releaseUrl || 'https://github.com/demgkp1/pro-flash-orchestrator/releases/latest',
        assetUrl: assetUrl || '',
      };
      const jsonContent = JSON.stringify(updateCheckData, null, 2);

      const targetsToUpdate = new Set();
      const installStateDir = path.join(installDir, '.state');
      if (fs.existsSync(installStateDir)) {
        targetsToUpdate.add(path.join(installStateDir, 'update-check.json'));
      }
      targetsToUpdate.add(UPDATE_CHECK_FILE);

      const defaultPluginDataDir = path.join(
        os.homedir(),
        '.gemini',
        'antigravity',
        'plugin_data',
        'pro-flash-orchestrator'
      );
      if (fs.existsSync(defaultPluginDataDir)) {
        targetsToUpdate.add(path.join(defaultPluginDataDir, 'update-check.json'));
      }

      for (const checkPath of targetsToUpdate) {
        try {
          safeWriteFileSync(checkPath, jsonContent);
        } catch {
          /* ignore */
        }
      }
    }

    return {
      updated: true,
      currentVersion,
      latestVersion: newVersion,
      files: copiedCount,
      target: installDir,
      dryRun,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = PLUGIN_DIR;
  let zipPath = '';
  let dryRun = false;
  let allowGit = false;
  let apiUrl = process.env.PRO_UPDATE_API_URL || 'https://api.github.com/repos/demgkp1/pro-flash-orchestrator/releases/latest';

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
