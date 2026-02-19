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
- Для long-polling Telegram допускается только один активный процесс на токен. Если увидите `409 Conflict`, остановите другой процесс, который читает updates этого бота.
- Это UI-демо + минимальная bot-auth и mock API.
- Логика TDLib и продовая backend-интеграция не переносились.
