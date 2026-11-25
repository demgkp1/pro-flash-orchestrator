---
name: pfo-setup
description: Set up or diagnose Pro-Flash Orchestrator native Codex hooks and verified worker-model configuration.
---

# Setup

For the standalone Codex ZIP, run these commands from the extracted `pro-flash-orchestrator-codex` marketplace root:

- `node install.mjs`
- `node doctor.mjs`
- after configuring a worker, `node doctor.mjs --verify-worker`

For a maintained source checkout, use the equivalent commands:

- `node scripts/install.mjs --platform codex`
- `node scripts/doctor.mjs --platform codex`
- `node scripts/doctor.mjs --platform codex --verify-worker`

Use `node install.mjs --uninstall` in the standalone package, or `node scripts/install.mjs --platform codex --uninstall` in the source checkout, to unregister the integration. Uninstall preserves source and control/configuration files.

Installation must use the official Codex marketplace and plugin CLI. Do not mutate plugin caches. If bundled plugin hooks are not actually loaded, the installer may merge the six Pro-Flash events into `CODEX_HOME/hooks.json`; it must preserve unrelated hooks and make changed runtime code require review again.

Do not read, print, copy, or change API credentials. Verification reuses the existing Codex provider and authentication. It makes a minimal real model request with tools disabled.

Ask the user to review all six installed hooks in Settings > Hooks (desktop) or `/hooks` (CLI). Never bypass hook trust or mark hooks trusted yourself. Changed hook scripts require another review.

Plugin config and verification live in the user's `.codex/plugin-data/pro-flash-orchestrator` directory. Session state and decision logs prefer the runtime `PLUGIN_DATA` directory. The doctor command reports the observed data path. Mode supports `enforce`, `shadow`, and `off`. Configure `workerModel` and `workerReasoningEffort` in `config.json`, then reverify.

The distributed worker candidate is `gpt-5-mini` with low reasoning effort and must pass verification in the current provider. A failed probe blocks dispatch without falling back to the main model.

Do not claim the plugin works merely because files exist or offline tests pass. Check native hook trust, a recent actual hook event, the current provider, and observed worker-model verification. Report full native guard and worker-dispatch acceptance as pending until both are exercised end to end. Also report hosted-tool, timeout/error, approved-interactive-shell, account-login, and Claude Code coverage gaps.
