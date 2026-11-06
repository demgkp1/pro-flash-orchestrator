#!/usr/bin/env node
/**
 * PreToolUse guard for `run_command` (v3.3).
 *
 * `cat requirements.md` bypasses the read guard entirely, so the same flood has
 * to be closed at the shell. The blacklist is deliberately narrow and
 * high-precision: only unbounded file dumps and unbounded `git log`.
 * Sub-agents are exempt (flash needs to run tests and read stack traces).
 */
import {
  ALLOW,
  currentMode,
  getArgs,
  isSubAgent,
  logDecision,
  output,
  readPayload,
  resolvePath,
  setContext,
  toolName,
} from './lib.mjs';
import fs from 'node:fs';

const DUMP_BYTES = 400 * 1024;
const UNBOUNDED_READERS = /(?:^|[;&|]\s*)(cat|type|Get-Content|gc|more|less)\b/i;
const BOUNDED_TAIL = /\|\s*(head|tail)\b|\|\s*Select-Object\s+-First|\|\s*Out-String\s+-Stream|\|\s*more\b/i;
const BOUNDED_FLAG = /(^|\s)-(TotalCount|Tail|First|Last|Head)\b/i;
const SAFE_SINK_PIPE = /\|\s*(?:Set-Content|Add-Content|sc|ac|Out-File|Out-Null)\b/i;
const REDIRECT_TARGET = /(?<!2)(?:1?>>|1?>|&>)\s*(?!&[12]\b)(?:["'][^"']+["']|\$null\b|\/dev\/null\b|NUL\b|[^\s|;&<>]+)/i;
const GIT_LOG = /(?:^|[;&|]\s*)git\b(?:\s+(?:-[^\s]+(?:\s+[^\s-;|<>&]+)?))*\s+log\b/i;
const GIT_LOG_BOUND = /(-n\s*\d+|--max-count|-n\d+|\s-\d+\b|--oneline\s+-n)/i;

function unquote(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^\\"/, '')
    .replace(/\\"$/, '');
}

function stripOuterQuotes(str) {
  let s = String(str || '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    const q = s[0];
    const inner = s.slice(1, -1).trim();
    if (q === '"') {
      return inner.replace(/\\"/g, '"').replace(/""/g, '"').replace(/`"/g, '"');
    }
    return inner;
  }
  return s;
}

export function unwrapCommand(command) {
  let cmd = String(command || '').trim();
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    iterations += 1;
    changed = false;

    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      const q = cmd[0];
      let closedEarly = false;
      let escaped = false;
      for (let i = 1; i < cmd.length - 1; i += 1) {
        const c = cmd[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === '\\' || (q === '"' && c === '`')) {
          escaped = true;
          continue;
        }
        if (c === q) {
          if (q === '"' && cmd[i + 1] === '"') {
            i += 1;
            continue;
          }
          closedEarly = true;
          break;
        }
      }
      if (!closedEarly) {
        cmd = stripOuterQuotes(cmd);
        changed = true;
      }
    }

    // cmd /c or cmd /k
    const cmdMatch = cmd.match(/^(?:(?:[^\s"']*[\/\\\\])?cmd(?:\.exe)?)\s+(?:\/[cC]|\/[kK])\s+([\s\S]+)$/i);
    if (cmdMatch) {
      cmd = stripOuterQuotes(cmdMatch[1]);
      changed = true;
      continue;
    }

    // bash / sh / zsh
    const bashMatch = cmd.match(
      /^(?:wsl(?:\.exe)?\s+(?:--\s+)?)?(?:(?:[^\s"']*[\/\\\\])?(?:bash|sh|zsh)(?:\.exe)?)\s+(?:-[a-zA-Z]*c\s+)([\s\S]+)$/i
    );
    if (bashMatch) {
      cmd = stripOuterQuotes(bashMatch[1]);
      changed = true;
      continue;
    }

    // wsl direct command: wsl cat ... or wsl -- cat ...
    const wslMatch = cmd.match(/^wsl(?:\.exe)?\s+(?:--\s+)?([\s\S]+)$/i);
    if (wslMatch) {
      cmd = stripOuterQuotes(wslMatch[1]);
      changed = true;
      continue;
    }

    // powershell / pwsh with explicit -Command or -c
    const pwshWithFlag = /^(?:(?:[^\s"']*[\/\\\\])?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?))\s+[\s\S]*?-(?:Command|c)\s+([\s\S]+)$/i;
    const pwshFlagMatch = cmd.match(pwshWithFlag);
    if (pwshFlagMatch) {
      cmd = stripOuterQuotes(pwshFlagMatch[1]);
      changed = true;
      continue;
    }

    // powershell / pwsh direct without -Command
    const pwshDirect = /^(?:(?:[^\s"']*[\/\\\\])?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?))\s+(?:-(?:NoProfile|NonInteractive|NoLogo)\s+)*([\s\S]+)$/i;
    const pwshDirectMatch = cmd.match(pwshDirect);
    if (pwshDirectMatch) {
      cmd = stripOuterQuotes(pwshDirectMatch[1]);
      changed = true;
      continue;
    }

    // scriptblock: & { ... } or { ... }
    const blockMatch = cmd.match(/^(?:&\s*)?\{([\s\S]+)\}$/);
    if (blockMatch) {
      cmd = stripOuterQuotes(blockMatch[1]);
      changed = true;
      continue;
    }
  }
  return cmd;
}

function extractDumpTarget(command) {
  const match = command.match(UNBOUNDED_READERS);
  if (!match) return null;
  const reader = match[1];
  const rest = command.slice(match.index + match[0].length);

  // Check if this reader statement/pipeline has safe sink or output redirection
  const stmtMatch = rest.match(/^(?:(?![;&]|&&|\|\|)[\s\S])*/);
  const readerStmt = stmtMatch ? stmtMatch[0] : rest;
  if (SAFE_SINK_PIPE.test(readerStmt) || REDIRECT_TARGET.test(readerStmt)) {
    return null;
  }

  const subCmd = rest.split(/[|;&<>]/)[0].trim();

  // 1. Explicit -Path or -LiteralPath (PowerShell syntax)
  const flagMatch = subCmd.match(/(?:^|\s)-(?:Path|LiteralPath)\s+("[^"]+"|'[^']+'|[^\s]+)/i);
  if (flagMatch) {
    return { reader, rawPath: unquote(flagMatch[1]) };
  }

  // 2. Positional target path, skipping flags (e.g. -Raw, /b, -n)
  const tokenRegex = /"[^"]+"|'[^']+'|[^\s]+/g;
  let tokenMatch;
  while ((tokenMatch = tokenRegex.exec(subCmd)) !== null) {
    const token = tokenMatch[0];
    if (token.startsWith('-') || token.startsWith('/')) {
      if (/^-(?:Encoding|Delimiter|Filter|Include|Exclude)$/i.test(token)) {
        tokenRegex.exec(subCmd);
      }
      continue;
    }
    return { reader, rawPath: unquote(token) };
  }
  return null;
}

export function splitTopLevelPipelines(command) {
  const pipelines = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escape = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
        if (current.trim()) pipelines.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      if (ch === ';' || ch === '\n') {
        if (current.trim()) pipelines.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) pipelines.push(current.trim());
  return pipelines.length > 0 ? pipelines : [command.trim()];
}

export function getSubPipelines(command) {
  const topPipelines = splitTopLevelPipelines(command);
  const result = [];
  for (const p of topPipelines) {
    const unwrapped = unwrapCommand(p);
    const sub = splitTopLevelPipelines(unwrapped);
    for (const s of sub) {
      result.push(s);
    }
  }
  return result.length > 0 ? result : [command.trim()];
}

function decide() {
  const payload = readPayload();
  setContext(payload);
  const mode = currentMode();
  if (mode === 'off') return ALLOW;

  const tool = toolName(payload);
  if (tool !== 'run_command') return ALLOW;
  if (isSubAgent(payload)) return ALLOW;

  const args = getArgs(payload);
  const command = String(args.CommandLine || args.Command || args.command || '');
  if (!command.trim()) return ALLOW;

  const deny = (rule, reason) => {
    logDecision({
      hook: 'guard-command',
      tool,
      mode,
      rule,
      action: mode === 'enforce' ? 'deny' : 'would-deny',
      command: command.slice(0, 200),
    });
    return mode === 'shadow' ? ALLOW : { decision: 'deny', reason };
  };

  const pipelines = getSubPipelines(command);

  for (const pipe of pipelines) {
    const effPipe = unwrapCommand(pipe);

    /* bounded or safely sunk pipelines are fine ---------------------------- */
    if (
      BOUNDED_TAIL.test(pipe) ||
      BOUNDED_TAIL.test(effPipe) ||
      SAFE_SINK_PIPE.test(pipe) ||
      SAFE_SINK_PIPE.test(effPipe)
    ) {
      continue;
    }

    /* unbounded file dump -------------------------------------------------- */
    const dump = extractDumpTarget(effPipe);
    if (dump && dump.rawPath && !BOUNDED_FLAG.test(effPipe) && !BOUNDED_FLAG.test(pipe)) {
      const target = resolvePath(dump.rawPath, payload);
      try {
        const size = fs.statSync(target).size;
        if (size > DUMP_BYTES) {
          return deny(
            'dump',
            `【命令守门】\`${dump.reader}\` 会把 ${(size / 1024).toFixed(0)} KB 内容灌进上下文。请改用 \`Get-Content -TotalCount 80\` / \`head -n 80\`，或派 flash_lite 提取要点。`,
          );
        }
      } catch {
        /* unknown path: let the command fail on its own */
      }
    }

    /* unbounded git log ---------------------------------------------------- */
    if (GIT_LOG.test(effPipe) && !GIT_LOG_BOUND.test(effPipe)) {
      const gitMatch = effPipe.match(GIT_LOG);
      const rest = effPipe.slice(gitMatch.index + gitMatch[0].length);
      const stmtMatch = rest.match(/^(?:(?![;&]|&&|\|\|)[\s\S])*/);
      const gitStmt = stmtMatch ? stmtMatch[0] : rest;
      if (!SAFE_SINK_PIPE.test(gitStmt) && !REDIRECT_TARGET.test(gitStmt)) {
        return deny('git-log', '【命令守门】无界 `git log` 会输出全部提交。请加 `-n 20 --oneline`，或只看 `git log -n 5 --stat`。');
      }
    }
  }

  logDecision({ hook: 'guard-command', tool, mode, action: 'pass', command: command.slice(0, 200) });
  return ALLOW;
}

try {
  output(decide());
} catch {
  output(ALLOW);
}
