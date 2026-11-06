#!/usr/bin/env node
/**
 * PreToolUse guard for `invoke_subagent` / `define_subagent` / `send_message` (v3.2).
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
import { ALLOW, currentMode, getArgs, isSubAgent, lastUserInput, logDecision, output, readPayload, setContext, toolName } from './lib.mjs';

const CONTRACT_MARKER = '[PRO-CONTRACT]';
const LEGACY_CONTRACT_MARKER = '[ARGON-CONTRACT]';
const FORCE_PATTERN = /\[(?:FORCE-PRO|FORCE-ARGON|ALLOW-PRO)\]/i;
const INVOKE = 'invoke_subagent';
const DEFINE = 'define_subagent';
const SEND = 'send_message';
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
  return dir || '.gemini/artifacts';
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
  if (base.includes(CONTRACT_MARKER) || base.includes(LEGACY_CONTRACT_MARKER)) return null;
  return base ? `${base}\n\n${contract}` : contract;
}

function decide() {
  const payload = readPayload();
  setContext(payload);
  const mode = currentMode();
  if (mode === 'off') return ALLOW;

  const tool = toolName(payload);
  const args = getArgs(payload);
  const sub = isSubAgent(payload);

  /* 1. recursion ------------------------------------------------------- */
  if (sub && (tool === INVOKE || tool === DEFINE)) {
    const reason =
      '【递归守门】子代理不得再派发子代理。请直接执行任务并按 [PRO-CONTRACT] 回报，把需要拆分的工作写进汇报。';
    logDecision({ hook: 'guard-subagent', tool, action: mode === 'enforce' ? 'deny' : 'would-deny', mode, reason });
    return mode === 'enforce' ? { decision: 'deny', reason } : ALLOW;
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

    if (!forced && !isCurrentModelFlash && !CHEAP_MODELS.has(lower)) {
      overwrite.Model = target;
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
        contract: Boolean(overwrite.Prompt),
        forced,
      });
      return { decision: 'allow', overwrite };
    }
    logDecision({ hook: 'guard-subagent', tool, action: 'pass', mode, typeName, modelName: currentModel, model });
    return ALLOW;
  }

  /* follow-up work sent to an existing sub-agent: re-assert the contract */
  if (tool === SEND) {
    const key = typeof args.Message === 'string' ? 'Message' : typeof args.message === 'string' ? 'message' : null;
    if (!key) return ALLOW;
    const message = String(args[key]);
    if (message.includes(CONTRACT_MARKER) || message.includes(LEGACY_CONTRACT_MARKER)) return ALLOW;
    const reminder = `${CONTRACT_MARKER} 保持紧凑回报（禁止大段粘贴源码）：工程实现按四列表格回报，调研任务直接回复结构化要点。`;
    logDecision({ hook: 'guard-subagent', tool, action: 'contract', mode, key });
    return { decision: 'allow', overwrite: { [key]: `${message.replace(/\s+$/, '')}\n\n${reminder}` } };
  }

  return ALLOW;
}

try {
  output(decide());
} catch {
  output(ALLOW);
}
