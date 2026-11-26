#!/usr/bin/env node
/** Local panel/AGY routing contract. All settings, caches and hook state live in a tempdir. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-panel-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const state = path.join(tmp, 'state');
const file = path.join(state, 'worker-settings.json');
const defaults = { model: 'auto' };
const models = ['auto', 'flash_lite', 'flash', 'pro', 'inherit'];
const envKeys = ['PRO_RESEARCH_MODEL', 'PRO_SELF_MODEL', 'PRO_WORKER_MODEL', 'PRO_HYDROGEN_ID', 'PRO_NATIVE_ORCHESTRATOR'];
Object.assign(process.env, { PRO_STATE_DIR: state, ARGON_STATE_DIR: '', PRO_HARNESS: 'antigravity', PRO_MODE: 'enforce', PRO_NO_UPDATE_CHECK: '1', PRO_TEST: '', ARGON_TEST: '' });
const { readPanelSettings, writePanelSettings, panelModelOverrides, targetWorkerModel, CAPABILITIES_FILE } = await import('./lib.mjs');
let sequence = 0;
beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  fs.mkdirSync(state, { recursive: true });
  fs.rmSync(file, { force: true });
  // Keep SessionStart offline even if the developer has a real agy installed.
  fs.writeFileSync(CAPABILITIES_FILE, JSON.stringify({ detectedAt: Date.now(), hasHydrogen: true, cliProbeSucceeded: true }));
});

function node(args, input, env = {}) {
  const result = spawnSync(process.execPath, args, { input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, ...env }, cwd: tmp, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const hook = (name, payload, env) => node([path.join(dir, `${name}.mjs`)], payload, env);
const main = extra => ({ conversationId: `panel-${++sequence}`, modelName: 'Gemini 4 Neon', lastUserInput: 'ordinary work', ...extra });
function dispatched(type, model, extra, prompt = 'bounded work', env) {
  const args = { TypeName: type, Prompt: prompt, ...(model === undefined ? {} : { Model: model }) };
  const out = hook('guard-subagent', main({ ...extra, toolCall: { name: 'invoke_subagent', args } }), env);
  assert.equal(out.decision, 'allow', JSON.stringify(out));
  assert(!Object.hasOwn(out.overwrite ?? {}, 'TypeName'), 'the dispatch type belongs to the caller');
  const effective = { ...args, ...out.overwrite };
  assert.match(effective.Prompt, type === 'research' ? /\[PRO-CONTRACT\] 【深度研报契约】/ : /\[PRO-CONTRACT\] 完成后仅回复四列表格/);
  assert.deepEqual(Object.keys(effective).sort(), (effective.Model === undefined ? ['Prompt','TypeName'] : ['Model','Prompt','TypeName']));
  return effective.Model;
}

test('settings contain one strict model; a missing or damaged file is auto', () => {
  assert.deepEqual(readPanelSettings(), defaults);
  assert(!fs.existsSync(file));
  for (const model of models) {
    assert.deepEqual(writePanelSettings({ model }), { model });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model });
    assert.deepEqual(readPanelSettings(), { model });
  }
  const original = fs.readFileSync(file, 'utf8');
  for (const value of [null, [], {}, { research: 'flash', self: 'flash' }, { model: 'flash', self: 'pro' }, { ...defaults, extra: 0 },
    { model: 'FLASH' }, { model: ' flash ' }, { model: 1 }, { model: 'bad' }, { ...defaults, [Symbol()]: true }]) {
    assert.throws(() => writePanelSettings(value), TypeError);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  for (const damaged of ['{broken', 'null', '[]', '{}', '{"model":"bad"}', '{"model":"pro","other":1}']) {
    fs.writeFileSync(file, damaged);
    assert.deepEqual(readPanelSettings(), defaults);
  }
  assert.equal(dispatched('research', 'pro', { lastUserInput: 'ordinary' }), 'flash');
});

test('legacy reads preserve unanimous valid models, use auto for conflicts, and do not rewrite the file', () => {
  function checkLegacy(settings, expected) {
    const original = JSON.stringify(settings, null, 4) + '\n';
    fs.writeFileSync(file, original);
    assert.deepEqual(readPanelSettings(), { model: expected });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  for (const model of models) checkLegacy({ research: model, self: model }, model);
  for (const settings of [{ research: 'pro', self: 'bad' }, { research: 'bad', self: 'bad' },
    { research: 'inherit' }, { research: 'pro', self: 'pro', other: 1 },
    { model: 'flash_lite', research: 'flash_lite', self: 'flash_lite' }]) checkLegacy(settings, 'auto');
  checkLegacy({ research: 'flash_lite', self: 'flash_lite' }, 'flash_lite');
  assert.equal(dispatched('research', 'inherit'), 'flash_lite');
  checkLegacy({ research: 'flash_lite', self: 'pro' }, 'auto');
  assert.equal(dispatched('research', 'flash_lite'), 'flash');
  assert.equal(dispatched('self', 'pro', { modelName: 'Gemini 4 Hydrogen' }), 'inherit');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { research: 'flash_lite', self: 'pro' });
  writePanelSettings({ model: 'inherit' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'inherit' });
});

test('one saved preference applies to research and self without changing the caller-selected TypeName', () => {
  writePanelSettings({ model: 'flash_lite' });
  const turn = { conversationId: 'same-user-turn' };
  assert.equal(dispatched('research', 'inherit', turn), 'flash_lite');
  assert.equal(dispatched('self', 'flash', turn), 'flash_lite');
});

test('a failed atomic rename throws, preserves the old setting and cleans up the temp file', () => {
  writePanelSettings({ model: 'inherit' });
  const previous = fs.readFileSync(file, 'utf8');
  const error = Object.assign(new Error('simulated failed rename'), { code: 'EPERM' });
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw error; };
    assert.throws(() => writePanelSettings(defaults), e => e === error);
  } finally { fs.renameSync = originalRename; }
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert(!fs.readdirSync(state).some(name => name.endsWith('.tmp')));
});

test('sidecar and hook share a writable per-user path regardless of PLUGIN_DATA; explicit state paths win', () => {
  const home = path.join(tmp, 'fake-home');
  const env = { HOME: home, USERPROFILE: home, PRO_STATE_DIR: '', ARGON_STATE_DIR: '' };
  const src = new URL('./lib.mjs', import.meta.url).href;
  const settings = { model: 'flash_lite' };
  const save = ['--input-type=module', '-e', `import {writePanelSettings} from ${JSON.stringify(src)}; console.log(JSON.stringify(writePanelSettings(${JSON.stringify(settings)})));`];
  const location = (folder) => path.join(folder, 'worker-settings.json');
  const userData = path.join(home, '.gemini', 'antigravity', 'plugin_data', 'pro-flash-orchestrator');
  assert.deepEqual(node(save, undefined, { ...env, PLUGIN_DATA: undefined }), settings);
  assert.deepEqual(JSON.parse(fs.readFileSync(location(userData), 'utf8')), settings);
  const hookData = path.join(tmp, 'hook-only-data');
  assert.equal(dispatched('research', 'flash', {}, undefined, { ...env, PLUGIN_DATA: hookData }), 'flash_lite');
  assert(!fs.existsSync(location(hookData)));
  const legacy = path.join(tmp, 'legacy'), preferred = path.join(tmp, 'preferred');
  node(save, undefined, { ...env, ARGON_STATE_DIR: legacy });
  assert(fs.existsSync(location(legacy)));
  fs.unlinkSync(location(legacy));
  node(save, undefined, { ...env, ARGON_STATE_DIR: legacy, PRO_STATE_DIR: preferred });
  assert(fs.existsSync(location(preferred)) && !fs.existsSync(location(legacy)));
});

test('each invoke resolves valid role env > global env > shared panel model > entitled Hydrogen override > default', () => {
  const shared = { model: 'flash_lite' };
  writePanelSettings(shared);
  process.env.PRO_HYDROGEN_ID = 'inherit';
  process.env.PRO_WORKER_MODEL = 'auto';
  assert.deepEqual(panelModelOverrides(), { research: null, self: null });
  assert.equal(dispatched('research', 'inherit'), 'flash_lite');
  assert.equal(dispatched('self', 'inherit'), 'flash_lite');
  writePanelSettings(defaults);
  assert.equal(dispatched('self', 'flash_lite'), 'inherit');
  writePanelSettings(shared);
  Object.assign(process.env, { PRO_RESEARCH_MODEL: 'broken-role', PRO_SELF_MODEL: ' FLASH_LITE ', PRO_WORKER_MODEL: 'flash' });
  assert.deepEqual(panelModelOverrides(), { research: 'flash', self: 'flash_lite' });
  assert.equal(dispatched('research', 'inherit'), 'flash');
  assert.equal(dispatched('self', 'inherit'), 'flash_lite');
  process.env.PRO_SELF_MODEL = 'pro';
  assert.deepEqual(panelModelOverrides(), { research: 'flash', self: 'pro' });
  assert.equal(targetWorkerModel('antigravity', 'self'), 'flash', 'no hook context is not authorization');
  assert.equal(dispatched('self', 'flash_lite'), 'flash');
  assert.equal(dispatched('self', 'flash_lite', { lastUserInput: '[FORCE-PRO]' }), 'pro');
  assert.deepEqual(readPanelSettings(), shared);
  for (const key of envKeys) delete process.env[key];
  writePanelSettings(defaults);
  process.env.PRO_HYDROGEN_ID = 'flash_lite';
  fs.writeFileSync(CAPABILITIES_FILE, JSON.stringify({ hasHydrogen: false, cliProbeSucceeded: true }));
  assert.equal(dispatched('self', 'pro'), 'flash');
  assert.equal(dispatched('self', 'pro', { modelName: 'Gemini 4 Hydrogen' }), 'inherit');
});

test('saved pro is an intent; only this turn’s user marker authorizes it, never the child prompt', () => {
  writePanelSettings({ model: 'pro' });
  const same = { conversationId: 'live-panel' };
  for (const mark of ['[FORCE-PRO]', '[force-pro]', '[FORCE-ARGON]', '[Force-Argon]']) {
    assert.equal(dispatched('self', 'flash', { ...same, lastUserInput: `review ${mark}` }), 'pro');
    assert.equal(dispatched('self', '"pro"', same, `please ${mark}`), 'flash');
  }
  assert.equal(dispatched('self', 'pro', { lastUserInput: '[ALLOW-PRO]' }), 'flash');
  assert.equal(dispatched('self', 'pro', { ...same, lastUserInput: undefined, prompt: '[FORCE-PRO]' }), 'flash');
  assert.equal(dispatched('self', undefined, { modelName: 'Gemini 4 Hydrogen' }), 'inherit');
  assert.equal(dispatched('research', 'pro', same), 'flash');
  assert.equal(dispatched('research', 'flash', { ...same, lastUserInput: '[FORCE-PRO]' }), 'pro');
  writePanelSettings({ model: 'inherit' });
  assert.equal(dispatched('research', 'flash_lite', same), 'inherit');
  writePanelSettings(defaults);
  const authorized = { lastUserInput: '[FORCE-PRO] choose a tier' };
  for (const model of ['pro', '"PrO"', 'flash_lite', 'inherit', 'flash', 'host-model-id', undefined]) {
    assert.equal(dispatched('self', model, authorized), model);
  }
});

test('SessionStart card and injected guidance match the ordinary or authorized guard result for each role', () => {
  writePanelSettings({ model: 'pro' });
  for (const [extra, expected] of [[{}, 'flash'], [{ modelName: 'Gemini 4 Hydrogen' }, 'inherit'], [{ lastUserInput: '[FORCE-ARGON]' }, 'pro']]) {
    const card = hook('session-start', main(extra)).injectSteps[0].systemMessage;
    for (const text of [card.systemMessage, card.renderInfo.markdown]) {
      assert(text.includes(`TypeName="research", Model="${expected}"`));
      assert(text.includes(`TypeName="self", Model="${expected}"`));
      assert.match(text, /用户原话.*\[FORCE-PRO\].*\[FORCE-ARGON\]/);
    }
    assert.equal(dispatched('research', 'flash_lite', extra), expected);
    assert.equal(dispatched('self', undefined, extra), expected);
  }
});

test('native Lite does not apply panel/env choices; explicit pro still needs user authorization', () => {
  writePanelSettings({ model: 'pro' });
  process.env.PRO_WORKER_MODEL = 'pro';
  const native = { modelName: 'Orchestrator (Neon)' };
  for (const model of ['flash_lite', 'host-native-id', undefined]) assert.equal(dispatched('self', model, native), model);
  assert.equal(dispatched('self', '"pro"', native, '[FORCE-PRO]'), 'flash');
  assert.equal(dispatched('self', 'pro', { ...native, lastUserInput: '[force-argon]' }), 'pro');
  assert.equal(dispatched('self', 'flash_lite', { ...native, lastUserInput: '[FORCE-PRO]' }), 'flash_lite');
  const card = hook('session-start', main(native)).injectSteps[0].systemMessage;
  assert.match(card.renderInfo.markdown, /Lite Guard Mode/);
  assert.match(card.systemMessage, /原生.*用户原话/);
  assert(!card.systemMessage.includes('invoke_subagent('));
});

test('AGY panel settings do not affect Claude/Codex worker arguments or their force conventions', () => {
  writePanelSettings({ model: 'flash_lite' });
  for (const [host, tool, worker, requested] of [['codex','spawn_agent','gpt-5-mini','gpt-expensive'], ['claude','Agent','haiku','opus']]) {
    const invoke = (user, prompt) => {
      const payload = { session_id: `host-${++sequence}`, hook_event_name: 'PreToolUse', lastUserInput: user, tool_name: tool,
        tool_input: { model: requested, ...(host === 'codex' ? { message: prompt } : { prompt }) } };
      const out = hook('guard-subagent', payload, { PRO_HARNESS: host }).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'allow');
      return out.updatedInput.model;
    };
    assert.equal(invoke('work', 'work'), worker);
    assert.equal(invoke('[FORCE-PRO]', 'work'), requested);
    assert.equal(invoke('work', '[FORCE-PRO]'), host === 'codex' ? worker : requested);
  }
});
