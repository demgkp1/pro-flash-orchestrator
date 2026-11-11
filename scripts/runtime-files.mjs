#!/usr/bin/env node
/** Shared, explicit runtime allowlist for installation and release packaging. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function validateRuntimePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Invalid runtime path: ${value}`);
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' ||
      ['.git', '.state', '.maintenance'].includes(part.toLowerCase()))) {
    throw new Error(`Protected or escaping runtime path: ${value}`);
  }
  return parts.join('/');
}

export function readProjectFile(file, { worktree = true, ref = 'HEAD' } = {}) {
  const rel = validateRuntimePath(file);
  return worktree
    ? fs.readFileSync(path.join(ROOT_DIR, rel))
    : execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT_DIR, maxBuffer: 16 * 1024 * 1024 });
}

export function runtimeEntries({ platform = 'all', ...source } = {}) {
  const spec = JSON.parse(readProjectFile('runtime-files.json', source).toString('utf8'));
  if (!Array.isArray(spec.files) || !['antigravity', 'claude', 'codex', 'all'].includes(platform)) {
    throw new Error('Invalid runtime manifest or platform');
  }
  const files = [...spec.files];
  for (const [name, adapters] of Object.entries(spec.adapters || {})) {
    if (platform === 'all' || name === platform) files.push(...adapters);
  }
  const targets = new Set();
  return files.map((file) => {
    const from = validateRuntimePath(typeof file === 'string' ? file : file.from);
    const to = validateRuntimePath(typeof file === 'string' ? file : file.to);
    if (targets.has(to)) throw new Error(`Duplicate runtime target: ${to}`);
    targets.add(to);
    return { from, to };
  });
}

export function renderInstallReadme(content, { maintenanceDir = '<维护工程目录>', installDir = '<安装目录>' } = {}) {
  return Buffer.from(content.toString('utf8')
    .replaceAll('{{MAINTENANCE_DIR}}', maintenanceDir.replace(/\\/g, '/'))
    .replaceAll('{{INSTALL_DIR}}', installDir.replace(/\\/g, '/')));
}
