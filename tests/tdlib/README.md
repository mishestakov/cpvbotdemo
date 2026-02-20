# TDLib E2E Runner

## Modes
1. `auto` (default): TDLib сам нажимает кнопки в боте.
2. `guided`: вы сами кликаете в Telegram, раннер ведёт по шагам и ждёт `Y/s/q`.

## Run
Авто-режим:
```bash
npm run test:tdlib
# или
node tests/tdlib/e2e-runner.js --mode=auto
```

Guided-режим (UX-прогон вручную):
```bash
node tests/tdlib/e2e-runner.js --mode=guided
```

Только выбранные сценарии:
```bash
node tests/tdlib/e2e-runner.js --mode=guided --scenarios=precheck_confirm,manual_erid_reward
```

Новый сценарий для ветки "ничего не нажал до времени слота":
```bash
node tests/tdlib/e2e-runner.js --mode=guided --scenarios=manual_no_action_until_slot
```

## Required env
В `.env`:
1. `BOT_TOKEN`
2. `WEBHOOK_BASE_URL`
3. `WEBHOOK_SECRET_TOKEN`
4. `TDLIB_TEST_CHANNEL` (например `@mytestchannel`)

Для быстрого прогона:
1. `ALLOW_TEST_API=true`
2. `MANUAL_PUBLICATION_HOLD_MS=3000`
3. `MANUAL_PENDING_REMINDER_INTERVAL_MS=5000`
4. `AUTO_PAUSE_DURATION_MS=5000`
5. `OFFER_DEADLINE_CHECK_INTERVAL_MS=500`
6. (optional) `CPVDEMO_USE_TEST_API=true` (default in runner)

TDLib auth (`auto` mode):
1. `TDLIB_AUTH_MODE=user` (default)
2. `TELEGRAM_API_ID`
3. `TELEGRAM_API_HASH`
4. (optional) `TDLIB_PATH`, `TDLIB_DATABASE_DIR`, `TDLIB_FILES_DIR`

## Notes
1. Для chat selection (`chat_shared`) раннер инжектит update напрямую в локальный webhook с `WEBHOOK_SECRET_TOKEN`.
2. Это нужно для стабилизации шага выбора канала в автоматическом режиме.
3. При `ALLOW_TEST_API=true` раннер использует `/api/test/offers` и `/api/test/tick`, чтобы не ждать часовые слоты.
4. В `guided` режиме вы выполняете действия в Telegram руками, а раннер валидирует статусы через API.
5. Сценарий `manual_no_action_until_slot` рассчитан на быстрый прогон через test API (используйте `ALLOW_TEST_API=true`).
