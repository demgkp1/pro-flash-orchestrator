#!/usr/bin/env node
/**
 * PreToolUse guard for `run_command` (v0.3).
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
const UNBOUNDED_READERS = /(?:^|[;&|]\s*|\$\w+\s*=\s*|\(\s*)(cat|type|Get-Content|gc|more|less)\b/i;
const DOTNET_READERS = /\[(?:System\.)?IO\.File\]::(ReadAllText|ReadAllLines|ReadAllBytes|ReadLines)\s*\(\s*(\([^\)]+\)|"[^"]+"|'[^']+'|[^,)\s]+)/i;
const BOUNDED_FLAG = /(^|\s)-(TotalCount|Tail|First|Last|Head)\b/i;
const SAFE_SINK_PIPE = /\|\s*(?:Set-Content|Add-Content|sc|ac|Out-File|Out-Null)\b/i;
const REDIRECT_TARGET = /(?<!2)(?:1?>>|1?>|&>)\s*(?!&[12]\b)(?:["'][^"']+["']|\$null\b|\/dev\/null\b|NUL\b|[^\s|;&<>]+)/i;
const GIT_LOG = /(?:^|[;&|`(]\s*|\bxargs\s+(?:-\S+\s+)*)git\b(?:\s+(?:-[^\s]+(?:\s+[^\s-;|<>&]+)?))*\s+log\b/i;
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

function cleanSubExpression(raw) {
  let s = unquote(raw);
  const subExpr = s.match(/^\(\s*(?:Resolve-Path|Convert-Path|Get-Item|gi|gp)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]+"|'[^']+'|[^)\s]+)\s*\)$/i);
  if (subExpr) return unquote(subExpr[1]);
  if (s.startsWith('(') && s.endsWith(')')) {
    s = unquote(s.slice(1, -1).trim());
  }
  return s;
}

// Keep quoted paths and Resolve-Path expressions intact, while separating
// lists/pipes/redirections. This is lexical inspection, not shell evaluation.
function commandTokens(command) {
  const tokens = [];
  let token = '';
  let quote = '';
  let depth = 0;
  let escaped = false;
  const flush = () => { if (token) tokens.push(token); token = ''; };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { token += ch; escaped = false; continue; }
    if (ch === '`' && quote !== "'") { token += ch; escaped = true; continue; }
    if (quote) {
      token += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { token += ch; quote = ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) { flush(); continue; }
    if (depth === 0 && /[,|<>;]/.test(ch)) {
      flush();
      if ((ch === '>' || ch === '<') && command[i + 1] === ch) {
        tokens.push(ch + ch); i += 1;
      } else tokens.push(ch);
      continue;
    }
    token += ch;
  }
  flush();
  return tokens;
}

function isBoundedPipeline(command) {
  const tokens = commandTokens(command);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== '|') continue;
    const name = String(tokens[i + 1] || '').toLowerCase();
    const end = tokens.indexOf('|', i + 1);
    const args = tokens.slice(i + 2, end < 0 ? tokens.length : end);
    if (name === 'select-object') {
      if (args.some((arg, j) => /^-(First|Last)$/i.test(arg) && /^\d+$/.test(args[j + 1] || ''))) return true;
    } else if (name === 'head' || name === 'tail') {
      if (args.some((arg) => /^(?:-.*f.*|--follow(?:=.*)?)$/.test(arg))) continue;
      const count = args.findIndex((arg) => /^(?:-[nc]|--lines|--bytes)$/.test(arg));
      if (count >= 0) {
        if (/^\d+$/.test(args[count + 1] || '')) return true;
      } else if (args.length === 0 || args.every((arg) => /^(?:-\d+|-[nc]\d+|--(?:lines|bytes)=\d+)$/.test(arg))) return true;
    }
  }
  return false;
}

function isReadOnlyModePipeline(command) {
  // Unknown programs and executable substitutions remain blocked. Only
  // recognisable read operations may mention the protected configuration.
  if (/\$\(|`/.test(command)) return false;
  const tokens = commandTokens(command);
  const readCommands = new Set([
    'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'more', 'less', 'rg', 'grep',
    'select-string', 'get-item', 'test-path', 'get-childitem', 'ls', 'stat', 'file',
    'select-object', 'sort-object', 'measure-object', 'out-string', 'out-null',
    'write-output', 'echo', 'printf',
  ]);
  const sinks = new Set(['set-content', 'add-content', 'out-file', 'sc', 'ac', 'tee']);
  let expectCommand = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '>' || token === '>>') {
      const target = unquote(tokens[++i] || '');
      if (!target || /\bmode\.json\b/i.test(target) || /[()]/.test(target) ||
          (target.includes('$') && target !== '$null')) return false;
      continue;
    }
    if (token === '<' || token === '<<' || token === ';') return false;
    if (token === '|') { expectCommand = true; continue; }
    if (expectCommand) {
      const name = token.toLowerCase();
      if (name === 'git' && /^(?:diff|show|log|status)$/.test(tokens[i + 1] || '')) {
        expectCommand = false;
        continue;
      }
      if (sinks.has(name)) {
        const end = tokens.indexOf('|', i + 1);
        const args = tokens.slice(i + 1, end < 0 ? tokens.length : end);
        if (args.some((arg) => /\bmode\.json\b/i.test(arg) || arg.includes('$'))) return false;
      } else if (!readCommands.has(name)) return false;
      expectCommand = false;
    } else if (token.startsWith('{') || token.startsWith('&') ||
               (token.startsWith('(') && !/^\(\s*(?:Resolve-Path|Convert-Path|Get-Item|gi)\b/i.test(token))) {
      return false;
    }
  }
  return !expectCommand;
}

function extractDumpTargets(command) {
  const dotnetMatch = command.match(DOTNET_READERS);
  if (dotnetMatch) {
    const rest = command.slice(dotnetMatch.index + dotnetMatch[0].length);
    const stmtMatch = rest.match(/^(?:(?![;&]|&&|\|\|)[\s\S])*/);
    const readerStmt = stmtMatch ? stmtMatch[0] : rest;
    if (SAFE_SINK_PIPE.test(readerStmt) || REDIRECT_TARGET.test(readerStmt)) {
      return [];
    }
    return [{ reader: `[IO.File]::${dotnetMatch[1]}`, rawPath: cleanSubExpression(dotnetMatch[2]) }];
  }

  const match = command.match(UNBOUNDED_READERS);
  if (!match) return [];
  const reader = match[1];
  const rest = command.slice(match.index + match[0].length);

  // Check if this reader statement/pipeline has safe sink or output redirection
  const stmtMatch = rest.match(/^(?:(?![;&]|&&|\|\|)[\s\S])*/);
  const readerStmt = stmtMatch ? stmtMatch[0] : rest;
  if (SAFE_SINK_PIPE.test(readerStmt) || REDIRECT_TARGET.test(readerStmt)) {
    return [];
  }

  const targets = [];
  const tokens = commandTokens(rest);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^[|;&<>]/.test(token)) break;
    if (token === ',') continue;
    if (token.startsWith('-')) {
      if (/^-(?:Encoding|Delimiter|Filter|Include|Exclude|TotalCount|Tail)$/i.test(token)) i += 1;
      continue;
    }
    // Only cmd.exe TYPE's actual switches are options; /tmp/file is a path.
    if (reader.toLowerCase() === 'type' && /^\/[abp]$/i.test(token)) continue;
    targets.push({ reader, rawPath: cleanSubExpression(token) });
  }
  return targets;
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

  /* S1: mode.json is protected by security policy; no agent may modify it */
  const pipelines = getSubPipelines(command);
  if (pipelines.some((pipe) => /\bmode\.json\b/i.test(pipe) && !isReadOnlyModePipeline(unwrapCommand(pipe)))) {
    return deny(
      'mode-json',
      '【安全拦截】禁止通过命令修改 mode.json。运行模式为用户安全配置，只能由用户在 .state/mode.json 手动配置。',
    );
  }

  if (isSubAgent(payload)) return ALLOW;

  for (const pipe of pipelines) {
    const effPipe = unwrapCommand(pipe);

    /* bounded or safely sunk pipelines are fine ---------------------------- */
    if (
      isBoundedPipeline(effPipe) ||
      SAFE_SINK_PIPE.test(pipe) ||
      SAFE_SINK_PIPE.test(effPipe)
    ) {
      continue;
    }

    /* unbounded file dump -------------------------------------------------- */
    const dumps = extractDumpTargets(effPipe);
    let dumpedBytes = 0;
    for (const dump of dumps) {
      if (!dump.rawPath || BOUNDED_FLAG.test(effPipe) || BOUNDED_FLAG.test(pipe)) continue;
      const target = resolvePath(dump.rawPath, payload);
      try {
        const size = fs.statSync(target).size;
        dumpedBytes += size;
        if (dumpedBytes > DUMP_BYTES) {
          return deny(
            'dump',
            `【命令守门】\`${dump.reader}\` 会把至少 ${(dumpedBytes / 1024).toFixed(0)} KB 内容灌进上下文。请改用 \`Get-Content -TotalCount 80\` / \`head -n 80\`，或派 flash 提取要点。`,
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
