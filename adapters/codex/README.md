# Pro-Flash Orchestrator for Codex

This ZIP contains a complete Codex marketplace. Antigravity is not required. Its plugin is under plugins/pro-flash-orchestrator/.

## Install

From the extracted marketplace root:

    node install.mjs
    node doctor.mjs

The default installer registers https://github.com/demgkp1/pro-flash-orchestrator.git with ref codex-marketplace, then installs pro-flash-orchestrator@pro-flash-local. The marketplace identity remains pro-flash-local, including when migrating an older local installation. Successful installation uses official Codex commands, not direct cache edits.

Git is required for the default installer. It first clones and validates the release branch before changing any installation or configuration. An unavailable or not-yet-published branch leaves the previous installation in place; it does not silently fall back to local. Codex rejects same-name add from a different source, so migration snapshots the old state and removes only the marketplace registration, never its local origin or a pre-existing plugin. Later failures restore the old source via the CLI, this plugin's versioned cache snapshot, enabled/disabled state, controls and owned hook/config entries. Unrelated concurrent config and hooks are preserved. A native rollback failure explicitly reports that recovery needs attention.

A registered marketplace and working global hooks (including historical 0.5.2 installations) do not prove that a native plugin is installed. Check the installed array, not just the marketplace list:

    codex plugin marketplace list --json
    codex plugin list --json

The installer supports a registered marketplace with no installed plugin record, verifies the new native record/version after plugin add, and preserves an existing disabled state. Real CLI 0.171.0-alpha.13.2 isolated local fixtures verified same-name rejection, remove preserving the old origin/cache, and rollback; these are not claims about the user's live installation.

For offline installation or local development, keep the extracted directory and choose local explicitly:

    node install.mjs --local
    node doctor.mjs

The maintained source checkout has the same defaults and an explicit local option:

    node scripts/install.mjs --platform codex --git
    node scripts/install.mjs --platform codex --local

To generate a local deployment without registering any marketplace:

    node scripts/install.mjs --platform codex --no-register

This works before the first release branch exists. The standalone entry also accepts --ref codex-marketplace, --dry-run and --uninstall. For example:

    node install.mjs --git --ref codex-marketplace --dry-run

Codex CLI 0.167.0-alpha.3.2 did not load bundled hooks during historical acceptance. When bundled hooks are unavailable, the installer merges six user-native events into CODEX_HOME/hooks.json (normally ~/.codex/hooks.json). Unrelated hooks are preserved and backed up. Git bridges point to the configured Git snapshot returned by codex plugin marketplace list --json, rather than the old ZIP directory. Refreshing that stable snapshot lets the bridge import its updated script. Re-running installation regenerates the runtime hash in bridge commands and requires review again.

Review all six Pro-Flash hooks in desktop **Settings > Hooks** or CLI /hooks, mark them trusted yourself, then start a new session. The installer never changes trust.

## Upgrade

For a Git installation, explicitly refresh the published snapshot:

    codex plugin marketplace upgrade pro-flash-local --json
    codex plugin add pro-flash-orchestrator@pro-flash-local --json
    node install.mjs
    node doctor.mjs

Review changed hooks and start a new session. An old source_type = "local" installation must first migrate by running the new default installer. Local development installations refresh by deploying a new local package and re-running node install.mjs --local. Antigravity's scripts/update.mjs is not a Codex upgrade path.

The plugin entry uses source: local relative to the Git snapshot. CLI marketplace upgrade is the supported Git-snapshot refresh mechanism; its command/help has been checked, while a real remote refresh still needs the first publication. Isolated tests executed an unchanged bridge against a stable marketplace root before and after replacing its script, including the Windows command. Whether the desktop **plugin upgrade button** also refreshes the parent Git snapshot, and whether it replaces an installed plugin from that relative local entry, still require testing after publication. Native-button upgrades have not been live-validated. A git-subdir plugin source targeting this release branch is an alternative if native single-plugin upgrade cannot refresh the relative local source.

## First publication

The codex-marketplace branch may not exist until the first stable Release runs the new workflow. Before that first publication, use node install.mjs --local or generate a local package with the maintained source's --no-register option.

Maintainers must commit the implementation and prepare plugin.json and release notes for a new stable version before tagging it. For example, after preparing version 0.7.4:

    git tag v0.7.4
    git push origin v0.7.4

The Release workflow verifies tag/manifest agreement, creates or updates the GitHub Release, then publishes the already-built Codex ZIP contents to codex-marketplace. The branch root contains .agents/plugins/marketplace.json, the complete plugin and entry wrappers. Drafts and prereleases are excluded. Publication is serialized, skips equal or older versions, and uses a normal fast-forward push so concurrent newer releases cannot be overwritten. Generated marketplace contents are not committed to main.

After a successful first publication:

    git ls-remote --heads https://github.com/demgkp1/pro-flash-orchestrator.git refs/heads/codex-marketplace
    node install.mjs --git --ref codex-marketplace

An existing stable tag can be rerun from Actions after these changes are part of its tagged commit. A branch-based manual run only packages archives; it does not publish the stable marketplace.

## Configure and verify a worker

Edit CODEX_HOME/plugin-data/pro-flash-orchestrator/config.json, then verify the selected model through its configured provider:

    node doctor.mjs --verify-worker
    node doctor.mjs

The distributed candidate is gpt-5-mini with low reasoning effort. Dispatch remains blocked until that exact model/provider configuration passes verification. Choose a model exposed by the native spawn tool and provider; there is no silent fallback to the main model.

Control files live under CODEX_HOME/plugin-data/pro-flash-orchestrator. Set mode.json to enforce, shadow or off. Configuration and verification survive plugin replacement; changing the provider, model or reasoning effort invalidates the old proof.

## Uninstall

From the extracted marketplace root:

    node install.mjs --uninstall

This unregisters the plugin and marketplace and removes only generated Pro-Flash entries from the user hook registry. Source and control/configuration files are preserved.

## Acceptance status

Historical acceptance observed six trusted user-native hooks and a real desktop PreToolUse event. A minimal CLI worker probe succeeded, but later upstream unavailability invalidated its proof. Full native guard and worker-dispatch acceptance, and the new desktop upgrade-button path, remain pending.

Hosted tools, hook errors/timeouts and later input to an already-approved interactive shell may be outside coverage. Account sign-in and Claude Code have not been live-validated. See docs/codex-acceptance-v0.5.2.md in the source repository for historical evidence.

## Decision report

Run node report.mjs or node report.mjs --days 30 from the marketplace root. The wrapper selects the Codex data directory before importing the shared report. It reports observed startup strategies, refusal categories and estimated read-guard savings, excluding test logs and shadow savings.
