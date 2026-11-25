#!/usr/bin/env node
/** Publish the already-built Codex ZIP after a stable GitHub Release succeeds. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyZipLayout} from './package.mjs';
import {codexMarketplaceFiles} from './codex-maintenance.mjs';
import {ROOT_DIR,validateRuntimePath} from './runtime-files.mjs';
import {redact} from './codex-runtime.mjs';

const MARKETPLACE='pro-flash-local';
const PLUGIN='plugins/pro-flash-orchestrator/';
const ZIP_ROOT='pro-flash-orchestrator-codex/';
export const PUBLISH_BRANCH='codex-marketplace';

export function stableVersion(value) {
  const version=String(value).replace(/^v/,'');
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw new Error('Expected a stable semantic version: '+value);
  return version;
}
export function compareVersions(left,right) {
  const a=stableVersion(left).split('.').map(BigInt),b=stableVersion(right).split('.').map(BigInt);
  for(let i=0;i<3;i++){if(a[i]>b[i])return 1;if(a[i]<b[i])return -1;}
  return 0;
}
export function validateRelease(tag,release) {
  if(!release || release.tagName!==tag || typeof release.isDraft!=='boolean' || typeof release.isPrerelease!=='boolean')
    throw new Error('Provide the matching GitHub Release tagName, isDraft and isPrerelease fields');
  if(release.isDraft || release.isPrerelease || /^v\d+\.\d+\.\d+-/.test(tag))return {eligible:false,reason:'draft-or-prerelease'};
  if(tag!=='v'+stableVersion(tag))throw new Error('Release tag must use the v prefix');
  return {eligible:true,version:stableVersion(tag)};
}
export function validateMarketplaceFiles(files,tag) {
  const version=stableVersion(tag),byPath=new Map();
  for(const entry of files){
    const name=validateRuntimePath(entry.to);
    if(byPath.has(name))throw new Error('Duplicate publication path: '+name);
    if(!['.agents/plugins/marketplace.json','README.md','install.mjs','doctor.mjs','report.mjs'].includes(name)&&!name.startsWith(PLUGIN))
      throw new Error('Unexpected Codex publication path: '+name);
    byPath.set(name,Buffer.from(entry.content));
  }
  const required=['.agents/plugins/marketplace.json',PLUGIN+'plugin.json',PLUGIN+'.codex-plugin/plugin.json',
    PLUGIN+'hooks/hooks.json',PLUGIN+'scripts/lib.mjs',PLUGIN+'scripts/codex-hook.mjs',
    PLUGIN+'skills/flash-dev/SKILL.md',PLUGIN+'skills/pfo-setup/SKILL.md','install.mjs','doctor.mjs','report.mjs','README.md'];
  for(const name of required)if(!byPath.has(name))throw new Error('Missing Codex publication file: '+name);
  if(byPath.has(PLUGIN+'scripts/update.mjs')||byPath.has(PLUGIN+'scripts/check-update-worker.mjs'))
    throw new Error('Codex publication must not carry Antigravity update tools');
  const json=name=>JSON.parse(byPath.get(name).toString('utf8'));
  const marketplace=json('.agents/plugins/marketplace.json'),entry=marketplace.plugins?.find(p=>p.name==='pro-flash-orchestrator');
  if(marketplace.name!==MARKETPLACE||entry?.source?.source!=='local'||entry.source.path!=='./plugins/pro-flash-orchestrator')
    throw new Error('Publication must preserve marketplace identity and the complete relative plugin source');
  for(const name of [PLUGIN+'plugin.json',PLUGIN+'.codex-plugin/plugin.json']){
    const manifest=json(name);
    if(manifest.name!=='pro-flash-orchestrator'||manifest.version!==version)throw new Error('Release tag and plugin manifest version differ: '+name);
  }
  if(json(PLUGIN+'.codex-plugin/plugin.json').hooks!=='./hooks/hooks.json')throw new Error('Invalid native hook layout');
  return [...byPath].map(([to,content])=>({to,content}));
}
export function readCodexArchive(archive,tag) {
  const expected=codexMarketplaceFiles({worktree:false,ref:tag});
  verifyZipLayout(archive,expected.map(entry=>entry.to),{prefix:ZIP_ROOT,required:[
    '.agents/plugins/marketplace.json',PLUGIN+'.codex-plugin/plugin.json',PLUGIN+'scripts/codex-hook.mjs']});
  const files=expected.map(entry=>{
    const content=execFileSync('unzip',['-p',path.resolve(archive),ZIP_ROOT+entry.to],{windowsHide:true,maxBuffer:16*1024*1024});
    if(!content.equals(entry.content))throw new Error('ZIP content differs from the release tag: '+entry.to);
    return {to:entry.to,content};
  });
  return validateMarketplaceFiles(files,tag);
}
function gitCommand(args,{cwd=ROOT_DIR,env={},input}={}) {
  try {return execFileSync('git',args,{cwd,input,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...env},
    encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024}).trim();}
  catch(error){throw new Error(redact(error.stderr?.toString() || error.message).slice(0,1800));}
}
export function publishCodexMarketplace({tag,release,archive,files,repository=ROOT_DIR,remote='origin',
  branch=PUBLISH_BRANCH,push=false,git=gitCommand}={}) {
  const eligibility=validateRelease(tag,release);
  if(!eligibility.eligible)return {published:false,reason:eligibility.reason};
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)||branch.includes('..')||branch.endsWith('/'))throw new Error('Invalid publication branch');
  const payload=validateMarketplaceFiles(files || readCodexArchive(archive,tag),tag);
  const run=(args,options={})=>git(args,{cwd:repository,...options});
  const listing=String(run(['ls-remote','--heads',remote,'refs/heads/'+branch])).trim();
  let base=null,temporaryRef=null,temporary=null;
  try {
    if(listing){
      temporaryRef='refs/pfo-codex-marketplace/'+crypto.randomBytes(12).toString('hex');
      run(['fetch','--no-tags','--no-write-fetch-head',remote,'refs/heads/'+branch+':'+temporaryRef]);
      base=String(run(['rev-parse',temporaryRef])).trim();
      const current=JSON.parse(run(['show',base+':'+PLUGIN+'.codex-plugin/plugin.json']));
      const market=JSON.parse(run(['show',base+':.agents/plugins/marketplace.json']));
      if(current.name!=='pro-flash-orchestrator'||market.name!==MARKETPLACE)throw new Error('Refusing to replace an unrelated publication branch');
      const comparison=compareVersions(eligibility.version,current.version);
      if(comparison<=0)return {published:false,reason:comparison===0?'already-published':'newer-version-exists',version:eligibility.version,currentVersion:current.version};
    }
    if(!push)return {published:false,prepared:true,firstPublish:!base,version:eligibility.version,files:payload.length,branch};
    const sourceCommit=String(run(['rev-parse',tag+'^{commit}'])).trim();
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pfo-codex-publish-'));
    const env={GIT_INDEX_FILE:path.join(temporary,'index'),GIT_AUTHOR_NAME:'github-actions[bot]',
      GIT_AUTHOR_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME:'github-actions[bot]',GIT_COMMITTER_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com'};
    run(['read-tree','--empty'],{env});
    const metadata={tag,version:eligibility.version,sourceCommit};
    for(const entry of [...payload,{to:'.pfo-release.json',content:Buffer.from(JSON.stringify(metadata,null,2)+'\n')}]){
      const blob=String(run(['hash-object','-w','--stdin'],{input:entry.content})).trim();
      run(['update-index','--add','--cacheinfo','100644',blob,entry.to],{env});
    }
    const tree=String(run(['write-tree'],{env})).trim();
    const commit=String(run(['commit-tree',tree,...(base?['-p',base]:[]),'-m','Publish Codex marketplace '+tag],{env})).trim();
    // A normal fast-forward push rejects races. Never force-push over a newer release.
    run(['push',remote,commit+':refs/heads/'+branch]);
    return {published:true,firstPublish:!base,version:eligibility.version,branch,commit,files:payload.length};
  } finally {
    if(temporaryRef)run(['update-ref','-d',temporaryRef]);
    if(temporary){
      if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('pfo-codex-publish-'))throw new Error('Invalid publication cleanup path');
      fs.rmSync(temporary,{recursive:true,force:true});
    }
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};let info=null;
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    if(['--tag','--archive','--release-info','--remote','--branch'].includes(args[i])){
      const key=args[i].slice(2);
      if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(args[i]+' requires a value');
      const value=args[++i];
      if(key==='release-info')info=value;else options[key]=value;
    } else if(args[i]==='--push')options.push=true;
    else if(args[i]==='--dry-run')options.push=false;
    else throw new Error('Unknown publication argument: '+args[i]);
  }
  if(!info)throw new Error('--release-info is required; obtain it with gh release view --json tagName,isDraft,isPrerelease');
  options.release=JSON.parse(fs.readFileSync(info,'utf8'));
  console.log(JSON.stringify(publishCodexMarketplace(options),null,2));
}
