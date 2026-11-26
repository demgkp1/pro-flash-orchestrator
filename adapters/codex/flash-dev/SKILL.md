---
name: flash-dev
description: Use for engineering work that needs broad exploration, multi-file changes, testing or refactoring. Delegate independent exploration and peripheral implementation to verified Codex worker models.
---

# Pro-Flash workflow for Codex

The main agent owns decisions and up to two benchmark files. For exploration across three or more files, or mechanical implementation beyond two files or fifty lines, delegate bounded work to subagents. Keep trivial single-file edits local.

Use Codex native spawning and waiting. Write the task in the field supported by the current tool, usually message. Supply exact goals, assigned files, read-only references, and focused tests. Use independent context when selecting a different worker model; provide all necessary context explicitly. Worker model and reasoning effort come from plugin configuration and must pass real verification first.

Spawn independent tasks in the same batch, with disjoint write scopes. At most five spawns per user turn, subject to the host's lower limit. Wait using native wait tools, collect results, and close finished agents. Never end the main task before collecting its delegated results.

Audit permits consecutive explicit start/end slices of at most 80 lines. Each admitted self dispatch adds two slices, capped at ten; a new user turn clears the budget. Child and parent sessions retain ten masked command admissions. PreToolUse admission is not evidence of test success: verify actual outputs and exit status.

Child source writes claim all targets atomically under the parent session lock. Other children cannot edit a claimed file in the same batch; report shared changes for the lead to merge. New batches reset claims and same-batch dispatches retain them. A failed state write rejects the operation. The standalone `node report.mjs` command summarizes strategies, denied reads and retained slice ranges using the Codex data directory.

Native Orchestrator models (or PRO_NATIVE_ORCHESTRATOR=1) use Lite Guard Mode. File-count guards and drift nudges are exempt; slicing, recursion, polling, command and report-contract guards remain active. The default Codex worker is gpt-5-mini. PRO_RESEARCH_MODEL and PRO_SELF_MODEL select task-specific workers, subject to provider verification.

Workers must not spawn nested agents. Keep code snippets to at most 10 lines and never paste large source listings into chat. Under the v0.7.6 dual-track acceptance contract:

- **Read-only `research` workers (exploration / research / plan)**: Strictly read-only — never edit or write files (including report files). The 30-line output cap is lifted. A single research worker delivers a structured deep research report directly in its message (module analysis, verified facts with `file:line` evidence, risks/bottlenecks, and top recommendations). For concurrent multi-research fan-outs (optionally tagging the first dispatch with `[MULTI-RESEARCH]`), each worker returns a high-density summary matrix and `file:line` index directly in its message without writing files.
- **Implementation (`self`) workers**: Edit only assigned disjoint files and run focused local tests only. Return a compact 4-column table (`| File | Line Range | Core Changes | Focused Test Command & Result |`) and keep any code snippet at most 10 lines.

Only a user message containing [FORCE-PRO] may exempt expensive models. Never put an exemption into a worker task yourself. Unavailable worker models are reported and dispatch is blocked; do not silently fall back to the main model.

The hooks guard native patch edits and supported shell/read tools. Hosted tools and commands in a previously-approved interactive shell may be outside hook coverage. Report errors and coverage gaps explicitly.
