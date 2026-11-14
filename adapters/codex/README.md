# Pro-Flash Orchestrator for Codex

This ZIP is an independent Codex local marketplace. Antigravity is not required. Keep the extracted `pro-flash-orchestrator-codex/` directory intact: its plugin is under `plugins/pro-flash-orchestrator/`.

## Install

From the extracted marketplace root, run:

```bash
node install.mjs
node doctor.mjs
```

The installer registers the marketplace and plugin with the official `codex plugin marketplace add` and `codex plugin add` commands. It does not edit plugin caches.

Codex CLI `0.167.0-alpha.3.2` did not load the bundled plugin hooks during acceptance. For compatibility, the installer therefore merges six user-native hook events into `CODEX_HOME/hooks.json` (normally `~/.codex/hooks.json`). Existing unrelated hooks are preserved and backed up. Each generated command includes a hash of the plugin runtime; changed code produces a changed command that must be reviewed again.

Review all six Pro-Flash hooks in desktop **Settings > Hooks** or CLI `/hooks`, mark them trusted yourself, then start a new session. The installer never changes trust.

## Configure and verify a worker

Edit `CODEX_HOME/plugin-data/pro-flash-orchestrator/config.json`, then run a minimal real request through the configured provider:

```bash
node doctor.mjs --verify-worker
node doctor.mjs
```

The v0.7.0 distributed candidate is `gpt-5-mini` with low reasoning effort, but dispatch remains blocked until that exact model/provider configuration passes verification. There is no silent fallback to the main model. Choose a model exposed by the native spawn tool and your provider. The current host exposes `gpt-6.1-sol` and `gpt-6-astra`; its local worker is `gpt-6.1-sol`/low. Historical probe results remain in the repository acceptance evidence.

Control files live under `CODEX_HOME/plugin-data/pro-flash-orchestrator`. Set `mode.json` to `enforce`, `shadow`, or `off`. Configuration and verification survive plugin replacement; changing the provider, model, or reasoning effort invalidates the old proof.

## Uninstall

From the extracted marketplace root:

```bash
node install.mjs --uninstall
```

This unregisters the plugin and marketplace and removes only the generated Pro-Flash entries from the user hook registry. The extracted source and control/configuration directory are preserved.

## Acceptance status

Six user-native hooks were user-reviewed as trusted, and a real desktop `PreToolUse` event was observed. A minimal CLI probe succeeded for the current local `gpt-6.1-sol` selection, but native workers encountered upstream unavailability and invalidated that proof. Full guard coverage and a native end-to-end worker-dispatch acceptance run remain pending, so v0.7.0 is not claimed as fully live-usable on Codex.

Hosted tools, hook errors/timeouts, and later input to an already-approved interactive shell may be outside coverage. Account sign-in and Claude Code have not been live-validated. See the repository's `docs/codex-acceptance-v0.5.2.md` for the evidence and remaining checklist.

## Decision report

Run `node report.mjs` or `node report.mjs --days 30` from the marketplace root. The wrapper selects the Codex data directory before importing the shared report, which displays startup strategies, refusal categories and estimated KB / tokens saved by real read guards. It excludes test logs and shadow savings.
