(() => {
  'use strict';

  const I18n = window.PanelI18n;
  const $ = id => document.getElementById(id);
  const MODEL_EFFORT_KEYS = {
    auto: 'effort.auto',
    flash_lite: 'effort.flash_lite',
    flash: 'effort.flash',
    pro: 'effort.pro',
    inherit: 'effort.inherit',
  };
  const INSTALL_KIND_KEYS = {
    global: 'installKind.global',
    workspace: 'installKind.workspace',
    custom: 'installKind.custom',
    git: 'installKind.git',
    unsupported: 'installKind.unsupported',
  };

  const standalone = typeof window.sidecar?.fetch !== 'function';
  const fetchLocal = standalone ? window.fetch.bind(window) : window.sidecar.fetch.bind(window.sidecar);

  let lang = I18n.detectLang();
  let state = null;
  let draft = null;
  let busy = 'load';
  let release = null;
  let loadError = null;
  let settingsStatus = { key: 'feedback.default', tone: '' };

  const t = (key, vars) => I18n.t(lang, key, vars);
  const text = value => typeof value === 'string' && value.trim() !== '';
  const isModel = model => typeof model === 'string' && Object.hasOwn(MODEL_EFFORT_KEYS, model);
  const isOverride = model => model === null || (model !== 'auto' && isModel(model));
  const versionLabel = version => /^v/i.test(version) ? version : `v${version}`;
  const normalizeVersion = version => text(version) ? version.trim().replace(/^v/i, '') : '';

  function valid(flag) {
    if (!flag) {
      const err = new Error('incomplete');
      err.isIncomplete = true;
      throw err;
    }
  }

  function toErrorInfo(err) {
    return {
      code: text(err?.code) ? err.code : null,
      rawError: err?.isIncomplete ? null : (text(err?.rawError) ? err.rawError : (text(err?.message) ? err.message : null)),
      status: Number.isInteger(err?.status) ? err.status : null,
    };
  }

  function resolveError(info) {
    if (info?.code) {
      const codeKey = `errorCode.${info.code}`;
      const dict = I18n.MESSAGES[lang] || I18n.MESSAGES['zh-CN'];
      if (Object.hasOwn(dict, codeKey)) return dict[codeKey];
    }
    if (text(info?.rawError)) return info.rawError;
    if (info?.status) return t('error.httpStatus', { status: info.status });
    return t('error.incompleteData');
  }

  function readSettings(data) {
    const model = data?.settings?.model;
    const { research, self } = data?.overrides ?? {};
    valid(isModel(model) && isOverride(research) && isOverride(self));
    return { settings: { model }, overrides: { research, self } };
  }

  async function request(path, body) {
    const response = await fetchLocal(path, body === undefined ? { method: 'GET', cache: 'no-store' } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const err = new Error(text(data?.error) ? data.error : `HTTP ${response.status}`);
      err.code = text(data?.code) ? data.code : null;
      err.rawError = text(data?.error) ? data.error : null;
      err.status = response.status;
      throw err;
    }
    valid(data && typeof data === 'object');
    return data;
  }

  function write(id, message, tone = '') {
    const el = $(id);
    if (!el) return;
    if (el.textContent !== message) el.textContent = message;
    el.dataset.tone = tone;
  }

  const isDirty = () => !!state && draft !== state.settings.model;
  const editable = () => !!state && !busy && release?.status !== 'updated';

  function renderAutoRouteHint() {
    const el = $('auto-route-hint');
    const show = !!state && draft === 'auto';
    el.hidden = !show;
    if (!show) return;
    const rt = state.runtime || {};
    const source = text(rt.capabilitySource) ? t('autoRoute.source', { source: rt.capabilitySource }) : '';
    if (text(rt.hydrogenId)) {
      write('auto-route-hint', t('autoRoute.withHydrogenId', { id: rt.hydrogenId }), 'ok');
    } else if (rt.hasHydrogen === true) {
      write('auto-route-hint', t('autoRoute.hasHydrogen', { source }), 'ok');
    } else if (rt.hasHydrogen === false) {
      write('auto-route-hint', t('autoRoute.noHydrogen', { source }), 'warn');
    } else {
      write('auto-route-hint', t('autoRoute.unknown'), '');
    }
  }

  function renderOverrides() {
    if (!state) {
      $('override-badge').hidden = $('override-note').hidden = $('override-banner').hidden = true;
      return;
    }
    const { research, self } = state.overrides;
    const overrides = [
      research && t('override.roleResearch', { model: research }),
      self && t('override.roleSelf', { model: self }),
    ].filter(Boolean);
    const hasOverrides = overrides.length > 0;
    $('override-badge').hidden = $('override-note').hidden = $('override-banner').hidden = !hasOverrides;
    if (hasOverrides) {
      const items = overrides.join(lang === 'zh-CN' ? '、' : ', ');
      write('override-banner', t('override.banner', { items }));
      write('override-note', t('override.note', { items }));
    }
  }

  function renderInstallMeta() {
    if (!state) {
      const hasError = !!loadError;
      write('panel-version', t('version.pending'));
      $('panel-version').setAttribute('aria-label', t('version.ariaPending'));
      write('install-kind', t(hasError ? 'installKind.unknown' : 'installKind.detecting'));
      write('install-version', t(hasError ? 'install.versionNotRead' : 'install.versionPending'));
      write('install-target', t(hasError ? 'install.targetDisconnected' : 'install.targetDetecting'));
      $('latest-version-row').hidden = true;
      return;
    }

    const panelVer = versionLabel(state.version);
    write('panel-version', panelVer);
    $('panel-version').setAttribute('aria-label', t('version.ariaLabel', { version: panelVer }));
    write('install-kind', t(INSTALL_KIND_KEYS[state.install.kind]));
    write('install-target', text(state.install.target) ? state.install.target : t('install.targetUnknown'));
    write('install-version', text(state.install.version) ? versionLabel(state.install.version) : t('install.versionUnknown'));

    const latestVer = state.updateCheck?.latestVersion;
    const currentVer = state.install.version || state.version;
    const hasNewer = text(latestVer) && normalizeVersion(latestVer) !== normalizeVersion(currentVer);
    $('latest-version-row').hidden = !hasNewer;
    if (hasNewer) {
      write('latest-version', versionLabel(latestVer));
      const releaseUrl = state.updateCheck?.releaseUrl;
      const safeUrl = text(releaseUrl) && /^https?:\/\//i.test(releaseUrl.trim()) ? releaseUrl.trim() : null;
      $('latest-release-link').hidden = !safeUrl;
      if (safeUrl) $('latest-release-link').setAttribute('href', safeUrl);
      else $('latest-release-link').removeAttribute('href');
    }
  }

  function renderUnsupportedReason() {
    const code = state.install.reasonCode;
    if (text(code)) {
      const key = `reasonCode.${code}`;
      const dict = I18n.MESSAGES[lang] || I18n.MESSAGES['zh-CN'];
      if (Object.hasOwn(dict, key)) return dict[key];
    }
    if (text(state.install.reason)) return state.install.reason;
    return t('update.unsupportedFallback');
  }

  function render() {
    const dirty = isDirty();
    const canEdit = editable();
    const updatedLocked = release?.status === 'updated';

    if (loadError) {
      write('connection-text', t('connection.error', { message: resolveError(loadError) }));
    } else if (busy === 'load') {
      write('connection-text', t('connection.loading'));
    }

    $('model').disabled = !canEdit;
    if (state) {
      $('model').value = draft;
      write('effort-value', t(MODEL_EFFORT_KEYS[draft]));
      const { research, self } = state.overrides;
      const showGuard = draft === 'pro' || research === 'pro' || self === 'pro';
      $('pro-guard').hidden = !showGuard;
      $('model').setAttribute('aria-describedby', `model-effort model-note${showGuard ? ' pro-guard' : ''}`);
    } else {
      write('effort-value', t('effort.pending'));
      $('pro-guard').hidden = true;
    }

    renderAutoRouteHint();
    renderOverrides();
    renderInstallMeta();

    $('reload-lock-hint').hidden = !updatedLocked;
    if (updatedLocked) write('reload-lock-hint', t('lock.reloadRequired'));

    $('reset').disabled = !canEdit || draft === 'auto';
    $('save').disabled = !canEdit || !dirty;
    $('save-label').textContent = t(busy === 'save' ? 'action.saving' : 'action.save');

    const saveStateKey = !state ? (busy ? 'state.loading' : 'state.disconnected')
      : busy === 'save' ? 'state.saving'
      : dirty ? 'state.dirty'
      : 'state.saved';
    const saveStateTone = !state ? '' : busy === 'save' ? 'busy' : dirty ? 'dirty' : 'ok';
    write('save-state', t(saveStateKey), saveStateTone);

    const feedbackText = settingsStatus.key === 'feedback.saveFailed'
      ? t('feedback.saveFailed', { message: resolveError(settingsStatus.error) })
      : t(settingsStatus.key);
    write('settings-feedback', feedbackText, settingsStatus.tone);

    $('update').hidden = updatedLocked;
    $('reload').hidden = !updatedLocked;
    $('update').disabled = !state?.install.canUpdate || !canEdit || dirty;
    $('update-label').textContent = t(busy === 'update' ? 'action.updating' : 'action.update');
    $('discard').hidden = !dirty || !canEdit;

    let updateMsg = t('update.default');
    let updateTone = '';
    if (busy === 'update') {
      updateMsg = t('update.checking');
      updateTone = 'busy';
    } else if (state && !state.install.canUpdate) {
      updateMsg = renderUnsupportedReason();
    } else if (dirty) {
      updateMsg = t('update.dirtyGuard');
    } else if (release) {
      updateTone = release.tone;
      if (release.status === 'current') {
        updateMsg = t('update.current', { version: versionLabel(release.version) });
      } else if (release.status === 'updated') {
        updateMsg = t('update.updated', {
          previous: versionLabel(release.previousVersion),
          version: versionLabel(release.version),
        });
      } else {
        updateMsg = t('update.failed', { message: resolveError(release.error) });
      }
    }
    write('update-feedback', updateMsg, updateTone);
  }

  function applyLanguage(nextLang, { persist = false } = {}) {
    lang = persist ? I18n.saveLang(nextLang) : (Object.hasOwn(I18n.MESSAGES, nextLang) ? nextLang : I18n.detectLang());
    document.documentElement.lang = lang;
    document.title = t('page.title');
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
      el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      el.setAttribute('title', t(el.dataset.i18nTitle));
    }
    for (const btn of document.querySelectorAll('.lang-switch button[data-lang]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
    }
    render();
  }

  function setFeedbackForDraft(overrideKey = null) {
    const dirty = isDirty();
    settingsStatus = {
      key: overrideKey || (dirty ? 'feedback.dirty' : 'feedback.synced'),
      tone: dirty ? 'dirty' : '',
    };
  }

  async function load() {
    busy = 'load';
    loadError = null;
    $('retry').hidden = true;
    $('retry').disabled = true;
    $('connection').hidden = false;
    $('connection').dataset.tone = '';
    render();
    try {
      const data = await request('/api/state');
      const config = readSettings(data);
      const install = data.install;
      valid(text(data.csrfToken) && text(data.version) && Object.hasOwn(INSTALL_KIND_KEYS, install?.kind) && typeof install.canUpdate === 'boolean');
      state = {
        ...config,
        version: data.version,
        csrfToken: data.csrfToken,
        install,
        runtime: data.runtime || null,
        updateCheck: data.updateCheck || null,
      };
      draft = config.settings.model;
      $('connection').hidden = true;
      settingsStatus = { key: standalone ? 'feedback.preview' : 'feedback.default', tone: '' };
    } catch (err) {
      loadError = toErrorInfo(err);
      $('connection').dataset.tone = 'error';
      $('retry').hidden = false;
      $('retry').disabled = false;
      settingsStatus = { key: 'feedback.disconnected', tone: '' };
    } finally {
      busy = '';
      render();
    }
  }

  for (const btn of document.querySelectorAll('.lang-switch button[data-lang]')) {
    btn.addEventListener('click', () => applyLanguage(btn.dataset.lang, { persist: true }));
  }

  $('retry').addEventListener('click', () => { if (!busy) void load(); });
  $('model').addEventListener('change', e => {
    if (!editable() || !isModel(e.target.value)) return;
    draft = e.target.value;
    setFeedbackForDraft();
    render();
  });
  $('reset').addEventListener('click', () => {
    if (!editable()) return;
    draft = 'auto';
    setFeedbackForDraft(isDirty() ? 'feedback.resetDirty' : 'feedback.resetClean');
    render();
  });
  $('discard').addEventListener('click', () => {
    if (!editable()) return;
    draft = state.settings.model;
    setFeedbackForDraft('feedback.discarded');
    render();
    $('model').focus();
  });
  $('save').addEventListener('click', async () => {
    if (!editable() || !isDirty()) return;
    busy = 'save';
    settingsStatus = { key: 'feedback.saving', tone: 'busy' };
    render();
    try {
      const config = readSettings(await request('/api/settings', { csrfToken: state.csrfToken, model: draft }));
      Object.assign(state, config);
      draft = config.settings.model;
      settingsStatus = { key: standalone ? 'feedback.savedPreview' : 'feedback.saved', tone: 'ok' };
    } catch (err) {
      settingsStatus = { key: 'feedback.saveFailed', error: toErrorInfo(err), tone: 'error' };
    } finally {
      busy = '';
      render();
    }
  });
  $('update').addEventListener('click', async () => {
    if (!editable() || !state.install.canUpdate || isDirty()) return;
    busy = 'update';
    render();
    try {
      const data = await request('/api/update', { csrfToken: state.csrfToken });
      valid(['current', 'updated'].includes(data.status) && text(data.version) && text(data.previousVersion));
      state.install.version = data.version;
      release = {
        status: data.status,
        version: data.version,
        previousVersion: data.previousVersion,
        tone: 'ok',
      };
    } catch (err) {
      release = { status: 'error', error: toErrorInfo(err), tone: 'error' };
    } finally {
      busy = '';
      render();
      if (release?.status === 'updated') $('reload').focus();
    }
  });
  $('reload').addEventListener('click', () => {
    if (release?.status === 'updated') window.location.reload();
  });

  applyLanguage(lang);
  void load();
})();
