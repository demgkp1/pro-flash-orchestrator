#!/usr/bin/env node
/** Standalone local-marketplace setup. Native trust is never changed here. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {codexHome,readJson,writeJson,workerConfig,verificationStatus,providerIdentity,redact} from './codex-runtime.mjs';
import {inspectNative} from './codex-app-server.mjs';
export const CONTROL_DIR=path.join(codexHome(),'plugin-data','pro-flash-orchestrator');
const BRIDGE='PFO_NATIVE_BRIDGE';
export function nativeCommand(args,{cwd=process.cwd(),timeout=60000}={}) {
  const r=spawnSync(process.env.PFO_CODEX_BIN || 'codex',args,{cwd,encoding:'utf8',timeout,windowsHide:true,maxBuffer:16*1024*1024});
  if(r.error || r.status!==0)throw new Error(redact(r.error?.message || r.stderr || r.stdout || 'Codex command failed').slice(0,1500));
  return r.stdout;
}
function runtimeHash(root) {
  const list=[];
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,e.name);
    if(e.isSymbolicLink())throw new Error('Plugin files cannot be symbolic links');
    if(e.isDirectory())walk(file);else if(e.isFile())list.push(file);
  }}
  walk(root);const h=crypto.createHash('sha256');
  for(const file of list.sort()){h.update(path.relative(root,file));h.update(fs.readFileSync(file));}
  return h.digest('hex');
}
export function connectNativeHooks(pluginRoot,{remove=false,hookFile=path.join(codexHome(),'hooks.json')}={}) {
  const original=readJson(hookFile,{hooks:{}});
  if(!original || typeof original!=='object' || !original.hooks || typeof original.hooks!=='object' || Array.isArray(original.hooks))throw new Error('Cannot safely merge existing Codex hooks.json');
  const next=structuredClone(original);
  for(const [event,groups] of Object.entries(next.hooks)){
    if(!Array.isArray(groups))throw new Error('Invalid existing hook event: '+event);
    next.hooks[event]=groups.map(g=>({...g,hooks:(g.hooks || []).filter(h=>!String(h.command || h.commandWindows || '').includes(BRIDGE))})).filter(g=>g.hooks.length);
    if(!next.hooks[event].length)delete next.hooks[event];
  }
  if(!remove) {
    const template=JSON.parse(fs.readFileSync(path.join(pluginRoot,'hooks/hooks.json'),'utf8'));
    const encoded=Buffer.from(path.resolve(pluginRoot)).toString('base64');
    const hash=runtimeHash(pluginRoot);
    const code='/* '+BRIDGE+' '+hash+' */ process.env.PFO_HOOK_SOURCE="user";process.env.PLUGIN_ROOT=Buffer.from("'+encoded+'","base64").toString("utf8");import(require("node:url").pathToFileURL(require("node:path").join(process.env.PLUGIN_ROOT,"scripts/codex-hook.mjs")).href)';
    const unix=code.replaceAll('"',"'");
    const psLiteral=v=>"'"+v.replaceAll("'","''")+"'";
    const windows='powershell.exe -NoProfile -Command "& '+psLiteral(process.execPath.replaceAll('\\','/'))+' -e '+psLiteral(unix)+'"';
    for(const [event,groups] of Object.entries(template.hooks)) {
      const generated=groups.map(g=>({...g,hooks:g.hooks.map(h=>({...h,command:'node -e "'+unix+'"',commandWindows:windows}))}));
      next.hooks[event]=[...(next.hooks[event] || []),...generated];
    }
  }
  const changed=JSON.stringify(original)!==JSON.stringify(next);
  if(changed) {
    if(fs.existsSync(hookFile)){
      const backup=path.join(CONTROL_DIR,'backups','hooks-'+Date.now()+'.json');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(hookFile,backup);
    }
    writeJson(hookFile,next);
  }
  return {changed,path:hookFile,source:remove?'removed':'native-user-hooks',requiresReview:changed&&!remove};
}
export async function registerMarketplace(target) {
  const root=path.resolve(target),pluginRoot=path.join(root,'plugins','pro-flash-orchestrator');
  nativeCommand(['plugin','marketplace','add',root,'--json']);
  nativeCommand(['plugin','add','pro-flash-orchestrator@pro-flash-local','--json']);
  fs.mkdirSync(CONTROL_DIR,{recursive:true});
  if(!fs.existsSync(path.join(CONTROL_DIR,'config.json')))writeJson(path.join(CONTROL_DIR,'config.json'),{workerModel:'gpt-5-mini',workerReasoningEffort:'low'});
  if(!fs.existsSync(path.join(CONTROL_DIR,'mode.json')))writeJson(path.join(CONTROL_DIR,'mode.json'),{mode:'enforce'});
  const native=await inspectNative({cwd:root});
  const bundled=native.hooks.filter(h=>h.source==='plugin');
  const wiring=connectNativeHooks(pluginRoot,{remove:bundled.length===6});
  writeJson(path.join(CONTROL_DIR,'deployment.json'),{target:root,registered:true,wiring,updatedAt:new Date().toISOString()});
  return {registered:true,wiring,next:'Review all Pro-Flash hooks in Settings > Hooks or /hooks, then start a new session.'};
}
export async function unregisterMarketplace(target) {
  const wiring=connectNativeHooks(path.join(target,'plugins','pro-flash-orchestrator'),{remove:true});
  nativeCommand(['plugin','remove','pro-flash-orchestrator@pro-flash-local']);
  nativeCommand(['plugin','marketplace','remove','pro-flash-local']);
  writeJson(path.join(CONTROL_DIR,'deployment.json'),{target,registered:false,uninstalledAt:new Date().toISOString()});
  return {uninstalled:true,wiring,preservedConfiguration:CONTROL_DIR,preservedSource:target};
}
function findSession(dir,id) {
  if(!fs.existsSync(dir))return '';
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isFile()&&e.name.endsWith('.jsonl')&&e.name.includes(id))return p;
    if(e.isDirectory()){const found=findSession(p,id);if(found)return found;}
  }
  return '';
}
export function verifyWorker({cwd=process.cwd(),controlDir=CONTROL_DIR,timeout=180000}={}) {
  const cfg=workerConfig(controlDir),identity=providerIdentity(cwd),marker='PFO_PROBE_'+crypto.randomBytes(8).toString('hex');
  const proof={status:'failed',workerModel:cfg.workerModel,workerReasoningEffort:cfg.workerReasoningEffort,provider:identity.provider,
    providerFingerprint:identity.fingerprint,verifiedAt:new Date().toISOString(),source:'real-codex-probe'};
  const r=spawnSync(process.env.PFO_CODEX_BIN||'codex',['exec','--sandbox','read-only','--skip-git-repo-check','--disable','hooks','--disable','plugins',
    '--model',cfg.workerModel,'-c','model_reasoning_effort="'+cfg.workerReasoningEffort+'"','--json','--color','never',
    'Reply exactly '+marker+'. Do not call tools or read or change files.'],{cwd,encoding:'utf8',timeout,windowsHide:true,maxBuffer:8*1024*1024});
  const events=(r.stdout||'').split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
  const thread=events.find(e=>e.type==='thread.started')?.thread_id;
  const session=thread?findSession(path.join(codexHome(),'sessions'),thread):'';
  let model='',effort='';
  if(session){for(const line of fs.readFileSync(session,'utf8').split(/\r?\n/)){let e;try{e=JSON.parse(line);}catch{continue;}
    if(e.type==='turn_context'){model=e.payload?.model || model;effort=e.payload?.effort || e.payload?.reasoning_effort || effort;}}}
  const message=events.find(e=>e.type==='item.completed'&&e.item?.type==='agent_message'&&e.item.text?.trim()===marker);
  const usedTools=events.some(e=>e.item&&['command_execution','mcp_tool_call','file_change'].includes(e.item.type));
  Object.assign(proof,{observedModel:model,observedEffort:effort,threadId:thread||'',usage:events.find(e=>e.type==='turn.completed')?.usage||null});
  if(!r.error&&r.status===0&&message&&!usedTools&&model===cfg.workerModel&&effort===cfg.workerReasoningEffort)proof.status='verified';
  else proof.error=redact(r.error?.message || events.find(e=>e.type==='turn.failed')?.error?.message || 'Probe failed or runtime model/reasoning effort was not confirmed').slice(0,1200);
  writeJson(path.join(controlDir,'worker-verification.json'),proof);return proof;
}
export function summarizeTelemetry(dir) {
  const models={},events={},guards={};let records=0;
  if(!dir || !fs.existsSync(dir))return {dataDir:dir,records,events,guards,models};
  for(const name of fs.readdirSync(dir).filter(n=>/^decisions(?:\.1|\.archive-[^/]+)?\.jsonl(?:\.1)?$/.test(n))) {
    for(const line of fs.readFileSync(path.join(dir,name),'utf8').split(/\r?\n/)) {
      let row;try{row=JSON.parse(line);}catch{continue;}if(row.test)continue;records++;
      if(row.hook==='codex-runtime'&&row.event)events[row.event]=(events[row.event] || 0)+1;
      if(row.hook!=='codex-model'){const key=row.hook+'/'+row.action;guards[key]=(guards[key] || 0)+1;continue;}
      const model=String(row.model || 'unknown');const m=models[model] ||= {requests:0,completed:0,failed:0,usage:{}};
      m.requests++;if(row.action==='completed')m.completed++;if(row.action==='failed')m.failed++;
      for(const [key,value] of Object.entries(row.usage || {}))if(typeof value==='number'&&Number.isFinite(value))m.usage[key]=(m.usage[key] || 0)+value;
    }
  }
  return {dataDir:dir,records,events,guards,models};
}
export async function diagnose({cwd=process.cwd()}={}) {
  const cfg=workerConfig(CONTROL_DIR),verification=verificationStatus(cfg,cwd,CONTROL_DIR);
  const native=await inspectNative({cwd});
  const trusted=native.hooks.length===6&&native.hooks.every(h=>h.enabled&&['trusted','managed'].includes(h.trustStatus));
  const observation=readJson(path.join(CONTROL_DIR,'last-hook.json'));
  return {platform:'codex',codexVersion:nativeCommand(['--version']).trim(),node:process.execPath,controlDir:CONTROL_DIR,
    deployment:readJson(path.join(CONTROL_DIR,'deployment.json')),worker:{model:cfg.workerModel,effort:cfg.workerReasoningEffort,verified:verification.verified,proof:verification.proof},
    hookState:!native.hooks.length?'not-loaded':!trusted?'needs-review':observation?'observed':'trusted-not-yet-observed',
    hooks:native.hooks.map(h=>({event:h.eventName,enabled:h.enabled,trust:h.trustStatus,source:h.source,sourcePath:h.sourcePath})),
    lastHook:observation,telemetry:summarizeTelemetry(observation?.dataDir || CONTROL_DIR),errors:native.errors,accountSignIn:'not live-validated',claudeCode:'not live-validated',
    limitations:['hosted tools','hook errors/timeouts','later input to an already-approved interactive shell']};
}
