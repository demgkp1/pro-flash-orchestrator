#!/usr/bin/env node
/**
 * PreToolUse guard for write_file / write_to_file / edit_file / replace_file_content / multi_replace_file_content.
 *
 * Implements the v0.3 sandwich workflow red line:
 *   - The Pro architect writes 1-2 core/benchmark files directly.
 *   - Any further multi-file engineering (attempting 3rd distinct file) is blocked
 *     and must be delegated to a Flash worker subagent.
 *   - Subagents and artifacts are exempt.
 */
import path from 'node:path';
import {
  ALLOW,
  basenameOf,
  currentMode,
  getArgs,
  isExemptPath,
  isSubAgent,
  lastUserInput,
  logDecision,
  mentions,
  output,
  pickPath,
  readPayload,
  readSession,
  resolvePath,
  setContext,
  STATE_DIR,
  toolName,
  updateSession,
  writeSession,
} from './lib.mjs';

const WRITE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

function decide() {
  const payload = readPayload();
  setContext(payload);
  const mode = currentMode();
  if (mode === 'off') return ALLOW;

  const tool = toolName(payload);
  if (!WRITE_TOOLS.has(tool)) return ALLOW;

  const args = getArgs(payload);
  const rawPaths = payload._rawToolName === 'apply_patch' && Array.isArray(payload._patchPaths)
    ? payload._patchPaths : [pickPath(args)];
  const files = [...new Set(rawPaths.map((raw) => resolvePath(raw, payload)).filter(Boolean))];
  if (files.length === 0) return ALLOW;
  const file = files[0];

  const sub = isSubAgent(payload);
  const base = basenameOf(file);

  const record = {
    hook: 'guard-write-file',
    tool,
    mode,
    sub,
    base,
    path: file.length > 180 ? `…${file.slice(-179)}` : file,
    ...(files.length > 1 ? { paths: files } : {}),
  };

  const finish = ({ deny = false, reason = '' } = {}) => {
    const action = deny
      ? mode === 'enforce' ? 'deny' : 'would-deny'
      : 'pass';
    logDecision({ ...record, action });
    if (mode === 'shadow') return ALLOW;
    if (deny) return { decision: 'deny', reason };
    return ALLOW;
  };

  /* S1: mode.json is protected by security policy; no agent may modify it */
  try {
    const normState = path.resolve(STATE_DIR);
    if (files.some((target) => {
      const rel = path.relative(normState, path.resolve(target));
      return !rel.startsWith('..') && !path.isAbsolute(rel) && basenameOf(target) === 'mode.json';
    })) {
      return finish({
        deny: true,
        reason: '【安全拦截】禁止通过工具修改 mode.json。运行模式为用户安全配置，只能由用户在 .state/mode.json 手动配置。',
      });
    }
  } catch {
    /* ignore */
  }

  /* sub-agents and exempt paths are never policed ----------------------- */
  const guardedFiles = files.filter((target) => !isExemptPath(target, payload));
  if (sub || guardedFiles.length === 0) return finish();
  if (
    mentions(payload, '[ALLOW-WRITE]') ||
    mentions(payload, '[FORCE-PRO]') ||
    mentions(payload, '[FORCE-ARGON]')
  ) {
    return finish();
  }

  const convId = String(payload.conversationId || 'unknown');
  const uInput = lastUserInput(payload).trim();
  const normFiles = guardedFiles.map((target) => process.platform === 'win32'
    ? path.normalize(target).toLowerCase() : path.normalize(target));
  let shouldDeny = false;
  let currentList = [];

  const updated = updateSession(convId, (state) => {
    if (uInput && uInput !== state.lastWriteUserInput) {
      state.lastWriteUserInput = uInput;
      state.writesSinceDispatch = [];
    }

    const writeList = Array.isArray(state.writesSinceDispatch) ? state.writesSinceDispatch : [];
    currentList = writeList;

    const nextList = [...new Set([...writeList, ...normFiles])];
    if (nextList.length > 2) {
      shouldDeny = true;
      return;
    }
    state.writesSinceDispatch = nextList;
  });

  if (!updated) return finish({ deny: true, reason: '【状态锁忙】写入配额暂时无法安全更新，请稍后重试本次工具调用。' });

  if (shouldDeny) {
    return finish({
      deny: true,
      reason:
        '【写入守门：多文件连续直改拦截】本次操作将超过 2 个不同文件的直改上限。此前修改的文件（' +
        currentList.map((p) => path.basename(p)).join(', ') +
        '）。按三明治协同红线，主控仅负责落盘 1~2 个核心标杆文件，其余外围文件修改必须同轮外派 invoke_subagent(TypeName="self", Model="flash") 或用 send_message 续派现有子代理（若确需主控直改可在输入中加 [ALLOW-WRITE]）。',
    });
  }

  return finish();
}

try {
  output(decide());
} catch {
  output(ALLOW);
}
