#!/usr/bin/env node
/**
 * Opt-in live acceptance tests for the native Codex integration.
 *
 * Preflight is read-only with respect to CODEX_HOME. Network/model scenarios and
 * the JSON report are only created when the caller explicitly supplies --run.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  codexHome,
  readJson,
  redact,
  sessionIdentity,
  verificationStatus,
  workerConfig,
} from './codex-runtime.mjs';
import {inspectNative} from './codex-app-server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let reportFile = path.join(root, '.maintenance', 'codex-0.6.1', 'codex-live-report.json');
const scenarioNames=['ordinary-edit','batch-write-denied','large-output-denied','native-collaboration','unavailable-model'];
const controlDir = path.join(codexHome(), 'plugin-data', 'pro-flash-orchestrator');
const codexBin = process.env.PFO_CODEX_BIN || 'codex';
const expectedEvents = [
  'postModelRequest',
  'preToolUse',
  'sessionStart',
  'subagentStart',
  'subagentStop',
  'userPromptSubmit',
];
const maxOutputBytes = 6 * 1024 * 1024;
const scenarioTimeoutMs = boundedNumber(process.env.PFO_LIVE_SCENARIO_MS, 120000, 30000, 240000);
const totalTimeoutMs = boundedNumber(process.env.PFO_LIVE_TOTAL_MS, 600000, 120000, 1200000);
let liveDeadline = Number.POSITIVE_INFINITY;

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function shortError(error) {
  return redact(error?.message || error || 'unknown error')
    .replaceAll(codexHome(), '<CODEX_HOME>')
    .replaceAll(root, '<REPO>')
    .replaceAll(os.tmpdir(), '<TEMP>')
    .slice(0, 500);
}

function parseJsonLines(text) {
  const values = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch { /* CLI diagnostics can be non-JSON. */ }
  }
  return values;
}

function readJsonLines(file) {
  try { return parseJsonLines(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function normalizeName(value) {
  const name=String(value || '').split('.').pop();
  const local=name.replace(/^(?:collaboration|functions)(?:__|_)?(?=(?:spawn_agent|wait_agent|interrupt_agent|list_agents|followup_task|send_message|exec_command|apply_patch|shell)$)/,'');
  return local.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function toolCalls(trace, name) {
  const canonical=value=>({bash:'execcommand',shell:'execcommand',runcommand:'execcommand',waitagent:'wait'}[normalizeName(value)] || normalizeName(value));
  const wanted = canonical(name);
  return trace.filter((event) =>
    event.event === 'PreToolUse' && canonical(event.tool_name) === wanted);
}

function isSubTrace(event) {
  try { return sessionIdentity(event).sub; } catch { /* fall through */ }
  return Boolean(event.agent_id && event.agent_id !== event.session_id);
}

function inputText(event) {
  try { return JSON.stringify(event.tool_input || ''); } catch { return ''; }
}

function collabItems(events) {
  const found = [];
  for (const event of events) {
    walk(event, (value) => {
      if (['collabagenttoolcall','collabtoolcall'].includes(normalizeName(value.type))) found.push(value);
    });
  }
  return found;
}

function itemTool(item) {
  const name=normalizeName(item.tool || item.name);
  return name==='waitagent'?'wait':name;
}

function itemStatus(item) {
  return normalizeName(item.status);
}

function eventText(events) {
  let text = '';
  for (const event of events) {
    if (text.length >= maxOutputBytes) break;
    try { text += JSON.stringify(event) + '\n'; } catch { /* ignore */ }
  }
  return text.slice(0, maxOutputBytes);
}

function initGit(project) {
  const result = spawnSync('git', ['init', '--quiet'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Cannot initialize temporary Git project: ' + (result.error?.message || result.stderr));
  }
}

function makeProject(tempRoot, name) {
  const project = path.join(tempRoot, name);
  fs.mkdirSync(project, {recursive: true});
  initGit(project);
  return project;
}

function scenarioState(tempRoot, name) {
  const stateDir = path.join(tempRoot, 'state', name);
  fs.mkdirSync(stateDir, {recursive: true});
  return {stateDir, traceFile: path.join(stateDir, 'hook-trace.jsonl')};
}

function childEnv(state) {
  const env = {...process.env};
  delete env.PRO_MODE;
  delete env.PRO_HARNESS;
  delete env.PLUGIN_ROOT;
  env.PRO_STATE_DIR = state.stateDir;
  env.PFO_TEST_TRACE = state.traceFile;
  env.NO_COLOR = '1';
  return env;
}

function assertSafeArgs(args) {
  const joined = args.join(' ');
  if (/dangerously|bypass-hook|bypass.*sandbox|danger-full-access/i.test(joined)) {
    throw new Error('Unsafe Codex flag rejected by the live acceptance runner');
  }
}

function runProcess(command, args, {cwd, env, timeoutMs = scenarioTimeoutMs, input = ''} = {}) {
  assertSafeArgs(args);
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let timer;
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.kill();
      child.unref();
      resolve({
        code: extra.code ?? null,
        signal: extra.signal ?? null,
        spawnError: extra.spawnError || '',
        stdout,
        stderr,
        overflow,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    const add = (kind, chunk) => {
      const current = kind === 'stdout' ? stdout : stderr;
      if (Buffer.byteLength(current) >= maxOutputBytes) return;
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > maxOutputBytes) {
        overflow = true;
        if (kind === 'stdout') stdout = next.slice(0, maxOutputBytes);
        else stderr = next.slice(0, maxOutputBytes);
        child.kill();
      } else if (kind === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout.on('data', (chunk) => add('stdout', chunk));
    child.stderr.on('data', (chunk) => add('stderr', chunk));
    child.on('error', (error) => finish({spawnError: shortError(error)}));
    child.on('close', (code, signal) => finish({code, signal}));
    const effectiveTimeout = Math.max(1, Math.min(timeoutMs, liveDeadline - Date.now()));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => finish({signal: 'timeout'}), 2500).unref();
    }, effectiveTimeout);
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function runCodex(project, state, prompt, cfg, timeoutMs = scenarioTimeoutMs) {
  const args = [
    'exec',
    '--json',
    '--color', 'never',
    '--ephemeral',
    '--sandbox', 'workspace-write',
    '--cd', project,
    '--model', cfg.workerModel,
    '-c', 'model_reasoning_effort=' + JSON.stringify(cfg.workerReasoningEffort),
    prompt,
  ];
  const result = await runProcess(codexBin, args, {
    cwd: project,
    env: childEnv(state),
    timeoutMs,
  });
  return {
    ...result,
    parentModel: cfg.workerModel,
    events: parseJsonLines(result.stdout),
    trace: readJsonLines(state.traceFile),
    decisions: readJsonLines(path.join(state.stateDir, 'decisions.jsonl')),
  };
}

function baseScenario(name, run) {
  return {
    name,
    status: 'fail',
    classification: 'not_evaluated',
    durationMs: run.durationMs,
    execution: {
      exitCode: run.code,
      timedOut: run.timedOut,
      outputOverflow: run.overflow,
      eventCount: run.events?.length || 0,
      traceCount: run.trace?.length || 0,
      parentModel: run.parentModel || null,
      observedTools: [...new Set((run.trace || []).filter(event=>event.event==='PreToolUse').map(event=>event.tool_name))],
      cliItemTypes: [...new Set((run.events || []).filter(event=>event.item).map(event=>event.item.type))],
    },
    evidence: {},
  };
}

function executionFailure(result, run) {
  if (run.timedOut) {
    result.classification = 'timeout';
    return true;
  }
  if (run.overflow) {
    result.classification = 'unexpected_output_volume';
    return true;
  }
  if (run.spawnError) {
    result.classification = 'cli_start_failed';
    result.evidence.error = run.spawnError;
    return true;
  }
  return false;
}

async function ordinaryEdit(tempRoot, cfg) {
  const name = 'ordinary-edit';
  const project = makeProject(tempRoot, name);
  const state = scenarioState(tempRoot, name);
  const prompt = [
    'Live acceptance test. Use the native apply_patch tool exactly once.',
    'Add ordinary.txt with exact content: ordinary edit ok followed by one newline.',
    'Do not use a shell or another write tool and do not modify any other file.',
    'After the tool completes, reply exactly DONE.',
  ].join(' ');
  const run = await runCodex(project, state, prompt, cfg);
  const result = baseScenario(name, run);
  if (executionFailure(result, run)) return result;
  const calls = toolCalls(run.trace, 'apply_patch');
  const content = fs.existsSync(path.join(project, 'ordinary.txt'))
    ? fs.readFileSync(path.join(project, 'ordinary.txt'), 'utf8') : '';
  result.evidence = {
    applyPatchObserved: calls.length > 0,
    exactContent: content === 'ordinary edit ok\n',
  };
  if (!calls.length) result.classification = 'model_compliance_absent';
  else if (content !== 'ordinary edit ok\n') result.classification = 'allowed_edit_did_not_land';
  else {
    result.status = 'pass';
    result.classification = 'guard_allowed_expected_edit';
  }
  return result;
}

async function batchWriteDenied(tempRoot, cfg) {
  const name = 'batch-write-denied';
  const project = makeProject(tempRoot, name);
  const state = scenarioState(tempRoot, name);
  fs.writeFileSync(path.join(project, 'update.txt'), 'before update\n');
  fs.writeFileSync(path.join(project, 'delete.txt'), 'delete me\n');
  fs.writeFileSync(path.join(project, 'move-source.txt'), 'move me\n');
  const before = {
    update: fs.readFileSync(path.join(project, 'update.txt'), 'utf8'),
    delete: fs.readFileSync(path.join(project, 'delete.txt'), 'utf8'),
    move: fs.readFileSync(path.join(project, 'move-source.txt'), 'utf8'),
  };
  const patch = [
    '*** Begin Patch',
    '*** Add File: add.txt',
    '+added',
    '*** Update File: update.txt',
    '@@',
    '-before update',
    '+after update',
    '*** Delete File: delete.txt',
    '*** Update File: move-source.txt',
    '*** Move to: moved.txt',
    '@@',
    '-move me',
    '+move me',
    '*** End Patch',
  ].join('\n');
  const prompt = [
    'Live acceptance test. Call the native apply_patch tool exactly once with this exact patch.',
    'The call is expected to be denied; do not retry and do not use another tool.',
    patch,
  ].join('\n\n');
  const run = await runCodex(project, state, prompt, cfg);
  const result = baseScenario(name, run);
  if (executionFailure(result, run)) return result;
  const calls = toolCalls(run.trace, 'apply_patch');
  const callText = calls.map(inputText).join('\n');
  const exactShape = ['add.txt', 'update.txt', 'delete.txt', 'move-source.txt', 'moved.txt']
    .every((file) => callText.includes(file));
  const denied = run.decisions.some((entry) =>
    entry.hook === 'guard-write-file' && entry.action === 'deny');
  const unchanged =
    !fs.existsSync(path.join(project, 'add.txt')) &&
    fs.readFileSync(path.join(project, 'update.txt'), 'utf8') === before.update &&
    fs.readFileSync(path.join(project, 'delete.txt'), 'utf8') === before.delete &&
    fs.readFileSync(path.join(project, 'move-source.txt'), 'utf8') === before.move &&
    !fs.existsSync(path.join(project, 'moved.txt'));
  result.evidence = {
    applyPatchObserved: calls.length > 0,
    requestedAddUpdateDeleteMove: exactShape,
    guardDenyLogged: denied,
    fixturesUnchanged: unchanged,
  };
  if (!calls.length || !exactShape) result.classification = 'model_compliance_absent';
  else if (!denied) result.classification = 'guard_denial_absent';
  else if (!unchanged) result.classification = 'denied_batch_changed_files';
  else {
    result.status = 'pass';
    result.classification = 'guard_denied_atomic_batch';
  }
  return result;
}

async function largeOutputDenied(tempRoot, cfg) {
  const name = 'large-output-denied';
  const project = makeProject(tempRoot, name);
  const state = scenarioState(tempRoot, name);
  const chunk = 'large-output-line\n';
  fs.writeFileSync(path.join(project, 'large.txt'), chunk.repeat(Math.ceil((520 * 1024) / chunk.length)));
  const prompt = [
    'Live acceptance test. Use the native shell tool (exec_command or Bash) exactly once with this exact PowerShell command:',
    'Get-Content -Raw -LiteralPath .\\large.txt',
    'The command is expected to be denied. Do not add bounded flags, redirect output, retry, or use another tool.',
  ].join('\n');
  const run = await runCodex(project, state, prompt, cfg);
  const result = baseScenario(name, run);
  if (executionFailure(result, run)) return result;
  const calls = toolCalls(run.trace, 'exec_command');
  const exactCommand = calls.some((entry) => {
    const text = inputText(entry);
    return /Get-Content/i.test(text) && /large\.txt/i.test(text) &&
      !/-TotalCount|-Head|-Tail|-First|-Last/i.test(text);
  });
  const denied = run.decisions.some((entry) =>
    entry.hook === 'guard-command' && entry.action === 'deny' && entry.rule === 'dump');
  result.evidence = {
    execCommandObserved: calls.length > 0,
    unboundedReadObserved: exactCommand,
    dumpGuardDenyLogged: denied,
    cliOutputStayedBounded: Buffer.byteLength(run.stdout) < 400 * 1024,
  };
  if (!calls.length || !exactCommand) result.classification = 'model_compliance_absent';
  else if (!denied) result.classification = 'guard_denial_absent';
  else if (Buffer.byteLength(run.stdout) >= 400 * 1024) result.classification = 'denied_output_leaked';
  else {
    result.status = 'pass';
    result.classification = 'guard_denied_large_dump';
  }
  return result;
}

async function collaborationLifecycle(tempRoot, cfg) {
  const name = 'native-collaboration';
  const project = makeProject(tempRoot, name);
  const state = scenarioState(tempRoot, name);
  const nonce = 'PFO_ROOT_NONCE_' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const workerMessage = [
    'Acceptance worker. Do the following exactly.',
    '1. If context supplied outside this task contains an exact token matching PFO_ROOT_NONCE_[A-F0-9]{12}, write context.txt containing that token; otherwise write context.txt containing NONE.',
    '2. If your supplied task contains the bracketed plugin contract marker whose words are PRO and CONTRACT, write contract.txt containing PRESENT; otherwise write ABSENT.',
    '3. Call native spawn_agent once for a nested child. It should be denied. After the call result, write nested.txt containing DENIED only if it was denied, otherwise NOT_DENIED.',
    'Use apply_patch for the three files, then return a compact result.',
  ].join(' ');
  const prompt = [
    'Live native collaboration acceptance test. This parent-only nonce is ' + nonce + '.',
    'Use native spawn_agent exactly once with task_name live_worker, model gpt-6-astra, reasoning_effort high, and fork_turns all.',
    'The spawn message must be exactly the quoted message below and must not include the nonce.',
    JSON.stringify(workerMessage),
    'Then use native wait or wait_agent to collect the worker result and native close_agent to close it. If close_agent is unavailable, use native interrupt_agent and explicitly report CLOSE_UNSUPPORTED; interruption must not be described as closure.',
    'Do not modify files in the parent and do not answer before wait and close finish.',
  ].join('\n');
  const run = await runCodex(project, state, prompt, cfg);
  const result = baseScenario(name, run);
  if (executionFailure(result, run)) return result;
  const spawns = toolCalls(run.trace, 'spawn_agent');
  const rootSpawn = spawns.find((entry) => !isSubTrace(entry)) || spawns[0];
  const nestedSpawn = spawns.find((entry) => entry !== rootSpawn && isSubTrace(entry)) ||
    spawns.find((entry) => entry !== rootSpawn);
  const waits = toolCalls(run.trace, 'wait');
  const closes = toolCalls(run.trace, 'close_agent');
  const interrupts = toolCalls(run.trace, 'interrupt_agent');
  const rootInput = rootSpawn ? inputText(rootSpawn) : '';
  const rawRequestedRewrite =
    /gpt-6-astra/i.test(rootInput) &&
    /high/i.test(rootInput) &&
    /fork_turns/i.test(rootInput) &&
    /all/i.test(rootInput);
  const rawTaskHadNoContract = rootSpawn ? !rootInput.includes('[PRO-CONTRACT]') : false;
  const rawTaskHadNoNonce = rootSpawn ? !rootInput.includes(nonce) : false;
  const collab = collabItems(run.events);
  const spawnItems = collab.filter((item) => itemTool(item) === 'spawnagent');
  const waitItems = collab.filter((item) => itemTool(item) === 'wait');
  const closeItems = collab.filter((item) => itemTool(item) === 'closeagent');
  const interruptItems = collab.filter((item) => itemTool(item) === 'interruptagent');
  const resolvedSpawn = spawnItems.find((item) =>
    String(item.model || '') === cfg.workerModel) || spawnItems[0];
  const resolvedModel = String(resolvedSpawn?.model || '');
  const resolvedEffort = String(resolvedSpawn?.reasoningEffort || resolvedSpawn?.reasoning_effort || '');
  const resolvedPrompt = String(resolvedSpawn?.prompt || '');
  const rewriteDecision = run.decisions.some((entry) =>
    entry.hook === 'guard-subagent' &&
    entry.action === 'rewrite' &&
    entry.to === cfg.workerModel &&
    entry.contract === true);
  const readMarker = (file) => {
    try { return fs.readFileSync(path.join(project, file), 'utf8').trim(); } catch { return ''; }
  };
  const contextMarker = readMarker('context.txt');
  const contractMarker = readMarker('contract.txt');
  const nestedMarker = readMarker('nested.txt');
  const recursionDenyLogged = run.decisions.some((entry) =>
    entry.hook === 'codex-worker' && entry.action === 'deny-recursion');
  const workerEvidenceComplete =
    contextMarker === 'NONE' &&
    contractMarker === 'PRESENT' &&
    nestedMarker === 'DENIED';
  const nestedDenied = Boolean(nestedSpawn && recursionDenyLogged && nestedMarker === 'DENIED');
  const waitSucceeded = waits.length > 0 &&
    waitItems.some((item) => itemStatus(item) === 'completed') &&
    workerEvidenceComplete;
  const closeSucceeded = closes.length > 0 &&
    closeItems.some((item) => itemStatus(item) === 'completed') &&
    workerEvidenceComplete;
  result.evidence = {
    rootSpawnObserved: Boolean(rootSpawn),
    requestedRewriteInputs: rawRequestedRewrite,
    guardRewriteLogged: rewriteDecision,
    resolvedWorkerModel: resolvedModel || null,
    resolvedReasoningEffort: resolvedEffort || null,
    resolvedIndependentContext: rawTaskHadNoNonce && contextMarker === 'NONE',
    contractAddedAfterRawCall: rawTaskHadNoContract && resolvedPrompt.includes('[PRO-CONTRACT]'),
    workerConfirmedContract: contractMarker === 'PRESENT',
    nestedSpawnObserved: Boolean(nestedSpawn),
    recursionDenyLogged,
    nestedSpawnDenied: nestedDenied,
    waitObserved: waits.length > 0,
    waitSucceeded,
    closeObserved: closes.length > 0,
    closeSucceeded,
    interruptObserved: interrupts.length > 0,
    interruptSucceeded: interruptItems.some(item=>['completed','interrupted'].includes(itemStatus(item))),
    workerModelRequests: [...new Set(run.decisions.filter(entry=>entry.hook==='codex-model'&&entry.sub).map(entry=>entry.model))],
    workerFailures: run.decisions.filter(entry=>entry.hook==='codex-model'&&entry.sub&&entry.error).map(entry=>({model:entry.model,error:shortError(entry.error)})),
    resolvedCollabItems: collab.map(item=>({tool:item.tool,status:item.status,model:item.model,reasoningEffort:item.reasoningEffort || item.reasoning_effort,
      fields:Object.keys(item),
      agents:Object.entries(item.agentsStates || item.agents_states || item.agents_statuses || {}).map(([id,state])=>({id,status:state.status,message:state.message?shortError(state.message):undefined}))})),
  };
  const requiredCalls = rootSpawn && nestedSpawn && waits.length;
  const workerFailed=result.evidence.workerFailures.length>0 || collab.some(item=>Object.values(item.agentsStates || {}).some(state=>normalizeName(state.status)==='errored'));
  if (workerFailed) result.classification = 'worker_runtime_failed';
  else if (!requiredCalls) result.classification = 'model_compliance_absent';
  else if (!rawRequestedRewrite || !rawTaskHadNoContract || !rawTaskHadNoNonce) {
    result.classification = 'model_call_shape_noncompliant';
  } else if (!rewriteDecision || resolvedModel !== cfg.workerModel || resolvedEffort !== cfg.workerReasoningEffort) {
    result.classification = 'spawn_rewrite_not_observed';
  } else if (contextMarker !== 'NONE') result.classification = 'worker_context_not_independent';
  else if (!resolvedPrompt.includes('[PRO-CONTRACT]') || contractMarker !== 'PRESENT') {
    result.classification = 'worker_contract_not_received';
  } else if (!nestedDenied || nestedMarker !== 'DENIED') result.classification = 'nested_spawn_not_denied';
  else if (!waitSucceeded) result.classification = 'wait_failed';
  else if (!closes.length && interrupts.length) result.classification = 'native_close_unsupported';
  else if (!closeSucceeded) result.classification = 'close_failed';
  else {
    result.status = 'pass';
    result.classification = 'native_lifecycle_guarded';
  }
  return result;
}

function rpcErrorText(messages) {
  let text = '';
  for (const message of messages) {
    try { text += JSON.stringify(message) + '\n'; } catch { /* ignore */ }
  }
  return text.slice(0, maxOutputBytes);
}

async function unavailableModel(tempRoot) {
  const name = 'unavailable-model';
  const project = makeProject(tempRoot, name);
  const state = scenarioState(tempRoot, name);
  const requestedModel = 'pfo-unavailable-model-' + crypto.randomBytes(6).toString('hex');
  const env = childEnv(state);
  const started = Date.now();
  const run = await new Promise((resolve) => {
    const args = ['app-server', '--stdio'];
    assertSafeArgs(args);
    const child = spawn(codexBin, args, {
      cwd: project,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let timer;
    const messages = [];
    let threadId = '';
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.kill();
      child.unref();
      resolve({
        code: extra.code ?? null,
        signal: extra.signal ?? null,
        spawnError: extra.spawnError || '',
        timedOut,
        overflow: bytes > maxOutputBytes,
        stdout: '',
        stderr,
        durationMs: Date.now() - started,
        events: messages,
        trace: readJsonLines(state.traceFile),
        decisions: readJsonLines(path.join(state.stateDir, 'decisions.jsonl')),
      });
    };
    child.on('error', (error) => finish({spawnError: shortError(error)}));
    child.on('close', (code, signal) => {
      if (!settled) finish({code, signal});
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 100000) stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        finish({signal: 'output-overflow'});
        return;
      }
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        messages.push(message);
        if (message.id === 1 && message.result) {
          send({method: 'initialized'});
          send({
            id: 2,
            method: 'thread/start',
            params: {
              allowProviderModelFallback: false,
              approvalPolicy: 'never',
              cwd: project,
              ephemeral: true,
              experimentalRawEvents: false,
              model: requestedModel,
              sandbox: 'workspace-write',
            },
          });
        } else if (message.id === 2 && message.error) {
          finish();
        } else if (message.id === 2 && message.result) {
          threadId = String(message.result.thread?.id || message.result.id || '');
          if (!threadId) {
            finish();
          } else {
            send({
              id: 3,
              method: 'turn/start',
              params: {
                threadId,
                input: [{
                  type: 'text',
                  text: 'Reply exactly UNAVAILABLE_MODEL_SHOULD_NOT_RUN. Do not use tools.',
                }],
              },
            });
          }
        } else if (message.id === 3 && message.error) {
          finish();
        } else if (message.method === 'turn/completed' &&
          (!threadId || message.params?.threadId === threadId)) {
          finish();
        }
      }
    });
    const effectiveTimeout = Math.max(1, Math.min(scenarioTimeoutMs, liveDeadline - Date.now()));
    timer = setTimeout(() => {
      timedOut = true;
      finish({signal: 'timeout'});
    }, effectiveTimeout);
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'pfo_live_acceptance',
          title: 'PFO live acceptance',
          version: '0.6.1',
        },
        capabilities: {experimentalApi: true},
      },
    });
  });
  const result = baseScenario(name, run);
  if (executionFailure(result, run)) return result;
  const text = rpcErrorText(run.events);
  const explicitFailure = /modelNotFound|model.?not.?found|unknown model|unsupported model|model.{0,50}(unavailable|does not exist|not available)/i.test(text);
  const modelEvents = run.trace
    .filter((entry) => entry.event === 'PostModelRequest')
    .map((entry) => String(entry.model || ''))
    .filter(Boolean);
  let returnedThreadModel = '';
  let assistantOutput = false;
  for (const message of run.events) {
    walk(message, (value) => {
      if (!returnedThreadModel && value.id && value.model && value.turns) {
        returnedThreadModel = String(value.model);
      }
      const type = normalizeName(value.type);
      if (type === 'agentmessage' || type === 'assistantmessage') assistantOutput = true;
    });
  }
  const fallbackModels = [...new Set([
    returnedThreadModel,
    ...modelEvents,
  ].filter((model) => model && model !== requestedModel))];
  result.evidence = {
    noFallbackRequestedByProtocol: true,
    explicitUnavailableFailure: explicitFailure,
    fallbackModelObserved: fallbackModels.length > 0,
    assistantOutputObserved: assistantOutput,
  };
  if (!explicitFailure) result.classification = 'explicit_model_failure_absent';
  else if (fallbackModels.length || assistantOutput) result.classification = 'unexpected_model_fallback';
  else {
    result.status = 'pass';
    result.classification = 'unavailable_model_failed_closed';
  }
  return result;
}

function schemaDir() {
  if (process.env.PFO_CODEX_SCHEMA_DIR) return path.resolve(process.env.PFO_CODEX_SCHEMA_DIR);
  return path.join(root, '.maintenance', 'codex-0.6.1', 'schema');
}

async function preflight() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({name, ok: Boolean(ok), detail});
  let temp = '';
  let cfg = null;
  let provider = '';
  try {
    const version = spawnSync(codexBin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    add('codex-cli', !version.error && version.status === 0,
      (!version.error && version.status === 0) ? redact(version.stdout.trim()).slice(0, 120) : 'unavailable');
    const help = spawnSync(codexBin, ['exec', '--help'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const helpText = help.stdout || '';
    add('exec-cli-shape', help.status === 0 &&
      helpText.includes('--json') &&
      helpText.includes('--sandbox') &&
      helpText.includes('--ephemeral') &&
      helpText.includes('--cd'), 'requires json, workspace sandbox, ephemeral, and cwd options');

    const turnSchema = readJson(path.join(schemaDir(), 'v2', 'TurnCompletedNotification.json'));
    const nativeTools = turnSchema?.definitions?.CollabAgentTool?.enum || [];
    add('pinned-collab-schema',
      ['spawnAgent', 'wait', 'closeAgent'].every((name) => nativeTools.includes(name)),
      'spawnAgent/wait/closeAgent');

    cfg = workerConfig(controlDir);
    add('worker-config',
      Boolean(cfg.workerModel && cfg.workerReasoningEffort),
      String(cfg.workerModel) + ' (' + String(cfg.workerReasoningEffort) + ')');
    const mode = readJson(path.join(controlDir, 'mode.json'))?.mode;
    add('enforce-mode', mode === 'enforce', String(mode || 'missing'));

    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-codex-live-preflight-'));
    initGit(temp);
    const verification = verificationStatus(cfg, temp, controlDir);
    provider = verification.provider;
    add('worker-verification', verification.verified,
      verification.verified ? 'verified proof matches configured provider' : 'proof missing or mismatched');

    const native = await inspectNative({cwd: temp, models: false, timeout: 20000});
    const hooks = native.hooks || [];
    const eventNames = hooks.map((hook) => hook.eventName).sort();
    const expected = [...expectedEvents].sort();
    const hookSetMatches = eventNames.length === expected.length &&
      eventNames.every((name, index) => name === expected[index]);
    const hookTrust = hooks.every((hook) =>
      ['user', 'plugin'].includes(hook.source) &&
      hook.enabled === true &&
      ['trusted', 'managed'].includes(hook.trustStatus));
    add('native-hook-set', hookSetMatches, String(hooks.length) + ' PFO hooks');
    add('native-hook-trust', hookTrust,
      hookTrust ? 'all native hooks enabled and trusted/managed' : 'untrusted, modified, or disabled hook present');
    add('native-hook-errors', (native.errors || []).length === 0,
      (native.errors || []).length ? String(native.errors.length) + ' native hook errors' : 'none');
  } catch (error) {
    add('preflight-exception', false, shortError(error));
  } finally {
    if (temp && path.dirname(temp) === path.resolve(os.tmpdir()) &&
      path.basename(temp).startsWith('pfo-codex-live-preflight-')) {
      fs.rmSync(temp, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
    }
  }
  return {
    status: checks.every((check) => check.ok) ? 'ready' : 'blocked',
    checkedAt: new Date().toISOString(),
    provider: provider || null,
    worker: cfg ? {
      workerModel: cfg.workerModel,
      workerReasoningEffort: cfg.workerReasoningEffort,
    } : null,
    checks,
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportFile), {recursive: true});
  const temp = reportFile + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.renameSync(temp, reportFile);
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/test-codex-live.mjs --preflight',
    '  node scripts/test-codex-live.mjs --run',
    '  node scripts/test-codex-live.mjs --run --scenario native-collaboration',
    '',
    '--preflight performs read-only native trust/proof/schema inspection.',
    '--run requires a ready preflight, executes real network/model/tool scenarios,',
    'and writes .maintenance/codex-0.6.1/codex-live-report.json.',
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  let selected='';
  const scenarioIndex=args.indexOf('--scenario');
  if(scenarioIndex>=0)selected=args[scenarioIndex+1] || '';
  const flags=args.filter((arg,index)=>index!==scenarioIndex && (scenarioIndex<0 || index!==scenarioIndex+1));
  const allowed = new Set(['--preflight', '--run']);
  const unknown = flags.filter((arg) => !allowed.has(arg));
  if (unknown.length || (args.includes('--preflight') && args.includes('--run')) ||
      (scenarioIndex>=0 && (!args.includes('--run') || !scenarioNames.includes(selected)))) {
    printUsage();
    process.exitCode = 64;
    return;
  }
  const runLive = args.includes('--run');
  if(selected)reportFile=path.join(root,'.maintenance','codex-0.6.1','codex-live-'+selected+'-report.json');
  const check = await preflight();
  if (!runLive) {
    console.log(JSON.stringify({
      mode: 'preflight',
      ...check,
      liveScenariosExecuted: false,
      next: check.status === 'ready'
        ? 'Run again with --run to execute live acceptance scenarios.'
        : 'Fix failed checks; the runner will not bypass hook trust or verification.',
    }, null, 2));
    if (check.status !== 'ready') process.exitCode = 2;
    return;
  }

  const report = {
    schemaVersion: 1,
    kind: 'pfo-codex-live-acceptance',
    selection: selected || 'all',
    startedAt: new Date().toISOString(),
    preflight: check,
    models: {
      parent: check.worker?.workerModel || null,
      worker: check.worker?.workerModel || null,
      workerReasoningEffort: check.worker?.workerReasoningEffort || null,
    },
    limits: {scenarioTimeoutMs, totalTimeoutMs, maxCapturedOutputBytes: maxOutputBytes},
    scenarios: [],
  };
  if (check.status !== 'ready') {
    report.status = 'blocked';
    report.completedAt = new Date().toISOString();
    writeReport(report);
    console.error('BLOCKED: native trust or worker verification preflight failed. No live scenario ran.');
    process.exitCode = 2;
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-codex-live-'));
  const deadline = Date.now() + totalTimeoutMs;
  liveDeadline = deadline;
  const allScenarioFns = [
    (dir) => ordinaryEdit(dir, check.worker),
    (dir) => batchWriteDenied(dir, check.worker),
    (dir) => largeOutputDenied(dir, check.worker),
    (dir) => collaborationLifecycle(dir, check.worker),
    unavailableModel,
  ];
  const scenarioFns=allScenarioFns.map((run,index)=>({name:scenarioNames[index],run})).filter(scenario=>!selected || scenario.name===selected);
  try {
    for (const scenario of scenarioFns) {
      if (Date.now() >= deadline) {
        report.scenarios.push({
          name: scenario.name || 'remaining-scenario',
          status: 'fail',
          classification: 'total_timeout_budget_exhausted',
          durationMs: 0,
          evidence: {},
        });
        break;
      }
      try {
        report.scenarios.push(await scenario.run(tempRoot));
      } catch (error) {
        report.scenarios.push({
          name: scenario.name || 'scenario',
          status: 'fail',
          classification: 'runner_exception',
          durationMs: 0,
          evidence: {error: shortError(error)},
        });
      }
    }
  } finally {
    if (path.dirname(tempRoot) !== path.resolve(os.tmpdir()) ||
      !path.basename(tempRoot).startsWith('pfo-codex-live-')) {
      throw new Error('Refusing to clean unexpected live acceptance path');
    }
    fs.rmSync(tempRoot, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
  const passed = report.scenarios.filter((scenario) => scenario.status === 'pass').length;
  report.summary = {passed, failed: report.scenarios.length - passed, total: report.scenarios.length};
  report.status = report.summary.failed === 0 && report.summary.total === scenarioFns.length ? 'pass' : 'fail';
  report.completedAt = new Date().toISOString();
  writeReport(report);
  console.log('Codex live acceptance: ' + passed + '/' + report.scenarios.length + ' passed');
  console.log('Report: ' + reportFile);
  if (report.status !== 'pass') process.exitCode = 1;
}

export {normalizeName,toolCalls,collabItems,itemTool};
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch((error) => {
  console.error('Codex live acceptance runner failed: ' + shortError(error));
  process.exitCode = 1;
});
