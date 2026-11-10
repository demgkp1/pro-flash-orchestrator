#!/usr/bin/env node
/**
 * SessionStart hook (v0.5.0)
 *
 * Injects the role + red lines ONCE per conversation as a persistent
 * `systemMessage` (one copy in the trajectory, re-sent each turn), and renders a
 * status card to the user through `renderInfo` (UI only, zero model tokens).
 *
 * It must not fire inside a sub-agent: a flash worker told "you are Argon the
 * architect" would start delegating (and gets blocked by guard-subagent).
 */
import { currentMode, isSubAgent, logDecision, output, pruneStaleSessions, readPayload, setContext } from './lib.mjs';

const RULES = '[Pro-Flash Orchestrator Active]';

const CARD = [
  '**Pro-Flash Orchestrator v0.5.0 已接管本会话**',
  '',
  '| 守门 | 行为 |',
  '| --- | --- |',
  '| 派单守门 | `pro`→`flash` 降级、追加契约、阻断套娃、拦截 `manage_subagents` 轮询 |',
  '| 读取守门 | 大代码自动切片；长文档拦截；拦截切片连读 ≥4 个文件 |',
  '| 写入守门 | 拦截连续直改 ≥3 个源码文件，强制外派 Flash |',
  '| 命令守门 | 拦截 `cat` 超大文件与无界 `git log` |',
  '| 漂移与唤醒 | 长会话新轮次瞬态唤醒，去重切片精准告警 |',
  '',
  '> 关闭：`PRO_MODE=off`　试运行：`PRO_MODE=shadow`　体检：`node scripts/doctor.mjs`　复盘：`node scripts/report.mjs`',
].join('\n');

const payload = readPayload();
setContext(payload);
pruneStaleSessions();
const mode = currentMode();

if (mode === 'off') {
  output({});
} else if (mode === 'shadow') {
  logDecision({ hook: 'session-start', action: 'shadow-pass', mode });
  output({});
} else if (isSubAgent(payload)) {
  // A sub-agent must not be re-branded as the architect.
  logDecision({ hook: 'session-start', action: 'skip-subagent', mode });
  output({});
} else {
  logDecision({ hook: 'session-start', action: 'inject', mode });
  output({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: RULES,
          // IMPORTANT: do NOT use metadata.user_markdown here. In the current
          // Antigravity build the adapter panics with
          // "type mismatch: cannot convert string to message" and discards the
          // whole hook result (verified against language_server 2026-11-06).
          // renderInfo is the supported way to render a card to the user.
          renderInfo: {
            title: 'Pro-Flash Orchestrator v0.5.0',
            titlePrefix: '已接管',
            markdown: CARD,
          },
        },
      },
    ],
  });
}
