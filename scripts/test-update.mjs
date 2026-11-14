#!/usr/bin/env node
/**
 * Offline unit test suite for self-update mechanism (v0.6.1).
 *
 * Covers:
 * 1. compareSemver and readUpdateNotice filtering & TTL refresh.
 * 2. session-start.mjs rendering update notice in renderInfo with zero model token pollution.
 * 3. update.mjs local zip package extraction, version bump, 100% .state preservation & git protection.
 * 4. runtime-files.json allowlist entries across platforms.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compareSemver, readUpdateNotice } from './lib.mjs';
import { installRuntime } from './install.mjs';
import { ROOT_DIR, runtimeEntries } from './runtime-files.mjs';
import { runUpdate } from './update.mjs';

// Ensure test environment flags do not suppress update notices during testing
delete process.env.PRO_TEST;
delete process.env.ARGON_TEST;
delete process.env.PRO_NO_UPDATE_CHECK;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pfo-update-test-'));

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

try {
  // --------------------------------------------------------------------------
  // Test 1: compareSemver and readUpdateNotice
  // --------------------------------------------------------------------------
  await test('compareSemver handles patch increments, v-prefix, and decrements', () => {
    assert.equal(compareSemver('0.6.2', '0.6.1'), 1);
    assert.equal(compareSemver('v0.6.1', '0.6.1'), 0);
    assert.equal(compareSemver('0.6.0', '0.6.1'), -1);
  });

  await test('readUpdateNotice returns notice when newer version exists and filters properly', () => {
    const test1Dir = path.join(TMP, 'test1');
    fs.mkdirSync(test1Dir, { recursive: true });
    const checkFile = path.join(test1Dir, 'update-check.json');

    // 1. When latestVersion is '9.9.9'
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
      releaseUrl: 'https://github.com/demgkp1/pro-flash-orchestrator/releases/latest',
    }));

    const notice = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert(notice !== null, 'notice should be returned for 9.9.9 > 0.6.1');
    assert.equal(notice.latestVersion, '9.9.9');
    assert.equal(notice.currentVersion, '0.6.1');
    assert(typeof notice.updateCommand === 'string' && notice.updateCommand.includes('update.mjs'));

    // 2. When latestVersion is '0.6.1' (same version) -> returns null
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '0.6.1',
    }));
    const noticeSame = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeSame, null, 'notice should be null when latestVersion == currentVersion');

    // 3. When PRO_NO_UPDATE_CHECK = '1' -> returns null
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
    }));
    process.env.PRO_NO_UPDATE_CHECK = '1';
    const noticeDisabled = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeDisabled, null, 'notice should be null when PRO_NO_UPDATE_CHECK is 1');
    delete process.env.PRO_NO_UPDATE_CHECK;

    // 4. When subagent or non-antigravity harness -> returns null
    const noticeSubagent = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity', is_subagent: true },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeSubagent, null, 'subagent should receive null update notice');

    const noticeClaude = readUpdateNotice(
      { conversationId: 'u1', _harness: 'claude' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeClaude, null, 'claude harness should receive null update notice');

    const noticeCodex = readUpdateNotice(
      { conversationId: 'u1', _harness: 'codex' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert.equal(noticeCodex, null, 'codex harness should receive null update notice');

    // 5. When cache is expired (checkedAt was 25 hours ago) -> auto refreshes checkedAt
    const oldCheckedAt = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: oldCheckedAt,
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
    }));
    const noticeExpired = readUpdateNotice(
      { conversationId: 'u1', _harness: 'antigravity' },
      { checkFile, currentVersion: '0.6.1', spawnWorker: false }
    );
    assert(noticeExpired !== null, 'notice should still be returned from expired cache data');
    const refreshedCache = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    assert(refreshedCache.checkedAt > oldCheckedAt, 'checkedAt must be refreshed on expiration');
  });

  // --------------------------------------------------------------------------
  // Test 2: session-start.mjs writes renderInfo.markdown without polluting systemMessage
  // --------------------------------------------------------------------------
  await test('session-start.mjs writes update banner to renderInfo.markdown only', () => {
    const test2Dir = path.join(TMP, 'test2-state');
    fs.mkdirSync(test2Dir, { recursive: true });
    const checkFile = path.join(test2Dir, 'update-check.json');
    fs.writeFileSync(checkFile, JSON.stringify({
      checkedAt: Date.now(),
      currentVersion: '0.6.1',
      latestVersion: '9.9.9',
      releaseUrl: 'https://example.com/release',
    }));

    const sessionPayload = {
      conversationId: 'main-session-update-banner',
      modelName: 'Argon',
      transcriptPath: '',
      lastUserInput: 'start conversation',
    };

    const stdout = cp.execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'session-start.mjs')], {
      input: JSON.stringify(sessionPayload),
      encoding: 'utf8',
      cwd: ROOT_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        PRO_STATE_DIR: test2Dir,
        PRO_MODE: 'enforce',
        PRO_TEST: '',
        ARGON_TEST: '',
        PRO_NO_UPDATE_CHECK: '',
      },
    });

    const parsed = JSON.parse(stdout);
    const markdown = parsed.injectSteps?.[0]?.systemMessage?.renderInfo?.markdown || '';
    const systemMessage = parsed.injectSteps?.[0]?.systemMessage?.systemMessage || '';

    assert(markdown.includes('发现新版本 v9.9.9'), 'renderInfo.markdown must contain 发现新版本 v9.9.9');
    assert(markdown.replace(/\\/g, '/').includes('scripts/update.mjs'), 'renderInfo.markdown must reference scripts/update.mjs');
    assert(!systemMessage.includes('发现新版本'), 'systemMessage must NOT contain 发现新版本 to maintain zero model tokens');
  });

  // --------------------------------------------------------------------------
  // Test 3: update.mjs local zip upgrade and 100% .state retention
  // --------------------------------------------------------------------------
  await test('update.mjs upgrades from local release zip, retains 100% .state, and rejects git dir', async () => {
    const test3Dir = path.join(TMP, 'test3');
    const installDir = path.join(test3Dir, 'pro-flash-orchestrator');
    fs.mkdirSync(installDir, { recursive: true });

    // Step 1: install base runtime and pin version to 0.6.1
    installRuntime(installDir);
    const pjPath = path.join(installDir, 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.version = '0.6.1';
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));

    // Step 2: write user state
    const stateDir = path.join(installDir, '.state');
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    const keepSessionContent = JSON.stringify({ sessionData: 'keep-me-intact', count: 42 });
    const keepModeContent = JSON.stringify({ mode: 'shadow', userSet: true });
    fs.writeFileSync(path.join(stateDir, 'sessions', 'keep.json'), keepSessionContent);
    fs.writeFileSync(path.join(stateDir, 'mode.json'), keepModeContent);

    // Step 3: construct mock package for v0.7.0
    const stageDir = path.join(test3Dir, 'stage');
    const stagePkg = path.join(stageDir, 'pro-flash-orchestrator');
    fs.mkdirSync(path.join(stagePkg, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(stagePkg, 'plugin.json'), JSON.stringify({
      name: 'pro-flash-orchestrator',
      version: '0.7.0',
    }, null, 2));
    fs.writeFileSync(path.join(stagePkg, 'scripts', 'lib.mjs'), '// upgraded lib v0.7.0\n');
    fs.writeFileSync(path.join(stagePkg, 'README.md'), '# Upgraded Documentation v0.7.0\n');

    const zipPath = path.join(test3Dir, 'release-0.7.0.zip');
    let zipped = false;
    try {
      cp.execFileSync('tar', ['-a', '-cf', zipPath, '-C', stageDir, 'pro-flash-orchestrator'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      zipped = fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0;
    } catch {
      zipped = false;
    }
    if (!zipped) {
      if (process.platform === 'win32') {
        const src = path.join(stageDir, 'pro-flash-orchestrator').replace(/'/g, "''");
        const dst = zipPath.replace(/'/g, "''");
        cp.execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${src}' -DestinationPath '${dst}' -Force`,
        ], { windowsHide: true, stdio: 'ignore' });
      } else {
        cp.execFileSync('zip', ['-rq', zipPath, 'pro-flash-orchestrator'], {
          cwd: stageDir,
          windowsHide: true,
          stdio: 'ignore',
        });
      }
    }
    assert(fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0, 'Release archive must exist');

    // Step 4: call runUpdate
    const updateResult = await runUpdate({ target: installDir, zipPath });
    assert.equal(updateResult.updated, true);
    assert.equal(updateResult.currentVersion, '0.6.1');
    assert.equal(updateResult.latestVersion, '0.7.0');

    // Step 5: verify plugin.json version updated to 0.7.0
    const afterPj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    assert.equal(afterPj.version, '0.7.0');

    // Step 6: verify .state/ contents are 100% retained
    assert.equal(
      fs.readFileSync(path.join(stateDir, 'sessions', 'keep.json'), 'utf8'),
      keepSessionContent,
      'keep.json in .state/sessions/ must remain intact'
    );
    assert.equal(
      fs.readFileSync(path.join(stateDir, 'mode.json'), 'utf8'),
      keepModeContent,
      'mode.json in .state/ must remain intact'
    );

    // Step 7: verify git checkout rejection
    const gitDir = path.join(test3Dir, 'fake-git-checkout');
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
    await assert.rejects(
      async () => runUpdate({ target: gitDir, zipPath }),
      /Refusing to overwrite a Git checkout/
    );
  });

  // --------------------------------------------------------------------------
  // Test 4: runtime-files.json whitelist validation
  // --------------------------------------------------------------------------
  await test('runtime-files.json includes check-update-worker and update in Antigravity only', () => {
    const agyEntries = runtimeEntries({ platform: 'antigravity' }).map((e) => e.to);
    assert(agyEntries.includes('scripts/check-update-worker.mjs'), 'Antigravity runtime must contain scripts/check-update-worker.mjs');
    assert(agyEntries.includes('scripts/update.mjs'), 'Antigravity runtime must contain scripts/update.mjs');
    assert.equal(agyEntries.length, 17, 'Antigravity runtime entries count must be 17');

    const codexEntries = runtimeEntries({ platform: 'codex' }).map((e) => e.to);
    assert(!codexEntries.includes('scripts/check-update-worker.mjs'), 'Codex runtime must not contain scripts/check-update-worker.mjs');
    assert(!codexEntries.includes('scripts/update.mjs'), 'Codex runtime must not contain scripts/update.mjs');
    assert.equal(codexEntries.length, 16, 'Codex runtime entries count must remain 16');
  });

  // --------------------------------------------------------------------------
  // Test 5: subagent thrashing circuit breaker blocks 3rd consecutive identical command and resets on different command
  // --------------------------------------------------------------------------
  await test('subagent thrashing circuit breaker blocks 3rd consecutive identical command and resets on different command', () => {
    const test6Dir = path.join(TMP, 'test6-thrash-state');
    fs.mkdirSync(test6Dir, { recursive: true });

    const invokeGuardCommand = (cmd) => {
      const payload = {
        is_subagent: true,
        conversationId: 'sub-thrash-1',
        tool_name: 'run_command',
        tool_input: { CommandLine: cmd },
      };
      const env = {
        ...process.env,
        PRO_STATE_DIR: test6Dir,
        PRO_MODE: 'enforce',
      };
      delete env.PRO_TEST;
      delete env.ARGON_TEST;

      const stdout = cp.execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'guard-command.mjs')], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: ROOT_DIR,
        windowsHide: true,
        env,
      });

      const parsed = JSON.parse(stdout);
      return {
        permissionDecision: parsed.hookSpecificOutput?.permissionDecision || parsed.decision,
        permissionDecisionReason: parsed.hookSpecificOutput?.permissionDecisionReason || parsed.reason || '',
        raw: parsed,
      };
    };

    // 1st invocation of test-foo: allowed
    const call1 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert(call1.permissionDecision !== 'deny', '1st invocation of test-foo must be allowed');

    // 2nd invocation of test-foo: allowed (retry after 1st failure)
    const call2 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert(call2.permissionDecision !== 'deny', '2nd invocation of test-foo must be allowed');

    // 3rd consecutive invocation of identical test-foo: physically denied
    const call3 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert.equal(call3.permissionDecision, 'deny', '3rd consecutive invocation of test-foo must be denied');
    assert(call3.permissionDecisionReason.includes('【死循环熔断拦截】'), 'denial reason must contain 【死循环熔断拦截】');

    // Different command: allowed and resets consecutive counter
    const call4 = invokeGuardCommand('node scripts/test-bar.mjs');
    assert(call4.permissionDecision !== 'deny', 'invocation of different command test-bar must be allowed');

    // Verification of counter reset: test-foo is allowed again
    const call5 = invokeGuardCommand('node scripts/test-foo.mjs');
    assert(call5.permissionDecision !== 'deny', 'test-foo must be allowed after reset by different command');

    // Verify decisions.jsonl records rule: 'thrash-circuit-breaker'
    const decisionsPath = path.join(test6Dir, 'decisions.jsonl');
    assert(fs.existsSync(decisionsPath), 'decisions.jsonl must exist');
    const decisions = fs.readFileSync(decisionsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const thrashRecord = decisions.find((d) => d.rule === 'thrash-circuit-breaker');
    assert(thrashRecord, 'decisions.jsonl must record rule thrash-circuit-breaker');
    assert.equal(thrashRecord.action, 'deny');

    // Verify report.mjs output contains (死循环熔断)
    const reportEnv = {
      ...process.env,
      PRO_STATE_DIR: test6Dir,
    };
    delete reportEnv.PRO_TEST;
    delete reportEnv.ARGON_TEST;

    const reportStdout = cp.execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'report.mjs')], {
      encoding: 'utf8',
      cwd: ROOT_DIR,
      windowsHide: true,
      env: reportEnv,
    });
    assert(reportStdout.includes('(死循环熔断)'), 'report.mjs output must contain (死循环熔断) tag');
  });
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // cleanup
  }
}

console.log(`\nUpdate test results: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
