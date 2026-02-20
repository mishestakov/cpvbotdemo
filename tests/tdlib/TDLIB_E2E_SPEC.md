# CPV Demo TDLib E2E Spec

## Scope
Проверяем реальные пользовательские действия через TDLib (как обычный Telegram user):
1. Авторизация через `/start <token>`.
2. Подтверждение канала (chat_shared update инжектится в webhook как технический шаг).
3. Работа с inline-кнопками бота по офферам.
4. Создание/отмена офферов через advertiser API.
5. Проверка финальных статусов через `/api/advertiser/state`.

Поддерживаются 2 режима запуска:
1. `auto` — TDLib кликает кнопки сам.
2. `guided` — человек кликает вручную, runner проверяет ожидания.

## Fast-Run Requirements
Чтобы прогон занимал минуты, а не дни:
1. `ALLOW_TEST_API=true` (только локально).
2. `MANUAL_PUBLICATION_HOLD_MS` уменьшить (например `3000`).
2. `MANUAL_PENDING_REMINDER_INTERVAL_MS` уменьшить (например `5000`).
3. `AUTO_PAUSE_DURATION_MS` уменьшить (например `5000`).
4. `OFFER_DEADLINE_CHECK_INTERVAL_MS` уменьшить (например `500`).

## Preconditions
1. Запущен `cpvdemo/server.js`.
2. Настроены `BOT_TOKEN`, `WEBHOOK_BASE_URL`, `WEBHOOK_SECRET_TOKEN`.
3. Есть test-канал, где тестовый пользователь админ.
4. В `.env` установлен `TDLIB_TEST_CHANNEL`.

## Covered Scenarios (implemented in `e2e-runner.js`)
1. `precheck_confirm`
   - mode: `auto_with_precheck`
   - action: нажать `✅ Подтвердить`
   - expected: offer -> `scheduled`
2. `precheck_decline`
   - mode: `auto_with_precheck`
   - action: нажать `❌ Отклонить`
   - expected: offer -> `declined_by_blogger`
3. `manual_erid_reward`
   - mode: `manual_posting`
   - action: нажать `🏷 Получить ERID`, отправить пост в канал с `ERID`
   - expected: `manual_waiting_publication` -> `manual_publication_found` -> `rewarded`
4. `advertiser_cancel`
   - mode: `manual_approval`
   - action: отменить оффер через advertiser API
   - expected: `cancelled_by_advertiser`
5. `manual_no_action_until_slot`
   - mode: `manual_posting`
   - action: не нажимать кнопки в оффере до наступления времени публикации
   - expected: `archived_not_published`
6. `auto_pause_skip`
   - mode: `auto`
   - action: `/pause` -> `⏸ Пауза 24 часа`
   - expected: advertiser offer create -> `skipped` с причиной `Autoposting paused until ...`

## Not Yet Automated (planned)
1. `pending_precheck` deadline auto-approve by timeout.
2. `pending_approval` timeout -> `archived_not_published`.
3. `scheduled` timeout -> `auto_publish_error` / `archived_not_published` branches.
4. Полный reminder-loop для `pending_manual_posting` (количество и интервалы напоминаний как отдельные ассерты).
5. Multi-channel branch coverage for `/mode` and `/pause`.

## Main Risks / Pitfalls
1. TDLib user auth (phone/code/2FA) может требовать ручной ввод.
2. `request_chat` (кнопка выбора канала) сложно эмулировать в TDLib, поэтому chat_shared инжектится через webhook для полной автоматизации.
3. Telegram API network flaps (`ETIMEDOUT`) могут давать флаки.
4. Если канал не имеет прав на постинг, сценарии manual publish не пройдут.

## Test APIs (local only)
1. `POST /api/test/offers` — создать оффер с произвольным `scheduledAt`.
2. `POST /api/test/tick` — принудительно прогнать deadline/pause processing.
3. Endpoint-ы доступны только при `ALLOW_TEST_API=true` и только с localhost.
