const webApp = window.Telegram?.WebApp || null;

const els = {
  channelSelectWrap: document.getElementById("waChannelSelectWrap"),
  channelSelect: document.getElementById("waChannelSelect"),
  channel: document.getElementById("waChannel"),
  pauseDefaultBtn: document.getElementById("waPauseDefaultBtn"),
  pauseOtherBtn: document.getElementById("waPauseOtherBtn"),
  resumeBtn: document.getElementById("waResumeBtn"),
  scheduleBtn: document.getElementById("waScheduleBtn"),
  pauseHint: document.getElementById("waPauseHint"),
  scheduleHint: document.getElementById("waScheduleHint"),
  pauseSheet: document.getElementById("waPauseSheet"),
  slotSheet: document.getElementById("waSlotSheet"),
  slotDateInput: document.getElementById("waSlotDateInput"),
  slotList: document.getElementById("waSlotList"),
  slotApplyBtn: document.getElementById("waSlotApplyBtn"),
  slotPublishNowBtn: document.getElementById("waSlotPublishNowBtn"),
  offers: document.getElementById("waOffers"),
  filterNew: document.getElementById("waFilterNew"),
  filterScheduled: document.getElementById("waFilterScheduled"),
  filterPublished: document.getElementById("waFilterPublished"),
  filterFailed: document.getElementById("waFilterFailed"),
  filterAll: document.getElementById("waFilterAll")
};
let currentState = null;
let currentFilter = "new";
let currentChannelId = "";
let slotPickerOfferId = 0;
let slotPickerPages = [];
let slotPickerDateKey = "";
let selectedSlotTs = 0;

function setText(node, value) {
  if (!node) return;
  node.textContent = String(value || "");
}

function setHidden(node, hidden) {
  if (!node) return;
  node.hidden = Boolean(hidden);
}

function webAppHeaders() {
  const initData = String(webApp?.initData || "").trim();
  return initData ? { "x-telegram-webapp-init-data": initData } : {};
}

async function apiGet(path) {
  const res = await fetch(path, { method: "GET", headers: webAppHeaders() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...webAppHeaders() },
    body: JSON.stringify(body || {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

function renderList(root, items, emptyText) {
  if (!root) return;
  root.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    root.innerHTML = `<p class="muted">${emptyText}</p>`;
    return;
  }

  for (const item of items) {
    const statusClass = item.status === "rewarded"
      ? "is-success"
      : (item.publicationState === "failed" ? "is-failed" : "is-planned");
    const text = String(item.text || "").replace(/\s+/g, " ").trim();
    const card = document.createElement("div");
    card.className = "planned-item pp-waOffer";
    card.innerHTML =
      `<div class="planned-main">` +
      `<div class="pp-waOfferHead">` +
      `<strong>#${item.id}</strong>` +
      `<span class="pp-waBadge ${statusClass}">${item.statusTitle || item.status}</span>` +
      `</div>` +
      `<div class="planned-meta">${item.scheduledAtText}</div>` +
      `<div class="planned-meta">CPV ${item.cpv} ₽ · доход ${item.estimatedIncome} ₽</div>` +
      `<div class="planned-meta pp-waOfferText">${text}</div>` +
      `<div class="pp-waActions">` +
      (item.canDecline ? `<button class="pp-waAction danger" data-offer-action="decline" data-offer-id="${item.id}">Отклонить</button>` : "") +
      (item.canPickTime ? `<button class="pp-waAction ${(item.status === "pending_approval") ? "success" : "primary"}" data-offer-action="pick_time" data-offer-id="${item.id}">${item.status === "pending_approval" ? "Взять в работу" : "Изменить время"}</button>` : "") +
      (item.canCancelScheduled ? `<button class="pp-waAction danger" data-offer-action="cancel_scheduled" data-offer-id="${item.id}">Отказаться</button>` : "") +
      (item.canRestore ? `<button class="pp-waAction primary" data-offer-action="restore_cancelled" data-offer-id="${item.id}">Вернуть в работу</button>` : "") +
      `</div>` +
      `</div>`;
    root.appendChild(card);
  }
}

function setFilter(filterName) {
  currentFilter = filterName;
  if (els.filterNew) els.filterNew.classList.toggle("active", filterName === "new");
  if (els.filterScheduled) els.filterScheduled.classList.toggle("active", filterName === "scheduled");
  if (els.filterPublished) els.filterPublished.classList.toggle("active", filterName === "published");
  if (els.filterFailed) els.filterFailed.classList.toggle("active", filterName === "failed");
  if (els.filterAll) els.filterAll.classList.toggle("active", filterName === "all");
  renderOffers();
}

function renderOffers() {
  const offers = currentState?.offers || {};
  const mode = String(currentState?.channel?.postingMode || "");
  const upcoming = Array.isArray(offers.upcoming) ? offers.upcoming : [];
  const newItems = upcoming.filter((item) => item.status === "pending_approval");
  const scheduled = mode === "auto_with_precheck"
    ? upcoming.filter((item) => item.status === "scheduled")
    : upcoming.filter((item) => item.status === "scheduled");
  const published = Array.isArray(offers.published) ? offers.published : [];
  const failed = Array.isArray(offers.failed) ? offers.failed : [];
  const all = [...newItems, ...scheduled, ...published, ...failed];

  if (currentFilter === "new") {
    renderList(els.offers, newItems, "Пока нет новых размещений.");
    return;
  }
  if (currentFilter === "scheduled") {
    renderList(els.offers, scheduled, "Пока нет запланированных размещений.");
    return;
  }

  if (currentFilter === "published") {
    renderList(els.offers, published, "Пока нет успешных размещений.");
    return;
  }
  if (currentFilter === "failed") {
    renderList(els.offers, failed, "Пока нет несостоявшихся размещений.");
    return;
  }
  if (currentFilter === "all") {
    renderList(els.offers, all, "Пока нет размещений.");
    return;
  }
  renderList(els.offers, newItems, "Пока нет новых размещений.");
}

function renderChannelSelect(state) {
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const selected = String(state?.selectedChannelId || "");
  if (!els.channelSelectWrap || !els.channelSelect) return;
  if (channels.length < 2) {
    els.channelSelectWrap.hidden = true;
    els.channelSelect.innerHTML = "";
    return;
  }

  els.channelSelectWrap.hidden = false;
  els.channelSelect.innerHTML = "";
  for (const item of channels) {
    const option = document.createElement("option");
    option.value = String(item.id || "");
    const name = item.username ? `@${item.username}` : (item.title || `Канал ${item.id}`);
    option.textContent = name;
    if (option.value === selected) option.selected = true;
    els.channelSelect.appendChild(option);
  }
}

function applyPauseView(state) {
  const pause = state?.pause || {};
  if (!pause.supported) {
    if (els.pauseDefaultBtn) els.pauseDefaultBtn.disabled = true;
    if (els.pauseOtherBtn) els.pauseOtherBtn.disabled = true;
    if (els.resumeBtn) els.resumeBtn.hidden = true;
    if (els.pauseSheet) els.pauseSheet.hidden = true;
    setText(els.pauseHint, "В этом режиме пауза автопубликаций недоступна.");
    return;
  }

  if (pause.active) {
    if (els.pauseDefaultBtn) els.pauseDefaultBtn.disabled = false;
    if (els.pauseDefaultBtn) els.pauseDefaultBtn.hidden = true;
    if (els.pauseOtherBtn) els.pauseOtherBtn.hidden = true;
    if (els.resumeBtn) els.resumeBtn.hidden = false;
    if (els.pauseSheet) els.pauseSheet.hidden = true;
    setText(els.pauseHint, `Пауза активна до ${pause.untilText}.`);
    return;
  }

  if (els.pauseDefaultBtn) els.pauseDefaultBtn.disabled = false;
  if (els.pauseOtherBtn) els.pauseOtherBtn.disabled = false;
  if (els.pauseDefaultBtn) els.pauseDefaultBtn.hidden = false;
  if (els.pauseOtherBtn) els.pauseOtherBtn.hidden = false;
  if (els.resumeBtn) els.resumeBtn.hidden = true;
  setText(els.pauseHint, "");
}

function buildHoursDefault(scheduleSlots) {
  const hours = Array.from(
    new Set((Array.isArray(scheduleSlots) ? scheduleSlots : []).map((slot) => Number(slot?.hour)).filter(Number.isInteger))
  ).sort((a, b) => a - b);
  return hours.join(",");
}

function parseHoursInput(value) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(value || "").split(",")) {
    const hour = Number(String(chunk || "").trim());
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (seen.has(hour)) continue;
    seen.add(hour);
    out.push(hour);
  }
  return out.sort((a, b) => a - b);
}

async function editSchedule() {
  const channel = currentState?.channel || null;
  if (!channel) return;
  const currentLimit = Number(channel.weeklyPostLimit || 21);
  const nextLimitRaw = window.prompt("Лимит публикаций в неделю (1..28):", String(currentLimit));
  if (nextLimitRaw == null) return;
  const nextLimit = Number(nextLimitRaw);
  if (!Number.isInteger(nextLimit) || nextLimit < 1 || nextLimit > 28) {
    setText(els.scheduleHint, "Некорректный лимит: укажите число 1..28.");
    return;
  }

  const defaultHours = buildHoursDefault(channel.scheduleSlots);
  const nextHoursRaw = window.prompt("Часы публикаций через запятую (0..23), применится на все дни:", defaultHours || "10,11,12");
  if (nextHoursRaw == null) return;
  const hours = parseHoursInput(nextHoursRaw);
  if (!hours.length) {
    setText(els.scheduleHint, "Некорректные часы: укажите хотя бы один час 0..23.");
    return;
  }
  const scheduleSlots = [];
  for (let day = 1; day <= 7; day += 1) {
    for (const hour of hours) scheduleSlots.push({ day, hour });
  }
  try {
    await apiPost("/api/webapp/channel/settings", {
      channelId: currentChannelId || undefined,
      weeklyPostLimit: nextLimit,
      scheduleSlots
    });
    await loadState();
    setText(els.scheduleHint, "Расписание сохранено.");
  } catch (err) {
    setText(els.scheduleHint, `Ошибка: ${err?.message || String(err)}`);
  }
}

function renderState(state) {
  currentState = state;
  currentChannelId = String(state?.selectedChannelId || "");
  const channel = state?.channel || {};
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const isMultiChannel = channels.length >= 2;
  const title = channel?.title || "Канал";
  const username = channel?.username ? `@${channel.username}` : "";
  const mode = String(channel?.postingMode || "");
  setText(els.channel, username || title);
  const showNewFilter = mode === "manual_approval";
  setHidden(els.filterNew, !showNewFilter);
  if (!showNewFilter && currentFilter === "new") {
    setFilter("scheduled");
  }
  if (channel?.weeklyPostLimit && channel?.scheduleSlotsCount) {
    setText(els.scheduleHint, `Лимит ${channel.weeklyPostLimit}/нед · слотов ${channel.scheduleSlotsCount}`);
  } else {
    setText(els.scheduleHint, "");
  }
  setHidden(els.channel, isMultiChannel);
  renderChannelSelect(state);
  applyPauseView(state);
  renderOffers();
}

async function loadState() {
  if (!String(webApp?.initData || "").trim()) throw new Error("WebApp auth is missing");
  const qs = currentChannelId ? `?channelId=${encodeURIComponent(currentChannelId)}` : "";
  const state = await apiGet(`/api/webapp/state${qs}`);
  renderState(state);
  return state;
}

async function togglePause() {
  const hintBefore = els.pauseHint?.textContent || "";
  try {
    const state = await loadState();
    const action = state?.pause?.active ? "resume" : "pause24h";
    await apiPost("/api/webapp/pause", { action, channelId: currentChannelId || undefined });
    await loadState();
  } catch (err) {
    setText(els.pauseHint, `Ошибка: ${err?.message || String(err)}`);
    if (hintBefore) {
      setTimeout(() => setText(els.pauseHint, hintBefore), 2500);
    }
  }
}

function openPauseSheet() {
  if (els.pauseSheet) els.pauseSheet.hidden = false;
}

function closePauseSheet() {
  if (els.pauseSheet) els.pauseSheet.hidden = true;
}

async function pauseForDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return;
  const hintBefore = els.pauseHint?.textContent || "";
  try {
    await apiPost("/api/webapp/pause", { action: "pause", durationDays: n, channelId: currentChannelId || undefined });
    closePauseSheet();
    await loadState();
  } catch (err) {
    setText(els.pauseHint, `Ошибка: ${err?.message || String(err)}`);
    if (hintBefore) setTimeout(() => setText(els.pauseHint, hintBefore), 2500);
  }
}

function flattenSlotsFromPages(pages) {
  const out = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const dateLabel = String(page?.dateLabel || "");
    for (const slot of Array.isArray(page?.slots) ? page.slots : []) {
      out.push({
        ts: Number(slot?.ts || 0),
        label: `${dateLabel} ${String(slot?.timeLabel || "")}`.trim()
      });
    }
  }
  return out.filter((item) => Number.isFinite(item.ts) && item.ts > 0);
}

function toDateInputValue(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderSlotOptions() {
  if (!els.slotList) return;
  const page = slotPickerPages.find((item) => item.dateKey === slotPickerDateKey) || null;
  const slots = Array.isArray(page?.slots) ? page.slots : [];
  els.slotList.innerHTML = "";
  selectedSlotTs = 0;
  if (!slots.length) {
    els.slotList.innerHTML = "<p class='muted'>На эту дату нет слотов.</p>";
    return;
  }
  for (const slot of slots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pp-slotBtn";
    button.dataset.slotTs = String(slot?.ts || "");
    button.textContent = String(slot?.timeLabel || "");
    if (!selectedSlotTs) {
      selectedSlotTs = Number(slot?.ts || 0);
      button.classList.add("active");
    }
    els.slotList.appendChild(button);
  }
}

function openSlotSheet(offerId, pages) {
  slotPickerOfferId = Number(offerId);
  slotPickerPages = Array.isArray(pages) ? pages.filter((item) => Array.isArray(item?.slots) && item.slots.length) : [];
  if (!slotPickerPages.length || !els.slotDateInput || !els.slotSheet) return false;
  slotPickerDateKey = String(slotPickerPages[0]?.dateKey || "");
  const dt = slotPickerPages[0]?.slots?.[0]?.ts || Date.now();
  els.slotDateInput.value = slotPickerDateKey;
  els.slotDateInput.min = slotPickerPages[0]?.dateKey || toDateInputValue(dt);
  const lastPage = slotPickerPages[slotPickerPages.length - 1];
  els.slotDateInput.max = lastPage?.dateKey || toDateInputValue(dt);
  renderSlotOptions();
  const source = [
    ...(Array.isArray(currentState?.offers?.upcoming) ? currentState.offers.upcoming : []),
    ...(Array.isArray(currentState?.offers?.published) ? currentState.offers.published : []),
    ...(Array.isArray(currentState?.offers?.failed) ? currentState.offers.failed : [])
  ];
  const offer = source.find((item) => Number(item?.id) === slotPickerOfferId) || null;
  if (els.slotPublishNowBtn) {
    els.slotPublishNowBtn.hidden = !Boolean(offer?.canPublishNow);
  }
  els.slotSheet.hidden = false;
  return true;
}

function closeSlotSheet() {
  if (els.slotSheet) els.slotSheet.hidden = true;
  slotPickerOfferId = 0;
  slotPickerPages = [];
  slotPickerDateKey = "";
  selectedSlotTs = 0;
  if (els.slotPublishNowBtn) els.slotPublishNowBtn.hidden = true;
}

function handleSlotDateChange() {
  if (!els.slotDateInput) return;
  const key = String(els.slotDateInput.value || "");
  const next = slotPickerPages.find((item) => String(item?.dateKey || "") === key);
  if (!next) return;
  slotPickerDateKey = String(next.dateKey || "");
  renderSlotOptions();
}

async function handleOfferAction(action, offerId) {
  if (!Number.isInteger(offerId) || offerId <= 0) return;
  const before = els.pauseHint?.textContent || "";
  try {
    if (action === "pick_time") {
      const slotsRes = await apiGet(`/api/webapp/offer-pages?offerId=${offerId}`);
      const pages = Array.isArray(slotsRes?.pages) ? slotsRes.pages : [];
      if (!flattenSlotsFromPages(pages).length) {
        setText(els.pauseHint, "Нет доступных слотов в окне кампании.");
        return;
      }
      openSlotSheet(offerId, pages);
      return;
    }
    await apiPost("/api/webapp/offer-action", { action, offerId, channelId: currentChannelId || undefined });
    await loadState();
    setText(els.pauseHint, "Изменение сохранено.");
  } catch (err) {
    setText(els.pauseHint, `Ошибка: ${err?.message || String(err)}`);
    if (before) setTimeout(() => setText(els.pauseHint, before), 2500);
  }
}

async function boot() {
  webApp?.ready?.();
  webApp?.expand?.();
  els.pauseDefaultBtn?.addEventListener("click", () => {
    pauseForDays(1).catch(() => {});
  });
  els.pauseOtherBtn?.addEventListener("click", () => {
    openPauseSheet();
  });
  els.pauseSheet?.addEventListener("click", (event) => {
    const closer = event.target?.closest?.("[data-close='1']");
    if (closer) {
      closePauseSheet();
      return;
    }
    const btn = event.target?.closest?.("button[data-days]");
    if (!btn) return;
    const days = Number(btn.dataset.days || 0);
    pauseForDays(days).catch(() => {});
  });
  els.resumeBtn?.addEventListener("click", () => {
    togglePause().catch(() => {});
  });
  els.scheduleBtn?.addEventListener("click", () => {
    editSchedule().catch(() => {});
  });
  els.slotDateInput?.addEventListener("change", handleSlotDateChange);
  els.slotSheet?.addEventListener("click", (event) => {
    const close = event.target?.closest?.("[data-slot-close='1']");
    if (close) closeSlotSheet();
    const slotButton = event.target?.closest?.("[data-slot-ts]");
    if (slotButton) {
      selectedSlotTs = Number(slotButton.dataset.slotTs || 0);
      const buttons = els.slotList?.querySelectorAll?.("[data-slot-ts]") || [];
      for (const node of buttons) {
        node.classList.toggle("active", node === slotButton);
      }
    }
  });
  els.slotApplyBtn?.addEventListener("click", async () => {
    const slotTs = Number(selectedSlotTs || 0);
    if (!slotPickerOfferId || !Number.isFinite(slotTs)) {
      setText(els.pauseHint, "Выберите слот.");
      return;
    }
    try {
      await apiPost("/api/webapp/offer-action", {
        action: "pick_time",
        offerId: slotPickerOfferId,
        slotTs,
        channelId: currentChannelId || undefined
      });
      closeSlotSheet();
      await loadState();
      setText(els.pauseHint, "Время публикации обновлено.");
    } catch (err) {
      setText(els.pauseHint, `Ошибка: ${err?.message || String(err)}`);
    }
  });
  els.slotPublishNowBtn?.addEventListener("click", async () => {
    if (!slotPickerOfferId) return;
    try {
      await apiPost("/api/webapp/offer-action", {
        action: "publish_now",
        offerId: slotPickerOfferId,
        channelId: currentChannelId || undefined
      });
      closeSlotSheet();
      await loadState();
      setText(els.pauseHint, "Публикация перенесена на ближайшее время.");
    } catch (err) {
      setText(els.pauseHint, `Ошибка: ${err?.message || String(err)}`);
    }
  });
  els.channelSelect?.addEventListener("change", () => {
    currentChannelId = String(els.channelSelect?.value || "");
    loadState().catch(() => {});
  });
  els.filterNew?.addEventListener("click", () => setFilter("new"));
  els.filterScheduled?.addEventListener("click", () => setFilter("scheduled"));
  els.filterPublished?.addEventListener("click", () => setFilter("published"));
  els.filterFailed?.addEventListener("click", () => setFilter("failed"));
  els.filterAll?.addEventListener("click", () => setFilter("all"));
  els.offers?.addEventListener("click", (event) => {
    const btn = event.target?.closest?.("[data-offer-action]");
    if (!btn) return;
    const action = String(btn.dataset.offerAction || "");
    const offerId = Number(btn.dataset.offerId || 0);
    handleOfferAction(action, offerId).catch(() => {});
  });

  try {
    await loadState();
  } catch (err) {
    const rawMessage = String(err?.message || err || "");
    const isAuthMiss = rawMessage.includes("WebApp auth is missing");
    const uiMessage = isAuthMiss
      ? "Ошибка: откройте кабинет из Telegram-бота."
      : `Ошибка: ${rawMessage}`;
    setText(els.channel, uiMessage);
    setText(els.pauseHint, isAuthMiss ? "Авторизация WebApp не передана." : "Не удалось загрузить кабинет.");
    if (els.pauseDefaultBtn) els.pauseDefaultBtn.disabled = true;
    if (els.pauseOtherBtn) els.pauseOtherBtn.disabled = true;
    if (els.resumeBtn) els.resumeBtn.hidden = true;
    if (els.pauseSheet) els.pauseSheet.hidden = true;
  }
}

boot().catch(() => {});
