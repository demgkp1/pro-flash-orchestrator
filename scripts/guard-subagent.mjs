#!/usr/bin/env node
/**
 * PreToolUse guard for `invoke_subagent` / `define_subagent` / `send_message` (v0.3).
 *
 * 1. recursion  — a sub-agent may not dispatch another sub-agent (hard deny).
 * 2. model leak — `Model` missing / "inherit" / "pro" is rewritten to
 *                 flash_lite (research) or flash (everything else), unless the
 *                 prompt (or the user's own message) carries [FORCE-ARGON].
 * 3. contract   — the report contract is appended to the dispatch prompt, so it
 *                 cannot be forgotten by the model. Idempotent via a marker.
 *
 * Failure policy: any exception -> {"decision":"allow"} (never block the loop).
 */
import os from 'node:os';
import path from 'node:path';
import {
  ALLOW,
  currentMode,
  getArgs,
  isSubAgent,
  lastUserInput,
  logDecision,
  markSubagentSpawn,
  output,
  readPayload,
  readSession,
  setContext,
  toolName,
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
const CHEAP_MODELS = new Set(['flash', 'flash_lite']);

/** Some dispatches arrive double-encoded: `Model: "\"flash_lite\""`. */
function clean(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function artifactDir(payload) {
  const dir = String((payload && payload.artifactDirectoryPath) || '').trim();
  if (dir) return dir;
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
  if (typeName === 'research') {
    return (
      `${CONTRACT_MARKER} 汇报仅限结构化摘要（≤30 行）：核心结论 / 架构与模块清单 / 约束与隐患 / 关键文件与行号。` +
      `严禁粘贴大段源码原文（单段 ≤10 行）。因 research 属于只读探路代理，全部研究结论请直接在消息中完整结构化输出。`
    );
  }
  return (
    `${CONTRACT_MARKER} 完成后仅回复四列表格，禁止粘贴源码（单段代码 ≤10 行）；完整报告写入 \`${dir}/<task>.report.md\`：\n` +
    '| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |'
  );
}

function appendContract(text, contract) {
  const base = String(text || '').replace(/\s+$/, '');
  const hasContract = base.includes(CONTRACT_MARKER) || base.includes(LEGACY_CONTRACT_MARKER);
  const hasPrefix = PREFIX_PATTERN.test(base);
  if (hasContract && hasPrefix) return null;

  let next = base;
  if (!hasPrefix) {
    next = next ? `${WORKER_PREFIX} ${next}` : WORKER_PREFIX;
  }
  if (!hasContract) {
    next = next ? `${next}\n\n${contract}` : `${WORKER_PREFIX}\n\n${contract}`;
  }
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

  /* 0. polling guard on manage_subagents ------------------------------- */
  if (tool === MANAGE) {
    const action = clean(args.Action || args.action).toLowerCase();
    if (!sub && action === 'list' && !FORCE_PATTERN.test(lastUserInput(payload))) {
      const reason =
        '【轮询守门】严禁主模型调用 manage_subagents(Action="list") 轮询子代理状态（会白白消耗一轮主模型上下文推理并引发抢改）。子代理完成后系统会自动异步唤醒你；请直接结束当前回合（不要调用任何工具）静默等待子代理消息。';
      logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, subAction: action });
      return mode === 'enforce' ? { decision: 'deny', reason } : ALLOW;
    }
    return ALLOW;
  }

  /* 1. recursion ------------------------------------------------------- */
  if (sub && (tool === INVOKE || tool === DEFINE)) {
    const reason =
      '【递归守门】子代理不得再派发子代理。请直接执行任务并按 [PRO-CONTRACT] 回报，把需要拆分的工作写进汇报。';
    logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, reason });
    return mode === 'enforce' ? { decision: 'deny', reason } : ALLOW;
  }

  if (!sub) {
    if (tool === INVOKE) {
      markSubagentSpawn(payload.conversationId);
      const state = readSession(payload.conversationId);
      state.readsSinceDispatch = [];
      state.writesSinceDispatch = [];
      writeSession(payload.conversationId, state);
    } else if (tool === SEND) {
      const state = readSession(payload.conversationId);
      state.readsSinceDispatch = [];
      state.writesSinceDispatch = [];
      writeSession(payload.conversationId, state);
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
    const forced = FORCE_PATTERN.test(prompt) || FORCE_PATTERN.test(lastUserInput(payload));
    const model = clean(args.Model);
    const lower = model.toLowerCase();
    const currentModel = String((payload && payload.modelName) || '').toLowerCase();
    const isCurrentModelFlash = currentModel.includes('flash');
    const target = typeName === 'research' ? 'flash_lite' : 'flash';

    if (!forced) {
      if (typeName === 'research') {
        if (lower !== 'flash_lite') {
          overwrite.Model = 'flash_lite';
        }
      } else if (lower === 'pro') {
        overwrite.Model = target;
      } else if (!isCurrentModelFlash && !CHEAP_MODELS.has(lower)) {
        overwrite.Model = target;
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
} catch {
  output(ALLOW);
}
