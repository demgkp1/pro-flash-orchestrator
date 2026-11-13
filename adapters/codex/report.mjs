#!/usr/bin/env node
// Set the harness before importing shared state paths from lib.mjs.
process.env.PRO_HARNESS = 'codex';
const { runCli } = await import('./plugins/pro-flash-orchestrator/scripts/report.mjs');
runCli();
