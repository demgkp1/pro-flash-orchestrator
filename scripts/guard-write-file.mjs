#!/usr/bin/env node
/**
 * PreToolUse guard for write_file / write_to_file / edit_file / replace_file_content / multi_replace_file_content.
 *
 * Implements the v0.6.1 sandwich workflow red line:
 *   - The Pro architect writes 1-2 core/benchmark files directly.
 *   - Any further multi-file engineering (attempting 3rd distinct file) is blocked
 *     and must be delegated to a Flash worker subagent.
 *   - Subagents claim source files atomically within their parent's batch.
 *   - Artifacts are exempt.
 */
import path from 'node:path';
import {
  ALLOW,
  basenameOf,
  currentMode,
  getArgs,
  isExemptPath,
  isNativeOrchestrator,
  isSubAgent,
  lastUserInput,
  logDecision,
  mentions,
  output,
  pickPath,
  readPayload,
  readCapabilities,
  readSession,
  resolvePath,
  setContext,
  targetWorkerModel,
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
  const writeLimit = readCapabilities(payload).strategy === 'flash-main-relaxed' ? 4 : 2;
  const worker = targetWorkerModel(undefined, 'self', payload);
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

  const finish = ({ deny = false, reason = '', rule = '' } = {}) => {
    const action = deny
      ? mode === 'enforce' ? 'deny' : 'would-deny'
      : 'pass';
    logDecision({ ...record, action, ...(reason ? { reason } : {}), ...(rule ? { rule } : {}) });
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
        rule: 'protected-config',
        reason: '【安全拦截】禁止通过工具修改 mode.json。运行模式为用户安全配置，只能由用户在 .state/mode.json 手动配置。',
      });
    }
  } catch {
    /* ignore */
  }

  /* exempt paths bypass ownership; children share their parent's claims */
  const guardedFiles = files.filter((target) => !isExemptPath(target, payload));
  if (guardedFiles.length === 0) return finish();
  const convId = String(payload.conversationId || 'unknown');
  const normFiles = [...new Set(guardedFiles.map((target) => process.platform === 'win32'
    ? path.normalize(target).toLowerCase() : path.normalize(target)))];

  if (sub) {
    // isSubAgent may have just persisted the parent inferred from the transcript.
    const parentId = String(payload.parentConversationId || payload.callerContext?.parentConversationId ||
      readSession(convId).parentConversationId || '');
    if ((!parentId || parentId === convId) && payload._harness !== 'claude' && payload._harness !== 'codex') {
      return finish({ deny: true, rule: 'parent-unresolved', reason: '【父会话关联缺失】无法安全认领源码文件。请由主控重新派单并携带父会话标识，将所需变更写入四列表格交主控合并。' });
    }
    if (parentId && parentId !== convId) {
      let conflict = null;
      const claimed = updateSession(parentId, (state) => {
        const claims = state.batchFileClaims && typeof state.batchFileClaims === 'object' &&
          !Array.isArray(state.batchFileClaims) ? state.batchFileClaims : {};
        for (const target of normFiles) {
          const owner = claims[target];
          if (owner && owner !== convId) {
            conflict = { file: target, owner: String(owner) };
            return;
          }
        }
        // Check every target before recording any claim for a multi-file patch.
        for (const target of normFiles) claims[target] = convId;
        state.batchFileClaims = claims;
      });
      if (!claimed) return finish({ deny: true, rule: 'state-update', reason: '【状态锁忙或写入失败】并发文件认领暂时无法安全更新，请稍后重试本次工具调用。' });
      if (conflict) {
        return finish({
          deny: true,
          rule: 'file-conflict',
          reason: `【并发互斥守门】文件 ${basenameOf(conflict.file)} 已被同批次并行子代理 (${conflict.owner.slice(0, 8)}) 锁定修改。严禁多代理交叉修改同一文件！请勿修改该文件，将所需变更写入最终四列表格交由主控模型统一合并。`,
        });
      }
    }
    return finish();
  }

  if (isNativeOrchestrator(payload)) return finish();
  if (
    mentions(payload, '[ALLOW-WRITE]') ||
    mentions(payload, '[FORCE-PRO]') ||
    mentions(payload, '[FORCE-ARGON]')
  ) {
    return finish();
  }

  const uInput = lastUserInput(payload).trim();
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
    if (nextList.length > writeLimit) {
      shouldDeny = true;
      return;
    }
    state.writesSinceDispatch = nextList;
  });

  if (!updated) return finish({ deny: true, rule: 'state-update', reason: '【状态锁忙或写入失败】写入配额暂时无法安全更新，请稍后重试本次工具调用。' });

  if (shouldDeny) {
    return finish({
      deny: true,
      rule: 'write-quota',
      reason:
        `【写入守门：多文件连续直改拦截】本次操作将超过 ${writeLimit} 个不同文件的直改上限。此前修改的文件（` +
        currentList.map((p) => path.basename(p)).join(', ') +
        `）。当前策略允许主控直改最多 ${writeLimit} 个文件，其余外围文件修改请同轮外派 invoke_subagent(TypeName="self", Model="${worker}") 或用 send_message 续派现有子代理（若确需主控直改可在输入中加 [ALLOW-WRITE]）。`,
    });
  }

  return finish();
}

try {
  output(decide());
} catch (error) {
  output(process.env.PRO_HARNESS === 'codex' && currentMode() === 'enforce'
    ? { decision: 'deny', reason: 'Codex guard failed safely: ' + String(error.message || error).slice(0,160) }
    : ALLOW);
}
