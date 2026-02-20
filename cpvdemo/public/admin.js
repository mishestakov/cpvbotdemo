const els = {
  metricBloggers: document.getElementById("metricBloggers"),
  metricChannels: document.getElementById("metricChannels"),
  metricOffers: document.getElementById("metricOffers"),
  metricActiveOffers: document.getElementById("metricActiveOffers"),
  adminReloadBtn: document.getElementById("adminReloadBtn"),
  adminStatusText: document.getElementById("adminStatusText"),
  adminBloggersList: document.getElementById("adminBloggersList"),
  adminOffersList: document.getElementById("adminOffersList")
};

const dayLabels = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];

function setText(el, value) {
  if (!el) return;
  el.textContent = value == null || value === "" ? "—" : String(value);
}

function hh(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function slotsToRangesText(slots) {
  const byDay = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    const day = Number(slot?.day);
    const hour = Number(slot?.hour);
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(hour);
  }

  const chunks = [];
  for (let day = 1; day <= 7; day += 1) {
    const hours = (byDay.get(day) || []).sort((a, b) => a - b);
    if (!hours.length) continue;
    const ranges = [];
    let start = hours[0];
    let prev = hours[0];
    for (let i = 1; i <= hours.length; i += 1) {
      const cur = hours[i];
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      ranges.push(`${hh(start)}-${hh(prev + 1)}`);
      start = cur;
      prev = cur;
    }
    chunks.push(`${dayLabels[day - 1]} ${ranges.join(", ")}`);
  }
  return chunks.length ? chunks.join(" | ") : "Слоты не заданы";
}

async function apiGet(path) {
  const res = await fetch(path, { method: "GET" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

function renderMetrics(state) {
  setText(els.metricBloggers, Number(state?.totals?.bloggers || 0));
  setText(els.metricChannels, Number(state?.totals?.channels || 0));
  setText(els.metricOffers, Number(state?.totals?.offers || 0));
  setText(els.metricActiveOffers, Number(state?.totals?.activeOffers || 0));
}

function renderBloggers(bloggers) {
  const root = els.adminBloggersList;
  if (!root) return;
  root.innerHTML = "";

  if (!Array.isArray(bloggers) || !bloggers.length) {
    root.innerHTML = '<p class="muted">Авторизованных блогеров пока нет.</p>';
    return;
  }

  for (const blogger of bloggers) {
    const item = document.createElement("div");
    item.className = "planned-item";

    const channel = blogger?.channel || null;
    const channelTitle = channel?.title || "Канал не выбран";
    const channelLogin = channel?.username ? `@${channel.username}` : `chat_id: ${channel?.chatId || "—"}`;
    const modeTitle = channel?.postingModeTitle || "—";
    const weeklyLimit = channel?.weeklyPostLimit ?? "—";
    const schedule = channel ? slotsToRangesText(channel.scheduleSlots) : "Слоты не заданы";
    const botState = channel ? (channel.botConnected ? "подключен" : `не подключен (${channel.botMemberStatus || "unknown"})`) : "—";

    const main = document.createElement("div");
    main.className = "planned-main";
    main.innerHTML =
      `<div><strong>@${blogger.tgUsername || blogger.id}</strong> (tgUserId: ${blogger.tgUserId || "—"})</div>` +
      `<div class="planned-meta">Канал: ${channelTitle} (${channelLogin})</div>` +
      `<div class="planned-meta">Режим: ${modeTitle}</div>` +
      `<div class="planned-meta">Лимит: ${weeklyLimit} в неделю • Бот: ${botState}</div>` +
      `<div class="planned-meta">Слоты: ${schedule}</div>` +
      `<div class="planned-meta">Офферы: ${blogger.activeOffers}/${blogger.totalOffers} (active/total)</div>`;

    item.appendChild(main);
    root.appendChild(item);
  }
}

function renderOffers(offers) {
  const root = els.adminOffersList;
  if (!root) return;
  root.innerHTML = "";

  if (!Array.isArray(offers) || !offers.length) {
    root.innerHTML = '<p class="muted">Офферов пока нет.</p>';
    return;
  }

  for (const offer of offers) {
    const item = document.createElement("div");
    item.className = "planned-item";

    const main = document.createElement("div");
    main.className = "planned-main";
    main.innerHTML =
      `<div><strong>#${offer.id}</strong> @${offer.bloggerUsername || "unknown"}</div>` +
      `<div class="planned-meta">${offer.scheduledAtText} • ${offer.modeTitle || offer.mode}</div>` +
      `<div class="planned-meta">${offer.statusTitle || offer.status}</div>` +
      `<div class="planned-meta">CPV: ${offer.cpv} ₽ • Доход: ${offer.estimatedIncome} ₽</div>` +
      (offer.declineReason ? `<div class="planned-meta">Причина отклонения: ${offer.declineReason}</div>` : "") +
      `<div class="planned-meta">${offer.text || ""}</div>`;
    item.appendChild(main);
    root.appendChild(item);
  }
}

async function refreshState() {
  const state = await apiGet("/api/admin/state");
  renderMetrics(state);
  renderBloggers(state.bloggers || []);
  renderOffers(state.offers || []);
}

function bindEvents() {
  if (els.adminReloadBtn) {
    els.adminReloadBtn.addEventListener("click", () => {
      refreshState()
        .then(() => setText(els.adminStatusText, "Обновлено"))
        .catch((e) => setText(els.adminStatusText, `Ошибка: ${e?.message || String(e)}`));
    });
  }
}

async function boot() {
  bindEvents();
  await refreshState();
  setText(els.adminStatusText, "Готово");
}

boot().catch((e) => {
  setText(els.adminStatusText, `Ошибка: ${e?.message || String(e)}`);
});
