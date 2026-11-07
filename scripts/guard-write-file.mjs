#!/usr/bin/env node
/**
 * PreToolUse guard for write_file / write_to_file / edit_file / replace_file_content / multi_replace_file_content.
 *
 * Implements the v0.3 sandwich workflow red line:
 *   - The Pro architect writes 1-2 core/benchmark files directly.
 *   - Any further multi-file engineering (attempting 3rd distinct file) is blocked
 *     and must be delegated to a Flash worker subagent.
 *   - Subagents and artifacts are exempt.
 */
import path from 'node:path';
import {
  ALLOW,
  basenameOf,
  currentMode,
  getArgs,
  isSubAgent,
  lastUserInput,
  logDecision,
  mentions,
  output,
  readPayload,
  readSession,
  resolvePath,
  setContext,
  toolName,
  writeSession,
} from './lib.mjs';

const WRITE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const EXEMPT_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', 'vendor', '__pycache__',
  'venv', '.venv', '.tox', 'target', '.yarn', '.pnpm-store',
]);
const EXEMPT_BASENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock',
  'changelog.md', 'license', 'license.md', 'notice',
]);
const EXEMPT_SUFFIXES = ['.min.js', '.min.css', '.map', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'];

function pickPath(args) {
  const keys = ['AbsolutePath', 'AbsolutePathUri', 'Path', 'FilePath', 'TargetFile', 'TargetFileUri', 'Uri', 'absolutePath'];
  for (const key of keys) {
    const value = args[key];
    if (value && typeof value === 'string') return value;
  }
  return '';
}

function isExemptPath(file, payload) {
  const lower = file.toLowerCase();
  const segments = lower.split(/[\\/]+/);
  if (segments.some((segment) => EXEMPT_SEGMENTS.has(segment))) return true;
  if (
    lower.includes('/.gemini/antigravity/') ||
    lower.includes('\\.gemini\\antigravity\\') ||
    lower.includes('/.system_generated/') ||
    lower.includes('\\.system_generated\\')
  ) {
    return true;
  }
  if (
    (lower.includes('pro-flash-orchestrator') || lower.includes('argon-flash-orchestrator')) &&
    lower.includes('.state')
  ) {
    return true;
  }
  const rawArtifactDir = String((payload && payload.artifactDirectoryPath) || '').trim();
  if (rawArtifactDir) {
    const artifactDir = path.normalize(rawArtifactDir).toLowerCase();
    if (path.normalize(file).toLowerCase().startsWith(artifactDir)) return true;
  }
  const base = basenameOf(file);
  if (EXEMPT_BASENAMES.has(base)) return true;
  return EXEMPT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function decide() {
  const payload = readPayload();
  setContext(payload);
  const mode = currentMode();
  if (mode === 'off') return ALLOW;

  const tool = toolName(payload);
  if (!WRITE_TOOLS.has(tool)) return ALLOW;

  const args = getArgs(payload);
  const rawPath = pickPath(args);
  if (!rawPath) return ALLOW;

  const file = resolvePath(rawPath, payload);
  if (!file) return ALLOW;

  const sub = isSubAgent(payload);
  const base = basenameOf(file);

  const record = {
    hook: 'guard-write-file',
    tool,
    mode,
    sub,
    base,
    path: file.length > 180 ? `…${file.slice(-179)}` : file,
  };

  const finish = ({ deny = false, reason = '' } = {}) => {
    const action = deny
      ? mode === 'enforce' ? 'deny' : 'would-deny'
      : 'pass';
    logDecision({ ...record, action });
    if (mode === 'shadow') return ALLOW;
    if (deny) return { decision: 'deny', reason };
    return ALLOW;
  };

  /* sub-agents and exempt paths are never policed ----------------------- */
  if (sub || isExemptPath(file, payload)) return finish();
  if (
    mentions(payload, '[ALLOW-WRITE]') ||
    mentions(payload, '[FORCE-PRO]') ||
    mentions(payload, '[FORCE-ARGON]')
  ) {
    return finish();
  }

  const convId = String(payload.conversationId || 'unknown');
  const state = readSession(convId);
  const uInput = lastUserInput(payload).trim();
  if (uInput && uInput !== state.lastWriteUserInput) {
    state.lastWriteUserInput = uInput;
    state.writesSinceDispatch = [];
  }

  const writeList = Array.isArray(state.writesSinceDispatch) ? state.writesSinceDispatch : [];
  const normFile = path.normalize(file);

  if (!writeList.includes(normFile)) {
    if (writeList.length >= 2) {
      return finish({
        deny: true,
        reason:
          '【写入守门：多文件连续直改拦截】自上次派单以来你已直接修改 2 个不同文件（' +
          writeList.map((p) => path.basename(p)).join(', ') +
          '）。按三明治协同红线，主控仅负责落盘 1~2 个核心标杆文件，其余外围文件修改必须同轮外派 invoke_subagent(TypeName="self", Model="flash") 或用 send_message 续派现有子代理（若确需主控直改可在输入中加 [ALLOW-WRITE]）。',
      });
    }
    writeList.push(normFile);
    state.writesSinceDispatch = writeList;
    writeSession(convId, state);
  }

  return finish();
}

try {
  output(decide());
} catch {
  output(ALLOW);
}
