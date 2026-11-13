#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerMarketplace,unregisterMarketplace} from './plugins/pro-flash-orchestrator/scripts/codex-setup.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
if(process.argv.includes('--dry-run'))console.log(JSON.stringify({target:root,action:process.argv.includes('--uninstall')?'uninstall':'register',dryRun:true},null,2));
else console.log(JSON.stringify(await (process.argv.includes('--uninstall')?unregisterMarketplace(root):registerMarketplace(root)),null,2));
