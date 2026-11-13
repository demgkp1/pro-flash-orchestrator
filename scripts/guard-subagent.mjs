#!/usr/bin/env node
/**
 * PreToolUse guard for `invoke_subagent` / `define_subagent` / `send_message` (v0.3).
 *
 * 1. recursion  — a sub-agent may not dispatch another sub-agent (hard deny).
 * 2. model leak — route ordinary dispatches to a host-compatible worker model;
 *                 native Orchestrator routing and explicit overrides are preserved.
 * 3. contract   — the report contract is appended to the dispatch prompt, so it
 *                 cannot be forgotten by the model. Idempotent via a marker.
 *
 * Failure policy: any exception -> {"decision":"allow"} (never block the loop).
 */
import os from 'node:os';
import path from 'node:path';
import {
  ALLOW,
  STATE_DIR,
  getHarness,
  currentMode,
  getArgs,
  isNativeOrchestrator,
  isSubAgent,
  lastUserInput,
  logDecision,
  markSubagentSpawn,
  output,
  readPayload,
  readCapabilities,
  readSession,
  setContext,
  targetWorkerModel,
  toolName,
  updateSession,
  writeSession,
} from './lib.mjs';

const CONTRACT_MARKER = '[PRO-CONTRACT]';
const LEGACY_CONTRACT_MARKER = '[ARGON-CONTRACT]';
const WORKER_PREFIX = '[FLASH-WORKER]';
const PREFIX_PATTERN = /^\s*\[(?:FLASH-WORKER|PRO-CONTRACT|ARGON-CONTRACT)\]/;
const FORCE_PATTERN = /\[(?:FORCE-PRO|FORCE-ARGON|ALLOW-PRO)\]/i;
const INVOKE = 'invoke_subagent';
const DEFINE = 'define_subagent';
const SEND = 'send_message';
const MANAGE = 'manage_subagents';

/** Some dispatches arrive double-encoded: `Model: "\"flash\""`. */
function clean(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function artifactDir(payload) {
  const dir = String((payload && payload.artifactDirectoryPath) || '').trim();
  if (dir) return dir;
  if (getHarness() !== 'antigravity') {
    const rawConv = String((payload && payload.conversationId) || '').trim() || 'default';
    return path.join(STATE_DIR, 'reports', rawConv.replace(/[<>:"/\\|?*]/g, '_'));
  }
  const tPath = String((payload && payload.transcriptPath) || '').trim();
  const match = tPath.match(/^(.*[\\/]\.gemini[\\/](?:antigravity|antigravity-cli|antigravity-ide)[\\/]brain[\\/][^\\/]+)/i);
  if (match) return match[1];
  const convId = String((payload && payload.conversationId) || '').trim();
  if (convId && convId !== 'unknown') {
    const rootName = tPath.includes('antigravity-cli') ? 'antigravity-cli' : 'antigravity';
    return path.join(os.homedir(), '.gemini', rootName, 'brain', convId);
  }
  return path.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'default');
}

function contractFor(typeName, payload) {
  const dir = artifactDir(payload).replace(/[\\/]+$/, '');
  const parent = String(payload?.conversationId || '');
  const link = /^[a-zA-Z0-9._:-]+$/.test(parent) && parent !== 'unknown' ? ` [PRO-PARENT:${parent}]` : '';
  if (typeName === 'research') {
    return (
      `${CONTRACT_MARKER} 汇报仅限结构化摘要（≤30 行）：核心结论 / 架构与模块清单 / 约束与隐患 / 关键文件与行号。` +
      `每项结论必须附带具体文件:行号（file:line）及 1-2 行代码证据；凡包含统计结论的，必须附带生成该统计的执行命令。` +
      `严禁粘贴大段源码原文（单段 ≤10 行）。因 research 属于只读探路代理，全部研究结论请直接在消息中完整结构化输出。${link}`
    );
  }
  return (
    `${CONTRACT_MARKER} 完成后仅回复四列表格，禁止粘贴源码（单段代码 ≤10 行）；完整报告写入 \`${dir}/<task>.report.md\`：\n` +
    '| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |\n\n' +
    '【多代理并发安全与边界红线】\n' +
    '1. 文件互斥红线：专属写入范围与只读参考范围隔离，仅允许修改指派给你的专属文件，严禁越界修改其他代理负责的文件；\n' +
    '2. 精准局部测试红线：自检验证仅运行针对修改模块的单文件局部测试，禁止全量构建或全工程回归测试，避免进程冲突与磁盘 I/O 踩踏。' + link
  );
}

function appendContract(text, contract) {
  let base = String(text || '').replace(/\s+$/, '');
  const hasContract = base.includes(CONTRACT_MARKER) || base.includes(LEGACY_CONTRACT_MARKER);
  const hasPrefix = PREFIX_PATTERN.test(base);
  const parentLink = contract.match(/\[PRO-PARENT:[a-zA-Z0-9._:-]+\]/)?.[0];
  const links = base.match(/\[PRO-PARENT:[a-zA-Z0-9._:-]+\]/g) || [];
  const linked = links.length === 1 && links[0] === parentLink;
  if (parentLink && !linked) base = base.replace(/\[PRO-PARENT:[a-zA-Z0-9._:-]+\]/g, '').trimEnd();
  if (hasContract && hasPrefix) {
    return parentLink && !linked ? `${base}\n${parentLink}` : null;
  }

  let next = base;
  if (!hasPrefix) {
    next = next ? `${WORKER_PREFIX} ${next}` : WORKER_PREFIX;
  }
  if (!hasContract) {
    next = next ? `${next}\n\n${contract}` : `${WORKER_PREFIX}\n\n${contract}`;
  }
  else if (parentLink && !linked) next += `\n${parentLink}`;
  return next;
}

function decide() {
  const payload = readPayload();
  setContext(payload);
  const mode = currentMode();
  if (mode === 'off') return ALLOW;

  const tool = toolName(payload);
  const args = getArgs(payload);
  const sub = isSubAgent(payload);
  const { strategy } = readCapabilities(payload);
  const baseReads = strategy === 'flash-main-relaxed' ? 6 : 3;

  /* 0. polling guard on manage_subagents ------------------------------- */
  if (tool === MANAGE) {
    const action = clean(args.Action || args.action).toLowerCase();
    if (!sub && action === 'list' && !FORCE_PATTERN.test(lastUserInput(payload))) {
      const reason =
        '【轮询守门】严禁主模型调用 manage_subagents(Action="list") 轮询子代理状态（会白白消耗一轮主模型上下文推理并引发抢改）。子代理完成后系统会自动异步唤醒你；请直接结束当前回合（不要调用任何工具）静默等待子代理消息。';
      logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, subAction: action, reason });
      return mode === 'enforce' ? { decision: 'deny', reason } : ALLOW;
    }
    return ALLOW;
  }

  /* 1. recursion ------------------------------------------------------- */
  if (sub && (tool === INVOKE || tool === DEFINE)) {
    const reason =
      '【递归守门】子代理不得再派发子代理。请直接执行任务并按 [PRO-CONTRACT] 回报，将需要拆分的子任务建议写入汇报表格（或后续拆分建议）中。';
    logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, reason });
    return mode === 'enforce' ? { decision: 'deny', reason } : ALLOW;
  }

  if (!sub) {
    if (tool === INVOKE) {
      const convId = String((payload && payload.conversationId) || '');
      const isDoctor = convId === 'doctor-test' || convId.startsWith('doctor-') || Boolean(process.env.PRO_TEST || process.env.ARGON_TEST);
      let quotaDeny = false;
      let denyReason = '';

      const updated = updateSession(convId, (state) => {
        const now = Date.now();
        const userInput = lastUserInput(payload).trim();
        const turnKey = String(payload.turn_id || payload.turnId || state.userTurnSequence || '');
        const isNewBatch = state.spawnTurnKey !== turnKey ||
          (userInput && state.lastSpawnUserInput !== userInput);

        let batchCount = isNewBatch ? 0 : Number(state.currentBatchSpawns || 0);

        if (!isDoctor && batchCount >= 5) {
          quotaDeny = true;
          denyReason =
            '【并发守门拦截】单轮并发派发 Subagent 数量已达硬性上限 (5个)。请立即结束当前回复轮次（不要再调用工具），静默等待系统异步唤醒与子代理消息通知，待当前批次完成汇报后再继续派发，避免上下文泄洪与文件冲突。';
          return state;
        }

        batchCount += 1;
        if (isNewBatch) {
          state.phase = 'explore';
          state.auditSliceQuota = 0;
          state.auditPendingWakeup = false;
          state.batchFileClaims = {};
        }
        state.currentBatchSpawns = batchCount;
        state.spawnTurnKey = turnKey;
        if (userInput) {
          state.lastSpawnUserInput = userInput;
          state.lastUserInput = userInput;
        }
        if (payload.turn_id || payload.turnId) state.lastUserTurnId = String(payload.turn_id || payload.turnId);
        state.lastSpawnAt = now;
        state.readsSinceDispatch = [];
        state.writesSinceDispatch = [];
        state.strategy = strategy;
        state.maxReadsAllowed = Math.min(10, Math.max(baseReads, batchCount * 2));
        if (clean(args.TypeName).toLowerCase() === 'self') {
          if (state.phase !== 'audit' || !state.auditBatchId) {
            state.auditBatchId = `${now}-${Math.random().toString(36).slice(2)}`;
            state.auditStartedAt = now;
            state.batchFileClaims = {};
          }
          state.phase = 'audit';
          state.auditPendingWakeup = true;
          state.auditSliceQuota = Math.min(10, Math.max(0, Number(state.auditSliceQuota) || 0) + 2);
          state.maxReadsAllowed = Math.max(state.maxReadsAllowed, state.auditSliceQuota);
        }
        return state;
      });

      if (!updated) {
        const reason = '【状态锁忙】派单配额暂时无法安全更新，请稍后重试本次工具调用。';
        logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, reason });
        return mode === 'enforce' ? { decision: 'deny', reason } : ALLOW;
      }

      if (quotaDeny) {
        logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, reason: denyReason });
        return mode === 'enforce' ? { decision: 'deny', reason: denyReason } : ALLOW;
      }

      if (!isDoctor && getHarness() === 'antigravity') {
        markSubagentSpawn(convId);
      }
    } else if (tool === SEND) {
      updateSession(payload.conversationId, (state) => {
        state.readsSinceDispatch = [];
        state.writesSinceDispatch = [];
        return state;
      });
    }
  }

  if (mode === 'shadow') {
    logDecision({ hook: 'guard-subagent', tool, action: 'shadow-pass', mode, sub, model: String(args.Model || '') });
    return ALLOW;
  }

  const overwrite = {};

  /* 2 + 3. model downgrade & contract for dispatch --------------------- */
  if (tool === INVOKE) {
    const typeName = clean(args.TypeName).toLowerCase();
    const promptKey = typeof args.Prompt === 'string' ? 'Prompt' : typeof args.prompt === 'string' ? 'prompt' : null;
    const prompt = promptKey ? String(args[promptKey]) : '';
    const forced = (getHarness() !== 'codex' && FORCE_PATTERN.test(prompt)) || FORCE_PATTERN.test(lastUserInput(payload));
    const model = clean(args.Model);
    const lower = model.toLowerCase();
    const currentModel = String((payload && payload.modelName) || '').toLowerCase();

    if (!forced && !isNativeOrchestrator(payload)) {
      const targetModel = targetWorkerModel(getHarness(), typeName, payload);
      const targetLower = targetModel.toLowerCase();
      if (lower !== targetLower || args.Model !== targetModel) {
        overwrite.Model = targetModel;
      }
    }

    const nextPrompt = promptKey ? appendContract(prompt, contractFor(typeName, payload)) : null;
    if (nextPrompt) overwrite[promptKey] = nextPrompt;

    if (Object.keys(overwrite).length > 0) {
      logDecision({
        hook: 'guard-subagent',
        tool,
        action: 'rewrite',
        mode,
        typeName,
        modelName: currentModel,
        from: model || '(missing)',
        to: overwrite.Model || model,
        contract: Boolean(promptKey && overwrite[promptKey]),
        forced,
      });
      return { decision: 'allow', overwrite };
    }
    logDecision({ hook: 'guard-subagent', tool, action: 'pass', mode, typeName, modelName: currentModel, model });
    return ALLOW;
  }

  /* custom subagent definition: enforce contract in SystemPrompt ---------- */
  if (tool === DEFINE) {
    const name = clean(args.Name || args.name).toLowerCase();
    const spKey =
      typeof args.SystemPrompt === 'string'
        ? 'SystemPrompt'
        : typeof args.systemPrompt === 'string'
          ? 'systemPrompt'
          : null;
    if (!spKey) return ALLOW;
    const sp = String(args[spKey]);
    const isReadOnly = args.EnableWriteTools === false || name.includes('research');
    const nextSp = appendContract(sp, contractFor(isReadOnly ? 'research' : 'self', payload));
    if (nextSp) {
      logDecision({ hook: 'guard-subagent', tool, action: 'contract', mode, name });
      return { decision: 'allow', overwrite: { [spKey]: nextSp } };
    }
    return ALLOW;
  }

  /* follow-up work sent to an existing sub-agent: re-assert the contract */
  if (tool === SEND) {
    if (sub) return ALLOW;
    const recipient = clean(args.Recipient || args.recipient).toLowerCase();
    if (recipient === 'user') return ALLOW;

    const key = typeof args.Message === 'string' ? 'Message' : typeof args.message === 'string' ? 'message' : null;
    if (!key) return ALLOW;
    const message = String(args[key]);
    if (message.includes(CONTRACT_MARKER) || message.includes(LEGACY_CONTRACT_MARKER)) return ALLOW;
    const reminder = `${CONTRACT_MARKER} 保持紧凑回报（禁止大段粘贴源码）：工程实现按四列表格回报，调研任务直接回复结构化要点。`;
    logDecision({ hook: 'guard-subagent', tool, action: 'contract', mode, key, recipient });
    return { decision: 'allow', overwrite: { [key]: `${message.replace(/\s+$/, '')}\n\n${reminder}` } };
  }

  return ALLOW;
}

try {
  output(decide());
} catch (error) {
  output(process.env.PRO_HARNESS === 'codex' && currentMode() === 'enforce'
    ? { decision: 'deny', reason: 'Codex guard failed safely: ' + String(error.message || error).slice(0,160) }
    : ALLOW);
}
