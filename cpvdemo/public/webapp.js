const webApp = window.Telegram?.WebApp || null;

const els = {
  channelSelectWrap: document.getElementById("waChannelSelectWrap"),
  channelSelect: document.getElementById("waChannelSelect"),
  channel: document.getElementById("waChannel"),
  pauseDefaultBtn: document.getElementById("waPauseDefaultBtn"),
  pauseOtherBtn: document.getElementById("waPauseOtherBtn"),
  resumeBtn: document.getElementById("waResumeBtn"),
  pauseHint: document.getElementById("waPauseHint"),
  pauseSheet: document.getElementById("waPauseSheet"),
  offers: document.getElementById("waOffers"),
  filterUpcoming: document.getElementById("waFilterUpcoming"),
  filterPublished: document.getElementById("waFilterPublished"),
  filterFailed: document.getElementById("waFilterFailed"),
  filterAll: document.getElementById("waFilterAll")
};
let currentState = null;
let currentFilter = "upcoming";
let currentChannelId = "";

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
      `</div>`;
    root.appendChild(card);
  }
}

function setFilter(filterName) {
  currentFilter = filterName;
  if (els.filterUpcoming) els.filterUpcoming.classList.toggle("active", filterName === "upcoming");
  if (els.filterPublished) els.filterPublished.classList.toggle("active", filterName === "published");
  if (els.filterFailed) els.filterFailed.classList.toggle("active", filterName === "failed");
  if (els.filterAll) els.filterAll.classList.toggle("active", filterName === "all");
  renderOffers();
}

function renderOffers() {
  const offers = currentState?.offers || {};
  const upcoming = Array.isArray(offers.upcoming) ? offers.upcoming : [];
  const published = Array.isArray(offers.published) ? offers.published : [];
  const failed = Array.isArray(offers.failed) ? offers.failed : [];
  const all = [...upcoming, ...published, ...failed];

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
  renderList(els.offers, upcoming, "Пока нет предстоящих размещений.");
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

function renderState(state) {
  currentState = state;
  currentChannelId = String(state?.selectedChannelId || "");
  const channel = state?.channel || {};
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const isMultiChannel = channels.length >= 2;
  const title = channel?.title || "Канал";
  const username = channel?.username ? `@${channel.username}` : "";
  setText(els.channel, username || title);
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
  els.channelSelect?.addEventListener("change", () => {
    currentChannelId = String(els.channelSelect?.value || "");
    loadState().catch(() => {});
  });
  els.filterUpcoming?.addEventListener("click", () => setFilter("upcoming"));
  els.filterPublished?.addEventListener("click", () => setFilter("published"));
  els.filterFailed?.addEventListener("click", () => setFilter("failed"));
  els.filterAll?.addEventListener("click", () => setFilter("all"));

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
