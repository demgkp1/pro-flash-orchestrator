import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES_FILE,
  INVOCABLE_SUBAGENT_MODELS,
  PLUGIN_VERSION,
  UPDATE_CHECK_FILE,
  panelModelOverrides,
  readPanelSettings,
  writePanelSettings,
} from '../../scripts/lib.mjs';
import { inspectPanelInstall, updateFromPanel } from '../../scripts/update.mjs';

const LOOPBACK = '127.0.0.1';
const LOCAL_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;
const MAX_BODY = 4096;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'application/javascript']],
  ['/i18n.js', ['i18n.js', 'application/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);
const API_METHODS = new Map([['/api/state', 'GET'], ['/api/settings', 'POST'], ['/api/update', 'POST']]);
const installed = { readPanelSettings, writePanelSettings, panelModelOverrides, inspectPanelInstall, updateFromPanel };

// The installed SDK's preload takes ?token= from the iframe URL and sends
// X-Sidecar-Token. Implement only the fetch surface (no agentapi, metadata or
// conversation endpoints). Never embed a server-side token in a public asset.
const HOST_PRELOAD = `(() => {
  if (typeof window.sidecar?.fetch === 'function') return;
  const token = new URLSearchParams(window.location.search).get('token');
  const bridge = window.sidecar || (window.sidecar = {});
  bridge.fetch = async (path, options = {}) => {
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin) throw new TypeError('Expected a same-origin panel URL');
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Sidecar-Token', token);
    return window.fetch(url, { ...options, headers, mode: 'same-origin', credentials: 'same-origin', redirect: 'error' });
  };
})();\n`;

class PanelError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const reject = (status, code, message) => { throw new PanelError(status, code, message); };
function matchesSecret(input, secret) {
  if (typeof input !== 'string' || !secret) return false;
  const a = Buffer.from(input), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonObject(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function readRuntimeInfo(preview) {
  if (preview) return { hasHydrogen: true, capabilitySource: 'preview', hydrogenId: null };
  const data = await readJsonObject(CAPABILITIES_FILE);
  const rawHydrogenId = typeof process.env.PRO_HYDROGEN_ID === 'string' ? process.env.PRO_HYDROGEN_ID.trim() : '';
  const source = typeof data?.source === 'string' && data.source.trim()
    ? data.source.trim()
    : (typeof data?.capabilitySource === 'string' && data.capabilitySource.trim() ? data.capabilitySource.trim() : null);
  return {
    hasHydrogen: typeof data?.hasHydrogen === 'boolean' ? data.hasHydrogen : null,
    capabilitySource: source,
    hydrogenId: rawHydrogenId || null,
  };
}

async function readUpdateCheckInfo(preview) {
  if (preview) return { latestVersion: null, releaseUrl: null, checkedAt: null };
  const data = await readJsonObject(UPDATE_CHECK_FILE);
  let checkedAt = null;
  if (typeof data?.checkedAt === 'number' && Number.isFinite(data.checkedAt) && data.checkedAt > 0) {
    checkedAt = new Date(data.checkedAt).toISOString();
  } else if (typeof data?.checkedAt === 'string' && data.checkedAt.trim()) {
    checkedAt = data.checkedAt.trim();
  }
  return {
    latestVersion: typeof data?.latestVersion === 'string' && data.latestVersion.trim() ? data.latestVersion.trim() : null,
    releaseUrl: typeof data?.releaseUrl === 'string' && data.releaseUrl.trim() ? data.releaseUrl.trim() : null,
    checkedAt,
  };
}

function checkCaller(req, { preview, api, authenticated }) {
  const { host, origin, 'sec-fetch-site': site } = req.headers;
  const local = LOCAL_AUTHORITY.exec(host || '');
  if (!local || (local[1] && (+local[1] < 1 || +local[1] > 65535)) ||
      (preview && Number(local[1] || 80) !== req.socket.localPort)) reject(403, 'FORBIDDEN_ORIGIN', '非本机面板请求。');
  if (!api) return; // An aux pane is legitimately framed by the desktop host.
  if (site && site !== 'same-origin' && site !== 'none') reject(403, 'FORBIDDEN_ORIGIN', '不接受跨源面板请求。');
  if (origin === undefined || origin === `http://${host}` || (!preview && origin === `https://${host}`)) return;
  // The native per-sidecar gateway can forward a browser request on a different
  // loopback port from the listener. Require BOTH fetch metadata and the SDK
  // token before accepting that case; never trust X-Forwarded-* from callers.
  if (!preview && authenticated && site === 'same-origin' && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(origin)) return;
  reject(403, 'FORBIDDEN_ORIGIN', '不接受跨源面板请求。');
}

async function readInput(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须为 JSON。');
  if (Number(req.headers['content-length']) > MAX_BODY) reject(413, 'PAYLOAD_TOO_LARGE', '请求体过大。');
  let size = 0;
  const chunks = [];
  // Do not destroy the socket on early return: a chunked oversized request must
  // receive a JSON 413 too, without accumulating an unbounded body in memory.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) reject(413, 'PAYLOAD_TOO_LARGE', '请求体过大。');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { reject(400, 'INVALID_JSON', '无效的 JSON。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) reject(400, 'INVALID_JSON', '请求体必须为 JSON 对象。');
  return data;
}

function exactKeys(data, keys) {
  if (Object.keys(data).length !== keys.length || !keys.every(k => Object.hasOwn(data, k))) reject(400, 'INVALID_PAYLOAD', '请求字段无效。');
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function panelHandler({ preview, uiToken, actions }) {
  const csrfToken = randomBytes(32).toString('base64url');
  let memorySettings;
  let updating = false;
  async function inspect() {
    const raw = await actions.inspectPanelInstall(); // local manifest only
    const install = { ...raw, reasonCode: raw.reasonCode ?? (raw.canUpdate ? null : 'UPDATE_UNSUPPORTED') };
    return preview ? { ...install, canUpdate: false, reasonCode: 'PREVIEW_MODE', reason: '浏览器预览不更新真实插件。' } : install;
  }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Match the raw path, not a normalized filesystem path. Query metadata on
    // the host's initial / navigation (token, conversationId, etc.) is fine.
    const i = req.url.indexOf('?');
    const path = i === -1 ? req.url : req.url.slice(0, i);
    const query = new URLSearchParams(i === -1 ? '' : req.url.slice(i + 1));
    try {
      const method = API_METHODS.get(path);
      const authenticated = matchesSecret(req.headers['x-sidecar-token'] || query.get('token'), uiToken);
      checkCaller(req, { preview, api: !!method, authenticated });
      if (!method && path !== '/preload.js' && !ASSETS.has(path)) reject(404, 'NOT_FOUND', '接口不存在。');
      if (req.method !== (method || 'GET')) { res.setHeader('Allow', method || 'GET'); reject(405, 'METHOD_NOT_ALLOWED', '不支持此请求方法。'); }
      if (!method) {
        const [file, type] = ASSETS.get(path) || [null, 'application/javascript'];
        const content = file ? await readFile(new URL(file, import.meta.url)) : (preview ? '' : HOST_PRELOAD);
        if (path === '/') res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'" + (preview ? "; frame-ancestors 'none'" : ''));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(content);
        return;
      }
      // Like SidecarApp, GET does not require the host's UI token. POST uses
      // the header (preferred) or ?token= when the host supplies a UI token.
      // Mutation arguments are accepted only in the JSON body.
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if ([...query.keys()].some(k => k !== 'token') || query.getAll('token').length > 1) reject(400, 'INVALID_QUERY', '接口不接受查询参数。');
      if (method === 'GET') {
        const [install, settings, overrides, runtime, updateCheck] = await Promise.all([
          inspect(),
          memorySettings ?? actions.readPanelSettings(),
          actions.panelModelOverrides(),
          readRuntimeInfo(preview),
          readUpdateCheckInfo(preview),
        ]);
        json(res, 200, { version: install.version || PLUGIN_VERSION, settings, overrides, install, runtime, updateCheck, csrfToken });
        return;
      }
      // Older hosts may omit the UI token. Keep the caller checks above and
      // the panel's own CSRF requirement even when no SDK token is configured.
      if (!preview && uiToken && !authenticated) reject(401, 'UNAUTHORIZED', '宿主令牌无效，请从 AGY 重新打开面板。');
      const data = await readInput(req);
      if (!matchesSecret(data.csrfToken, csrfToken)) reject(403, 'INVALID_CSRF', '面板令牌无效，请刷新后重试。');
      if (path === '/api/settings') {
        exactKeys(data, ['csrfToken', 'model']);
        const { model } = data;
        if (model !== 'auto' && !INVOCABLE_SUBAGENT_MODELS.has(model)) reject(400, 'INVALID_MODEL', '未知的子代理档位。');
        const next = { model };
        const settings = preview ? (memorySettings = next) : await actions.writePanelSettings(next);
        json(res, 200, { settings, overrides: await actions.panelModelOverrides() });
        return;
      }
      exactKeys(data, ['csrfToken']);
      if (preview) reject(403, 'UPDATE_UNSUPPORTED', '浏览器预览不更新真实插件。');
      if (updating) reject(409, 'UPDATE_IN_PROGRESS', '更新正在进行，请勿重复提交。');
      updating = true;
      try {
        const install = await inspect();
        if (!install.canUpdate) reject(403, 'UPDATE_UNSUPPORTED', install.reason || '此安装不支持面板更新。');
        const { status, version, previousVersion } = await actions.updateFromPanel(); // no caller-supplied options
        if (!['updated', 'current'].includes(status) || typeof version !== 'string' || typeof previousVersion !== 'string') throw new Error('Invalid update result');
        json(res, 200, { status, version, previousVersion });
      } finally { updating = false; }
    } catch (error) {
      req.resume();
      if (res.destroyed || res.headersSent) return;
      if (error instanceof PanelError && error.status === 413) res.setHeader('Connection', 'close');
      const fallback = path === '/api/update'
        ? { code: 'UPDATE_FAILED', message: '更新未完成，请检查网络和本机安装目录后重试。' }
        : path === '/api/settings'
          ? { code: 'SAVE_FAILED', message: '保存失败，请检查插件数据目录的写权限。' }
          : { code: 'INTERNAL_ERROR', message: '无法读取面板数据。' };
      json(res, error instanceof PanelError ? error.status : 500, {
        error: error instanceof PanelError ? error.message : fallback.message,
        code: error instanceof PanelError ? error.code : fallback.code,
      });
    }
  };
}

// Programmatic tests inject only these five fixed actions. Network clients can
// never choose a bind address, file, executable, installation target or URL.
export async function startPanel({ port = 0, preview = true, uiToken = '', actions = installed } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid panel port.');
  const server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000 }, panelHandler({ preview, uiToken, actions }));
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, LOOPBACK, () => { server.off('error', fail); ok(); });
  });
  return server;
}

function portNumber(value, allowZero) {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535 || (!allowZero && Number(value) === 0)) throw new Error('Invalid panel port.');
  return Number(value);
}
function launchOptions(args, env) {
  if (args.length) {
    if (args[0] !== '--preview' || args.length > 2) throw new Error('Usage: node main.mjs --preview [port]');
    return { preview: true, port: portNumber(args[1] ?? '0', true) };
  }
  if (env.ANTIGRAVITY_SIDECAR_WEB_PORT === undefined) return null;
  if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) throw new Error('Incomplete Antigravity sidecar environment. For browser preview, pass --preview [port].');
  return { preview: false, port: portNumber(env.ANTIGRAVITY_SIDECAR_WEB_PORT, false), uiToken: env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = launchOptions(process.argv.slice(2), process.env);
    if (!options) console.log('Start this panel in Antigravity, or run: node main.mjs --preview [port]');
    else {
      // Windows holds the process cwd open. Do not pin the installed sidecar
      // directory across a release replacement; assets use import.meta.url.
      if (!options.preview && process.platform === 'win32') process.chdir(tmpdir());
      const server = await startPanel(options);
      const addr = `${LOOPBACK}:${server.address().port}`;
      console.log(options.preview ? `[preview] http://${addr}/ (in-memory settings; updates disabled)` : `[sidecar] listening on ${addr}`);
      const stop = () => { server.close(); server.closeIdleConnections?.(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
