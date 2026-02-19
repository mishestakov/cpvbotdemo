"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env") });
dns.setDefaultResultOrder("ipv4first");

const HOST = String(process.env.HOST || "127.0.0.1");
const PORT = Number(process.env.PORT || 3030);
const PUBLIC_DIR = path.join(__dirname, "public");
const CPVDEMO_TOKEN = "cpvdemo-token";

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const WEBHOOK_BASE_URL = String(process.env.WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET_TOKEN = String(process.env.WEBHOOK_SECRET_TOKEN || "").trim();
const WEBHOOK_PATH = "/api/telegram/webhook";

const BOT_API_TIMEOUT_MS = parseMsEnv("BOT_API_TIMEOUT_MS", 10_000, 3_000);
const BOT_CONNECT_RETRY_INTERVAL_MS = parseMsEnv("BOT_CONNECT_RETRY_INTERVAL_MS", 5_000, 1_000);
const AUTH_SESSION_TTL_MS = parseMsEnv("AUTH_SESSION_TTL_MS", 30 * 60 * 1000, 60_000);
const PRECHECK_DECISION_MS = parseMsEnv("PRECHECK_DECISION_MS", 60_000, 10_000);
const OFFER_DEADLINE_CHECK_INTERVAL_MS = parseMsEnv("OFFER_DEADLINE_CHECK_INTERVAL_MS", 5_000, 1_000);

const POSTING_MODES = ["auto", "auto_with_precheck", "manual_approval", "manual_posting"];
const MODE_TITLES = {
  auto: "Автоматически",
  auto_with_precheck: "С предпросмотром (если не отклоню — выйдет)",
  manual_approval: "Только после моего подтверждения",
  manual_posting: "Ручная публикация"
};

const ACTIVE_OFFER_STATUSES = new Set([
  "pending_precheck",
  "pending_approval",
  "pending_manual_posting",
  "scheduled"
]);

const STATUS_TITLES = {
  pending_precheck: "Ждёт решения (предпросмотр)",
  pending_approval: "Ждёт подтверждения",
  pending_manual_posting: "Ждёт принятия для ручной публикации",
  scheduled: "Согласован",
  declined_by_blogger: "Отклонён блогером",
  cancelled_by_advertiser: "Отменён рекламодателем",
  cancelled_by_blogger: "Отменён блогером",
  expired: "Истёк дедлайн"
};

const DEMO_AD_TEXTS = [
  "Скидка 20% на подписку и бонусы для новых пользователей.",
  "Запуск новой линейки продуктов: бесплатная доставка первую неделю.",
  "Сервис для бизнеса: автоматизация отчетности и CRM в одном окне.",
  "Образовательный курс: первый модуль бесплатно до конца недели.",
  "Приложение для планирования: персональные рекомендации и аналитика."
];

const channelState = {
  key: "@demo_channel",
  title: "Демо канал CPV",
  username: "demo_channel",
  status: "ready",
  postingMode: "auto_with_precheck",
  weeklyPostLimit: 7,
  scheduleSlots: buildDefaultScheduleSlots(),
  blogger: {
    id: null,
    tgUsername: "demo_admin",
    chatId: null,
    userId: null
  }
};

const authSessions = new Map();
const bloggers = new Map();
const offers = new Map();
const botState = {
  enabled: false,
  username: null,
  lastError: null,
  delivery: "webhook",
  webhookUrl: WEBHOOK_BASE_URL ? `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}` : null
};

let botLaunchInFlight = false;
let nextOfferId = 1001;
let offerTickInFlight = false;

function parseMsEnv(name, fallbackMs, minMs) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.max(minMs, Math.floor(value));
}

function normalizeMode(mode) {
  const value = String(mode || "").trim();
  if (value === "preapproval") return "auto_with_precheck";
  if (POSTING_MODES.includes(value)) return value;
  return "auto_with_precheck";
}

function modeTitle(mode) {
  const key = normalizeMode(mode);
  return MODE_TITLES[key] || MODE_TITLES.auto_with_precheck;
}

function formatError(err) {
  const message = err?.message || String(err);
  const code = err?.code || err?.cause?.code;
  const codeText = code ? ` code=${code}` : "";
  const description = err?.response?.description || err?.description;
  const descriptionText = description ? ` description=${description}` : "";
  const cause = err?.cause?.message;
  const causeText = cause ? ` cause=${cause}` : "";
  return `${message}${codeText}${descriptionText}${causeText}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(err) {
  const code = String(err?.code || err?.cause?.code || "").toUpperCase();
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function isOfferActive(offer) {
  return ACTIVE_OFFER_STATUSES.has(String(offer?.status || ""));
}

function statusTitle(status) {
  return STATUS_TITLES[status] || status || "—";
}

function buildDefaultScheduleSlots() {
  const slots = [];
  for (let day = 1; day <= 7; day += 1) {
    for (let hour = 10; hour <= 19; hour += 1) {
      slots.push({ day, hour });
    }
  }
  return slots;
}

function sendJson(res, code, data) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, code, body) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function normalizeScheduleSlots(input) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    const day = Number(item?.day);
    const hour = Number(item?.hour);
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const key = `${day}:${hour}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, hour });
  }
  return out.sort((a, b) => a.day - b.day || a.hour - b.hour);
}

function parseStartPayload(text) {
  const value = String(text || "").trim();
  const match = value.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return "";
  return String(match[1] || "").trim();
}

function markExpiredSessions() {
  const now = Date.now();
  for (const row of authSessions.values()) {
    if (row.status === "connected") continue;
    if (now <= row.expiresAt) continue;
    row.status = "expired";
    row.error = row.error || "Session expired";
  }
}

function dayOfWeekMonFirst(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

function twoDigits(num) {
  return String(num).padStart(2, "0");
}

function dateKeyFromTs(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`;
}

function formatDateLabel(ts) {
  const d = new Date(ts);
  return `${twoDigits(d.getDate())}.${twoDigits(d.getMonth() + 1)}`;
}

function formatTimeLabel(ts) {
  const d = new Date(ts);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${twoDigits(d.getDate())}.${twoDigits(d.getMonth() + 1)} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
}

function buildUpcomingScheduleSlots(scheduleSlots, days = 14, nowTs = Date.now()) {
  const out = [];
  const seen = new Set();
  for (let offset = 0; offset < days; offset += 1) {
    const dayDate = new Date(nowTs + offset * 24 * 60 * 60 * 1000);
    const day = dayOfWeekMonFirst(dayDate);
    const daySlots = scheduleSlots.filter((slot) => slot.day === day);
    for (const slot of daySlots) {
      const slotDate = new Date(
        dayDate.getFullYear(),
        dayDate.getMonth(),
        dayDate.getDate(),
        slot.hour,
        0,
        0,
        0
      );
      const ts = slotDate.getTime();
      if (ts <= nowTs + 30_000) continue;
      if (seen.has(ts)) continue;
      seen.add(ts);
      out.push({ ts, dateKey: dateKeyFromTs(ts), dateLabel: formatDateLabel(ts), timeLabel: formatTimeLabel(ts) });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function getReservedSlots(exceptOfferId, bloggerId) {
  const set = new Set();
  for (const offer of offers.values()) {
    if (offer.id === exceptOfferId) continue;
    if (offer.bloggerId !== bloggerId) continue;
    if (!isOfferActive(offer)) continue;
    set.add(Number(offer.scheduledAt));
  }
  return set;
}

function buildOfferDatePages(offer) {
  const slots = buildUpcomingScheduleSlots(channelState.scheduleSlots, 14);
  const reserved = getReservedSlots(offer.id, offer.bloggerId);
  const available = slots.filter((slot) => !reserved.has(slot.ts));

  const currentTs = Number(offer.scheduledAt);
  if (Number.isFinite(currentTs) && currentTs > Date.now() + 30_000 && !available.some((item) => item.ts === currentTs)) {
    available.push({
      ts: currentTs,
      dateKey: dateKeyFromTs(currentTs),
      dateLabel: formatDateLabel(currentTs),
      timeLabel: formatTimeLabel(currentTs)
    });
  }

  available.sort((a, b) => a.ts - b.ts);

  const grouped = new Map();
  for (const slot of available) {
    if (!grouped.has(slot.dateKey)) {
      grouped.set(slot.dateKey, { dateKey: slot.dateKey, dateLabel: slot.dateLabel, slots: [] });
    }
    grouped.get(slot.dateKey).slots.push({ ts: slot.ts, timeLabel: slot.timeLabel });
  }

  return Array.from(grouped.values()).map((page) => {
    page.slots.sort((a, b) => a.ts - b.ts);
    return page;
  });
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function buildModeKeyboard() {
  const rows = [];
  for (const mode of POSTING_MODES) {
    const isCurrent = normalizeMode(channelState.postingMode) === mode;
    const mark = isCurrent ? "• " : "";
    rows.push([{ text: `${mark}${modeTitle(mode)}`, callback_data: `mode:${mode}` }]);
  }
  return { inline_keyboard: rows };
}

function buildModeText() {
  return `Текущий режим: ${modeTitle(channelState.postingMode)}\nВыберите режим публикации:`;
}

function buildOfferKeyboard(offer, pageFromCallback) {
  if (!isOfferActive(offer)) return null;

  const pages = buildOfferDatePages(offer);
  const rows = [];

  if (pages.length > 0) {
    const currentPage = clamp(
      Number.isInteger(pageFromCallback) ? pageFromCallback : Number(offer.selectedDatePage || 0),
      0,
      pages.length - 1
    );
    offer.selectedDatePage = currentPage;

    const prevPage = clamp(currentPage - 1, 0, pages.length - 1);
    const nextPage = clamp(currentPage + 1, 0, pages.length - 1);
    rows.push([
      { text: "◀", callback_data: `of:pd:${offer.id}:${prevPage}` },
      { text: `📅 ${pages[currentPage].dateLabel}`, callback_data: `of:pd:${offer.id}:${currentPage}` },
      { text: "▶", callback_data: `of:pd:${offer.id}:${nextPage}` }
    ]);

    const timeButtons = pages[currentPage].slots.map((slot) => ({
      text: slot.timeLabel,
      callback_data: `of:ps:${offer.id}:${slot.ts}`
    }));

    for (let i = 0; i < timeButtons.length; i += 4) {
      rows.push(timeButtons.slice(i, i + 4));
    }
  }

  if (offer.status === "pending_precheck" || offer.status === "pending_approval") {
    rows.push([
      { text: "✅ Подтвердить", callback_data: `of:ap:${offer.id}` },
      { text: "❌ Отклонить", callback_data: `of:dc:${offer.id}` }
    ]);
  } else if (offer.status === "pending_manual_posting") {
    rows.push([
      { text: "✅ Принять", callback_data: `of:mp:${offer.id}` },
      { text: "❌ Отклонить", callback_data: `of:dc:${offer.id}` }
    ]);
  } else if (offer.status === "scheduled") {
    rows.push([{ text: "🚫 Отказаться", callback_data: `of:bc:${offer.id}` }]);
  }

  return rows.length ? { inline_keyboard: rows } : null;
}

function offerSummaryText(offer) {
  const lines = [];
  lines.push(`Оффер #${offer.id}`);
  lines.push(`Блогер: @${offer.bloggerUsername || "unknown"}`);
  lines.push(`Режим: ${modeTitle(offer.modeAtCreation)}`);
  lines.push(`Статус: ${statusTitle(offer.status)}`);
  lines.push(`Время выхода: ${formatDateTime(offer.scheduledAt)}`);
  lines.push(`CPV: ${offer.cpv} ₽`);
  lines.push(`Оценка дохода: ${offer.estimatedIncome} ₽`);
  lines.push("Текст (без ERID):");
  lines.push(offer.textRaw);

  if (offer.status === "pending_precheck") {
    const until = formatDateTime(offer.decisionDeadlineAt || Date.now());
    lines.push(`Если не отклоните до ${until}, пост выйдет автоматически.`);
  }
  if (offer.status === "pending_approval") {
    lines.push("Пост выйдет только после подтверждения.");
  }
  if (offer.status === "pending_manual_posting") {
    lines.push("После принятия пришлю промаркированный текст для ручной публикации.");
  }

  return lines.join("\n");
}

function countActiveOffersForBlogger(bloggerId) {
  let count = 0;
  for (const offer of offers.values()) {
    if (offer.bloggerId !== bloggerId) continue;
    if (!isOfferActive(offer)) continue;
    count += 1;
  }
  return count;
}

function toOfferDto(offer) {
  return {
    id: offer.id,
    bloggerId: offer.bloggerId,
    bloggerUsername: offer.bloggerUsername,
    status: offer.status,
    statusTitle: statusTitle(offer.status),
    mode: offer.modeAtCreation,
    modeTitle: modeTitle(offer.modeAtCreation),
    scheduledAt: offer.scheduledAt,
    scheduledAtText: formatDateTime(offer.scheduledAt),
    cpv: offer.cpv,
    estimatedIncome: offer.estimatedIncome,
    text: offer.textRaw
  };
}

function listPlannedOffersForCurrentBlogger() {
  const currentBloggerId = channelState.blogger.id;
  const out = [];
  for (const offer of offers.values()) {
    if (!isOfferActive(offer)) continue;
    if (currentBloggerId && offer.bloggerId !== currentBloggerId) continue;
    out.push(toOfferDto(offer));
  }
  return out.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

function listAllOffersForAdvertiser() {
  const out = [];
  for (const offer of offers.values()) {
    out.push(toOfferDto(offer));
  }
  return out.sort((a, b) => b.id - a.id);
}

function listConnectedBloggers() {
  const out = [];
  for (const blogger of bloggers.values()) {
    out.push({
      id: blogger.id,
      tgUsername: blogger.tgUsername,
      chatId: blogger.chatId,
      connectedAt: blogger.connectedAt
    });
  }
  return out.sort((a, b) => b.connectedAt - a.connectedAt);
}

function snapshot(token) {
  return {
    bot: {
      enabled: botState.enabled,
      username: botState.username,
      lastError: botState.lastError,
      delivery: botState.delivery,
      webhookUrl: botState.webhookUrl
    },
    channels: token === CPVDEMO_TOKEN ? [{ ...channelState, postingMode: normalizeMode(channelState.postingMode) }] : [],
    plannedPosts: token === CPVDEMO_TOKEN ? listPlannedOffersForCurrentBlogger() : []
  };
}

function advertiserSnapshot() {
  return {
    channel: {
      key: channelState.key,
      title: channelState.title,
      username: channelState.username,
      postingMode: normalizeMode(channelState.postingMode),
      postingModeTitle: modeTitle(channelState.postingMode),
      weeklyPostLimit: channelState.weeklyPostLimit
    },
    bloggers: listConnectedBloggers(),
    offers: listAllOffersForAdvertiser()
  };
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/auth.html";
  if (pathname === "/cpvdemo" || pathname === "/cpvdemo/") pathname = "/index.html";
  if (pathname === "/cpvdemo/auth" || pathname === "/cpvdemo/auth/") pathname = "/auth.html";
  if (pathname === "/cpvdemo/advertiser" || pathname === "/cpvdemo/advertiser/") pathname = "/advertiser.html";
  if (pathname.startsWith("/cpvdemo/")) pathname = pathname.slice("/cpvdemo".length);
  if (pathname === "/auth" || pathname === "/auth/") pathname = "/auth.html";

  const fullPath = path.join(PUBLIC_DIR, pathname);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "content-type": contentType(fullPath) });
    res.end(data);
  });
}

function botApiUrl(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function tgApi(method, payload = {}) {
  if (!BOT_TOKEN) {
    const err = new Error("BOT_TOKEN is missing");
    err.code = "BOT_TOKEN_MISSING";
    throw err;
  }

  const signal = AbortSignal.timeout(BOT_API_TIMEOUT_MS);
  const res = await fetch(botApiUrl(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || !json?.ok) {
    const description = json?.description || `HTTP ${res.status}`;
    const err = new Error(description);
    err.response = { description };
    throw err;
  }

  return json.result;
}

async function tgApiWithRetry(method, payload = {}) {
  const delays = [700, 1500];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await tgApi(method, payload);
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === delays.length) {
        throw err;
      }
      const delayMs = delays[attempt];
      console.warn(`Bot API ${method} transient error (${formatError(err)}), retry in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastError || new Error(`Bot API ${method} failed`);
}

async function answerCallbackQuery(callbackQueryId, text) {
  if (!callbackQueryId) return;
  try {
    await tgApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text ? String(text) : undefined
    });
  } catch (err) {
    botState.lastError = formatError(err);
  }
}

async function sendBotMessage(chatId, text, replyMarkup) {
  if (!chatId) return null;
  try {
    return await tgApi("sendMessage", {
      chat_id: chatId,
      text: String(text || ""),
      reply_markup: replyMarkup || undefined
    });
  } catch (err) {
    botState.lastError = formatError(err);
    return null;
  }
}

async function editBotMessage(chatId, messageId, text, replyMarkup) {
  if (!chatId || !messageId) return null;
  try {
    return await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: String(text || ""),
      reply_markup: replyMarkup || undefined
    });
  } catch (err) {
    const message = String(err?.message || "").toLowerCase();
    if (message.includes("message is not modified")) {
      return null;
    }
    botState.lastError = formatError(err);
    return null;
  }
}

async function upsertOfferMessage(offer, pageFromCallback) {
  if (!offer.chatId) return;

  const text = offerSummaryText(offer);
  const keyboard = buildOfferKeyboard(offer, pageFromCallback);

  if (offer.messageId) {
    const edited = await editBotMessage(offer.chatId, offer.messageId, text, keyboard);
    if (edited) return;
  }

  const sent = await sendBotMessage(offer.chatId, text, keyboard);
  if (sent?.message_id) {
    offer.messageId = sent.message_id;
  }
}

function pickAdText() {
  const idx = Math.floor(Math.random() * DEMO_AD_TEXTS.length);
  return DEMO_AD_TEXTS[idx];
}

function createOffer({ blogger, scheduledAt, textRaw, cpv }) {
  const mode = normalizeMode(channelState.postingMode);
  const createdAt = Date.now();
  const offerId = nextOfferId;
  nextOfferId += 1;

  const adText = String(textRaw || "").trim() || pickAdText();
  const offerCpv = Number.isFinite(Number(cpv)) ? Math.max(100, Math.round(Number(cpv))) : 900;
  const estimatedIncome = Math.round(offerCpv * 0.85);

  const initialStatus = mode === "auto"
    ? "scheduled"
    : mode === "auto_with_precheck"
      ? "pending_precheck"
      : mode === "manual_approval"
        ? "pending_approval"
        : "pending_manual_posting";

  const offer = {
    id: offerId,
    createdAt,
    scheduledAt,
    modeAtCreation: mode,
    status: initialStatus,
    cpv: offerCpv,
    estimatedIncome,
    textRaw: adText,
    textMarked: `[ERID: demo-${offerId}] ${adText}`,
    decisionDeadlineAt: initialStatus === "pending_precheck" ? Date.now() + PRECHECK_DECISION_MS : null,
    selectedDatePage: 0,
    bloggerId: blogger.id,
    bloggerUsername: blogger.tgUsername,
    chatId: blogger.chatId,
    messageId: null
  };

  offers.set(offer.id, offer);
  return offer;
}

function pickScheduledTimeInRange(rangeFrom, rangeTo, index) {
  const from = Number(rangeFrom);
  const to = Number(rangeTo);
  const nowSafe = Date.now() + 60_000;
  const baseFrom = Math.max(from, nowSafe);
  const baseTo = Math.max(to, baseFrom);

  if (baseTo <= baseFrom) return baseFrom;
  const step = 60 * 60 * 1000;
  const candidate = baseFrom + index * step;
  return Math.min(candidate, baseTo);
}

async function notifyOfferCreated(offer) {
  if (offer.modeAtCreation === "auto") {
    await sendBotMessage(offer.chatId, [
      `Оффер #${offer.id} запланирован автоматически.`,
      `Время выхода: ${formatDateTime(offer.scheduledAt)}`,
      `CPV: ${offer.cpv} ₽`,
      `Оценка дохода: ${offer.estimatedIncome} ₽`,
      "Текст (без ERID):",
      offer.textRaw
    ].join("\n"));
    return;
  }

  await upsertOfferMessage(offer, 0);
}

async function approveOffer(offer, reasonText) {
  offer.status = "scheduled";
  offer.decisionDeadlineAt = null;
  await upsertOfferMessage(offer);
  if (reasonText) {
    await sendBotMessage(offer.chatId, reasonText);
  }
}

async function declineOfferByBlogger(offer) {
  offer.status = "declined_by_blogger";
  offer.decisionDeadlineAt = null;
  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, `Оффер #${offer.id} отклонён.`);
}

async function cancelOfferByBlogger(offer) {
  offer.status = "cancelled_by_blogger";
  offer.decisionDeadlineAt = null;
  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, `Публикация по офферу #${offer.id} отменена.`);
}

async function cancelOfferByAdvertiser(offer) {
  offer.status = "cancelled_by_advertiser";
  offer.decisionDeadlineAt = null;
  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, `Рекламодатель отменил оффер #${offer.id}. Публикация не состоится.`);
}

async function acceptManualPostingOffer(offer) {
  offer.status = "scheduled";
  offer.decisionDeadlineAt = null;
  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, [
    `Оффер #${offer.id} принят для ручной публикации.`,
    "Промаркированный текст:",
    offer.textMarked
  ].join("\n"));
}

function canUseSlot(offer, slotTs) {
  const pages = buildOfferDatePages(offer);
  for (const page of pages) {
    if (page.slots.some((slot) => slot.ts === slotTs)) return true;
  }
  return false;
}

async function rescheduleOffer(offer, slotTs) {
  if (!Number.isFinite(slotTs)) return false;
  if (!canUseSlot(offer, slotTs)) return false;

  offer.scheduledAt = slotTs;
  if (offer.status === "pending_precheck") {
    offer.decisionDeadlineAt = Date.now() + PRECHECK_DECISION_MS;
  }

  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, `Оффер #${offer.id} перенесён на ${formatDateTime(slotTs)}.`);
  return true;
}

async function processOfferDeadlines() {
  if (offerTickInFlight) return;
  offerTickInFlight = true;

  try {
    const now = Date.now();
    for (const offer of offers.values()) {
      if (offer.status === "pending_precheck" && now >= Number(offer.decisionDeadlineAt || 0)) {
        await approveOffer(offer, `Оффер #${offer.id} автоматически подтверждён: до дедлайна не было отклонения.`);
        continue;
      }

      if (offer.status === "pending_approval" && now >= Number(offer.scheduledAt)) {
        offer.status = "expired";
        offer.decisionDeadlineAt = null;
        await upsertOfferMessage(offer);
        await sendBotMessage(offer.chatId, `Оффер #${offer.id} не подтверждён вовремя. Размещение не состоится.`);
        continue;
      }

      if (offer.status === "pending_manual_posting" && now >= Number(offer.scheduledAt)) {
        offer.status = "expired";
        offer.decisionDeadlineAt = null;
        await upsertOfferMessage(offer);
        await sendBotMessage(offer.chatId, `Оффер #${offer.id}: время вышло, ручная публикация не выполнена.`);
      }
    }
  } finally {
    offerTickInFlight = false;
  }
}

function upsertBlogger(userId, username, chatId) {
  const id = String(userId || chatId || "").trim();
  if (!id) return null;

  const row = {
    id,
    tgUserId: userId || null,
    tgUsername: username || `blogger_${id}`,
    chatId: Number(chatId || 0) || null,
    connectedAt: Date.now()
  };

  bloggers.set(id, row);
  return row;
}

async function handleStartMessage(message) {
  const chatId = Number(message?.chat?.id || 0);
  const payload = parseStartPayload(message?.text);

  if (!payload) {
    await sendBotMessage(chatId, "Откройте ссылку авторизации из веб-интерфейса и нажмите Start ещё раз.");
    return;
  }

  markExpiredSessions();
  const row = authSessions.get(payload);
  if (!row) {
    await sendBotMessage(chatId, "Ссылка авторизации не найдена. Запросите новую в интерфейсе.");
    return;
  }

  if (row.status === "expired") {
    await sendBotMessage(chatId, "Сессия авторизации истекла. Запросите новую ссылку.");
    return;
  }

  row.status = "connected";
  row.tgUserId = message?.from?.id || null;
  row.tgUsername = message?.from?.username || null;
  row.connectedAt = Date.now();
  row.error = null;

  const blogger = upsertBlogger(row.tgUserId, row.tgUsername, chatId);
  if (blogger) {
    channelState.blogger = {
      id: blogger.id,
      tgUsername: blogger.tgUsername,
      chatId: blogger.chatId,
      userId: blogger.tgUserId
    };
  }

  await sendBotMessage(chatId, "Канал авторизован. Возвращайтесь в браузер, страница обновится автоматически.");
}

async function sendModeChooser(chatId) {
  await sendBotMessage(chatId, buildModeText(), buildModeKeyboard());
}

async function handleModeCallback(query, mode) {
  const nextMode = normalizeMode(mode);
  channelState.postingMode = nextMode;
  await answerCallbackQuery(query.id, `Режим: ${modeTitle(nextMode)}`);

  const chatId = Number(query?.message?.chat?.id || 0);
  const messageId = Number(query?.message?.message_id || 0);
  if (chatId && messageId) {
    await editBotMessage(chatId, messageId, buildModeText(), buildModeKeyboard());
  }
}

function parseOfferCallback(data) {
  const parts = String(data || "").split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== "of") return null;
  return {
    action: parts[1],
    offerId: Number(parts[2]),
    arg: parts[3] != null ? String(parts[3]) : null
  };
}

async function handleOfferCallback(query, parsed) {
  if (!parsed || !Number.isInteger(parsed.offerId)) {
    await answerCallbackQuery(query.id, "Некорректное действие");
    return;
  }

  const offer = offers.get(parsed.offerId);
  if (!offer) {
    await answerCallbackQuery(query.id, "Оффер не найден");
    return;
  }

  const queryChatId = Number(query?.message?.chat?.id || 0);
  if (offer.chatId && queryChatId && offer.chatId !== queryChatId) {
    await answerCallbackQuery(query.id, "Этот оффер не для вас");
    return;
  }

  if (parsed.action === "pd") {
    const page = Number(parsed.arg || 0);
    await upsertOfferMessage(offer, Number.isInteger(page) ? page : 0);
    await answerCallbackQuery(query.id);
    return;
  }

  if (parsed.action === "ps") {
    const slotTs = Number(parsed.arg || 0);
    const ok = await rescheduleOffer(offer, slotTs);
    await answerCallbackQuery(query.id, ok ? "Время обновлено" : "Слот недоступен");
    return;
  }

  if (parsed.action === "ap") {
    if (offer.status !== "pending_precheck" && offer.status !== "pending_approval") {
      await answerCallbackQuery(query.id, "Оффер уже обработан");
      return;
    }
    await approveOffer(offer, `Оффер #${offer.id} подтверждён.`);
    await answerCallbackQuery(query.id, "Подтверждено");
    return;
  }

  if (parsed.action === "dc") {
    if (!isOfferActive(offer)) {
      await answerCallbackQuery(query.id, "Оффер уже обработан");
      return;
    }
    await declineOfferByBlogger(offer);
    await answerCallbackQuery(query.id, "Отклонено");
    return;
  }

  if (parsed.action === "mp") {
    if (offer.status !== "pending_manual_posting") {
      await answerCallbackQuery(query.id, "Оффер уже обработан");
      return;
    }
    await acceptManualPostingOffer(offer);
    await answerCallbackQuery(query.id, "Принято");
    return;
  }

  if (parsed.action === "bc") {
    if (!isOfferActive(offer)) {
      await answerCallbackQuery(query.id, "Оффер уже обработан");
      return;
    }
    await cancelOfferByBlogger(offer);
    await answerCallbackQuery(query.id, "Отменено");
    return;
  }

  await answerCallbackQuery(query.id, "Неизвестное действие");
}

async function processTelegramUpdate(update) {
  const text = String(update?.message?.text || "");

  if (/^\/start(?:@\w+)?/i.test(text)) {
    await handleStartMessage(update.message);
    return;
  }

  if (/^\/mode(?:@\w+)?(?:\s+.*)?$/i.test(text)) {
    const chatId = Number(update?.message?.chat?.id || 0);
    await sendModeChooser(chatId);
    return;
  }

  if (update?.callback_query) {
    const query = update.callback_query;
    const data = String(query?.data || "");

    if (data.startsWith("mode:")) {
      await handleModeCallback(query, data.slice(5));
      return;
    }

    const parsed = parseOfferCallback(data);
    await handleOfferCallback(query, parsed);
  }
}

async function startBot() {
  if (botLaunchInFlight) return;
  botLaunchInFlight = true;

  try {
    if (!WEBHOOK_BASE_URL) {
      throw new Error("WEBHOOK_BASE_URL is missing. Start ngrok and set WEBHOOK_BASE_URL in .env");
    }
    if (!WEBHOOK_SECRET_TOKEN) {
      throw new Error("WEBHOOK_SECRET_TOKEN is missing. Set a random secret in .env");
    }

    const me = await tgApiWithRetry("getMe", {});
    botState.username = me?.username || null;

    const webhookUrl = `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}`;
    botState.webhookUrl = webhookUrl;

    const payload = {
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      secret_token: WEBHOOK_SECRET_TOKEN
    };

    await tgApiWithRetry("setWebhook", payload);

    botState.enabled = true;
    botState.lastError = null;
    console.log(`Bot connected: @${botState.username || "unknown"}; webhook=${webhookUrl}`);
  } catch (err) {
    botState.enabled = false;
    botState.lastError = formatError(err);
    console.error(`Bot launch failed: ${botState.lastError}`);
  } finally {
    botLaunchInFlight = false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  markExpiredSessions();

  if (url.pathname === WEBHOOK_PATH && req.method === "POST") {
    const got = String(req.headers["x-telegram-bot-api-secret-token"] || "");
    if (got !== WEBHOOK_SECRET_TOKEN) {
      sendText(res, 403, "Forbidden");
      return;
    }

    const update = await readJsonBody(req);
    sendJson(res, 200, { ok: true });
    processTelegramUpdate(update).catch((err) => {
      botState.lastError = formatError(err);
    });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const token = String(url.searchParams.get("token") || "").trim();
    sendJson(res, 200, snapshot(token));
    return;
  }

  if (url.pathname === "/api/advertiser/state" && req.method === "GET") {
    sendJson(res, 200, advertiserSnapshot());
    return;
  }

  if (url.pathname === "/api/auth/session" && req.method === "POST") {
    if (!botState.enabled || !botState.username) {
      sendJson(res, 503, { error: botState.lastError || "Bot is not configured" });
      return;
    }

    const token = crypto.randomBytes(8).toString("hex");
    const row = {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
      status: "pending_start",
      tgUserId: null,
      tgUsername: null,
      connectedAt: null,
      error: null
    };
    authSessions.set(token, row);

    sendJson(res, 200, {
      ok: true,
      token,
      tg: `https://t.me/${botState.username}?start=${encodeURIComponent(token)}`,
      status: row.status,
      expiresAt: row.expiresAt
    });
    return;
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const token = String(url.searchParams.get("token") || "").trim();
    const row = authSessions.get(token);
    if (!row) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      token,
      status: row.status,
      tgUserId: row.tgUserId,
      tgUsername: row.tgUsername,
      error: row.error,
      expiresAt: row.expiresAt,
      web: row.status === "connected" ? `/cpvdemo?token=${encodeURIComponent(CPVDEMO_TOKEN)}` : null
    });
    return;
  }

  if (url.pathname === "/api/channel/mode" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (String(body.token || "") !== CPVDEMO_TOKEN) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const mode = normalizeMode(body.mode);
    if (!POSTING_MODES.includes(mode)) {
      sendJson(res, 400, { error: "Invalid mode" });
      return;
    }

    channelState.postingMode = mode;
    sendJson(res, 200, { ok: true, mode });
    return;
  }

  if (url.pathname === "/api/channel/settings" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (String(body.token || "") !== CPVDEMO_TOKEN) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const weeklyPostLimit = Number(body.weeklyPostLimit);
    if (!Number.isInteger(weeklyPostLimit) || weeklyPostLimit < 1 || weeklyPostLimit > 28) {
      sendJson(res, 400, { error: "Invalid weeklyPostLimit" });
      return;
    }

    const scheduleSlots = normalizeScheduleSlots(body.scheduleSlots);
    if (!scheduleSlots.length) {
      sendJson(res, 400, { error: "Invalid scheduleSlots" });
      return;
    }

    channelState.weeklyPostLimit = weeklyPostLimit;
    channelState.scheduleSlots = scheduleSlots;
    sendJson(res, 200, { ok: true, weeklyPostLimit, scheduleSlots });
    return;
  }

  if (url.pathname === "/api/offers/cancel" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (String(body.token || "") !== CPVDEMO_TOKEN) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const offerId = Number(body.offerId);
    if (!Number.isInteger(offerId)) {
      sendJson(res, 400, { error: "Invalid offerId" });
      return;
    }

    const offer = offers.get(offerId);
    if (!offer) {
      sendJson(res, 404, { error: "Offer not found" });
      return;
    }

    if (!isOfferActive(offer)) {
      sendJson(res, 400, { error: "Offer is not active" });
      return;
    }

    if (channelState.blogger.id && offer.bloggerId !== channelState.blogger.id) {
      sendJson(res, 403, { error: "Offer is assigned to another blogger" });
      return;
    }

    await cancelOfferByBlogger(offer);
    sendJson(res, 200, { ok: true, offer: toOfferDto(offer) });
    return;
  }

  if (url.pathname === "/api/advertiser/offers" && req.method === "POST") {
    const body = await readJsonBody(req);

    const dateFrom = Number(body.dateFrom);
    const dateTo = Number(body.dateTo);
    if (!Number.isFinite(dateFrom) || !Number.isFinite(dateTo) || dateTo < dateFrom) {
      sendJson(res, 400, { error: "Invalid date range" });
      return;
    }

    const bloggerIds = Array.isArray(body.bloggerIds)
      ? body.bloggerIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    if (!bloggerIds.length) {
      sendJson(res, 400, { error: "Select at least one blogger" });
      return;
    }

    const text = String(body.text || "").trim();
    const cpv = Number(body.cpv);

    const created = [];
    const skipped = [];

    for (let i = 0; i < bloggerIds.length; i += 1) {
      const bloggerId = bloggerIds[i];
      const blogger = bloggers.get(bloggerId);
      if (!blogger) {
        skipped.push({ bloggerId, reason: "Blogger not found" });
        continue;
      }

      if (!blogger.chatId) {
        skipped.push({ bloggerId, reason: "Blogger has no active chat" });
        continue;
      }

      if (countActiveOffersForBlogger(bloggerId) >= channelState.weeklyPostLimit) {
        skipped.push({ bloggerId, reason: "Weekly post limit is filled" });
        continue;
      }

      const scheduledAt = pickScheduledTimeInRange(dateFrom, dateTo, i);
      const offer = createOffer({
        blogger,
        scheduledAt,
        textRaw: text,
        cpv
      });

      await notifyOfferCreated(offer);
      created.push(toOfferDto(offer));
    }

    sendJson(res, 200, {
      ok: true,
      created,
      skipped
    });
    return;
  }

  if (url.pathname === "/api/advertiser/offers/cancel" && req.method === "POST") {
    const body = await readJsonBody(req);
    const offerId = Number(body.offerId);
    if (!Number.isInteger(offerId)) {
      sendJson(res, 400, { error: "Invalid offerId" });
      return;
    }

    const offer = offers.get(offerId);
    if (!offer) {
      sendJson(res, 404, { error: "Offer not found" });
      return;
    }

    if (!isOfferActive(offer)) {
      sendJson(res, 400, { error: "Offer is not active" });
      return;
    }

    await cancelOfferByAdvertiser(offer);

    sendJson(res, 200, {
      ok: true,
      offer: toOfferDto(offer)
    });
    return;
  }

  serveStatic(req, res, url);
});

async function boot() {
  server.listen(PORT, HOST, () => {
    console.log(`CPV demo: http://${HOST}:${PORT}/cpvdemo/auth`);
  });

  startBot().catch((err) => {
    botState.enabled = false;
    botState.lastError = formatError(err);
  });

  const retryTimer = setInterval(() => {
    if (!BOT_TOKEN) return;
    if (botLaunchInFlight) return;
    if (botState.enabled) return;
    startBot().catch((err) => {
      botState.enabled = false;
      botState.lastError = formatError(err);
    });
  }, BOT_CONNECT_RETRY_INTERVAL_MS);
  retryTimer.unref();

  const offerTickTimer = setInterval(() => {
    processOfferDeadlines().catch((err) => {
      botState.lastError = formatError(err);
    });
  }, OFFER_DEADLINE_CHECK_INTERVAL_MS);
  offerTickTimer.unref();

  const shutdown = () => {
    clearInterval(retryTimer);
    clearInterval(offerTickTimer);
    server.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

boot().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
