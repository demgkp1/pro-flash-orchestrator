#!/usr/bin/env node
/** Copy only runtime files from the maintenance checkout; never write state. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR, runtimeEntries, readProjectFile, renderInstallReadme } from './runtime-files.mjs';

function checkParents(target, file) {
  let current = target;
  for (const part of ['', ...file.split('/')]) {
    if (part) current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to deploy through a symbolic link: ${current}`);
    }
  }
}

export function installRuntime(target, { platform = 'antigravity', dryRun = false } = {}) {
  const installDir = path.resolve(target);
  const sourceDir = path.resolve(ROOT_DIR);
  const name = JSON.parse(readProjectFile('plugin.json')).name;
  if (path.basename(installDir).toLowerCase() !== name.toLowerCase()) {
    throw new Error(`Target directory must be named ${name}`);
  }
  const rel = path.relative(sourceDir, installDir);
  const reverse = path.relative(installDir, sourceDir);
  if ((!rel.startsWith('..') && !path.isAbsolute(rel)) ||
      (!reverse.startsWith('..') && !path.isAbsolute(reverse))) {
    throw new Error('The install and maintenance directories must be separate');
  }
  if (fs.existsSync(path.join(installDir, '.git'))) {
    throw new Error('Target is a Git checkout; relocate the complete checkout before deploying runtime files');
  }
  const targetManifest = path.join(installDir, 'plugin.json');
  if (fs.existsSync(targetManifest) && JSON.parse(fs.readFileSync(targetManifest, 'utf8')).name !== name) {
    throw new Error('Target contains a different plugin');
  }
  const prepared = runtimeEntries({ platform }).map((entry) => {
    checkParents(installDir, entry.to);
    let content = readProjectFile(entry.from);
    if (entry.from === 'docs/INSTALL.md') {
      content = renderInstallReadme(content, { maintenanceDir: sourceDir, installDir });
    }
    return { ...entry, content, target: path.join(installDir, entry.to) };
  });
  let changed = 0;
  for (const file of prepared) {
    if (fs.existsSync(file.target) && fs.readFileSync(file.target).equals(file.content)) continue;
    changed += 1;
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(file.target), { recursive: true });
    const temporary = `${file.target}.${process.pid}.${Math.random().toString(36).slice(2)}.install-tmp`;
    try {
      fs.writeFileSync(temporary, file.content, { flag: 'wx' });
      fs.renameSync(temporary, file.target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { source: sourceDir, target: installDir, platform, files: prepared.length,
    bytes: prepared.reduce((total, file) => total + file.content.length, 0), changed, dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'pro-flash-orchestrator');
  let platform = 'antigravity';
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--target') { if (!args[i + 1]) throw new Error('--target requires a path'); target = args[++i]; }
    else if (args[i] === '--platform') { if (!args[i + 1]) throw new Error('--platform requires a name'); platform = args[++i]; }
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  console.log(JSON.stringify(installRuntime(target, { platform, dryRun }), null, 2));
}
