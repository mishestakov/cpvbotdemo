const els = {
  advText: document.getElementById("advText"),
  advDateFrom: document.getElementById("advDateFrom"),
  advDateTo: document.getElementById("advDateTo"),
  advCpv: document.getElementById("advCpv"),
  advBloggerList: document.getElementById("advBloggerList"),
  advCreateBtn: document.getElementById("advCreateBtn"),
  advReloadBtn: document.getElementById("advReloadBtn"),
  advStatusHint: document.getElementById("advStatusHint"),
  advOffersList: document.getElementById("advOffersList")
};

let latestState = null;

function setStatus(text) {
  if (!els.advStatusHint) return;
  els.advStatusHint.textContent = text == null || text === "" ? "—" : String(text);
}

function toLocalDateTimeInputValue(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

function readDateInputValue(input) {
  const value = String(input?.value || "").trim();
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return ts;
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

function renderBloggers(bloggers) {
  const root = els.advBloggerList;
  if (!root) return;
  root.innerHTML = "";

  if (!Array.isArray(bloggers) || !bloggers.length) {
    root.innerHTML = '<p class="muted">Пока нет авторизованных блогеров. Попросите блогера пройти /start через страницу /cpvdemo/auth.</p>';
    return;
  }

  for (const blogger of bloggers) {
    const label = document.createElement("label");
    label.className = "check";
    const username = blogger?.tgUsername ? `@${blogger.tgUsername}` : `ID ${blogger.id}`;
    label.innerHTML = `<input type="checkbox" class="adv-blogger-check" value="${blogger.id}" /> ${username}`;
    root.appendChild(label);
  }
}

function canCancelOffer(status) {
  return status === "pending_precheck" || status === "pending_approval" || status === "pending_manual_posting" || status === "scheduled";
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
      `<div class="planned-meta">${offer.text || ""}</div>`;

    item.appendChild(main);

    if (canCancelOffer(offer.status)) {
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

function selectedBloggerIds() {
  const root = els.advBloggerList;
  if (!root) return [];
  return Array.from(root.querySelectorAll(".adv-blogger-check:checked")).map((node) => String(node.value || "")).filter(Boolean);
}

async function refreshState() {
  const state = await apiGet("/api/advertiser/state");
  latestState = state;
  renderBloggers(state.bloggers || []);
  renderOffers(state.offers || []);
}

async function createOfferBatch() {
  const dateFrom = readDateInputValue(els.advDateFrom);
  const dateTo = readDateInputValue(els.advDateTo);
  const cpv = Number(els.advCpv?.value || 0);
  const text = String(els.advText?.value || "").trim();
  const bloggerIds = selectedBloggerIds();

  if (!dateFrom || !dateTo || dateTo < dateFrom) {
    alert("Проверьте диапазон дат");
    return;
  }
  if (!bloggerIds.length) {
    alert("Выберите хотя бы одного блогера");
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
      bloggerIds
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
}

function setDefaultRange() {
  const now = Date.now();
  const from = now + 60 * 60 * 1000;
  const to = now + 24 * 60 * 60 * 1000;
  if (els.advDateFrom && !els.advDateFrom.value) els.advDateFrom.value = toLocalDateTimeInputValue(from);
  if (els.advDateTo && !els.advDateTo.value) els.advDateTo.value = toLocalDateTimeInputValue(to);
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
