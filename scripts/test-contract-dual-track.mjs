#!/usr/bin/env node
/**
 * Dual-track acceptance contract regression tests:
 * 1. research single dispatch -> 【深度研报契约】 (no "≤30 行")
 * 2. research multi/concurrent dispatch -> 【并发调研契约】
 * 3. self dispatch -> four-column table + concurrency safety boundaries
 * 4. send_message reminder -> updated dual-track reminder
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-contract-dual-track-'));
const WORKSPACE = path.join(TMP, 'workspace');
const STATE = path.join(TMP, 'state');
fs.mkdirSync(WORKSPACE, { recursive: true });

for (const key of ['PRO_TEST', 'ARGON_TEST', 'PRO_HARNESS', 'PRO_WORKER_MODEL', 'PRO_RESEARCH_MODEL', 'PRO_SELF_MODEL', 'PRO_NATIVE_ORCHESTRATOR']) {
  process.env[key] = '';
}
process.env.PRO_STATE_DIR = STATE;
process.env.PRO_MODE = 'enforce';
process.env.CODEX_HOME = path.join(TMP, 'codex-home');

const mainTranscript = path.join(TMP, 'main.jsonl');
fs.writeFileSync(mainTranscript, JSON.stringify({ source: 'USER_EXPLICIT', content: 'task prompt' }) + '\n');

const base = (id, extra = {}) => ({
  conversationId: id,
  transcriptPath: mainTranscript,
  workspacePaths: [WORKSPACE],
  lastUserInput: 'perform research and implementation',
  ...extra,
});

const dispatch = (id, type = 'self', prompt = 'execute task', extra = {}) =>
  base(id, {
    toolCall: {
      name: 'invoke_subagent',
      args: { TypeName: type, Model: 'inherit', Prompt: prompt },
    },
    ...extra,
  });

function hook(script, payload, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failures.push(name);
    console.error('FAIL ' + name + ': ' + error.stack);
  }
}

try {
  // Test 1: research single dispatch injects 【深度研报契约】 and does not contain "≤30 行"
  await test('research single dispatch injects depth research contract without 30-line limit', () => {
    const convId = 'research-single-test';
    const out = hook('guard-subagent.mjs', dispatch(convId, 'research', 'explore codebase architecture', { turnId: 'turn-1' }));
    assert.equal(out.decision, 'allow');
    assert(out.overwrite && out.overwrite.Prompt, 'Expected Prompt to be overwritten');
    const prompt = out.overwrite.Prompt;

    assert(prompt.includes('[PRO-CONTRACT]'), 'Must include [PRO-CONTRACT]');
    assert(prompt.includes('【深度研报契约】'), 'Must include 【深度研报契约】');
    assert(prompt.includes('典范报告格式'), 'Must include 典范报告格式');
    assert(prompt.includes('1. 关键模块/任务深度剖析'), 'Must include 1. 关键模块/任务深度剖析');
    assert(prompt.includes('2. 具体文件、行号与事实证据'), 'Must include 2. 具体文件、行号与事实证据');
    assert(prompt.includes('3. 核心薄弱环节与风险诊断'), 'Must include 3. 核心薄弱环节与风险诊断');
    assert(prompt.includes('4. 最有价值的 Top 优化建议'), 'Must include 4. 最有价值的 Top 优化建议');
    assert(prompt.includes('严禁粘贴大段无关源码原文（单段 ≤10 行）'), 'Must include single snippet restriction');
    assert(prompt.includes('因 research 属于只读探路代理，全部研究结论请直接在消息中完整结构化输出'), 'Must include read-only statement');
    assert(prompt.includes(`[PRO-PARENT:${convId}]`), 'Must include parent link');

    // Crucial check: 30-line restriction abolished
    assert(!prompt.includes('≤30 行'), 'Must NOT include ≤30 行');
    assert(!prompt.includes('30 行'), 'Must NOT include 30 行');
  });

  // Test 2: research concurrent/multi dispatch injects 【并发调研契约】
  await test('research concurrent multi dispatch injects concurrent research contract', () => {
    const convId = 'research-multi-test';
    const turnId = 'turn-concurrent';

    // First dispatch in turn -> single (currentBatchSpawns = 1)
    const out1 = hook('guard-subagent.mjs', dispatch(convId, 'research', 'investigate module A', { turnId }));
    assert.equal(out1.decision, 'allow');
    assert(out1.overwrite.Prompt.includes('【深度研报契约】'));

    // Second dispatch in same turn -> multi (currentBatchSpawns = 2)
    const out2 = hook('guard-subagent.mjs', dispatch(convId, 'research', 'investigate module B', { turnId }));
    assert.equal(out2.decision, 'allow');
    assert(out2.overwrite && out2.overwrite.Prompt, 'Expected Prompt to be overwritten');
    const prompt2 = out2.overwrite.Prompt;

    assert(prompt2.includes('[PRO-CONTRACT]'), 'Must include [PRO-CONTRACT]');
    assert(prompt2.includes('【并发调研契约】'), 'Must include 【并发调研契约】');
    assert(prompt2.includes('reports/<task>.md'), 'Must instruct to write to reports/<task>.md');
    assert(prompt2.includes('核心结论速查、关键文件与行号证据、风险隐患与 Top 优化建议'), 'Must include summary items');
    assert(prompt2.includes('严禁回贴大段无关源码（单段 ≤10 行）'), 'Must include snippet limit');
    assert(prompt2.includes(`[PRO-PARENT:${convId}]`), 'Must include parent link');
    assert(!prompt2.includes('≤30 行'), 'Must NOT include ≤30 行');
  });

  // Test 3: self dispatch injects four-column table and safety boundary redlines
  await test('self dispatch injects four-column table and safety boundaries', () => {
    const convId = 'self-dispatch-test';
    const out = hook('guard-subagent.mjs', dispatch(convId, 'self', 'implement feature', { turnId: 'turn-self' }));
    assert.equal(out.decision, 'allow');
    assert(out.overwrite && out.overwrite.Prompt, 'Expected Prompt to be overwritten');
    const prompt = out.overwrite.Prompt;

    assert(prompt.includes('[PRO-CONTRACT]'), 'Must include [PRO-CONTRACT]');
    assert(prompt.includes('完成后仅回复四列表格，禁止粘贴源码（单段代码 ≤10 行）'), 'Must include table prompt');
    assert(prompt.includes('| 文件绝对路径 | 起止行号 | 核心变更 | 自检命令与结果 |'), 'Must include four columns');
    assert(prompt.includes('【多代理并发安全与边界红线】'), 'Must include concurrency safety section');
    assert(prompt.includes('1. 文件互斥红线：专属写入范围与只读参考范围隔离'), 'Must include file mutex rule');
    assert(prompt.includes('2. 精准局部测试红线：自检验证仅运行针对修改模块的单文件局部测试'), 'Must include local test rule');
    assert(prompt.includes(`[PRO-PARENT:${convId}]`), 'Must include parent link');
  });

  // Test 4: send_message reminder injects updated dual-track reminder
  await test('send_message injects updated dual-track reminder', () => {
    const convId = 'send-message-test';
    const payload = base(convId, {
      toolCall: {
        name: 'send_message',
        args: {
          Recipient: 'worker-sub-1',
          Message: 'Please proceed with the next step.',
        },
      },
    });
    const out = hook('guard-subagent.mjs', payload);
    assert.equal(out.decision, 'allow');
    assert(out.overwrite && out.overwrite.Message, 'Expected Message to be overwritten');
    const msg = out.overwrite.Message;

    assert(msg.includes('Please proceed with the next step.'), 'Original message preserved');
    assert(msg.includes('[PRO-CONTRACT]'), 'Must include [PRO-CONTRACT]');
    assert(
      msg.includes('保持紧凑回报（禁止大段粘贴源码）：工程实现按四列表格回报，调研任务直接回复结构化要点。'),
      'Must include updated dual-track reminder'
    );
  });

  // Test 5: define_subagent with read-only / research name gets depth research contract
  await test('define_subagent for read-only research gets depth research contract', () => {
    const convId = 'define-sub-test';
    const payload = base(convId, {
      toolCall: {
        name: 'define_subagent',
        args: {
          Name: 'custom-researcher',
          SystemPrompt: 'You are an explorer.',
          EnableWriteTools: false,
        },
      },
    });
    const out = hook('guard-subagent.mjs', payload);
    assert.equal(out.decision, 'allow');
    assert(out.overwrite && out.overwrite.SystemPrompt, 'Expected SystemPrompt to be overwritten');
    assert(out.overwrite.SystemPrompt.includes('【深度研报契约】'));
    assert(!out.overwrite.SystemPrompt.includes('≤30 行'));
  });
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}

if (failures.length > 0) {
  console.error(`\nTest failures (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} contract dual-track tests passed.`);
}
