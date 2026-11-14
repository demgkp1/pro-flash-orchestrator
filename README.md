# Pro-Flash Orchestrator

A lifecycle-hook orchestration engine for Google Antigravity, with an independently packaged Codex adapter.

Designed for universal software engineering, code review, bug diagnosis, refactoring, and document exploration. It keeps the flagship model focused on core decisions and benchmark implementations while offloading peripheral implementation, tests, and exploration to a verified lightweight worker. Antigravity is the established runtime; v0.7.0 includes a separately installed Codex integration under staged native acceptance.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-v0.7.0-lightgrey.svg)](https://github.com/demgkp1/pro-flash-orchestrator)
[![Platform](https://img.shields.io/badge/Platform-Antigravity%20%7C%20Codex-lightgrey.svg)](#)
[![Tests](https://img.shields.io/badge/Offline%20Suites-8%20Passed-green.svg)](#)

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Design Rationale

In long-running pair programming sessions, relying solely on a flagship model (Pro) leads to two common bottlenecks:

1. Quota & Budget Depletion: Expensive reasoning tokens are expended on boilerplate CRUD, repetitive data transforms, and writing extensive test suites.
2. Context Window Degradation: Unbounded dumps (such as direct `cat` calls or unsliced reads of massive files) saturate the context window, degrading subsequent reasoning performance.

Soft guidelines embedded in system prompts ("please delegate routine work") frequently fail as context grows and prompt drift occurs. Pro-Flash Orchestrator introduces Antigravity lifecycle hooks that enforce hard physical checks and parameter rewrites at tool execution (`PreToolUse`), model invocation (`PreInvocation`), and session startup (`SessionStart`).

---

## v0.7.0 guard updates

v0.7.0 introduces non-blocking background update checks and git-free one-click runtime updates, adds the subagent Thrashing Circuit Breaker, and hardens AGY model capability detection and model enum safety:

- **Non-blocking Update Checks & In-place Updater**: `check-update-worker.mjs` runs asynchronously during `SessionStart` and caches GitHub Releases metadata to `.state/update-check.json`, introducing zero network delay to session startup. New versions surface via transient UI cards; setting `PRO_NO_UPDATE_CHECK=1` completely disables update checks. Pre-packaged Release users can upgrade in-place without Git by executing `node "<install-directory>/scripts/update.mjs"`, which pulls the latest minimal release archive, validates boundary security, and 100% preserves user `.state/` configuration and telemetry. Offline upgrades via `--zip <path>` and preview with `--dry-run` are fully supported.
- **Subagent Thrashing Circuit Breaker**: Prevents subagents from endlessly retrying failing commands. In `guard-command.mjs`, consecutive executions of the exact same command within the same subagent task are counted. When reaching `PRO_THRASH_LIMIT` (default 3, representing 2 failed retries), a physical `deny` is issued, terminating the retry loop and mandating that the subagent report the error in a 4-column table for the Pro lead architect to resolve.
- **AGY Probe Timeout & Subagent Model Safety**: The startup `agy models` probe timeout is relaxed to 5500ms; on Windows, it executes `cmd.exe /c agy.cmd models` directly to eliminate `.cmd` execution failures and secondary timeout cascades. The `INVOCABLE_SUBAGENT_MODELS` validator guarantees that subagent worker models only evaluate to legal Antigravity enums (`inherit`, `flash_lite`, `flash`, `pro`), rejecting illegal IDs from environment variables.
- **PowerShell Aliases & Session Stability**: `guard-command.mjs` recognizes the PowerShell `select` alias (`Select-Object`) for pipeline slicing (`-First`/`-Last`) and read-only inspection. Child command recording uses `sessionExists` to prevent creating empty skeleton parent session state files. `scripts/install.mjs` normalizes CRLF and LF line endings during file comparison to eliminate spurious overwrites.
- **Established v0.6 Guards Preserved**: Preserves Hydrogen worker inheritance (`inherit`), Flash main relaxed policy (`flash-main-relaxed`), native Orchestrator Lite Guard Mode, atomic same-batch file mutex locks with parent session locking, turn-based audit slice budgets (≤80 lines), recursion/polling blocks, and context savings telemetry in `report.mjs`.

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
│  - Worker routing from startup data    │
│    Hydrogen -> inherit; others -> flash│
│  - Injects [FLASH-WORKER] & contract   │
│  - Anti-recursion & anti-polling       │
│  - Read/Write guards: slices & limits  │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│        Worker (Hydrogen / Flash)       │
│  - Explores and expands assigned files │
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
| **Worker Model Routing** | `PreToolUse` (`invoke_subagent`) | Startup capabilities and the main model select legal worker parameters: Hydrogen main sessions use `inherit`, other main sessions default to `flash`. Task overrides take precedence; native Orchestrator routing and explicit `[FORCE-PRO]` selections are preserved. | Uses the best available worker through host-compatible parameters. |
| **Write Guard & Benchmark Limit** | `PreToolUse` (`write_file`, `edit_file`, etc.) | Tracks `writesSinceDispatch`: the strict main policy permits two source files, while `flash-main-relaxed` permits four. Further distinct files require delegation. Child sessions bypass the main quota; artifacts and build/dependency paths are exempt. | Keeps benchmark work focused and delegates peripheral edits. |
| **Batch File Ownership** | `PreToolUse` (source writes and `apply_patch`) | Atomically checks and claims all normalized targets in the parent's `batchFileClaims`. The same child may retry; another child's claim causes a deny. New batches or audit IDs release claims; same-batch dispatches retain them. | Prevents parallel subagents from overwriting each other's edits. |
| **Cold-Start, Recursion & Anti-Polling** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `manage_subagents`) | 1. **Evidence-based identity**: Requires parent metadata, a worker transcript or a cold-start contract marker. Recent spawns alone never identify a session; claims must match an explicit parent;<br>2. **Anti-Recursion**: Strictly denies nested subagent delegation (`deny`);<br>3. **Anti-Polling**: Denies host calls to `manage_subagents(Action="list")` (`deny`), preventing wasteful polling tokens and out-of-order race conditions; instructs agent to wait for reactive notification (`Action="kill"` allowed). | Prevents recursion deadlocks, race conditions, and wasted token cycles during async subagent execution. |
| **Neutral Contract & Subagent Definition** | `PreToolUse` (`invoke_subagent`, `define_subagent`, `send_message`) | Appends `[FLASH-WORKER]` and `[PRO-CONTRACT]`: implementation workers must return a 4-column table with test output; `research` workers must return structured summaries without file writes. Injects contract into `define_subagent` SystemPrompt. Falls back safely to absolute path `~/.gemini/antigravity/brain/<convId>` if `artifactDirectoryPath` is missing. | Prevents source code pasting, avoids file-write errors in read-only sandboxes, and prevents workspace pollution. |
| **Sliced Multi-Read & Flood Guard** | `PreToolUse` (`read_file`, `view_file`) | 1. **Smart Slicing**: Unsliced reads of 300–800 line code files are clamped to [1, 150]; code >800 lines or docs >400 lines are denied;<br>2. **Minified Flood Guard**: Files >40KB with average line length >4KB are blocked;<br>3. **Sliced Multi-Read Guard**: Tracks `readsSinceDispatch`; attempting to read a 4th distinct source/doc file via slicing triggers a hard deny, mandating `research (flash)`. Dependency & artifact paths exempt. | Eliminates single-line minified dumps and context saturation; completely blocks multi-file slice-reading workarounds. |
| **Enhanced Dump Guard & Thrashing Breaker** | `PreToolUse` (`run_command`) | Unwraps multi-layer shells; splits pipelines; blocks unbounded `git log` and `cat`/`Get-Content` on files >400KB. Intercepts shell dumps across variable assignments (`$content = Get-Content`), sub-expressions (`Resolve-Path`), and .NET static methods (`[IO.File]::ReadAllText`). Allows file redirections (`>`, `>>`, `| Set-Content`, `> /dev/null`). Recognizes PowerShell `select` alias. **Thrashing Circuit Breaker**: Tracks consecutive executions of identical failing commands by subagents; triggers a physical hard deny at `PRO_THRASH_LIMIT` (default 3) to break retry loops and mandate Pro architect takeover. | Prevents terminal flooding and context pollution; stops wasteful subagent retry loops and enforces timely escalation. |
| **Turn-Boundary Wakeup & Deduplicated Drift** | `PreInvocation` | 1. **Turn-Boundary Wakeup**: In long conversations (`globalStep >= 8`), injects a transient 1-line `ephemeralMessage` at the start of new user turns to awaken the architect's dispatch discipline;<br>2. **Deduplicated Drift Warning**: Evaluates deduplicated and exempt-filtered `readsSinceDispatch` and `writesSinceDispatch`, alerting when consecutive reads/writes occur without delegation;<br>3. **Precision Filtering**: Applies relaxed thresholds to Flash main sessions and skips count nudges for native Orchestrator; parses AST/JSONL toolCall structures to eliminate false positives. | Zero context footprint, combining proactive turn wakeups with precision drift alerts to maintain architect discipline. |

---

## Platform packages and installation

v0.7.0 publishes two independent release assets:

- `pro-flash-orchestrator-antigravity-v0.7.0.zip`, rooted at `pro-flash-orchestrator/`.
- `pro-flash-orchestrator-codex-v0.7.0.zip`, rooted at `pro-flash-orchestrator-codex/` and containing the standalone marketplace plugin at `plugins/pro-flash-orchestrator/`.

### Antigravity

#### Option 1: Git-free One-click Online Update (Recommended for Release Users)

Users who installed from release packages can update in-place without Git or maintaining a source clone:

```powershell
node "<install-directory>/scripts/update.mjs"
```

The updater fetches the latest minimal release archive (`pro-flash-orchestrator-antigravity-v*.zip`) from GitHub Releases, verifies path boundaries against symlink attacks, overwrites runtime files, and 100% preserves your `.state/` settings, mode, and telemetry history.
- Offline update using a downloaded archive:
  ```powershell
  node "<install-directory>/scripts/update.mjs" --zip "path/to/pro-flash-orchestrator-antigravity-v0.7.0.zip"
  ```
- Use `--dry-run` to preview file changes without writing to disk.

#### Option 2: Deployment from Source / Maintenance Checkout

Keep Git history, tests, and release tooling in a maintenance checkout. Deploy only allowlisted runtime files into Antigravity:

```powershell
git clone https://github.com/demgkp1/pro-flash-orchestrator.git "E:\Edoc\Projects\pro-flash-orchestrator"
cd "E:\Edoc\Projects\pro-flash-orchestrator"
node scripts/install.mjs
```

On macOS or Linux, use any separate maintenance path such as `~/Projects/pro-flash-orchestrator`. The default install target is `.gemini/config/plugins/pro-flash-orchestrator` in the user home directory. Use `--target <install-directory>` to override it and `--dry-run` to preview deployment. The installer preserves `.state/` and excludes maintenance files.

### Codex standalone local marketplace

Extract the Codex ZIP, enter its marketplace root, and run:

```bash
node install.mjs
node doctor.mjs
```

The installer uses the official `codex plugin marketplace add` and `codex plugin add` commands; it does not modify plugin caches. Codex CLI `0.167.0-alpha.3.2` did not load bundled plugin hooks in the acceptance environment, so the installer also connects six user-native events through `CODEX_HOME/hooks.json`. It preserves and backs up unrelated hooks. The generated commands include a runtime hash, so changed code requires review again.

Review all six Pro-Flash entries in desktop **Settings > Hooks** or CLI `/hooks`, mark them trusted yourself, and start a new session. Then edit `CODEX_HOME/plugin-data/pro-flash-orchestrator/config.json` and verify the exact worker/provider selection:

```bash
node doctor.mjs --verify-worker
node doctor.mjs
```

The v0.7.0 distributed candidate is `gpt-5-mini` with low reasoning effort, but it must pass a real request before dispatch is enabled. Select a worker from the native tool model catalog as well as the provider catalog: this host currently exposes `gpt-6.1-sol` and `gpt-6-astra`, and its local worker is configured as `gpt-6.1-sol`/low. Historical provider probes are recorded in the acceptance document; a minimal CLI probe cannot establish native worker availability. A failed or stale proof blocks dispatch without falling back to the main model.

Unregister the standalone integration with:

```bash
node install.mjs --uninstall
```

Uninstall removes only the generated Pro-Flash user-hook entries and official registrations; it preserves the extracted source and `CODEX_HOME/plugin-data/pro-flash-orchestrator` controls.

Six user-native hooks have been user-reviewed as trusted and a real desktop `PreToolUse` event was observed. Full native guard coverage and an end-to-end native worker-dispatch acceptance run remain pending, so v0.7.0 is not claimed as fully live-usable on Codex. Account sign-in and Claude Code are also not live-validated. See the [Codex adapter acceptance evidence](docs/codex-acceptance-v0.5.2.md).

### Maintenance tests and release archives

Public/offline maintenance gates make no provider API requests:

```powershell
git pull
node scripts/doctor.mjs
node scripts/test-concurrency.mjs
node scripts/test-regressions.mjs
node scripts/test-v060.mjs
node scripts/test-capabilities.mjs
node scripts/test-install.mjs
node scripts/test-codex.mjs
node scripts/test-update.mjs
node scripts/install.mjs
```

Build the two runtime-only packages independently:

```powershell
node scripts/package.mjs --runtime --platform antigravity --worktree
node scripts/package.mjs --runtime --platform codex --worktree
```

`runtime-files.json` and the Codex marketplace builder define separate exact allowlists. Use `--source --worktree` for a complete source archive. Relocate any complete Git checkout from an existing install directory before deploying runtime files.

v0.7.0 combines these guard updates with the independently packaged platform adapters; native acceptance status remains tracked in the linked evidence.

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
2. Environment Variables (Require restarting Antigravity / shell):
   - Operational mode:
     - Windows PowerShell: `$env:PRO_MODE="shadow"`
     - macOS / Linux: `export PRO_MODE=shadow`
   - Background update checks:
     - Set `PRO_NO_UPDATE_CHECK=1` to completely disable background GitHub release update checks and session startup notice cards.
   - Subagent Thrashing Circuit Breaker:
     - Set `PRO_THRASH_LIMIT=3` (default 3, minimum 2) to configure the maximum consecutive identical commands a subagent can execute before triggering a physical deny and escalating to the Pro lead architect.

---

## Diagnostics and Telemetry

### 1. Automated Test & Concurrency Stress Suite
Run the doctor suite, including report statistics and concurrent file ownership checks. Its final line shows the current host's `strategy`, `hasHydrogen`, and `source`:
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

Run the offline Codex protocol and exact-package-allowlist suite (no provider/API calls):
```bash
node scripts/test-codex.mjs
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

The report shares `STATE_DIR` and `LOG_FILE` with the hooks, honoring `PRO_STATE_DIR`, `PLUGIN_DATA`, and the Codex state directory. Its ROI panel counts startup strategies and estimates saved context from actual denied reads and requested/retained slice spans, using four bytes per token. Shadow decisions do not count as actual savings. The standalone Codex package provides `node report.mjs` for the Codex data directory.

---

## Known Limitations

- **Pipeline & Redirection Bypass (S5)**: Shell pipelines and stream-processing commands executed directly via `run_command` (such as `head`, `grep`, `sed`, or file redirections `>`) are monitored by the command dump guard for flood prevention, but do not increment `read_file` multi-read or `write_file` benchmark tracking quotas or claim batch file ownership.
- **Codex acceptance is incomplete**: Hosted tools, hook errors/timeouts, and later input to an already-approved interactive shell may be outside native-hook coverage. Full guard and native worker-dispatch acceptance remain pending; account sign-in and Claude Code are not live-validated.

---

Root `SKILL.md` and `AGENTS.md` mirror `skills/flash-dev/SKILL.md` and `rules/AGENTS.md`; release tests verify their contents remain synchronized.

## Directory Structure

```text
pro-flash-orchestrator/
├── adapters/codex/             # Standalone Codex marketplace entry points, hooks and skills
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
│   ├── session-start.mjs       # Startup role injection, capabilities and update check trigger
│   ├── check-update-worker.mjs # Non-blocking background GitHub release update checker
│   ├── update.mjs              # In-place runtime updater preserving .state/
│   ├── pre-invocation.mjs      # Turn-boundary wakeup & deduplicated drift detector
│   ├── guard-subagent.mjs      # Sub-agent guard (recursion, polling, downgrade, contract)
│   ├── guard-read-file.mjs     # Read guard (slicing, dependency exemptions, multi-read deny)
│   ├── guard-write-file.mjs    # Write guard (benchmark limits and batch file ownership)
│   ├── guard-command.mjs       # Command guard (unwrapping, redirection, thrashing circuit breaker)
│   ├── doctor.mjs              # Doctor suite, live capability snapshot and Codex diagnostics
│   ├── test-concurrency.mjs    # Concurrency stress & guard integration test suite
│   ├── test-regressions.mjs    # Reproductions of audited defects and boundary cases
│   ├── test-update.mjs         # Background update checker and in-place updater test suite
│   ├── install.mjs             # Antigravity deployment and Codex marketplace setup
│   ├── codex-*.mjs             # Native Codex hook, runtime, setup and maintenance bridge
│   ├── runtime-files.mjs       # Shared runtime allowlist loader
│   ├── test-install.mjs        # Runtime boundary and state preservation tests
│   ├── test-codex.mjs          # Offline Codex protocol and package allowlist tests
│   ├── package.mjs             # Multi-platform distribution packager
│   └── report.mjs              # Production decision telemetry reviewer
└── assets/
    └── logo.svg                # Plugin icon
```

---

## License

This project is licensed under the [MIT License](LICENSE).
