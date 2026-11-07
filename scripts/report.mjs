#!/usr/bin/env node
/**
 * report.mjs — summarize what the guards actually did in real sessions (v0.3).
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
export const STATE_DIR = path.join(path.dirname(SCRIPT_DIR), '.state');
export const LOG_FILE = path.join(STATE_DIR, 'decisions.jsonl');

export function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function findLogFiles(stateDir = STATE_DIR) {
  const files = new Set();
  const logFile = path.join(stateDir, 'decisions.jsonl');
  const rot1 = path.join(stateDir, 'decisions.1.jsonl');
  const rot2 = `${logFile}.1`;

  if (fs.existsSync(logFile)) files.add(logFile);
  if (fs.existsSync(rot1)) files.add(rot1);
  if (fs.existsSync(rot2)) files.add(rot2);

  try {
    const entries = fs.readdirSync(stateDir);
    for (const entry of entries) {
      if (entry.startsWith('decisions.archive-') && entry.endsWith('.jsonl')) {
        files.add(path.join(stateDir, entry));
      }
    }
  } catch {
    /* ignore readdir error */
  }
  return [...files];
}

export function loadDecisions(stateDir = STATE_DIR, sinceMs = 0) {
  const logFiles = findLogFiles(stateDir);
  const rows = [];
  for (const f of logFiles) {
    const lines = readLines(f);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && !row.test && (!sinceMs || Date.parse(row.ts) >= sinceMs)) {
          rows.push(row);
        }
      } catch {
        /* ignore corrupt line */
      }
    }
  }
  return rows;
}

export function runCli(args = process.argv) {
  const daysArg = args.indexOf('--days');
  const days = daysArg > -1 ? Number(args[daysArg + 1]) || 7 : 7;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = loadDecisions(STATE_DIR, since);

  console.log(`\nPro-Flash 决策报告（最近 ${days} 天，已排除 doctor 自检）\n`);

  if (rows.length === 0) {
    console.log('  没有任何真实决策记录。');
    console.log('  可能是：还没在新会话里用过插件，或 Hook 未生效（先跑 node scripts/doctor.mjs）。\n');
    return;
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
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isDirectRun) {
  runCli();
}
