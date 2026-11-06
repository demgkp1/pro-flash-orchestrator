#!/usr/bin/env node
/**
 * PreToolUse guard for  read_file / view_file / view_content_chunk  (v3.2).
 *
 * Economics that drive the thresholds:
 *   one extra model round-trip re-sends the whole conversation, while a
 *   150-line read is only ~2K tokens. So we never `deny` a small read; we
 *   `overwrite` it into a slice (zero extra round-trip) and only `deny` when
 *   the file is big enough that delegation clearly pays off.
 *
 * Policy (main agent only — sub-agents are exempt, or flash_lite could never
 * read the PRD it was dispatched to read):
 *   code, no slice, > 300 lines / 12 KB  -> slice [1, 150]
 *   code, no slice, > 800 lines / 40 KB  -> deny, delegate to flash_lite
 *   doc,  no slice, > 400 lines / 30 KB  -> deny, extract outline / delegate
 *   any slice with span > 150            -> clamp EndLine to start + 149
 */
import path from 'node:path';
import {
  ALLOW,
  basenameOf,
  currentMode,
  fileInfo,
  getArgs,
  isSubAgent,
  logDecision,
  mentions,
  output,
  readPayload,
  resolvePath,
  setContext,
  toolName,
} from './lib.mjs';

const READ_TOOLS = new Set(['read_file', 'view_file', 'view_content_chunk']);
const SLICE_CAPABLE = new Set(['read_file', 'view_file', 'view_content_chunk']);

const MAX_SPAN = 150;
const CODE_SOFT_LINES = 300;
const CODE_SOFT_BYTES = 12 * 1024;
const CODE_HARD_LINES = 800;
const CODE_HARD_BYTES = 40 * 1024;
const DOC_HARD_LINES = 400;
const DOC_HARD_BYTES = 30 * 1024;
const HARD_MAX_BYTES = 5 * 1024 * 1024;

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py', '.java', '.kt', '.kts', '.go',
  '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.scala', '.sh', '.ps1', '.bat',
  '.sql', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.json', '.yaml', '.yml', '.toml', '.ini',
  '.xml', '.gradle', '.lua', '.dart', '.ex', '.exs', '.r', '.jl', '.m', '.mm', '.sol', '.proto',
]);
const DOC_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.pdf', '.doc', '.docx', '.odt', '.rtf', '.tex']);

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

function pickNumber(args, keys) {
  for (const key of keys) {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return null;
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
  if (!READ_TOOLS.has(tool)) return ALLOW;

  const args = getArgs(payload);
  const rawPath = pickPath(args);
  if (!rawPath) return ALLOW;

  const file = resolvePath(rawPath, payload);
  if (!file) return ALLOW;

  const sub = isSubAgent(payload);
  const info = fileInfo(file);
  const base = basenameOf(file);
  const ext = path.extname(file).toLowerCase();

  const start = pickNumber(args, ['StartLine', 'startLine', 'Start', 'BeginLine']);
  const end = pickNumber(args, ['EndLine', 'endLine', 'End']);
  const hasSlice = start !== null || end !== null;

  const record = {
    hook: 'guard-read-file',
    tool,
    mode,
    sub,
    base,
    path: file.length > 180 ? `…${file.slice(-179)}` : file,
    bytes: info.bytes || 0,
    lines: info.exists ? info.lines : 0,
    start,
    end,
  };

  /**
   * @param {{deny?: boolean, reason?: string, overwrite?: object}} result
   */
  const finish = ({ deny = false, reason = '', overwrite = null } = {}) => {
    const action = deny
      ? mode === 'enforce' ? 'deny' : 'would-deny'
      : overwrite
        ? mode === 'enforce' ? 'slice' : 'would-slice'
        : 'pass';
    logDecision({ ...record, action });
    if (mode === 'shadow') return ALLOW;
    if (deny) return { decision: 'deny', reason };
    if (overwrite) return { decision: 'allow', overwrite };
    return ALLOW;
  };

  /* sub-agents and exempt paths are never policed ----------------------- */
  if (sub || !info.exists || isExemptPath(file, payload)) return finish();
  if (mentions(payload, '[ALLOW-READ]') || (base.length >= 5 && mentions(payload, base))) return finish();

  /* binary / absurd size ------------------------------------------------ */
  if ((info.bytes || 0) > HARD_MAX_BYTES && !hasSlice) {
    return finish({
      deny: true,
      reason: `【读取守门】该文件 ${(info.bytes / 1024 / 1024).toFixed(1)} MB，禁止整文件读入。请派 flash_lite 抽样，或明确传入 StartLine/EndLine。`,
    });
  }

  /* explicit slice: only clamp the span --------------------------------- */
  if (hasSlice) {
    const from = start ?? 1;
    const to = end ?? from + MAX_SPAN - 1;
    if (to - from + 1 <= MAX_SPAN) {
      // StartLine without EndLine reads to EOF, so pin the implicit end.
      return end === null ? finish({ overwrite: { EndLine: to } }) : finish();
    }
    if (!SLICE_CAPABLE.has(tool)) {
      return finish({
        deny: true,
        reason: `【读取守门】切片跨度 ${to - from + 1} 行，超过单次 ${MAX_SPAN} 行上限，请缩小区间。`,
      });
    }
    return finish({ overwrite: { StartLine: from, EndLine: from + MAX_SPAN - 1 } });
  }

  /* unsliced read of a code file ---------------------------------------- */
  if (CODE_EXT.has(ext)) {
    if ((info.bytes || 0) > CODE_HARD_BYTES || info.lines > CODE_HARD_LINES) {
      return finish({
        deny: true,
        reason: `【读取守门】代码文件 ${info.lines} 行（约 ${Math.round((info.bytes || 0) / 1024)} KB）。请派 invoke_subagent(TypeName="research", Model="flash_lite") 定位，或用 view_file 传 StartLine/EndLine 一次读 ≤${MAX_SPAN} 行。`,
      });
    }
    if ((info.bytes || 0) > CODE_SOFT_BYTES || info.lines > CODE_SOFT_LINES) {
      return finish({ overwrite: { StartLine: 1, EndLine: MAX_SPAN } });
    }
    return finish();
  }

  /* unsliced read of a document ----------------------------------------- */
  if (DOC_EXT.has(ext)) {
    if ((info.bytes || 0) > DOC_HARD_BYTES || info.lines > DOC_HARD_LINES) {
      return finish({
        deny: true,
        reason: `【读取守门】文档 ${info.lines} 行（约 ${Math.round((info.bytes || 0) / 1024)} KB），禁止主模型通读。请先派 invoke_subagent(TypeName="research", Model="flash_lite") 提取结构化摘要；若只需目录或某一节，用 grep_search 或 view_file 切片（≤${MAX_SPAN} 行）。`,
      });
    }
  }

  return finish();
}

try {
  output(decide());
} catch {
  output(ALLOW);
}
