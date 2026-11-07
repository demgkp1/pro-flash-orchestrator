#!/usr/bin/env node
/**
 * PreInvocation hook (v0.3) — drift detector, not a per-turn nag.
 *
 * The old version repeated the same paragraph before every model call. That is
 * quadratic: N copies live in the trajectory and are re-sent on every later
 * turn. This version stays silent by default and only speaks when the transcript
 * shows one of two real problems:
 *
 *   1. drift      — the agent keeps writing/editing files and never dispatches;
 *   2. pressure   — the transcript is large enough that /compact is worth it
 *                   (shown to the user only, via renderInfo).
 *
 * Both are rate-limited per conversation.
 */
import fs from 'node:fs';
import {
  currentMode,
  isSubAgent,
  lastUserInput,
  logDecision,
  output,
  readPayload,
  readSession,
  readTail,
  setContext,
  writeSession,
} from './lib.mjs';

const NAG_COOLDOWN = 6; // invocations between two drift nudges
const WARN_COOLDOWN = 10; // invocations between two compaction warnings
const PRESSURE_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const WRITE_TOOL_CALL_RE = /"name"\s*:\s*"(?:write_file|write_to_file|edit_file|multi_replace_file_content|replace_file_content)"/g;
const DISPATCH_TOOL_CALL_RE = /"name"\s*:\s*"invoke_subagent"/;

const payload = readPayload();
setContext(payload);
const mode = currentMode();
const conversationId = payload.conversationId || 'unknown';
const invocationNum = Number(payload.invocationNum || 0);
const currentModel = String(payload.modelName || '').toLowerCase();
const isCurrentModelFlash = currentModel.includes('flash');

if (mode === 'off' || isSubAgent(payload)) {
  output({});
} else {
  const steps = [];
  const state = readSession(conversationId);
  const transcriptPath = String(payload.transcriptPath || '');

  let transcriptBytes = 0;
  if (transcriptPath) {
    try {
      transcriptBytes = fs.statSync(transcriptPath).size;
    } catch {
      transcriptBytes = 0;
    }
  }

  /* ---------------------------------------------------------- drift check */
  if (transcriptBytes > 0 && !isCurrentModelFlash) {
    try {
      const tail = readTail(transcriptPath, TAIL_BYTES);
      const lines = tail.split(/\r?\n/).filter(Boolean).slice(-400);
      let writes = 0;
      for (const line of lines) {
        let isPlanner = true;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object' && obj.source && obj.source !== 'MODEL' && obj.type !== 'PLANNER_RESPONSE') {
            isPlanner = false;
          }
          if (obj && typeof obj === 'object' && Array.isArray(obj.tool_calls)) {
            for (const tc of obj.tool_calls) {
              const name = String((tc && tc.name) || '');
              if (name === 'invoke_subagent') {
                writes = 0;
              } else if (
                name === 'write_file' ||
                name === 'write_to_file' ||
                name === 'edit_file' ||
                name === 'multi_replace_file_content' ||
                name === 'replace_file_content'
              ) {
                writes += 1;
              }
            }
            continue;
          }
          if (obj && typeof obj === 'object' && obj.toolCall && typeof obj.toolCall === 'object') {
            const name = String(obj.toolCall.name || '');
            if (name === 'invoke_subagent') {
              writes = 0;
            } else if (
              name === 'write_file' ||
              name === 'write_to_file' ||
              name === 'edit_file' ||
              name === 'multi_replace_file_content' ||
              name === 'replace_file_content'
            ) {
              writes += 1;
            }
            continue;
          }
        } catch {
          /* fallback for truncated JSONL lines */
        }
        if (!isPlanner) continue;
        if (!line.includes('"tool_calls"') && !line.includes('"toolCall"')) continue;
        if (DISPATCH_TOOL_CALL_RE.test(line)) {
          writes = 0;
        } else {
          const matches = line.match(WRITE_TOOL_CALL_RE);
          if (matches) writes += matches.length;
        }
      }
      const cooled = invocationNum - Number(state.lastNagInvocation || -999) >= NAG_COOLDOWN;
      if (writes >= 4 && cooled) {
        state.lastNagInvocation = invocationNum;
        steps.push({
          ephemeralMessage: `[Pro] 自上次派单以来你已连续 ${writes} 次直接改文件。机械部分请外派 invoke_subagent(TypeName="self", Model="flash")，你只保留架构与审核。`,
        });
      }
    } catch {
      /* unreadable transcript: stay silent */
    }
  }

  /* ------------------------------------------------------- pressure check */
  const warnCooled = invocationNum - Number(state.lastWarnInvocation || -999) >= WARN_COOLDOWN;
  if (transcriptBytes >= PRESSURE_BYTES && warnCooled) {
    state.lastWarnInvocation = invocationNum;
    const mb = (transcriptBytes / (1024 * 1024)).toFixed(1);
    steps.push({
      systemMessage: {
        systemMessage: '',
        renderInfo: {
          title: 'Pro-Flash 上下文预警',
          titlePrefix: '提醒',
          markdown: `⚠️ **上下文预警**：本会话转录已达 ${mb} MB，后续每轮都会重发这部分。建议在当前功能交付后执行 \`/compact\` 压缩上下文。`,
        },
      },
    });
  }

  if (steps.length > 0) {
    logDecision({
      hook: 'pre-invocation',
      action: 'inject',
      mode,
      steps: steps.length,
      transcriptMB: Number((transcriptBytes / (1024 * 1024)).toFixed(2)),
      userInput: lastUserInput(payload).slice(0, 80),
    });
    writeSession(conversationId, state);
    if (mode === 'enforce') output({ injectSteps: steps });
    else output({});
  } else {
    output({});
  }
}
