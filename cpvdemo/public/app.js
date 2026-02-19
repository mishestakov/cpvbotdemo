const URL_TOKEN = new URLSearchParams(location.search).get("token") || "";
if (!URL_TOKEN) {
  location.replace("/cpvdemo/auth");
  throw new Error("Missing token");
}
const telegramLinks = window.TelegramLinks || null;

const dayLabels = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];
const hoursCount = 24;

const els = {
  pageTitle: document.getElementById("pageTitle"),
  reconnectBotBtn: document.getElementById("reconnectBotBtn"),
  openBotBtn: document.getElementById("openBotBtn"),
  botHint: document.getElementById("botHint"),

  channelTitleInput: document.getElementById("channelTitleInput"),
  channelLinkInput: document.getElementById("channelLinkInput"),
  adminLoginInput: document.getElementById("adminLoginInput"),

  weeklyPostLimit: document.getElementById("weeklyPostLimit"),
  modeAuto: document.getElementById("modeAuto"),
  modePreapproval: document.getElementById("modePreapproval"),

  scheduleTags: document.getElementById("scheduleTags"),
  openScheduleModal: document.getElementById("openScheduleModal"),
  scheduleModal: document.getElementById("scheduleModal"),
  scheduleMatrixBody: document.getElementById("scheduleMatrixBody"),
  saveScheduleBtn: document.getElementById("saveScheduleBtn"),
  cancelScheduleBtn: document.getElementById("cancelScheduleBtn"),

  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  reloadStateBtn: document.getElementById("reloadStateBtn"),
  settingsSaveHint: document.getElementById("settingsSaveHint"),

  auctionStrategySlider: document.getElementById("auctionStrategySlider"),
  auctionStrategyLabels: Array.from(document.querySelectorAll("#auctionStrategyLabels span"))
};

let latestState = null;
let scheduleState = createDefaultScheduleState();
let draftState = createDefaultScheduleState();
let modeUpdateInFlight = false;

function setText(el, value) {
  if (!el) return;
  el.textContent = value == null || value === "" ? "—" : String(value);
}

function createDefaultScheduleState() {
  const state = Array.from({ length: dayLabels.length }, () => Array.from({ length: hoursCount }, () => false));
  for (let day = 0; day < dayLabels.length; day += 1) {
    for (let hour = 10; hour <= 19; hour += 1) {
      state[day][hour] = true;
    }
  }
  return state;
}

function cloneState(state) {
  return state.map((row) => row.slice());
}

function hourText(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function scheduleStateFromSlots(slots) {
  const state = Array.from({ length: dayLabels.length }, () => Array.from({ length: hoursCount }, () => false));
  for (const item of Array.isArray(slots) ? slots : []) {
    const day = Number(item?.day);
    const hour = Number(item?.hour);
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    state[day - 1][hour] = true;
  }
  return state;
}

function slotsFromScheduleState(state) {
  const out = [];
  for (let d = 0; d < state.length; d += 1) {
    for (let h = 0; h < state[d].length; h += 1) {
      if (!state[d][h]) continue;
      out.push({ day: d + 1, hour: h });
    }
  }
  return out;
}

function rowToRanges(row) {
  const ranges = [];
  let start = -1;
  for (let hour = 0; hour <= row.length; hour += 1) {
    const active = Boolean(row[hour]);
    if (active && start < 0) start = hour;
    if (!active && start >= 0) {
      ranges.push([start, hour]);
      start = -1;
    }
  }
  return ranges;
}

function renderScheduleTags() {
  const root = els.scheduleTags;
  if (!root) return;
  root.innerHTML = "";
  scheduleState.forEach((row, dayIndex) => {
    rowToRanges(row).forEach(([start, end]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag schedule-chip";
      chip.dataset.day = String(dayIndex);
      chip.dataset.start = String(start);
      chip.dataset.end = String(end);
      chip.innerHTML = `${dayLabels[dayIndex]} ${hourText(start)}-${hourText(end)} <span class="tag-x">×</span>`;
      root.appendChild(chip);
    });
  });
}

function buildMatrix() {
  const body = els.scheduleMatrixBody;
  if (!body) return;
  body.innerHTML = "";
  dayLabels.forEach((day, dayIndex) => {
    const row = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = day;
    row.appendChild(th);

    for (let hour = 0; hour < hoursCount; hour += 1) {
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot";
      btn.dataset.day = String(dayIndex);
      btn.dataset.hour = String(hour);
      td.appendChild(btn);
      row.appendChild(td);
    }
    body.appendChild(row);
  });
}

function paintMatrix() {
  const body = els.scheduleMatrixBody;
  if (!body) return;
  body.querySelectorAll(".slot").forEach((node) => {
    const day = Number(node.dataset.day);
    const hour = Number(node.dataset.hour);
    node.classList.toggle("active", Boolean(draftState[day][hour]));
  });
}

function openModal() {
  draftState = cloneState(scheduleState);
  paintMatrix();
  els.scheduleModal?.classList.add("is-open");
  els.scheduleModal?.setAttribute("aria-hidden", "false");
}

function closeModal() {
  els.scheduleModal?.classList.remove("is-open");
  els.scheduleModal?.setAttribute("aria-hidden", "true");
}

function getSelectedMode() {
  return els.modeAuto?.checked ? "auto" : "preapproval";
}

function setSelectedMode(mode) {
  const value = mode === "auto" ? "auto" : "preapproval";
  if (els.modeAuto) els.modeAuto.checked = value === "auto";
  if (els.modePreapproval) els.modePreapproval.checked = value === "preapproval";
}

function fillWeeklyPostLimitOptions() {
  if (!els.weeklyPostLimit) return;
  els.weeklyPostLimit.innerHTML = "";
  for (let i = 1; i <= 28; i += 1) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = String(i);
    els.weeklyPostLimit.appendChild(option);
  }
}

function updateStrategySlider() {
  const slider = els.auctionStrategySlider;
  if (!slider) return;
  const value = Number(slider.value);
  const progress = (value / 4) * 100;
  slider.style.setProperty("--progress", `${progress}%`);
  for (const label of els.auctionStrategyLabels) {
    label.classList.toggle("active", Number(label.dataset.index) === value);
  }
}

function renderState(state) {
  latestState = state;
  const ch = Array.isArray(state?.channels) && state.channels.length ? state.channels[0] : null;

  if (!ch) {
    setText(els.pageTitle, "Редактирование канала");
    setText(els.botHint, "Канал не найден по текущей ссылке.");
    return;
  }

  const channelLabel = ch.title || ch.username || ch.key;
  setText(els.pageTitle, `Редактирование канала (${channelLabel})`);
  els.channelTitleInput.value = ch.title || "";
  els.channelLinkInput.value = ch.username ? `https://t.me/${ch.username}` : "";
  els.adminLoginInput.value = ch?.blogger?.tgUsername ? `@${ch.blogger.tgUsername}` : "";

  const mode = ch.postingMode || "preapproval";
  setSelectedMode(mode);

  const limit = Number(
    ch.weeklyPostLimit ?? ch?.planner?.weeklyPostLimit ?? 28
  );
  if (els.weeklyPostLimit && Number.isInteger(limit) && limit >= 1 && limit <= 28) {
    els.weeklyPostLimit.value = String(limit);
  }

  scheduleState = scheduleStateFromSlots(ch.scheduleSlots || []);
  renderScheduleTags();

  const botUsername = state?.bot?.username || "";
  if (botUsername) {
    setText(els.botHint, `Подключение через @${botUsername}`);
    if (els.openBotBtn) {
      els.openBotBtn.disabled = false;
    }
  } else {
    setText(els.botHint, "Бот недоступен. Проверьте BOT_TOKEN и webhook в .env.");
    if (els.openBotBtn) {
      els.openBotBtn.disabled = true;
    }
  }
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

async function refreshState() {
  const state = await apiGet(`/api/state?token=${encodeURIComponent(URL_TOKEN)}`);
  renderState(state);
}

async function saveSettings() {
  const weeklyPostLimit = Number(els.weeklyPostLimit?.value || 0);
  const scheduleSlots = slotsFromScheduleState(scheduleState);
  const mode = getSelectedMode();

  if (!weeklyPostLimit || weeklyPostLimit < 1 || weeklyPostLimit > 28) {
    alert("Укажите лимит постов от 1 до 28");
    return;
  }
  if (!scheduleSlots.length) {
    alert("Добавьте хотя бы один слот публикации");
    return;
  }

  if (els.saveSettingsBtn) els.saveSettingsBtn.disabled = true;
  try {
    await apiPost("/api/channel/settings", {
      token: URL_TOKEN,
      weeklyPostLimit,
      scheduleSlots
    });
    await apiPost("/api/channel/mode", {
      token: URL_TOKEN,
      mode
    });
    setText(els.settingsSaveHint, "Настройки сохранены");
    await refreshState();
  } catch (e) {
    alert(e?.message || String(e));
    setText(els.settingsSaveHint, "Ошибка сохранения");
  } finally {
    if (els.saveSettingsBtn) els.saveSettingsBtn.disabled = false;
  }
}

async function applyPostingMode(mode) {
  if (modeUpdateInFlight) return;
  modeUpdateInFlight = true;
  try {
    await apiPost("/api/channel/mode", { token: URL_TOKEN, mode });
    setText(els.settingsSaveHint, "Режим публикации обновлён");
    await refreshState();
  } catch (e) {
    alert(e?.message || String(e));
    await refreshState().catch(() => {});
  } finally {
    modeUpdateInFlight = false;
  }
}

function removeTagRange(day, start, end) {
  for (let hour = start; hour < end; hour += 1) {
    scheduleState[day][hour] = false;
  }
  renderScheduleTags();
}

function bindEvents() {
  if (els.openScheduleModal) {
    els.openScheduleModal.addEventListener("click", openModal);
  }

  if (els.saveScheduleBtn) {
    els.saveScheduleBtn.addEventListener("click", () => {
      scheduleState = cloneState(draftState);
      renderScheduleTags();
      closeModal();
    });
  }

  if (els.cancelScheduleBtn) {
    els.cancelScheduleBtn.addEventListener("click", closeModal);
  }

  if (els.scheduleModal) {
    els.scheduleModal.addEventListener("click", (event) => {
      if (event.target === els.scheduleModal) {
        closeModal();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.scheduleModal?.classList.contains("is-open")) {
      closeModal();
    }
  });

  if (els.scheduleMatrixBody) {
    els.scheduleMatrixBody.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("slot")) return;
      const day = Number(target.dataset.day);
      const hour = Number(target.dataset.hour);
      draftState[day][hour] = !draftState[day][hour];
      target.classList.toggle("active", draftState[day][hour]);
    });
  }

  if (els.scheduleTags) {
    els.scheduleTags.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const chip = target.closest(".schedule-chip");
      if (!chip) return;
      const day = Number(chip.dataset.day);
      const start = Number(chip.dataset.start);
      const end = Number(chip.dataset.end);
      removeTagRange(day, start, end);
    });
  }

  if (els.modeAuto) {
    els.modeAuto.addEventListener("change", () => {
      if (els.modeAuto.checked) {
        applyPostingMode("auto").catch(() => {});
      }
    });
  }
  if (els.modePreapproval) {
    els.modePreapproval.addEventListener("change", () => {
      if (els.modePreapproval.checked) {
        applyPostingMode("preapproval").catch(() => {});
      }
    });
  }

  if (els.saveSettingsBtn) {
    els.saveSettingsBtn.addEventListener("click", () => {
      saveSettings().catch(() => {});
    });
  }

  if (els.reloadStateBtn) {
    els.reloadStateBtn.addEventListener("click", () => {
      refreshState().catch(() => {});
    });
  }

  if (els.openBotBtn) {
    els.openBotBtn.addEventListener("click", () => {
      const username = latestState?.bot?.username;
      if (!username) return;
      const links = telegramLinks?.buildFromUsernameStart(username, URL_TOKEN);
      telegramLinks?.openDeepLink(links?.deep || "");
    });
  }

  if (els.reconnectBotBtn) {
    els.reconnectBotBtn.addEventListener("click", () => {
      els.openBotBtn?.click();
    });
  }

  const slider = els.auctionStrategySlider;
  if (slider) {
    slider.addEventListener("input", updateStrategySlider);
  }
  for (const label of els.auctionStrategyLabels) {
    label.addEventListener("click", () => {
      if (!slider) return;
      slider.value = label.dataset.index || "0";
      updateStrategySlider();
    });
  }
}

async function boot() {
  fillWeeklyPostLimitOptions();
  buildMatrix();
  renderScheduleTags();
  updateStrategySlider();
  bindEvents();

  try {
    await refreshState();
  } catch (e) {
    setText(els.settingsSaveHint, `Ошибка загрузки: ${e?.message || String(e)}`);
  }

}

boot().catch(() => {});
