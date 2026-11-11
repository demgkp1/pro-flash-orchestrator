#!/usr/bin/env node
/**
 * Concurrency, Quota & Swarm Architecture Test Suite for Pro-Flash Orchestrator
 */
import assert from 'node:assert/strict';
import { spawnSync, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(SCRIPT_DIR);

const TMP_DIR = path.join(os.tmpdir(), `pro-concurrency-state-${process.pid}`);
fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
process.env.PRO_STATE_DIR = TMP_DIR;

const {
  acquireLock,
  checkAndClaimSubagent,
  isSubAgent,
  markSubagentSpawn,
  readSession,
  releaseLock,
  safeWriteFileSync,
  SESSION_DIR,
  SPAWN_FILE,
  SPAWN_LOCK,
  STATE_DIR,
  updateSession,
  writeSession,
} = await import('./lib.mjs');

function runHook(script, payload, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, script)], {
    input: JSON.stringify(payload),
    env: { ...process.env, PRO_STATE_DIR: TMP_DIR, ...env },
    encoding: 'utf8',
  });
  const raw = (result.stdout || '').trim();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {}
  assert(json !== null, `Hook ${script} output is not valid JSON: ${raw}`);
  return json;
}

async function test1_concurrentUpdateSession() {
  console.log('\n[TEST 1] 8 进程并发读写 updateSession 压测');
  const convId = 'concurrency-stress-test';
  const sessFile = path.join(SESSION_DIR, `${convId}.json`);
  const lockFile = path.join(SESSION_DIR, `${convId}.lock`);
  try { fs.unlinkSync(sessFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}

  updateSession(convId, (s) => {
    s.counter = 0;
    s.items = [];
    return s;
  });

  const workerScript = path.join(SCRIPT_DIR, '_worker_test.mjs');
  fs.writeFileSync(
    workerScript,
    `
import { updateSession } from './lib.mjs';
const workerId = process.argv[2];
const convId = process.argv[3];
for (let i = 0; i < 20; i++) {
  updateSession(convId, (s) => {
    s.counter = (s.counter || 0) + 1;
    s.items = s.items || [];
    s.items.push(workerId + '-' + i);
    return s;
  });
}
`,
    'utf8',
  );

  const workers = [];
  const numWorkers = 8;
  for (let w = 0; w < numWorkers; w++) {
    workers.push(
      new Promise((resolve, reject) => {
        const child = fork(workerScript, [`w${w}`, convId], {
          cwd: SCRIPT_DIR,
          env: { ...process.env, PRO_STATE_DIR: TMP_DIR },
        });
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Worker ${w} exited with code ${code}`));
        });
      }),
    );
  }

  await Promise.all(workers);
  try { fs.unlinkSync(workerScript); } catch {}

  const state = readSession(convId);
  assert.equal(state.counter, 160, `Expected counter 160, got ${state.counter}`);
  assert.equal(state.items.length, 160, `Expected items length 160, got ${state.items.length}`);
  try { fs.unlinkSync(sessFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
  console.log('  PASS 8 进程各累加 20 次（共 160 次更新），数据 100% 完整，无丢数与覆盖！');
}

async function test2_spawnPoolClaims() {
  console.log('\n[TEST 2] 并发冷启动身份认领池测试');
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}

  // 1. 并发多进程调用 markSubagentSpawn 与 checkAndClaimSubagent 压力测试
  const spawnWorkerScript = path.join(SCRIPT_DIR, '_spawn_claim_worker.mjs');
  fs.writeFileSync(
    spawnWorkerScript,
    `
import { markSubagentSpawn, checkAndClaimSubagent } from './lib.mjs';
const mode = process.argv[2];
const workerId = process.argv[3];
const count = Number(process.argv[4] || 3);

if (mode === 'spawn') {
  for (let i = 0; i < count; i++) {
    markSubagentSpawn('parent-' + workerId);
  }
} else if (mode === 'claim') {
  const claims = [];
  for (let i = 0; i < count; i++) {
    const res = checkAndClaimSubagent('worker-' + workerId + '-' + i, 'parent-sp-' + workerId.split('-').pop());
    if (res && res.isSubAgent) claims.push(res);
  }
  process.stdout.write(JSON.stringify(claims));
}
`,
    'utf8',
  );

  // 4 个 spawner 并发写入，每个写入 3 个，共 12 个 spawn
  const spawners = [];
  for (let s = 0; s < 4; s++) {
    spawners.push(
      new Promise((resolve, reject) => {
        const child = fork(spawnWorkerScript, ['spawn', `sp-${s}`, '3'], {
          cwd: SCRIPT_DIR,
          env: { ...process.env, PRO_STATE_DIR: TMP_DIR },
        });
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Spawner ${s} exited with code ${code}`));
        });
      }),
    );
  }
  await Promise.all(spawners);

  const poolAfterConcurrentSpawns = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8'));
  assert.equal(poolAfterConcurrentSpawns.pendingCount, 12, `Expected 12 pending spawns, got ${poolAfterConcurrentSpawns.pendingCount}`);
  assert.equal(poolAfterConcurrentSpawns.spawns.length, 12, `Expected 12 total spawns, got ${poolAfterConcurrentSpawns.spawns.length}`);

  // 4 个 claimer 并发认领，每个认领 3 个，共 12 个 claim
  const claimers = [];
  const claimedResults = [];
  for (let c = 0; c < 4; c++) {
    claimers.push(
      new Promise((resolve, reject) => {
        const child = fork(spawnWorkerScript, ['claim', `cl-${c}`, '3'], {
          cwd: SCRIPT_DIR,
          env: { ...process.env, PRO_STATE_DIR: TMP_DIR },
          stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('exit', (code) => {
          if (code === 0) {
            try {
              claimedResults.push(...JSON.parse(out || '[]'));
              resolve();
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error(`Claimer ${c} exited with code ${code}`));
          }
        });
      }),
    );
  }
  await Promise.all(claimers);
  try { fs.unlinkSync(spawnWorkerScript); } catch {}

  assert.equal(claimedResults.length, 12, `All 12 claims must succeed, got ${claimedResults.length}`);
  const poolAfterConcurrentClaims = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8'));
  assert.equal(poolAfterConcurrentClaims.pendingCount, 0, 'All spawns should be claimed concurrently');
  console.log('  PASS 多进程并发 markSubagentSpawn (12次) 与 checkAndClaimSubagent (12次) 互斥原子认领通过！');

  // 2. 依次隔离认领、幂等、防自领与耗尽判定
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}

  const parentId = 'test-parent-conv-1';
  markSubagentSpawn(parentId);
  markSubagentSpawn(parentId);
  markSubagentSpawn(parentId);

  const raw = fs.readFileSync(SPAWN_FILE, 'utf8');
  const pool = JSON.parse(raw);
  assert.equal(pool.pendingCount, 3, `Expected pendingCount 3, got ${pool.pendingCount}`);
  assert.equal(pool.spawns.length, 3, `Expected spawns length 3, got ${pool.spawns.length}`);

  assert.equal(checkAndClaimSubagent('unrelated-main'), null, 'No identity claim without parent evidence');
  const claim1 = checkAndClaimSubagent('child-worker-alpha', parentId);
  const claim2 = checkAndClaimSubagent('child-worker-beta', parentId);
  const claim3 = checkAndClaimSubagent('child-worker-gamma', parentId);

  assert.equal(claim1?.isSubAgent, true);
  assert.equal(claim1?.parent, parentId);
  assert.equal(claim2?.isSubAgent, true);
  assert.equal(claim2?.parent, parentId);
  assert.equal(claim3?.isSubAgent, true);
  assert.equal(claim3?.parent, parentId);

  const poolAfter = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8'));
  assert.equal(poolAfter.pendingCount, 0, 'All spawns should be claimed');

  const claim1Again = checkAndClaimSubagent('child-worker-alpha', parentId);
  assert.equal(claim1Again?.isSubAgent, true);
  assert.equal(claim1Again?.parent, parentId);

  const claim4 = checkAndClaimSubagent('child-worker-delta', parentId);
  assert.equal(claim4, null, '4th child should not claim any spawn');

  markSubagentSpawn('test-parent-conv-2');
  const parentClaim = checkAndClaimSubagent('test-parent-conv-2', 'test-parent-conv-2');
  assert.equal(parentClaim, null, 'Parent cannot claim its own spawn');
  console.log('  PASS 并发派生池支持多子代理依次隔离认领，防冲撞、幂等与耗尽判定通过！');

  // 3. 显式验证带有 toolCall 的 payload（首次触发 PreToolUse 的子代理）在 isSubAgent 中被正确认领
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}

  const toolCallParentId = 'test-parent-toolcall-conv';
  markSubagentSpawn(toolCallParentId);

  const subPayloadWithToolCall = {
    conversationId: 'sub-worker-coldstart-toolcall',
    parentConversationId: toolCallParentId,
    toolCall: {
      name: 'read_file',
      args: { Path: '/workspace/src/index.js', StartLine: 1, EndLine: 20 },
    },
    lastUserInput: '请阅读代码',
  };

  const isSubIdentified = isSubAgent(subPayloadWithToolCall);
  assert.equal(isSubIdentified, true, 'PreToolUse payload with toolCall must be recognized as subagent on cold start');

  const subSess = readSession('sub-worker-coldstart-toolcall');
  assert.equal(subSess.isSubAgent, true, 'Session isSubAgent must be true');
  assert.equal(subSess.parentConversationId, toolCallParentId, 'parentConversationId must match toolCallParentId');

  const poolAfterToolCall = JSON.parse(fs.readFileSync(SPAWN_FILE, 'utf8'));
  assert.equal(poolAfterToolCall.pendingCount, 0, 'Spawn should be claimed by toolCall payload');

  try { fs.unlinkSync(path.join(SESSION_DIR, 'sub-worker-coldstart-toolcall.json')); } catch {}
  try { fs.unlinkSync(path.join(SESSION_DIR, 'sub-worker-coldstart-toolcall.lock')); } catch {}
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}
  console.log('  PASS 首次触发 PreToolUse 携带 toolCall 的子代理在 verdict===null 下正确完成身份认领！');
}

async function test3_quotaAndDynamicRead() {
  console.log('\n[TEST 3] 守门员并发配额（1~5 放行，第 6 次 deny）与动态 Read 扩容');
  const convId = 'test-quota-conv';
  const sessFile = path.join(SESSION_DIR, `${convId}.json`);
  const lockFile = path.join(SESSION_DIR, `${convId}.lock`);
  try { fs.unlinkSync(sessFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}

  const dispatchPayload = (num) => ({
    conversationId: convId,
    toolCall: {
      name: 'invoke_subagent',
      args: { TypeName: 'self', Model: 'flash', Prompt: `子任务 ${num}` },
    },
    lastUserInput: '请并发执行',
  });

  // 连续 6 次调用 guard-subagent.mjs：第 1~5 次放行且 maxReadsAllowed 正确动态扩容（至 6/8/10），第 6 次物理 deny
  const expectedMaxReads = { 1: 3, 2: 4, 3: 6, 4: 8, 5: 10 };
  for (let i = 1; i <= 5; i++) {
    const res = runHook('guard-subagent.mjs', dispatchPayload(i));
    assert.equal(res.decision, 'allow', `Call ${i} should be allowed, got ${JSON.stringify(res)}`);
    const sess = readSession(convId);
    assert.equal(sess.currentBatchSpawns, i, `Expected ${i} batch spawns, got ${sess.currentBatchSpawns}`);
    assert.equal(
      sess.maxReadsAllowed,
      expectedMaxReads[i],
      `Call ${i} expected maxReadsAllowed ${expectedMaxReads[i]}, got ${sess.maxReadsAllowed}`,
    );
  }

  const res6 = runHook('guard-subagent.mjs', dispatchPayload(6));
  assert.equal(res6.decision, 'deny', `Call 6 should be denied, got ${JSON.stringify(res6)}`);
  assert(res6.reason.includes('【并发守门拦截】'), `Reason should include 【并发守门拦截】, got: ${res6.reason}`);
  console.log('  PASS 守门员单轮并发上限 5 个有效控制，第 1~5 次放行且 maxReadsAllowed 成功动态扩容（至 6/8/10），第 6 次被物理拦截！');

  // Dynamic Read Expansion test
  const readConvId = 'test-dyn-read-conv';
  const readSessFile = path.join(SESSION_DIR, `${readConvId}.json`);
  const readLockFile = path.join(SESSION_DIR, `${readConvId}.lock`);
  try { fs.unlinkSync(readSessFile); } catch {}
  try { fs.unlinkSync(readLockFile); } catch {}
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}

  for (let i = 1; i <= 3; i++) {
    runHook('guard-subagent.mjs', {
      conversationId: readConvId,
      toolCall: {
        name: 'invoke_subagent',
        args: { TypeName: 'self', Model: 'flash', Prompt: `Task ${i}` },
      },
      lastUserInput: '开始多代理协同',
    });
  }

  const readSess = readSession(readConvId);
  assert.equal(readSess.maxReadsAllowed, 6, `Expected maxReadsAllowed 6, got ${readSess.maxReadsAllowed}`);

  const tmpDir = path.join(os.tmpdir(), `pro-concurrency-test-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const testFiles = [];
  for (let f = 1; f <= 7; f++) {
    const file = path.join(tmpDir, `read_test_${f}.js`);
    fs.writeFileSync(file, `// file ${f}\nconsole.log(${f});\n`, 'utf8');
    testFiles.push(file);
  }

  for (let f = 0; f < 6; f++) {
    const r = runHook('guard-read-file.mjs', {
      conversationId: readConvId,
      toolCall: {
        name: 'read_file',
        args: { Path: testFiles[f], StartLine: 1, EndLine: 2 },
      },
      lastUserInput: '请审查代码',
    });
    assert.equal(r.decision, 'allow', `Read ${f+1} should be allowed, got ${JSON.stringify(r)}`);
  }

  const r7 = runHook('guard-read-file.mjs', {
    conversationId: readConvId,
    toolCall: {
      name: 'read_file',
      args: { Path: testFiles[6], StartLine: 1, EndLine: 2 },
    },
    lastUserInput: '请审查代码',
  });
  assert.equal(r7.decision, 'deny', `7th read should be denied, got ${JSON.stringify(r7)}`);
  assert(r7.reason.includes('6 个不同文件'), `Reason should mention 6 files, got: ${r7.reason}`);
  console.log('  PASS 动态 Read 配额成功扩容至 6，读取 6 个不同文件均放行，第 7 个被正确拦截！');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(readSessFile); } catch {}
  try { fs.unlinkSync(readLockFile); } catch {}
  try { fs.unlinkSync(sessFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
  try { fs.unlinkSync(SPAWN_FILE); } catch {}
  try { fs.unlinkSync(SPAWN_LOCK); } catch {}
}

async function test4_recursionAndPollingGuards() {
  console.log('\n[TEST 4] 递归派发、反轮询与契约注入回归测试');

  const subagentPayload = {
    conversationId: 'subagent-conv',
    lastUserInput: '[FLASH-WORKER] 请帮我实现认证模块',
    toolCall: {
      name: 'invoke_subagent',
      args: { TypeName: 'self', Model: 'flash', Prompt: '我还要派发一个' },
    },
  };
  const recRes = runHook('guard-subagent.mjs', subagentPayload);
  assert.equal(recRes.decision, 'deny', `Recursive invoke must be denied, got ${JSON.stringify(recRes)}`);
  assert(recRes.reason.includes('【递归守门】'), `Reason must include 【递归守门】, got: ${recRes.reason}`);
  console.log('  PASS 子代理嵌套递归派发被物理拦截！');

  const listPayload = {
    conversationId: 'main-conv',
    lastUserInput: '状态怎么样了',
    toolCall: {
      name: 'manage_subagents',
      args: { Action: 'list' },
    },
  };
  const listRes = runHook('guard-subagent.mjs', listPayload);
  assert.equal(listRes.decision, 'deny', `manage_subagents list must be denied, got ${JSON.stringify(listRes)}`);
  assert(listRes.reason.includes('【轮询守门】'), `Reason must include 【轮询守门】, got: ${listRes.reason}`);
  console.log('  PASS manage_subagents(Action="list") 轮询被物理拦截！');

  const killPayload = {
    conversationId: 'main-conv',
    lastUserInput: '终止子代理',
    toolCall: {
      name: 'manage_subagents',
      args: { Action: 'kill', ConversationIds: ['sub-1'] },
    },
  };
  const killRes = runHook('guard-subagent.mjs', killPayload);
  assert.equal(killRes.decision, 'allow', `manage_subagents kill should be allowed, got ${JSON.stringify(killRes)}`);
  console.log('  PASS manage_subagents(Action="kill") 正常放行！');

  const invokeSelfPayload = {
    conversationId: 'main-contract-test',
    lastUserInput: '开始多任务',
    toolCall: {
      name: 'invoke_subagent',
      args: { TypeName: 'self', Model: 'flash', Prompt: '实现模块 A' },
    },
  };
  const contractRes = runHook('guard-subagent.mjs', invokeSelfPayload);
  assert.equal(contractRes.decision, 'allow');
  const injectedPrompt = contractRes.overwrite?.Prompt || '';
  assert(injectedPrompt.includes('[PRO-CONTRACT]'), 'Prompt must contain [PRO-CONTRACT]');
  assert(injectedPrompt.includes('【多代理并发安全与边界红线】'), 'Prompt must contain 【多代理并发安全与边界红线】');
  assert(injectedPrompt.includes('文件互斥红线'), 'Prompt must contain 文件互斥红线');
  assert(injectedPrompt.includes('精准局部测试红线'), 'Prompt must contain 精准局部测试红线');
  console.log('  PASS 多 Agent 并发安全与互斥红线契约自动注入验证通过！');
}

process.on('exit', () => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
});

async function main() {
  console.log('====================================================');
  console.log('Pro-Flash Orchestrator — 并发协同与守门集成测试');
  console.log('====================================================');
  try {
    await test1_concurrentUpdateSession();
    await test2_spawnPoolClaims();
    await test3_quotaAndDynamicRead();
    await test4_recursionAndPollingGuards();
    console.log('\n====================================================');
    console.log('🎉 所有并发、配额与守门集成测试 100% 通过！');
    console.log('====================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {}
  }
}

main();
