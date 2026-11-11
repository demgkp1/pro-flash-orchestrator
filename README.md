# Pro-Flash Orchestrator

A dual-tier model orchestration engine for Google Antigravity.

Designed for universal software engineering, code review, bug diagnosis, refactoring, and document exploration. Keeps the flagship Pro model focused on core decisions and benchmark implementations, while offloading peripheral implementation, unit tests, and document exploration uniformly to Flash subagents (flash_lite retired). All governance policies are enforced at the runtime lifecycle Hook level via deterministic physical guards.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v0.5.1-lightgrey.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%202.0-lightgrey.svg)](#)
[![Tests](https://img.shields.io/badge/Tests-90%20Passed-green.svg)](#)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Design Rationale

In long-running pair programming sessions, relying solely on a flagship model (Pro) leads to two common bottlenecks:

1. Quota & Budget Depletion: Expensive reasoning tokens are expended on boilerplate CRUD, repetitive data transforms, and writing extensive test suites.
2. Context Window Degradation: Unbounded dumps (such as direct `cat` calls or unsliced reads of massive files) saturate the context window, degrading subsequent reasoning performance.

Soft guidelines embedded in system prompts ("please delegate routine work") frequently fail as context grows and prompt drift occurs. Pro-Flash Orchestrator introduces Antigravity lifecycle hooks that enforce hard physical checks and parameter rewrites at tool execution (`PreToolUse`), model invocation (`PreInvocation`), and session startup (`SessionStart`).

---

## Collaboration Model

### Universal Scale-Based Offloading (Applicable to all languages, frameworks, and domains)
- **Exploration & Review (≥3 files or massive docs/code)**: Dispatches `research (flash)` to extract structured summaries and exact line ranges; denies concurrent unguided slicing by the host model.
- **Implementation & Refactoring (>50 lines or ≥2 files)**: Pro directly commits core benchmark architecture/algorithms and dispatches `self (flash)` in the same turn for peripheral expansion and regression tests.
- **Surgical Single-Point Fixes (≤50 lines, ≤2 known files)**: Pro directly slices and edits (prevents delegation latency and communication overhead).

```text
[ User Prompt / /flash-dev ]
            │
            ▼
┌────────────────────────────────────────┐
│        Pro Lead Architect (Flagship)   │
│  - Universal: code/review/debug/docs   │
│  - Core benchmark & algorithm design   │
│  - Dispatches sub-agents in same turn  │
└───────────────────┬────────────────────┘
                    │ invoke_subagent / define_subagent
                    ▼
┌────────────────────────────────────────┐
│     Runtime Hook Interception Guards   │
│  - Unified subagent downgrade:         │
│    research & self/tasks -> flash      │
│  - Injects [FLASH-WORKER] & contract   │
│  - Anti-recursion & anti-polling       │
│  - Read/Write guards: slices & limits  │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│        Flash Worker (Lightweight)      │
│  - Unified flash: explore & expand     │
│  - Runs verification commands directly │
│  - Replies strictly with 4-column table│
└───────────────────┬────────────────────┘
                    │ Response
                    ▼
┌────────────────────────────────────────┐
│         Pro Audit & Verification       │
│  - Reviews git status range            │
│  - Inspects 20-60 line slices by index │
└────────────────────────────────────────┘
```

---

## Physical Guard Matrix

| Guard System | Hook Target | Enforcement Policy | Practical Benefit |
| :--- | :--- | :--- | :--- |
| **Role & Card Setup** | `SessionStart` | Injects universal governance rules once at session start; status card is emitted via `renderInfo` to the UI layer. Automatically skips role injection for sub-agents. | Status card consumes 0 model tokens and leaves no residue in the context window. |
| **Unified Sub-Agent Downgrade** | `PreToolUse` (`invoke_subagent`) | All assistant subagents are unified to `flash` (`research` exploration and `self` engineering tasks both route to `flash`, flash_lite retired), unless explicitly exempted via `[FORCE-PRO]`. | Balances reasoning quality with quota efficiency across all exploration and boilerplate tasks. |
| **Write Guard & Benchmark Limit** | `PreToolUse` (`write_file`, `edit_file`, etc.) | Direct source code modifications by the host model are capped at 1–2 benchmark files. Tracks `writesSinceDispatch`: attempting to modify a 3rd distinct source file is hard-denied (`deny`) and forced to delegate to Flash. Subagents, artifacts, and build/dependency paths are exempt. | Stops Pro from monopolizing multi-file engineering; enforces same-turn offloading to workers. |
| **Cold-Start, Recursion & Anti-Polling** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `manage_subagents`) | 1. **Evidence-based identity**: Requires parent metadata, a worker transcript or a cold-start contract marker. Recent spawns alone never identify a session; claims must match an explicit parent;<br>2. **Anti-Recursion**: Strictly denies nested subagent delegation (`deny`);<br>3. **Anti-Polling**: Denies host calls to `manage_subagents(Action="list")` (`deny`), preventing wasteful polling tokens and out-of-order race conditions; instructs agent to wait for reactive notification (`Action="kill"` allowed). | Prevents recursion deadlocks, race conditions, and wasted token cycles during async subagent execution. |
| **Neutral Contract & Subagent Definition** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `send_message`) | Appends `[FLASH-WORKER]` and `[PRO-CONTRACT]`: implementation workers must return a 4-column table with test output; `research` workers must return structured summaries without file writes. Injects contract into `define_subagent` SystemPrompt. Falls back safely to absolute path `~/.gemini/antigravity/brain/<convId>` if `artifactDirectoryPath` is missing. | Prevents source code pasting, avoids file-write errors in read-only sandboxes, and prevents workspace pollution. |
| **Sliced Multi-Read & Flood Guard** | `PreToolUse` (`read_file`, `view_file`) | 1. **Smart Slicing**: Unsliced reads of 300–800 line code files are clamped to [1, 150]; code >800 lines or docs >400 lines are denied;<br>2. **Minified Flood Guard**: Files >40KB with average line length >4KB are blocked;<br>3. **Sliced Multi-Read Guard**: Tracks `readsSinceDispatch`; attempting to read a 4th distinct source/doc file via slicing triggers a hard deny, mandating `research (flash)`. Dependency & artifact paths exempt. | Eliminates single-line minified dumps and context saturation; completely blocks multi-file slice-reading workarounds. |
| **Enhanced Dump Guard** | `PreToolUse` (`run_command`) | Unwraps multi-layer shells; splits pipelines; blocks unbounded `git log` and `cat`/`Get-Content` on files >400KB. **Enhanced Coverage**: Intercepts shell dumps across variable assignments (`$content = Get-Content`), sub-expressions (`Resolve-Path`), and .NET static methods (`[IO.File]::ReadAllText`). Allows file redirections (`>`, `>>`, `| Set-Content`, `> /dev/null`). | Prevents terminal flooding and seals command escape vectors without interfering with offline file writes. |
| **Turn-Boundary Wakeup & Deduplicated Drift** | `PreInvocation` | 1. **Turn-Boundary Wakeup**: In long conversations (`globalStep >= 8`), injects a transient 1-line `ephemeralMessage` at the start of new user turns to awaken the architect's dispatch discipline;<br>2. **Deduplicated Drift Warning**: Evaluates deduplicated and exempt-filtered `readsSinceDispatch` and `writesSinceDispatch`, alerting when consecutive reads/writes occur without delegation;<br>3. **Precision Filtering**: Silences architect drift warnings when the runtime model is Flash; parses AST/JSONL toolCall structures to eliminate false positives. | Zero context footprint, combining proactive turn wakeups with precision drift alerts to maintain architect discipline. |

---

## Separate maintenance and installation directories

Keep Git history, tests and release tooling in the maintenance checkout. Deploy only runtime files into Antigravity.

### Windows (PowerShell)

Skip cloning when the maintenance checkout already exists:

```powershell
git clone https://github.com/demgkp1/pro-flash-orchestrator.git "E:\Edoc\Projects\pro-flash-orchestrator"
cd "E:\Edoc\Projects\pro-flash-orchestrator"
node scripts/install.mjs
```

### macOS / Linux

```bash
git clone https://github.com/demgkp1/pro-flash-orchestrator.git ~/Projects/pro-flash-orchestrator
cd ~/Projects/pro-flash-orchestrator
node scripts/install.mjs
```

The default target is `.gemini/config/plugins/pro-flash-orchestrator` in the user home directory. Use `--target <install-directory>` to override it and `--dry-run` to preview deployment. The installer preserves `.state/` and excludes maintenance files.

### Updates and release archives

Run updates and all four test suites in the maintenance checkout, then redeploy:

```powershell
git pull
node scripts/doctor.mjs
node scripts/test-concurrency.mjs
node scripts/test-regressions.mjs
node scripts/test-install.mjs
node scripts/install.mjs
```

Build a runtime-only release with the cross-platform hook templates:

```powershell
node scripts/package.mjs --runtime --worktree
```

Use `--source --worktree` for a complete source archive. `runtime-files.json` defines the shared runtime allowlist, and `docs/INSTALL.md` supplies the installed README. Relocate any complete Git checkout from an existing install directory before deploying runtime files.

---

## Standard Workflow (/flash-dev)

The plugin bundles the `/flash-dev` skill to structure collaboration between the architect and worker models:

```text
/flash-dev Build a microservice for user authentication and payments. Design the schema, DDD layers, and the core benchmark service; dispatch Flash in the same turn to write the rest of CRUD, DTO validation, and integration tests.
```

### Execution Steps

1. Architectural Benchmark: The Pro architect drafts the schema, core API definitions, algorithms, or design tokens.
2. Same-Turn Dispatch: The architect writes the benchmark and dispatches `invoke_subagent` in the same turn; Flash workers expand the peripheral logic and unit tests.
3. Slice Verification: Upon receiving the 4-column completion report, the architect checks `git status --porcelain` and reads targeted 20–60 line slices to confirm correctness.

---

## Operational Modes

| Mode | Behavior | Recommended Use |
| :--- | :--- | :--- |
| `enforce` (Default) | All physical guards active; rewrites and blocks violations. | Standard production development. |
| `shadow` | Logs decisions to `.state/decisions.jsonl` without modifying behavior. | Policy observation and threshold tuning. |
| `off` | Completely bypassed; hooks return immediately. | Emergency troubleshooting. |

### Configuration

1. Configuration File (Immediate effect):
   Set in `.state/mode.json`:
   ```json
   { "mode": "shadow" }
   ```
   > **Security Notice (S1)**: `.state/mode.json` is a user security configuration that can only be manually edited by the user. It is strictly protected by physical guards against agent modification or overwriting.
   Read-only queries such as `Get-Content` and `cat` are allowed. Multi-file patches check every affected path, including rename destinations, before applying write quotas.
2. Environment Variable (Requires restarting Antigravity):
   - Windows PowerShell: `$env:PRO_MODE="shadow"`
   - macOS / Linux: `export PRO_MODE=shadow`

---

## Diagnostics and Telemetry

### 1. Automated Test & Concurrency Stress Suite
Run the 90-assertion diagnostic test suite:
```bash
node scripts/doctor.mjs
```

Run the multi-process concurrency stress & guard integration test suite:
```bash
node scripts/test-concurrency.mjs
```

Run the audit regression suite (identity isolation, all patch targets, lock contention, turn quotas, command guards and platform routing):
```bash
node scripts/test-regressions.mjs
```

Lock contention rejects the current quota update; retry the tool after the lock is released. The five-spawn quota resets on a new user turn, never on reads, writes or elapsed time. Turn IDs and `UserPromptSubmit` events distinguish identical prompts; hosts without these signals use changed user input or an invocation counter reset.

### 2. Decision Review
Inspect production decisions from the last 7 days (test-generated entries are automatically excluded):
```bash
node scripts/report.mjs
```

Inspect over a custom window:
```bash
node scripts/report.mjs --days 30
```

---

## Known Limitations

- **Pipeline & Redirection Bypass (S5)**: Shell pipelines and stream-processing commands executed directly via `run_command` (such as `head`, `grep`, `sed`, or file redirections `>`) are monitored by the command dump guard for flood prevention, but do not increment `read_file` multi-read or `write_file` benchmark tracking quotas.

---

## Directory Structure

```text
pro-flash-orchestrator/
├── .github/
│   └── workflows/
│       └── release.yml         # GitHub Actions CI & release pipeline
├── runtime-files.json          # Runtime distribution manifest
├── docs/INSTALL.md             # Installed README template
├── plugin.json                 # Antigravity plugin manifest
├── hooks.json                  # Lifecycle hook routing definitions
├── hooks/
│   ├── claude-settings-hooks.json # Claude Code hooks configuration
│   └── codex-hooks.json        # OpenAI Codex CLI hooks configuration
├── .gitattributes              # Enforces LF line endings for shell scripts
├── LICENSE                     # MIT License
├── README.md                   # English technical documentation
├── README.zh-CN.md             # Chinese technical documentation
├── rules/
│   └── AGENTS.md               # Persistent roles and boundaries
├── skills/
│   └── flash-dev/
│       └── SKILL.md            # /flash-dev prompt templates and procedures
├── scripts/
│   ├── lib.mjs                 # Shared utility library (subagent detection, spawn window, logging)
│   ├── session-start.mjs       # Startup role injection and status card
│   ├── pre-invocation.mjs      # Turn-boundary wakeup & deduplicated drift detector
│   ├── guard-subagent.mjs      # Sub-agent guard (recursion, polling, downgrade, contract)
│   ├── guard-read-file.mjs     # Read guard (slicing, dependency exemptions, multi-read deny)
│   ├── guard-write-file.mjs    # Write guard (benchmark edits limit, multi-file write deny)
│   ├── guard-command.mjs       # Command guard (unwrapping, redirection, dump blocks)
│   ├── doctor.mjs              # 90-assertion automated test suite
│   ├── test-concurrency.mjs    # Concurrency stress & guard integration test suite
│   ├── test-regressions.mjs    # Reproductions of audited defects and boundary cases
│   ├── install.mjs             # Runtime-only deployment from the maintenance checkout
│   ├── runtime-files.mjs       # Shared runtime allowlist loader
│   ├── test-install.mjs        # Runtime boundary and state preservation tests
│   ├── package.mjs             # Multi-platform distribution packager
│   └── report.mjs              # Production decision telemetry reviewer
└── assets/
    └── logo.svg                # Plugin icon
```

---

## License

This project is licensed under the [MIT License](LICENSE).
