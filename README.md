# Pro-Flash Orchestrator

A lifecycle-hook orchestration engine for Google Antigravity, with an independently packaged Codex adapter and Claude Code hook template.

Designed for universal software engineering, code review, bug diagnosis, refactoring, and document exploration. It keeps the flagship model (Pro) focused on architectural decisions and benchmark implementations while offloading exploration, peripheral expansion, and tests to a lightweight worker (Flash / Hydrogen) via deterministic physical hooks.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v0.7.1-blue.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%20%7C%20Codex%20%7C%20Claude%20Code-lightgrey.svg)](#multi-platform-support--acceptance-status)
[![Tests](https://img.shields.io/badge/Offline%20Suites-7%20Passed-green.svg)](#diagnostics--tests)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Core Positioning & Sandwich Collaboration

Relying solely on a flagship model in long-running sessions causes two bottlenecks: **quota depletion** on routine engineering and **context window degradation** from unbounded file dumps. Soft prompt instructions inevitably drift as context grows. Pro-Flash Orchestrator enforces physical checks and parameter rewrites at `SessionStart`, `PreInvocation`, and `PreToolUse`.

### Sandwich Collaboration Workflow (`/flash-dev`)

1. **Explore**: For unknown codebases, ≥3 files, or long docs/code, dispatch `research` to extract structured summaries and exact line ranges.
2. **Benchmark + Concurrent Fan-out**: Pro implements core schemas, algorithms, or benchmark files (≤2 files), and dispatches `self` subagents in the **same turn** for peripheral modules and unit tests.
3. **Audit Verification**: Upon receiving the 4-column completion table, Pro checks `git status --porcelain` and inspects 20–60 line slices using the Audit dynamic slice budget.

```text
[ User Prompt / /flash-dev ]
            │
            ▼
┌────────────────────────────────────────┐
│        Pro Lead Architect (Flagship)   │
│  - Core architecture & benchmark (≤2)  │
│  - Same-turn concurrent fan-out (≤5)   │
└───────────────────┬────────────────────┘
                    │ invoke_subagent / define_subagent
                    ▼
┌────────────────────────────────────────┐
│     Physical Lifecycle Hook Guards     │
│  - AGY v1.5.11+ tier alias routing     │
│  - Injects [FLASH-WORKER] & contract   │
│  - Read/Write limits & batch mutex     │
│  - Anti-recursion, anti-polling, breaker│
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│        Worker (Hydrogen / Flash)       │
│  - Explores or expands disjoint files  │
│  - Runs targeted local verification    │
│  - Replies with 4-column table only    │
└───────────────────┬────────────────────┘
                    │ Response
                    ▼
┌────────────────────────────────────────┐
│         Pro Audit & Verification       │
│  - Checks git status & Audit slices    │
└────────────────────────────────────────┘
```

---

## What's New in v0.7.1

- **Gemini 4 Neon & Native Orchestrator Support**: Full recognition of `Gemini 4 Neon` (`gemini-4-neon-low/medium/high/xhigh`, the default primary model for Pro/Ultra/Enterprise) alongside `Argon` / `Carbon` / `Hydrogen`, plus `Orchestrator (Neon)` and `Orchestrator (Argon)` as native orchestrator entry points (auto-enabling `Lite Guard Mode`).
- **AGY v1.5.11+ Official Tier Mapping**: `invoke_subagent` uniformly routes via legal tier aliases: `flash` → `Gemini 4 Hydrogen High`, `pro` under `[FORCE-PRO]` → `Gemini 4 Hydrogen XHigh`, and `inherit` in Hydrogen main sessions → inherits Hydrogen.
- **Git-free One-Click Upgrade & Zero-Blocking Update Check**: `check-update-worker.mjs` asynchronously checks GitHub Releases on `SessionStart` (cached in `.state/update-check.json`, zero startup latency; disable via `PRO_NO_UPDATE_CHECK=1`). Release users can upgrade in-place without Git via `node "<install-dir>/scripts/update.mjs"` while 100% preserving `.state/`.
- **Subagent Thrashing Circuit Breaker**: `guard-command.mjs` tracks consecutive identical commands per subagent task; hitting `PRO_THRASH_LIMIT` (default `3`, minimum `2`) triggers a physical `deny` and forces escalation back to Pro.

---

## Quick Install & Git-free Upgrade

v0.7.1 publishes two independent release assets:

- `pro-flash-orchestrator-antigravity-v0.7.1.zip` (rooted at `pro-flash-orchestrator/`)
- `pro-flash-orchestrator-codex-v0.7.1.zip` (rooted at `pro-flash-orchestrator-codex/`, containing `plugins/pro-flash-orchestrator/`)

### Option 1: Git-free Online / Offline Upgrade (Release Users)

```bash
# Online upgrade (fetches latest pro-flash-orchestrator-antigravity-v*.zip, preserves .state/)
node "<install-directory>/scripts/update.mjs"

# Offline upgrade from a local ZIP archive
node "<install-directory>/scripts/update.mjs" --zip "path/to/pro-flash-orchestrator-antigravity-v0.7.1.zip"

# Preview changes without writing
node "<install-directory>/scripts/update.mjs" --dry-run
```

### Option 2: Install from Source Checkout (Antigravity)

```bash
git clone https://github.com/demgkp1/pro-flash-orchestrator.git ~/Projects/pro-flash-orchestrator
cd ~/Projects/pro-flash-orchestrator
node scripts/install.mjs
```

- Default install target: `~/.gemini/config/plugins/pro-flash-orchestrator` (override with `--target <dir>`, preview with `--dry-run`).
- Only allowlisted runtime files from `runtime-files.json` are deployed; `.state/` is preserved and Git/test/CI files are excluded.

---

## Core Guard Mechanisms & Policies

### Main Session Policies

| Policy | Trigger | Read Quota | Write Quota | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Standard Main** | Flagship models (`Neon`, `Argon`, `Carbon`) | **3** distinct files | **2** source files | Enforces strict benchmark limits and dispatches workers for ≥3 reads or >2 writes. |
| **Flash Main Relaxed** | `flash-main-relaxed` (Flash main session) | **6** distinct files | **4** source files | Relaxes count thresholds for lightweight main sessions while keeping slice/flood/contract guards. |
| **Lite Guard Mode** | `Orchestrator (Neon)` / `Orchestrator (Argon)` or `PRO_NATIVE_ORCHESTRATOR=1` | Count exempt | Count exempt | Exempts main read/write count blocks and count drift nudges; retains oversized file slicing, anti-recursion, anti-polling, dispatch contracts, command guards, and subagent file mutex locks. |

### Physical Guard Matrix

| Guard | Hook | Enforcement & Benefit |
| :--- | :--- | :--- |
| **Role & Card Setup** | `SessionStart` | Injects rules once per main session (skipped for subagents); emits zero-token UI status card via `renderInfo`. |
| **Worker Model Routing** | `PreToolUse` (`invoke_subagent`) | Validates legal enums (`inherit`, `flash_lite`, `flash`, `pro`) and routes per AGY `v1.5.11+` tier mapping (`Hydrogen` → `inherit`; others → `flash`; `[FORCE-PRO]` → `pro`). |
| **Audit Dynamic Slice Budget** | `PreToolUse` (`read_file`, `view_file`) | Each `self` dispatch grants **+2** slice audit credits (capped at **10**). Explicit line ranges ≤80 lines consume audit credits first, allowing Pro to verify multiple worker-edited files without hitting the normal read quota; resets on a new user turn. |
| **Sliced Multi-Read & Flood Guard** | `PreToolUse` (`read_file`, `view_file`) | Unsliced 300–800 line code reads clamp to `[1, 150]`; >800 line code or >400 line docs are denied. Minified files (>40KB, avg line >4KB) are blocked. Dependency/artifact paths are exempt. |
| **Batch File Mutex Lock** | `PreToolUse` (`write_file`, `edit_file`, `apply_patch`) | Atomically checks and claims normalized targets in the parent's `batchFileClaims`. Same child may retry; cross-child conflicts are denied. New batches or audit IDs release claims. |
| **Anti-Recursion & Anti-Polling** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `manage_subagents`) | Blocks nested subagent spawning and `manage_subagents(Action="list")` polling (`Action="kill"` allowed); enforces evidence-based child identity. |
| **Contract Injection** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `send_message`) | Appends `[FLASH-WORKER]` and `[PRO-CONTRACT]` requiring a 4-column table and local test output (`research` returns structured summaries without writes). |
| **Command Guard & Thrashing Breaker** | `PreToolUse` (`run_command`) | Unwraps nested shells and pipelines; blocks unbounded `git log` and >400KB `cat`/`Get-Content` dumps (allows redirections and PowerShell `select` slicing); trips circuit breaker after `PRO_THRASH_LIMIT` (default 3) identical subagent commands. |
| **Turn Wakeup & Drift Alert** | `PreInvocation` | Injects a transient 1-line wakeup in long sessions (`globalStep >= 8`) and alerts on deduplicated read/write drift (suppressed for Flash main and native Orchestrator). |
| **Context Savings Telemetry** | `report.mjs` | `node scripts/report.mjs [--days 7]` summarizes startup strategies and estimates tokens saved (4 bytes/token) from denied reads and clamped slices (excluding `shadow` and test entries). |

### Operational Modes & Environment Variables

Set mode in `.state/mode.json` (`{ "mode": "enforce" | "shadow" | "off" }`, protected from agent edits) or via environment variables:

- `PRO_MODE`: `enforce` (default), `shadow` (log only), `off` (bypass).
- `PRO_NO_UPDATE_CHECK=1`: Disable background GitHub Release update checks.
- `PRO_THRASH_LIMIT=3`: Consecutive identical subagent commands before circuit breaker trips (min `2`).
- `PRO_NATIVE_ORCHESTRATOR=1`: Force `Lite Guard Mode`.
- `PRO_STATE_DIR` / `PRO_LOG_PASS=1`: Override state directory or log passing hook decisions.

---

## Multi-Platform Support & Acceptance Status

| Platform | Status | Notes |
| :--- | :--- | :--- |
| **Google Antigravity** | **Primary (Full Support)** | Production-verified lifecycle hooks, AGY `v1.5.11+` tier routing, Audit slice budget, and Git-free `update.mjs`. |
| **OpenAI Codex CLI** | **Staged Native Acceptance** | Independently packaged (`pro-flash-orchestrator-codex-v0.7.1.zip`). Six user-native hooks have been reviewed as trusted and desktop `PreToolUse` observed, but full native guard coverage and end-to-end native worker dispatch remain pending. **Not claimed as fully live-usable.** See [Codex acceptance evidence](docs/codex-acceptance-v0.5.2.md). |
| **Claude Code** | **Template Only** | Hook template provided in `hooks/claude-settings-hooks.json`; not live-validated. |

### Codex Standalone Setup

Extract `pro-flash-orchestrator-codex-v0.7.1.zip`, enter its marketplace root, and run:

```bash
node install.mjs
node doctor.mjs
```

Review and trust the six Pro-Flash entries in desktop **Settings > Hooks** or CLI `/hooks`, configure the worker/provider in `CODEX_HOME/plugin-data/pro-flash-orchestrator/config.json`, then verify:

```bash
node doctor.mjs --verify-worker
node doctor.mjs
```

To unregister: `node install.mjs --uninstall` (preserves `CODEX_HOME/plugin-data/pro-flash-orchestrator`).

---

## Diagnostics & Tests

### Health Check & Telemetry

```bash
node scripts/doctor.mjs          # Host capability snapshot (strategy, hasHydrogen, source), mutex & report checks
node scripts/report.mjs          # Production decision telemetry & context savings ROI (last 7 days)
```

### Offline Test Suites (No Provider API Calls)

```bash
node scripts/test-concurrency.mjs   # Multi-process atomic lock & guard integration stress test
node scripts/test-regressions.mjs   # Identity isolation, patch targets, quotas, command guards & routing
node scripts/test-v060.mjs          # v0.6.x policy, Audit slice budget & Lite Guard Mode tests
node scripts/test-capabilities.mjs  # AGY capability probe & v1.5.11+ tier mapping tests
node scripts/test-install.mjs       # Runtime allowlist boundary & .state/ preservation tests
node scripts/test-codex.mjs         # Offline Codex protocol & package allowlist tests
node scripts/test-update.mjs        # Background update checker & in-place updater tests
```

### Packaging Runtime Archives

```bash
node scripts/package.mjs --runtime --platform antigravity --worktree
node scripts/package.mjs --runtime --platform codex --worktree
```

---

## Known Limitations

- **Pipeline & Redirection Bypass (S5)**: Stream commands via `run_command` (`head`, `grep`, `sed`, `>`) are checked by the dump guard but do not increment `read_file`/`write_file` quotas or claim `batchFileClaims`.
- **Codex & Claude Code**: Codex hosted tools, hook timeouts, and already-approved interactive shells may fall outside native hook coverage; Claude Code and account sign-in are not live-validated.

---

## Directory Structure

```text
pro-flash-orchestrator/
├── adapters/codex/                # Standalone Codex marketplace entry points, hooks & skills
├── assets/logo.svg                # Plugin icon
├── docs/                          # INSTALL template, audits & Codex acceptance evidence
├── hooks/                         # Claude Code & Codex CLI hook configurations
├── hooks.json                     # Antigravity lifecycle hook routing
├── plugin.json                    # Antigravity plugin manifest (v0.7.1)
├── rules/AGENTS.md                # Persistent architect & worker rules (mirrored at root AGENTS.md)
├── runtime-files.json             # Runtime distribution allowlist
├── skills/flash-dev/SKILL.md      # /flash-dev workflow skill (mirrored at root SKILL.md)
└── scripts/
    ├── lib.mjs                    # Shared utilities, state locks, capability & mode resolution
    ├── session-start.mjs          # Startup role injection, UI card & update check trigger
    ├── pre-invocation.mjs         # Turn-boundary wakeup & deduplicated drift detector
    ├── guard-subagent.mjs         # Recursion, polling, tier routing & contract injection
    ├── guard-read-file.mjs        # Smart slicing, Audit slice budget & multi-read guard
    ├── guard-write-file.mjs       # Benchmark write limits & batchFileClaims mutex
    ├── guard-command.mjs          # Shell unwrapping, dump guard & thrashing circuit breaker
    ├── check-update-worker.mjs    # Non-blocking background GitHub Release checker
    ├── update.mjs                 # Git-free in-place updater preserving .state/
    ├── install.mjs                # Antigravity & Codex installer
    ├── package.mjs                # Multi-platform release packager
    ├── doctor.mjs                 # Diagnostics & live capability snapshot
    ├── report.mjs                 # Decision telemetry & context savings estimator
    ├── codex-*.mjs                # Native Codex hook, runtime, setup & maintenance bridge
    └── test-*.mjs                 # Offline verification & regression suites
```

## License

[MIT License](LICENSE)
