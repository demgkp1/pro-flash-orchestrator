#!/usr/bin/env node
/** Read-only app-server protocol queries. Never changes hook trust. */
import {spawn} from 'node:child_process';
import {redact} from './codex-runtime.mjs';
export async function inspectNative({cwd,models=false,timeout=20000}={}) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(process.env.PFO_CODEX_BIN || 'codex',['app-server','--stdio'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let pending='',stderr='',settled=false;const replies={};
    const timer=setTimeout(()=>finish(new Error('Native Codex inspection timed out')),timeout);
    function send(value){child.stdin.write(JSON.stringify(value)+'\n');}
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();child.kill();child.unref();if(error)reject(error);else resolve(value);}
    child.on('error',e=>finish(e));
    child.on('exit',code=>{if(!settled)finish(new Error('Native inspection exited: '+code+' '+redact(stderr).slice(0,250)));});
    child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-3000);});
    child.stdout.on('data',b=>{
      pending+=b.toString();let end;
      while((end=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,end);pending=pending.slice(end+1);
        let r;try{r=JSON.parse(line);}catch{continue;}
        if(r.error){finish(new Error(redact(r.error.message || 'Native inspection failed')));return;}
        if(r.id===1){send({method:'initialized'});send({id:2,method:'hooks/list',params:{cwds:[cwd]}});if(models)send({id:3,method:'model/list',params:{limit:100,includeHidden:true}});}
        if(r.id===2||r.id===3)replies[r.id]=r.result;
        if(replies[2]&&(!models||replies[3])){
          const entries=replies[2].data||[];
          const hooks=entries.flatMap(e=>e.hooks||[]).filter(h=>String(h.pluginId || '').startsWith('pro-flash-orchestrator') || String(h.sourcePath || '').includes('pro-flash-orchestrator') || String(h.command || '').includes('PFO_NATIVE_BRIDGE'));
          const catalog=(replies[3]?.data||[]).map(m=>({id:m.id,model:m.model,displayName:m.displayName,supportedReasoningEfforts:m.supportedReasoningEfforts}));
          finish(null,{hooks,errors:entries.flatMap(e=>e.errors||[]).map(e=>({path:e.path,message:redact(e.message)})),models:catalog});
        }
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'pfo_diagnostics',title:'Pro-Flash read-only diagnostics',version:'0.6.1'},capabilities:{experimentalApi:true}}});
  });
}
