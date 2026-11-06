#!/usr/bin/env node
/**
 * doctor.mjs — self-check for pro-flash-orchestrator v3.3.
 *
 * Runs every hook with synthetic payloads and asserts the decision shape, so a
 * bad matcher / wrong arg key / broken script is caught before it silently
 * fails open in a real session.  Usage:  node scripts/doctor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSubAgent } from './lib.mjs';
import { loadDecisions } from './report.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(SCRIPT_DIR);
const TMP = path.join(os.tmpdir(), `pro-doctor-${process.pid}`);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runHook(script, payload, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, script)], {
    input: JSON.stringify(payload),
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, PRO_TEST: '1', ARGON_TEST: '1', ...env },
  });
  const raw = (result.stdout || '').trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  assert(result.error === undefined, `spawn error: ${result.error && result.error.message}`);
  assert(json !== null, `stdout is not JSON: ${JSON.stringify(raw.slice(0, 160))} ${result.stderr ? `| stderr: ${result.stderr.slice(0, 160)}` : ''}`);
  return json;
}

function writeFixture(name, lines) {
  const file = path.join(TMP, name);
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(file, `${Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n')}\n`, 'utf8');
  return file;
}

function basePayload(extra = {}) {
  return {
    conversationId: 'doctor-test',
    workspacePaths: [TMP],
    artifactDirectoryPath: path.join(TMP, 'artifacts'),
    modelName: 'pro',
    lastUserInput: '继续把登录接口实现完',
    ...extra,
  };
}

console.log('\nPro-Flash Orchestrator v3.3 — doctor\n');

/* ------------------------------------------------------------ environment */
check('hooks.json 可解析，且引用的脚本都存在', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'hooks.json'), 'utf8'));
  const commands = [];
  for (const spec of Object.values(hooks)) {
    for (const event of ['SessionStart', 'PreToolUse', 'PreInvocation']) {
      for (const group of spec[event] || []) {
        for (const handler of (group.hooks || [group])) {
          if (handler.command) commands.push(handler.command);
        }
      }
    }
  }
  assert(commands.length >= 5, `expected >=5 hook handlers, found ${commands.length}`);
  for (const command of commands) {
    const rel = command.replace(/^node\s+/, '').replace(/^\.\//, '');
    assert(fs.existsSync(path.join(PLUGIN_DIR, rel)), `missing script: ${rel}`);
  }
});

check('node 在 Hook 的运行环境（cmd /c）里可用', () => {
  const probe = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'node -v'], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'node -v'], { encoding: 'utf8' });
  assert(probe.status === 0, `node 未在 PATH 中：Hook 会静默失效（${(probe.stderr || '').slice(0, 120)}）`);
});

/* ------------------------------------------------------------ session start */
check('SessionStart：主代理注入规则 + 状态卡片', () => {
  const out = runHook('session-start.mjs', basePayload());
  assert(Array.isArray(out.injectSteps) && out.injectSteps.length === 1, 'injectSteps missing');
  const step = out.injectSteps[0].systemMessage;
  assert(step && typeof step.systemMessage === 'string' && step.systemMessage.length > 0, 'systemMessage text missing');
  assert(step.renderInfo && typeof step.renderInfo.markdown === 'string', 'renderInfo.markdown missing');
  assert(!step.metadata, 'metadata.user_markdown panics the current Antigravity build (verified via agy -p) — must not be used');
});

check('SessionStart：子代理不再被注入 Pro 角色', () => {
  const out = runHook('session-start.mjs', basePayload({ parentConversationId: 'parent-1' }));
  assert(!out.injectSteps, 'sub-agent should get no role injection');
});

check('SessionStart：shadow 模式下 session-start 不注入卡片', () => {
  const out = runHook('session-start.mjs', basePayload(), { PRO_MODE: 'shadow' });
  assert(!out.injectSteps, `shadow mode must not inject steps, got ${JSON.stringify(out)}`);
});

check('isSubAgent：真实 transcript（首行 SYSTEM）在无 parentConversationId 时识别为子代理', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const subTranscript = path.join(TMP, 'doctor-sub-transcript.jsonl');
  fs.writeFileSync(
    subTranscript,
    JSON.stringify({
      step_index: 0,
      source: 'SYSTEM',
      type: 'USER_INPUT',
      content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-06T09:52:36Z sender=parent priority=MESSAGE_PRIORITY_HIGH content=[FLASH-WORKER] 测试\n</SYSTEM_MESSAGE>',
    }) + '\n',
    'utf8',
  );
  assert(isSubAgent({ transcriptPath: subTranscript }), 'transcript with SYSTEM source should be recognized as sub-agent');
  assert(isSubAgent({ lastUserInput: '[PRO-CONTRACT] 帮我实现' }), 'lastUserInput with PRO-CONTRACT should be recognized as sub-agent');
  assert(isSubAgent({ lastUserInput: '[ARGON-CONTRACT] 帮我实现' }), 'lastUserInput with ARGON-CONTRACT should be recognized as sub-agent');
  assert(isSubAgent({ lastUserInput: '[FLASH-WORKER] 帮我修复' }), 'lastUserInput with FLASH-WORKER should be recognized as sub-agent');
  assert(!isSubAgent({ lastUserInput: '普通用户请求' }), 'normal user request should not be sub-agent');
});

check('isSubAgent：SYSTEM_SDK 紧跟 [Message] 的子代理转录识别通过', () => {
  const subSdkTranscript = path.join(TMP, 'doctor-sub-sdk-transcript.jsonl');
  const lines = [
    JSON.stringify({ step_index: 0, source: 'SYSTEM_SDK', type: 'SYSTEM_EVENT', content: 'Session initialized' }),
    JSON.stringify({
      step_index: 1,
      source: 'SYSTEM',
      type: 'USER_INPUT',
      content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-06T09:52:36Z sender=parent priority=MESSAGE_PRIORITY_HIGH content=[FLASH-WORKER] 测试\n</SYSTEM_MESSAGE>',
    }),
  ];
  fs.writeFileSync(subSdkTranscript, `${lines.join('\n')}\n`, 'utf8');
  assert(isSubAgent({ transcriptPath: subSdkTranscript }), 'transcript with SYSTEM_SDK followed by SYSTEM [Message] should be recognized as sub-agent');
});

check('isSubAgent：首行 3KB 且含 "sender="、"[Message]" 的主会话转录不被误判为子代理', () => {
  const bigMainTranscript = path.join(TMP, 'doctor-big-main-transcript.jsonl');
  const padding = 'x'.repeat(3000);
  const line = JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content: `用户输入：请帮我分析 sender=parent 和 [Message] 的用法 ${padding}`,
  });
  fs.writeFileSync(bigMainTranscript, `${line}\n`, 'utf8');
  assert(!isSubAgent({ transcriptPath: bigMainTranscript }), 'first line 3KB USER_EXPLICIT must be main agent');
});

check('isSubAgent：主会话 transcript（首行 USER_EXPLICIT）即使正文含标记也不误判', () => {
  const mainTranscript = path.join(TMP, 'doctor-main-transcript.jsonl');
  fs.writeFileSync(
    mainTranscript,
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '帮我看看这段 [FLASH-WORKER] 和 [ARGON-CONTRACT] 的写法对不对',
    }) + '\n',
    'utf8',
  );
  assert(!isSubAgent({ transcriptPath: mainTranscript }), 'main transcript must win over token mentions');
  assert(
    !isSubAgent({ transcriptPath: mainTranscript, lastUserInput: '[FLASH-WORKER] 这段写法对吗' }),
    'readable main transcript must win over lastUserInput',
  );
});

check('isSubAgent：transcript 不存在时才退回 lastUserInput 前缀判定', () => {
  assert(isSubAgent({ transcriptPath: path.join(TMP, 'missing.jsonl'), lastUserInput: '[FLASH-WORKER] 修复' }), 'prefix fallback should hit');
  assert(!isSubAgent({ transcriptPath: path.join(TMP, 'missing.jsonl'), lastUserInput: '请参考 [FLASH-WORKER] 的写法' }), 'mid-sentence mention must not count');
});

/* ----------------------------------------------------------- subagent guard */
const dispatch = (args) => basePayload({ toolCall: { name: 'invoke_subagent', args } });

check('派单守门：Model="pro" 被降级为 flash', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'self', Model: 'pro', Prompt: '实现用户模块' }));
  assert(out.decision === 'allow', 'should allow');
  assert(out.overwrite && out.overwrite.Model === 'flash', `expected Model=flash, got ${JSON.stringify(out.overwrite)}`);
  assert(String(out.overwrite.Prompt).includes('[PRO-CONTRACT]'), 'contract not appended');
});

check('派单守门：research + inherit → flash_lite + 研究契约', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'research', Model: 'inherit', Prompt: '读一下 PRD' }));
  assert(out.overwrite.Model === 'flash_lite', `expected flash_lite, got ${out.overwrite && out.overwrite.Model}`);
  assert(String(out.overwrite.Prompt).includes('结构化摘要'), 'research contract missing');
});

check('派单守门：research 契约提醒在消息中输出，不要求写 artifact', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'research', Model: 'inherit', Prompt: '读一下 PRD' }));
  const prompt = String(out.overwrite && out.overwrite.Prompt);
  assert(prompt.includes('直接在消息中完整结构化输出'), 'missing direct message instruction');
  assert(!prompt.includes('.research.md'), 'should not instruct research agent to write artifact');
});

check('派单守门：双重编码的 Model（"pro"）仍能识别并降级', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'self', Model: '"pro"', Prompt: '实现' }));
  assert(out.overwrite && out.overwrite.Model === 'flash', `quoted pro not downgraded: ${JSON.stringify(out.overwrite)}`);
});

check('派单守门：双重编码的 Model（"flash_lite"）不被误升档', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'self', Model: '"flash_lite"', Prompt: '实现' }));
  assert(!out.overwrite || !out.overwrite.Model, `quoted flash_lite should pass: ${JSON.stringify(out.overwrite)}`);
});

check('派单守门：当前主模型已是 flash 时，subagent 不再降级', () => {
  const payload = dispatch({ TypeName: 'research', Model: 'inherit', Prompt: '读一下 PRD' });
  payload.modelName = 'Gemini 3.8 Flash (High)';
  const out = runHook('guard-subagent.mjs', payload);
  assert(!out.overwrite || !out.overwrite.Model, `expected no Model rewrite, got ${out.overwrite && out.overwrite.Model}`);
  assert(String(out.overwrite.Prompt).includes('结构化摘要'), 'contract should still be appended');
});

check('派单守门：主模型为 flash 时，派单 Model="pro" 仍被降级', () => {
  const payload = dispatch({ TypeName: 'self', Model: 'pro', Prompt: '实现' });
  payload.modelName = 'Gemini 3.8 Flash (High)';
  const out = runHook('guard-subagent.mjs', payload);
  assert(out.overwrite && out.overwrite.Model === 'flash', `expected downgrade to flash, got ${JSON.stringify(out.overwrite)}`);
});

check('派单守门：[FORCE-PRO] 保留 pro', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'self', Model: 'pro', Prompt: '[FORCE-PRO] 二审架构' }));
  assert(!out.overwrite || !out.overwrite.Model, `should not rewrite Model, got ${JSON.stringify(out.overwrite)}`);
});

check('派单守门：用户原话含 [FORCE-PRO] 也放行', () => {
  const payload = dispatch({ TypeName: 'self', Model: 'pro', Prompt: '二审架构' });
  payload.lastUserInput = '派个 pro 子代理 [FORCE-PRO] 帮我审';
  const out = runHook('guard-subagent.mjs', payload);
  assert(!out.overwrite || !out.overwrite.Model, 'user-level force token ignored');
});

check('派单守门：[FORCE-ARGON] 保留 pro', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'self', Model: 'pro', Prompt: '[FORCE-ARGON] 二审架构' }));
  assert(!out.overwrite || !out.overwrite.Model, `should not rewrite Model, got ${JSON.stringify(out.overwrite)}`);
});

check('派单守门：用户原话含 [FORCE-ARGON] 也放行', () => {
  const payload = dispatch({ TypeName: 'self', Model: 'pro', Prompt: '二审架构' });
  payload.lastUserInput = '派个 pro 子代理 [FORCE-ARGON] 帮我审';
  const out = runHook('guard-subagent.mjs', payload);
  assert(!out.overwrite || !out.overwrite.Model, 'user-level force token ignored');
});

check('派单守门：子代理套娃被 deny', () => {
  const payload = dispatch({ TypeName: 'self', Model: 'flash', Prompt: '再拆一层' });
  payload.parentConversationId = 'parent-1';
  const out = runHook('guard-subagent.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('派单守门：shadow 模式下不真的降级', () => {
  const out = runHook('guard-subagent.mjs', dispatch({ TypeName: 'self', Model: 'pro', Prompt: '实现' }), { PRO_MODE: 'shadow' });
  assert(out.decision === 'allow' && !out.overwrite, `shadow leaked a rewrite: ${JSON.stringify(out)}`);
});

check('派单守门：send_message 追加一行契约提醒', () => {
  const payload = basePayload({ toolCall: { name: 'send_message', args: { Recipient: 'conv-1', Message: '继续修一下那个测试' } } });
  const out = runHook('guard-subagent.mjs', payload);
  assert(out.decision === 'allow', 'should allow');
  assert(out.overwrite && String(out.overwrite.Message).includes('[PRO-CONTRACT]'), `contract not appended: ${JSON.stringify(out)}`);
});

check('派单守门：send_message 追加中立契约（不强迫写 artifact）', () => {
  const payload = basePayload({ toolCall: { name: 'send_message', args: { Recipient: 'conv-1', Message: '继续调研' } } });
  const out = runHook('guard-subagent.mjs', payload);
  assert(out.decision === 'allow', 'should allow');
  const msg = String(out.overwrite && out.overwrite.Message);
  assert(msg.includes('保持紧凑回报（禁止大段粘贴源码）：工程实现按四列表格回报，调研任务直接回复结构化要点。'), 'neutral contract missing');
  assert(!msg.includes('<task>.report.md'), 'should not force artifact file on follow-up message');
});

check('派单守门：send_message 给 Recipient: "user" 不追加契约', () => {
  const payload = basePayload({ toolCall: { name: 'send_message', args: { Recipient: 'user', Message: '这是给用户的回复' } } });
  const out = runHook('guard-subagent.mjs', payload);
  assert(out.decision === 'allow' && !out.overwrite, `expected allow without rewrite, got ${JSON.stringify(out)}`);
});

/* --------------------------------------------------------------- read guard */
const codeFile = writeFixture('big-code.js', 500);
const hugeCode = writeFixture('huge-code.js', 900);
const docFile = writeFixture('spec.md', 500);

check('读取守门：500 行代码被自动切片到 150 行', () => {
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'view_file', args: { AbsolutePath: codeFile } } }));
  assert(out.decision === 'allow', 'should allow');
  assert(out.overwrite && out.overwrite.StartLine === 1 && out.overwrite.EndLine === 150, `bad slice: ${JSON.stringify(out.overwrite)}`);
});

check('读取守门：900 行代码被拦截并要求派单', () => {
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'read_file', args: { AbsolutePath: hugeCode } } }));
  assert(out.decision === 'deny' && /flash_lite/.test(out.reason), `expected deny+flash_lite, got ${JSON.stringify(out)}`);
});

check('读取守门：500 行文档被拦截', () => {
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'view_file', args: { AbsolutePath: docFile } } }));
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('读取守门：子代理读同一文档放行（避免自锁）', () => {
  const payload = basePayload({ parentConversationId: 'parent-1', toolCall: { name: 'view_file', args: { AbsolutePath: docFile } } });
  const out = runHook('guard-read-file.mjs', payload);
  assert(out.decision === 'allow' && !out.overwrite, `sub-agent must pass, got ${JSON.stringify(out)}`);
});

check('读取守门：超出 150 行的显式切片被收窄', () => {
  const args = { AbsolutePath: codeFile, StartLine: 100, EndLine: 400 };
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'view_file', args } }));
  assert(out.overwrite && out.overwrite.StartLine === 100 && out.overwrite.EndLine === 249, `bad clamp: ${JSON.stringify(out.overwrite)}`);
});

check('读取守门：只给 StartLine 时补上 EndLine（避免读到 EOF）', () => {
  const args = { AbsolutePath: codeFile, StartLine: 100 };
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'view_file', args } }));
  assert(out.overwrite && out.overwrite.EndLine === 249 && out.overwrite.StartLine === undefined, `bad pin: ${JSON.stringify(out.overwrite)}`);
});

check('读取守门：用户点名的文件放行', () => {
  const payload = basePayload({
    lastUserInput: '帮我看下 huge-code.js 的第 10 行',
    toolCall: { name: 'view_file', args: { AbsolutePath: hugeCode } },
  });
  const out = runHook('guard-read-file.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('读取守门：node_modules 等生成物不受管', () => {
  const payload = basePayload({ toolCall: { name: 'view_file', args: { AbsolutePath: path.join(TMP, 'node_modules', 'x', 'index.js') } } });
  const out = runHook('guard-read-file.mjs', payload);
  assert(out.decision === 'allow', 'node_modules should be exempt');
});

check('读取守门：Python .venv 目录不受管', () => {
  const venvCode = path.join(TMP, '.venv', 'lib', 'site-packages', 'pkg', 'huge.py');
  fs.mkdirSync(path.dirname(venvCode), { recursive: true });
  fs.writeFileSync(venvCode, `${Array.from({ length: 900 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`, 'utf8');
  const payload = basePayload({ toolCall: { name: 'view_file', args: { AbsolutePath: venvCode } } });
  const out = runHook('guard-read-file.mjs', payload);
  assert(out.decision === 'allow' && !out.overwrite, `expected allow without slice, got ${JSON.stringify(out)}`);
});

check('读取守门：Rust target 目录不受管', () => {
  const targetCode = path.join(TMP, 'target', 'debug', 'build', 'huge.rs');
  fs.mkdirSync(path.dirname(targetCode), { recursive: true });
  fs.writeFileSync(targetCode, `${Array.from({ length: 900 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`, 'utf8');
  const payload = basePayload({ toolCall: { name: 'view_file', args: { AbsolutePath: targetCode } } });
  const out = runHook('guard-read-file.mjs', payload);
  assert(out.decision === 'allow' && !out.overwrite, `expected allow without slice, got ${JSON.stringify(out)}`);
});



const geminiWsCode = path.join(TMP, '.gemini', 'workspace', 'big-code.js');
fs.mkdirSync(path.dirname(geminiWsCode), { recursive: true });
fs.writeFileSync(geminiWsCode, `${Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`, 'utf8');

check('读取守门：工作区路径含 .gemini 时不被误豁免，仍执行切片', () => {
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'view_file', args: { AbsolutePath: geminiWsCode } } }));
  assert(out.decision === 'allow', 'should allow');
  assert(out.overwrite && out.overwrite.StartLine === 1 && out.overwrite.EndLine === 150, `bad slice on .gemini workspace path: ${JSON.stringify(out.overwrite)}`);
});

check('读取守门：正斜杠表示的 artifactDirectoryPath 下的文件被正确豁免放行', () => {
  const forwardSlashArtifactDir = path.join(TMP, 'artifacts').replace(/\\/g, '/');
  const artifactDoc = path.join(TMP, 'artifacts', 'huge-artifact.md');
  fs.mkdirSync(path.dirname(artifactDoc), { recursive: true });
  fs.writeFileSync(artifactDoc, `${Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`, 'utf8');

  const payload = basePayload({
    artifactDirectoryPath: forwardSlashArtifactDir,
    toolCall: { name: 'view_file', args: { AbsolutePath: artifactDoc } },
  });
  const out = runHook('guard-read-file.mjs', payload);
  assert(out.decision === 'allow' && !out.overwrite, `expected allow without slice, got ${JSON.stringify(out)}`);
});

check('读取守门：2MB .log 文件被拦截', () => {
  const log2mb = path.join(TMP, 'large-app.log');
  fs.writeFileSync(log2mb, Buffer.alloc(2 * 1024 * 1024, 0x61));
  const out = runHook('guard-read-file.mjs', basePayload({ toolCall: { name: 'read_file', args: { AbsolutePath: log2mb } } }));
  assert(out.decision === 'deny' && /数据\/日志文件/.test(out.reason), `expected deny for 2MB log, got ${JSON.stringify(out)}`);
});

/* ------------------------------------------------------------ command guard */
const bigLog = path.join(TMP, 'build-output.log');
fs.writeFileSync(bigLog, 'x'.repeat(1024 * 1024), 'utf8');

check('命令守门：cat 1MB 日志被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}"` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：powershell -Command "cat \\"${bigLog}\\"" 1MB 日志被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `powershell -Command "cat \\"${bigLog}\\""` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：Get-Content -Path 1MB 日志被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `Get-Content -Path "${bigLog}"` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：Get-Content -LiteralPath 1MB 日志被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `Get-Content -LiteralPath "${bigLog}"` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：有界管道放行', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}" | head -n 20` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：无界 git log 被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: 'git log' } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：powershell -Command "git log" 被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: 'powershell -Command "git log"' } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：git log -n 5 放行', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: 'git log -n 5 --oneline' } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：cat 1MB.log > output.txt 放行', () => {
  const outPath = path.join(TMP, 'output.txt');
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}" > "${outPath}"` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：cat 1MB.log > /dev/null 放行', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}" > /dev/null` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：cat 1MB.log > $null 放行', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}" > $null` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：cat 1MB.log > NUL 放行', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}" > NUL` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：Get-Content 1MB.log | Set-Content 放行', () => {
  const outPath = path.join(TMP, 'copy.txt');
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `Get-Content "${bigLog}" | Set-Content "${outPath}"` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：Get-Content 1MB.log | Out-Null 放行', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `Get-Content "${bigLog}" | Out-Null` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'allow', `expected allow, got ${JSON.stringify(out)}`);
});

check('命令守门：cat 1MB.log; echo hi | head -1 被正确拦截（复合命令逃逸测试）', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `cat "${bigLog}"; echo hi | head -1` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：git --no-pager log 被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: 'git --no-pager log' } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

check('命令守门：wsl cat 1MB.log 被拦截', () => {
  const payload = basePayload({ toolCall: { name: 'run_command', args: { CommandLine: `wsl cat "${bigLog}"` } } });
  const out = runHook('guard-command.mjs', payload);
  assert(out.decision === 'deny', `expected deny, got ${JSON.stringify(out)}`);
});

/* ------------------------------------------------------------ pre-invocation */
check('漂移提醒：连续改文件不派单时注入一次', () => {
  const transcript = path.join(TMP, 'transcript.jsonl');
  const lines = [
    '{"toolCall":{"name":"write_to_file"}}',
    '{"toolCall":{"name":"edit_file"}}',
    '{"toolCall":{"name":"write_to_file"}}',
    '{"toolCall":{"name":"edit_file"}}',
  ];
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  const out = runHook('pre-invocation.mjs', basePayload({ conversationId: 'doctor-drift', invocationNum: 10, transcriptPath: transcript }));
  assert(Array.isArray(out.injectSteps) && out.injectSteps.length === 1, `expected 1 step, got ${JSON.stringify(out)}`);
  assert(String(out.injectSteps[0].ephemeralMessage).includes('invoke_subagent'), 'nudge text missing');
});

check('漂移提醒：干净会话保持静默', () => {
  const transcript = path.join(TMP, 'clean.jsonl');
  fs.writeFileSync(transcript, '{"toolCall":{"name":"invoke_subagent"}}\n', 'utf8');
  const out = runHook('pre-invocation.mjs', basePayload({ conversationId: 'doctor-clean', invocationNum: 2, transcriptPath: transcript }));
  assert(!out.injectSteps, `expected silence, got ${JSON.stringify(out)}`);
});

check('漂移提醒：早期派单不再掩盖其后的连续直改', () => {
  const transcript = path.join(TMP, 'drift-after-dispatch.jsonl');
  const lines = [
    '{"toolCall":{"name":"invoke_subagent"}}',
    '{"toolCall":{"name":"write_to_file"}}',
    '{"toolCall":{"name":"edit_file"}}',
    '{"toolCall":{"name":"write_to_file"}}',
    '{"toolCall":{"name":"edit_file"}}',
  ];
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  const out = runHook('pre-invocation.mjs', basePayload({ conversationId: 'doctor-drift-after', invocationNum: 10, transcriptPath: transcript }));
  assert(Array.isArray(out.injectSteps) && out.injectSteps.length === 1, `expected 1 step, got ${JSON.stringify(out)}`);
});

check('漂移提醒：刚刚派过单就不唠叨', () => {
  const transcript = path.join(TMP, 'dispatch-last.jsonl');
  const lines = [
    '{"toolCall":{"name":"write_to_file"}}',
    '{"toolCall":{"name":"edit_file"}}',
    '{"toolCall":{"name":"write_to_file"}}',
    '{"toolCall":{"name":"edit_file"}}',
    '{"toolCall":{"name":"invoke_subagent"}}',
  ];
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  const out = runHook('pre-invocation.mjs', basePayload({ conversationId: 'doctor-dispatch-last', invocationNum: 10, transcriptPath: transcript }));
  assert(!out.injectSteps, `expected silence, got ${JSON.stringify(out)}`);
});

check('上下文压力：用 renderInfo 提示，不用会 panic 的 metadata', () => {
  const transcript = path.join(TMP, 'pressure.jsonl');
  fs.writeFileSync(transcript, 'x'.repeat(4 * 1024 * 1024), 'utf8');
  const out = runHook('pre-invocation.mjs', basePayload({ conversationId: 'doctor-pressure', invocationNum: 50, transcriptPath: transcript }));
  assert(Array.isArray(out.injectSteps) && out.injectSteps.length === 1, `expected 1 step, got ${JSON.stringify(out).slice(0, 200)}`);
  const step = out.injectSteps[0].systemMessage;
  assert(step && step.renderInfo && typeof step.renderInfo.markdown === 'string', 'renderInfo markdown missing');
  assert(!step.metadata, 'metadata must not be used');
});

check('漂移提醒：write_file 连续 4 次正确触发漂移提醒', () => {
  const transcript = path.join(TMP, 'drift-write-file.jsonl');
  const lines = [
    '{"toolCall":{"name":"write_file"}}',
    '{"toolCall":{"name":"write_file"}}',
    '{"toolCall":{"name":"write_file"}}',
    '{"toolCall":{"name":"write_file"}}',
  ];
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  const out = runHook('pre-invocation.mjs', basePayload({ conversationId: 'doctor-drift-wf', invocationNum: 10, transcriptPath: transcript }));
  assert(Array.isArray(out.injectSteps) && out.injectSteps.length === 1, `expected 1 step, got ${JSON.stringify(out)}`);
  assert(String(out.injectSteps[0].ephemeralMessage).includes('invoke_subagent'), 'nudge text missing');
});

/* ------------------------------------------------------------------ report */
check('决策复盘：report.mjs 能正确解析 decisions.1.jsonl 与归档日志', () => {
  const testStateDir = path.join(TMP, 'test-state');
  fs.mkdirSync(testStateDir, { recursive: true });
  const nowIso = new Date().toISOString();
  const rec1 = { ts: nowIso, conv: 'c1', hook: 'guard-read-file', action: 'slice', base: 'a.js', lines: 500 };
  const rec2 = { ts: nowIso, conv: 'c2', hook: 'guard-subagent', action: 'rewrite', from: 'pro', to: 'flash' };
  const rec3 = { ts: nowIso, conv: 'c3', hook: 'guard-command', action: 'deny', command: 'git log' };

  fs.writeFileSync(path.join(testStateDir, 'decisions.jsonl'), `${JSON.stringify(rec1)}\n`, 'utf8');
  fs.writeFileSync(path.join(testStateDir, 'decisions.1.jsonl'), `${JSON.stringify(rec2)}\n`, 'utf8');
  fs.writeFileSync(path.join(testStateDir, 'decisions.archive-2026-11-06.jsonl'), `${JSON.stringify(rec3)}\n`, 'utf8');

  const parsed = loadDecisions(testStateDir, Date.now() - 3600000);
  assert(parsed.length === 3, `expected 3 parsed decisions, got ${parsed.length}`);
  const actions = new Set(parsed.map((p) => p.action));
  assert(actions.has('slice') && actions.has('rewrite') && actions.has('deny'), 'missing expected actions from rotated/archived files');
});

/* -------------------------------------------------------------------- done */
try {
  fs.rmSync(TMP, { recursive: true, force: true });
  const sessions = path.join(PLUGIN_DIR, '.state', 'sessions');
  for (const file of fs.readdirSync(sessions)) {
    if (file.startsWith('doctor-')) fs.rmSync(path.join(sessions, file), { force: true });
  }
} catch {
  /* ignore */
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
console.log('提示：确认 `read_file` 的 StartLine/EndLine 切片已在 Antigravity 平台验证支持。\n');
process.exit(0);
