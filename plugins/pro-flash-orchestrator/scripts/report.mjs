#!/usr/bin/env node
/**
 * report.mjs — summarize real guard decisions and estimated context savings (v0.7.0).
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
import { STATE_DIR, LOG_FILE } from './lib.mjs';

export { STATE_DIR, LOG_FILE };

export function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function findLogFiles(stateDir = STATE_DIR) {
  const files = new Set();
  const logFile = stateDir === STATE_DIR ? LOG_FILE : path.join(stateDir, 'decisions.jsonl');
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
        if (row && typeof row === 'object' && !Array.isArray(row) &&
            typeof row.hook === 'string' && typeof row.action === 'string' &&
            !row.test && (!sinceMs || Date.parse(row.ts) >= sinceMs)) {
          rows.push(row);
        }
      } catch {
        /* ignore corrupt line */
      }
    }
  }
  return rows;
}

function count(list) {
  const map = new Map();
  for (const item of list) map.set(item, (map.get(item) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function estimateContextSavings(rows) {
  let savedBytes = 0;
  for (const r of rows) {
    if (r.hook !== 'guard-read-file' || r.mode === 'shadow' || r.mode === 'off' ||
        !['deny', 'slice'].includes(r.action)) continue;
    const bytes = Number(r.bytes);
    const lines = Number(r.lines);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    if (!Number.isFinite(lines) || lines <= 0) {
      if (r.action === 'deny') savedBytes += bytes;
      continue;
    }
    const requested = r.requestedLines !== undefined ? Number(r.requestedLines)
      : Math.min(r.end ?? lines, lines) - (r.start ?? 1) + 1;
    if (!Number.isFinite(requested)) continue;
    const requestedLines = Math.min(lines, Math.max(0, requested));
    const delivered = r.action === 'deny' ? 0 : r.deliveredLines !== undefined
      ? Number(r.deliveredLines) : Math.min(150, requestedLines);
    if (!Number.isFinite(delivered)) continue;
    const savedLines = requestedLines - Math.min(requestedLines, Math.max(0, delivered));
    savedBytes += Math.round(bytes * savedLines / lines);
  }
  return { savedBytes, savedKB: savedBytes / 1024, savedTokens: Math.round(savedBytes / 4) };
}

export function denyLabel(r) {
  const reason = String(r.reason || '');
  const file = r.base || r.path || '?';
  if (r.hook === 'guard-command') {
    if (r.rule === 'thrash-circuit-breaker' || /死循环熔断/.test(String(r.reason || ''))) {
      return `${r.command || '命令'} (死循环熔断)`;
    }
    return r.command || '命令';
  }
  if (r.hook === 'guard-subagent') {
    if (r.subAction === 'list' || /轮询|manage_subagents.*list/.test(reason)) return '轮询拦截 (manage_subagents:list)';
    if (/状态锁|写入失败/.test(reason)) return '派单状态更新失败';
    if (/并发/.test(reason)) return '并发超限拦截 (invoke_subagent)';
    if (/递归|子代理不得|套娃/.test(reason)) return `子代理递归拦截 (${r.tool || 'invoke_subagent'})`;
    return `派单拦截 (${r.tool || 'invoke_subagent'})`;
  }
  if (r.hook === 'guard-write-file') {
    if (r.rule === 'file-conflict' || /并发互斥|锁定修改/.test(reason)) return `同批文件冲突: ${file}`;
    if (r.rule === 'protected-config' || /安全拦截/.test(reason)) return `配置保护: ${file}`;
    if (r.rule === 'parent-unresolved' || /父会话关联缺失/.test(reason)) return `父会话未关联: ${file}`;
    if (r.rule === 'state-update' || /状态锁|写入失败/.test(reason)) return `写入状态更新失败: ${file}`;
    return `直改超限: ${file}`;
  }
  return r.lines === undefined ? file : `${file} (${r.lines} 行)`;
}

function printRoiSummary(rows) {
  console.log('\n策略分布与省流估算（ROI Summary）：');
  const strategies = count(rows.filter((r) => r.hook === 'session-start' && r.strategy)
    .map((r) => r.strategy));
  for (const [strategy, n] of strategies) console.log(`  ${strategy}: ${n}`);
  if (strategies.length === 0) console.log('  暂无启动策略记录。');

  const { savedKB, savedTokens } = estimateContextSavings(rows);
  console.log(`  预估节省主模型上下文：${savedKB.toFixed(1)} KB（约 ${savedTokens.toLocaleString('en-US')} Tokens，按 4 bytes/token 估算）`);
}

export function runCli(args = process.argv) {
  const daysArg = args.indexOf('--days');
  const days = daysArg > -1 ? Number(args[daysArg + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days 必须是大于 0 的有限天数。');
    process.exitCode = 1;
    return;
  }
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = loadDecisions(STATE_DIR, since);

  console.log(`\nPro-Flash 决策报告（最近 ${days} 天，已排除 doctor 自检）\n`);

  if (rows.length === 0) {
    console.log('  没有任何真实决策记录。');
    console.log('  可能是：还没在新会话里用过插件，或 Hook 未生效（请在维护工程运行 node scripts/doctor.mjs）。\n');
    printRoiSummary(rows);
    return;
  }

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
    console.log('\n拦截（Top 8）：');
    for (const [name, n] of count(denies.map(denyLabel)).slice(0, 8)) {
      console.log(`  ${pad(String(name).slice(0, 60), 62)} ${n}`);
    }
  }

  const nudges = rows.filter((r) => r.hook === 'pre-invocation' && r.action === 'inject').length;
  console.log(`\n漂移提醒注入：${nudges} 次`);
  printRoiSummary(rows);

  const shadow = rows.filter((r) => r.mode === 'shadow').length;
  if (shadow > 0) console.log(`其中 shadow 模式（只记录未生效）：${shadow} 条`);

  console.log('\n提示：在维护工程调整 scripts/guard-read-file.mjs 阈值并运行自检，再部署到安装目录。\n');
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isDirectRun) {
  runCli();
}
