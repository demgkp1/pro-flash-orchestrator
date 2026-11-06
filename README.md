# Pro-Flash Orchestrator

A dual-tier model orchestration engine for Google Antigravity.

Designed to keep the flagship Pro model focused on architecture, core API design, and code review, while offloading routine implementation, unit tests, and document exploration to Flash and Flash-Lite. All governance policies are enforced at the runtime lifecycle Hook level via deterministic physical guards.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v3.3.0-lightgrey.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%202.0-lightgrey.svg)](#)
[![Tests](https://img.shields.io/badge/Tests-63%20Passed-green.svg)](#)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Design Rationale

In long-running pair programming sessions, relying solely on a flagship model (Pro) leads to two common bottlenecks:

1. Quota & Budget Depletion: Expensive reasoning tokens are expended on boilerplate CRUD, repetitive data transforms, and writing extensive test suites.
2. Context Window Degradation: Unbounded dumps (such as direct `cat` calls or unsliced reads of massive files) saturate the context window, degrading subsequent reasoning performance.

Soft guidelines embedded in system prompts ("please delegate routine work") frequently fail as context grows and prompt drift occurs. Pro-Flash Orchestrator introduces Antigravity lifecycle hooks that enforce hard physical checks and parameter rewrites at tool execution (`PreToolUse`), model invocation (`PreInvocation`), and session startup (`SessionStart`).

---

## Collaboration Model

```text
[ User Prompt / /flash-dev ]
            │
            ▼
┌────────────────────────────────────────┐
│        Pro Lead Architect (Flagship)   │
│  - Domain modeling & database schema   │
│  - Core benchmark & algorithm design   │
│  - Dispatches sub-agents in same turn  │
└───────────────────┬────────────────────┘
                    │ invoke_subagent
                    ▼
┌────────────────────────────────────────┐
│     Runtime Hook Interception Guards   │
│  - Forced downgrade: Pro -> Flash/Lite │
│  - Automatically appends [PRO-CONTRACT]│
│  - Recursion block: Denies nested tasks│
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│        Flash Worker (Lightweight)      │
│  - Mechanical CRUD / Unit tests        │
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
| **Role & Card Setup** | `SessionStart` | Injects persistent rules once at session start; status card is emitted via `renderInfo` to the UI layer. | Status card consumes 0 model tokens and leaves no residue in the context window. |
| **Physical Downgrade** | `PreToolUse` (`invoke_subagent`) | Intercepts subagent calls requesting `pro`; rewrites to `flash` or `flash_lite` unless explicitly exempted via `[FORCE-PRO]`. | Prevents expensive Pro tokens from being consumed on routine coding tasks. |
| **Recursion Prevention** | `PreToolUse` (`invoke_subagent`, `define_subagent`) | Detects sub-agent context via transcript examination (`SYSTEM`/`SYSTEM_SDK`) and denies further delegations. | Eliminates runaway recursive subagent loops. |
| **Neutral Contract** | `PreToolUse` (`invoke_subagent`, `send_message`) | Appends `[PRO-CONTRACT]`: implementation workers must return a 4-column table with test output; `research` workers must return structured summaries without file writes. | Prevents source code pasting and file-write errors in read-only sandboxes. |
| **Smart File Slicing** | `PreToolUse` (`read_file`, `view_file`) | Unsliced reads of 300–800 line code files are clamped to lines [1, 150]; code >800 lines or docs >400 lines are denied. `.venv` and `target` paths are automatically exempt. | Eliminates context flooding; small file slicing incurs zero extra round-trips. |
| **Dump Prevention** | `PreToolUse` (`run_command`) | Unwraps multi-layer shells; splits pipelines; blocks unbounded `git log` and `cat`/`Get-Content` on files >400KB. Allows file redirections (`>`, `>>`, `| Set-Content`, `> /dev/null`). | Prevents terminal flooding without interfering with offline file writes. |
| **Drift Detection** | `PreInvocation` | Evaluates transcript history; injects a single-turn `ephemeralMessage` reminder when 4+ consecutive solo file edits occur without delegation. | Remains silent by default; nudges only when execution drift occurs. |

---

## Installation

Clone directly into Antigravity's global plugin directory with a single command:

### Windows (PowerShell)
```powershell
git clone https://github.com/demgkp1/pro-flash-orchestrator.git "$HOME\.gemini\config\plugins\pro-flash-orchestrator"
```

### macOS / Linux (bash / zsh)
```bash
git clone https://github.com/demgkp1/pro-flash-orchestrator.git ~/.gemini/config/plugins/pro-flash-orchestrator
```

### Updating
Pull the latest version directly inside the plugin directory:
```bash
cd ~/.gemini/config/plugins/pro-flash-orchestrator && git pull
```

<details>
<summary>Developer Mode (Linking from a custom workspace)</summary>

If you are developing the plugin inside a custom repository workspace (e.g., `~/projects/pro-flash-orchestrator`):

- Windows:
  ```powershell
  cd <workspace-dir>
  .\install.ps1
  ```
- macOS / Linux:
  ```bash
  cd <workspace-dir>
  chmod +x ./install.sh && ./install.sh
  ```
</details>

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
2. Environment Variable (Requires restarting Antigravity):
   - Windows PowerShell: `$env:PRO_MODE="shadow"`
   - macOS / Linux: `export PRO_MODE=shadow`

---

## Diagnostics and Telemetry

### 1. Test Suite
Run the 63-assertion diagnostic test suite:
```bash
node scripts/doctor.mjs
```

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

## Directory Structure

```text
pro-flash-orchestrator/
├── plugin.json                 # Antigravity plugin manifest
├── hooks.json                  # Lifecycle hook routing definitions
├── .gitattributes              # Enforces LF line endings for shell scripts
├── LICENSE                     # MIT License
├── README.md                   # English technical documentation
├── README.zh-CN.md             # Chinese technical documentation
├── install.ps1                 # Windows Junction installer
├── install.sh                  # macOS/Linux symlink installer
├── rules/
│   └── AGENTS.md               # Persistent roles and boundaries
├── skills/
│   └── flash-dev/
│       └── SKILL.md            # /flash-dev prompt templates and procedures
├── scripts/
│   ├── lib.mjs                 # Shared utility library
│   ├── session-start.mjs       # Startup role injection and status card
│   ├── pre-invocation.mjs      # Sliding-window transcript drift detector
│   ├── guard-subagent.mjs      # Sub-agent guard (recursion, downgrade, contract)
│   ├── guard-read-file.mjs     # Read guard (slicing, dependency exemptions)
│   ├── guard-command.mjs       # Command guard (unwrapping, redirection, dump blocks)
│   ├── doctor.mjs              # 63-assertion automated test suite
│   └── report.mjs              # Production decision telemetry reviewer
└── assets/
    └── logo.svg                # Plugin icon
```

---

## License

This project is licensed under the [MIT License](LICENSE).
