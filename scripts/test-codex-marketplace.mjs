#!/usr/bin/env node
/** Focused install/publish tests. All writes and real CLI calls use disposable fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pfo-codex-marketplace-test-'));
const saved=Object.fromEntries(['CODEX_HOME','PRO_STATE_DIR','PRO_TEST','PRO_NO_UPDATE_CHECK','PRO_CODEX_MARKETPLACE_SOURCE'].map(k=>[k,process.env[k]]));
process.env.CODEX_HOME=path.join(temp,'test-home');
process.env.PRO_STATE_DIR=path.join(temp,'test-state');
process.env.PRO_TEST='1';
process.env.PRO_NO_UPDATE_CHECK='1';
delete process.env.PRO_CODEX_MARKETPLACE_SOURCE;
const setup=await import('./codex-setup.mjs');
const maintenance=await import('./codex-maintenance.mjs');
const publication=await import('./publish-codex-marketplace.mjs');
const {parseInstallArgs}=await import('../adapters/codex/install.mjs');
const generated=maintenance.codexMarketplaceFiles();
const actualVersion=JSON.parse(generated.find(f=>f.to==='plugins/pro-flash-orchestrator/.codex-plugin/plugin.json').content).version;
const pluginPrefix='plugins/pro-flash-orchestrator/';
let passed=0,skipped=0;const failures=[];
async function test(name,fn){
  if((process.argv.includes('--native-probe')||process.argv.includes('--native-discovery'))&&!name.startsWith('real Codex CLI'))return;
  try{if(await fn()===false)return;passed++;console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+': '+error.stack);}
}
function write(file,content){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
function writeJson(file,value){write(file,JSON.stringify(value,null,2)+'\n');}
function payload(version=actualVersion,{stub=false}={}){
  return generated.map(entry=>{
    let content=Buffer.from(entry.content);
    if([pluginPrefix+'plugin.json',pluginPrefix+'.codex-plugin/plugin.json'].includes(entry.to)){
      const value=JSON.parse(content);value.version=version;content=Buffer.from(JSON.stringify(value,null,2)+'\n');
    }
    if(stub&&entry.to===pluginPrefix+'scripts/codex-hook.mjs')
      content=Buffer.from('process.stdout.write(JSON.stringify({version:'+JSON.stringify(version)+',root:process.env.PLUGIN_ROOT}));\n');
    return {to:entry.to,content};
  });
}
function seedMarketplace(dir,version='0.7.2'){
  const files=payload(version,{stub:true});
  for(const file of files)write(path.join(dir,file.to),file.content);
  writeJson(path.join(dir,'.pfo-marketplace.json'),{name:'pro-flash-orchestrator',version,files:files.map(f=>f.to)});
}
function setSource(file,source,type,ref){
  const text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  const start=text.indexOf('[marketplaces.pro-flash-local]'),end=start<0?-1:text.indexOf('\n[',start+1);
  const section='[marketplaces.pro-flash-local]\nsource_type = '+JSON.stringify(type)+'\nsource = '+JSON.stringify(source)+'\n'+(ref?'ref = '+JSON.stringify(ref)+'\n':'');
  write(file,start<0?text+'\n'+section:text.slice(0,start)+section+(end<0?'':text.slice(end)));
}
function setEnabled(file,enabled){
  const text=fs.readFileSync(file,'utf8'),header='[plugins."'+setup.PLUGIN_ID+'"]';
  const start=text.indexOf(header),end=start<0?-1:text.indexOf('\n[',start+1);
  const section=header+'\nenabled = '+enabled+'\n';
  write(file,start<0?text+'\n'+section:text.slice(0,start)+section+(end<0?'':text.slice(end)));
}
function enabledIn(file){
  return !fs.readFileSync(file,'utf8').match(/\[plugins\."pro-flash-orchestrator@pro-flash-local"\][\s\S]*?enabled\s*=\s*(true|false)/)?.[1]?.includes('false');
}
function treeSnapshot(dir){
  const files=new Map();
  if(!fs.existsSync(dir))return files;
  function walk(current){for(const entry of fs.readdirSync(current,{withFileTypes:true})){
    const file=path.join(current,entry.name);assert(!entry.isSymbolicLink(),'Unexpected fixture symlink');
    if(entry.isDirectory())walk(file);else if(entry.isFile())files.set(file,fs.readFileSync(file));
  }}
  walk(dir);return files;
}
function fixture(name,{installed=true,enabled=true}={}){
  const base=path.join(temp,name),home=path.join(base,'home'),oldRoot=path.join(home,'local-marketplaces','pro-flash-orchestrator');
  const gitRoot=path.join(base,'git-snapshot'),controlDir=path.join(home,'plugin-data','pro-flash-orchestrator'),hookFile=path.join(home,'hooks.json');
  seedMarketplace(oldRoot,'0.7.2');seedMarketplace(gitRoot,'0.7.3');
  const configFile=path.join(home,'config.toml');
  write(configFile,'model = "fixture"\n[marketplaces.other]\nsource_type = "local"\nsource = "untouched"\n[plugins."other@other"]\nenabled = false\n');
  setSource(configFile,oldRoot,'local');
  if(installed)setEnabled(configFile,enabled);
  writeJson(path.join(controlDir,'config.json'),{workerModel:'gpt-5-mini',workerReasoningEffort:'low',custom:'keep'});
  writeJson(path.join(controlDir,'mode.json'),{mode:'off'});
  writeJson(path.join(controlDir,'deployment.json'),{target:oldRoot,registered:true,custom:'keep'});
  writeJson(path.join(controlDir,'worker-verification.json'),{status:'fixture',custom:'keep'});
  writeJson(hookFile,{hooks:{Stop:[{hooks:[{type:'command',command:'echo unrelated'}]}]}});
  setup.connectNativeHooks(path.join(oldRoot,pluginPrefix),{hookFile,controlDir});
  const commands=[],state={root:oldRoot,installed:installed?{version:'0.7.2'}:null,failPlugin:false,failGit:false,concurrent:false};
  const command=args=>{
    commands.push(args);
    if(args.slice(0,2).join(' ')==='plugin list')return JSON.stringify({installed:state.installed?[{
      pluginId:setup.PLUGIN_ID,installed:true,version:state.installed.version,enabled:enabledIn(configFile)}]:[],available:[]});
    if(args.slice(0,3).join(' ')==='plugin marketplace list')return JSON.stringify({marketplaces:state.root?[{name:'pro-flash-local',root:state.root}]:[]});
    if(args.slice(0,3).join(' ')==='plugin marketplace remove'){state.root=null;return '';}
    if(args.slice(0,3).join(' ')==='plugin marketplace add'){
      const isGit=args[3]===setup.MARKETPLACE_URL;
      const wanted=isGit?gitRoot:path.resolve(args[3]);
      if(state.root&&state.root!==wanted)throw new Error('fixture marketplace is already added from a different source');
      state.root=wanted;
      setSource(configFile,args[3],isGit?'git':'local',isGit?args[args.indexOf('--ref')+1]:null);
      return JSON.stringify({name:'pro-flash-local',root:state.root});
    }
    if(args.slice(0,2).join(' ')==='plugin add'){
      assert.equal(args[2],setup.PLUGIN_ID);
      if(state.failPlugin){state.failPlugin=false;if(state.concurrent)fs.appendFileSync(configFile,'\n[projects.fixture]\ntrust_level = "trusted"\n');throw new Error('fixture plugin install failed');}
      state.installed={version:JSON.parse(fs.readFileSync(path.join(state.root,pluginPrefix+'.codex-plugin/plugin.json'))).version};
      setEnabled(configFile,true);
      return '{}';
    }
    if(args.slice(0,2).join(' ')==='plugin remove'){state.installed=null;return '';}
    throw new Error('Unexpected native fixture command: '+args.join(' '));
  };
  const git=args=>{
    commands.push(['git',...args]);assert.equal(args[0],'clone');
    if(state.failGit)throw new Error('fixture remote branch unavailable');
    fs.cpSync(gitRoot,args.at(-1),{recursive:true});return '';
  };
  const options={source:'git',command,git,inspect:async()=>({hooks:[]}),codexDir:home,controlDir,hookFile};
  return {base,home,oldRoot,gitRoot,controlDir,hookFile,configFile,commands,state,options};
}
function snapshot(f){
  return new Map([f.configFile,f.hookFile,...['config.json','mode.json','deployment.json','worker-verification.json'].map(name=>path.join(f.controlDir,name)),
    path.join(f.oldRoot,pluginPrefix+'scripts/codex-hook.mjs')].map(file=>[file,fs.readFileSync(file)]));
}
function assertSnapshot(before){for(const [file,content]of before)assert(fs.readFileSync(file).equals(content),'Changed old fixture: '+file);}
function bridgeCommand(hookFile){
  return Object.values(JSON.parse(fs.readFileSync(hookFile,'utf8')).hooks).flatMap(groups=>groups.flatMap(group=>group.hooks)).find(h=>h.command?.includes('PFO_NATIVE_BRIDGE'));
}
function executeBridge(hook,home,{windows=false}={}){
  const code=windows?hook.commandWindows.match(/^powershell.exe -NoProfile -Command "(.*)"$/s)?.[1]:hook.command.match(/^node -e "(.*)"$/s)?.[1];assert(code);
  const result=spawnSync(windows?'powershell.exe':process.execPath,windows?['-NoProfile','-Command',code]:['-e',code],{encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,CODEX_HOME:home}});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
function fakePublication(currentVersion=null,{race=false}={}){
  const calls=[],blobs=new Map(),index=new Map(),state={version:currentVersion};
  const git=(args,options={})=>{
    calls.push(args);
    if(args[0]==='ls-remote')return state.version?'1'.repeat(40)+'\trefs/heads/codex-marketplace':'';
    if(args[0]==='fetch'||args[0]==='update-ref')return '';
    if(args[0]==='rev-parse')return args[1].startsWith('refs/pfo-')?'1'.repeat(40):'a'.repeat(40);
    if(args[0]==='show')return JSON.stringify(args[1].endsWith('marketplace.json')?{name:'pro-flash-local'}:{name:'pro-flash-orchestrator',version:state.version});
    if(args[0]==='read-tree'){index.clear();return '';}
    if(args[0]==='hash-object'){const hash=crypto.createHash('sha1').update(options.input).digest('hex');blobs.set(hash,Buffer.from(options.input));return hash;}
    if(args[0]==='update-index'){index.set(args[5],blobs.get(args[4]));return '';}
    if(args[0]==='write-tree')return '2'.repeat(40);
    if(args[0]==='commit-tree'){assert.equal(args.includes('-p'),Boolean(state.version));return '3'.repeat(40);}
    if(args[0]==='push'){
      assert(!args.some(a=>a.includes('force')));
      if(race)throw new Error('fixture non-fast-forward rejected');
      state.version=JSON.parse(index.get('.pfo-release.json')).version;return '';
    }
    throw new Error('Unexpected publication Git command: '+args.join(' '));
  };
  return {git,calls,index,state};
}
const release=tag=>({tagName:tag,isDraft:false,isPrerelease:false});

// This preload only exists in the disposable fixture and intercepts child CLI/Git calls.
function mockToolsPrelude(){
  const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{syncBuiltinESMExports}=require('node:module');
  const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
  const originalSync=cp.spawnSync,originalSpawn=cp.spawn;
  cp.spawnSync=(bin,args,options)=>{
    if(bin!=='git'&&bin!=='codex')return originalSync(bin,args,options);
    fs.appendFileSync(process.env.PFO_FIXTURE_CALLS,JSON.stringify({bin,args})+'\n');
    const ok=stdout=>({status:0,stdout,stderr:''});
    if(bin==='git'){
      if(process.env.PFO_FIXTURE_GIT_FAIL==='1')return {status:128,stdout:'',stderr:'fixture missing release branch'};
      fs.cpSync(process.env.PFO_FIXTURE_MARKETPLACE_ROOT,args.at(-1),{recursive:true});return ok('');
    }
    const registry=process.env.PFO_FIXTURE_REGISTRY,home=process.env.CODEX_HOME;
    const config=path.join(home,'config.toml'),installedFile=registry+'.installed';
    if(args.slice(0,2).join(' ')==='plugin list'){
      const item=JSON.parse(fs.readFileSync(installedFile,'utf8'));
      const enabled=fs.readFileSync(config,'utf8').match(/\[plugins\."pro-flash-orchestrator@pro-flash-local"\][\s\S]*?enabled\s*=\s*(true|false)/)?.[1]!=='false';
      return ok(JSON.stringify({installed:item?[{pluginId:'pro-flash-orchestrator@pro-flash-local',installed:true,version:item.version,enabled}]:[],available:[]}));
    }
    if(args.slice(0,3).join(' ')==='plugin marketplace list'){
      const root=fs.readFileSync(registry,'utf8');
      return ok(JSON.stringify({marketplaces:root?[{name:'pro-flash-local',root}]:[]}));
    }
    if(args.slice(0,3).join(' ')==='plugin marketplace remove'){fs.writeFileSync(registry,'');return ok('');}
    if(args.slice(0,3).join(' ')==='plugin marketplace add'){
      const isGit=args[3].startsWith('https://'),root=isGit?process.env.PFO_FIXTURE_MARKETPLACE_ROOT:args[3];
      const previous=fs.readFileSync(registry,'utf8');
      if(previous&&previous!==root)return {status:1,stdout:'',stderr:'marketplace is already added from a different source'};
      fs.writeFileSync(registry,root);
      const text=fs.readFileSync(config,'utf8');
      const start=text.indexOf('[marketplaces.pro-flash-local]'),end=text.indexOf('\n[',start+1);
      const section='[marketplaces.pro-flash-local]\nsource_type = '+JSON.stringify(isGit?'git':'local')+'\nsource = '+JSON.stringify(args[3])+'\n'+(isGit?'ref = "codex-marketplace"\n':'');
      fs.writeFileSync(config,text.slice(0,start)+section+(end<0?'':text.slice(end)));return ok('{}');
    }
    if(args.slice(0,2).join(' ')==='plugin add'){
      const root=fs.readFileSync(registry,'utf8'),manifest=JSON.parse(fs.readFileSync(path.join(root,'plugins/pro-flash-orchestrator/.codex-plugin/plugin.json')));
      fs.writeFileSync(installedFile,JSON.stringify({version:manifest.version}));
      const text=fs.readFileSync(config,'utf8'),header='[plugins."pro-flash-orchestrator@pro-flash-local"]';
      const start=text.indexOf(header),end=start<0?-1:text.indexOf('\n[',start+1),section=header+'\nenabled = true\n';
      fs.writeFileSync(config,start<0?text+'\n'+section:text.slice(0,start)+section+(end<0?'':text.slice(end)));
      return ok('{}');
    }
    if(args.slice(0,2).join(' ')==='plugin remove'){fs.writeFileSync(installedFile,'null');return ok('{}');}
    throw new Error('Unexpected mocked CLI command');
  };
  cp.spawn=(bin,args,options)=>{
    if(args[0]!=='app-server')return originalSpawn(bin,args,options);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,encoding,done){
      const value=JSON.parse(chunk.toString());
      if(value.id)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:value.id,result:value.id===1?{}:{data:[{hooks:[]}]}})+'\n'));
      done();
    }});
    child.kill=()=>true;child.unref=()=>{};return child;
  };
  syncBuiltinESMExports();
}
const preload=path.join(temp,'fixture-tools.cjs');
write(preload,'('+mockToolsPrelude.toString()+')();\n');
function rootEntry(f,args,{failGit=false}={}){
  const registry=path.join(f.base,'registry'),calls=path.join(f.base,'calls.jsonl');
  write(registry,f.oldRoot);
  write(registry+'.installed',JSON.stringify(f.state.installed));
  const result=spawnSync(process.execPath,[path.join(root,'scripts/install.mjs'),'--platform','codex',...args],{
    encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,CODEX_HOME:f.home,PRO_STATE_DIR:path.join(f.base,'state'),
      NODE_OPTIONS:'--require '+JSON.stringify(preload),PFO_CODEX_BIN:'codex',PFO_FIXTURE_REGISTRY:registry,PFO_FIXTURE_CALLS:calls,
      PFO_FIXTURE_MARKETPLACE_ROOT:f.gitRoot,PFO_FIXTURE_GIT_FAIL:failGit?'1':'0'}});
  assert.ifError(result.error);
  return {...result,calls:fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse):[]};
}

try {
await test('real Codex CLI rejects different-source add; transactional remove/add migrates and exposes root',async()=>{
  const home=path.join(temp,'real-cli-home'),a=path.join(temp,'real-market-a'),b=path.join(temp,'real-market-b');
  seedMarketplace(a,'0.7.2');seedMarketplace(b,'0.7.3');fs.mkdirSync(home,{recursive:true});
  const env={...process.env,CODEX_HOME:home,HOME:home,USERPROFILE:home};delete env.NODE_OPTIONS;
  const availability=spawnSync('codex',['--version'],{env,encoding:'utf8',timeout:30000,windowsHide:true});
  if(availability.error?.code==='ENOENT'&&!process.argv.includes('--native-probe')&&!process.argv.includes('--native-discovery')){
    skipped++;console.log('SKIP real Codex CLI: not available on this host');return false;
  }
  assert.ifError(availability.error);assert.equal(availability.status,0,availability.stderr);
  const real=(args,{expectedStatus=0}={})=>{
    const out=spawnSync('codex',args,{env,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.ifError(out.error);assert.equal(out.status,expectedStatus,out.stderr);
    console.log('REAL codex '+args.join(' ')+' => exit '+out.status);
    if(expectedStatus!==0)console.log('REAL expected rejection '+out.stderr.trim().slice(0,250));
    return out.stdout;
  };
  console.log('REAL CLI version '+real(['--version']).trim());
  real(['plugin','marketplace','add',a,'--json']);
  real(['plugin','add',setup.PLUGIN_ID,'--json']);
  const state=JSON.parse(real(['plugin','list','--marketplace','pro-flash-local','--json']));
  console.log('REAL installed state '+JSON.stringify(state,(key,value)=>{
    if(['description','shortDescription','suggestedPrompts','interface'].includes(key))return undefined;return value;
  }));
  const config=fs.readFileSync(path.join(home,'config.toml'),'utf8');let section='';
  for(const line of config.split(/\r?\n/)){
    if(line.trim().startsWith('['))section=line.trim();
    if(section.includes('pro-flash')&&line.trim())console.log('REAL owned config '+line);
  }
  const cacheBefore=treeSnapshot(path.join(home,'plugins'));
  const cacheManifests=[...cacheBefore].filter(([file])=>file.replaceAll('\\','/').endsWith('/.codex-plugin/plugin.json'));
  assert(cacheManifests.length>0,'Expected an isolated installed plugin cache manifest');
  console.log('REAL cache manifests '+JSON.stringify(cacheManifests.map(([file,contents])=>({path:path.relative(home,file),version:JSON.parse(contents).version}))));
  real(['plugin','marketplace','remove','pro-flash-local','--json']);
  assert(fs.existsSync(path.join(a,'.agents/plugins/marketplace.json')),'remove deleted local origin');
  assertSnapshot(cacheBefore);
  console.log('REAL marketplace remove preserved local origin and '+cacheBefore.size+' plugin files');
  console.log('REAL installed after marketplace remove '+JSON.stringify(setup.installedPlugin(real(['plugin','list','--json']))));
  real(['plugin','marketplace','add',a,'--json']);
  if(process.argv.includes('--native-discovery'))return;
  real(['plugin','add',setup.PLUGIN_ID,'--json']);
  const configFile=path.join(home,'config.toml'),hookFile=path.join(home,'hooks.json'),controlDir=path.join(home,'plugin-data','pro-flash-orchestrator');
  setEnabled(configFile,false);
  assert.deepEqual(setup.installedPlugin(real(['plugin','list','--json'])),{installed:true,version:'0.7.2',enabled:false});
  writeJson(path.join(controlDir,'config.json'),{workerModel:'gpt-5-mini',custom:'keep'});
  writeJson(path.join(controlDir,'mode.json'),{mode:'off'});
  writeJson(path.join(controlDir,'deployment.json'),{target:a,custom:'keep'});
  setup.connectNativeHooks(path.join(a,pluginPrefix),{hookFile,controlDir});
  const oldHook=bridgeCommand(hookFile),ownedCache=path.join(home,'plugins/cache/pro-flash-local/pro-flash-orchestrator');
  const oldCache=treeSnapshot(ownedCache),oldOrigin=treeSnapshot(a),oldControls=treeSnapshot(controlDir);
  real(['plugin','marketplace','add',b,'--json'],{expectedStatus:1});
  const unchanged=JSON.parse(real(['plugin','marketplace','list','--json'])).marketplaces.find(m=>m.name==='pro-flash-local');
  assert.equal(fs.realpathSync(unchanged.root),fs.realpathSync(a));
  const nativeOptions={source:'local',command:args=>real(args),inspect:async()=>({hooks:[]}),codexDir:home,controlDir,hookFile};
  await assert.rejects(()=>setup.registerMarketplace(b,{...nativeOptions,inspect:async()=>{
    fs.appendFileSync(configFile,'\n[projects.fixture]\ntrust_level = "trusted"\n');
    const hooks=JSON.parse(fs.readFileSync(hookFile));(hooks.hooks.Stop ||= []).push({hooks:[{type:'command',command:'echo concurrent-other'}]});writeJson(hookFile,hooks);
    throw new Error('fixture post-install inspection failure');
  }}),error=>error.message==='fixture post-install inspection failure');
  const recovered=setup.installedPlugin(real(['plugin','list','--json']));
  assert.deepEqual(recovered,{installed:true,version:'0.7.2',enabled:false});
  assertSnapshot(oldCache);assertSnapshot(oldOrigin);assertSnapshot(oldControls);
  assert.equal(treeSnapshot(ownedCache).size,oldCache.size);
  assert.equal(bridgeCommand(hookFile).command,oldHook.command);
  assert(fs.readFileSync(configFile,'utf8').includes('[projects.fixture]'));
  assert(JSON.stringify(JSON.parse(fs.readFileSync(hookFile))).includes('echo concurrent-other'));
  console.log('REAL injected post-install failure restored source A, cache 0.7.2, disabled=false and retained unrelated concurrent config/hooks');
  const transaction=await setup.registerMarketplace(b,nativeOptions);
  assert.equal(fs.realpathSync(transaction.target),fs.realpathSync(b));
  assert.deepEqual(setup.installedPlugin(real(['plugin','list','--json'])),{installed:true,version:'0.7.3',enabled:false});
  const listed=JSON.parse(real(['plugin','marketplace','list','--json']));
  assert(Array.isArray(listed.marketplaces));
  const entry=listed.marketplaces.find(m=>m.name==='pro-flash-local');
  assert.equal(fs.realpathSync(entry.root),fs.realpathSync(b));
  setup.connectNativeHooks(path.join(entry.root,pluginPrefix),{hookFile,controlDir});
  const hook=bridgeCommand(hookFile),before=executeBridge(hook,home);
  assert.equal(before.version,'0.7.3');
  if(process.platform==='win32')assert.equal(executeBridge(hook,home,{windows:true}).version,'0.7.3');
  seedMarketplace(b,'0.7.4');
  const after=executeBridge(hook,home);
  assert.equal(after.version,'0.7.4');assert.equal(after.root,path.join(b,'plugins/pro-flash-orchestrator'));
  assert.equal(before.root,after.root);
  if(process.platform==='win32')assert.equal(executeBridge(hook,home,{windows:true}).version,'0.7.4');
  console.log('REAL stable bridge executed '+before.version+' -> '+after.version+' at '+after.root+'; both exit 0');
});
await test('default standalone source is Git and explicit local/legacy flags parse',()=>{
  assert.equal(parseInstallArgs([]).source,'git');assert.equal(parseInstallArgs(['--local']).source,'local');
  assert.equal(parseInstallArgs(['--uninstall','--dry-run']).uninstall,true);
  assert.throws(()=>parseInstallArgs(['--git','--local']),/either/);
});
await test('Git migration preserves identity and bridges the configured snapshot instead of old ZIP',async()=>{
  const f=fixture('git-success'),unrelated=JSON.parse(fs.readFileSync(f.hookFile)).hooks.Stop[0].hooks[0];
  const verification=fs.readFileSync(path.join(f.controlDir,'worker-verification.json'));
  const result=await setup.registerMarketplace(f.oldRoot,f.options);
  assert.equal(result.plugin,setup.PLUGIN_ID);assert.equal(result.marketplace,'pro-flash-local');assert.equal(result.ref,'codex-marketplace');
  assert.equal(result.target,f.gitRoot);assert.equal(executeBridge(bridgeCommand(f.hookFile),f.home).root,path.join(f.gitRoot,'plugins/pro-flash-orchestrator'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.hookFile)).hooks.Stop[0].hooks[0],unrelated);
  assert(fs.readFileSync(path.join(f.controlDir,'worker-verification.json')).equals(verification));
  assert(f.commands.some(a=>a[3]===setup.MARKETPLACE_URL&&a.includes('--ref')));
  assert(f.commands.some(a=>a.slice(0,3).join(' ')==='plugin marketplace remove'));
  assert(!f.commands.some(a=>a.slice(0,2).join(' ')==='plugin remove'));
});
await test('registered marketplace with only legacy global hooks installs and verifies a native plugin record',async()=>{
  const f=fixture('hook-only-success',{installed:false}),old=fs.readFileSync(path.join(f.oldRoot,pluginPrefix+'scripts/codex-hook.mjs'));
  assert.deepEqual(setup.installedPlugin(f.options.command(['plugin','list','--json'])),{installed:false});
  const result=await setup.registerMarketplace(f.oldRoot,f.options);
  assert.equal(result.source,'git');assert.deepEqual(setup.installedPlugin(f.options.command(['plugin','list','--json'])),{installed:true,version:'0.7.3',enabled:true});
  assert(fs.readFileSync(path.join(f.oldRoot,pluginPrefix+'scripts/codex-hook.mjs')).equals(old));
});
await test('disabled native plugin stays disabled on successful migration',async()=>{
  const f=fixture('disabled-success',{enabled:false});
  await setup.registerMarketplace(f.oldRoot,f.options);
  assert.deepEqual(setup.installedPlugin(f.options.command(['plugin','list','--json'])),{installed:true,version:'0.7.3',enabled:false});
});
await test('post-install failure restores a hook-only state without inventing an old plugin installation',async()=>{
  const f=fixture('hook-only-failure',{installed:false}),before=snapshot(f);
  await assert.rejects(()=>setup.registerMarketplace(f.oldRoot,{...f.options,inspect:async()=>{throw new Error('fixture inspection failure');}}),/fixture inspection failure/);
  assertSnapshot(before);assert.equal(f.state.root,f.oldRoot);
  assert.deepEqual(setup.installedPlugin(f.options.command(['plugin','list','--json'])),{installed:false});
  assert(f.commands.some(args=>args.slice(0,2).join(' ')==='plugin remove'));
});
await test('successful CLI add without an installed record is rejected and rolled back',async()=>{
  const f=fixture('unconfirmed-install',{installed:false}),before=snapshot(f);
  const command=args=>{const output=f.options.command(args);if(args.slice(0,2).join(' ')==='plugin add')f.state.installed=null;return output;};
  await assert.rejects(()=>setup.registerMarketplace(f.oldRoot,{...f.options,command}),/did not confirm/);
  assertSnapshot(before);assert.equal(f.state.root,f.oldRoot);
});
await test('unavailable remote changes no old files or configuration and reports first publication',async()=>{
  const f=fixture('git-unavailable'),before=snapshot(f);f.state.failGit=true;
  await assert.rejects(()=>setup.registerMarketplace(f.oldRoot,f.options),/first stable Release.*--local/);
  assertSnapshot(before);assert(!f.commands.some(a=>a[0]==='plugin'));
});
await test('later plugin failure rolls back the source, hooks, controls and old installation',async()=>{
  const f=fixture('late-failure'),before=snapshot(f);f.state.failPlugin=true;
  await assert.rejects(()=>setup.registerMarketplace(f.oldRoot,f.options),/fixture plugin install failed/);
  assertSnapshot(before);assert.equal(f.state.root,f.oldRoot);
});
await test('rollback retains an unrelated concurrent TOML edit',async()=>{
  const f=fixture('concurrent'),other=fs.readFileSync(f.configFile,'utf8');f.state.failPlugin=true;f.state.concurrent=true;
  await assert.rejects(()=>setup.registerMarketplace(f.oldRoot,f.options),/fixture plugin install failed/);
  const result=fs.readFileSync(f.configFile,'utf8');
  assert(result.includes('[projects.fixture]'));assert(result.includes('trust_level = "trusted"'));
  assert(result.includes('[marketplaces.other]'));assert(result.includes('source = "untouched"'));
  assert(result.includes('source = '+JSON.stringify(f.oldRoot)));assert(other.includes('source_type = "local"'));
});
await test('explicit local registration needs no Git and keeps the existing API target parameter',async()=>{
  const f=fixture('local-success');
  const result=await setup.registerMarketplace(f.oldRoot,{...f.options,source:'local',git:()=>{throw new Error('Local mode must not call Git');}});
  assert.equal(result.source,'local');assert.equal(result.target,f.oldRoot);assert.equal(result.ref,null);
});
await test('actual root CLI default and --git preflight before touching the old local deployment',()=>{
  for(const args of [[],['--git']]){
    const f=fixture('root-fail-'+args.length),before=snapshot(f),out=rootEntry(f,args,{failGit:true});
    assert.equal(out.status,1);assert(out.stderr.includes('first stable Release'));assertSnapshot(before);
    assert.equal(out.calls.length,1);assert.equal(out.calls[0].bin,'git');
  }
});
await test('actual root CLI --git leaves old runtime intact and keeps the new Git deployment target',()=>{
  const f=fixture('root-git-success'),old=fs.readFileSync(path.join(f.oldRoot,pluginPrefix+'scripts/codex-hook.mjs')),out=rootEntry(f,['--git']);
  assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).target,f.gitRoot);
  assert(fs.readFileSync(path.join(f.oldRoot,pluginPrefix+'scripts/codex-hook.mjs')).equals(old));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.controlDir,'deployment.json'))).target,f.gitRoot);
});
await test('actual root CLI --local and --no-register retain local deployment semantics',()=>{
  const local=fixture('root-local'),localOut=rootEntry(local,['--local']);
  assert.equal(localOut.status,0,localOut.stderr);assert(!localOut.calls.some(call=>call.bin==='git'));
  assert(localOut.calls.some(call=>call.args[3]===local.oldRoot));
  const unregistered=fixture('root-no-register'),out=rootEntry(unregistered,['--no-register']);
  assert.equal(out.status,0,out.stderr);assert.equal(out.calls.length,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(unregistered.oldRoot,pluginPrefix+'.codex-plugin/plugin.json'))).version,actualVersion);
});
await test('actual root CLI Git dry-run does not access Git or overwrite local files',()=>{
  const f=fixture('root-dry-run'),before=snapshot(f),out=rootEntry(f,['--git','--dry-run']);
  assert.equal(out.status,0,out.stderr);assert.equal(out.calls.length,0);assertSnapshot(before);
});
await test('publication validates complete native layout, tag versions and protected paths',()=>{
  const files=payload('0.7.3');
  assert.equal(publication.validateMarketplaceFiles(files,'v0.7.3').length,files.length);
  assert.throws(()=>publication.validateMarketplaceFiles(files,'v0.7.4'),/version differ/);
  assert.throws(()=>publication.validateMarketplaceFiles([...files,files[0]],'v0.7.3'),/Duplicate/);
  assert.throws(()=>publication.validateMarketplaceFiles([...files,{to:'../escape',content:''}],'v0.7.3'),/escaping/);
  assert.throws(()=>publication.validateMarketplaceFiles(files.filter(f=>f.to!==pluginPrefix+'skills/pfo-setup/SKILL.md'),'v0.7.3'),/Missing/);
  assert(!files.some(f=>/scripts\/(?:update|check-update-worker)\.mjs$/.test(f.to)));
});
await test('first stable publication publishes a complete root tree using a simulated Git push',()=>{
  const fake=fakePublication(),result=publication.publishCodexMarketplace({tag:'v0.7.3',release:release('v0.7.3'),files:payload('0.7.3'),push:true,git:fake.git,repository:temp});
  assert.equal(result.firstPublish,true);assert.equal(result.published,true);
  assert(fake.index.has('.agents/plugins/marketplace.json'));assert(fake.index.has(pluginPrefix+'.codex-plugin/plugin.json'));
  assert(![...fake.index.keys()].some(k=>k.startsWith('pro-flash-orchestrator-codex/')));
  assert.equal(JSON.parse(fake.index.get('.pfo-release.json')).tag,'v0.7.3');
});
await test('equal and older release reruns cannot downgrade the market branch',()=>{
  for(const version of ['0.7.2','0.7.3']){
    const fake=fakePublication('0.7.3');
    const result=publication.publishCodexMarketplace({tag:'v'+version,release:release('v'+version),files:payload(version),push:true,git:fake.git,repository:temp});
    assert.equal(result.published,false);assert(!fake.calls.some(a=>a[0]==='push'||a[0]==='hash-object'));
  }
  const fake=fakePublication('0.7.2');
  assert(publication.publishCodexMarketplace({tag:'v0.7.3',release:release('v0.7.3'),files:payload('0.7.3'),push:true,git:fake.git,repository:temp}).published);
});
await test('draft/prerelease metadata is skipped and mismatched metadata is rejected before Git',()=>{
  for(const info of [{...release('v0.7.3'),isDraft:true},{...release('v0.7.3'),isPrerelease:true},release('v0.7.3-rc.1')]){
    const fake=fakePublication();
    const result=publication.publishCodexMarketplace({tag:info.tagName,release:info,push:true,git:fake.git});
    assert.equal(result.published,false);assert.equal(fake.calls.length,0);
  }
  assert.throws(()=>publication.publishCodexMarketplace({tag:'v0.7.3',release:release('v0.7.4')}),/matching/);
});
await test('fast-forward race rejection and preview never overwrite a newer branch',()=>{
  const fake=fakePublication('0.7.2',{race:true});
  assert.throws(()=>publication.publishCodexMarketplace({tag:'v0.7.3',release:release('v0.7.3'),files:payload('0.7.3'),push:true,git:fake.git,repository:temp}),/non-fast-forward/);
  assert.equal(fake.state.version,'0.7.2');
  const preview=fakePublication();
  assert(publication.publishCodexMarketplace({tag:'v0.7.3',release:release('v0.7.3'),files:payload('0.7.3'),git:preview.git}).prepared);
  assert(!preview.calls.some(a=>a[0]==='push'||a[0]==='hash-object'));
});
await test('workflow serializes publication after Release and docs leave native UI acceptance pending',()=>{
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');
  assert(workflow.includes('group: codex-marketplace-release'));assert(workflow.includes('cancel-in-progress: false'));
  assert(workflow.indexOf('Publish stable Codex Git marketplace')>workflow.indexOf('Create or update GitHub Release'));
  assert(workflow.includes('--json tagName,isDraft,isPrerelease'));assert(workflow.includes('Release tag and plugin.json version differ'));
  const readme=fs.readFileSync(path.join(root,'adapters/codex/README.md'),'utf8');
  assert(readme.includes('Native-button upgrades have not been live-validated'));assert(readme.includes('node scripts/install.mjs --platform codex --local'));
});
} finally {
  for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('pfo-codex-marketplace-test-'))throw new Error('Invalid fixture cleanup path');
  fs.rmSync(temp,{recursive:true,force:true});
}
console.log('\nCodex marketplace focused results: '+passed+' passed, '+failures.length+' failed, '+skipped+' skipped');
process.exitCode=failures.length?1:0;
