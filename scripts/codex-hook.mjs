#!/usr/bin/env node
/** Native Codex entry point. Shared guards remain platform-neutral. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {codexHome,dataDir,readJson,writeJson as writeRuntimeJson,workerConfig,verificationStatus,sessionIdentity,agentOverride,redact} from './codex-runtime.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PRO_HARNESS='codex';
process.env.PRO_STATE_DIR=dataDir();
const lib=await import('./lib.mjs');
let raw={}; let mode='enforce';
const emit=(value)=>process.stdout.write(JSON.stringify(value));
const deny=(reason)=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});
const context=(event,text)=>({hookSpecificOutput:{hookEventName:event,additionalContext:text}});
function writeJson(file,value) {
  for(let attempt=0;;attempt++) {
    try { return writeRuntimeJson(file,value); }
    catch(error) {
      if(process.platform!=='win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=8)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    }
  }
}
function nativeToolName(value) {
  const name=String(value || '').split('.').pop();
  const collab=name.match(/^collaboration(?:__|_)?(spawn_agent|followup_task|send_message|wait_agent|interrupt_agent|list_agents)$/);
  if(collab)return collab[1];
  const functions=name.match(/^functions(?:__|_)?(apply_patch|exec_command|write_stdin|shell|read_file|write_file|edit_file)$/);
  return functions?functions[1]:name;
}
function safeError(value) {
  try {
    const seen=new WeakSet();
    const text=typeof value === 'string' ? value : JSON.stringify(value,(key,item)=>{
      if(/^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret)$/i.test(key))return '[REDACTED]';
      if(typeof item === 'string')return redact(item);
      if(item && typeof item === 'object'){if(seen.has(item))return '[Circular]';seen.add(item);}
      return item;
    });
    return redact(text || String(value)).slice(0,300);
  } catch { return redact(String(value)).slice(0,300); }
}
function runGuard(script,payload) {
  const result=spawnSync(process.execPath,[path.join(root,'scripts',script)],{
    input:JSON.stringify(payload),encoding:'utf8',timeout:9000,windowsHide:true,env:process.env});
  if(result.error || result.status !== 0) throw new Error('Guard execution failed: '+script);
  const out=JSON.parse(result.stdout || '{}');
  if(out.hookSpecificOutput?.permissionDecisionReason) {
    out.hookSpecificOutput.permissionDecisionReason=out.hookSpecificOutput.permissionDecisionReason
      .replace(/invoke_subagent\(TypeName="self", Model="flash"\)/g,'spawn_agent')
      .replace(/invoke_subagent\(TypeName="self"\|"research", Model="flash"\)/g,'spawn_agent')
      .replace(/静默等待系统异步唤醒与子代理消息通知/g,'使用 Codex 原生等待收集结果')
      .replace(/静默等待子代理消息/g,'使用 Codex 原生等待收集结果');
  }
  return out;
}
try {
  raw=JSON.parse(fs.readFileSync(0,'utf8'));
  if(!raw || typeof raw !== 'object' || !raw.hook_event_name) throw new Error('Invalid Codex hook payload');
  let cfg;
  const identity=sessionIdentity(raw);
  const nativeTool=nativeToolName(raw.tool_name);
  const payload=lib.normalizeIncomingPayload({...raw,...(!identity.sub && raw.agent_id ? {agent_id:undefined} : {}),...(nativeTool?{tool_name:nativeTool}:{}),conversationId:identity.conversationId,
    ...(identity.sub ? {parentConversationId:identity.root} : {})},'codex');
  lib.setContext(payload);
  const control=path.join(codexHome(),'plugin-data','pro-flash-orchestrator');
  if(!process.env.PRO_MODE && !fs.existsSync(path.join(process.env.PRO_STATE_DIR,'mode.json'))) {
    const configuredMode=readJson(path.join(control,'mode.json'))?.mode;
    if(['off','shadow','enforce'].includes(configuredMode))process.env.PRO_MODE=configuredMode;
  }
  mode=lib.currentMode();
  const event=raw.hook_event_name;
  if(mode === 'off') {emit({});process.exit(0);}
  const roleType = raw.agent_type || lib.readSession(identity.conversationId).workerType || '';
  const workerType = /explor|research|plan/i.test(String(roleType)) ? 'research' : 'self';
  cfg=workerConfig(undefined, identity.sub ? workerType : '');process.env.PRO_WORKER_MODEL=cfg.workerModel;
  lib.logDecision({hook:'codex-runtime',action:'event',mode,event,model:String(raw.model || ''),
    sub:identity.sub,agentId:identity.sub ? identity.id : undefined,turnId:raw.turn_id || ''});
  writeJson(path.join(control,'last-hook.json'),{event,observedAt:new Date().toISOString(),dataDir:process.env.PRO_STATE_DIR,pluginRoot:root,version:JSON.parse(fs.readFileSync(path.join(root,'plugin.json'),'utf8')).version});
  if(process.env.PFO_TEST_TRACE)fs.appendFileSync(process.env.PFO_TEST_TRACE,redact(JSON.stringify({event,tool_name:raw.tool_name,tool_input:raw.tool_input,model:raw.model,session_id:raw.session_id,agent_id:raw.agent_id,transcript_path:raw.transcript_path}))+'\n');
  const rootState='codex-root:'+identity.root;
  if(event === 'SubagentStart' || event === 'SubagentStop') {
    const state=lib.updateSession(rootState,s=>{
      s.agents=s.agents || {}; const id=String(raw.agent_id || identity.id);
      s.agents[id]={...(s.agents[id] || {}),agentType:raw.agent_type || '',model:raw.model || '',
        status:event === 'SubagentStart' ? 'active' : 'complete',updatedAt:Date.now()};
    });
    if(!state) throw new Error('Cannot update agent lifecycle state');
    if(event === 'SubagentStart') {
      if (!lib.updateSession(identity.conversationId, s => { s.workerType = workerType; })) throw new Error('Cannot update worker type');
      emit(context(event,'[FLASH-WORKER] Work only within your assigned files. Do not spawn nested agents. Return a compact result with file:line evidence and focused test results.'));
    } else {
      const parent = lib.readSession(identity.root);
      emit(runGuard('pre-invocation.mjs', { hook_event_name: event, session_id: identity.root,
        conversationId: identity.root, cwd: raw.cwd, lastUserInput: parent.lastUserInput || '',
        turn_id: parent.lastUserTurnId || '' }));
    }
  } else if(event === 'PostModelRequest') {
    const usage={};
    for(const [key,value] of Object.entries(raw.token_usage || {})) {
      if(/tokens?$/i.test(key) && typeof value === 'number' && Number.isFinite(value)) usage[key]=value;
    }
    const status=String(raw.status || 'unknown').toLowerCase();
    const failure=Boolean(raw.error) || ['error','errored','failed','failure'].includes(status);
    if(failure && String(raw.model || '') === cfg.workerModel) {
      const check=verificationStatus(cfg,raw.cwd);
      writeJson(path.join(process.env.PRO_STATE_DIR,'worker-verification.json'),{...(check.proof || {}),status:'invalidated',
        workerModel:cfg.workerModel,workerReasoningEffort:cfg.workerReasoningEffort,providerFingerprint:check.fingerprint,
        invalidatedAt:new Date().toISOString(),invalidationReason:'post-model-failure'});
    }
    lib.logDecision({hook:'codex-model',action:status,mode,model:raw.model || '',sub:identity.sub,
      agentId:raw.agent_id || '',usage,...(raw.error ? {error:safeError(raw.error)} : {})});
    emit({});
  } else if(event === 'SessionStart') {
    const check=verificationStatus(cfg,raw.cwd);
    const text='[Pro-Flash Orchestrator Active] Codex v'+JSON.parse(fs.readFileSync(path.join(root,'plugin.json'),'utf8')).version+
      '. Mode='+mode+'. Worker='+cfg.workerModel+' ('+cfg.workerReasoningEffort+'), verified='+check.verified+'. '+
      (lib.isNativeOrchestrator(payload)
        ? 'Native Orchestrator Lite Guard Mode: file-count limits are exempt; recursion, polling, command and contract guards remain active. '
        : 'For engineering work, follow the bundled flash-dev skill: keep decisions and up to two benchmark edits in the main agent; delegate independent exploration and peripheral edits. ')+
      'Use native spawn and wait tools, return compact evidence and focused tests. Only the user may enable [FORCE-PRO]. '+
      (!check.verified ? 'Worker dispatch is blocked until a real model verification succeeds; other guards remain active.' : '');
    emit(mode === 'shadow' || identity.sub ? {} : context(event,text));
  } else if(event === 'UserPromptSubmit') {
    const updated=lib.updateSession(identity.root,s=>{
      s.lastUserInput=String(raw.prompt || '');s.lastUserTurnId=String(raw.turn_id || '');
      s.userTurnSequence=Number(s.userTurnSequence || 0)+1;s.currentBatchSpawns=0;
      s.spawnTurnKey='';s.lastSpawnUserInput='';
      s.readsSinceDispatch=[];s.writesSinceDispatch=[];s.maxReadsAllowed=3;
      s.phase='explore';s.auditSliceQuota=0;
    });
    if(!updated) throw new Error('Cannot update turn state');
    emit({});
  } else if(event === 'PreToolUse') {
    const tool=nativeTool;
    const input=raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    const userInput=String(lib.readSession(identity.root).lastUserInput || '');
    const forced=/\[FORCE-PRO\]/i.test(userInput);
    const guardUserInput=userInput.replace(/\[(?:FORCE-ARGON|ALLOW-PRO)\]/gi,'[IGNORED-LEGACY-EXEMPTION]');
    const guardPayload={...payload,lastUserInput:guardUserInput};
    if(identity.sub && raw.model && raw.model !== cfg.workerModel && !forced && mode === 'enforce') {
      emit(deny('Worker model differs from configured model. Fix the agent profile or worker configuration; no main-model fallback.'));process.exit(0);
    }
    if(['spawn_agent','Agent','Task','invoke_subagent'].includes(tool)) {
      if(identity.sub && mode === 'enforce') {
        lib.logDecision({hook:'codex-worker',action:'deny-recursion',mode,model:raw.model || '',agentId:identity.id});
        emit(deny('Subagents cannot spawn nested subagents.'));process.exit(0);
      }
      cfg=workerConfig(undefined,lib.getArgs(payload).TypeName);
      process.env.PRO_WORKER_MODEL=cfg.workerModel;
      const check=verificationStatus(cfg,raw.cwd);
      if(!forced && !check.verified && mode === 'enforce') {
        lib.logDecision({hook:'codex-worker',action:'deny-unverified',mode,model:cfg.workerModel});
        emit(deny('Worker model '+cfg.workerModel+' is not verified for this provider. Run doctor --platform codex --verify-worker; no main-model fallback.'));process.exit(0);
      }
      const profile=agentOverride(input.agent_type || input.subagent_type,raw.cwd);
      if(!forced && profile && ((!profile.model || profile.model !== cfg.workerModel) ||
          (profile.effort && profile.effort !== cfg.workerReasoningEffort)) && mode === 'enforce') {
        emit(deny('Selected agent profile inherits or overrides the configured worker model or reasoning effort. Pin a compatible worker profile.'));process.exit(0);
      }
      const out=runGuard('guard-subagent.mjs',{...guardPayload,tool_name:tool});
      if(mode === 'enforce' && out.hookSpecificOutput?.permissionDecision !== 'deny') {
        const next=out.hookSpecificOutput?.updatedInput || {...input};
        if(!forced) {
          next.model=cfg.workerModel;next.reasoning_effort=cfg.workerReasoningEffort;
          if('fork_turns' in next || 'task_name' in next) next.fork_turns='none';
          if('fork_context' in next || 'agent_type' in next) next.fork_context=false;
        }
        emit({hookSpecificOutput:{hookEventName:event,permissionDecision:'allow',updatedInput:next}});
      } else emit(out);
    } else if (['list_agents','manage_subagents'].includes(tool)) {
      emit(runGuard('guard-subagent.mjs', { ...guardPayload, tool_name: 'manage_subagents',
        toolCall: { name: 'manage_subagents', args: tool === 'list_agents' ? { ...input, Action: 'list' } : input } }));
    } else if(['send_message','followup_task'].includes(tool)) {
      emit(runGuard('guard-subagent.mjs',{...guardPayload,tool_name:'send_message',_rawToolName:'send_message',
        toolCall:{name:'send_message',args:{...input}}}));
    } else if(['apply_patch','Write','Edit','MultiEdit','write_file','edit_file'].includes(tool)) {
      if(tool === 'apply_patch' && typeof (input.command || input.input || input.patch || raw.tool_input) !== 'string') {
        emit(mode === 'enforce' ? deny('Cannot safely parse apply_patch input.') : {});process.exit(0);
      }
      const paths=payload._patchPaths || [lib.pickPath(lib.getArgs(payload))];
      if(tool === 'apply_patch' && paths.length === 0) {
        emit(mode === 'enforce' ? deny('Cannot safely extract apply_patch target paths.') : {});process.exit(0);
      }
      const protectedFiles=[path.join(codexHome(),'hooks.json'),
        ...['mode.json','config.json','worker-verification.json'].flatMap(name=>[path.join(control,name),path.join(process.env.PRO_STATE_DIR,name)])]
        .map(p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p));
      if(paths.some(p=>{const resolved=lib.resolvePath(p,payload);return protectedFiles.includes(process.platform==='win32'?resolved.toLowerCase():resolved);}) && mode === 'enforce') {
        emit(deny('Plugin control and verification files are user-managed and cannot be edited by agents.'));process.exit(0);
      }
      emit(runGuard('guard-write-file.mjs',{...guardPayload,tool_name:tool}));
    } else if(['Bash','shell','exec_command','run_command'].includes(tool)) {
      emit(runGuard('guard-command.mjs',{...guardPayload,tool_name:tool}));
    } else if(['Read','read_file','view_file'].includes(tool)) {
      emit(runGuard('guard-read-file.mjs',{...guardPayload,tool_name:tool}));
    } else emit({});
  } else emit({});
} catch(error) {
  const reason=redact(error.message || error).slice(0,250);
  if(raw.hook_event_name === 'PreToolUse' && mode === 'enforce') emit(deny('PFO guard failed safely: '+reason));
  else emit({systemMessage:'PFO hook failed: '+reason});
}
