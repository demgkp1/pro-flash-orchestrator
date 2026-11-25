#!/usr/bin/env node
import {diagnose,verifyWorker} from './plugins/pro-flash-orchestrator/scripts/codex-setup.mjs';
const result=process.argv.includes('--verify-worker')?verifyWorker():await diagnose();
console.log(JSON.stringify(result,null,2));
if(process.argv.includes('--verify-worker')&&result.status!=='verified')process.exitCode=1;
