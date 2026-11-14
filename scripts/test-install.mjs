#!/usr/bin/env node
/** Verify the runtime-only install/package boundary and preservation of state. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installRuntime } from './install.mjs';
import { ROOT_DIR, runtimeEntries, validateRuntimePath } from './runtime-files.mjs';
import { createReleaseZip, verifyZipLayout, resolveTag } from './package.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-install-test-'));
const target = path.join(TMP, 'pro-flash-orchestrator');
const stateDir = path.join(target, '.state');
fs.mkdirSync(stateDir, { recursive: true });
const stateFiles = new Map([
  ['mode.json', '{"mode":"shadow"}\n'],
  ['decisions.jsonl', '{"custom":"keep this history"}\n'],
  ['capabilities.json', '{"hasHydrogen":true,"source":"keep this local capability cache"}\n'],
  ['sessions/existing.json', '{"writesSinceDispatch":["keep.js"]}\n'],
]);
for (const [file, content] of stateFiles) {
  fs.mkdirSync(path.dirname(path.join(stateDir, file)), { recursive: true });
  fs.writeFileSync(path.join(stateDir, file), content);
}
const checkState = () => {
  for (const [file, content] of stateFiles) assert.equal(fs.readFileSync(path.join(stateDir, file), 'utf8'), content);
};
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
try {
  test('worktree release names use the working version instead of the previous HEAD tag', () => {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'plugin.json'), 'utf8')).version;
    assert.equal(resolveTag('', { worktree: true }), 'v' + version);
    assert.equal(resolveTag('v9.9.9', { worktree: true }), 'v9.9.9');
  });
  test('dry run validates the layout without creating plugin files', () => {
    const out = installRuntime(target, { dryRun: true });
    assert.equal(out.files, 17);
    assert.equal(fs.existsSync(path.join(target, 'plugin.json')), false);
    checkState();
  });
  test('Antigravity install contains only runtime files and keeps user state', () => {
    const out = installRuntime(target);
    assert.equal(out.files, 17);
    for (const { to } of runtimeEntries({ platform: 'antigravity' })) assert(fs.existsSync(path.join(target, to)), to);
    for (const file of ['.git', '.github', 'runtime-files.json', 'hooks', 'scripts/doctor.mjs',
      'scripts/test-regressions.mjs', 'scripts/package.mjs', 'scripts/install.mjs']) {
      assert.equal(fs.existsSync(path.join(target, file)), false, file);
    }
    assert(fs.readFileSync(path.join(target, 'README.md'), 'utf8').includes(ROOT_DIR.replace(/\\/g, '/')));
    checkState();
  });
  test('repeated deployment does not rewrite matching files or overwrite state', () => {
    const before = fs.statSync(path.join(target, 'scripts/lib.mjs')).mtimeMs;
    const out = installRuntime(target);
    assert.equal(out.changed, 0);
    assert.equal(fs.statSync(path.join(target, 'scripts/lib.mjs')).mtimeMs, before);
    checkState();
  });
  test('all six installed hooks execute with isolated smoke-test state', () => {
    const calls = [
      ['session-start.mjs', null], ['pre-invocation.mjs', null],
      ['guard-subagent.mjs', { name: 'invoke_subagent', args: { TypeName: 'self', Model: 'pro', Prompt: 'task' } }],
      ['guard-read-file.mjs', { name: 'read_file', args: { Path: path.join(target, 'scripts/lib.mjs'), StartLine: 1, EndLine: 1 } }],
      ['guard-write-file.mjs', { name: 'write_file', args: { Path: path.join(TMP, 'module.js') } }],
      ['guard-command.mjs', { name: 'run_command', args: { CommandLine: 'git log -n 1' } }],
    ];
    for (const [script, toolCall] of calls) {
      const payload = { conversationId: 'doctor-runtime-layout', lastUserInput: 'test runtime install', workspacePaths: [TMP], toolCall };
      const out = spawnSync(process.execPath, [path.join(target, 'scripts', script)], {
        input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PRO_MODE: 'enforce', PRO_STATE_DIR: path.join(TMP, 'smoke-state'), PRO_TEST: '1', ARGON_TEST: '1' },
      });
      assert.ifError(out.error);
      assert.equal(out.status, 0, out.stderr);
      const result = JSON.parse(out.stdout);
      if (script === 'session-start.mjs') {
        assert(result.injectSteps?.length);
        assert.match(result.injectSteps[0].systemMessage.renderInfo.markdown, /在维护工程运行/);
      } else if (script === 'guard-subagent.mjs') assert.equal(result.overwrite.Model, 'flash');
      else assert.notEqual(result.decision, 'deny');
    }
    checkState();
  });
  test('Git checkouts, unsafe target directories and protected manifest paths are rejected', () => {
    assert.throws(() => installRuntime(ROOT_DIR), /separate/);
    assert.throws(() => installRuntime(TMP), /must be named/);
    fs.mkdirSync(path.join(target, '.git'));
    try { assert.throws(() => installRuntime(target), /Git checkout/); }
    finally { fs.rmdirSync(path.join(target, '.git')); }
    for (const file of ['../file', '.state/mode.json', '.git/config', '/absolute', 'C:/absolute']) {
      assert.throws(() => validateRuntimePath(file));
    }
    checkState();
  });
  test('runtime release excludes all maintenance files and includes cross-platform adapters', () => {
    const result = createReleaseZip({ tag: 'v0.6.1', worktree: true, runtime: true, outFile: path.join(TMP, 'runtime.zip') });
    const entries = verifyZipLayout(result.outFile, runtimeEntries().map((file) => file.to));
    assert(entries.includes('pro-flash-orchestrator/hooks/codex-hooks.json'));
    assert(entries.includes('pro-flash-orchestrator/hooks/claude-settings-hooks.json'));
    assert(entries.includes('pro-flash-orchestrator/README.md'));
    assert(!entries.some((file) => /scripts\/(?:doctor|test-|package|install|runtime-files)/.test(file)));
    assert(!entries.some((file) => file.includes('.maintenance')));
    checkState();
  });
  test('complete source archives remain available separately', () => {
    const result = createReleaseZip({ tag: 'v0.6.1', worktree: true, runtime: false, outFile: path.join(TMP, 'source.zip') });
    const entries = verifyZipLayout(result.outFile);
    assert(entries.includes('pro-flash-orchestrator/scripts/test-install.mjs'));
    assert(entries.includes('pro-flash-orchestrator/runtime-files.json'));
    assert(!entries.some((file) => file.includes('.maintenance')));
  });
} finally {
  if (path.dirname(path.resolve(TMP)) !== path.resolve(os.tmpdir()) ||
      !path.basename(TMP).startsWith('pfo-install-test-')) throw new Error('Invalid install test cleanup path');
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nInstall results: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
