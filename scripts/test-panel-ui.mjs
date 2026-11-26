// Optional browser smoke; no installs, external requests, real settings or releases.
// NODE_PATH may point at existing Playwright; PANEL_BROWSER selects Chromium; PANEL_SCREENSHOT is optional.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startPanel } from '../sidecars/panel/main.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const token = 'ui-smoke-only';
const currentVersion = '0.8.0', nextVersion = '0.8.1';
let settings = { model: 'auto' }, overrides = { research: null, self: 'flash_lite' };
let install = { kind: 'workspace', target: '/示例工作区/.gemini/plugins/pro-flash-orchestrator', version: currentVersion, canUpdate: true };
let saveError = true, updateResult = 'error', updateGate, releaseUpdate;
const actions = {
  readPanelSettings: () => settings, panelModelOverrides: () => overrides, inspectPanelInstall: () => install,
  writePanelSettings(next) { if (saveError) throw Error('fixture write failure'); return (settings = { ...next }); },
  async updateFromPanel() {
    if (updateResult === 'error') throw Error('fixture update failure');
    if (updateResult === 'current') return { status: 'current', version: install.version, previousVersion: install.version };
    await updateGate;
    const previousVersion = install.version; install = { ...install, version: nextVersion };
    return { status: 'updated', version: install.version, previousVersion };
  },
};
const browser = await chromium.launch(process.env.PANEL_BROWSER ? { executablePath: process.env.PANEL_BROWSER } : { channel: 'chrome' });
let host, preview, count = 0;
function pass(label) { console.log(`ok ${++count} - ${label}`); }
try {
  host = await startPanel({ preview: false, uiToken: token, actions });
  preview = await startPanel({ preview: true, actions });
  const url = s => `http://127.0.0.1:${s.address().port}`;
  const context = await browser.newContext({ colorScheme: 'dark', locale: 'zh-CN', viewport: { width: 800, height: 760 } });
  const requests = [], errors = [], outside = [];
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (![url(host), url(preview)].includes(u.origin)) { outside.push(u.origin); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) requests.push(r); });
  const $ = id => page.locator(`#${id}`), model = $('model'), policy = page.locator('details > summary');
  const langBtn = lang => page.locator(`.lang-switch button[data-lang="${lang}"]`);
  const message = (id, text) => $(id).filter({ hasText: text }).waitFor();
  const dirty = () => message('save-state', '未保存');
  const mutations = () => requests.filter(r => r.method() === 'POST');
  await page.goto(`${url(host)}/?token=${token}`); await message('save-state', '已保存');
  assert.equal(await page.title(), 'Pro-Flash Orchestrator');
  assert.equal(await page.locator('h1').innerText(), 'Pro-Flash Orchestrator');
  assert.deepEqual(requests.map(r => [r.method(), new URL(r.url()).pathname]), [['GET', '/api/state']]);
  assert.equal(requests[0].headers()['x-sidecar-token'], token);
  const { csrfToken } = await (await requests[0].response()).json();
  assert.equal(await $('panel-version').innerText(), `v${currentVersion}`);
  assert.equal(await model.inputValue(), 'auto');
  assert.equal(await $('auto-route-hint').isVisible(), true);
  pass('preload bridge precedes app; authenticated local state GET only');

  assert.equal(await page.locator('select, input, [role="combobox"], [role="tab"]').count(), 1);
  assert.deepEqual(await model.locator('option').evaluateAll(options => options.map(o => [o.value, o.label])), [
    ['auto', '自动（按路由策略）'], ['flash_lite', 'flash_lite: gemini 3.5 flash-lite'],
    ['flash', 'flash: gemini 4 hydrogen (high)'], ['pro', 'pro: gemini 4 hydrogen (xhigh)'],
    ['inherit', 'inherit: 继承主模型'],
  ]);
  assert.equal(await $('effort-value').innerText(), '跟随路由策略');
  for (const [value, effort] of [['flash_lite', '宿主默认'], ['flash', 'High'], ['inherit', '继承主模型'], ['pro', 'XHigh']]) {
    await model.selectOption(value); await dirty();
    assert.equal(await $('effort-value').innerText(), effort);
    assert.equal(await $('pro-guard').isVisible(), value === 'pro');
    assert.equal(await $('auto-route-hint').isHidden(), true);
  }
  assert.match(await $('pro-guard').innerText(), /\[FORCE-PRO\]/);
  assert.equal(await $('override-banner').isVisible(), true);
  assert.equal(await $('override-badge').isVisible(), true);
  await policy.click(); await message('override-note', '执行 flash_lite'); await policy.click();
  assert.equal(await $('update').isDisabled(), true);
  assert.equal(mutations().length, 0);
  pass('single model picker, exact labels/order, read-only reasoning and environment state, Pro guard');

  await $('save').click(); await message('settings-feedback', '草稿已保留');
  assert.equal(await model.inputValue(), 'pro'); assert.deepEqual(settings, { model: 'auto' });
  saveError = false; overrides = { research: 'pro', self: null };
  await $('save').click(); await message('settings-feedback', '已保存模型档位');
  assert.deepEqual(mutations().at(-1).postDataJSON(), { csrfToken, model: 'pro' });
  assert.deepEqual(settings, { model: 'pro' });
  await policy.click(); await message('override-note', '调研 pro'); await policy.click();
  if (process.env.PANEL_SCREENSHOT) {
    await page.setViewportSize({ width: 420, height: 480 });
    await page.screenshot({ path: process.env.PANEL_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 800, height: 760 });
  }
  const beforeReset = mutations().length;
  await $('reset').click(); await dirty(); assert.equal(mutations().length, beforeReset);
  assert.equal(await model.inputValue(), 'auto'); assert.equal(await $('pro-guard').isVisible(), true);
  assert.equal(await $('auto-route-hint').isVisible(), true);
  await $('discard').click(); assert.equal(await model.inputValue(), 'pro');
  overrides = { research: null, self: null };
  await $('reset').click(); await $('save').click(); await message('settings-feedback', '已保存模型档位');
  assert.deepEqual(settings, { model: 'auto' });
  assert.equal(await $('pro-guard').isHidden(), true);
  assert.equal(await $('override-banner').isHidden(), true);
  assert.equal(await $('override-badge').isHidden(), true);
  assert.equal(mutations().length, beforeReset + 1);
  pass('save failures keep drafts; reset and discard stay local; save sends only model and CSRF and refreshes overrides');

  await $('update').click(); await message('update-feedback', '更新未确认');
  assert.equal(await $('reload').isHidden(), true); assert.equal(await $('install-version').innerText(), `v${currentVersion}`);
  updateResult = 'current'; await $('update').click(); await message('update-feedback', `没有可用更新，已保留本机 v${currentVersion}。`);
  assert.doesNotMatch(await $('update-feedback').innerText(), /已是最新/);
  assert.equal(await $('reload').isHidden(), true);
  updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  updateResult = 'updated';
  const updateRequest = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/update'));
  await $('update').click(); await message('update-label', '更新中');
  assert.equal(await $('update').isDisabled(), true); assert.equal(await model.isDisabled(), true);
  assert.deepEqual((await updateRequest).postDataJSON(), { csrfToken });
  releaseUpdate(); await $('reload').waitFor(); await message('install-version', `v${nextVersion}`);
  assert.equal(await $('reload-lock-hint').isVisible(), true);
  assert.equal(await $('panel-version').innerText(), `v${currentVersion}`); // Open panel hasn't reloaded yet.
  await $('reload').click(); await message('panel-version', `v${nextVersion}`);
  pass('only explicit update POST; error/current/in-flight/success and real reload remain distinct');

  await langBtn('en').click();
  await message('save-state', 'Saved');
  assert.equal(await page.title(), 'Pro-Flash Orchestrator');
  assert.equal(await page.locator('h1').innerText(), 'Pro-Flash Orchestrator');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await langBtn('en').getAttribute('aria-pressed'), 'true');
  assert.equal(await langBtn('zh-CN').getAttribute('aria-pressed'), 'false');
  assert.equal(await $('route-title').innerText(), 'Subagent Routing');
  assert.equal(await $('effort-value').innerText(), 'Follows routing policy');
  assert.equal(await model.locator('option[value="inherit"]').evaluate(o => o.label), 'inherit: main model');
  assert.equal(await page.evaluate(() => localStorage.getItem('pfo.panel.lang')), 'en');
  await page.reload(); await message('save-state', 'Saved');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await $('route-title').innerText(), 'Subagent Routing');
  await langBtn('zh-CN').click(); await message('save-state', '已保存');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  assert.equal(await page.evaluate(() => localStorage.getItem('pfo.panel.lang')), 'zh-CN');
  await page.goto(`${url(host)}/?token=${token}&lang=en`); await message('save-state', 'Saved');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await page.goto(`${url(host)}/?token=${token}`); await message('save-state', '已保存');
  pass('bilingual UI switching, query override and localStorage persistence');

  await page.route('**/api/state', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      version: currentVersion,
      settings: { model: 'auto' },
      overrides: { research: null, self: null },
      install: { kind: 'git', target: '/repo', version: currentVersion, canUpdate: false, reasonCode: 'GIT_CHECKOUT' },
      runtime: { hasHydrogen: true, capabilitySource: 'cache', hydrogenId: null },
      updateCheck: { latestVersion: '0.9.0', releaseUrl: 'https://github.com/example/repo/releases/tag/v0.9.0', checkedAt: '2026-11-26T00:00:00Z' },
      csrfToken,
    }),
  }));
  await page.reload(); await message('install-kind', 'Git 工作树');
  await message('auto-route-hint', 'Hydrogen');
  await message('latest-version', 'v0.9.0');
  assert.equal(await $('latest-version-row').isVisible(), true);
  assert.equal(await $('latest-release-link').getAttribute('href'), 'https://github.com/example/repo/releases/tag/v0.9.0');
  await message('update-feedback', 'git pull');
  await langBtn('en').click();
  await message('update-feedback', 'Git worktrees cannot be updated');
  await langBtn('zh-CN').click();
  await page.unroute('**/api/state');
  pass('runtime hydrogen hint, updateCheck latest release row and localized reasonCode');

  await page.route('**/api/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '<img onerror="bad()">本机未就绪' }) }));
  await page.reload(); await $('retry').waitFor(); await message('connection-text', '<img');
  assert.equal(await $('connection').locator('img').count(), 0); assert.equal(await $('save').isDisabled(), true);
  await page.unroute('**/api/state'); await $('retry').click(); await message('save-state', '已保存');
  install = { ...install, kind: 'git', canUpdate: false, target: `/测试工作树/${'路径'.repeat(90)}`, reason: 'Git 工作树不能在此更新。' };
  const postCount = mutations().length;
  await page.goto(`${url(preview)}/`); await message('install-kind', 'Git 工作树');
  assert.equal(await $('update').isDisabled(), true); assert.equal(requests.at(-1).headers()['x-sidecar-token'], undefined);
  await page.setViewportSize({ width: 320, height: 700 }); await page.emulateMedia({ colorScheme: 'light' });
  await policy.click(); await model.selectOption('flash');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const wraps = await model.evaluate(el => getComputedStyle(el).appearance === 'base-select');
  if (wraps) {
    await page.setViewportSize({ width: 240, height: 700 });
    await model.click();
    assert.equal(await model.locator('option').evaluateAll(options => options.every(option => {
      const range = document.createRange(); range.selectNodeContents(option);
      const bounds = option.getBoundingClientRect(), lines = [...range.getClientRects()];
      return lines.length > 0 && lines.every(rect => rect.left >= bounds.left && rect.left >= 0 && rect.right <= innerWidth && rect.right <= bounds.right);
    })), true);
    await page.keyboard.press('Escape');
  }
  assert.equal(await $('reset').isVisible(), true); assert.equal(mutations().length, postCount);
  await $('discard').click(); assert.equal(await model.inputValue(), 'auto');
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  pass('recoverable load errors, browser preview, unsupported installs and readable narrow-screen model labels');
  console.log(`${count} browser smoke groups passed.`);
} finally {
  // A failed assertion while the mock updater is waiting must not hang cleanup.
  releaseUpdate?.();
  await browser.close();
  for (const s of [host, preview]) if (s) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
}
