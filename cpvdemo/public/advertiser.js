const els = {
  advText: document.getElementById("advText"),
  advDateFrom: document.getElementById("advDateFrom"),
  advDateTo: document.getElementById("advDateTo"),
  advCpv: document.getElementById("advCpv"),
  advChannelList: document.getElementById("advChannelList"),
  advChannelFilter: document.getElementById("advChannelFilter"),
  advCreateBtn: document.getElementById("advCreateBtn"),
  advReloadBtn: document.getElementById("advReloadBtn"),
  advStatusHint: document.getElementById("advStatusHint"),
  advOffersList: document.getElementById("advOffersList")
};

let latestState = null;
let channelFilterMode = "all";
const selectedChannelIdsState = new Set();
const ACTIVE_OFFER_STATUSES = new Set([
  "pending_precheck",
  "pending_approval",
  "pending_manual_posting",
  "manual_waiting_publication",
  "manual_publication_found",
  "scheduled"
]);

function setStatus(text) {
  if (!els.advStatusHint) return;
  els.advStatusHint.textContent = text == null || text === "" ? "—" : String(text);
}

function toLocalDateInputValue(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readDateOnlyInputValue(input, endOfDay) {
  const value = String(input?.value || "").trim();
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const dt = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  const ts = dt.getTime();
  return Number.isFinite(ts) ? ts : null;
}

async function apiGet(path) {
  const res = await fetch(path, { method: "GET" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
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

function dayOfWeekMonFirst(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

function activeOffersForChannel(channelId) {
  const offers = Array.isArray(latestState?.offers) ? latestState.offers : [];
  return offers.filter((offer) => String(offer?.channelId || "") === String(channelId || "") && ACTIVE_OFFER_STATUSES.has(String(offer?.status || "")));
}

function buildAvailableSlotsInRange(channel, dateFrom, dateTo) {
  const from = Number(dateFrom);
  const to = Number(dateTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];

  const schedule = Array.isArray(channel?.scheduleSlots) ? channel.scheduleSlots : [];
  if (!schedule.length) return [];

  const reserved = new Set(activeOffersForChannel(channel.id).map((offer) => Number(offer.scheduledAt)).filter((value) => Number.isFinite(value)));
  const out = [];

  const start = new Date(from);
  const end = new Date(to);
  const current = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  const nowCutoff = Date.now() + 30_000;

  while (current <= endDay) {
    const day = dayOfWeekMonFirst(current);
    for (const slot of schedule) {
      const slotDay = Number(slot?.day);
      const slotHour = Number(slot?.hour);
      if (!Number.isInteger(slotDay) || !Number.isInteger(slotHour)) continue;
      if (slotDay !== day) continue;

      const dt = new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate(),
        slotHour,
        0,
        0,
        0
      );
      const ts = dt.getTime();
      if (ts < from || ts > to) continue;
      if (ts <= nowCutoff) continue;
      if (reserved.has(ts)) continue;
      out.push(ts);
    }
    current.setDate(current.getDate() + 1);
  }

  out.sort((a, b) => a - b);
  return out;
}

function channelAvailability(channel, dateFrom, dateTo) {
  const from = Number(dateFrom);
  const to = Number(dateTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return { available: true, reason: "" };
  }

  const activeCount = activeOffersForChannel(channel.id).length;
  const weeklyLimit = Number(channel?.weeklyPostLimit || 21);
  if (activeCount >= weeklyLimit) {
    return { available: false, reason: "недоступен: достигнут недельный лимит" };
  }

  const slots = buildAvailableSlotsInRange(channel, from, to);
  if (!slots.length) {
    return { available: false, reason: "недоступен: нет слотов в выбранном диапазоне" };
  }
  return { available: true, reason: "" };
}

function selectedVisibleChannelIds() {
  const root = els.advChannelList;
  if (!root) return [];
  return Array.from(root.querySelectorAll(".adv-channel-check:checked"))
    .map((node) => String(node.value || ""))
    .filter(Boolean);
}

function renderChannels(channels) {
  const root = els.advChannelList;
  if (!root) return;
  root.innerHTML = "";

  if (!Array.isArray(channels) || !channels.length) {
    root.innerHTML = '<p class="muted">Пока нет подключенных каналов. Блогер должен пройти /start и выбрать канал через кнопку в боте.</p>';
    return;
  }

  const dateFrom = readDateOnlyInputValue(els.advDateFrom, false);
  const dateTo = readDateOnlyInputValue(els.advDateTo, true);
  const rows = [];

  for (const channel of channels) {
    const availability = channelAvailability(channel, dateFrom, dateTo);
    if (channelFilterMode === "available" && !availability.available) {
      continue;
    }

    const label = document.createElement("label");
    label.className = "check";
    const title = channel?.title || `Канал ${channel?.id || ""}`.trim();
    const username = channel?.username ? ` @${channel.username}` : "";
    const owner = channel?.blogger?.tgUsername ? `админ @${channel.blogger.tgUsername}` : `админ ${channel?.blogger?.id || "unknown"}`;
    const botState = channel?.botConnected ? "бот подключен" : "бот не подключен";
    const unavailableText = availability.available ? "" : `, ${availability.reason}`;
    label.innerHTML =
      `<input type="checkbox" class="adv-channel-check" value="${channel.id}" /> ` +
      `${title}${username} (${owner}, ${botState}${unavailableText})`;
    const check = label.querySelector("input");
    if (check) check.checked = selectedChannelIdsState.has(String(channel.id));
    rows.push(label);
  }

  if (!rows.length) {
    root.innerHTML = '<p class="muted">Нет каналов для выбранного диапазона дат.</p>';
    return;
  }

  for (const row of rows) root.appendChild(row);
}

function canCancelOffer(status, scheduledAt) {
  const ts = Number(scheduledAt || 0);
  if (Number.isFinite(ts) && ts > 0 && ts < Date.now()) return false;
  return (
    status === "pending_precheck" ||
    status === "pending_approval" ||
    status === "pending_manual_posting" ||
    status === "manual_waiting_publication" ||
    status === "scheduled"
  );
}

function renderOffers(offers) {
  const root = els.advOffersList;
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
      `<div class="planned-meta">${offer.scheduledAtText} • ${offer.modeTitle} • ${offer.statusTitle}</div>` +
      `<div class="planned-meta">CPV: ${offer.cpv} ₽ • Доход: ${offer.estimatedIncome} ₽</div>` +
      (offer.declineReason ? `<div class="planned-meta">Причина отклонения: ${offer.declineReason}</div>` : "") +
      `<div class="planned-meta">${offer.text || ""}</div>`;

    item.appendChild(main);

    if (canCancelOffer(offer.status, offer.scheduledAt)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-outline";
      btn.dataset.offerId = String(offer.id);
      btn.textContent = "Отменить";
      item.appendChild(btn);
    }

    root.appendChild(item);
  }
}

async function refreshState() {
  const state = await apiGet("/api/advertiser/state");
  latestState = state;
  renderChannels(state.channels || []);
  renderOffers(state.offers || []);
}

async function createOfferBatch() {
  const dateFrom = readDateOnlyInputValue(els.advDateFrom, false);
  const dateTo = readDateOnlyInputValue(els.advDateTo, true);
  const cpv = Number(els.advCpv?.value || 0);
  const text = String(els.advText?.value || "").trim();
  const channelIds = selectedVisibleChannelIds();

  if (!dateFrom || !dateTo || dateTo < dateFrom) {
    alert("Проверьте диапазон дат");
    return;
  }
  if (!channelIds.length) {
    alert("Выберите хотя бы один канал");
    return;
  }
  if (!cpv || cpv < 100) {
    alert("CPV должен быть не меньше 100");
    return;
  }

  if (els.advCreateBtn) els.advCreateBtn.disabled = true;
  try {
    const res = await apiPost("/api/advertiser/offers", {
      dateFrom,
      dateTo,
      cpv,
      text,
      channelIds
    });

    const createdCount = Array.isArray(res.created) ? res.created.length : 0;
    const skippedCount = Array.isArray(res.skipped) ? res.skipped.length : 0;
    setStatus(`Создано: ${createdCount}. Пропущено: ${skippedCount}.`);
    await refreshState();
  } catch (e) {
    setStatus(`Ошибка: ${e?.message || String(e)}`);
  } finally {
    if (els.advCreateBtn) els.advCreateBtn.disabled = false;
  }
}

async function cancelOffer(offerId) {
  await apiPost("/api/advertiser/offers/cancel", { offerId });
  setStatus(`Оффер #${offerId} отменен.`);
  await refreshState();
}

function bindEvents() {
  if (els.advCreateBtn) {
    els.advCreateBtn.addEventListener("click", () => {
      createOfferBatch().catch((e) => {
        setStatus(`Ошибка: ${e?.message || String(e)}`);
      });
    });
  }

  if (els.advReloadBtn) {
    els.advReloadBtn.addEventListener("click", () => {
      refreshState().catch((e) => {
        setStatus(`Ошибка: ${e?.message || String(e)}`);
      });
    });
  }

  if (els.advOffersList) {
    els.advOffersList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const offerId = Number(target.dataset.offerId || 0);
      if (!offerId) return;
      cancelOffer(offerId).catch((e) => {
        setStatus(`Ошибка: ${e?.message || String(e)}`);
      });
    });
  }

  if (els.advChannelList) {
    els.advChannelList.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains("adv-channel-check")) return;
      const id = String(target.value || "").trim();
      if (!id) return;
      if (target.checked) selectedChannelIdsState.add(id);
      else selectedChannelIdsState.delete(id);
    });
  }

  if (els.advChannelFilter) {
    els.advChannelFilter.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.name !== "channelFilterMode") return;
      channelFilterMode = target.value === "available" ? "available" : "all";
      renderChannels(latestState?.channels || []);
    });
  }

  const rerenderChannels = () => {
    renderChannels(latestState?.channels || []);
  };
  if (els.advDateFrom) {
    els.advDateFrom.addEventListener("change", rerenderChannels);
  }
  if (els.advDateTo) {
    els.advDateTo.addEventListener("change", rerenderChannels);
  }
}

function setDefaultRange() {
  const now = Date.now();
  const from = now;
  const to = now + 6 * 24 * 60 * 60 * 1000;
  if (els.advDateFrom && !els.advDateFrom.value) els.advDateFrom.value = toLocalDateInputValue(from);
  if (els.advDateTo && !els.advDateTo.value) els.advDateTo.value = toLocalDateInputValue(to);
}

async function boot() {
  setDefaultRange();
  bindEvents();
  await refreshState();
  setStatus("Готово");
}

boot().catch((e) => {
  setStatus(`Ошибка: ${e?.message || String(e)}`);
});
