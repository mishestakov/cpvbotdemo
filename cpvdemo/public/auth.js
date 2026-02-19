const els = {
  authOpenBot: document.getElementById("authOpenBot"),
  authStatusText: document.getElementById("authStatusText")
};

let sessionToken = "";
let pollTimer = null;

function setStatus(text) {
  if (els.authStatusText) {
    els.authStatusText.textContent = String(text || "");
  }
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

async function apiGet(path) {
  const res = await fetch(path, { method: "GET" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!sessionToken) return;
    try {
      const row = await apiGet(`/api/auth/session?token=${encodeURIComponent(sessionToken)}`);
      if (row.status === "pending_start") {
        setStatus("Откройте бота и нажмите Start.");
        return;
      }
      if (row.status === "awaiting_channel") {
        setStatus("В боте выберите канал, где вы администратор.");
        return;
      }
      if (row.status === "connecting") {
        setStatus("Подключаем канал. Это может занять несколько секунд...");
        return;
      }
      if (row.status === "connected") {
        if (row.web) {
          location.replace(row.web);
          return;
        }
        setStatus("Канал подключен, но ссылка не сформирована.");
        return;
      }
      if (row.status === "expired") {
        setStatus("Сессия истекла. Обновите страницу, чтобы создать новую ссылку.");
        return;
      }
      if (row.status === "error") {
        setStatus(`Ошибка: ${row.error || "не удалось подключить канал"}`);
      }
    } catch (e) {
      setStatus(`Ошибка проверки статуса: ${e?.message || String(e)}`);
    }
  }, 1500);
}

async function boot() {
  try {
    const res = await apiPost("/api/auth/session", {});
    sessionToken = String(res.token || "");
    if (els.authOpenBot) {
      els.authOpenBot.href = String(res.tg || "#");
    }
    setStatus("Ссылка готова. Перейдите в Telegram и нажмите Start.");
    startPolling();
  } catch (e) {
    setStatus(`Не удалось создать auth-сессию: ${e?.message || String(e)}`);
    if (els.authOpenBot) {
      els.authOpenBot.classList.add("btn-disabled");
      els.authOpenBot.removeAttribute("href");
    }
  }
}

boot().catch(() => {});
