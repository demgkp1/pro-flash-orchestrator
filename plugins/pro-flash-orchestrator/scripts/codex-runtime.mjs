#!/usr/bin/env node
/** Codex-only configuration, identity and native package helpers. No secrets are logged. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
export const DEFAULT_WORKER = 'gpt-5-mini';
export function codexHome() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }
export function dataDir() {
  return path.resolve(process.env.PRO_STATE_DIR || process.env.PLUGIN_DATA || path.join(codexHome(), 'plugin-data', 'pro-flash-orchestrator'));
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('Invalid plugin data file: ' + path.basename(file)); }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function workerConfig(dir = dataDir(), taskType = '') {
  const control=path.join(codexHome(),'plugin-data','pro-flash-orchestrator');
  const stored = readJson(path.join(dir, 'config.json')) || readJson(path.join(control,'config.json'), { workerModel: DEFAULT_WORKER, workerReasoningEffort: 'low' });
  const typeModel = taskType === 'research' ? process.env.PRO_RESEARCH_MODEL : taskType === 'self' ? process.env.PRO_SELF_MODEL : '';
  const cfg = { ...stored, ...(typeModel ? { workerModel: typeModel } : {}) };
  if (!/^[a-z0-9][a-z0-9._/-]{0,99}$/i.test(cfg.workerModel || '') ||
      !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(cfg.workerReasoningEffort)) {
    throw new Error('Configure workerModel and workerReasoningEffort in plugin config.json');
  }
  return cfg;
}
/** Read only selected TOML scalar keys; never print the source config or credentials. */
export function tomlScalars(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch(e) { if(e.code === 'ENOENT') return {}; throw e; }
  const values = {}; let section = ''; let multiline = '';
  for (const line of text.split(/\r?\n/)) {
    if (multiline) { if (line.includes(multiline)) multiline = ''; continue; }
    const block = line.match(/^\s*[\w.-]+\s*=\s*("""|''')/);
    if (block) { if (line.split(block[1]).length < 3) multiline = block[1]; continue; }
    const head = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (head) { section = head[1]; continue; }
    const item = line.match(/^\s*([\w.-]+|"[^"]+")\s*=\s*("(?:\\.|[^"])*"|'[^']*'|true|false|\d+)\s*(?:#.*)?$/);
    if (!item) continue;
    const key = item[1].startsWith('"') ? JSON.parse(item[1]) : item[1];
    const v = item[2].startsWith("'") ? item[2].slice(1,-1) : JSON.parse(item[2]);
    values[(section ? section + '.' : '') + key] = v;
  }
  return values;
}
export function configLayers(cwd) {
  const files = [path.join(codexHome(), 'config.toml')];
  if (cwd) {
    const dirs=[];let dir=path.resolve(cwd);let foundRoot=false;
    for(;;){dirs.unshift(dir);if(fs.existsSync(path.join(dir,'.git'))){foundRoot=true;break;}const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}
    files.push(...(foundRoot?dirs:[path.resolve(cwd)]).map(p=>path.join(p,'.codex','config.toml')));
  }
  return files;
}
function secretDigest(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}
function credentialFingerprint(scalars, prefix) {
  const authMode = scalars[prefix + 'requires_openai_auth'] === false ? 'custom' : 'openai';
  const envKey = String(scalars[prefix + 'env_key'] || (authMode === 'openai' ? 'OPENAI_API_KEY' : ''));
  const credentials = [];
  if (envKey) {
    const value = process.env[envKey];
    credentials.push({source:'env',name:envKey,present:typeof value === 'string' && value.length > 0,
      ...(typeof value === 'string' && value.length > 0 ? {digest:secretDigest(value)} : {})});
  }
  if (authMode === 'openai') {
    const authFile = path.join(codexHome(), 'auth.json');
    let auth = null;
    try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); }
    catch(e) { if(e.code !== 'ENOENT') throw new Error('Invalid Codex auth file'); }
    const selected = [];
    const visit = (value, trail = []) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const key of Object.keys(value).sort()) {
        const item = value[key];
        const next = [...trail, key];
        if (/^(?:openai_api_key|api_key|access_token|refresh_token|id_token|account_id)$/i.test(key) &&
            (typeof item === 'string' || typeof item === 'number')) {
          selected.push({key:next.join('.').toLowerCase(),digest:secretDigest(item)});
        } else if (item && typeof item === 'object') visit(item, next);
      }
    };
    visit(auth);
    credentials.push({source:'auth.json',present:Boolean(auth),selected});
  }
  return secretDigest(JSON.stringify(credentials));
}
export function providerIdentity(cwd) {
  const scalars = Object.assign({}, ...configLayers(cwd).map(tomlScalars));
  const provider = scalars.model_provider || 'openai';
  const prefix = 'model_providers.' + provider + '.';
  const identity = { provider, baseUrl: scalars[prefix + 'base_url'] || '', wireApi: scalars[prefix + 'wire_api'] || 'responses',
    authMode: scalars[prefix + 'requires_openai_auth'] === false ? 'custom' : 'openai',
    authSource: scalars[prefix + 'env_key'] || '', credentialFingerprint:credentialFingerprint(scalars,prefix) };
  return { provider, fingerprint: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}
export function verificationStatus(cfg, cwd, dir = dataDir()) {
  const proof = readJson(path.join(dir, 'worker-verification.json')) || readJson(path.join(codexHome(),'plugin-data','pro-flash-orchestrator','worker-verification.json'));
  const identity = providerIdentity(cwd);
  const verified = proof?.status === 'verified' && proof.workerModel === cfg.workerModel &&
    proof.workerReasoningEffort === cfg.workerReasoningEffort && proof.providerFingerprint === identity.fingerprint;
  return { verified, proof, ...identity };
}
export function agentOverride(name, cwd) {
  if (!name) return null;
  const layers=configLayers(cwd);const normalized=String(name);
  const prefixes=[`agents.${normalized}.`,`agents."${normalized.replace(/"/g,'\\"')}".`];
  const fields={};
  for(const file of layers) {
    const data=tomlScalars(file);
    for(const prefix of prefixes) for(const key of ['config_file','model','model_reasoning_effort']) {
      if(Object.prototype.hasOwnProperty.call(data,prefix+key)) fields[key]={value:data[prefix+key],file};
    }
  }
  if(Object.keys(fields).length) {
    let profile={};let configFile='';
    if(typeof fields.config_file?.value === 'string' && fields.config_file.value) {
      const configured=fields.config_file.value;
      configFile=configured === '~' ? os.homedir() : configured.startsWith('~/') || configured.startsWith('~\\')
        ? path.join(os.homedir(),configured.slice(2)) : path.isAbsolute(configured)
          ? path.normalize(configured) : path.resolve(path.dirname(fields.config_file.file),configured);
      const data=tomlScalars(configFile);
      profile={model:data.model,effort:data.model_reasoning_effort};
    }
    if(fields.model)profile.model=fields.model.value;
    if(fields.model_reasoning_effort)profile.effort=fields.model_reasoning_effort.value;
    return {...profile,defined:true,...(configFile?{configFile}:{})};
  }
  const dirs=layers.map(file=>path.join(path.dirname(file),'agents'));
  let matched=null;
  for (const dir of dirs) {
    if(!fs.existsSync(dir)) continue;
    for(const item of fs.readdirSync(dir, {withFileTypes:true})) {
      if(!item.isFile() || !item.name.endsWith('.toml')) continue;
      const data = tomlScalars(path.join(dir,item.name));
      if(data.name === name) matched={model:data.model,effort:data.model_reasoning_effort,defined:true,configFile:path.join(dir,item.name)};
    }
  }
  return matched;
}
export function transcriptIdentity(file) {
  if(!file || !fs.existsSync(file)) return null;
  const fd = fs.openSync(file,'r'); let text;
  try { const b=Buffer.alloc(65536); const n=fs.readSync(fd,b,0,b.length,0); text=b.toString('utf8',0,n); }
  finally { fs.closeSync(fd); }
  for(const line of text.split(/\r?\n/).slice(0,10)) {
    let event; try {event=JSON.parse(line);} catch {continue;}
    if(event.type !== 'session_meta') continue;
    const m=event.payload || {};
    const spawn=m.source?.subagent?.thread_spawn || m.source?.subagent?.threadSpawn;
    return { id:m.id, parent:spawn?.parent_thread_id || spawn?.parentThreadId || m.parent_thread_id || '',
      sub:Boolean(spawn || (m.source && typeof m.source === 'object' && m.source.subagent)) };
  }
  return null;
}
export function sessionIdentity(raw) {
  const meta=transcriptIdentity(raw.transcript_path);
  const parent=raw.parentConversationId || raw.parent_session_id || meta?.parent || '';
  const explicit=raw.agent_id && raw.agent_id !== raw.session_id ? String(raw.agent_id) : '';
  const sub=Boolean(parent || meta?.sub || raw.is_subagent || explicit);
  const root=String(parent || raw.session_id || meta?.id || 'unknown');
  const id=String(explicit || (sub && meta?.id) || raw.session_id || meta?.id || 'unknown');
  return { sub,root,id, conversationId:sub ? root + ':sub:' + id : root };
}
export function nativeManifest(original) {
  return { $schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name:original.name,version:original.version,description:'Native Codex model orchestration and lifecycle guards.',
    license:original.license,repository:original.repository,homepage:original.homepage,
    keywords:['codex','orchestration'] };
}
export function marketplace() {
  return {name:'pro-flash-local',interface:{displayName:'Pro-Flash Orchestrator'},
    plugins:[{name:'pro-flash-orchestrator',source:{source:'local',path:'./plugins/pro-flash-orchestrator'},
      policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
}
export function redact(text) {
  return String(text).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi,'[REDACTED]')
    .replace(/((?:["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1[REDACTED]');
}
