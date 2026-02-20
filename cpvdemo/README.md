# CPV Demo

Демо флоу CPV с Telegram Bot API:
- блогер авторизуется через `/start <token>`;
- выбирает канал через `request_chat` (только канал, где он админ);
- настраивает режим публикации и расписание;
- рекламодатель вручную создает офферы;
- админка показывает всех блогеров, каналы и офферы.

## Что внутри
- `public/auth.html` — вход блогера в Telegram-бот.
- `public/index.html` — кабинет блогера.
- `public/advertiser.html` — кабинет рекламодателя.
- `public/admin.html` — админка.
- `server.js` — API, webhook обработка, бизнес-логика.
- `data/db.json` — JSON база (создается автоматически).

## Запуск
```bash
npm install
cp .env.example .env
# заполнить BOT_TOKEN в .env
npm run start:cpvdemo
```

Открыть:
- `http://127.0.0.1:3030/cpvdemo/auth`
- `http://127.0.0.1:3030/cpvdemo/advertiser`
- `http://127.0.0.1:3030/cpvdemo/admin`

## Важно
- Для auth через Telegram нужен `BOT_TOKEN` в `.env`.
- Сервер работает в webhook-режиме (без long polling).
- Нужен публичный HTTPS URL (например, ngrok) и `WEBHOOK_BASE_URL` в `.env`.
- `WEBHOOK_SECRET_TOKEN` обязателен: сервер проверяет заголовок `x-telegram-bot-api-secret-token`.
- `WEBHOOK_DROP_PENDING_UPDATES=true` (по умолчанию) очищает хвост старых Telegram updates при рестарте сервера.
- `ALLOW_TEST_API=false` (по умолчанию) — включает локальные test endpoint-ы `/api/test/*` для e2e.
- `MANUAL_PUBLICATION_HOLD_MS=60000` — сколько пост с ERID должен провисеть в канале до начисления (для демо: 1 минута).
- `MANUAL_PENDING_REMINDER_MAX=2` — максимум напоминаний по ручному размещению.
- `MANUAL_PENDING_REMINDER_INTERVAL_MS=86400000` — интервал между напоминаниями.
- `AUTO_PAUSE_DURATION_MS=86400000` — длительность паузы автопубликаций.
- После смены ngrok URL перезапустите `npm run start:cpvdemo`, чтобы заново вызвать `setWebhook`.
- База хранится в `cpvdemo/data/db.json` и исключена из git.
- Это UI-демо + минимальная bot-auth и API.
- Логика TDLib и продовая backend-интеграция не переносились.

## TDLib E2E
Минимальный e2e-раннер лежит в `tests/tdlib/e2e-runner.js`.

Запуск:
```bash
npm run test:tdlib
```

Документация:
- `tests/tdlib/README.md`
- `tests/tdlib/TDLIB_E2E_SPEC.md`

## Быстрый пример с ngrok
```bash
# Терминал 1
npm run start:cpvdemo

# Терминал 2
ngrok http 3030
```

Возьмите HTTPS адрес из ngrok и пропишите в `.env`:
```bash
WEBHOOK_BASE_URL=https://<your-subdomain>.ngrok-free.app
```
Затем перезапустите сервис:
```bash
npm run start:cpvdemo
```
