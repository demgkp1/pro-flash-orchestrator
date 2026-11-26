#!/usr/bin/env node
// Local protocol tests. All mutations use injected actions or an in-memory
// preview; no real settings, updater, host credentials or UI automation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { startPanel } from '../sidecars/panel/main.mjs';

const uiToken = 'simulated-host-ui-token';
const defaults = { model: 'auto' };
const overrides = { research: null, self: 'flash' };
const install = { kind: 'installed', target: '/fixture/plugin', version: '1.0.0', canUpdate: true };
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
  t.after(() => new Promise((done, fail) => {
    server.close(error => error ? fail(error) : done());
    server.closeAllConnections();
  }));
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const base = `http://${address}:${port}`;
  return { calls, base, get: (path, options) => fetch(base + path, options), server };
}
async function errorResponse(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length);
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
  const { csrfToken, ...data } = await first.json();
  assert.match(csrfToken, /^[\w-]{40,}$/);
  assert.notEqual(csrfToken, uiToken);
  assert.deepEqual(data, { version: '1.0.0', settings: defaults, overrides, install });
  assert.deepEqual(await (await get('/api/state?token=ignored-on-GET')).json(), { ...data, csrfToken });
  for (const [path, type] of [['/?token=test&conversationId=synthetic', 'text/html'], ['/app.js?v=1', 'application/javascript'], ['/style.css', 'text/css']]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get('content-type').includes(type));
    const body = await r.text();
    assert.ok(body.length > 0);
    if (type === 'text/html') assert.match(body, /src=["']\/?preload\.js/);
  }
  for (const path of ['/index.html', '/sidecar.json', '/main.mjs', '/_sidecar/new-conversation', '/%2e%2e%2fscripts%2flib.mjs', '/other/../app.js']) {
    const result = await raw(base, path);
    assert.equal(result.status, 404, path);
    assert.equal(typeof result.json.error, 'string');
  }
  await errorResponse(await get('/api/update'), 405);
  await errorResponse(await get('/api/settings', { method: 'OPTIONS' }), 405);
  await errorResponse(await get('/api/state?url=https://invalid.example'), 400);
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
    assert.deepEqual(await (await get('/api/state')).json(), { version: install.version, settings: { model }, overrides, install, csrfToken });
  }
  assert.deepEqual(calls.write, models.map(model => ({ model })));
});

test('settings reject legacy pairs, extra fields and invalid models; JSON and byte limits precede actions', async t => {
  const { calls, get, base } = await fixture(t);
  const { csrfToken } = await (await get('/api/state')).json();
  for (const [path, data] of [
    ['/api/settings', null], ['/api/settings', []], ['/api/settings', { csrfToken }],
    ['/api/settings', { csrfToken, research: 'flash', self: 'inherit' }],
    ['/api/settings', { csrfToken, ...defaults, self: 'pro' }], ['/api/settings', { csrfToken, ...defaults, overrides }],
    ['/api/settings', { csrfToken, model: 'xhigh' }], ['/api/settings', { csrfToken, model: [] }],
    ['/api/settings', { csrfToken, ...defaults, ['__proto__']: {} }], ['/api/settings?model=pro', { csrfToken, ...defaults }],
    ['/api/update', { csrfToken, target: '/tmp' }], ['/api/update', { csrfToken, url: 'https://invalid.example' }],
    ['/api/update?command=test', { csrfToken }], ['/api/update?token=a&token=b', { csrfToken }],
  ]) await errorResponse(await get(path, asPost(data, auth)), 400);
  await errorResponse(await get('/api/settings', { ...asPost({}, auth), body: '{' }), 400);
  await errorResponse(await get('/api/settings', asPost({ csrfToken }, { ...auth, 'Content-Type': 'text/plain' })), 415);
  await errorResponse(await get('/api/settings', { ...asPost({}, auth), body: 'a'.repeat(5000) }), 413);
  const big = await raw(base, '/api/settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, chunks: ['a'.repeat(3000), 'b'.repeat(3000)] });
  assert.equal(big.status, 413);
  assert.equal(typeof big.json.error, 'string');
  assert.deepEqual(calls.write, []);
  assert.deepEqual(calls.update, []);
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
  try { await running; await errorResponse(await update(), 409); assert.equal(n, 1); }
  finally { release(); }
  const failure = await errorResponse(await first, 500);
  assert.equal(failure.includes('internal-token'), false);
  assert.deepEqual(await (await update()).json(), upgraded);
  assert.deepEqual(await (await update()).json(), { status: 'current', version: '1.1.0', previousVersion: '1.1.0' });
  const denied = await fixture(t, { actions: { inspectPanelInstall: () => ({ ...install, canUpdate: false, reason: 'Git checkout' }) } });
  const state = await (await denied.get('/api/state')).json();
  assert.equal(await errorResponse(await denied.get('/api/update', asPost({ csrfToken: state.csrfToken }, auth)), 403), 'Git checkout');
  assert.equal(denied.calls.update.length, 0);
});

test('browser preview persists only until close, serves no host bridge and never invokes either mutating action', async t => {
  const { calls, get, base } = await fixture(t, { preview: true, token: '' });
  assert.equal(await (await get('/preload.js')).text(), '');
  const { csrfToken, install: info, settings } = await (await get('/api/state')).json();
  assert.equal(info.canUpdate, false);
  assert.deepEqual(settings, defaults);
  const next = { model: 'pro' };
  const r = await get('/api/settings', asPost({ csrfToken, ...next }, { Origin: base }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { settings: next, overrides });
  assert.deepEqual((await (await get('/api/state')).json()).settings, next);
  await errorResponse(await get('/api/update', asPost({ csrfToken })), 403);
  await errorResponse(await get('/api/settings', asPost({ csrfToken, ...next }, { Origin: 'http://127.0.0.1:9', 'Sec-Fetch-Site': 'same-origin' })), 403);
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
  await errorResponse(await fetch(`${url}/api/settings`, asPost(invalid)), 401);
  await errorResponse(await fetch(`${url}/api/settings`, asPost(invalid, auth)), 400);
  child.kill('SIGTERM');
  await closed;
});
