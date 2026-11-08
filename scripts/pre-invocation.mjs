#!/usr/bin/env node
/**
 * PreInvocation hook (v0.3.2) — turn-boundary wake-up + deduplicated drift detector.
 *
 * Key guarantees:
 *   1. Uses `globalStep` (transcript step_index / line count) and turn-reset
 *      detection instead of per-turn `invocationNum`, so cooldown never locks.
 *   2. Uses deduplicated, exempt-filtered `state.readsSinceDispatch` and
 *      `state.writesSinceDispatch` tracked by `guard-read-file` / `guard-write-file`
 *      (with transcript fallback for write calls), avoiding false positives when
 *      the main agent reads two slices of the same file or reads exempt logs.
 *   3. Injects a 1-line transient `ephemeralMessage` on new user turns once
 *      `globalStep >= 8`, preventing attention dilution in 100+ step sessions
 *      with zero permanent trajectory growth.
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

const NAG_STEP_COOLDOWN = 4; // minimum transcript steps between two drift nudges
const WARN_STEP_COOLDOWN = 12; // minimum transcript steps between compaction warnings
const WAKEUP_MIN_STEPS = 8; // start turn-boundary ephemeral wake-ups after early turns
const PRESSURE_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const WRITE_TOOL_CALL_RE = /"name"\s*:\s*"(?:write_file|write_to_file|edit_file|multi_replace_file_content|replace_file_content)"/g;
const DISPATCH_TOOL_CALL_RE = /"name"\s*:\s*"(?:invoke_subagent|send_message)"/;

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
  const userInput = lastUserInput(payload).trim();

  let transcriptBytes = 0;
  if (transcriptPath) {
    try {
      transcriptBytes = fs.statSync(transcriptPath).size;
    } catch {
      transcriptBytes = 0;
    }
  }

  /* ---------------------------------------- scan transcript tail & steps */
  let transcriptWrites = 0;
  let globalStep = 0;

  if (transcriptBytes > 0 && !isCurrentModelFlash) {
    try {
      const tail = readTail(transcriptPath, TAIL_BYTES);
      const lines = tail.split(/\r?\n/).filter(Boolean).slice(-400);
      globalStep = lines.length;

      for (const line of lines) {
        let isPlanner = true;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object') {
            if (Number.isFinite(Number(obj.step_index))) {
              globalStep = Math.max(globalStep, Number(obj.step_index));
            }
            if (obj.source && obj.source !== 'MODEL' && obj.type !== 'PLANNER_RESPONSE') {
              isPlanner = false;
            }
            if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
              for (const tc of obj.tool_calls) {
                const name = String((tc && tc.name) || '');
                if (name === 'invoke_subagent' || name === 'send_message') {
                  transcriptWrites = 0;
                } else if (
                  name === 'write_file' ||
                  name === 'write_to_file' ||
                  name === 'edit_file' ||
                  name === 'multi_replace_file_content' ||
                  name === 'replace_file_content'
                ) {
                  transcriptWrites += 1;
                }
              }
              continue;
            }
            if (obj.toolCall && typeof obj.toolCall === 'object') {
              const name = String(obj.toolCall.name || '');
              if (name === 'invoke_subagent' || name === 'send_message') {
                transcriptWrites = 0;
              } else if (
                name === 'write_file' ||
                name === 'write_to_file' ||
                name === 'edit_file' ||
                name === 'multi_replace_file_content' ||
                name === 'replace_file_content'
              ) {
                transcriptWrites += 1;
              }
              continue;
            }
            if (
              isPlanner &&
              Array.isArray(obj.truncated_fields) &&
              obj.truncated_fields.includes('tool_calls')
            ) {
              transcriptWrites += 1;
              continue;
            }
          }
        } catch {
          /* fallback for partial JSONL lines */
        }
        if (!isPlanner) continue;
        if (!line.includes('"tool_calls"') && !line.includes('"toolCall"') && !line.includes('"truncated_fields"')) {
          continue;
        }
        if (DISPATCH_TOOL_CALL_RE.test(line)) {
          transcriptWrites = 0;
        } else {
          const writeMatches = line.match(WRITE_TOOL_CALL_RE);
          if (writeMatches) transcriptWrites += writeMatches.length;
          else if (line.includes('"truncated_fields"') && line.includes('"tool_calls"')) transcriptWrites += 1;
        }
      }
    } catch {
      /* unreadable transcript: stay silent */
    }
  }

  /* ------------------------------------ 1. new user turn boundary wakeup */
  const isNewUserTurn = Boolean(userInput && userInput !== state.lastUserInput);
  if (isNewUserTurn) {
    state.lastUserInput = userInput;
    state.readsSinceDispatch = [];
    state.writesSinceDispatch = [];
  }

  // Prefer deduplicated, exempt-filtered file lists from guard-read-file / guard-write-file
  const distinctReads = Array.isArray(state.readsSinceDispatch) ? state.readsSinceDispatch.length : 0;
  const stateWrites = Array.isArray(state.writesSinceDispatch)
    ? state.writesSinceDispatch.length
    : Number(state.writesSinceDispatch || 0);
  const writes = Math.max(stateWrites, transcriptWrites);
  const reads = distinctReads;

  const lastNagStep = Number(state.lastNagStep ?? -999);
  const stepDelta = globalStep >= lastNagStep ? globalStep - lastNagStep : NAG_STEP_COOLDOWN;
  const invReset = invocationNum > 0 && invocationNum < Number(state.lastNagInvocation || 0);
  const cooled = stepDelta >= NAG_STEP_COOLDOWN || invReset || isNewUserTurn;

  if (!isCurrentModelFlash && isNewUserTurn && globalStep >= WAKEUP_MIN_STEPS && writes < 3) {
    state.lastNagStep = globalStep;
    state.lastNagInvocation = invocationNum;
    steps.push({
      ephemeralMessage:
        '[Pro-Flash 轮次唤醒] 凡需读≥3个文件请派 invoke_subagent(TypeName="research", Model="flash")；改≥2个文件或>50行请派 invoke_subagent(TypeName="self", Model="flash")。派单后静默等待通知。',
    });
  } else if (!isCurrentModelFlash && cooled && (writes >= 3 || reads >= 3 || (writes >= 2 && reads >= 2))) {
    /* ---------------------------------------------------- 2. mid-turn drift */
    state.lastNagStep = globalStep;
    state.lastNagInvocation = invocationNum;
    steps.push({
      ephemeralMessage: `[Pro-Flash 漂移提醒] 已直读 ${reads} 个文件、改写 ${writes} 次文件。请立即派 invoke_subagent(TypeName="research"|"self", Model="flash") 协作，派单后静默等待通知。`,
    });
  }

  /* ----------------------------------------------------- 3. pressure check */
  const lastWarnStep = Number(state.lastWarnStep ?? -999);
  const warnCooled = globalStep < lastWarnStep || globalStep - lastWarnStep >= WARN_STEP_COOLDOWN;
  if (transcriptBytes >= PRESSURE_BYTES && warnCooled) {
    state.lastWarnStep = globalStep;
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

  writeSession(conversationId, state);

  if (steps.length > 0) {
    logDecision({
      hook: 'pre-invocation',
      action: 'inject',
      mode,
      steps: steps.length,
      globalStep,
      reads,
      writes,
      isNewUserTurn,
      transcriptMB: Number((transcriptBytes / (1024 * 1024)).toFixed(2)),
      userInput: userInput.slice(0, 80),
    });
  }

  output(steps.length > 0 && mode === 'enforce' ? { injectSteps: steps, terminationBehavior: '' } : {});
}
