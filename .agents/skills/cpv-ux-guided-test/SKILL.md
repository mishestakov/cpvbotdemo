---
name: cpv-ux-guided-test
description: Guide manual UX walkthroughs for the CPV demo Telegram bot using guided TDLib scenarios, capture user feedback branch-by-branch, and apply minimal targeted fixes without rerunning completed steps. Use when the user wants hands-on UX validation, iterative text/flow tuning, resume-from-failure testing, or “fix and retest only this branch” behavior in this repository.
---

# CPV UX Guided Test

## Overview

Run UX checks as short guided loops:
1. Pick one scenario branch.
2. Walk the user through actions in Telegram.
3. Capture feedback (`нравится/не нравится/почему`).
4. Apply minimal fix.
5. Re-run only that branch.

Keep scope narrow per iteration. Do not bundle multiple UX changes into one step.

## Workflow

### 1. Preflight

Before running UX branch checks:
1. Confirm server responds (`/api/admin/state`).
2. Confirm bot username is present in admin state.
3. For fast runs, confirm `ALLOW_TEST_API=true` and local test API base is reachable.
4. If guided mode is used, do not require `TDLIB_TEST_CHANNEL`.

If preflight fails, fix env/config first. Do not start UX walkthrough in broken state.

### 2. Branch Selection and Checkpointing

Default behavior:
1. Ask which single branch to test now (example: `manual_no_action_until_slot`).
2. Run only chosen scenario via `tests/tdlib/e2e-runner.js --mode=guided --scenarios=<id>`.
3. If run failed after auth or partial progress, continue from current state; do not re-run already validated branches unless user asks.

When user says “не хочу повторять руками”:
1. Reuse existing auth/session state if available.
2. Restart only affected scenario.
3. Clearly list what is already accepted and what remains unchecked.

### 3. Guided UX Loop

For each branch:
1. Tell user exact action sequence in one short checklist.
2. After each meaningful bot response, ask for verdict:
   - `OK`
   - `Не ок: текст`
   - `Не ок: поведение`
3. If verdict is `Не ок`, propose 1-2 minimal options and ask which one to apply.
4. Apply only the selected fix.
5. Re-run same branch and re-check.

Do not accumulate speculative improvements. Fix only current UX complaint.

### 4. Patch Rules

When patching during UX loop:
1. Prefer smallest diff in existing files.
2. Do not rename unrelated code or refactor broadly.
3. Keep message text human and short; avoid kancelarit style.
4. If a change may increase code size noticeably, ask before implementing.
5. After patch, run only relevant checks (for JS at least `node --check <file>`).

### 5. Logging and Artifacts

For each accepted change:
1. Append concise entry to `creation.md`:
   - user issue,
   - fix,
   - validation command/result.
2. Provide short branch status summary:
   - `passed`,
   - `needs follow-up`,
   - `blocked`.

### 6. Finish Step

At the end of each granular step:
1. Show exactly changed files.
2. State what branch is now covered.
3. Ask: `Коммитим этот шаг?`

If user confirms, create focused commit and push.

## Scenario IDs (current)

Use these runner scenarios where applicable:
1. `precheck_confirm`
2. `precheck_decline`
3. `manual_erid_reward`
4. `manual_no_action_until_slot`
5. `advertiser_cancel`
6. `auto_pause_skip`
