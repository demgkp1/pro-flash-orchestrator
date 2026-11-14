#!/usr/bin/env node
/** Offline Codex protocol/package tests. These are not a claim of live validation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pfo-codex-tests-'));
process.env.CODEX_HOME=path.join(temp,'home');
process.env.PRO_STATE_DIR=path.join(temp,'state');
const runtime=await import('./codex-runtime.mjs');
const maintenance=await import('./codex-maintenance.mjs');
const setup=await import('./codex-setup.mjs');
const pack=await import('./package.mjs');
const live=await import('./test-codex-live.mjs');
const control=path.join(process.env.CODEX_HOME,'plugin-data','pro-flash-orchestrator');
const verificationFile=path.join(process.env.PRO_STATE_DIR,'worker-verification.json');
fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
fs.mkdirSync(control,{recursive:true});
fs.writeFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
runtime.writeJson(path.join(control,'config.json'),{workerModel:'gpt-6-luna',workerReasoningEffort:'low'});
const cfg=runtime.workerConfig();
function proof(cwd=temp){const value={status:'verified',workerModel:cfg.workerModel,workerReasoningEffort:cfg.workerReasoningEffort,providerFingerprint:runtime.providerIdentity(cwd).fingerprint};runtime.writeJson(verificationFile,value);runtime.writeJson(path.join(control,'worker-verification.json'),value);}
function clearProof(){for(const file of [verificationFile,path.join(control,'worker-verification.json')])if(fs.existsSync(file))fs.unlinkSync(file);}
function call(event,extra={},mode='enforce') {
  const p={hook_event_name:event,session_id:'root',turn_id:'turn-1',model:'gpt-6.1-sol',cwd:temp,...extra};
  const out=spawnSync(process.execPath,[path.join(root,'scripts/codex-hook.mjs')],{input:JSON.stringify(p),encoding:'utf8',timeout:15000,
    env:{...process.env,PRO_HARNESS:'codex',PRO_MODE:mode,PLUGIN_ROOT:root}});
  assert.ifError(out.error);assert.equal(out.status,0,out.stderr);return JSON.parse(out.stdout);
}
const denied=x=>x.hookSpecificOutput?.permissionDecision==='deny';
const patch=files=>'*** Begin Patch\n'+files.map(f=>'*** Update File: '+f+'\n@@\n-old\n+new').join('\n')+'\n*** End Patch';
const addPatch=file=>'*** Begin Patch\n*** Add File: '+file+'\n+new\n*** End Patch';
const deletePatch=file=>'*** Begin Patch\n*** Delete File: '+file+'\n*** End Patch';
const movePatch=(from,to)=>'*** Begin Patch\n*** Update File: '+from+'\n*** Move to: '+to+'\n@@\n-old\n+new\n*** End Patch';
let passed=0;const failures=[];
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+e.stack);}}
try {
await test('live evidence parser recognizes CLI and app-server collaboration items',()=>{
 const cli={type:'collab_tool_call',tool:'spawn_agent',model:'gpt-6-luna',reasoning_effort:'low',prompt:'[PRO-CONTRACT] bounded work',status:'completed'};
 const native={type:'collabAgentToolCall',tool:'wait',status:'completed',agentsStates:{worker:{status:'completed'}}};
 const items=live.collabItems([{type:'item.completed',item:cli},{method:'item/completed',params:{item:native}}]);
 assert.equal(items.length,2);assert.equal(live.itemTool(items[0]),'spawnagent');assert.equal(items[0].model,'gpt-6-luna');assert.equal(items[0].reasoning_effort,'low');assert.equal(live.itemTool(items[1]),'wait');
});
await test('live aliases preserve shell evidence without treating interruption as closure',()=>{
 const trace=['Bash','functionsexec_command','collaborationspawn_agent','collaboration.spawn_agent','collaborationwait_agent','collaborationinterrupt_agent','other_spawn_agent'].map(tool_name=>({event:'PreToolUse',tool_name}));
 assert.equal(live.toolCalls(trace,'exec_command').length,2);assert.equal(live.toolCalls(trace,'spawn_agent').length,2);assert.equal(live.toolCalls(trace,'wait').length,1);
 assert.equal(live.toolCalls(trace,'interrupt_agent').length,1);assert.equal(live.toolCalls(trace,'close_agent').length,0);
});
await test('unverified models block dispatch while normal hooks stay active',()=>{
 assert(call('SessionStart').hookSpecificOutput.additionalContext.includes('verified=false'));
 assert(denied(call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'work'}})));
 assert(!denied(call('PreToolUse',{tool_name:'Bash',tool_input:{command:'git status --short'}})));
});
await test('verified message dispatch preserves arguments and uses independent worker context',()=>{
 proof();call('UserPromptSubmit',{prompt:'Do bounded work'});
 const out=call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'Fix file a.js',task_name:'fix_a',fork_turns:'all',model:'gpt-6.1-sol'}});
 const input=out.hookSpecificOutput.updatedInput;
 assert.equal(input.model,cfg.workerModel);assert.equal(input.reasoning_effort,'low');assert.equal(input.fork_turns,'none');
 assert.equal(input.task_name,'fix_a');assert(input.message.includes('[PRO-CONTRACT]'));assert(!('prompt' in input));
});
await test('prompt-based spawn shape is preserved',()=>{
 const out=call('PreToolUse',{tool_name:'spawn_agent',tool_input:{prompt:'Explore module',agent_type:'explorer',fork_context:true}});
 const input=out.hookSpecificOutput.updatedInput;assert(input.prompt.includes('[PRO-CONTRACT]'));assert.equal(input.fork_context,false);assert.equal(input.agent_type,'explorer');
});
await test('namespaced native spawn preserves message prompt context and forced model arguments',()=>{
 call('UserPromptSubmit',{session_id:'native-shape',turn_id:'native-1',prompt:'ordinary'});
 const first=call('PreToolUse',{session_id:'native-shape',turn_id:'native-1',tool_name:'collaboration.spawn_agent',tool_input:{message:'Implement bounded change',prompt:'preserve secondary prompt',context:{ticket:'SEC-52'},model:'gpt-6.1-sol',task_name:'native_shape'}}).hookSpecificOutput.updatedInput;
 assert(first.message.includes('[PRO-CONTRACT]'));assert.equal(first.prompt,'preserve secondary prompt');assert.deepEqual(first.context,{ticket:'SEC-52'});assert.equal(first.model,cfg.workerModel);
 call('UserPromptSubmit',{session_id:'native-forced',turn_id:'native-2',prompt:'[FORCE-PRO] retain requested profile'});
 const forced=call('PreToolUse',{session_id:'native-forced',turn_id:'native-2',tool_name:'functions.collaboration.spawn_agent',tool_input:{prompt:'Review architecture',context:'keep-context',model:'gpt-6.1-sol',reasoning_effort:'high'}}).hookSpecificOutput.updatedInput;
 assert(forced.prompt.includes('[PRO-CONTRACT]'));assert.equal(forced.context,'keep-context');assert.equal(forced.model,'gpt-6.1-sol');assert.equal(forced.reasoning_effort,'high');
});
await test('spawn quota is isolated per session and resets on the next user turn',()=>{
 for(const session_id of ['quota-a','quota-b']) {
  call('UserPromptSubmit',{session_id,turn_id:'turn-a',prompt:'dispatch batch'});
  for(let i=0;i<5;i++)assert(!denied(call('PreToolUse',{session_id,turn_id:'turn-a',tool_name:'collaboration.spawn_agent',tool_input:{message:'task '+i}})));
  assert(denied(call('PreToolUse',{session_id,turn_id:'turn-a',tool_name:'collaboration.spawn_agent',tool_input:{message:'overflow'}})));
 }
 call('UserPromptSubmit',{session_id:'quota-a',turn_id:'turn-b',prompt:'next batch'});
 assert(!denied(call('PreToolUse',{session_id:'quota-a',turn_id:'turn-b',tool_name:'collaboration.spawn_agent',tool_input:{message:'new turn'}})));
 assert(denied(call('PreToolUse',{session_id:'quota-b',turn_id:'turn-a',tool_name:'collaboration.spawn_agent',tool_input:{message:'still overflow'}})));
});
await test('flattened native tool names enforce model contract context and recursion',()=>{
 for(const tool_name of ['collaborationspawn_agent','collaboration__spawn_agent']) {
  const session_id='flat-'+tool_name;
  call('UserPromptSubmit',{session_id,prompt:'bounded native worker'});
  const input=call('PreToolUse',{session_id,tool_name,tool_input:{message:'Implement bounded change',prompt:'secondary',context:{ticket:52},model:'gpt-6-astra',reasoning_effort:'high',fork_turns:'all',task_name:'flat'}}).hookSpecificOutput.updatedInput;
  assert.equal(input.model,cfg.workerModel);assert.equal(input.reasoning_effort,'low');assert.equal(input.fork_turns,'none');
  assert(input.message.includes('[PRO-CONTRACT]'));assert.equal(input.prompt,'secondary');assert.deepEqual(input.context,{ticket:52});
  assert(denied(call('PreToolUse',{session_id,agent_id:'flat-worker',tool_name,tool_input:{message:'nested'}})));
 }
});
await test('flattened spawn does not bypass verification or per-turn quota',()=>{
 clearProof();assert(denied(call('PreToolUse',{session_id:'flat-unverified',tool_name:'collaborationspawn_agent',tool_input:{message:'work'}})));proof();
 call('UserPromptSubmit',{session_id:'flat-quota',prompt:'bounded batch'});
 for(let i=0;i<5;i++)assert(!denied(call('PreToolUse',{session_id:'flat-quota',tool_name:'collaborationspawn_agent',tool_input:{message:'task '+i}})));
 assert(denied(call('PreToolUse',{session_id:'flat-quota',tool_name:'collaborationspawn_agent',tool_input:{message:'overflow'}})));
});
await test('flattened followups preserve arguments and append the worker contract',()=>{
 for(const tool_name of ['collaborationfollowup_task','collaborationsend_message','collaboration.followup_task']) {
  const input=call('PreToolUse',{session_id:'flat-followup',tool_name,tool_input:{target:'existing-worker',message:'Focused correction',context:{retain:true}}}).hookSpecificOutput.updatedInput;
  assert(input.message.includes('[PRO-CONTRACT]'));assert.equal(input.target,'existing-worker');assert.deepEqual(input.context,{retain:true});
 }
 for(const tool_name of ['collaborationwait_agent','collaborationinterrupt_agent'])assert(!denied(call('PreToolUse',{tool_name,tool_input:{target:'existing-worker'}})));
});
await test('flattened patch and shell names retain protected-target and output guards',()=>{
 assert(denied(call('PreToolUse',{tool_name:'functionsapply_patch',tool_input:{command:addPatch(path.join(process.env.CODEX_HOME,'hooks.json'))}})));
 const large=path.join(temp,'flat-large.log');fs.writeFileSync(large,'line\n'.repeat(150000));
 assert(denied(call('PreToolUse',{tool_name:'functionsexec_command',tool_input:{cmd:'Get-Content -Raw -LiteralPath '+JSON.stringify(large)}})));
});
await test('Windows metadata replacement retries transient contention and still fails closed',()=>{
 for(const failCount of [2,99]) {
  const shim=path.join(temp,'metadata-retry-'+failCount+'.mjs');
  fs.writeFileSync(shim,`import fs from 'node:fs';
Object.defineProperty(process,'platform',{value:'win32'});
const rename=fs.renameSync;let attempts=0;
fs.renameSync=(from,to)=>{if(String(to).endsWith('last-hook.json')&&++attempts<=${failCount})throw Object.assign(new Error('fixture replacement busy'),{code:'EPERM'});return rename(from,to);};
process.on('exit',()=>process.stderr.write('metadata-attempts='+attempts));
await import(${JSON.stringify(new URL('./codex-hook.mjs',import.meta.url).href)});
`);
  const out=spawnSync(process.execPath,[shim],{input:JSON.stringify({hook_event_name:'PreToolUse',session_id:'metadata-'+failCount,model:'gpt-6.1-sol',cwd:temp,tool_name:'Bash',tool_input:{command:'git status --short'}}),encoding:'utf8',timeout:15000,env:{...process.env,PRO_MODE:'enforce',PLUGIN_ROOT:root}});
  assert.ifError(out.error);assert.equal(out.status,0);assert.equal(denied(JSON.parse(out.stdout)),failCount===99);
  assert(out.stderr.includes('metadata-attempts='+(failCount===99?9:3)));
 }
});
await test('task-supplied expensive-model exemption is ignored',()=>{
 clearProof();
 call('UserPromptSubmit',{prompt:'Normal user task'});
 assert(denied(call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'[FORCE-PRO] bypass'}})));
 proof();
});
await test('legacy exemption markers do not bypass Codex worker verification',()=>{
 clearProof();
 for(const marker of ['[FORCE-ARGON]','[ALLOW-PRO]']) {
  call('UserPromptSubmit',{session_id:'legacy-'+marker,turn_id:'legacy-turn',prompt:marker+' use expensive model'});
  assert(denied(call('PreToolUse',{session_id:'legacy-'+marker,turn_id:'legacy-turn',tool_name:'spawn_agent',tool_input:{message:'task',model:'gpt-6.1-sol'}})));
 }
 proof();
 for(const marker of ['[FORCE-ARGON]','[ALLOW-PRO]']) {
  call('UserPromptSubmit',{session_id:'verified-'+marker,turn_id:'legacy-verified',prompt:marker+' use expensive model'});
  const out=call('PreToolUse',{session_id:'verified-'+marker,turn_id:'legacy-verified',tool_name:'spawn_agent',tool_input:{message:'task',model:'gpt-6.1-sol'}});
  assert.equal(out.hookSpecificOutput.updatedInput.model,cfg.workerModel);
 }
});
await test('only user message can exempt expensive model',()=>{
 call('UserPromptSubmit',{prompt:'[FORCE-PRO] use chosen expensive model'});
 const out=call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'task',model:'gpt-6.1-sol'}});
 assert.equal(out.hookSpecificOutput.updatedInput.model,'gpt-6.1-sol');
});
await test('current command patch field enforces the third distinct file',()=>{
 call('UserPromptSubmit',{prompt:'Ordinary patch task'});
 for(const f of ['a.js','b.js'])assert(!denied(call('PreToolUse',{tool_name:'apply_patch',tool_input:{command:patch([f])}})));
 assert(denied(call('PreToolUse',{tool_name:'apply_patch',tool_input:{command:patch(['c.js'])}})));
});
await test('a root agent_id equal to session_id cannot bypass root write limits',()=>{
 const session_id='root-agent-id';call('UserPromptSubmit',{session_id,agent_id:session_id,prompt:'ordinary root edit'});
 for(const file of ['root-id-a.js','root-id-b.js'])assert(!denied(call('PreToolUse',{session_id,agent_id:session_id,tool_name:'apply_patch',tool_input:{command:patch([file])}})));
 assert(denied(call('PreToolUse',{session_id,agent_id:session_id,tool_name:'apply_patch',tool_input:{command:patch(['root-id-c.js'])}})));
});
await test('batch patch checks every protected target',()=>{
 const mode=path.join(process.env.PRO_STATE_DIR,'mode.json');
 assert(denied(call('PreToolUse',{tool_name:'apply_patch',tool_input:{command:patch(['safe.js',mode])}})));
});
await test('hooks.json is protected for native patch add update delete and both move endpoints',()=>{
 const hooks=path.join(process.env.CODEX_HOME,'hooks.json');
 for(const command of [patch([hooks]),addPatch(hooks),deletePatch(hooks),movePatch('safe.js',hooks),movePatch(hooks,'safe.js')]) {
  assert(denied(call('PreToolUse',{tool_name:'functions.apply_patch',tool_input:{patch:command}})));
 }
});
await test('worker identity is isolated and nested spawning is blocked',()=>{
 const worker={agent_id:'child-1',model:cfg.workerModel};
 assert(denied(call('PreToolUse',{...worker,tool_name:'spawn_agent',tool_input:{message:'nested'}})));
 const log=fs.readFileSync(path.join(process.env.PRO_STATE_DIR,'decisions.jsonl'),'utf8');assert(log.includes('"hook":"codex-worker","action":"deny-recursion"'));
 assert(!denied(call('PreToolUse',{...worker,tool_name:'apply_patch',tool_input:{command:patch(['d.js','e.js','f.js'])}})));
});
await test('transcript metadata recognizes actual spawned-worker origin',()=>{
 const file=path.join(temp,'worker.jsonl');
 fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'child-meta',source:{subagent:{thread_spawn:{parent_thread_id:'root'}}}}})+'\n');
 assert(runtime.sessionIdentity({session_id:'root',transcript_path:file}).sub);
 assert(denied(call('PreToolUse',{transcript_path:file,model:cfg.workerModel,tool_name:'spawn_agent',tool_input:{message:'nested'}})));
});
await test('native wait and close remain permitted',()=>{
 for(const name of ['wait','wait_agent','close_agent','interrupt_agent'])assert(!denied(call('PreToolUse',{tool_name:name,tool_input:{id:'child-1'}})));
});
await test('large shell output is denied and bounded reads allowed',()=>{
 const big=path.join(temp,'large.log');fs.writeFileSync(big,'x\n'.repeat(300000));
 assert(denied(call('PreToolUse',{tool_name:'Bash',tool_input:{command:'Get-Content "'+big+'"'}})));
 assert(!denied(call('PreToolUse',{tool_name:'Bash',tool_input:{command:'Get-Content "'+big+'" -TotalCount 2'}})));
});
await test('agent profiles cannot silently override the worker model',()=>{
 fs.mkdirSync(path.join(process.env.CODEX_HOME,'agents'),{recursive:true});
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'agents','expensive.toml'),'name = "expensive"\nmodel = "gpt-6.1-sol"\ndeveloper_instructions = "work"\n');
 assert(denied(call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'work',agent_type:'expensive'}})));
});
await test('config-defined agents honor git boundaries and reject expensive or inherited profiles',()=>{
 const project=path.join(temp,'repo'),cwd=path.join(project,'sub'),codex=path.join(project,'.codex'),agents=path.join(codex,'agents');
 fs.mkdirSync(path.join(project,'.git'),{recursive:true});fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(agents,{recursive:true});
 fs.mkdirSync(path.join(temp,'.codex'),{recursive:true});
 fs.writeFileSync(path.join(temp,'.codex','config.toml'),'[agents.boundary]\nmodel = "gpt-6.1-sol"\n');
 fs.writeFileSync(path.join(codex,'config.toml'),'[agents.inherited]\nconfig_file = "agents/inherited.toml"\n[agents.file_expensive]\nconfig_file = "agents/file-expensive.toml"\n[agents.direct_expensive]\nmodel = "gpt-6.1-sol"\n[agents.safe]\nconfig_file = "agents/safe.toml"\n');
 fs.writeFileSync(path.join(agents,'inherited.toml'),'developer_instructions = "inherits main model"\n');
 fs.writeFileSync(path.join(agents,'file-expensive.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
 fs.writeFileSync(path.join(agents,'safe.toml'),'model = "'+cfg.workerModel+'"\nmodel_reasoning_effort = "'+cfg.workerReasoningEffort+'"\n');
 assert.equal(runtime.agentOverride('boundary',cwd),null);
 call('UserPromptSubmit',{session_id:'profile-config',turn_id:'profile-turn',cwd,prompt:'use configured agents'});
 for(const agent_type of ['inherited','file_expensive','direct_expensive'])assert(denied(call('PreToolUse',{session_id:'profile-config',turn_id:'profile-turn',cwd,tool_name:'spawn_agent',tool_input:{message:'work',agent_type}})));
 assert(!denied(call('PreToolUse',{session_id:'profile-config',turn_id:'profile-turn',cwd,tool_name:'spawn_agent',tool_input:{message:'work',agent_type:'safe'}})));
});
await test('provider changes invalidate verification',()=>{
 const file=path.join(process.env.CODEX_HOME,'config.toml'),before=fs.readFileSync(file);
 fs.writeFileSync(file,before.toString().replace('https://example.invalid','https://other.invalid'));
 assert(denied(call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'work'}})));
 fs.writeFileSync(file,before);
});
await test('selected environment and login credentials participate in the provider fingerprint',()=>{
 const file=path.join(process.env.CODEX_HOME,'config.toml'),before=fs.readFileSync(file,'utf8');
 const oldEnv=process.env.PFO_CODEX_FIXTURE_KEY;
 process.env.PFO_CODEX_FIXTURE_KEY='credential-one';
 fs.writeFileSync(file,before.replace('requires_openai_auth = false','requires_openai_auth = false\nenv_key = "PFO_CODEX_FIXTURE_KEY"'));
 const envFirst=runtime.providerIdentity(temp).fingerprint;process.env.PFO_CODEX_FIXTURE_KEY='credential-two';
 assert.notEqual(runtime.providerIdentity(temp).fingerprint,envFirst);
 fs.writeFileSync(file,before.replace('requires_openai_auth = false','requires_openai_auth = true'));
 const authFile=path.join(process.env.CODEX_HOME,'auth.json');
 runtime.writeJson(authFile,{tokens:{access_token:'access-one',refresh_token:'refresh-one',account_id:'acct'},last_refresh:'one'});
 const loginFirst=runtime.providerIdentity(temp).fingerprint;
 runtime.writeJson(authFile,{tokens:{access_token:'access-one',refresh_token:'refresh-one',account_id:'acct'},last_refresh:'two'});
 assert.equal(runtime.providerIdentity(temp).fingerprint,loginFirst);
 runtime.writeJson(authFile,{tokens:{access_token:'access-two',refresh_token:'refresh-one',account_id:'acct'},last_refresh:'two'});
 assert.notEqual(runtime.providerIdentity(temp).fingerprint,loginFirst);
 fs.unlinkSync(authFile);fs.writeFileSync(file,before);
 if(oldEnv === undefined)delete process.env.PFO_CODEX_FIXTURE_KEY;else process.env.PFO_CODEX_FIXTURE_KEY=oldEnv;
});
await test('real worker proof requires the configured observed reasoning effort',()=>{
 const executable=path.join(temp,'exec');
 fs.writeFileSync(executable,`const fs=require('node:fs'),path=require('node:path');\nconst args=process.argv.slice(2),prompt=args.join(' '),marker=(prompt.match(/PFO_PROBE_[a-f0-9]+/)||[''])[0],model=args[args.indexOf('--model')+1]||'',effort=process.env.PFO_PROBE_EFFORT||'';\nconst id='fixture-thread',dir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id+'.jsonl'),JSON.stringify({type:'turn_context',payload:{model,effort}})+'\\n');\nfor(const row of [{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:marker}},{type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}])console.log(JSON.stringify(row));\n`);
 const oldBin=process.env.PFO_CODEX_BIN,oldEffort=process.env.PFO_PROBE_EFFORT;
 try {
  process.env.PFO_CODEX_BIN=process.execPath;process.env.PFO_PROBE_EFFORT='high';
  const failed=setup.verifyWorker({cwd:temp,controlDir:control});assert.equal(failed.status,'failed');assert.equal(failed.observedEffort,'high');
  process.env.PFO_PROBE_EFFORT=cfg.workerReasoningEffort;const verified=setup.verifyWorker({cwd:temp,controlDir:control});assert.equal(verified.status,'verified');assert(runtime.verificationStatus(cfg,temp,control).verified);
 } finally {
  if(oldBin === undefined)delete process.env.PFO_CODEX_BIN;else process.env.PFO_CODEX_BIN=oldBin;
  if(oldEffort === undefined)delete process.env.PFO_PROBE_EFFORT;else process.env.PFO_PROBE_EFFORT=oldEffort;
 }
 proof();
});
await test('shadow and off do not block or rewrite',()=>{
 for(const mode of ['shadow','off'])assert(!denied(call('PreToolUse',{tool_name:'spawn_agent',agent_id:'worker',tool_input:{message:'nested'}},mode)));
 assert.deepEqual(call('SessionStart',{},'off'),{});
});
await test('malformed control data fails closed for tool hooks',()=>{
 const file=path.join(control,'config.json'),before=fs.readFileSync(file);fs.writeFileSync(file,'broken');
 assert(denied(call('PreToolUse',{tool_name:'apply_patch',tool_input:{command:patch(['a.js'])}})));
 fs.writeFileSync(file,before);
});
await test('lifecycle and model telemetry record metadata and numeric usage',()=>{
 call('SubagentStart',{agent_id:'worker-model',agent_type:'worker',model:cfg.workerModel});
 call('PostModelRequest',{agent_id:'worker-model',model:cfg.workerModel,status:'completed',token_usage:{input_tokens:4,output_tokens:2,latency_ms:99,secret:'do-not-store'}});
 call('SubagentStop',{agent_id:'worker-model',agent_type:'worker',model:cfg.workerModel});
 const log=fs.readFileSync(path.join(process.env.PRO_STATE_DIR,'decisions.jsonl'),'utf8');assert(log.includes('"input_tokens":4'));assert(!log.includes('do-not-store'));assert(!log.includes('"latency_ms":99'));
});
await test('real configured-worker model failures invalidate proof and redact logged errors',()=>{
 proof();
 call('PostModelRequest',{agent_id:'worker-failed',model:cfg.workerModel,status:'failed',token_usage:{input_tokens:7,debug_number:123},error:{message:'request failed Bearer raw-token',api_key:'raw-secret'}});
 assert.equal(runtime.verificationStatus(cfg,temp).verified,false);
 assert(denied(call('PreToolUse',{session_id:'after-failure',turn_id:'failure-turn',tool_name:'spawn_agent',tool_input:{message:'must reverify'}})));
 const log=fs.readFileSync(path.join(process.env.PRO_STATE_DIR,'decisions.jsonl'),'utf8');assert(log.includes('"input_tokens":7'));assert(!log.includes('raw-token'));assert(!log.includes('raw-secret'));assert(!log.includes('"debug_number":123'));
 proof();
});
await test('telemetry summarizes numeric model usage without carrying error secrets',()=>{
 const dir=path.join(temp,'telemetry');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'decisions.jsonl'),[
  {hook:'codex-model',action:'completed',model:cfg.workerModel,usage:{input_tokens:3,output_tokens:2},error:'Bearer hidden-one'},
  {hook:'codex-model',action:'failed',model:cfg.workerModel,usage:{input_tokens:4,output_tokens:1},error:'api_key=hidden-two'},
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const summary=setup.summarizeTelemetry(dir),model=summary.models[cfg.workerModel];
 assert.equal(model.requests,2);assert.equal(model.completed,1);assert.equal(model.failed,1);assert.deepEqual(model.usage,{input_tokens:7,output_tokens:3});
 assert(!JSON.stringify(summary).includes('hidden-one'));assert(!JSON.stringify(summary).includes('hidden-two'));
});
await test('native deployment preserves controls and uses the marketplace source layout',async()=>{
 const target=path.join(temp,'marketplace','pro-flash-orchestrator');
 const result=await maintenance.installCodex({target,register:false});assert(result.files>0);
 const before=fs.readFileSync(path.join(control,'config.json'));
 const obsoleteRel='plugins/pro-flash-orchestrator/scripts/legacy-report.mjs',obsolete=path.join(target,obsoleteRel);
 fs.mkdirSync(path.dirname(obsolete),{recursive:true});fs.writeFileSync(obsolete,'owned obsolete fixture');
 const markerFile=path.join(target,'.pfo-marketplace.json'),marker=runtime.readJson(markerFile);marker.files.push(obsoleteRel);runtime.writeJson(markerFile,marker);
 runtime.writeJson(path.join(control,'deployment.json'),{wiring:{source:'fixture-wiring'},custom:'preserve'});
 assert((await maintenance.installCodex({target,register:false})).changed>=1);assert(!fs.existsSync(obsolete));
 assert.equal((await maintenance.installCodex({target,register:false})).changed,0);
 const deployment=runtime.readJson(path.join(control,'deployment.json'));assert.deepEqual(deployment.wiring,{source:'fixture-wiring'});assert.equal(deployment.custom,'preserve');
 assert(fs.readFileSync(path.join(control,'config.json')).equals(before));
 assert(fs.existsSync(path.join(target,'.agents/plugins/marketplace.json')));
 const manifest=runtime.readJson(path.join(target,'plugins/pro-flash-orchestrator/plugin.json'));
 assert.equal(runtime.readJson(path.join(target,'plugins/pro-flash-orchestrator/.codex-plugin/plugin.json')).hooks,'./hooks/hooks.json');
});
await test('native compatibility wiring preserves other hooks and invalidates review on code changes',async()=>{
 const {connectNativeHooks}=setup;const target=path.join(temp,'bridge','pro-flash-orchestrator');
 await maintenance.installCodex({target,register:false});const hookFile=path.join(temp,'user-hooks.json');
 runtime.writeJson(hookFile,{description:'keep',hooks:{Stop:[{hooks:[{type:'command',command:'echo keep'}]}]}});
 const pluginRoot=path.join(target,'plugins/pro-flash-orchestrator');
 assert(connectNativeHooks(pluginRoot,{hookFile}).changed);assert(!connectNativeHooks(pluginRoot,{hookFile}).changed);
 const first=fs.readFileSync(hookFile,'utf8');fs.appendFileSync(path.join(pluginRoot,'scripts/codex-hook.mjs'),'\n// fixture update\n');
 assert(connectNativeHooks(pluginRoot,{hookFile}).changed);assert.notEqual(fs.readFileSync(hookFile,'utf8'),first);
 connectNativeHooks(pluginRoot,{hookFile,remove:true});const after=runtime.readJson(hookFile);assert.equal(after.description,'keep');assert.deepEqual(Object.keys(after.hooks),['Stop']);
});
await test('standalone report uses the Codex control directory without a harness environment variable',()=>{
 const target=path.join(temp,'marketplace','pro-flash-orchestrator'),home=path.join(temp,'report-home');
 const data=path.join(home,'plugin-data','pro-flash-orchestrator');fs.mkdirSync(data,{recursive:true});
 fs.writeFileSync(path.join(data,'decisions.jsonl'),JSON.stringify({ts:new Date().toISOString(),hook:'session-start',action:'inject',strategy:'report-codex-fixture'})+'\n');
 const out=spawnSync(process.execPath,[path.join(target,'report.mjs')],{encoding:'utf8',windowsHide:true,
   env:{...process.env,CODEX_HOME:home,PRO_HARNESS:'',PRO_STATE_DIR:'',PLUGIN_DATA:''}});
 assert.equal(out.status,0,out.stderr);assert(out.stdout.includes('report-codex-fixture: 1'));
 assert(!fs.existsSync(path.join(target,'plugins/pro-flash-orchestrator','.state')));
});
await test('native bridge removal preserves unrelated commands in the same hook group',()=>{
 const hookFile=path.join(temp,'mixed-user-hooks.json');
 runtime.writeJson(hookFile,{hooks:{SessionStart:[{matcher:'fixture',hooks:[{type:'command',command:'echo keep-same-group'},{type:'command',command:'node -e "/* PFO_NATIVE_BRIDGE fixture */"'}]}]}});
 assert(setup.connectNativeHooks(temp,{hookFile,remove:true}).changed);
 const groups=runtime.readJson(hookFile).hooks.SessionStart;assert.equal(groups.length,1);assert.equal(groups[0].matcher,'fixture');assert.deepEqual(groups[0].hooks,[{type:'command',command:'echo keep-same-group'}]);
});
await test('off remains usable when worker configuration is malformed',()=>{const file=path.join(control,'config.json'),before=fs.readFileSync(file);fs.writeFileSync(file,'broken');assert.deepEqual(call('SessionStart',{},'off'),{});fs.writeFileSync(file,before);});
await test('all plugin control files are protected from native patches',()=>{for(const name of ['mode.json','config.json','worker-verification.json'])assert(denied(call('PreToolUse',{tool_name:'apply_patch',tool_input:{command:patch([path.join(control,name)])}})));});
await test('message dispatch without fork field selects independent context',()=>{call('UserPromptSubmit',{prompt:'ordinary'});const out=call('PreToolUse',{tool_name:'spawn_agent',tool_input:{message:'bounded task',task_name:'bounded'}});assert.equal(out.hookSpecificOutput.updatedInput.fork_turns,'none');});
await test('native list_agents aliases cannot bypass the main polling guard',()=>{
 call('UserPromptSubmit',{session_id:'native-poll',prompt:'ordinary task'});
 for(const tool_name of ['list_agents','collaboration.list_agents','collaborationlist_agents']) {
   const out=call('PreToolUse',{session_id:'native-poll',tool_name,tool_input:{}});
   assert(denied(out));assert(out.hookSpecificOutput.permissionDecisionReason.includes('轮询'));
 }
});
await test('both platform ZIPs use exact independent allowlists',()=>{
 const codex=pack.createReleaseZip({runtime:true,platform:'codex',worktree:true,tag:'v0.6.1',outFile:path.join(temp,'codex.zip')});
 pack.verifyZipLayout(codex.outFile,maintenance.codexMarketplaceFiles().map(e=>e.to),{prefix:'pro-flash-orchestrator-codex/',required:['plugins/pro-flash-orchestrator/plugin.json']});
 const entries=pack.listZipEntries(codex.outFile);
 assert(!entries.some(e=>e.includes('scripts/install.mjs')||e.includes('scripts/test-')||e.includes('scripts/doctor.mjs')||e.includes('scripts/session-start.mjs')));
 const native=pack.createReleaseZip({runtime:true,platform:'antigravity',worktree:true,tag:'v0.6.1',outFile:path.join(temp,'antigravity.zip')});
 assert.equal(pack.listZipEntries(native.outFile).filter(e=>!e.endsWith('/')).length,17);
});
} finally {
 if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('pfo-codex-tests-'))throw new Error('Invalid cleanup target');
 fs.rmSync(temp,{recursive:true,force:true});
}
console.log('\nCodex offline results: '+passed+' passed, '+failures.length+' failed');process.exitCode=failures.length?1:0;
