#!/usr/bin/env node
/** AGY capability routing regressions. Probes are mocked; all state is isolated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-capabilities-'));
const STATE = path.join(TMP, 'state');
const WORKSPACE = path.join(TMP, 'workspace');
fs.mkdirSync(WORKSPACE);
for (const key of ['PRO_TEST','ARGON_TEST','PRO_HARNESS','PRO_WORKER_MODEL','PRO_RESEARCH_MODEL','PRO_SELF_MODEL','PRO_HYDROGEN_ID','PRO_NATIVE_ORCHESTRATOR']) process.env[key] = '';
process.env.PRO_STATE_DIR = STATE;
process.env.PRO_MODE = 'enforce';
process.env.CODEX_HOME = path.join(TMP, 'codex-home');
let calls = [];
let probe = () => JSON.stringify(['gemini-4-hydrogen', 'argon', 'gemini-3.8-flash']);
const originalExec = cp.execFileSync;
cp.execFileSync = (...args) => { calls.push(args); return probe(...args); };
syncBuiltinESMExports();
const lib = await import('./lib.mjs');
const main = path.join(TMP, 'main.jsonl');
fs.writeFileSync(main, Array.from({length:12}, (_,i) => JSON.stringify({source:i===0?'USER_EXPLICIT':'MODEL',content:'task',step_index:i})).join('\n')+'\n');
const files = Array.from({length:12}, (_,i) => path.join(WORKSPACE,'unit-'+i+'.js'));
files.forEach(file => fs.writeFileSync(file,'// fixture\n'.repeat(200)));
const base = (id, extra={}) => ({conversationId:id,modelName:'Argon',transcriptPath:main,workspacePaths:[WORKSPACE],lastUserInput:'work',...extra});
const read = (id,index,extra={}) => base(id,{toolCall:{name:'view_file',args:{Path:files[index],StartLine:1,EndLine:40}},...extra});
const write = (id,index,extra={}) => base(id,{toolCall:{name:'edit_file',args:{Path:files[index]}},...extra});
const dispatch = (id,extra={}) => base(id,{toolCall:{name:'invoke_subagent',args:{TypeName:'self',Model:'inherit',Prompt:'bounded work'}},...extra});
const capabilities = (data={}) => ({detectedAt:Date.now(),agyPpid:process.ppid,hasHydrogen:true,hasArgon:true,hasCarbon:false,hasFlash:true,availableModels:['hydrogen','argon','flash'],cliProbeSucceeded:true,...data});
const cache = data => {fs.mkdirSync(STATE,{recursive:true});fs.writeFileSync(lib.CAPABILITIES_FILE,JSON.stringify(capabilities(data)));};
const clear = () => {fs.rmSync(STATE,{recursive:true,force:true});calls=[];probe=()=>JSON.stringify(['hydrogen','argon','flash']);};
const sessions = (id,data) => lib.writeSession(id,data);
const message = out => JSON.stringify(out);
const decision = out => out.decision || out.hookSpecificOutput?.permissionDecision || 'allow';
const telemetry = path.join(TMP,'probe-calls.jsonl');
const shim = path.join(TMP,'mock-probe.mjs');
fs.writeFileSync(shim,
  "import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';\n"+
  "cp.execFileSync=(...args)=>{fs.appendFileSync(process.env.PROBE_TELEMETRY,JSON.stringify(args)+'\\n');if(process.env.PROBE_FAIL==='1')throw Object.assign(new Error('missing CLI'),{code:'ENOENT'});return process.env.PROBE_MODELS;};syncBuiltinESMExports();\n");
function hook(script,payload,env={}) {
  const result=cp.spawnSync(process.execPath,['--import',pathToFileURL(shim).href,path.join(ROOT,'scripts',script)],{
    input:JSON.stringify(payload),encoding:'utf8',cwd:ROOT,timeout:10000,windowsHide:true,
    env:{...process.env,PROBE_TELEMETRY:telemetry,PROBE_MODELS:'["hydrogen","argon","flash"]',...env},
  });
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
const probeCount = () => fs.existsSync(telemetry) ? fs.readFileSync(telemetry,'utf8').trim().split('\n').filter(Boolean).length : 0;
let passed=0;const failures=[];
async function test(name,fn) {
  clear();fs.rmSync(telemetry,{force:true});
  try {await fn();passed++;console.log('PASS '+name);} catch(error) {failures.push(name);console.error('FAIL '+name+': '+error.stack);}
}
try {

await test('concurrent AGY starts share one locked probe and a complete cache',async()=>{
  const runs=Array.from({length:4},(_,i)=>new Promise((resolve,reject)=>{
    const child=cp.spawn(process.execPath,['--import',pathToFileURL(shim).href,path.join(ROOT,'scripts/session-start.mjs')],{
      cwd:ROOT,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PROBE_TELEMETRY:telemetry,PROBE_MODELS:'["hydrogen","argon","flash"]'},
    });
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.once('error',reject);child.once('exit',code=>{try{assert.equal(code,0,stderr);assert.match(JSON.stringify(JSON.parse(stdout)),/hydrogen-worker/);resolve();}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify(base('parallel-start-'+i)));
  }));
  await Promise.all(runs);assert.equal(probeCount(),1);assert.equal(JSON.parse(fs.readFileSync(lib.CAPABILITIES_FILE,'utf8')).hasHydrogen,true);
});
await test('Windows command-shim fallback is fixed and timeout remains bounded',()=>{
  if(process.platform!=='win32')return;
  probe=(command)=>{if(command==='agy')throw Object.assign(new Error('cmd shim'),{code:'ENOENT'});return '["hydrogen"]';};
  assert(lib.detectModelCapabilities(base('windows-shim')).hasHydrogen);
  assert.equal(calls.length,2);assert.deepEqual(calls[1][1],['/d','/s','/c','agy.cmd models']);assert(calls[1][2].timeout>0&&calls[1][2].timeout<=2500);
  calls=[];probe=()=>{throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});};lib.detectModelCapabilities(base('windows-timeout'),true);assert.equal(calls.length,1);
});

await test('capabilities path belongs to isolated STATE_DIR',()=>assert.equal(lib.CAPABILITIES_FILE,path.join(STATE,'capabilities.json')));
await test('missing cache gives read-only payload inference without launching CLI',()=>{
  assert.equal(lib.readCapabilities(base('inference')).hasHydrogen,true);
  assert.equal(lib.readCapabilities({model:'Flash'}).strategy,'flash-main-relaxed');
  assert.equal(calls.length,0);assert(!fs.existsSync(STATE));
});
await test('same AGY parent reuses a cache younger than twelve hours',()=>{
  cache({detectedAt:Date.now()-11*3600000});lib.detectModelCapabilities(base('same-parent'));assert.equal(calls.length,0);
});
await test('another parent reuses a cache younger than one hour',()=>{
  cache({agyPpid:process.ppid+1,detectedAt:Date.now()-30*60000});lib.detectModelCapabilities(base('other-parent'));assert.equal(calls.length,0);
});
await test('same parent twelve-hour expiry probes again',()=>{
  cache({detectedAt:Date.now()-12*3600000-1});lib.detectModelCapabilities(base('expired'));assert(calls.length>0);
});
await test('different parent one-hour expiry probes again',()=>{
  cache({agyPpid:process.ppid+1,detectedAt:Date.now()-3600001});lib.detectModelCapabilities(base('expired-parent'));assert(calls.length>0);
});
await test('future or malformed timestamps do not prevent startup refresh',()=>{
  for(const detectedAt of [Date.now()+3600000,'bad']){calls=[];cache({detectedAt});lib.detectModelCapabilities(base('invalid-age'));assert(calls.length>0);}
});
await test('force refresh bypasses a reusable cache',()=>{
  cache();lib.detectModelCapabilities(base('force'),true);assert.equal(calls.length,1);
});
await test('damaged cache recovers and probe is timeout bounded',()=>{
  fs.mkdirSync(STATE,{recursive:true});fs.writeFileSync(lib.CAPABILITIES_FILE,'{broken');
  const result=lib.detectModelCapabilities(base('broken'));
  assert.equal(result.hasHydrogen,true);assert.equal(result.source,'cli');
  assert.equal(calls[0][0],'agy');assert.deepEqual(calls[0][1],['models']);assert.equal(calls[0][2].timeout,2500);
  assert.deepEqual(calls[0][2].stdio,['ignore','pipe','ignore']);assert.equal(calls[0][2].encoding,'utf8');
});
await test('CLI JSON object rows filter unavailable entitlements',()=>{
  probe=()=>JSON.stringify({models:[{id:'gemini-4-hydrogen',available:true},{name:'Argon'},{id:'Carbon',entitled:false},{modelId:'gemini-3.8-flash'},{id:'Carbon',enabled:false}]});
  const result=lib.detectModelCapabilities(base('json'));
  assert(result.hasHydrogen);assert(result.hasArgon);assert(result.hasFlash);assert.equal(result.hasCarbon,false);
  assert.deepEqual(result.availableModels,['gemini-4-hydrogen','Argon','gemini-3.8-flash']);
});
await test('availableModels lists and ANSI text model lists are parsed',()=>{
  for(const text of [JSON.stringify({availableModels:['hydrogen','carbon']}),'\x1b[32mhydrogen\x1b[0m available\ncarbon available\nargon denied\nflash unavailable']){
    probe=()=>text;const result=lib.detectModelCapabilities(base('text'),true);
    assert(result.hasHydrogen);assert(result.hasCarbon);assert.equal(result.hasArgon,false);assert.equal(result.hasFlash,false);
  }
});
await test('Hydrogen ACL uses legal flash by default and supports an explicit host-specific ID',()=>{
  cache();assert.equal(lib.targetWorkerModel('antigravity','self',base('worker')),'flash');
  process.env.PRO_HYDROGEN_ID='gemini-4-hydrogen';assert.equal(lib.targetWorkerModel('antigravity','self',base('worker')),'gemini-4-hydrogen');
  process.env.PRO_HYDROGEN_ID='flash';assert.equal(lib.targetWorkerModel('antigravity','self',base('worker')),'flash');process.env.PRO_HYDROGEN_ID='';
});
await test('Hydrogen mains inherit under either model field even with an explicit cached ACL denial',()=>{
  for(const hasHydrogen of [true,false]) {
    cache({hasHydrogen});
    for(const model of [{modelName:'Gemini 4 Hydrogen'},{model:'GEMINI 4 HYDROGEN'}]) {
      const payload=base('hydrogen-main',{modelName:'',...model});
      assert.equal(lib.readCapabilities(payload).strategy,'hydrogen-main');
      for(const type of ['research','self'])assert.equal(lib.targetWorkerModel('antigravity',type,payload),'inherit');
    }
  }
  assert.equal(calls.length,0);
});
await test('Hydrogen child evidence and other harnesses never receive hydrogen-main strategy',()=>{
  const workerTranscript=path.join(TMP,'hydrogen-child.jsonl');
  fs.writeFileSync(workerTranscript,JSON.stringify({source:'SYSTEM',content:'[Message] sender=parent work'})+'\n');
  cache();
  for(const extra of [{parentConversationId:'parent'},{is_subagent:true},{lastUserInput:'[FLASH-WORKER] task'},
    {transcriptPath:workerTranscript},{_harness:'codex'},{_harness:'claude'}]) {
    assert.notEqual(lib.readCapabilities(base('hydrogen-child',{modelName:'Gemini 4 Hydrogen',transcriptPath:'',...extra})).strategy,'hydrogen-main');
  }
  assert.equal(calls.length,0);
  assert(!fs.existsSync(lib.SESSION_DIR),'capability readers must not persist identity');
});
await test('ordinary AGY dispatches satisfy the host Model enum and Hydrogen inherits',()=>{
  const allowed=new Set(['inherit','flash_lite','flash','pro']);
  cache();
  for(const [index,modelName] of ['Argon','Carbon','Opus','Gemini 3.8 Flash','Gemini 4 Hydrogen'].entries()) {
    for(const type of ['research','self']) {
      const args={TypeName:type,Model:'hydrogen',Prompt:'bounded task'};
      const out=hook('guard-subagent.mjs',base('enum-'+index+'-'+type,{modelName,toolCall:{name:'invoke_subagent',args}}));
      const effective={...args,...out.overwrite};
      assert(allowed.has(effective.Model),modelName+': '+effective.Model);
      assert.equal(effective.Model,/hydrogen/i.test(modelName)?'inherit':'flash');
      assert(effective.Prompt.includes('[PRO-CONTRACT]'));
    }
  }
});
await test('native Orchestrator preserves its own model routing and only injects the contract',()=>{
  cache();
  for(const [index,extra] of [{modelName:'Orchestrator (Argon)'},{modelName:'Argon',model:'ORCHESTRATOR'},
    {modelName:'Argon'}].entries()) {
    for(const [modelIndex,Model] of ['inherit','hydrogen','gemini-4-hydrogen','pro',undefined].entries()) {
      const args={TypeName:'self',...(Model===undefined?{}:{Model}),Prompt:'bounded native work'};
      const env=index===2?{PRO_NATIVE_ORCHESTRATOR:'1'}:{};
      const out=hook('guard-subagent.mjs',base('native-route-'+index+'-'+modelIndex,{...extra,toolCall:{name:'invoke_subagent',args}}),env);
      assert.equal(decision(out),'allow');
      assert.deepEqual(Object.keys(out.overwrite),['Prompt']);
      assert.equal(({...args,...out.overwrite}).Model,Model);
      assert(out.overwrite.Prompt.includes('[PRO-CONTRACT]'));
      const again=hook('guard-subagent.mjs',base('native-route-'+index+'-'+modelIndex,
        {...extra,toolCall:{name:'invoke_subagent',args:{...args,...out.overwrite}}}),env);
      assert.equal(again.overwrite,undefined,'contract injection must be idempotent');
    }
  }
});
await test('explicit CLI denial overrides Argon inference and custom Hydrogen ID',()=>{
  probe=()=>JSON.stringify(['gemini-3.8-flash']);const result=lib.detectModelCapabilities(base('deny'));
  assert.equal(result.hasHydrogen,false);assert.equal(result.strategy,'flash-fallback');
  process.env.PRO_HYDROGEN_ID='gemini-4-hydrogen';assert.equal(lib.targetWorkerModel('antigravity','self',base('deny')),'flash');process.env.PRO_HYDROGEN_ID='';
});
await test('CLI failure infers Gemini 4 permissions from either model field',()=>{
  probe=()=>{throw Object.assign(new Error('CLI absent'),{code:'ENOENT'});};
  for(const model of ['Argon','Carbon','Hydrogen','Orchestrator (Argon)']){
    const result=lib.detectModelCapabilities({model},true);assert(result.hasHydrogen);assert.equal(result.cliProbeSucceeded,false);
  }
  assert.equal(lib.detectModelCapabilities({modelName:'Gemini 3.8 Flash'},true).hasHydrogen,false);
});
await test('later model evidence upgrades failed inference but preserves known CLI denial',()=>{
  cache({hasHydrogen:false,cliProbeSucceeded:false});assert(lib.readCapabilities({model:'Carbon'}).hasHydrogen);
  cache({hasHydrogen:false,cliProbeSucceeded:true});assert.equal(lib.readCapabilities({model:'Carbon'}).hasHydrogen,false);
});
await test('CLI outage retains the last successful ACL instead of inventing permission',()=>{
  cache({hasHydrogen:false,cliProbeSucceeded:true,detectedAt:0});probe=()=>{throw new Error('offline');};
  const result=lib.detectModelCapabilities({model:'Argon'});assert.equal(result.hasHydrogen,false);assert.equal(result.source,'cli-cache');
});
await test('strategy is recomputed for each main model when reusing shared cache',()=>{
  cache({strategy:'flash-main-relaxed'});assert.equal(lib.readCapabilities({modelName:'Argon'}).strategy,'hydrogen-worker');
  assert.equal(lib.readCapabilities({modelName:'Gemini 3.8 Flash'}).strategy,'flash-main-relaxed');assert.equal(calls.length,0);
});
await test('Flash children and other harnesses never receive relaxed strategy or startup probing',()=>{
  for(const payload of [{model:'Flash',parentConversationId:'parent'},{model:'Flash',is_subagent:true},{model:'Flash',lastUserInput:'[FLASH-WORKER] task'},{model:'Flash',_harness:'codex'},{model:'Flash',_harness:'claude'}]){
    assert.notEqual(lib.readCapabilities(payload).strategy,'flash-main-relaxed');lib.detectModelCapabilities(payload);assert.equal(calls.length,0);
  }
});
await test('task and common overrides preserve priority across harnesses',()=>{
  cache();process.env.PRO_WORKER_MODEL='common';process.env.PRO_RESEARCH_MODEL='research';process.env.PRO_SELF_MODEL='self';
  try {for(const harness of ['antigravity','codex','claude']){assert.equal(lib.targetWorkerModel(harness,'research'),'research');assert.equal(lib.targetWorkerModel(harness,'self'),'self');assert.equal(lib.targetWorkerModel(harness),'common');}}
  finally {for(const key of ['PRO_WORKER_MODEL','PRO_RESEARCH_MODEL','PRO_SELF_MODEL'])process.env[key]='';}
  assert.equal(lib.targetWorkerModel('codex'),'gpt-5-mini');assert.equal(lib.targetWorkerModel('claude'),'haiku');
});
await test('Flash main can read six files and the seventh is denied',()=>{
  for(let i=0;i<6;i++)assert.equal(decision(hook('guard-read-file.mjs',read('flash-reads',i,{modelName:'Gemini 3.8 Flash'}))),'allow');
  assert.equal(decision(hook('guard-read-file.mjs',read('flash-reads',6,{modelName:'Gemini 3.8 Flash'}))),'deny');
  assert.equal(lib.readSession('flash-reads').maxReadsAllowed,6);
});
await test('Flash main can write four files and the fifth is denied',()=>{
  for(let i=0;i<4;i++)assert.equal(decision(hook('guard-write-file.mjs',write('flash-writes',i,{model:'Flash',modelName:''}))),'allow');
  const out=hook('guard-write-file.mjs',write('flash-writes',4,{model:'Flash',modelName:''}));assert.equal(decision(out),'deny');assert.match(message(out),/超过 4/);
});
await test('heavy main retains three reads and two writes without startup dependency',()=>{
  for(let i=0;i<3;i++)assert.equal(decision(hook('guard-read-file.mjs',read('heavy',i))),'allow');
  const denied=hook('guard-read-file.mjs',read('heavy',3));assert.equal(decision(denied),'deny');assert.match(message(denied),/Model=\\"flash\\"/);
  for(let i=0;i<2;i++)assert.equal(decision(hook('guard-write-file.mjs',write('heavy',i))),'allow');
  assert.equal(decision(hook('guard-write-file.mjs',write('heavy',2))),'deny');
});
await test('new Flash turn resets read quota to six and preserves the write limit',()=>{
  sessions('turn',{maxReadsAllowed:3,phase:'audit',auditSliceQuota:8,lastUserInput:'old'});
  hook('pre-invocation.mjs',base('turn',{modelName:'Flash',lastUserInput:'new',turnId:'new'}));
  const state=lib.readSession('turn');assert.equal(state.maxReadsAllowed,6);assert.equal(state.auditSliceQuota,0);assert.equal(state.phase,'explore');
});
await test('read guard itself resets stale turn quota using current strategy',()=>{
  sessions('reset',{maxReadsAllowed:3,lastUserInput:'old',lastReadUserInput:'old',lastSpawnUserInput:'old',readsSinceDispatch:files.slice(0,3)});
  hook('guard-read-file.mjs',read('reset',3,{modelName:'Flash',lastUserInput:'new'}));assert.equal(lib.readSession('reset').maxReadsAllowed,6);
});
await test('switching Flash main to heavy restores the ordinary quota',()=>{
  sessions('switch',{strategy:'flash-main-relaxed',maxReadsAllowed:6,phase:'explore',lastUserInput:'work'});
  hook('guard-read-file.mjs',read('switch',0));assert.equal(lib.readSession('switch').maxReadsAllowed,3);
});
await test('relaxed dispatch retains six reads and mints two audit slices',()=>{
  const out=hook('guard-subagent.mjs',dispatch('flash-dispatch',{modelName:'Flash'}));assert.equal(out.overwrite.Model,'flash');
  const state=lib.readSession('flash-dispatch');assert.equal(state.maxReadsAllowed,6);assert.equal(state.auditSliceQuota,2);assert.equal(state.phase,'audit');
});
await test('ACL availability does not emit an unsupported default Model value',()=>{
  for(const hasHydrogen of [true,false]){cache({hasHydrogen});const out=hook('guard-subagent.mjs',dispatch('route-'+hasHydrogen));assert.equal(out.overwrite.Model,'flash');assert(out.overwrite.Prompt.includes('[PRO-CONTRACT]'));}
});
await test('startup runs one probe then reuses it for another session',()=>{
  const out=hook('session-start.mjs',base('start-one'));assert.match(message(out),/hydrogen-worker/);assert.match(message(out),/Model=\\"flash\\"/);assert.equal(probeCount(),1);
  hook('session-start.mjs',base('start-two'));assert.equal(probeCount(),1);
});
await test('Hydrogen startup cards show hydrogen-main and legal inherited research/self routes',()=>{
  const out=hook('session-start.mjs',base('start-hydrogen',{modelName:'Gemini 4 Hydrogen'}));
  assert.match(message(out),/hydrogen-main/);
  assert.match(message(out),/Model=\\"inherit\\"/);
  assert(!message(out).includes('Model=\\"hydrogen\\"'));
  assert.equal(lib.readSession('start-hydrogen').strategy,'hydrogen-main');
});
await test('startup fallback and relaxed cards match effective Worker and limits',()=>{
  const out=hook('session-start.mjs',base('start-fallback'),{PROBE_MODELS:'["gemini-3.8-flash"]'});assert.match(message(out),/flash-fallback/);assert.match(message(out),/Model=\\"flash\\"/);
  const relaxed=hook('session-start.mjs',base('start-relaxed',{modelName:'Flash'}));assert.match(message(relaxed),/flash-main-relaxed/);assert.match(message(relaxed),/最多 4/);assert.match(message(relaxed),/最多 6/);assert.equal(lib.readSession('start-relaxed').maxReadsAllowed,6);
});
await test('startup honors research and self overrides in injected parameters',()=>{
  cache();const out=hook('session-start.mjs',base('overrides'),{PRO_RESEARCH_MODEL:'flash',PRO_SELF_MODEL:'custom-hydrogen'});assert.match(message(out),/custom-hydrogen/);assert.match(message(out),/Model=\\"flash\\"/);assert.equal(probeCount(),0);
});
await test('disabled, child, Claude and Codex starts never run AGY probes',()=>{
  hook('session-start.mjs',base('off'),{PRO_MODE:'off'});
  hook('session-start.mjs',base('child',{parentConversationId:'parent'}));
  hook('session-start.mjs',{session_id:'claude',model:'sonnet',hook_event_name:'SessionStart'},{PRO_HARNESS:'claude'});
  hook('session-start.mjs',{session_id:'codex',model:'gpt-6',hook_event_name:'SessionStart'},{PRO_HARNESS:'codex'});
  assert.equal(probeCount(),0);assert(!fs.existsSync(lib.CAPABILITIES_FILE));
});
await test('PreInvocation and all PreToolUse guards never probe even without cache',()=>{
  hook('pre-invocation.mjs',base('readonly',{invocationNum:1}));
  hook('guard-read-file.mjs',read('readonly',0));hook('guard-write-file.mjs',write('readonly',0));
  hook('guard-subagent.mjs',dispatch('readonly'));
  hook('guard-command.mjs',base('readonly',{toolCall:{name:'run_command',args:{CommandLine:'node --version'}}}));
  assert.equal(probeCount(),0);assert(!fs.existsSync(lib.CAPABILITIES_FILE));
});
await test('Flash within allowed read and write limits receives no drift demand',()=>{
  sessions('no-drift',{strategy:'flash-main-relaxed',lastUserInput:'work',readsSinceDispatch:files.slice(0,6),writesSinceDispatch:files.slice(0,4)});
  const out=hook('pre-invocation.mjs',base('no-drift',{modelName:'Flash'}));assert(!message(out).includes('漂移提醒'));
});
await test('heavy wakeups show effective route while Flash wakeups explain six and four',()=>{
  cache();assert.match(message(hook('pre-invocation.mjs',base('wake-heavy'))),/Model=\\"flash\\"/);
  const relaxed=message(hook('pre-invocation.mjs',base('wake-flash',{modelName:'Flash'})));assert.match(relaxed,/6 个文件/);assert.match(relaxed,/4 个文件/);
});
await test('Audit slices and native Lite bypass remain valid under capability routing',()=>{
  cache();hook('guard-subagent.mjs',dispatch('audit'));
  for(let i=0;i<5;i++)assert.equal(decision(hook('guard-read-file.mjs',read('audit',i))),'allow');
  assert.equal(lib.readSession('audit').auditSliceQuota,0);
  for(let i=0;i<7;i++)assert.equal(decision(hook('guard-write-file.mjs',write('lite',i,{modelName:'Orchestrator (Argon)'}))),'allow');
});
} finally {
  cp.execFileSync=originalExec;syncBuiltinESMExports();fs.rmSync(TMP,{recursive:true,force:true});
}
console.log('\nCapability results: '+passed+' passed, '+failures.length+' failed');
if(failures.length)process.exitCode=1;
