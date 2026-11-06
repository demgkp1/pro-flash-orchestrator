#!/usr/bin/env node
/**
 * report.mjs — summarize what the guards actually did in real sessions.
 *
 * Doctor runs tag their entries with ARGON_TEST=1, so this report only shows
 * production decisions. Use it to tune thresholds with data instead of guesses.
 *
 *   node scripts/report.mjs            # last 7 days
 *   node scripts/report.mjs --days 30
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(path.dirname(SCRIPT_DIR), '.state');
const LOG_FILE = path.join(STATE_DIR, 'decisions.jsonl');

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;
const since = Date.now() - days * 24 * 60 * 60 * 1000;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const rows = [...readLines(`${LOG_FILE}.1`), ...readLines(LOG_FILE)]
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((row) => row && !row.test && Date.parse(row.ts) >= since);

console.log(`\nPro-Flash 决策报告（最近 ${days} 天，已排除 doctor 自检）\n`);

if (rows.length === 0) {
  console.log('  没有任何真实决策记录。');
  console.log('  可能是：还没在新会话里用过插件，或 Hook 未生效（先跑 node scripts/doctor.mjs）。\n');
  process.exit(0);
}

const count = (list) => {
  const map = new Map();
  for (const item of list) map.set(item, (map.get(item) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

const pad = (value, width) => String(value).padEnd(width);

console.log(`共 ${rows.length} 条决策，涉及 ${new Set(rows.map((r) => r.conv).filter(Boolean)).size} 个会话\n`);

console.log('按 Hook / 动作：');
for (const [name, n] of count(rows.map((r) => `${r.hook}/${r.action}`))) {
  console.log(`  ${pad(name, 34)} ${n}`);
}

const rewrites = rows.filter((r) => r.action === 'rewrite' && r.from !== r.to);
if (rewrites.length > 0) {
  console.log('\n模型降级（真实发生的）：');
  for (const [name, n] of count(rewrites.map((r) => `${r.from} → ${r.to}`))) {
    console.log(`  ${pad(name, 34)} ${n}`);
  }
}

const slices = rows.filter((r) => r.action === 'slice');
if (slices.length > 0) {
  console.log('\n被自动切片的文件（Top 8）：');
  for (const [name, n] of count(slices.map((r) => `${r.base} (${r.lines} 行)`)).slice(0, 8)) {
    console.log(`  ${pad(name, 44)} ${n}`);
  }
}

const denies = rows.filter((r) => r.action === 'deny');
if (denies.length > 0) {
  const label = (r) => {
    if (r.hook === 'guard-command') return r.command || '命令';
    if (r.hook === 'guard-subagent') return `子代理递归（${r.tool || 'invoke_subagent'}）`;
    return `${r.base || r.path || '?'} (${r.lines ?? '?'} 行)`;
  };
  console.log('\n拦截（Top 8）：');
  for (const [name, n] of count(denies.map(label)).slice(0, 8)) {
    console.log(`  ${pad(String(name).slice(0, 60), 62)} ${n}`);
  }
}

const nudges = rows.filter((r) => r.hook === 'pre-invocation' && r.action === 'inject').length;
console.log(`\n漂移提醒注入：${nudges} 次`);

const shadow = rows.filter((r) => r.mode === 'shadow').length;
if (shadow > 0) console.log(`其中 shadow 模式（只记录未生效）：${shadow} 条`);

console.log('\n提示：阈值在 scripts/guard-read-file.mjs 顶部；改完跑 node scripts/doctor.mjs。\n');
