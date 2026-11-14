#!/usr/bin/env node
/**
 * SessionStart hook (v0.7.0)
 *
 * Injects the role + red lines ONCE per conversation as a persistent
 * `systemMessage` (one copy in the trajectory, re-sent each turn), and renders a
 * status card to the user through `renderInfo` (UI only, zero model tokens).
 *
 * It must not fire inside a sub-agent: a flash worker told "you are Argon the
 * architect" would start delegating (and gets blocked by guard-subagent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR, currentMode, detectModelCapabilities, getHarness, isNativeOrchestrator, isSubAgent, logDecision, output, pruneStaleSessions, readPayload, readUpdateNotice, setContext, targetWorkerModel, updateSession } from './lib.mjs';

const RULES = '[Pro-Flash Orchestrator Active]';
const DOCTOR = fs.existsSync(path.join(PLUGIN_DIR, 'scripts', 'doctor.mjs'))
  ? 'node scripts/doctor.mjs' : '在维护工程运行 node scripts/doctor.mjs';

const CARD = [
  '**Pro-Flash Orchestrator v0.7.0 已接管本会话**',
  '',
  '| 守门 | 行为 |',
  '| --- | --- |',
  '| 派单守门 | `pro`→`flash` 降级、追加契约、阻断套娃、拦截 `manage_subagents` 轮询 |',
  '| 读取守门 | 大代码自动切片；长文档拦截；Audit 允许 ≤80 行切片按额度连读抽检 |',
  '| 写入守门 | 拦截连续直改 ≥3 个源码文件，强制外派 Flash |',
  '| 命令守门 | 拦截 `cat` 超大文件与无界 `git log` |',
  '| 漂移与唤醒 | 长会话新轮次瞬态唤醒，去重切片精准告警 |',
  '',
  `> 关闭：\`PRO_MODE=off\`　试运行：\`PRO_MODE=shadow\`　体检：${DOCTOR}　复盘：\`node scripts/report.mjs\``,
].join('\n');

const payload = readPayload();
setContext(payload);
pruneStaleSessions();
const mode = currentMode();

if (mode === 'off') {
  output({});
} else if (isSubAgent(payload)) {
  // A sub-agent must not be re-branded as the architect.
  logDecision({ hook: 'session-start', action: 'skip-subagent', mode });
  output({});
} else {
  const harness = getHarness();
  const capabilities = harness === 'antigravity' ? detectModelCapabilities(payload) : null;
  const strategy = capabilities?.strategy || 'strict-worker';
  const worker = targetWorkerModel(harness, 'self', payload);
  const researcher = targetWorkerModel(harness, 'research', payload);
  const relaxed = strategy === 'flash-main-relaxed';
  const native = isNativeOrchestrator(payload);
  const reads = relaxed ? 6 : 3;
  const writes = relaxed ? 4 : 2;
  updateSession(payload.conversationId || 'unknown', (state) => {
    state.strategy = strategy;
    state.maxReadsAllowed = state.phase === 'audit' ? Math.max(reads, state.maxReadsAllowed || reads) : reads;
  });
  let card = CARD.replace('`pro`→`flash`', `\`pro\`→\`${worker}\``)
    .replace('强制外派 Flash', `推荐外派 ${worker}`);
  if (native) {
    card = card.replace('已接管本会话', '已启用 Lite Guard Mode')
      .replace(/\| 写入守门 \|[^\n]+/, '| 写入守门 | 原生 Orchestrator 自主读写编排，豁免文件数量拦截 |')
      .replace(/\| 读取守门 \|[^\n]+/, '| 读取守门 | 豁免文件数量拦截；保留超大文件切片保护 |');
  } else if (relaxed) {
    card = card.replace('已接管本会话', '已启用 Flash 主模型宽松策略')
      .replace(/\| 写入守门 \|[^\n]+/, '| 写入守门 | Flash 主模型可直改最多 4 个源码文件 |')
      .replace(/\| 读取守门 \|[^\n]+/, '| 读取守门 | Flash 主模型可读取最多 6 个文件；保留大文件与 Audit 切片保护 |');
  }
  const isHydrogen = strategy === 'hydrogen-main' || worker === 'inherit';
  const routing = isHydrogen
    ? `策略：${strategy}；推荐 invoke_subagent(TypeName="research", Model="${researcher}") / invoke_subagent(TypeName="self", Model="inherit")（继承主会话的 Gemini 4 Hydrogen）。`
    : `策略：${strategy}；推荐 invoke_subagent(TypeName="research", Model="${researcher}") / invoke_subagent(TypeName="self", Model="${worker}")。`;
  const policy = native ? 'Lite Guard Mode：文件数量限制豁免，保留切片、命令、防嵌套与派单契约。'
    : `主模型普通读取配额 ${reads} 个文件，源码直改上限 ${writes} 个文件；Audit 切片额度另行计算。`;
  card += `\n\n${routing}\n\n${policy}`;
  const updateNotice = readUpdateNotice(payload);
  if (updateNotice) {
    card += `\n\n---\n🔔 **发现新版本 v${updateNotice.latestVersion}**（当前 v${updateNotice.currentVersion}）：终端运行 \`${updateNotice.updateCommand}\` 一键更新精简包，或[前往 Releases 下载覆盖](${updateNotice.releaseUrl})`;
  }
  logDecision({ hook: 'session-start', action: mode === 'shadow' ? 'shadow-pass' : 'inject', mode, strategy, worker });
  if (mode === 'shadow') {
    output({});
  } else {
    output({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: `${RULES} ${routing} ${policy}`,
            // IMPORTANT: do NOT use metadata.user_markdown here. In the current
            // Antigravity build the adapter panics with
            // "type mismatch: cannot convert string to message" and discards the
            // whole hook result (verified against language_server 2026-11-06).
            // renderInfo is the supported way to render a card to the user.
            renderInfo: {
              title: 'Pro-Flash Orchestrator v0.7.0',
              titlePrefix: native ? '轻量护栏' : relaxed ? '宽松策略' : '已接管',
              markdown: card,
            },
          },
        },
      ],
    });
  }
}
