#!/usr/bin/env node
/** v0.6.1 guard regressions. All hooks and protocol probes use isolated state. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-v060-'));
const WORKSPACE = path.join(TMP, 'workspace');
const STATE = path.join(TMP, 'state');
fs.mkdirSync(WORKSPACE);
for (const key of ['PRO_TEST','ARGON_TEST','PRO_HARNESS','PRO_WORKER_MODEL','PRO_RESEARCH_MODEL','PRO_SELF_MODEL','PRO_NATIVE_ORCHESTRATOR']) process.env[key] = '';
process.env.PRO_STATE_DIR = STATE;
process.env.PRO_MODE = 'enforce';
process.env.CODEX_HOME = path.join(TMP, 'codex-home');
const lib = await import('./lib.mjs');
const runtime = await import('./codex-runtime.mjs');
const report = await import('./report.mjs');
const mainTranscript = path.join(TMP, 'main.jsonl');
fs.writeFileSync(mainTranscript, JSON.stringify({source:'USER_EXPLICIT',content:'ordinary task'})+'\n');
const files = Array.from({length:12}, (_,i) => path.join(WORKSPACE,'file-'+i+'.js'));
for (const file of files) fs.writeFileSync(file, '// fixture\n'.repeat(200));
const big = path.join(WORKSPACE,'huge.js');
fs.writeFileSync(big, '// giant fixture\n'.repeat(1000));
const minified = path.join(WORKSPACE,'minified.js');
fs.writeFileSync(minified, 'x'.repeat(100000));
const convFile = id => path.join(STATE,'sessions',id.replace(/[^a-zA-Z0-9._-]/g,'_')+'.json');
const seed = (id,state) => {fs.mkdirSync(path.dirname(convFile(id)),{recursive:true});fs.writeFileSync(convFile(id),JSON.stringify(state));};
const base = (id,extra={}) => ({conversationId:id,transcriptPath:mainTranscript,workspacePaths:[WORKSPACE],lastUserInput:'implement modules',...extra});
const dispatch = (id,type='self',extra={}) => base(id,{toolCall:{name:'invoke_subagent',args:{TypeName:type,Model:'inherit',Prompt:'bounded work'}},...extra});
const read = (id,file=files[0],args={StartLine:1,EndLine:80},extra={}) => base(id,{toolCall:{name:'view_file',args:{Path:file,...args}},...extra});
const command = (id,text,extra={}) => base(id,{toolCall:{name:'run_command',args:{CommandLine:text}},...extra});
const decision = out => out.decision || out.hookSpecificOutput?.permissionDecision || 'allow';
function hook(script,payload,env={}) {
  const result=spawnSync(process.execPath,[path.join(ROOT,'scripts',script)],{
    input:JSON.stringify(payload),encoding:'utf8',cwd:ROOT,timeout:15000,windowsHide:true,
    env:{...process.env,...env},
  });
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
function concurrent(script,payload) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(ROOT,'scripts',script)],{env:process.env,cwd:ROOT,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
    child.once('error',reject);child.once('exit',code=>{
      try {assert.equal(code,0,stderr);resolve(JSON.parse(stdout));} catch(error){reject(error);}
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
function fillReads(id,extra={}) {
  seed(id,{phase:'audit',auditSliceQuota:2,maxReadsAllowed:3,lastReadUserInput:'implement modules',lastUserInput:'implement modules',
    readsSinceDispatch:files.slice(0,3).map(file=>process.platform==='win32'?file.toLowerCase():file),...extra});
}
const messages=out=>out.injectSteps?.map(step=>step.ephemeralMessage || '').join('\n') || out.hookSpecificOutput?.additionalContext || '';
let passed=0;
const failures=[];
async function test(name,fn) {
  try {await fn();passed++;console.log('PASS '+name);}
  catch(error){failures.push(name);console.error('FAIL '+name+': '+error.stack);}
}
try {
await test('report estimates only admitted read reductions and handles slice boundaries',()=>{
  const row={hook:'guard-read-file',bytes:4000,lines:1000};
  assert.equal(report.estimateContextSavings([{...row,action:'slice',start:201,end:400}]).savedBytes,200);
  assert.equal(report.estimateContextSavings([{...row,action:'slice',start:851,end:null}]).savedBytes,0);
  assert.equal(report.estimateContextSavings([{...row,action:'slice',start:951,end:1200}]).savedBytes,0);
  assert.equal(report.estimateContextSavings([{...row,action:'deny',start:101,end:180}]).savedBytes,320);
  assert.equal(report.estimateContextSavings([{...row,action:'slice',requestedLines:200,deliveredLines:50}]).savedBytes,600);
  assert.equal(report.estimateContextSavings([{...row,action:'deny',mode:'shadow'}, {...row,action:'would-deny'},
    {...row,action:'slice',bytes:'invalid'}, {...row,action:'slice',requestedLines:-1}]).savedBytes,0);
});
await test('read telemetry records the requested and retained span for explicit clamps',()=>{
  hook('guard-read-file.mjs',read('span-clamp',big,{StartLine:201,EndLine:400}));
  const rows=report.loadDecisions(STATE).filter(row=>row.hook==='guard-read-file'&&row.action==='slice');
  const row=rows.find(row=>row.start===201&&row.end===400);
  assert(row);assert.equal(row.requestedLines,200);assert.equal(row.deliveredLines,150);
  assert.equal(report.estimateContextSavings([row]).savedBytes,850);
});
await test('report labels file ownership, configuration, state failures and unknown dispatches separately',()=>{
  for(const [rule,label] of [['file-conflict','同批文件冲突'],['protected-config','配置保护'],
    ['state-update','写入状态更新失败'],['parent-unresolved','父会话未关联'],['write-quota','直改超限']]) {
    assert.equal(report.denyLabel({hook:'guard-write-file',rule,base:'unit.js'}),label+': unit.js');
  }
  assert.equal(report.denyLabel({hook:'guard-subagent',reason:'状态锁忙'}),'派单状态更新失败');
  assert.equal(report.denyLabel({hook:'guard-subagent',reason:'unexpected'}),'派单拦截 (invoke_subagent)');
  assert(!report.denyLabel({hook:'guard-read-file',base:'unit.js'}).includes('? 行'));
});
await test('report discards malformed JSON values and rejects invalid day windows',()=>{
  const dir=path.join(TMP,'report-malformed');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'decisions.jsonl'),'null\n42\n"text"\n[]\n{}\n'+
    JSON.stringify({hook:'session-start',action:'inject',ts:new Date().toISOString()})+'\n');
  assert.equal(report.loadDecisions(dir).length,1);
  for(const value of ['0','-1','Infinity','invalid']) {
    const result=spawnSync(process.execPath,[path.join(ROOT,'scripts/report.mjs'),'--days',value],{env:process.env,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);assert(result.stderr.includes('--days'));
  }
});
await test('release metadata, root prompt mirrors and legacy matcher sets stay synchronized',()=>{
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT,'plugin.json'),'utf8')).version,'0.6.1');
  for(const [mirror,canonical] of [['SKILL.md','skills/flash-dev/SKILL.md'],['AGENTS.md','rules/AGENTS.md']]) {
    assert.equal(fs.readFileSync(path.join(ROOT,mirror),'utf8').replace(/\r\n/g,'\n'),
      fs.readFileSync(path.join(ROOT,canonical),'utf8').replace(/\r\n/g,'\n'));
  }
  const rootHooks=JSON.parse(fs.readFileSync(path.join(ROOT,'hooks.json'),'utf8'));
  const matchers=Object.values(rootHooks).flatMap(group=>group.PreToolUse || []).map(group=>group.matcher).sort();
  for(const file of ['hooks/claude-settings-hooks.json','hooks/codex-hooks.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8')).hooks.PreToolUse.map(group=>group.matcher).sort(),matchers);
  }
});
await test('native detection checks both model fields and the explicit environment flag',()=>{
  assert(lib.isNativeOrchestrator({modelName:'Orchestrator (Argon)'}));
  assert(lib.isNativeOrchestrator({model:'ORCHESTRATOR',modelName:'Pro'}));
  assert(!lib.isNativeOrchestrator({model:'argon'}));
  assert(!lib.isNativeOrchestrator(null));
  process.env.PRO_NATIVE_ORCHESTRATOR='1';
  try {assert(lib.isNativeOrchestrator({}));} finally {process.env.PRO_NATIVE_ORCHESTRATOR='';}
});
await test('worker defaults and task override precedence are consistent',()=>{
  assert.equal(lib.targetWorkerModel('antigravity','self',{modelName:'Pro',model:'Hydrogen'}),'inherit');
  assert.equal(lib.targetWorkerModel('codex'),'gpt-5-mini');
  assert.equal(runtime.DEFAULT_WORKER,'gpt-5-mini');
  assert.equal(runtime.workerConfig().workerModel,'gpt-5-mini');
  assert.equal(lib.targetWorkerModel('claude'),'haiku');
  assert.equal(lib.targetWorkerModel('antigravity'),'flash');
  process.env.PRO_WORKER_MODEL='common';process.env.PRO_RESEARCH_MODEL='hydrogen';process.env.PRO_SELF_MODEL='flash';
  try {
    for(const harness of ['codex','claude','antigravity']) {
      assert.equal(lib.targetWorkerModel(harness,'research'),'hydrogen');
      assert.equal(lib.targetWorkerModel(harness,'self'),'flash');
      assert.equal(lib.targetWorkerModel(harness),'common');
    }
    assert.equal(runtime.workerConfig(undefined,'research').workerModel,'hydrogen');
    assert.equal(runtime.workerConfig(undefined,'self').workerModel,'flash');
  } finally {for(const key of ['PRO_WORKER_MODEL','PRO_RESEARCH_MODEL','PRO_SELF_MODEL'])process.env[key]='';}
});
await test('all platform matcher files include every requested native tool name',()=>{
  const groups={
    'guard-subagent.mjs':['invoke_subagent','define_subagent','send_message','manage_subagents','Task','Agent','spawn_agent'],
    'guard-write-file.mjs':['write_file','write_to_file','edit_file','replace_file_content','multi_replace_file_content','Write','Edit','MultiEdit','apply_patch'],
    'guard-read-file.mjs':['read_file','view_file','view_content_chunk','Read'],
    'guard-command.mjs':['run_command','Bash','shell','exec_command'],
  };
  const root=JSON.parse(fs.readFileSync(path.join(ROOT,'hooks.json'),'utf8'));
  const entries=Object.values(root).flatMap(entry=>entry.PreToolUse || []);
  for(const file of ['hooks/claude-settings-hooks.json','hooks/codex-hooks.json'])entries.push(...JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8')).hooks.PreToolUse);
  for(const [script,names] of Object.entries(groups)) {
    const matching=entries.filter(entry=>entry.hooks.some(item=>item.command.endsWith(script)));
    assert.equal(matching.length,3);
    for(const entry of matching)for(const name of names)assert(entry.matcher.split('|').includes(name),script+': '+name);
  }
});
await test('partial SYSTEM records preserve every worker marker, including late source fields',()=>{
  for(const marker of ['[FLASH-WORKER]','[PRO-CONTRACT]','[ARGON-CONTRACT]']) {
    for(const sourceFirst of [true,false]) {
      const file=path.join(TMP,'worker-'+marker.slice(1,-1)+'-'+sourceFirst+'.jsonl');
      const content=marker+' '+ 'x'.repeat(100000);
      fs.writeFileSync(file,JSON.stringify(sourceFirst?{source:'SYSTEM',content}:{content,source:'SYSTEM'})+'\n');
      lib.setContext({});
      assert(lib.isSubAgent({transcriptPath:file}),marker+' sourceFirst='+sourceFirst);
      assert.deepEqual(hook('session-start.mjs',base('long-worker',{transcriptPath:file})),{});
    }
  }
});
await test('explicit main transcript remains authoritative when users paste worker markers',()=>{
  const file=path.join(TMP,'long-main.jsonl');
  fs.writeFileSync(file,JSON.stringify({source:'USER_EXPLICIT',content:'[FLASH-WORKER] [PRO-CONTRACT] '+ 'x'.repeat(100000)})+'\n');
  lib.setContext({});
  assert(!lib.isSubAgent({transcriptPath:file,lastUserInput:'[FLASH-WORKER] pasted'}));
});
await test('PRO_TEST alone marks decision telemetry as test data',()=>{
  const out=hook('guard-subagent.mjs',dispatch('test-flag'),{PRO_TEST:'1',ARGON_TEST:''});
  assert.equal(decision(out),'allow');
  const rows=fs.readFileSync(lib.LOG_FILE,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(rows.some(row=>row.conv==='test-fla' && row.test===true));
  assert.equal(lib.readSession('test-flag').auditSliceQuota,2);
});
await test('old and missing sessions receive the new phase, quota and command defaults',()=>{
  assert.equal(lib.readSession('missing').phase,'explore');
  assert.equal(lib.readSession('missing').auditSliceQuota,0);
  assert.equal(lib.readSession('missing').auditPendingWakeup,false);
  seed('legacy',{maxReadsAllowed:7});
  assert.equal(lib.readSession('legacy').phase,'explore');
  assert.deepEqual(lib.readSession('legacy').subagentCommands,[]);
  assert.equal(lib.readSession('legacy').maxReadsAllowed,7);
});
await test('ordinary main read and write quotas remain enforced',()=>{
  for(let i=0;i<3;i++)assert.equal(decision(hook('guard-read-file.mjs',read('ordinary',files[i]))),'allow');
  assert.equal(decision(hook('guard-read-file.mjs',read('ordinary',files[3]))),'deny');
  for(let i=0;i<2;i++)assert.equal(decision(hook('guard-write-file.mjs',base('ordinary-write',{toolCall:{name:'write_file',args:{Path:files[i]}}}))),'allow');
  assert.equal(decision(hook('guard-write-file.mjs',base('ordinary-write',{toolCall:{name:'write_file',args:{Path:files[2]}}}))),'deny');
});
await test('Lite mode bypasses read and write counts via model name or environment',()=>{
  for(const byEnv of [false,true]) {
    const extra=byEnv?{}:{modelName:'Orchestrator (Argon)'};
    const env=byEnv?{PRO_NATIVE_ORCHESTRATOR:'1'}:{};
    for(let i=0;i<5;i++) {
      assert.equal(decision(hook('guard-read-file.mjs',read('lite-read-'+byEnv,files[i],{StartLine:1,EndLine:80},extra),env)),'allow');
      assert.equal(decision(hook('guard-write-file.mjs',base('lite-write-'+byEnv,{...extra,toolCall:{name:'write_file',args:{Path:files[i]}}}),env)),'allow');
    }
  }
});
await test('Lite preserves huge full-read denial, soft slicing and protected writes',()=>{
  const extra={modelName:'Orchestrator (Argon)'};
  assert.equal(decision(hook('guard-read-file.mjs',read('lite-hard',big,{},extra))),'deny');
  assert.equal(decision(hook('guard-read-file.mjs',read('lite-slice',big,{StartLine:1,EndLine:80},extra))),'allow');
  const soft=path.join(WORKSPACE,'soft.js');fs.writeFileSync(soft,'// line\n'.repeat(500));
  assert(hook('guard-read-file.mjs',read('lite-soft',soft,{},extra)).overwrite);
  const protectedFile=path.join(STATE,'mode.json');
  assert.equal(decision(hook('guard-write-file.mjs',base('lite-protected',{...extra,toolCall:{name:'write_file',args:{Path:protectedFile}}}))),'deny');
});
await test('Lite preserves recursion, polling, contracts and command restrictions',()=>{
  const extra={modelName:'Orchestrator (Argon)'};
  assert.equal(decision(hook('guard-subagent.mjs',dispatch('lite-sub','self',{...extra,parentConversationId:'parent'}))),'deny');
  assert.equal(decision(hook('guard-subagent.mjs',base('lite-poll',{...extra,toolCall:{name:'manage_subagents',args:{Action:'list'}}}))),'deny');
  assert(hook('guard-subagent.mjs',dispatch('lite-contract','self',extra)).overwrite.Prompt.includes('[PRO-CONTRACT]'));
  assert.equal(decision(hook('guard-command.mjs',command('lite-command','git log',extra))),'deny');
  assert.equal(decision(hook('guard-command.mjs',command('lite-dump','cat "'+big+'"',extra))),'allow','fixture is below the command dump byte limit');
  assert.equal(decision(hook('guard-command.mjs',command('lite-dump','cat "'+minified+'"',extra))),'allow');
  const hugeLog=path.join(WORKSPACE,'dump.log');fs.writeFileSync(hugeLog,'x'.repeat(500000));
  assert.equal(decision(hook('guard-command.mjs',command('lite-dump','cat "'+hugeLog+'"',extra))),'deny');
});
for(const count of [1,3,5]) await test(count+' self dispatches grant exactly two audit slices each',()=>{
  const id='audit-'+count;
  for(let i=0;i<count;i++)assert.equal(decision(hook('guard-subagent.mjs',dispatch(id))),'allow');
  assert.equal(lib.readSession(id).phase,'audit');
  assert.equal(lib.readSession(id).auditPendingWakeup,true);
  assert.equal(lib.readSession(id).auditSliceQuota,count*2);
  fillReads(id,{...lib.readSession(id),maxReadsAllowed:3,readsSinceDispatch:files.slice(0,3).map(file=>process.platform==='win32'?file.toLowerCase():file)});
  for(let i=0;i<count*2;i++)assert.equal(decision(hook('guard-read-file.mjs',read(id,files[i]))),'allow');
  assert.equal(lib.readSession(id).auditSliceQuota,0);
  assert.equal(lib.readSession(id).readsSinceDispatch.length,3);
  assert.equal(decision(hook('guard-read-file.mjs',read(id,files[11]))),'deny');
});
await test('denied sixth spawn, definitions, research and followups do not mint self audit quota',()=>{
  const before=lib.readSession('audit-5').auditSliceQuota;
  assert.equal(decision(hook('guard-subagent.mjs',dispatch('audit-5'))),'deny');
  assert.equal(lib.readSession('audit-5').auditSliceQuota,before);
  hook('guard-subagent.mjs',dispatch('research-only','research'));
  assert.equal(lib.readSession('research-only').phase,'explore');
  assert.equal(lib.readSession('research-only').auditSliceQuota,0);
  assert.equal(lib.readSession('research-only').auditPendingWakeup,false);
  hook('guard-subagent.mjs',base('research-only',{toolCall:{name:'define_subagent',args:{Name:'self',SystemPrompt:'work'}}}));
  hook('guard-subagent.mjs',base('research-only',{toolCall:{name:'send_message',args:{Recipient:'worker',Message:'continue'}}}));
  assert.equal(lib.readSession('research-only').auditSliceQuota,0);
});
await test('only complete <=80 line ranges consume audit quota',()=>{
  fillReads('audit-bounds');
  for(const args of [{StartLine:1,EndLine:81},{StartLine:1},{EndLine:80},{StartLine:20,EndLine:10},{StartLine:1.5,EndLine:80.5},{}]) {
    assert.equal(decision(hook('guard-read-file.mjs',read('audit-bounds',files[10],args))),'deny');
    assert.equal(lib.readSession('audit-bounds').auditSliceQuota,2);
  }
  assert.equal(decision(hook('guard-read-file.mjs',read('audit-bounds',files[10],{StartLine:21,EndLine:100}))),'allow');
  assert.equal(lib.readSession('audit-bounds').auditSliceQuota,1);
});
await test('audit slices handle unknown extensions and reject minified flooding without charging',()=>{
  const unknown=path.join(WORKSPACE,'extensionless');fs.writeFileSync(unknown,'line\n'.repeat(100));
  fillReads('audit-unknown');
  assert.equal(decision(hook('guard-read-file.mjs',read('audit-unknown',unknown))),'allow');
  assert.equal(lib.readSession('audit-unknown').auditSliceQuota,1);
  assert.equal(decision(hook('guard-read-file.mjs',read('audit-unknown',minified))),'deny');
  assert.equal(lib.readSession('audit-unknown').auditSliceQuota,1);
});
await test('audit phase alone cannot create an unlimited slice bypass',()=>{
  fillReads('audit-empty',{auditSliceQuota:0});
  assert.equal(decision(hook('guard-read-file.mjs',read('audit-empty',files[10]))),'deny');
});
await test('new dispatch batches reset audit budgets while wakeup consumes the pending marker once',()=>{
  hook('guard-subagent.mjs',dispatch('audit-turn','self',{turnId:'one'}));
  const first=lib.readSession('audit-turn').auditBatchId;
  hook('guard-subagent.mjs',dispatch('audit-turn','self',{turnId:'two'}));
  assert.equal(lib.readSession('audit-turn').auditSliceQuota,2);
  assert.notEqual(lib.readSession('audit-turn').auditBatchId,first);
  hook('pre-invocation.mjs',{hook_event_name:'UserPromptSubmit',session_id:'audit-turn',model:'claude-opus',prompt:'implement modules'});
  assert.equal(lib.readSession('audit-turn').phase,'audit');
  assert.equal(lib.readSession('audit-turn').auditSliceQuota,2);
  assert.equal(lib.readSession('audit-turn').auditPendingWakeup,false);
  hook('pre-invocation.mjs',{hook_event_name:'UserPromptSubmit',session_id:'audit-turn',model:'claude-opus',prompt:'implement modules'});
  assert.equal(lib.readSession('audit-turn').phase,'explore');
  assert.equal(lib.readSession('audit-turn').auditSliceQuota,0);
});
await test('changed read input preserves and consumes a positive audit slice budget',()=>{
  hook('guard-subagent.mjs',dispatch('audit-input'));
  lib.updateSession('audit-input',state=>{state.maxReadsAllowed=7;state.lastReadUserInput='old input';});
  hook('guard-read-file.mjs',read('audit-input',files[0],{StartLine:1,EndLine:80},{lastUserInput:'new task'}));
  const state=lib.readSession('audit-input');
  assert.equal(state.phase,'audit');assert.equal(state.auditSliceQuota,1);assert.equal(state.maxReadsAllowed,7);
});
for(const wakeup of ['input-change','turn-change','invocation-reset','UserPromptSubmit']) {
  await test(wakeup+' wakeup retains audit phase and quotas through the next read, then an ordinary turn resets',()=>{
    const id='wake-'+wakeup;
    hook('guard-subagent.mjs',dispatch(id,'self',{turnId:'work-turn'}));
    lib.updateSession(id,state=>{state.maxReadsAllowed=7;state.lastInvocationNum=20;});
    // Normal invocations in the dispatch turn must not consume the wakeup marker.
    hook('pre-invocation.mjs',base(id,{turnId:'work-turn',invocationNum:20}));
    assert.equal(lib.readSession(id).auditPendingWakeup,true);
    const payload=wakeup==='UserPromptSubmit'
      ? {hook_event_name:'UserPromptSubmit',session_id:id,model:'claude-opus',prompt:'implement modules'}
      : base(id,{turnId:wakeup==='turn-change'?'wake-turn':'work-turn',
          lastUserInput:wakeup==='input-change'?'worker completed':'implement modules',
          invocationNum:wakeup==='invocation-reset'?1:20});
    hook('pre-invocation.mjs',payload);
    const state=lib.readSession(id);
    assert.equal(state.auditPendingWakeup,false);assert.equal(state.phase,'audit');
    assert.equal(state.auditSliceQuota,2);assert.equal(state.maxReadsAllowed,7);
    assert.equal(decision(hook('guard-read-file.mjs',read(id,files[0],{StartLine:1,EndLine:40},
      {lastUserInput:'worker completed: read result'}))),'allow');
    assert.equal(lib.readSession(id).auditSliceQuota,1);assert.equal(lib.readSession(id).phase,'audit');
    assert.equal(lib.readSession(id).maxReadsAllowed,7);
    hook('pre-invocation.mjs',base(id,{turnId:'next-user-turn',lastUserInput:'next user task',invocationNum:1}));
    const next=lib.readSession(id);
    assert.equal(next.phase,'explore');assert.equal(next.auditSliceQuota,0);assert.equal(next.maxReadsAllowed,3);
    assert.equal(next.auditPendingWakeup,false);
  });
}
await test('changed read input with exhausted audit quota uses the normal new-turn reset',()=>{
  fillReads('audit-exhausted-input',{auditSliceQuota:0,auditPendingWakeup:true,maxReadsAllowed:7});
  assert.equal(decision(hook('guard-read-file.mjs',read('audit-exhausted-input',files[0],{StartLine:1,EndLine:40},
    {lastUserInput:'new user task'}))),'allow');
  const state=lib.readSession('audit-exhausted-input');
  assert.equal(state.phase,'explore');assert.equal(state.auditSliceQuota,0);
  assert.equal(state.auditPendingWakeup,false);assert.equal(state.maxReadsAllowed,3);
});
await test('a new research batch clears an older self wakeup marker and off mode cannot create one',()=>{
  hook('guard-subagent.mjs',dispatch('research-reset','self',{turnId:'self-turn'}));
  assert.equal(lib.readSession('research-reset').auditPendingWakeup,true);
  hook('guard-subagent.mjs',dispatch('research-reset','research',{turnId:'research-turn'}));
  assert.equal(lib.readSession('research-reset').phase,'explore');
  assert.equal(lib.readSession('research-reset').auditPendingWakeup,false);
  hook('guard-subagent.mjs',dispatch('off-self'),{PRO_MODE:'off'});
  assert.equal(lib.readSession('off-self').auditPendingWakeup,false);
  assert.equal(lib.readSession('off-self').phase,'explore');
});
await test('parallel spawn admissions cap audit quota at ten and reject overflow',async()=>{
  const out=await Promise.all(Array.from({length:8},()=>concurrent('guard-subagent.mjs',dispatch('audit-parallel'))));
  assert.equal(out.filter(item=>decision(item)==='allow').length,5);
  assert.equal(out.filter(item=>decision(item)==='deny').length,3);
  assert.equal(lib.readSession('audit-parallel').auditSliceQuota,10);
});
await test('parallel audit reads atomically consume a shared budget without lost decrements',async()=>{
  fillReads('audit-read-parallel',{auditSliceQuota:6});
  const out=await Promise.all(files.slice(3).map(file=>concurrent('guard-read-file.mjs',read('audit-read-parallel',file))));
  assert.equal(lib.readSession('audit-read-parallel').auditSliceQuota,0);
  assert.equal(out.filter(item=>decision(item)==='allow').length,6);
  assert.equal(out.filter(item=>decision(item)==='deny').length,3);
  assert.equal(lib.readSession('audit-read-parallel').readsSinceDispatch.length,3);
});
await test('child and parent retain the latest ten masked admitted commands with timestamps',()=>{
  hook('guard-subagent.mjs',dispatch('command-parent'));
  for(let i=0;i<12;i++)assert.equal(decision(hook('guard-command.mjs',command('command-child','node check.js token=hidden-'+i+' api_key="quoted secret" --case '+i,{parentConversationId:'command-parent'}))),'allow');
  for(const id of ['command-child','command-parent']) {
    const rows=lib.readSession(id).subagentCommands;
    assert.equal(rows.length,10);assert(rows[0].command.endsWith('--case 2'));assert(rows[9].command.endsWith('--case 11'));
    assert(!JSON.stringify(rows).includes('hidden-'));assert(!JSON.stringify(rows).includes('quoted secret'));
    assert(rows.every(row=>row.status==='allowed' && Number.isFinite(row.ts) && row.auditBatchId===lib.readSession('command-parent').auditBatchId));
  }
});
await test('parent summary combines children, supports caller context, and keeps older children tied to their batch',()=>{
  hook('guard-command.mjs',command('command-child-two','npm test',{callerContext:{parentConversationId:'command-parent'}}));
  assert(lib.readSession('command-parent').subagentCommands.some(row=>row.conversationId==='command-child-two'));
  const oldBatch=lib.readSession('command-child').auditBatchId;
  hook('guard-subagent.mjs',dispatch('command-parent','self',{turnId:'new-command-turn'}));
  hook('guard-command.mjs',command('command-child','node old-child-check.js',{parentConversationId:'command-parent'}));
  const latest=lib.readSession('command-parent').subagentCommands.at(-1);
  assert.equal(latest.auditBatchId,oldBatch);
  assert.notEqual(latest.auditBatchId,lib.readSession('command-parent').auditBatchId);
});
await test('contract-only child and cached parent sessions can record commands without explicit parent metadata',()=>{
  hook('guard-command.mjs',command('solo-child','node --test check.js',{transcriptPath:'',lastUserInput:'[FLASH-WORKER] check'}));
  assert.equal(lib.readSession('solo-child').subagentCommands.length,1);
  seed('cached-child',{isSubAgent:true,subagentEvidence:'parent',parentConversationId:'cached-parent'});
  hook('guard-command.mjs',command('cached-child','node --test check.js',{transcriptPath:'',lastUserInput:'continue'}));
  assert.equal(lib.readSession('cached-parent').subagentCommands.length,1);
});
await test('main and denied child commands never count as child test evidence',()=>{
  hook('guard-command.mjs',command('no-evidence','node --test check.js'));
  assert.equal(lib.readSession('no-evidence').subagentCommands.length,0);
  const text='Set-Content "'+path.join(STATE,'mode.json')+'" "{}"';
  assert.equal(decision(hook('guard-command.mjs',command('denied-child',text,{parentConversationId:'no-evidence'}))),'deny');
  assert.equal(lib.readSession('denied-child').subagentCommands.length,0);
  assert.equal(lib.readSession('no-evidence').subagentCommands.length,0);
});
await test('parallel children append parent command summaries without overwriting each other',async()=>{
  hook('guard-subagent.mjs',dispatch('parallel-command-parent'));
  await Promise.all(Array.from({length:8},(_,i)=>concurrent('guard-command.mjs',command('parallel-child-'+i,'node check-'+i+'.js',{parentConversationId:'parallel-command-parent'}))));
  assert.equal(lib.readSession('parallel-command-parent').subagentCommands.length,8);
  assert.equal(new Set(lib.readSession('parallel-command-parent').subagentCommands.map(row=>row.conversationId)).size,8);
});
await test('command tracking lock failure stays visible without inventing execution evidence',()=>{
  hook('guard-subagent.mjs',dispatch('record-lock-parent'));
  const lockFile=convFile('record-lock-parent').replace(/\.json$/,'.lock');
  fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,token:'held-by-test'}));
  try {
    assert.equal(decision(hook('guard-command.mjs',command('record-lock-child','node --test actual.js',{parentConversationId:'record-lock-parent'}))),'allow');
  } finally {fs.unlinkSync(lockFile);}
  assert.equal(lib.readSession('record-lock-child').subagentCommands.length,1);
  assert.equal(lib.readSession('record-lock-parent').subagentCommands.length,0);
  const logs=fs.readFileSync(lib.LOG_FILE,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(logs.some(row=>row.action==='command-record-failed' && row.recorded===false));
});
await test('audit reminders are gentle, once per batch, and ignore old command evidence',()=>{
  hook('guard-subagent.mjs',dispatch('reminder'));
  const out=hook('pre-invocation.mjs',base('reminder'));
  assert(messages(out).includes('终审提示'));assert(messages(out).includes('不能证明测试通过'));
  assert.equal(lib.readSession('reminder').auditSliceQuota,2);
  assert(!messages(hook('pre-invocation.mjs',base('reminder'))).includes('终审提示'));
  hook('guard-subagent.mjs',dispatch('reminder','self',{turnId:'next'}));
  lib.updateSession('reminder',state=>{state.subagentCommands=[{auditBatchId:'old',command:'npm test',ts:Date.now()}];});
  assert(messages(hook('pre-invocation.mjs',base('reminder',{turnId:'next'}))).includes('终审提示'));
});
await test('current child command evidence suppresses missing-evidence audit reminders',()=>{
  hook('guard-subagent.mjs',dispatch('evidence-reminder'));
  hook('guard-command.mjs',command('evidence-worker','npm test',{parentConversationId:'evidence-reminder'}));
  assert(!messages(hook('pre-invocation.mjs',base('evidence-reminder'))).includes('终审提示'));
});
await test('Lite and audit suppress quantity drift, and Lite session cards describe the exemption',()=>{
  const file=path.join(TMP,'planner.jsonl');
  fs.writeFileSync(file,Array.from({length:12},(_,i)=>JSON.stringify({source:'MODEL',step_index:i,tool_calls:[{name:'write_file'}]})).join('\n')+'\n');
  seed('lite-drift',{lastUserInput:'implement modules',readsSinceDispatch:files.slice(0,5),writesSinceDispatch:files.slice(0,5)});
  const out=hook('pre-invocation.mjs',base('lite-drift',{modelName:'Orchestrator (Argon)',transcriptPath:file}));
  assert(!messages(out).includes('漂移提醒'));assert(!messages(out).includes('轮次唤醒'));
  const card=hook('session-start.mjs',base('lite-card',{modelName:'Orchestrator (Argon)'}));
  assert(card.injectSteps[0].systemMessage.renderInfo.markdown.includes('Lite Guard Mode'));
  assert(card.injectSteps[0].systemMessage.renderInfo.markdown.includes('豁免文件数量拦截'));
});
await test('cross-platform dispatch output preserves task-specific models and the contract',()=>{
  for(const harness of ['claude','codex'])for(const type of ['research','self']) {
    const out=hook('guard-subagent.mjs',{hook_event_name:'PreToolUse',session_id:'routing-'+harness+'-'+type,
      model:harness==='claude'?'claude-opus':'gpt-5',cwd:WORKSPACE,tool_name:harness==='claude'?'Agent':'spawn_agent',
      tool_input:{subagent_type:type,model:'inherit',prompt:'bounded task'}},
      {PRO_HARNESS:harness,PRO_WORKER_MODEL:'common',PRO_RESEARCH_MODEL:'hydrogen',PRO_SELF_MODEL:'flash'});
    assert.equal(out.hookSpecificOutput.updatedInput.model,type==='research'?'hydrogen':'flash');
    assert(out.hookSpecificOutput.updatedInput.prompt.includes('[PRO-CONTRACT]'));
  }
});
await test('Claude offset/limit audit reads consume the same explicit slice quota',()=>{
  fillReads('claude-audit');
  const out=hook('guard-read-file.mjs',{hook_event_name:'PreToolUse',session_id:'claude-audit',model:'claude-opus',
    tool_name:'Read',tool_input:{file_path:files[10],offset:21,limit:80},lastUserInput:'implement modules'});
  assert.equal(decision(out),'allow');assert.equal(lib.readSession('claude-audit').auditSliceQuota,1);
});
const control=path.join(process.env.CODEX_HOME,'plugin-data','pro-flash-orchestrator');
fs.mkdirSync(control,{recursive:true});
fs.writeFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
function native(event,extra={},env={}) {
  return hook('codex-hook.mjs',{hook_event_name:event,session_id:'native-audit',model:'gpt-6.1-sol',cwd:WORKSPACE,...extra},env);
}
function proof(model) {
  fs.mkdirSync(STATE,{recursive:true});
  fs.writeFileSync(path.join(STATE,'worker-verification.json'),JSON.stringify({status:'verified',workerModel:model,workerReasoningEffort:'low',providerFingerprint:runtime.providerIdentity(WORKSPACE).fingerprint}));
}
await test('native Codex honors task models without bypassing exact provider verification',()=>{
  const lite=messages(native('SessionStart',{}, {PRO_NATIVE_ORCHESTRATOR:'1'}));
  assert(lite.includes('Lite Guard Mode'));assert(!lite.includes('up to two benchmark edits'));
  proof('gpt-5-mini');
  native('UserPromptSubmit',{session_id:'native-routing',prompt:'bounded task'});
  const payload={session_id:'native-routing',tool_name:'spawn_agent',tool_input:{agent_type:'research',message:'inspect',task_name:'research'}};
  assert.equal(decision(native('PreToolUse',payload,{PRO_RESEARCH_MODEL:'hydrogen'})),'deny');
  proof('hydrogen');
  assert.equal(native('PreToolUse',payload,{PRO_RESEARCH_MODEL:'hydrogen'}).hookSpecificOutput.updatedInput.model,'hydrogen');
  native('SubagentStart',{session_id:'native-routing',agent_id:'research-child',agent_type:'research',model:'hydrogen'},{PRO_RESEARCH_MODEL:'hydrogen'});
  assert.equal(decision(native('PreToolUse',{session_id:'native-routing',agent_id:'research-child',model:'hydrogen',tool_name:'exec_command',tool_input:{cmd:'node --test check.js'}},{PRO_RESEARCH_MODEL:'hydrogen'})),'allow');
  proof('flash');
  assert.equal(native('PreToolUse',{session_id:'native-self-routing',tool_name:'spawn_agent',tool_input:{message:'work'}},{PRO_SELF_MODEL:'flash'}).hookSpecificOutput.updatedInput.model,'flash');
  proof('gpt-5-mini');
});
await test('native Codex audit lifecycle records child commands and resets quota on new user turns',()=>{
  native('UserPromptSubmit',{prompt:'implement modules',turn_id:'audit-one'});
  const out=native('PreToolUse',{turn_id:'audit-one',tool_name:'spawn_agent',tool_input:{message:'work'}});
  assert.equal(decision(out),'allow');assert.equal(lib.readSession('native-audit').auditSliceQuota,2);
  native('SubagentStart',{agent_id:'native-child',model:'gpt-5-mini'});
  native('PreToolUse',{agent_id:'native-child',model:'gpt-5-mini',tool_name:'exec_command',tool_input:{cmd:'node --test child.js'}});
  assert.equal(lib.readSession('native-audit').subagentCommands.length,1);
  assert.equal(lib.readSession('native-audit:sub:native-child').subagentCommands.length,1);
  assert(!messages(native('SubagentStop',{agent_id:'native-child',model:'gpt-5-mini'})).includes('终审提示'));
  native('UserPromptSubmit',{prompt:'same task next turn',turn_id:'audit-two'});
  assert.equal(lib.readSession('native-audit').phase,'explore');assert.equal(lib.readSession('native-audit').auditSliceQuota,0);
});
await test('native Codex stop hook emits audit reminder for a child with no command record',()=>{
  native('UserPromptSubmit',{session_id:'native-no-command',prompt:'work'});
  native('PreToolUse',{session_id:'native-no-command',tool_name:'spawn_agent',tool_input:{message:'work'}});
  native('SubagentStart',{session_id:'native-no-command',agent_id:'no-command-child',model:'gpt-5-mini'});
  assert(messages(native('SubagentStop',{session_id:'native-no-command',agent_id:'no-command-child',model:'gpt-5-mini'})).includes('终审提示'));
});
} finally {
  if(path.dirname(TMP)!==path.resolve(os.tmpdir()) || !path.basename(TMP).startsWith('pfo-v060-'))throw new Error('Unsafe test cleanup target');
  fs.rmSync(TMP,{recursive:true,force:true});
}
console.log('\nv0.6.1 results: '+passed+' passed, '+failures.length+' failed');
process.exitCode=failures.length?1:0;
