#!/usr/bin/env node
/** Git/local marketplace setup. Native trust is never changed here. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {codexHome,readJson,writeJson,workerConfig,verificationStatus,providerIdentity,redact} from './codex-runtime.mjs';
import {inspectNative} from './codex-app-server.mjs';
export const CONTROL_DIR=path.join(codexHome(),'plugin-data','pro-flash-orchestrator');
export const MARKETPLACE_NAME='pro-flash-local';
export const PLUGIN_ID='pro-flash-orchestrator@'+MARKETPLACE_NAME;
export const MARKETPLACE_URL='https://github.com/demgkp1/pro-flash-orchestrator.git';
export const MARKETPLACE_REF='codex-marketplace';
const BRIDGE='PFO_NATIVE_BRIDGE';
export function nativeCommand(args,{cwd=process.cwd(),timeout=60000}={}) {
  const r=spawnSync(process.env.PFO_CODEX_BIN || 'codex',args,{cwd,encoding:'utf8',timeout,windowsHide:true,maxBuffer:16*1024*1024});
  if(r.error || r.status!==0)throw new Error(redact(r.error?.message || r.stderr || r.stdout || 'Codex command failed').slice(0,1500));
  return r.stdout;
}
export function gitCommand(args,{cwd=process.cwd(),timeout=60000}={}) {
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout,windowsHide:true,maxBuffer:16*1024*1024});
  if(r.error || r.status!==0)throw new Error(redact(r.error?.message || r.stderr || r.stdout || 'Git command failed').slice(0,1500));
  return r.stdout;
}
function atomicContents(file,content) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+process.pid+'.'+crypto.randomBytes(4).toString('hex')+'.setup-tmp';
  try {
    fs.writeFileSync(tmp,content,{flag:'wx',mode:fs.existsSync(file)?fs.statSync(file).mode:0o600});
    for(let attempt=0;;attempt++){
      try {fs.renameSync(tmp,file);break;}
      catch(error){if(process.platform!=='win32'||attempt===2)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);}
    }
  } finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function readContents(file){return fs.existsSync(file)?fs.readFileSync(file):null;}
function tomlParts(contents) {
  return String(contents || '').split(/(?=^[ \t]*\[[^\r\n]+\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$))/m).map(text=>{
    const header=text.match(/^[ \t]*\[([^\r\n]+)\]/)?.[1].replace(/[ "'\t]/g,'') || '';
    return {header,text};
  });
}
function ownedTable(header) {
  return [ 'marketplaces.'+MARKETPLACE_NAME,'plugins.'+PLUGIN_ID ].some(key=>header===key||header.startsWith(key+'.'));
}
function ownedLine(header,line) {
  const key=header==='marketplaces'?MARKETPLACE_NAME:header==='plugins'?PLUGIN_ID:null;
  return key && new RegExp('^\\s*(?:"'+key+'"|\\x27'+key+'\\x27)\\s*=').test(line);
}
function splitOwnedConfig(contents) {
  let other='',owned='';
  for(const part of tomlParts(contents)){
    if(ownedTable(part.header)){owned+=part.text;continue;}
    const lines=part.text.match(/[^\n]*\n|[^\n]+$/g) || [];
    let kept='',selected='';
    for(const line of lines){if(ownedLine(part.header,line))selected+=line;else kept+=line;}
    other+=kept;
    if(selected)owned+='['+part.header+']\n'+selected;
  }
  return {other,owned};
}
function restoreConfig(file,before) {
  const current=readContents(file),old=splitOwnedConfig(before?.toString('utf8')),now=splitOwnedConfig(current?.toString('utf8'));
  // Restore byte-for-byte when only our entries changed; preserve concurrent unrelated edits otherwise.
  const restored=old.other===now.other?before:Buffer.from(now.other.replace(/\s*$/,'')+'\n\n'+old.owned);
  if(restored===null){if(fs.existsSync(file))fs.unlinkSync(file);}
  else if(!current?.equals(restored))atomicContents(file,restored);
}
function previousSource(contents,oldRoot) {
  const table=tomlParts(contents?.toString('utf8')).find(part=>part.header==='marketplaces.'+MARKETPLACE_NAME);
  const values={};
  for(const line of (table?.text || '').split(/\r?\n/)){
    const match=line.match(/^\s*(source_type|source|ref)\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*(?:#.*)?$/);
    if(match)values[match[1]]=match[2][0]==='"'?JSON.parse(match[2]):match[2].slice(1,-1);
  }
  return values.source?{source:values.source,type:values.source_type,ref:values.source_type==='git'?values.ref:null}:oldRoot?{source:oldRoot,type:'local'}:null;
}
function sameSource(previous,source,url,ref,root) {
  if(!previous)return false;
  if(source==='git')return previous.type==='git'&&previous.source===url&&previous.ref===ref;
  if(previous.type==='git')return false;
  try {return fs.realpathSync(previous.source)===fs.realpathSync(root);}
  catch {return path.resolve(previous.source)===path.resolve(root);}
}
function marketplaceRoot(output) {
  const result=JSON.parse(output),entries=Array.isArray(result)?result:result.marketplaces || result.data || [];
  const entry=entries.find(value=>value.name===MARKETPLACE_NAME);
  return entry?.root?path.resolve(entry.root):null;
}
export function installedPlugin(output) {
  const result=JSON.parse(output);
  if(!Array.isArray(result.installed))throw new Error('Unsupported Codex plugin list JSON: expected installed array');
  const entry=result.installed.find(plugin=>plugin.pluginId===PLUGIN_ID&&plugin.installed===true);
  if(!entry)return {installed:false};
  if(typeof entry.enabled!=='boolean'||typeof entry.version!=='string')throw new Error('Codex did not report the installed plugin version/enabled state');
  return {installed:true,enabled:entry.enabled,version:entry.version};
}
function pluginCacheSnapshot(home) {
  // Native CLI 0.171 stores versioned caches here. Never touch another plugin or the local origin.
  const root=path.resolve(home,'plugins','cache',MARKETPLACE_NAME,'pro-flash-orchestrator');
  let current=path.resolve(home);
  for(const part of path.relative(current,root).split(path.sep)){
    current=path.join(current,part);
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('Unsafe installed plugin cache path');
  }
  const files=new Map(),directories=[];
  function walk(dir){
    if(!fs.existsSync(dir))return;
    directories.push(dir);
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw new Error('Unsafe installed plugin cache link');
      if(entry.isDirectory())walk(file);else if(entry.isFile())files.set(file,fs.readFileSync(file));
      else throw new Error('Unsupported installed plugin cache entry');
    }
  }
  walk(root);return {root,files,directories};
}
function restorePluginCache(home,before) {
  const now=pluginCacheSnapshot(home);
  if(now.root!==before.root)throw new Error('Installed cache recovery path changed');
  for(const [file]of now.files)if(!before.files.has(file))fs.unlinkSync(file);
  for(const [file,content]of before.files)if(!readContents(file)?.equals(content))atomicContents(file,content);
  for(const dir of [...now.directories].reverse())if(!before.directories.includes(dir)&&fs.existsSync(dir)&&!fs.readdirSync(dir).length)fs.rmdirSync(dir);
}
function setPluginEnabled(file,enabled) {
  const original=fs.readFileSync(file,'utf8'),parts=tomlParts(original);
  const part=parts.find(value=>value.header==='plugins.'+PLUGIN_ID);
  if(!part)throw new Error('Cannot preserve enabled state: missing Codex plugin configuration table');
  if(/^[ \t]*enabled[ \t]*=/m.test(part.text))part.text=part.text.replace(/^([ \t]*enabled[ \t]*=[ \t]*)(true|false)/m,'$1'+String(enabled));
  else part.text=part.text.replace(/\s*$/,'')+'\nenabled = '+String(enabled)+'\n';
  const next=parts.map(value=>value.text).join('');
  if(next!==original)atomicContents(file,Buffer.from(next));
}
function restoreHooks(file,before) {
  const current=readContents(file);
  if((current===null&&before===null)||(before!==null&&current?.equals(before)))return;
  const parse=contents=>contents?JSON.parse(contents.toString('utf8')):{hooks:{}};
  const previous=parse(before),now=parse(current);
  const extract=(registry,wantOwned)=>{
    const hooks={};
    for(const [event,groups]of Object.entries(registry.hooks || {})){
      if(!Array.isArray(groups))throw new Error('Cannot safely restore malformed hook groups');
      const kept=groups.map(group=>({...group,hooks:(group.hooks || []).filter(hook=>
        String(hook.command || hook.commandWindows || '').includes(BRIDGE)===wantOwned)})).filter(group=>group.hooks.length);
      if(kept.length)hooks[event]=kept;
    }
    return hooks;
  };
  const oldOther={...previous,hooks:extract(previous,false)},newOther={...now,hooks:extract(now,false)};
  if(JSON.stringify(oldOther)===JSON.stringify(newOther)){
    if(before===null){if(fs.existsSync(file))fs.unlinkSync(file);}else atomicContents(file,before);
    return;
  }
  const owned=extract(previous,true),hooks=newOther.hooks;
  for(const [event,groups]of Object.entries(owned))hooks[event]=[...(hooks[event] || []),...groups];
  atomicContents(file,Buffer.from(JSON.stringify({...now,hooks},null,2)+'\n'));
}
export function validateMarketplaceRoot(root) {
  const manifest=readJson(path.join(root,'.agents/plugins/marketplace.json'));
  const entry=manifest?.plugins?.find(value=>value.name==='pro-flash-orchestrator');
  if(manifest?.name!==MARKETPLACE_NAME || entry?.source?.source!=='local' || entry.source.path!=='./plugins/pro-flash-orchestrator')
    throw new Error('Expected '+MARKETPLACE_NAME+' with its complete relative local plugin package');
  const pluginRoot=path.join(root,'plugins','pro-flash-orchestrator');
  const native=readJson(path.join(pluginRoot,'.codex-plugin/plugin.json')),legacy=readJson(path.join(pluginRoot,'plugin.json'));
  if(native?.name!=='pro-flash-orchestrator'||legacy?.name!==native.name||legacy.version!==native.version||
    !/^\d+\.\d+\.\d+$/.test(native?.version || '')||native.hooks!=='./hooks/hooks.json')
    throw new Error('Invalid or mismatched stable Codex plugin manifests');
  for(const relative of ['.agents/plugins/marketplace.json','plugins/pro-flash-orchestrator/.codex-plugin/plugin.json',
    'plugins/pro-flash-orchestrator/plugin.json','plugins/pro-flash-orchestrator/hooks/hooks.json','plugins/pro-flash-orchestrator/scripts/codex-hook.mjs']){
    let current=path.resolve(root);
    for(const part of relative.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('Marketplace package cannot contain symbolic links');}
    if(!fs.statSync(current).isFile())throw new Error('Missing Codex runtime file: '+relative);
  }
  return {pluginRoot,version:native.version};
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
export function connectNativeHooks(pluginRoot,{remove=false,hookFile=path.join(codexHome(),'hooks.json'),controlDir=CONTROL_DIR}={}) {
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
      const backup=path.join(controlDir,'backups','hooks-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.json');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(hookFile,backup);
    }
    writeJson(hookFile,next);
  }
  return {changed,path:hookFile,source:remove?'removed':'native-user-hooks',requiresReview:changed&&!remove};
}
export async function registerMarketplace(target,options={}) {
  const source=options.source || process.env.PRO_CODEX_MARKETPLACE_SOURCE || 'git';
  const url=options.url || MARKETPLACE_URL,ref=options.ref || MARKETPLACE_REF;
  const run=options.command || nativeCommand,git=options.git || gitCommand,inspect=options.inspect || inspectNative;
  const home=options.codexDir || codexHome(),controlDir=options.controlDir || path.join(home,'plugin-data','pro-flash-orchestrator');
  const hookFile=options.hookFile || path.join(home,'hooks.json'),configFile=path.join(home,'config.toml');
  const installerRoot=path.resolve(target);
  if(!['git','local'].includes(source))throw new Error('Marketplace source must be git or local');
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)||ref.includes('..')||ref.endsWith('/'))throw new Error('Invalid marketplace branch');
  let temporary=null,configBefore=null,oldSource=null,oldInstalled={installed:false},cacheBefore=null,mutating=false,pluginAttempted=false;
  const snapshots=new Map();
  try {
    if(source==='git'){
      temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pfo-codex-register-'));
      const preflight=path.join(temporary,'marketplace');
      try {
        git(['clone','--quiet','--depth','1','--single-branch','--branch',ref,'--',url,preflight],{cwd:installerRoot});
        validateMarketplaceRoot(preflight);
      } catch(error) {
        throw new Error('Cannot prepare Git marketplace '+ref+': '+redact(error.message)+
          '. No installation or configuration was changed. The first stable Release must publish this branch; use node install.mjs --local meanwhile.');
      }
    } else validateMarketplaceRoot(installerRoot);
    configBefore=readContents(configFile);
    const oldRoot=marketplaceRoot(run(['plugin','marketplace','list','--json'],{cwd:installerRoot}));
    oldSource=previousSource(configBefore,oldRoot);
    oldInstalled=installedPlugin(run(['plugin','list','--json'],{cwd:installerRoot}));
    cacheBefore=pluginCacheSnapshot(home);
    for(const file of [hookFile,...['config.json','mode.json','deployment.json'].map(name=>path.join(controlDir,name))])snapshots.set(file,readContents(file));
    // Codex rejects same-name add from a different source. Remove only its source record after preflight.
    // The old plugin, source directory, hooks and controls remain intact until the new add succeeds.
    mutating=true;
    if(oldRoot&&!sameSource(oldSource,source,url,ref,installerRoot))
      run(['plugin','marketplace','remove',MARKETPLACE_NAME],{cwd:installerRoot});
    run(['plugin','marketplace','add',source==='git'?url:installerRoot,...(source==='git'?['--ref',ref]:[]),'--json'],{cwd:installerRoot});
    const root=marketplaceRoot(run(['plugin','marketplace','list','--json'],{cwd:installerRoot}));
    if(!root)throw new Error('Codex did not report the configured marketplace root');
    const {pluginRoot,version}=validateMarketplaceRoot(root);
    pluginAttempted=true;
    run(['plugin','add',PLUGIN_ID,'--json'],{cwd:installerRoot});
    if(oldInstalled.installed&&!oldInstalled.enabled)setPluginEnabled(configFile,false);
    const installed=installedPlugin(run(['plugin','list','--json'],{cwd:installerRoot}));
    if(!installed.installed||installed.version!==version||(oldInstalled.installed&&installed.enabled!==oldInstalled.enabled))
      throw new Error('Codex did not confirm the requested installed plugin version/enabled state');
    const native=await inspect({cwd:root});
    const bundled=native.hooks.filter(h=>h.source==='plugin');
    const wiring=connectNativeHooks(pluginRoot,{remove:bundled.length===6,hookFile,controlDir});
    fs.mkdirSync(controlDir,{recursive:true});
    if(!fs.existsSync(path.join(controlDir,'config.json')))writeJson(path.join(controlDir,'config.json'),{workerModel:'gpt-5-mini',workerReasoningEffort:'low'});
    if(!fs.existsSync(path.join(controlDir,'mode.json')))writeJson(path.join(controlDir,'mode.json'),{mode:'enforce'});
    writeJson(path.join(controlDir,'deployment.json'),{...readJson(path.join(controlDir,'deployment.json'),{}),
      target:root,installerSource:installerRoot,registered:true,source,repository:source==='git'?url:null,ref:source==='git'?ref:null,version,wiring,updatedAt:new Date().toISOString()});
    return {registered:true,marketplace:MARKETPLACE_NAME,plugin:PLUGIN_ID,source,ref:source==='git'?ref:null,target:root,version,wiring,
      next:'Review Pro-Flash hooks in Settings > Hooks or /hooks, then start a new session. Git snapshots refresh with codex plugin marketplace upgrade pro-flash-local; native UI upgrade still needs release-time acceptance.'};
  } catch(error) {
    if(mutating){
      const recoveryErrors=[];
      try {
        if(pluginAttempted&&!oldInstalled.installed&&installedPlugin(run(['plugin','list','--json'],{cwd:installerRoot})).installed)
          run(['plugin','remove',PLUGIN_ID],{cwd:installerRoot}); // Only a newly-created installation, before removing its source record.
        const configured=marketplaceRoot(run(['plugin','marketplace','list','--json'],{cwd:installerRoot}));
        if(configured)run(['plugin','marketplace','remove',MARKETPLACE_NAME],{cwd:installerRoot});
        if(oldSource){
          run(['plugin','marketplace','add',oldSource.source,...(oldSource.ref?['--ref',oldSource.ref]:[]),'--json'],{cwd:installerRoot});
          if(pluginAttempted&&oldInstalled.installed)run(['plugin','add',PLUGIN_ID,'--json'],{cwd:installerRoot});
        }
      } catch(recovery){recoveryErrors.push(redact(recovery.message));}
      try {restorePluginCache(home,cacheBefore);}catch(recovery){recoveryErrors.push(redact(recovery.message));}
      try {restoreConfig(configFile,configBefore);}catch(recovery){recoveryErrors.push(redact(recovery.message));}
      for(const [file,contents] of snapshots){
        try {if(file===hookFile)restoreHooks(file,contents);else if(contents===null){if(fs.existsSync(file))fs.unlinkSync(file);}else if(!readContents(file)?.equals(contents))atomicContents(file,contents);}
        catch(recovery){recoveryErrors.push(redact(recovery.message));}
      }
      try {
        const restored=installedPlugin(run(['plugin','list','--json'],{cwd:installerRoot}));
        if(restored.installed!==oldInstalled.installed||(oldInstalled.installed&&
          (restored.version!==oldInstalled.version||restored.enabled!==oldInstalled.enabled)))
          throw new Error('Previous installed plugin version/enabled state was not restored');
      } catch(recovery){recoveryErrors.push(redact(recovery.message));}
      if(recoveryErrors.length)throw new Error(redact(error.message)+'; native rollback needs attention: '+recoveryErrors.join('; '));
    }
    throw error;
  } finally {
    if(temporary){
      if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('pfo-codex-register-'))throw new Error('Invalid preflight cleanup path');
      fs.rmSync(temporary,{recursive:true,force:true});
    }
  }
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
