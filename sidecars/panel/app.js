(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const efforts = { auto: '跟随路由策略', flash_lite: '宿主默认', flash: 'High', pro: 'XHigh', inherit: '继承主模型' };
  const installKinds = { global: '全局安装', workspace: '工作区安装', custom: '自定义安装', git: 'Git 工作树', unsupported: '不支持更新' };
  const standalone = typeof window.sidecar?.fetch !== 'function';
  const fetchLocal = standalone ? window.fetch.bind(window) : window.sidecar.fetch.bind(window.sidecar);
  let state = null, draft = null, busy = 'load', release = null;
  const text = value => typeof value === 'string' && value.trim() !== '';
  const isModel = model => typeof model === 'string' && Object.hasOwn(efforts, model);
  const isOverride = model => model === null || (model !== 'auto' && isModel(model));
  const versionLabel = version => /^v/i.test(version) ? version : `v${version}`;
  const valid = flag => { if (!flag) throw new Error('本机服务返回的数据不完整，请重新打开面板核对。'); };
  function readSettings(data) {
    const model = data?.settings?.model, { research, self } = data?.overrides ?? {};
    valid(isModel(model) && isOverride(research) && isOverride(self));
    return { settings: { model }, overrides: { research, self } };
  }
  async function request(path, body) {
    const response = await fetchLocal(path, body === undefined ? { method: 'GET', cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(text(data?.error) ? data.error : `本机服务返回 HTTP ${response.status}。`);
    valid(data && typeof data === 'object');
    return data;
  }
  function write(id, message, tone = '') {
    const el = $(id);
    if (el.textContent !== message) el.textContent = message;
    el.dataset.tone = tone;
  }
  const isDirty = () => !!state && draft !== state.settings.model;
  const editable = () => !!state && !busy && release?.status !== 'updated';

  function render() {
    const dirty = isDirty(), canEdit = editable();
    $('model').disabled = !canEdit;
    if (state) {
      $('model').value = draft;
      write('effort-value', efforts[draft]);
      const { research, self } = state.overrides;
      const showGuard = draft === 'pro' || research === 'pro' || self === 'pro';
      $('pro-guard').hidden = !showGuard;
      $('model').setAttribute('aria-describedby', `model-effort model-note${showGuard ? ' pro-guard' : ''}`);
      const overrides = [research && `调研 ${research}`, self && `执行 ${self}`].filter(Boolean);
      $('override-badge').hidden = $('override-note').hidden = !overrides.length;
      if (overrides.length) write('override-note', `当前环境变量覆盖（只读）：${overrides.join('、')}。`);
    }
    $('reset').disabled = !canEdit || draft === 'auto';
    $('save').disabled = !canEdit || !dirty;
    $('save-label').textContent = busy === 'save' ? '保存中…' : '保存设置';
    write('save-state', !state ? (busy ? '读取中' : '未连接') : busy === 'save' ? '保存中' : dirty ? '未保存' : '已保存', !state ? '' : busy === 'save' ? 'busy' : dirty ? 'dirty' : 'ok');
    $('update').hidden = release?.status === 'updated';
    $('reload').hidden = release?.status !== 'updated';
    $('update').disabled = !state?.install.canUpdate || !canEdit || dirty;
    $('update-label').textContent = busy === 'update' ? '更新中…' : '获取最新版本';
    $('discard').hidden = !dirty || !canEdit;
    let message = '点击后检查 GitHub Release，有新版时下载并替换。', tone = '';
    if (busy === 'update') { message = '正在检查最新版本，有新版时将下载并替换当前安装…'; tone = 'busy'; }
    else if (state && !state.install.canUpdate) message = state.install.reason || '此安装不能从面板更新。';
    else if (dirty) message = '更新前请保存或撤销未保存的更改。';
    else if (release) { message = release.message; tone = release.tone; }
    write('update-feedback', message, tone);
  }
  function feedbackForDraft(prefix = '') {
    const dirty = isDirty();
    write('settings-feedback', prefix || (dirty ? '档位有未保存的更改；保存后生效。' : '与已保存的设置一致。'), dirty ? 'dirty' : '');
  }
  async function load() {
    busy = 'load'; $('retry').hidden = true; $('retry').disabled = true;
    $('connection').hidden = false; $('connection').dataset.tone = '';
    write('connection-text', '正在读取本机设置与安装信息…'); render();
    try {
      const data = await request('/api/state'), config = readSettings(data), install = data.install;
      valid(text(data.csrfToken) && text(data.version) && Object.hasOwn(installKinds, install?.kind) && typeof install.canUpdate === 'boolean');
      state = { ...config, csrfToken: data.csrfToken, install }; draft = config.settings.model;
      const version = versionLabel(data.version);
      write('panel-version', version); $('panel-version').setAttribute('aria-label', `面板版本 ${version}`);
      write('install-kind', installKinds[install.kind]); write('install-target', text(install.target) ? install.target : '未识别安装路径');
      write('install-version', text(install.version) ? versionLabel(install.version) : '未识别');
      $('connection').hidden = true;
      write('settings-feedback', standalone ? '浏览器预览：保存仅对本次预览生效。' : '更改只在保存后生效。');
    } catch (err) {
      $('connection').dataset.tone = 'error'; $('retry').hidden = false; $('retry').disabled = false;
      write('connection-text', `无法读取本机面板：${err.message}`);
      write('install-kind', '未识别'); write('install-version', '未读取'); write('install-target', '未连接本机服务');
      write('settings-feedback', '连接本机服务后可编辑。');
    } finally { busy = ''; render(); }
  }
  $('retry').addEventListener('click', () => { if (!busy) void load(); });
  $('model').addEventListener('change', e => {
    if (!editable() || !isModel(e.target.value)) return;
    draft = e.target.value; feedbackForDraft(); render();
  });
  $('reset').addEventListener('click', () => {
    if (!editable()) return;
    draft = 'auto';
    feedbackForDraft(isDirty() ? '已选自动，点击保存才会生效。' : '已恢复为已保存的自动设置。'); render();
  });
  $('discard').addEventListener('click', () => {
    if (!editable()) return;
    draft = state.settings.model; feedbackForDraft('已撤销更改，保留已保存的设置。'); render();
    $('model').focus();
  });
  $('save').addEventListener('click', async () => {
    if (!editable() || !isDirty()) return;
    busy = 'save'; write('settings-feedback', '正在保存模型档位…', 'busy'); render();
    try {
      const config = readSettings(await request('/api/settings', { csrfToken: state.csrfToken, model: draft }));
      Object.assign(state, config); draft = config.settings.model;
      write('settings-feedback', standalone ? '已保存到本次预览，未写入插件。' : '已保存模型档位。', 'ok');
    } catch (err) { write('settings-feedback', `保存失败：${err.message} 草稿已保留。`, 'error'); }
    finally { busy = ''; render(); }
  });
  $('update').addEventListener('click', async () => {
    if (!editable() || !state.install.canUpdate || isDirty()) return;
    busy = 'update'; render();
    try {
      const data = await request('/api/update', { csrfToken: state.csrfToken });
      valid(['current', 'updated'].includes(data.status) && text(data.version) && text(data.previousVersion));
      const version = versionLabel(data.version);
      state.install.version = data.version; write('install-version', version);
      release = { status: data.status, tone: 'ok', message: data.status === 'current' ? `没有可用更新，已保留本机 ${version}。`
        : `已从 ${versionLabel(data.previousVersion)} 更新至 ${version}。请在 AGY 中重载插件，再重新打开面板。` };
    } catch (err) { release = { status: 'error', tone: 'error', message: `更新未确认：${err.message} 可重试。` }; }
    finally { busy = ''; render(); if (release?.status === 'updated') $('reload').focus(); }
  });
  $('reload').addEventListener('click', () => { if (release?.status === 'updated') window.location.reload(); });
  void load();
})();
