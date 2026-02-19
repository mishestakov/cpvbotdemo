const els = {
  authOpenBot: document.getElementById("authOpenBot"),
  authStatusText: document.getElementById("authStatusText")
};
const telegramLinks = window.TelegramLinks || null;

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
  if (els.authOpenBot) {
    els.authOpenBot.addEventListener("click", (event) => {
      event.preventDefault();
      const deep = String(els.authOpenBot.dataset.deep || "");
      telegramLinks?.openDeepLink(deep || els.authOpenBot.href);
    });
  }

  try {
    const res = await apiPost("/api/auth/session", {});
    sessionToken = String(res.token || "");
    if (els.authOpenBot) {
      const links = telegramLinks?.buildFromTelegramUrl(res.tg) || { deep: String(res.tg || "#"), web: String(res.tg || "#") };
      els.authOpenBot.href = links.deep || links.web || "#";
      els.authOpenBot.dataset.deep = links.deep || "";
    }
    setStatus("Ссылка готова. Откройте Telegram, нажмите Start и вернитесь в эту вкладку.");
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
