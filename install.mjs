#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function parseInstallArgs(args) {
  const options={source:'git',ref:'codex-marketplace',uninstall:false,dryRun:false};
  let explicitSource=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--local'||args[i]==='--git'){
      const source=args[i].slice(2);
      if(explicitSource&&explicitSource!==source)throw new Error('Choose either --git or --local');
      explicitSource=options.source=source;
    } else if(args[i]==='--ref'){
      if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('--ref requires a branch');
      options.ref=args[++i];
    } else if(args[i]==='--uninstall')options.uninstall=true;
    else if(args[i]==='--dry-run')options.dryRun=true;
    else throw new Error('Unknown install argument: '+args[i]);
  }
  return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.dirname(fileURLToPath(import.meta.url)),options=parseInstallArgs(process.argv.slice(2));
  if(options.dryRun)console.log(JSON.stringify({target:root,...options,action:options.uninstall?'uninstall':'register'},null,2));
  else {
    const {registerMarketplace,unregisterMarketplace}=await import('./plugins/pro-flash-orchestrator/scripts/codex-setup.mjs');
    console.log(JSON.stringify(await (options.uninstall?unregisterMarketplace(root):registerMarketplace(root,options)),null,2));
  }
}
