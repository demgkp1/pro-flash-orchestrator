#!/usr/bin/env node
/** Reproductions of audited defects, with isolated runtime state. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-regressions-'));
const WORKSPACE = path.join(TMP, 'workspace');
fs.mkdirSync(WORKSPACE);
process.env.PRO_STATE_DIR = path.join(TMP, 'lib-state');
process.env.PRO_TEST = '';
process.env.ARGON_TEST = '';
const libUrl = pathToFileURL(path.join(ROOT, 'scripts', 'lib.mjs')).href;
const {
  acquireLock, releaseLock, updateSession, readSession, markSubagentSpawn,
  checkAndClaimSubagent, SPAWN_FILE, SPAWN_LOCK, SESSION_DIR,
} = await import(libUrl);

const transcript = path.join(WORKSPACE, 'main.jsonl');
fs.writeFileSync(transcript, JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'ordinary request' }) + '\n');
const small = path.join(WORKSPACE, 'small.js');
const big = path.join(WORKSPACE, 'big.log');
fs.writeFileSync(small, '// small\n');
fs.writeFileSync(big, 'x\n'.repeat(300000));
const stateDir = (name) => path.join(TMP, 'states', name);
const sessionFile = (name, conv) => path.join(stateDir(name), 'sessions', `${conv.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
function seed(name, conv, data) {
  const file = sessionFile(name, conv);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
function state(name, conv) { return JSON.parse(fs.readFileSync(sessionFile(name, conv), 'utf8')); }
function seedSpawns(name, spawns) {
  fs.mkdirSync(stateDir(name), { recursive: true });
  fs.writeFileSync(path.join(stateDir(name), 'last_spawn.json'), JSON.stringify({ spawns, pendingCount: spawns.filter((s) => s && !s.claimedBy).length }));
}
function hook(script, payload, name, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT, input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PRO_STATE_DIR: stateDir(name), PRO_MODE: 'enforce', CODEX_HOME: '', PRO_WORKER_MODEL: '', ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const decision = (out) => out.decision || out.hookSpecificOutput?.permissionDecision || 'allow';
const base = (conv, extra = {}) => ({ conversationId: conv, transcriptPath: transcript, workspacePaths: [WORKSPACE], lastUserInput: 'implement modules', ...extra });
const dispatch = (conv, extra = {}) => base(conv, { toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Model: 'flash', Prompt: 'implement module' } }, ...extra });
const command = (cmd, env = {}, extra = {}) => hook('guard-command.mjs', base('command-main', { toolCall: { name: 'run_command', args: { CommandLine: cmd } }, ...extra }), 'command', env);
const patchPayload = (input, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'patch-main', turn_id: 'turn-1', model: 'gpt-5', cwd: WORKSPACE, tool_name: 'apply_patch', tool_input: { input }, ...extra });
const patch = (paths) => `*** Begin Patch\n${paths.map((file) => `*** Update File: ${file}\n@@\n-old\n+new`).join('\n')}\n*** End Patch`;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}

try {
  await test('cold main session cannot consume another session spawn', () => {
    hook('guard-subagent.mjs', dispatch('parent-A'), 'identity');
    const main = base('unrelated-main', { transcriptPath: path.join(TMP, 'missing.jsonl') });
    const out = hook('session-start.mjs', main, 'identity');
    assert(out.injectSteps?.length);
    const pool = JSON.parse(fs.readFileSync(path.join(stateDir('identity'), 'last_spawn.json'), 'utf8'));
    assert.equal(pool.pendingCount, 1);
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('unrelated-main'), 'identity')), 'allow');
  });
  await test('legacy false-positive identity is re-evaluated', () => {
    for (const transcriptPath of ['', transcript]) {
      seed('legacy', 'legacy-main', { isSubAgent: true, parentConversationId: 'old-parent' });
      const out = hook('session-start.mjs', base('legacy-main', { transcriptPath }), 'legacy');
      assert(out.injectSteps?.length);
    }
  });
  await test('cold worker contract is recognised and cached for later messages', () => {
    const worker = base('worker', { transcriptPath: '', lastUserInput: '[FLASH-WORKER] implement module' });
    assert.deepEqual(hook('session-start.mjs', worker, 'worker'), {});
    assert.equal(state('worker', 'worker').subagentEvidence, 'contract');
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('worker', { transcriptPath: '', lastUserInput: 'continue' }), 'worker')), 'deny');
  });
  await test('spawn claims require matching explicit parent evidence', () => {
    markSubagentSpawn('parent-1');
    assert.equal(checkAndClaimSubagent('main'), null);
    assert.equal(checkAndClaimSubagent('worker', 'parent-2'), null);
    assert.equal(checkAndClaimSubagent('parent-1', 'parent-1'), null);
    assert.equal(checkAndClaimSubagent('worker', 'parent-1')?.parent, 'parent-1');
  });
  await test('spawn retention and explicit claims share the ten-minute parent recovery window', () => {
    const pool = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8'));
    pool.spawns.push({ parent: 'older-parent', ts: Date.now() - 5 * 60 * 1000, claimedBy: null },
      { parent: 'expired-parent', ts: Date.now() - 10 * 60 * 1000, claimedBy: null });
    fs.writeFileSync(SPAWN_FILE, JSON.stringify(pool));
    assert.equal(markSubagentSpawn('new-parent'), true);
    const retained = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8')).spawns;
    assert(retained.some((s) => s.parent === 'older-parent'));
    assert(!retained.some((s) => s.parent === 'expired-parent'));
    assert.equal(checkAndClaimSubagent('older-child', 'older-parent')?.parent, 'older-parent');
  });
  await test('transcript-only sender persists the parent and mirrors masked commands into its audit batch', () => {
    const name = 'transcript-parent';
    const parent = 'parent.alpha_42:task-3';
    const child = 'transcript-child';
    const file = path.join(TMP, 'sender-child.jsonl');
    fs.writeFileSync(file, JSON.stringify({ source: 'SYSTEM_SDK', content: 'startup' }) + '\n' +
      JSON.stringify({ source: 'SYSTEM', content: `<SYSTEM_MESSAGE>[Message] sender=${parent} priority=high work</SYSTEM_MESSAGE>` }) + '\n');
    seed(name, parent, { auditBatchId: 'sender-batch', subagentCommands: [] });
    seed(name, 'unrelated-parent', { subagentCommands: [] });
    seedSpawns(name, [{ parent: 'unrelated-parent', ts: Date.now(), claimedBy: null }]);
    const payload = base(child, { transcriptPath: file,
      toolCall: { name: 'run_command', args: { CommandLine: 'node check.js token=hidden api_key="quoted secret"' } } });
    assert.equal(decision(hook('guard-command.mjs', payload, name)), 'allow');
    assert.equal(state(name, child).parentConversationId, parent);
    assert.equal(state(name, child).subagentEvidence, 'transcript');
    const entry = state(name, parent).subagentCommands[0];
    assert.equal(entry.conversationId, child); assert.equal(entry.auditBatchId, 'sender-batch');
    assert.equal(entry.status, 'allowed'); assert.equal(typeof entry.ts, 'number');
    assert(!entry.command.includes('hidden')); assert(!entry.command.includes('quoted secret'));
    assert.equal(state(name, 'unrelated-parent').subagentCommands.length, 0);
    // Later followups have neither sender metadata nor the original contract.
    assert.equal(decision(hook('guard-command.mjs', { ...payload, transcriptPath: '', lastUserInput: 'continue: sender=unrelated-parent is a code example',
      toolCall: { name: 'run_command', args: { CommandLine: 'node second-check.js' } } }, name)), 'allow');
    assert.equal(state(name, parent).subagentCommands.length, 2);
    assert.equal(state(name, child).parentConversationId, parent);
    assert.equal(state(name, 'unrelated-parent').subagentCommands.length, 0);
    const denied = { ...payload, toolCall: { name: 'run_command', args: {
      CommandLine: `Set-Content "${path.join(stateDir(name), 'mode.json')}" '{}'`,
    } } };
    assert.equal(decision(hook('guard-command.mjs', denied, name)), 'deny');
    assert.equal(state(name, parent).subagentCommands.length, 2);
  });
  await test('cold system, prefixed and appended contracts all preserve sender parent IDs', () => {
    const inputs = [
      '<SYSTEM_MESSAGE>\n[Message] sender=input-parent work\n</SYSTEM_MESSAGE>',
      '[FLASH-WORKER] sender=input-parent work',
      '[PRO-CONTRACT] sender=input-parent work',
      'bounded work\n\n[PRO-CONTRACT] 完成后仅回复四列表格 sender=input-parent',
    ];
    for (const [i, lastUserInput] of inputs.entries()) {
      const name = 'input-parent-' + i;
      seed(name, 'input-parent', { auditBatchId: 'input-batch', subagentCommands: [] });
      const child = 'input-child-' + i;
      const payload = base(child, { transcriptPath: path.join(TMP, 'missing-child.jsonl'), lastUserInput,
        toolCall: { name: 'run_command', args: { CommandLine: 'node --test local.mjs' } } });
      assert.equal(decision(hook('guard-command.mjs', payload, name)), 'allow');
      assert.equal(state(name, child).parentConversationId, 'input-parent');
      assert.equal(state(name, child).subagentEvidence, 'contract');
      assert.equal(state(name, 'input-parent').subagentCommands[0].conversationId, child);
    }
  });
  await test('contract-only child recovers an unambiguous unclaimed parent within ten minutes', () => {
    const name = 'spawn-parent';
    seed(name, 'older-parent', { subagentCommands: [] });
    seed(name, 'recent-parent', { auditBatchId: 'spawn-batch', subagentCommands: [] });
    seedSpawns(name, [
      { parent: 'older-parent', ts: Date.now() - 11 * 60 * 1000, claimedBy: null },
      { parent: 'recent-parent', ts: Date.now() - 5 * 60 * 1000, claimedBy: null },
      { parent: 'other-child-parent', ts: Date.now(), claimedBy: 'another-child' },
    ]);
    const child = 'spawn-child';
    const payload = base(child, { transcriptPath: '', lastUserInput: '[PRO-CONTRACT] bounded work',
      toolCall: { name: 'run_command', args: { CommandLine: 'node --test local.mjs' } } });
    hook('guard-command.mjs', payload, name);
    assert.equal(state(name, child).parentConversationId, 'recent-parent');
    assert.equal(state(name, 'recent-parent').subagentCommands[0].auditBatchId, 'spawn-batch');
    assert.equal(state(name, 'older-parent').subagentCommands.length, 0);
    const pool = JSON.parse(fs.readFileSync(path.join(stateDir(name), 'last_spawn.json'), 'utf8'));
    assert.equal(pool.spawns.find((s) => s.parent === 'recent-parent').claimedBy, child);
    assert.equal(pool.pendingCount, 0);
  });
  await test('ambiguous parents cannot claim an unlinked child or bypass the file mutex', () => {
    const name = 'ambiguous-parent';
    seed(name, 'parent-a', { subagentCommands: [] });
    seed(name, 'parent-b', { subagentCommands: [] });
    seedSpawns(name, [{ parent: 'parent-a', ts: Date.now() - 1000, claimedBy: null },
      { parent: 'parent-b', ts: Date.now(), claimedBy: null }]);
    const payload = base('unlinked-child', { transcriptPath: '', lastUserInput: '[FLASH-WORKER] implement file',
      toolCall: { name: 'edit_file', args: { Path: small } } });
    assert.equal(decision(hook('guard-write-file.mjs', payload, name)), 'deny');
    assert.equal(state(name, 'unlinked-child').parentConversationId, undefined);
    const pool = JSON.parse(fs.readFileSync(path.join(stateDir(name), 'last_spawn.json'), 'utf8'));
    assert.equal(pool.pendingCount, 2);
    assert(pool.spawns.every((s) => !s.claimedBy));
  });
  await test('generated parent contract links concurrent parents without confusing source-code sender text', () => {
    const name = 'parent-contract';
    const a = hook('guard-subagent.mjs', dispatch('contract-a'), name).overwrite.Prompt;
    hook('guard-subagent.mjs', dispatch('contract-b'), name);
    assert(a.includes('[PRO-PARENT:contract-a]'));
    const payload = base('linked-child', { transcriptPath: '', lastUserInput: a + '\nsender=contract-b is a code example',
      toolCall: { name: 'run_command', args: { CommandLine: 'node local-check.mjs' } } });
    hook('guard-command.mjs', payload, name);
    assert.equal(state(name, 'linked-child').parentConversationId, 'contract-a');
    assert.equal(state(name, 'contract-a').subagentCommands.length, 1);
    assert.equal(state(name, 'contract-b').subagentCommands.length, 0);
    assert.equal(decision(hook('guard-write-file.mjs', { ...payload,
      toolCall: { name: 'edit_file', args: { Path: small } } }, name)), 'allow');
    const target = process.platform === 'win32' ? small.toLowerCase() : small;
    assert.equal(state(name, 'contract-a').batchFileClaims[target], 'linked-child');
    const repeat = hook('guard-subagent.mjs', dispatch('contract-a', {
      toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Model: 'flash', Prompt: a } } }), name);
    assert.equal(repeat.overwrite?.Prompt, undefined, 'generated contracts must remain idempotent');
    const rebased = hook('guard-subagent.mjs', dispatch('contract-b', {
      toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Model: 'flash', Prompt: a } } }), name).overwrite.Prompt;
    assert(!rebased.includes('[PRO-PARENT:contract-a]'));
    assert.equal(rebased.match(/\[PRO-PARENT:[^\]]+\]/g).length, 1);
    hook('guard-command.mjs', { ...payload, conversationId: 'rebased-child', lastUserInput: rebased }, name);
    assert.equal(state(name, 'rebased-child').parentConversationId, 'contract-b');
  });
  await test('legacy single-spawn state recovers a parent and migrates its claim', () => {
    const name = 'legacy-spawn';
    seed(name, 'legacy-parent', { subagentCommands: [] });
    fs.writeFileSync(path.join(stateDir(name), 'last_spawn.json'), JSON.stringify({ parent: 'legacy-parent', ts: Date.now() }));
    hook('guard-command.mjs', base('legacy-child', { transcriptPath: '', lastUserInput: '[FLASH-WORKER] task',
      toolCall: { name: 'run_command', args: { CommandLine: 'node check.mjs' } } }), name);
    assert.equal(state(name, 'legacy-child').parentConversationId, 'legacy-parent');
    const pool = JSON.parse(fs.readFileSync(path.join(stateDir(name), 'last_spawn.json'), 'utf8'));
    assert.equal(pool.spawns[0].claimedBy, 'legacy-child');
    assert.equal(pool.pendingCount, 0);
  });
  await test('a matching claimed spawn outranks a newer unrelated pending spawn and repairs cached child identity', () => {
    const name = 'cached-spawn-parent'; const child = 'cached-child';
    seed(name, child, { isSubAgent: true, subagentEvidence: 'contract' });
    seed(name, 'matched-parent', { subagentCommands: [] });
    seed(name, 'unrelated-parent', { subagentCommands: [] });
    seedSpawns(name, [
      { parent: 'matched-parent', ts: Date.now() - 5 * 60 * 1000, claimedBy: child },
      { parent: 'unrelated-parent', ts: Date.now(), claimedBy: null },
    ]);
    hook('guard-command.mjs', base(child, { transcriptPath: '', lastUserInput: 'continue',
      toolCall: { name: 'run_command', args: { CommandLine: 'node local-check.mjs' } } }), name);
    assert.equal(state(name, child).parentConversationId, 'matched-parent');
    assert.equal(state(name, 'matched-parent').subagentCommands.length, 1);
    assert.equal(state(name, 'unrelated-parent').subagentCommands.length, 0);
  });
  await test('expired, future, malformed, foreign-claimed and own-parent spawns cannot assign a parent', () => {
    const invalid = [
      { parent: 'bad-parent', ts: Date.now() - 10 * 60 * 1000, claimedBy: null },
      { parent: 'bad-parent', ts: Date.now() + 60000, claimedBy: null },
      { parent: 'bad-parent', ts: 'invalid', claimedBy: null },
      { parent: 'bad-parent', ts: Date.now(), claimedBy: 'someone-else' },
      { parent: 'orphan-child', ts: Date.now(), claimedBy: null }, null,
    ];
    for (const [i, spawn] of invalid.entries()) {
      const name = 'invalid-parent-' + i;
      seed(name, 'bad-parent', { subagentCommands: [] }); seedSpawns(name, [spawn]);
      hook('guard-command.mjs', base('orphan-child', { transcriptPath: '', lastUserInput: '[FLASH-WORKER] work',
        toolCall: { name: 'run_command', args: { CommandLine: 'node local-check.mjs' } } }), name);
      assert.equal(state(name, 'orphan-child').parentConversationId, undefined);
      assert.equal(state(name, 'bad-parent').subagentCommands.length, 0);
    }
    const name = 'mixed-invalid-parent';
    seed(name, 'valid-parent', { subagentCommands: [] });
    seedSpawns(name, [null, { ts: 'bad' }, { parent: 'valid-parent', ts: Date.now(), claimedBy: null }]);
    hook('guard-command.mjs', base('valid-child', { transcriptPath: '', lastUserInput: '[PRO-CONTRACT] work',
      toolCall: { name: 'run_command', args: { CommandLine: 'node local-check.mjs' } } }), name);
    assert.equal(state(name, 'valid-child').parentConversationId, 'valid-parent');
    assert.equal(state(name, 'valid-parent').subagentCommands.length, 1);
  });
  await test('explicit payload parent takes priority over a conflicting transcript sender', () => {
    const name = 'explicit-parent'; const file = path.join(TMP, 'conflicting-child.jsonl');
    fs.writeFileSync(file, JSON.stringify({ source: 'SYSTEM', content: '[Message] sender=other-parent work' }) + '\n');
    seed(name, 'explicit-parent', { subagentCommands: [] }); seed(name, 'other-parent', { subagentCommands: [] });
    hook('guard-command.mjs', base('explicit-child', { transcriptPath: file, parentConversationId: 'explicit-parent',
      toolCall: { name: 'run_command', args: { CommandLine: 'node local-check.mjs' } } }), name);
    assert.equal(state(name, 'explicit-child').parentConversationId, 'explicit-parent');
    assert.equal(state(name, 'explicit-parent').subagentCommands.length, 1);
    assert.equal(state(name, 'other-parent').subagentCommands.length, 0);
  });
  await test('readable main transcripts cannot recover a spawn parent from pasted sender contracts', () => {
    const name = 'pasted-main';
    seed(name, 'pending-parent', { subagentCommands: [] });
    seedSpawns(name, [{ parent: 'pending-parent', ts: Date.now(), claimedBy: null }]);
    hook('guard-command.mjs', base('ordinary-main', { lastUserInput: '[PRO-CONTRACT] sender=pending-parent pasted',
      toolCall: { name: 'run_command', args: { CommandLine: 'node local-check.mjs' } } }), name);
    assert.equal(state(name, 'ordinary-main').isSubAgent, false);
    assert.equal(state(name, 'ordinary-main').parentConversationId, undefined);
    assert.equal(state(name, 'pending-parent').subagentCommands.length, 0);
    const pool = JSON.parse(fs.readFileSync(path.join(stateDir(name), 'last_spawn.json'), 'utf8'));
    assert.equal(pool.pendingCount, 1); assert.equal(pool.spawns[0].claimedBy, null);
  });
  await test('parallel contract-only children claim distinct spawns and mirror commands without lost updates', async () => {
    const name = 'parallel-parent-recovery'; const parent = 'parallel-parent';
    seed(name, parent, { auditBatchId: 'parallel-batch', subagentCommands: [] });
    seedSpawns(name, Array.from({ length: 8 }, () => ({ parent, ts: Date.now(), claimedBy: null })));
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const payload = base('recovery-child-' + i, { transcriptPath: '', lastUserInput: '[PRO-CONTRACT] bounded work',
        toolCall: { name: 'run_command', args: { CommandLine: 'node check-' + i + '.mjs' } } });
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'guard-command.mjs')], {
        cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PRO_STATE_DIR: stateDir(name), PRO_MODE: 'enforce', PRO_HARNESS: 'antigravity' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
      child.once('error', reject); child.once('exit', (code) => {
        try { assert.equal(code, 0, stderr); assert.equal(decision(JSON.parse(stdout)), 'allow'); resolve(); }
        catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(payload));
    })));
    const pool = JSON.parse(fs.readFileSync(path.join(stateDir(name), 'last_spawn.json'), 'utf8'));
    assert.equal(pool.pendingCount, 0); assert.equal(new Set(pool.spawns.map((s) => s.claimedBy)).size, 8);
    const commands = state(name, parent).subagentCommands;
    assert.equal(commands.length, 8); assert.equal(new Set(commands.map((row) => row.conversationId)).size, 8);
    assert(commands.every((row) => row.auditBatchId === 'parallel-batch'));
    for (let i = 0; i < 8; i++)assert.equal(state(name, 'recovery-child-' + i).parentConversationId, parent);
  });
  await test('all patch operation kinds protect mode.json at any position', () => {
    const mode = path.join(stateDir('protected-patch'), 'mode.json');
    for (const operation of ['Update File:', 'Add File:', 'Delete File:', 'Move to:']) {
      const input = `*** Begin Patch\n*** Update File: ${small}\n${operation === 'Move to:' ? '' : '@@\n-old\n+new\n'}*** ${operation} ${mode}\n*** End Patch`;
      for (const extra of [{}, { agent_id: 'worker' }]) {
        assert.equal(decision(hook('guard-write-file.mjs', patchPayload(input, extra), 'protected-patch')), 'deny');
      }
    }
    assert.equal(fs.existsSync(mode), false, 'The hooks must not actually write configuration');
  });
  await test('multi-file patch quota is checked atomically', () => {
    const files = ['a.js', 'b.js', 'c.js'].map((file) => path.join(WORKSPACE, file));
    assert.equal(decision(hook('guard-write-file.mjs', patchPayload(patch(files)), 'patch-quota')), 'deny');
    assert.equal((state('patch-quota', 'patch-main').writesSinceDispatch || []).length, 0);
    assert.equal(decision(hook('guard-write-file.mjs', patchPayload(patch(files.slice(0, 2))), 'patch-quota')), 'allow');
    assert.equal(state('patch-quota', 'patch-main').writesSinceDispatch.length, 2);
    assert.equal(decision(hook('guard-write-file.mjs', patchPayload(patch(files.slice(2))), 'patch-quota')), 'deny');
  });
  await test('string patch payloads protect all targets too', () => {
    const mode = path.join(stateDir('string-patch'), 'mode.json');
    const input = patch([small, mode]);
    assert.equal(decision(hook('guard-write-file.mjs', patchPayload(input, { tool_input: input }), 'string-patch')), 'deny');
  });
  await test('ordinary Write arguments cannot spoof the internal patch path list', () => {
    const mode = path.join(stateDir('spoofed-write'), 'mode.json');
    const payload = { hook_event_name: 'PreToolUse', session_id: 'write-main', tool_name: 'Write', tool_input: { file_path: mode, content: '{}', _patchPaths: [] } };
    assert.equal(decision(hook('guard-write-file.mjs', payload, 'spoofed-write')), 'deny');
  });
  await test('timed-out session update does not run unlocked; retry preserves both increments', async () => {
    updateSession('lock-demo', (s) => { s.counter = 0; });
    const code = `import {updateSession} from ${JSON.stringify(libUrl)}; updateSession('lock-demo', s => { process.stdout.write('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500); s.counter += 1; });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    });
    try {
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      let called = false;
      assert.equal(updateSession('lock-demo', (s) => { called = true; s.counter += 1; }), null);
      assert.equal(called, false);
      await exited;
      assert.equal(readSession('lock-demo').counter, 1);
      assert(updateSession('lock-demo', (s) => { s.counter += 1; }));
      assert.equal(readSession('lock-demo').counter, 2);
    } finally { if (child.exitCode === null) { child.kill(); await exited.catch(() => {}); } }
  });
  await test('session persistence failure is reported and temporary state is cleaned up', () => {
    assert(updateSession('unwritable', (s) => { s.counter = 0; }));
    const originalWrite = fs.writeFileSync;
    const target = path.join(SESSION_DIR, 'unwritable.json');
    fs.writeFileSync = (file, ...args) => {
      if (String(file).startsWith(target)) throw Object.assign(new Error('simulated disk write failure'), { code: 'EACCES' });
      return originalWrite(file, ...args);
    };
    try { assert.equal(updateSession('unwritable', (s) => { s.counter = 1; }), null); }
    finally { fs.writeFileSync = originalWrite; }
    assert.equal(readSession('unwritable').counter, 0);
    assert(!fs.readdirSync(SESSION_DIR).some((name) => name.startsWith('unwritable.json.') && name.endsWith('.tmp')));
  });
  await test('failed parent-state persistence cannot admit an unprotected child write', () => {
    const name = 'claim-write-failure';
    fs.mkdirSync(sessionFile(name, 'unwritable-parent'), { recursive: true });
    const out = hook('guard-write-file.mjs', base('child-write-failure', {
      parentConversationId: 'unwritable-parent', toolCall: { name: 'edit_file', args: { Path: small } } }), name);
    assert.equal(decision(out), 'deny');
    assert(out.reason.includes('写入失败'));
  });
  await test('corrupt parent state cannot be reset into an empty file-claim map', () => {
    const name = 'corrupt-parent';
    seed(name, 'corrupt-parent', {});
    const file = sessionFile(name, 'corrupt-parent');
    fs.writeFileSync(file, '{incomplete claims');
    const out = hook('guard-write-file.mjs', base('corrupt-child', {
      parentConversationId: 'corrupt-parent', toolCall: { name: 'edit_file', args: { Path: small } } }), name);
    assert.equal(decision(out), 'deny');
    assert.equal(fs.readFileSync(file, 'utf8'), '{incomplete claims');
  });
  await test('aged live locks are not stolen; abandoned legacy locks recover', () => {
    const file = path.join(SESSION_DIR, 'live.lock');
    assert(acquireLock(file));
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(file, old, old);
    try { assert.equal(acquireLock(file, 40), false); }
    finally { releaseLock(file); }
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'legacy abandoned lock');
    fs.utimesSync(file, old, old);
    assert(acquireLock(file, 100));
    releaseLock(file);
  });
  for (const [script, toolCall] of [
    ['guard-read-file.mjs', { name: 'read_file', args: { Path: small, StartLine: 1, EndLine: 1 } }],
    ['guard-write-file.mjs', { name: 'write_file', args: { Path: small } }],
    ['guard-subagent.mjs', dispatch('busy').toolCall],
  ]) {
    await test(`${script} rejects an update when the session lock is busy`, () => {
      seed(script, 'busy', { isSubAgent: false });
      const file = path.join(stateDir(script), 'sessions', 'busy.lock');
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'held-by-test' }));
      const before = fs.readFileSync(sessionFile(script, 'busy'), 'utf8');
      try {
        const out = hook(script, base('busy', { toolCall }), script);
        assert.equal(decision(out), 'deny');
        assert.match(out.reason, /状态锁忙/);
        assert.equal(fs.readFileSync(sessionFile(script, 'busy'), 'utf8'), before);
      } finally { fs.unlinkSync(file); }
    });
  }
  await test('busy spawn pool is not written or claimed without its lock', () => {
    const before = fs.readFileSync(SPAWN_FILE, 'utf8');
    assert(acquireLock(SPAWN_LOCK));
    try {
      assert.equal(markSubagentSpawn('other-parent'), false);
      assert.equal(checkAndClaimSubagent('other-worker', 'parent-1'), null);
      assert.equal(fs.readFileSync(SPAWN_FILE, 'utf8'), before);
    } finally { releaseLock(SPAWN_LOCK); }
  });
  await test('reads, writes and elapsed time cannot reset the five-spawn turn quota', () => {
    for (let i = 0; i < 5; i += 1) assert.equal(decision(hook('guard-subagent.mjs', dispatch('quota-main'), 'quota')), 'allow');
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('quota-main'), 'quota')), 'deny');
    hook('guard-read-file.mjs', base('quota-main', { toolCall: { name: 'read_file', args: { Path: small, StartLine: 1, EndLine: 1 } } }), 'quota');
    hook('guard-write-file.mjs', base('quota-main', { toolCall: { name: 'write_file', args: { Path: small } } }), 'quota');
    const current = state('quota', 'quota-main');
    current.lastSpawnAt = Date.now() - 60000;
    seed('quota', 'quota-main', current);
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('quota-main'), 'quota')), 'deny');
    assert.equal(state('quota', 'quota-main').currentBatchSpawns, 5);
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('quota-main', { lastUserInput: 'new user task' }), 'quota')), 'allow');
    assert.equal(state('quota', 'quota-main').currentBatchSpawns, 1);
  });
  await test('identical user prompts still start a fresh quota via UserPromptSubmit', () => {
    for (let i = 0; i < 5; i += 1) hook('guard-subagent.mjs', dispatch('repeat-main'), 'repeat');
    hook('pre-invocation.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 'repeat-main', prompt: 'implement modules' }, 'repeat');
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('repeat-main'), 'repeat')), 'allow');
    assert.equal(state('repeat', 'repeat-main').currentBatchSpawns, 1);
  });
  await test('explicit turn IDs reset the quota without a prompt change', () => {
    for (let i = 0; i < 5; i += 1) hook('guard-subagent.mjs', dispatch('turn-main', { turnId: 'one' }), 'turns');
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('turn-main', { turnId: 'one' }), 'turns')), 'deny');
    assert.equal(decision(hook('guard-subagent.mjs', dispatch('turn-main', { turnId: 'two' }), 'turns')), 'allow');
  });
  await test('concurrent dispatch hooks share the same five-spawn quota', async () => {
    const payload = dispatch('concurrent-main');
    const jobs = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'guard-subagent.mjs')], {
        env: { ...process.env, PRO_STATE_DIR: stateDir('concurrent-quota'), PRO_MODE: 'enforce' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.once('error', reject);
      child.once('exit', (code) => {
        try { assert.equal(code, 0); resolve(decision(JSON.parse(stdout))); }
        catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(payload));
    }));
    const decisions = await Promise.all(jobs);
    assert.equal(decisions.filter((value) => value === 'allow').length, 5);
    assert.equal(decisions.filter((value) => value === 'deny').length, 3);
    assert.equal(state('concurrent-quota', 'concurrent-main').currentBatchSpawns, 5);
  });
  await test('Out-String -Stream, pager and unbounded tail pipelines do not bypass large-file checks', () => {
    for (const pipe of ['Out-String -Stream', 'more', 'tail -n +1', 'tail -f', 'head -n -1']) {
      assert.equal(decision(command(`Get-Content -LiteralPath "${big}" | ${pipe}`)), 'deny', pipe);
    }
    assert.equal(decision(command(`Get-Content -LiteralPath "${big}" | Out-String -Stream | Select-Object -First 20`)), 'allow');
  });
  await test('all positional and comma-separated file targets are checked', () => {
    for (const cmd of [
      `cat "${small}" "${big}"`, `cat ${small} ${big}`,
      `Get-Content -LiteralPath "${small}", "${big}"`,
      `Get-Content (Resolve-Path "${small}") (Resolve-Path "${big}")`,
    ]) assert.equal(decision(command(cmd)), 'deny', cmd);
  });
  await test('bounded output and ordinary file sinks remain allowed', () => {
    for (const cmd of [
      `cat "${small}" "${big}" | head -n 20`,
      `Get-Content "${big}" | Select-Object -First 20`,
      `cat "${big}" > "${path.join(WORKSPACE, 'output.log')}"`,
      `Get-Content "${big}" | Set-Content "${path.join(WORKSPACE, 'output.log')}"`,
    ]) assert.equal(decision(command(cmd)), 'allow', cmd);
  });
  await test('read-only mode queries pass in main sessions and workers', () => {
    const mode = path.join(stateDir('command'), 'mode.json');
    for (const cmd of [
      `Get-Content -LiteralPath "${mode}"`, `cat "${mode}"`,
      `Get-Content "${mode}" | Select-Object -First 1`,
      `rg -n 'mode.json' "${WORKSPACE}"`, `Write-Output 'mode.json'`,
      `powershell -Command 'Get-Content "${mode}"'`,
    ]) {
      assert.equal(decision(command(cmd)), 'allow', cmd);
      assert.equal(decision(command(cmd, {}, { parentConversationId: 'parent' })), 'allow', cmd);
    }
  });
  await test('mode writes, redirections, executable substitutions and unknown programs remain denied', () => {
    const mode = path.join(stateDir('command'), 'mode.json');
    for (const cmd of [
      `echo '{}' > "${mode}"`, `Set-Content "${mode}" '{}'`, `tee "${mode}"`,
      `Get-Content "${small}" | Set-Content "${mode}"`,
      `cat "${mode}" | tee "${mode}"`, `Remove-Item "${mode}"`,
      `Get-Content "${mode}" > ('mode' + '.json')`,
      `Get-Content "${mode}"; Set-Content "${mode}" '{}'`,
      `echo "$(Set-Content '${mode}' '{}')"`, `node -e 'write("${mode}")'`,
    ]) {
      assert.equal(decision(command(cmd)), 'deny', cmd);
      assert.equal(decision(command(cmd, {}, { parentConversationId: 'parent' })), 'deny', cmd);
    }
  });
  await test('CODEX_HOME cannot change Claude model routing', () => {
    for (const model of ['', 'claude-opus-4']) {
      const payload = { hook_event_name: 'PreToolUse', session_id: 'claude-main', model, tool_name: 'Task', tool_input: { model: 'opus', prompt: 'implement' } };
      const out = hook('guard-subagent.mjs', payload, 'platform', { CODEX_HOME: path.join(TMP, 'codex-home') });
      assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku');
    }
    const out = hook('guard-subagent.mjs', { hook_event_name: 'PreToolUse', session_id: 'codex-main', tool_name: 'spawn_agent', tool_input: { model: 'inherit', prompt: 'implement' } }, 'platform');
    assert.equal(out.hookSpecificOutput.updatedInput.model, 'gpt-5-mini');
  });
  await test('shadow records decisions without blocking or rewriting', () => {
    assert.equal(decision(command(`cat "${big}" | Out-String -Stream`, { PRO_MODE: 'shadow' })), 'allow');
    const mode = path.join(stateDir('shadow-patch'), 'mode.json');
    assert.equal(decision(hook('guard-write-file.mjs', patchPayload(patch([small, mode])), 'shadow-patch', { PRO_MODE: 'shadow' })), 'allow');
  });
} finally {
  const resolved = path.resolve(TMP);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pfo-regressions-')) throw new Error('Invalid regression cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(`\nRegression results: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
