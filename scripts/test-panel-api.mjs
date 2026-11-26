#!/usr/bin/env node
// Local protocol tests. All mutations use injected actions or an in-memory
// preview; no real settings, updater, host credentials or UI automation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { startPanel } from '../sidecars/panel/main.mjs';

const uiToken = 'simulated-host-ui-token';
const defaults = { model: 'auto' };
const overrides = { research: null, self: 'flash' };
const install = { kind: 'installed', target: '/fixture/plugin', version: '1.0.0', canUpdate: true, reasonCode: null };
const upgraded = { status: 'updated', version: '1.1.0', previousVersion: '1.0.0' };
const asPost = (data, headers) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
const auth = { 'X-Sidecar-Token': uiToken };

async function fixture(t, { preview = false, token = uiToken, actions: extra = {} } = {}) {
  const calls = { read: 0, inspect: 0, write: [], update: [] };
  let saved = { ...defaults };
  const actions = {
    readPanelSettings() { calls.read++; return saved; },
    panelModelOverrides: () => overrides,
    inspectPanelInstall() { calls.inspect++; return install; },
    writePanelSettings(next) { calls.write.push(next); return saved = { ...next }; },
    updateFromPanel(...args) { calls.update.push(args); return upgraded; },
    ...extra,
  };
  const server = await startPanel({ port: 0, preview, uiToken: token, actions });
  assert.ok(server.requestTimeout >= 60_000);
  t.after(() => new Promise((done, fail) => {
    server.close(error => error ? fail(error) : done());
    server.closeAllConnections();
  }));
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const base = `http://${address}:${port}`;
  return { calls, base, get: (path, options) => fetch(base + path, options), server };
}
async function errorResponse(response, status, expectedCode) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length);
  assert.equal(typeof body.code, 'string');
  assert.ok(body.code.length);
  if (expectedCode !== undefined) assert.equal(body.code, expectedCode);
  return body.error;
}
// Preserve the actual raw request target and chunk framing when fetch would
// normalize the path, drop a custom Host, or synthesize a Content-Length.
function raw(base, path, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((ok, fail) => {
    const req = request(base, { path, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', x => { text += x; }).on('end', () => ok({ status: res.statusCode, json: JSON.parse(text) })).on('error', fail);
    });
    req.on('error', fail);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('desktop GET shows local state without running an update; assets are an explicit allowlist', async t => {
  const { calls, base, get } = await fixture(t);
  const first = await get('/api/state');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('access-control-allow-origin'), null);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const { csrfToken, runtime, updateCheck, ...data } = await first.json();
  assert.match(csrfToken, /^[\w-]{40,}$/);
  assert.notEqual(csrfToken, uiToken);
  assert.deepEqual(data, { version: '1.0.0', settings: defaults, overrides, install });
  assert.equal(data.install.reasonCode, null);
  assert.deepEqual(Object.keys(runtime).sort(), ['capabilitySource', 'hasHydrogen', 'hydrogenId']);
  assert.ok(runtime.hasHydrogen === null || typeof runtime.hasHydrogen === 'boolean');
  assert.ok(runtime.capabilitySource === null || typeof runtime.capabilitySource === 'string');
  assert.ok(runtime.hydrogenId === null || typeof runtime.hydrogenId === 'string');
  assert.deepEqual(Object.keys(updateCheck).sort(), ['checkedAt', 'latestVersion', 'releaseUrl']);
  assert.ok(updateCheck.latestVersion === null || typeof updateCheck.latestVersion === 'string');
  assert.ok(updateCheck.releaseUrl === null || typeof updateCheck.releaseUrl === 'string');
  assert.ok(updateCheck.checkedAt === null || typeof updateCheck.checkedAt === 'string');
  assert.deepEqual(await (await get('/api/state?token=ignored-on-GET')).json(), { ...data, runtime, updateCheck, csrfToken });
  for (const [path, type] of [['/?token=test&conversationId=synthetic', 'text/html'], ['/app.js?v=1', 'application/javascript'], ['/style.css', 'text/css']]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get('content-type').includes(type));
    const body = await r.text();
    assert.ok(body.length > 0);
    if (type === 'text/html') assert.match(body, /src=["']\/?preload\.js/);
  }
  const i18nFile = fileURLToPath(new URL('../sidecars/panel/i18n.js', import.meta.url));
  const i18nRes = await get('/i18n.js');
  if (existsSync(i18nFile)) {
    assert.equal(i18nRes.status, 200, '/i18n.js');
    assert.equal(i18nRes.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.ok((await i18nRes.text()).length > 0);
  } else {
    assert.equal(i18nRes.status, 500, '/i18n.js route registered even before asset file exists');
    assert.equal((await i18nRes.json()).code, 'INTERNAL_ERROR');
  }
  for (const path of ['/index.html', '/sidecar.json', '/main.mjs', '/_sidecar/new-conversation', '/%2e%2e%2fscripts%2flib.mjs', '/other/../app.js']) {
    const result = await raw(base, path);
    assert.equal(result.status, 404, path);
    assert.equal(typeof result.json.error, 'string');
    assert.equal(result.json.code, 'NOT_FOUND');
  }
  await errorResponse(await get('/api/update'), 405, 'METHOD_NOT_ALLOWED');
  await errorResponse(await get('/api/settings', { method: 'OPTIONS' }), 405, 'METHOD_NOT_ALLOWED');
  await errorResponse(await get('/api/state?url=https://invalid.example'), 400, 'INVALID_QUERY');
  assert.equal(calls.inspect, 2);
  assert.deepEqual(calls.update, []);
});

test('native fetch bridge takes the iframe token and sends JSON, without exposing host operations', async t => {
  const { calls, get, base } = await fixture(t);
  const source = await (await get('/preload.js')).text();
  assert.equal(source.includes(uiToken), false);
  const page = new URL(`/?token=${uiToken}&conversationId=test`, base);
  const win = { location: page, fetch };
  const load = () => runInNewContext(source, { window: win, URL, URLSearchParams, Headers });
  load();
  assert.deepEqual(Object.keys(win.sidecar), ['fetch']);
  const { csrfToken } = await (await win.sidecar.fetch('/api/state')).json();
  const next = { model: 'flash_lite' };
  const result = await win.sidecar.fetch('/api/settings', { method: 'POST', body: JSON.stringify({ csrfToken, ...next }) });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { settings: next, overrides });
  assert.deepEqual(calls.write, [next]);
  await assert.rejects(win.sidecar.fetch('https://invalid.example/'), /same-origin/);
  const existing = { fetch() {} }; win.sidecar = existing; load();
  assert.equal(win.sidecar, existing); // do not replace the desktop's own bridge
});

test('POST requires the SDK token when configured (header before query) and an independent per-instance CSRF token', async t => {
  const { calls, get } = await fixture(t);
  const other = await fixture(t);
  const { csrfToken } = await (await get('/api/state')).json();
  const foreign = (await (await other.get('/api/state')).json()).csrfToken;
  const payload = { csrfToken, model: 'inherit' };
  await errorResponse(await get('/api/settings', asPost(payload)), 401);
  await errorResponse(await get(`/api/settings?token=${uiToken}`, asPost(payload, { 'X-Sidecar-Token': 'incorrect' })), 401);
  for (const wrong of [undefined, [], uiToken, foreign]) {
    await errorResponse(await get('/api/settings', asPost({ ...payload, csrfToken: wrong }, auth)), 403);
  }
  const ok = await get(`/api/settings?token=${uiToken}`, asPost(payload));
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.write, [{ model: 'inherit' }]);
});

test('native hosts without a UI token can save with same-origin CSRF protection', async t => {
  const { calls, get, base } = await fixture(t, { token: '' });
  const state = await get('/api/state');
  assert.equal(state.status, 200);
  const { csrfToken } = await state.json();
  const next = { model: 'inherit' };
  const local = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  await errorResponse(await get('/api/settings', asPost(next, local)), 403);
  await errorResponse(await get('/api/settings', asPost({ csrfToken, ...next }, { ...local, Origin: `${base}.invalid` })), 403);
  await errorResponse(await get('/api/settings', asPost({ csrfToken, ...next }, { ...local, Origin: 'http://localhost:30000', ...auth })), 403);
  assert.deepEqual(calls.write, []);
  const saved = await get('/api/settings', asPost({ csrfToken, ...next }, local));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { settings: next, overrides });
  assert.deepEqual(calls.write, [next]);
});

test('rejects foreign origins, rebinding and same-site sibling reads; native iframe and gateway still work', async t => {
  const { calls, get, base } = await fixture(t);
  const { csrfToken } = await (await get('/api/state')).json();
  const data = { csrfToken, ...defaults };
  for (const origin of ['https://invalid.example', 'null', `${base}.invalid`, 'http://127.0.0.1:9']) {
    await errorResponse(await get('/api/settings', asPost(data, { ...auth, Origin: origin })), 403);
  }
  for (const site of ['cross-site', 'same-site']) {
    await errorResponse(await get('/api/state', { headers: { 'Sec-Fetch-Site': site } }), 403);
  }
  const rebound = await raw(base, '/api/state', { headers: { Host: 'not.localhost.invalid', 'X-Forwarded-Host': new URL(base).host } });
  assert.equal(rebound.status, 403);
  assert.equal(typeof rebound.json.error, 'string');
  assert.equal(calls.write.length, 0);
  assert.equal((await get('/?token=test', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  assert.equal((await get('/api/settings', asPost(data, { ...auth, Origin: 'http://localhost:30000', 'Sec-Fetch-Site': 'same-origin' }))).status, 200);
});

test('one shared preference accepts each model alias without persisting role overrides', async t => {
  const { calls, get } = await fixture(t);
  const { csrfToken } = await (await get('/api/state')).json();
  const models = ['auto', 'flash_lite', 'flash', 'pro', 'inherit'];
  for (const model of models) {
    const saved = await get('/api/settings', asPost({ csrfToken, model }, auth));
    assert.equal(saved.status, 200, model);
    assert.deepEqual(await saved.json(), { settings: { model }, overrides });
    const state = await (await get('/api/state')).json();
    assert.deepEqual({ version: state.version, settings: state.settings, overrides: state.overrides, install: state.install, csrfToken: state.csrfToken },
      { version: install.version, settings: { model }, overrides, install, csrfToken });
  }
  assert.deepEqual(calls.write, models.map(model => ({ model })));
});

test('settings reject legacy pairs, extra fields and invalid models; JSON and byte limits precede actions', async t => {
  const { calls, get, base } = await fixture(t);
  const { csrfToken } = await (await get('/api/state')).json();
  for (const [path, data, code] of [
    ['/api/settings', null, 'INVALID_JSON'], ['/api/settings', [], 'INVALID_JSON'], ['/api/settings', { csrfToken }, 'INVALID_PAYLOAD'],
    ['/api/settings', { csrfToken, research: 'flash', self: 'inherit' }, 'INVALID_PAYLOAD'],
    ['/api/settings', { csrfToken, ...defaults, self: 'pro' }, 'INVALID_PAYLOAD'], ['/api/settings', { csrfToken, ...defaults, overrides }, 'INVALID_PAYLOAD'],
    ['/api/settings', { csrfToken, model: 'xhigh' }, 'INVALID_MODEL'], ['/api/settings', { csrfToken, model: [] }, 'INVALID_MODEL'],
    ['/api/settings', { csrfToken, ...defaults, ['__proto__']: {} }, 'INVALID_PAYLOAD'], ['/api/settings?model=pro', { csrfToken, ...defaults }, 'INVALID_QUERY'],
    ['/api/update', { csrfToken, target: '/tmp' }, 'INVALID_PAYLOAD'], ['/api/update', { csrfToken, url: 'https://invalid.example' }, 'INVALID_PAYLOAD'],
    ['/api/update?command=test', { csrfToken }, 'INVALID_QUERY'], ['/api/update?token=a&token=b', { csrfToken }, 'INVALID_QUERY'],
  ]) await errorResponse(await get(path, asPost(data, auth)), 400, code);
  await errorResponse(await get('/api/settings', { ...asPost({}, auth), body: '{' }), 400, 'INVALID_JSON');
  await errorResponse(await get('/api/settings', asPost({ csrfToken }, { ...auth, 'Content-Type': 'text/plain' })), 415, 'UNSUPPORTED_MEDIA_TYPE');
  await errorResponse(await get('/api/settings', { ...asPost({}, auth), body: 'a'.repeat(5000) }), 413, 'PAYLOAD_TOO_LARGE');
  const big = await raw(base, '/api/settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, chunks: ['a'.repeat(3000), 'b'.repeat(3000)] });
  assert.equal(big.status, 413);
  assert.equal(typeof big.json.error, 'string');
  assert.equal(big.json.code, 'PAYLOAD_TOO_LARGE');
  assert.deepEqual(calls.write, []);
  assert.deepEqual(calls.update, []);
  const brokenSave = await fixture(t, { actions: { writePanelSettings() { throw new Error('disk full'); } } });
  const brokenToken = (await (await brokenSave.get('/api/state')).json()).csrfToken;
  await errorResponse(await brokenSave.get('/api/settings', asPost({ csrfToken: brokenToken, model: 'flash' }, auth)), 500, 'SAVE_FAILED');
});

test('only one update enters at a time, errors release the lock and the updater gets no user arguments', async t => {
  let entered, release, n = 0;
  const running = new Promise(ok => { entered = ok; });
  const waitForRelease = new Promise(ok => { release = ok; });
  const { get } = await fixture(t, { actions: { async updateFromPanel(...args) {
    assert.deepEqual(args, []);
    n++;
    if (n === 1) { entered(); await waitForRelease; throw new Error('internal-token-like-fixture'); }
    return n === 2 ? upgraded : { status: 'current', version: '1.1.0', previousVersion: '1.1.0' };
  } } });
  const { csrfToken } = await (await get('/api/state')).json();
  const update = () => get('/api/update', asPost({ csrfToken }, auth));
  const first = update();
  try { await running; await errorResponse(await update(), 409, 'UPDATE_IN_PROGRESS'); assert.equal(n, 1); }
  finally { release(); }
  const failure = await errorResponse(await first, 500, 'UPDATE_FAILED');
  assert.equal(failure.includes('internal-token'), false);
  assert.deepEqual(await (await update()).json(), upgraded);
  assert.deepEqual(await (await update()).json(), { status: 'current', version: '1.1.0', previousVersion: '1.1.0' });
  const denied = await fixture(t, { actions: { inspectPanelInstall: () => ({ ...install, canUpdate: false, reasonCode: 'GIT_CHECKOUT', reason: 'Git checkout' }) } });
  const state = await (await denied.get('/api/state')).json();
  assert.equal(state.install.reasonCode, 'GIT_CHECKOUT');
  assert.equal(await errorResponse(await denied.get('/api/update', asPost({ csrfToken: state.csrfToken }, auth)), 403, 'UPDATE_UNSUPPORTED'), 'Git checkout');
  assert.equal(denied.calls.update.length, 0);
});

test('browser preview persists only until close, serves no host bridge and never invokes either mutating action', async t => {
  const { calls, get, base } = await fixture(t, { preview: true, token: '' });
  assert.equal(await (await get('/preload.js')).text(), '');
  const { csrfToken, install: info, settings, runtime, updateCheck } = await (await get('/api/state')).json();
  assert.equal(info.canUpdate, false);
  assert.equal(info.reasonCode, 'PREVIEW_MODE');
  assert.deepEqual(runtime, { hasHydrogen: true, capabilitySource: 'preview', hydrogenId: null });
  assert.deepEqual(updateCheck, { latestVersion: null, releaseUrl: null, checkedAt: null });
  assert.deepEqual(settings, defaults);
  const next = { model: 'pro' };
  const r = await get('/api/settings', asPost({ csrfToken, ...next }, { Origin: base }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { settings: next, overrides });
  assert.deepEqual((await (await get('/api/state')).json()).settings, next);
  await errorResponse(await get('/api/update', asPost({ csrfToken })), 403, 'UPDATE_UNSUPPORTED');
  await errorResponse(await get('/api/settings', asPost({ csrfToken, ...next }, { Origin: 'http://127.0.0.1:9', 'Sec-Fetch-Site': 'same-origin' })), 403, 'FORBIDDEN_ORIGIN');
  const independent = await fixture(t, { preview: true });
  assert.deepEqual((await (await independent.get('/api/state')).json()).settings, defaults);
  assert.equal(calls.read, 1);
  assert.deepEqual(calls.write, []);
  assert.deepEqual(calls.update, []);
});

test('CLI without the native environment never listens; bad arguments and partial host configuration fail closed', () => {
  const main = fileURLToPath(new URL('../sidecars/panel/main.mjs', import.meta.url));
  const run = (args = [], env = {}) => spawnSync(process.execPath, [main, ...args], { env, timeout: 4000, encoding: 'utf8' });
  const alone = run();
  assert.ifError(alone.error); assert.equal(alone.status, 0, alone.stderr); assert.match(alone.stdout, /--preview/);
  for (const [args, env] of [[['--other']], [['--preview', '-1']], [['--preview', '99999']], [['--preview', '0', '0.0.0.0']], [[], { ANTIGRAVITY_SIDECAR_WEB_PORT: '1234' }]]) {
    const result = run(args, env); assert.ifError(result.error); assert.equal(result.status, 1, JSON.stringify(args));
  }
});


test('explicit preview CLI prints its ephemeral loopback URL and reports the real local install without enabling updates', { timeout: 8000 }, async t => {
  const main = fileURLToPath(new URL('../sidecars/panel/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [main, '--preview', '0'], { stdio: ['ignore', 'pipe', 'ignore'], env: {
    // Reads, if any, are local to this checkout, not the user's preference file.
    PRO_STATE_DIR: fileURLToPath(new URL('.', import.meta.url)),
  } });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  child.stdout.setEncoding('utf8');
  let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('\n')) break; }
  const url = /^\[preview\] (http:\/\/127\.0\.0\.1:\d+)\//.exec(output)?.[1];
  assert.ok(url, 'preview printed its actual loopback URL');
  const res = await fetch(`${url}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.install.canUpdate, false);
  assert.equal(typeof state.version, 'string');
  await errorResponse(await fetch(`${url}/api/update`, asPost({ csrfToken: state.csrfToken })), 403);
  child.kill('SIGTERM');
  await closed;
});


test('native CLI honors host-assigned port and UI token without a sidecar_sdk resolver', { timeout: 8000 }, async t => {
  const { createServer } = await import('node:net');
  const reservation = createServer();
  await new Promise((ok, fail) => reservation.once('error', fail).listen(0, '127.0.0.1', ok));
  const { port } = reservation.address();
  await new Promise(done => reservation.close(done));
  const main = fileURLToPath(new URL('../sidecars/panel/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [main], { stdio: ['ignore', 'pipe', 'ignore'], env: {
    PRO_STATE_DIR: fileURLToPath(new URL('.', import.meta.url)), ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
    ANTIGRAVITY_CSRF_TOKEN: 'synthetic-ls-token', ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
    ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
    PRO_RESEARCH_MODEL: 'inherit', PRO_SELF_MODEL: 'flash_lite',
  } });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  child.stdout.setEncoding('utf8');
  let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('\n')) break; }
  assert.ok(output.includes(`[sidecar] listening on 127.0.0.1:${port}`));
  const url = `http://127.0.0.1:${port}`;
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(typeof state.csrfToken, 'string');
  assert.deepEqual(Object.keys(state.settings), ['model']);
  assert.deepEqual(state.overrides, { research: 'inherit', self: 'flash_lite' });
  assert.equal(JSON.stringify(state).includes(uiToken), false);
  const invalid = { csrfToken: state.csrfToken, model: false };
  await errorResponse(await fetch(`${url}/api/settings`, asPost(invalid)), 401, 'UNAUTHORIZED');
  await errorResponse(await fetch(`${url}/api/settings`, asPost(invalid, auth)), 400, 'INVALID_MODEL');
  child.kill('SIGTERM');
  await closed;
});

test('native /api/state exposes runtime capabilities, updateCheck metadata and safe null fallbacks', { timeout: 8000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'pfo-panel-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const checkedAtMs = 1732631340000;
  writeFileSync(join(stateDir, 'capabilities.json'), JSON.stringify({ hasHydrogen: true, source: 'cli' }));
  writeFileSync(join(stateDir, 'update-check.json'), JSON.stringify({
    latestVersion: '0.9.0',
    releaseUrl: 'https://github.com/demgkp1/pro-flash-orchestrator/releases/tag/v0.9.0',
    checkedAt: checkedAtMs,
  }));

  const { createServer } = await import('node:net');
  const reservation = createServer();
  await new Promise((ok, fail) => reservation.once('error', fail).listen(0, '127.0.0.1', ok));
  const { port } = reservation.address();
  await new Promise(done => reservation.close(done));

  const main = fileURLToPath(new URL('../sidecars/panel/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [main], { stdio: ['ignore', 'pipe', 'ignore'], env: {
    PRO_STATE_DIR: stateDir, ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
    ANTIGRAVITY_CSRF_TOKEN: 'synthetic-ls-token', ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
    ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
    PRO_HYDROGEN_ID: 'inherit',
  } });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  child.stdout.setEncoding('utf8');
  let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('\n')) break; }
  assert.ok(output.includes(`[sidecar] listening on 127.0.0.1:${port}`));

  const url = `http://127.0.0.1:${port}`;
  const first = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(first.runtime, { hasHydrogen: true, capabilitySource: 'cli', hydrogenId: 'inherit' });
  assert.deepEqual(first.updateCheck, {
    latestVersion: '0.9.0',
    releaseUrl: 'https://github.com/demgkp1/pro-flash-orchestrator/releases/tag/v0.9.0',
    checkedAt: new Date(checkedAtMs).toISOString(),
  });
  assert.ok(first.install.reasonCode === null || typeof first.install.reasonCode === 'string');

  writeFileSync(join(stateDir, 'capabilities.json'), '{broken-json');
  writeFileSync(join(stateDir, 'update-check.json'), '[]');
  const corrupted = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(corrupted.runtime, { hasHydrogen: null, capabilitySource: null, hydrogenId: 'inherit' });
  assert.deepEqual(corrupted.updateCheck, { latestVersion: null, releaseUrl: null, checkedAt: null });

  child.kill('SIGTERM');
  await closed;
});
