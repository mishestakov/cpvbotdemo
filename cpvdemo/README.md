# CPV Demo

Минимальный перенос страницы настроек из `~/suggestpost/post-planner/public` для демо-флоу CPV.

## Что внутри
- `public/index.html` — страница настроек канала.
- `public/auth.html` — простая точка входа авторизации.
- `public/proto.css` — стили.
- `public/app.js`, `public/auth.js` — клиентский UI-скрипт.
- `server.js` — локальный demo-сервер для API страницы (без TDLib).

## Запуск
```bash
npm install
cp .env.example .env
# заполнить BOT_TOKEN в .env
npm run start:cpvdemo
```

Открыть:
- `http://127.0.0.1:3030/cpvdemo/auth`

## Важно
- Для auth через Telegram нужен `BOT_TOKEN` в `.env`.
- Сервер работает в webhook-режиме (без long polling).
- Нужен публичный HTTPS URL (например, ngrok) и `WEBHOOK_BASE_URL` в `.env`.
- `WEBHOOK_SECRET_TOKEN` обязателен: сервер проверяет заголовок `x-telegram-bot-api-secret-token`.
- После смены ngrok URL перезапустите `npm run start:cpvdemo`, чтобы заново вызвать `setWebhook`.
- Это UI-демо + минимальная bot-auth и mock API.
- Логика TDLib и продовая backend-интеграция не переносились.

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
