(() => {
  'use strict';

  const STORAGE_KEY = 'pfo.panel.lang';
  const SUPPORTED = ['zh-CN', 'en'];

  const MESSAGES = {
    'zh-CN': {
      'page.title': 'Pro-Flash Orchestrator',
      'masthead.eyebrow': '辅助面板',
      'masthead.langGroup': '切换界面语言',
      'version.pending': '版本待查',
      'version.ariaPending': '面板版本尚未读取',
      'version.ariaLabel': '面板版本 {version}',
      'noscript.notice': '需要启用 JavaScript 才能连接本机插件；当前不能保存或更新。',

      'connection.loading': '正在读取本机设置与安装信息…',
      'connection.retry': '重新连接',
      'connection.error': '无法读取本机面板：{message}',

      'route.title': '子代理路由',
      'route.subtitle': '主模型自动选择子代理类型，无需手选角色。',
      'state.loading': '读取中',
      'state.disconnected': '未连接',
      'state.saving': '保存中',
      'state.dirty': '未保存',
      'state.saved': '已保存',

      'model.label': '统一模型档位',
      'model.option.auto': '自动（按路由策略）',
      'model.option.flash_lite': 'flash_lite: gemini 3.5 flash-lite',
      'model.option.flash': 'flash: gemini 4 hydrogen (high)',
      'model.option.pro': 'pro: gemini 4 hydrogen (xhigh)',
      'model.option.inherit': 'inherit: 继承主模型',
      'model.effortLabel': '推理强度',
      'model.note': '实际模型与可用档位取决于账户权限和宿主版本。',

      'effort.pending': '待读取',
      'effort.auto': '跟随路由策略',
      'effort.flash_lite': '宿主默认',
      'effort.flash': 'High',
      'effort.pro': 'XHigh',
      'effort.inherit': '继承主模型',

      'guard.proPrefix': '使用 Pro / XHigh 需用户在本轮原话中写出 ',
      'guard.proSuffix': '；未授权时按默认策略回退。',

      'autoRoute.withHydrogenId': '自动路由：已配置 PRO_HYDROGEN_ID ({id})，将优先使用。',
      'autoRoute.hasHydrogen': '自动路由：已探测到 Hydrogen 权限{source}，默认派发将路由至 Hydrogen Worker。',
      'autoRoute.noHydrogen': '自动路由：未探测到 Hydrogen 权限{source}，默认派发将回退至 Flash Worker。',
      'autoRoute.unknown': '自动路由：Hydrogen 权限将在主会话启动时自动探测。',
      'autoRoute.source': '（来源：{source}）',

      'override.roleResearch': '调研 {model}',
      'override.roleSelf': '执行 {model}',
      'override.banner': '环境变量覆盖生效中：{items}（面板保存不会覆盖环境变量）。',
      'override.note': '当前环境变量覆盖（只读）：{items}。',

      'policy.summary': '原生编排与环境变量',
      'policy.overrideBadge': '有覆盖',
      'policy.part1': '原生 Orchestrator 自行派单，不使用面板档位。普通会话先使用角色环境变量（',
      'policy.part2': '），再使用 ',
      'policy.part3': '，然后才使用面板档位。选择自动时，有效的 ',
      'policy.part4': ' 优先于默认策略。',

      'lock.reloadRequired': '插件已更新，编辑已暂时锁定；请在 AGY 中重载插件并重新载入面板后再修改设置。',

      'feedback.default': '更改只在保存后生效。',
      'feedback.preview': '浏览器预览：保存仅对本次预览生效。',
      'feedback.disconnected': '连接本机服务后可编辑。',
      'feedback.dirty': '档位有未保存的更改；保存后生效。',
      'feedback.synced': '与已保存的设置一致。',
      'feedback.resetDirty': '已选自动，点击保存才会生效。',
      'feedback.resetClean': '已恢复为已保存的自动设置。',
      'feedback.discarded': '已撤销更改，保留已保存的设置。',
      'feedback.saving': '正在保存模型档位…',
      'feedback.saved': '已保存模型档位。',
      'feedback.savedPreview': '已保存到本次预览，未写入插件。',
      'feedback.saveFailed': '保存失败：{message} 草稿已保留。',

      'action.discard': '撤销未保存的更改',
      'action.reset': '恢复自动',
      'action.resetTitle': '保存后生效',
      'action.save': '保存设置',
      'action.saving': '保存中…',

      'release.title': '插件版本',
      'release.subtitle': '仅更新下方识别到的安装副本。',
      'installKind.detecting': '识别中',
      'installKind.unknown': '未识别',
      'installKind.global': '全局安装',
      'installKind.workspace': '工作区安装',
      'installKind.custom': '自定义安装',
      'installKind.git': 'Git 工作树',
      'installKind.unsupported': '不支持更新',

      'install.versionLabel': '安装版本',
      'install.versionPending': '待读取',
      'install.versionNotRead': '未读取',
      'install.versionUnknown': '未识别',
      'install.latestLabel': '最新版本',
      'install.releaseLink': '查看 Release',
      'install.targetLabel': '安装路径',
      'install.targetDetecting': '正在识别本机安装位置…',
      'install.targetUnknown': '未识别安装路径',
      'install.targetDisconnected': '未连接本机服务',

      'update.default': '点击后检查 GitHub Release，有新版时下载并替换。',
      'update.checking': '正在检查最新版本，有新版时将下载并替换当前安装…',
      'update.unsupportedFallback': '此安装不能从面板更新。',
      'update.dirtyGuard': '更新前请保存或撤销未保存的更改。',
      'update.current': '没有可用更新，已保留本机 {version}。',
      'update.updated': '已从 {previous} 更新至 {version}。请在 AGY 中重载插件，再重新打开面板。',
      'update.failed': '更新未确认：{message} 可重试。',
      'action.update': '获取最新版本',
      'action.updating': '更新中…',
      'action.reload': '重新载入面板',

      'reasonCode.GIT_CHECKOUT': 'Git 工作树不能从面板更新，请使用 git pull。',
      'reasonCode.UNSUPPORTED_LAYOUT': '当前安装目录结构不支持面板自动更新。',
      'reasonCode.MISSING_MANIFEST': '未找到插件清单文件，无法验证或更新此安装。',
      'reasonCode.READ_ERROR': '读取安装信息失败，请检查文件权限。',
      'reasonCode.PREVIEW_MODE': '浏览器预览不更新真实插件。',

      'errorCode.INVALID_JSON': '请求数据格式无效（JSON 解析失败）。',
      'errorCode.INVALID_MODEL': '未知的子代理模型档位。',
      'errorCode.SAVE_FAILED': '保存失败，请检查插件数据目录的写权限。',
      'errorCode.UPDATE_IN_PROGRESS': '更新正在进行，请勿重复提交。',
      'errorCode.UPDATE_UNSUPPORTED': '此安装不支持面板更新。',
      'errorCode.UPDATE_FAILED': '更新未完成，请检查网络和本机安装目录后重试。',

      'error.incompleteData': '本机服务返回的数据不完整，请重新打开面板核对。',
      'error.httpStatus': '本机服务返回 HTTP {status}。',
    },
    en: {
      'page.title': 'Pro-Flash Orchestrator',
      'masthead.eyebrow': 'SIDE PANEL',
      'masthead.langGroup': 'Switch interface language',
      'version.pending': 'Checking',
      'version.ariaPending': 'Panel version not loaded yet',
      'version.ariaLabel': 'Panel version {version}',
      'noscript.notice': 'JavaScript is required to connect to the local plugin; saving and updating are unavailable.',

      'connection.loading': 'Loading local settings and install info…',
      'connection.retry': 'Reconnect',
      'connection.error': 'Unable to read local panel: {message}',

      'route.title': 'Subagent Routing',
      'route.subtitle': 'The main model picks subagent types automatically.',
      'state.loading': 'Loading',
      'state.disconnected': 'Offline',
      'state.saving': 'Saving',
      'state.dirty': 'Unsaved',
      'state.saved': 'Saved',

      'model.label': 'Unified Worker Model',
      'model.option.auto': 'Auto (follow routing policy)',
      'model.option.flash_lite': 'flash_lite: gemini 3.5 flash-lite',
      'model.option.flash': 'flash: gemini 4 hydrogen (high)',
      'model.option.pro': 'pro: gemini 4 hydrogen (xhigh)',
      'model.option.inherit': 'inherit: main model',
      'model.effortLabel': 'Reasoning Effort',
      'model.note': 'Actual model and tier availability depend on account permissions and host version.',

      'effort.pending': 'Pending',
      'effort.auto': 'Follows routing policy',
      'effort.flash_lite': 'Host default',
      'effort.flash': 'High',
      'effort.pro': 'XHigh',
      'effort.inherit': 'Inherits main model',

      'guard.proPrefix': 'Pro / XHigh requires ',
      'guard.proSuffix': ' in the user message for this turn; otherwise it falls back to the default policy.',

      'autoRoute.withHydrogenId': 'Auto-route: PRO_HYDROGEN_ID ({id}) is configured and takes precedence.',
      'autoRoute.hasHydrogen': 'Auto-route: Hydrogen capability detected{source}; default workers route to Hydrogen.',
      'autoRoute.noHydrogen': 'Auto-route: Hydrogen capability not detected{source}; default workers fall back to Flash.',
      'autoRoute.unknown': 'Auto-route: Hydrogen capability is probed automatically at main session start.',
      'autoRoute.source': ' (source: {source})',

      'override.roleResearch': 'research {model}',
      'override.roleSelf': 'self {model}',
      'override.banner': 'Environment override active: {items} (panel saves do not override env vars).',
      'override.note': 'Active environment overrides (read-only): {items}.',

      'policy.summary': 'Native Orchestrator & Env Vars',
      'policy.overrideBadge': 'Overridden',
      'policy.part1': 'Native Orchestrator dispatches its own workers without panel tiers. Standard sessions check role env vars (',
      'policy.part2': ') first, then ',
      'policy.part3': ', then the panel tier. Under Auto, a valid ',
      'policy.part4': ' takes precedence over the default policy.',

      'lock.reloadRequired': 'Plugin updated — editing is locked until you reload the plugin in AGY and reload this panel.',

      'feedback.default': 'Changes take effect only after saving.',
      'feedback.preview': 'Browser preview: changes apply to this preview session only.',
      'feedback.disconnected': 'Connect to the local service to edit.',
      'feedback.dirty': 'Unsaved tier change; save to apply.',
      'feedback.synced': 'Matches saved settings.',
      'feedback.resetDirty': 'Auto selected; click Save to apply.',
      'feedback.resetClean': 'Restored to saved Auto setting.',
      'feedback.discarded': 'Changes discarded; saved settings kept.',
      'feedback.saving': 'Saving model tier…',
      'feedback.saved': 'Model tier saved.',
      'feedback.savedPreview': 'Saved to preview session only (not written to plugin).',
      'feedback.saveFailed': 'Save failed: {message} Draft preserved.',

      'action.discard': 'Discard unsaved changes',
      'action.reset': 'Reset to Auto',
      'action.resetTitle': 'Takes effect after saving',
      'action.save': 'Save',
      'action.saving': 'Saving…',

      'release.title': 'Plugin Version',
      'release.subtitle': 'Updates only the installed copy detected below.',
      'installKind.detecting': 'Detecting',
      'installKind.unknown': 'Unknown',
      'installKind.global': 'Global install',
      'installKind.workspace': 'Workspace install',
      'installKind.custom': 'Custom install',
      'installKind.git': 'Git worktree',
      'installKind.unsupported': 'Update unsupported',

      'install.versionLabel': 'Installed version',
      'install.versionPending': 'Pending',
      'install.versionNotRead': 'Not read',
      'install.versionUnknown': 'Unknown',
      'install.latestLabel': 'Latest version',
      'install.releaseLink': 'View Release',
      'install.targetLabel': 'Install path',
      'install.targetDetecting': 'Detecting local install path…',
      'install.targetUnknown': 'Install path not detected',
      'install.targetDisconnected': 'Local service disconnected',

      'update.default': 'Check GitHub Release and replace this install when a newer version is available.',
      'update.checking': 'Checking for the latest release and updating this install if newer…',
      'update.unsupportedFallback': 'This installation cannot be updated from the panel.',
      'update.dirtyGuard': 'Save or discard unsaved changes before updating.',
      'update.current': 'No update available; keeping local {version}.',
      'update.updated': 'Updated from {previous} to {version}. Reload the plugin in AGY, then reopen the panel.',
      'update.failed': 'Update unconfirmed: {message} You can retry.',
      'action.update': 'Check for updates',
      'action.updating': 'Updating…',
      'action.reload': 'Reload panel',

      'reasonCode.GIT_CHECKOUT': 'Git worktrees cannot be updated from the panel; use git pull instead.',
      'reasonCode.UNSUPPORTED_LAYOUT': 'This installation layout does not support panel updates.',
      'reasonCode.MISSING_MANIFEST': 'Plugin manifest is missing; cannot verify or update this install.',
      'reasonCode.READ_ERROR': 'Failed to read installation metadata; check file permissions.',
      'reasonCode.PREVIEW_MODE': 'Browser preview does not update the real plugin.',

      'errorCode.INVALID_JSON': 'Invalid JSON request payload.',
      'errorCode.INVALID_MODEL': 'Unknown subagent model tier.',
      'errorCode.SAVE_FAILED': 'Save failed; check write permissions on the plugin data directory.',
      'errorCode.UPDATE_IN_PROGRESS': 'An update is already in progress.',
      'errorCode.UPDATE_UNSUPPORTED': 'This installation does not support panel updates.',
      'errorCode.UPDATE_FAILED': 'Update failed; check network and local install directory, then retry.',

      'error.incompleteData': 'Local service returned incomplete data; reopen the panel to verify.',
      'error.httpStatus': 'Local service returned HTTP {status}.',
    },
  };

  function normalizeLang(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'en' || trimmed.startsWith('en-')) return 'en';
    if (trimmed === 'zh' || trimmed === 'zh-cn' || trimmed.startsWith('zh-')) return 'zh-CN';
    return null;
  }

  function detectLang() {
    try {
      const queryLang = normalizeLang(new URLSearchParams(window.location.search).get('lang'));
      if (queryLang && SUPPORTED.includes(queryLang)) return queryLang;
    } catch {}
    try {
      const stored = normalizeLang(window.localStorage?.getItem(STORAGE_KEY));
      if (stored && SUPPORTED.includes(stored)) return stored;
    } catch {}
    const navLang = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
    return navLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }

  function saveLang(lang) {
    const normalized = normalizeLang(lang) || 'zh-CN';
    try {
      window.localStorage?.setItem(STORAGE_KEY, normalized);
    } catch {}
    return normalized;
  }

  function t(lang, key, vars) {
    const active = normalizeLang(lang) || 'zh-CN';
    const dict = MESSAGES[active] || MESSAGES['zh-CN'];
    let template = Object.hasOwn(dict, key) ? dict[key]
      : Object.hasOwn(MESSAGES['zh-CN'], key) ? MESSAGES['zh-CN'][key]
      : key;
    if (vars && typeof vars === 'object') {
      template = template.replace(/\{(\w+)\}/g, (_, name) => (
        Object.hasOwn(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : ''
      ));
    }
    return template;
  }

  window.PanelI18n = { detectLang, saveLang, t, MESSAGES };
})();
