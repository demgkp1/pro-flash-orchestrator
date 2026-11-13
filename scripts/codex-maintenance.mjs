#!/usr/bin/env node
/** Native packaging, registration, uninstallation, diagnostics and real worker verification. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runtimeEntries,readProjectFile,ROOT_DIR} from './runtime-files.mjs';
import {inspectNative} from './codex-app-server.mjs';
import {registerMarketplace,unregisterMarketplace,diagnose,verifyWorker as standaloneVerify} from './codex-setup.mjs';
import {codexHome,dataDir,readJson,writeJson,workerConfig,providerIdentity,verificationStatus,nativeManifest,marketplace,redact} from './codex-runtime.mjs';
export const CONTROL_DIR=path.join(codexHome(),'plugin-data','pro-flash-orchestrator');
export const MARKETPLACE_DIR=path.join(codexHome(),'local-marketplaces','pro-flash-orchestrator');
export function codexRuntimeFiles(source={worktree:true}) {
  const base=runtimeEntries({...source,platform:'antigravity'}).filter(e=>!['plugin.json','hooks.json','rules/AGENTS.md','skills/flash-dev/SKILL.md','README.md','scripts/session-start.mjs'].includes(e.to));
  const files=base.map(e=>({to:e.to,content:readProjectFile(e.from,source)}));
  for(const name of ['codex-hook.mjs','codex-runtime.mjs','codex-app-server.mjs','codex-setup.mjs']) files.push({to:'scripts/'+name,content:readProjectFile('scripts/'+name,source)});
  for(const [from,to] of [['adapters/codex/hooks.json','hooks/hooks.json'],
    ['adapters/codex/flash-dev/SKILL.md','skills/flash-dev/SKILL.md'],
    ['adapters/codex/pfo-setup/SKILL.md','skills/pfo-setup/SKILL.md']]) files.push({to,content:readProjectFile(from,source)});
  files.push({to:'plugin.json',content:Buffer.from(JSON.stringify(nativeManifest(JSON.parse(readProjectFile('plugin.json',source))),null,2)+'\n')});
  const original=JSON.parse(readProjectFile('plugin.json',source));
  files.push({to:'.codex-plugin/plugin.json',content:Buffer.from(JSON.stringify({name:original.name,version:original.version,description:'Native Codex orchestration guards',skills:'./skills/',hooks:'./hooks/hooks.json',onboardingSkill:'./skills/pfo-setup/SKILL.md',interface:{displayName:'Pro-Flash Orchestrator for Codex',shortDescription:'Verified workers and native guards'}},null,2)+'\n')});
  return files;
}
export function codexMarketplaceFiles(source={worktree:true}) {
  return [{to:'.agents/plugins/marketplace.json',content:Buffer.from(JSON.stringify(marketplace(),null,2)+'\n')},
    {to:'README.md',content:readProjectFile('adapters/codex/README.md',source)},
    {to:'install.mjs',content:readProjectFile('adapters/codex/install.mjs',source)},
    {to:'doctor.mjs',content:readProjectFile('adapters/codex/doctor.mjs',source)},
    {to:'report.mjs',content:readProjectFile('adapters/codex/report.mjs',source)},
    ...codexRuntimeFiles(source).map(e=>({...e,to:'plugins/pro-flash-orchestrator/'+e.to}))];
}
function command(args,{timeout=60000,cwd=ROOT_DIR}={}) {
  const r=spawnSync(process.env.PFO_CODEX_BIN || 'codex',args,{cwd,encoding:'utf8',timeout,windowsHide:true,maxBuffer:16*1024*1024});
  if(r.error || r.status !== 0) throw new Error(redact(r.error?.message || r.stderr || r.stdout || 'Codex command failed').slice(0,1800));
  return r.stdout;
}
function validateTarget(target) {
  const dir=path.resolve(target);const rel=path.relative(ROOT_DIR,dir);
  if(!rel || (!rel.startsWith('..')&&!path.isAbsolute(rel))) throw new Error('Codex install must be outside the maintenance checkout');
  if(path.basename(dir).toLowerCase()!=='pro-flash-orchestrator') throw new Error('Codex marketplace directory must be named pro-flash-orchestrator');
  let p=dir;for(;;){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Refusing deployment through symbolic links');const next=path.dirname(p);if(next===p)break;p=next;}
  if(fs.existsSync(path.join(dir,'.git')))throw new Error('Refusing to overwrite a Git checkout');
  const marker=path.join(dir,'.pfo-marketplace.json');
  if(fs.existsSync(dir)&&fs.readdirSync(dir).length&&!fs.existsSync(marker))throw new Error('Target is not a managed PFO marketplace');
  return dir;
}
export async function installCodex({target=MARKETPLACE_DIR,dryRun=false,register=true}={}) {
  const dir=validateTarget(target);const files=codexMarketplaceFiles();const marker=readJson(path.join(dir,'.pfo-marketplace.json'));let changed=0;
  const previousOwned=marker?.files || (marker ? ['plugins/pro-flash-orchestrator/scripts/report.mjs'] : []);
  const wanted=new Set(files.map(f=>f.to));
  for(const old of previousOwned){
    if(wanted.has(old))continue;const dst=path.resolve(dir,old),rel=path.relative(dir,dst);
    if(!rel || rel.startsWith('..') || path.isAbsolute(rel) || !old.startsWith('plugins/pro-flash-orchestrator/'))throw new Error('Invalid obsolete deployment path');
    let ancestor=dir;for(const part of rel.split(path.sep)){ancestor=path.join(ancestor,part);if(fs.existsSync(ancestor)&&fs.lstatSync(ancestor).isSymbolicLink())throw new Error('Unsafe obsolete deployment path through symbolic link');}
    if(fs.existsSync(dst)){if(fs.lstatSync(dst).isSymbolicLink() || !fs.statSync(dst).isFile())throw new Error('Unsafe obsolete deployment file');changed++;if(!dryRun)fs.unlinkSync(dst);}
  }
  for(const f of files) {
    const dst=path.join(dir,f.to);
    let check=dir;for(const part of f.to.split('/')){check=path.join(check,part);if(fs.existsSync(check)&&fs.lstatSync(check).isSymbolicLink())throw new Error('Refusing deployment through a symbolic link');}
    if(fs.existsSync(dst)&&fs.readFileSync(dst).equals(f.content))continue;
    changed++;
    if(dryRun)continue;
    fs.mkdirSync(path.dirname(dst),{recursive:true});
    const tmp=dst+'.'+process.pid+'.install-tmp';
    try {fs.writeFileSync(tmp,f.content,{flag:'wx'});fs.renameSync(tmp,dst);}
    finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  }
  if(!dryRun) {
    writeJson(path.join(dir,'.pfo-marketplace.json'),{name:'pro-flash-orchestrator',version:JSON.parse(readProjectFile('plugin.json')).version,files:files.map(f=>f.to)});
    fs.mkdirSync(CONTROL_DIR,{recursive:true});
    if(!fs.existsSync(path.join(CONTROL_DIR,'config.json')))writeJson(path.join(CONTROL_DIR,'config.json'),{workerModel:'gpt-5-mini',workerReasoningEffort:'low'});
    if(!fs.existsSync(path.join(CONTROL_DIR,'mode.json')))writeJson(path.join(CONTROL_DIR,'mode.json'),{mode:'enforce'});
    if(register) {
      await registerMarketplace(dir);
    }
    writeJson(path.join(CONTROL_DIR,'deployment.json'),{...readJson(path.join(CONTROL_DIR,'deployment.json'),{}),target:dir,registered:register,updatedAt:new Date().toISOString()});
  }
  return {platform:'codex',target:dir,files:files.length,changed,dryRun,registered:!dryRun&&register,
    next:'Review installed hooks in Settings > Hooks or /hooks, then start a new session.'};
}
export async function uninstallCodex({target=MARKETPLACE_DIR,dryRun=false}={}) {
  const dir=validateTarget(target);
  if(!dryRun) {
    await unregisterMarketplace(dir);
    writeJson(path.join(CONTROL_DIR,'deployment.json'),{target:dir,registered:false,uninstalledAt:new Date().toISOString()});
  }
  return {uninstalled:!dryRun,preservedConfiguration:CONTROL_DIR,preservedSource:dir};
}
export const verifyWorker=standaloneVerify;
export async function doctorCodex({verify=false}={}){return verify?verifyWorker({cwd:ROOT_DIR}):diagnose({cwd:ROOT_DIR});}
