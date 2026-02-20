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
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const WEBHOOK_BASE_URL = String(process.env.WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET_TOKEN = String(process.env.WEBHOOK_SECRET_TOKEN || "").trim();
const WEBHOOK_PATH = "/api/telegram/webhook";
const WEBHOOK_DROP_PENDING_UPDATES = String(process.env.WEBHOOK_DROP_PENDING_UPDATES || "true").trim().toLowerCase() !== "false";
const ALLOW_TEST_API = String(process.env.ALLOW_TEST_API || "false").trim().toLowerCase() === "true";

const BOT_API_TIMEOUT_MS = parseMsEnv("BOT_API_TIMEOUT_MS", 20_000, 3_000);
const BOT_CONNECT_RETRY_INTERVAL_MS = parseMsEnv("BOT_CONNECT_RETRY_INTERVAL_MS", 5_000, 1_000);
const AUTH_SESSION_TTL_MS = parseMsEnv("AUTH_SESSION_TTL_MS", 30 * 60 * 1000, 60_000);
const PRECHECK_DECISION_MS = parseMsEnv("PRECHECK_DECISION_MS", 60_000, 10_000);
const OFFER_DEADLINE_CHECK_INTERVAL_MS = parseMsEnv("OFFER_DEADLINE_CHECK_INTERVAL_MS", 5_000, 1_000);
const MANUAL_PUBLICATION_HOLD_MS = parseMsEnv("MANUAL_PUBLICATION_HOLD_MS", 60_000, 1_000);
const MANUAL_PENDING_REMINDER_MAX = parseIntEnv("MANUAL_PENDING_REMINDER_MAX", 2, 0);
const MANUAL_PENDING_REMINDER_INTERVAL_MS = parseMsEnv(
  "MANUAL_PENDING_REMINDER_INTERVAL_MS",
  24 * 60 * 60 * 1000,
  1_000
);
const AUTO_PAUSE_DURATION_MS = parseMsEnv("AUTO_PAUSE_DURATION_MS", 24 * 60 * 60 * 1000, 1_000);
const RU_HUMAN_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const POSTING_MODES = ["auto", "auto_with_precheck", "manual_approval", "manual_posting"];
const MODE_TITLES = {
  auto: "Автоматически",
  auto_with_precheck: "С предпросмотром (если не отклоню — выйдет)",
  manual_approval: "Только после моего подтверждения",
  manual_posting: "Ручная публикация"
};
const MODE_BUTTON_TITLES = {
  auto: "Авто",
  auto_with_precheck: "Предпросмотр",
  manual_approval: "Подтверждение",
  manual_posting: "Ручная"
};

const ACTIVE_OFFER_STATUSES = new Set([
  "pending_precheck",
  "pending_approval",
  "pending_manual_posting",
  "manual_waiting_publication",
  "manual_queued_publication",
  "manual_publication_found",
  "scheduled"
]);

const STATUS_TITLES = {
  pending_precheck: "Ждёт решения (предпросмотр)",
  pending_approval: "Ждёт подтверждения",
  pending_manual_posting: "Ждёт принятия для ручной публикации",
  manual_waiting_publication: "Ожидает публикацию с ERID",
  manual_queued_publication: "Отложка подтверждена, ждём публикацию",
  manual_publication_found: "Публикация найдена, идёт проверка",
  rewarded: "Вознаграждение начислено",
  archived_not_published: "Перенесено в архив (не размещено)",
  auto_publish_error: "Ошибка автопубликации",
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

const botState = {
  enabled: false,
  username: null,
  userId: null,
  lastError: null,
  delivery: "webhook",
  webhookUrl: WEBHOOK_BASE_URL ? `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}` : null
};

let botLaunchInFlight = false;
let offerTickInFlight = false;

function parseMsEnv(name, fallbackMs, minMs) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.max(minMs, Math.floor(value));
}

function parseIntEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
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

function modeButtonTitle(mode) {
  const key = normalizeMode(mode);
  return MODE_BUTTON_TITLES[key] || MODE_BUTTON_TITLES.auto_with_precheck;
}

function modeSupportsPause(mode) {
  const key = normalizeMode(mode);
  return key === "auto" || key === "auto_with_precheck" || key === "manual_approval";
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

function statusTitle(status) {
  return STATUS_TITLES[status] || status || "—";
}

function offerProcessedCallbackText(offer) {
  return `Оффер уже в статусе: ${statusTitle(offer?.status)}.`;
}

function isOfferActive(offer) {
  return ACTIVE_OFFER_STATUSES.has(String(offer?.status || ""));
}

function canCancelOffer(status) {
  return (
    status === "pending_precheck" ||
    status === "pending_approval" ||
    status === "pending_manual_posting" ||
    status === "manual_waiting_publication" ||
    status === "manual_queued_publication" ||
    status === "scheduled"
  );
}

function isOfferAwaitingDecision(offer) {
  const status = String(offer?.status || "");
  return status === "pending_precheck" || status === "pending_approval" || status === "pending_manual_posting";
}

function isChannelAutoPaused(channel, now = Date.now()) {
  const untilAt = Number(channel?.autoPausedUntilAt || 0);
  return Number.isFinite(untilAt) && untilAt > now;
}

function buildDefaultScheduleSlots() {
  const slots = [];
  for (let day = 1; day <= 7; day += 1) {
    for (let hour = 10; hour <= 20; hour += 1) {
      slots.push({ day, hour });
    }
  }
  return slots;
}

function createEmptyDb() {
  return {
    meta: {
      nextOfferId: 1001,
      nextChannelId: 1
    },
    bloggers: {},
    channels: {},
    offers: {},
    authSessions: {}
  };
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

function normalizeDb(raw) {
  const db = createEmptyDb();
  if (!raw || typeof raw !== "object") return db;

  db.meta.nextOfferId = Number(raw?.meta?.nextOfferId) > 0 ? Number(raw.meta.nextOfferId) : 1001;
  db.meta.nextChannelId = Number(raw?.meta?.nextChannelId) > 0 ? Number(raw.meta.nextChannelId) : 1;

  db.bloggers = raw.bloggers && typeof raw.bloggers === "object" ? raw.bloggers : {};
  db.channels = raw.channels && typeof raw.channels === "object" ? raw.channels : {};
  db.offers = raw.offers && typeof raw.offers === "object" ? raw.offers : {};
  db.authSessions = raw.authSessions && typeof raw.authSessions === "object" ? raw.authSessions : {};

  for (const channel of Object.values(db.channels)) {
    channel.postingMode = normalizeMode(channel.postingMode);
    channel.weeklyPostLimit = Number.isInteger(Number(channel.weeklyPostLimit))
      ? Math.max(1, Math.min(28, Number(channel.weeklyPostLimit)))
      : 21;
    channel.scheduleSlots = normalizeScheduleSlots(channel.scheduleSlots);
    if (!channel.scheduleSlots.length) {
      channel.scheduleSlots = buildDefaultScheduleSlots();
    }
    channel.botConnected = Boolean(channel.botConnected);
    channel.botMemberStatus = String(channel.botMemberStatus || "unknown");
    channel.autoPausedUntilAt = Number.isFinite(Number(channel.autoPausedUntilAt))
      ? Number(channel.autoPausedUntilAt)
      : null;
    channel.autoPauseMessageId = Number.isInteger(Number(channel.autoPauseMessageId))
      ? Number(channel.autoPauseMessageId)
      : null;
  }

  for (const offer of Object.values(db.offers)) {
    offer.uiState = String(offer.uiState || "main");
    offer.bloggerDeclineReason = offer.bloggerDeclineReason ? String(offer.bloggerDeclineReason) : null;
    offer.eridTag = String(offer.eridTag || `demo-${offer.id}`);
    offer.adMessageId = Number.isInteger(Number(offer.adMessageId)) ? Number(offer.adMessageId) : null;
    offer.manualPublicationFoundAt = Number.isFinite(Number(offer.manualPublicationFoundAt))
      ? Number(offer.manualPublicationFoundAt)
      : null;
    const fallbackAt = Number.isFinite(Number(offer.scheduledAt)) ? Number(offer.scheduledAt) : Date.now();
    offer.availabilityFromAt = Number.isFinite(Number(offer.availabilityFromAt))
      ? Number(offer.availabilityFromAt)
      : fallbackAt;
    offer.availabilityToAt = Number.isFinite(Number(offer.availabilityToAt))
      ? Number(offer.availabilityToAt)
      : fallbackAt;
    if (offer.availabilityToAt < offer.availabilityFromAt) {
      offer.availabilityToAt = offer.availabilityFromAt;
    }
    offer.manualReminderCount = Number.isInteger(Number(offer.manualReminderCount))
      ? Math.max(0, Number(offer.manualReminderCount))
      : 0;
    offer.manualReminderSentAt = Number.isFinite(Number(offer.manualReminderSentAt))
      ? Number(offer.manualReminderSentAt)
      : null;
  }

  return db;
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const db = createEmptyDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    return db;
  }

  try {
    const text = fs.readFileSync(DB_PATH, "utf8");
    return normalizeDb(JSON.parse(text));
  } catch {
    return createEmptyDb();
  }
}

function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const db = loadDb();

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

function isLocalRequest(req) {
  const addr = String(req?.socket?.remoteAddress || "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
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

function parseStartPayload(text) {
  const value = String(text || "").trim();
  const match = value.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return "";
  return String(match[1] || "").trim();
}

function markExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const row of Object.values(db.authSessions)) {
    if (row.status === "connected") continue;
    if (now <= Number(row.expiresAt || 0)) continue;
    row.status = "expired";
    row.error = row.error || "Session expired";
    changed = true;
  }
  if (changed) saveDb(db);
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

function formatDateTimeHumanRu(ts) {
  return RU_HUMAN_DATE_TIME_FORMATTER.format(new Date(ts)).replace(" в ", ", ");
}

function buildMarkedAdText(textRaw, eridTag) {
  const body = String(textRaw || "").trim();
  const marker = `Реклама. erid: ${String(eridTag || "").trim()}`;
  if (!body) return marker;
  return `${body}\n\n${marker}`;
}

function manualHoldDurationText() {
  if (MANUAL_PUBLICATION_HOLD_MS % 60_000 === 0) {
    return `${MANUAL_PUBLICATION_HOLD_MS / 60_000} мин.`;
  }
  return `${Math.ceil(MANUAL_PUBLICATION_HOLD_MS / 1000)} сек.`;
}

function listBloggers() {
  return Object.values(db.bloggers);
}

function listChannels() {
  return Object.values(db.channels);
}

function listOffers() {
  return Object.values(db.offers);
}

function getBloggerById(bloggerId) {
  return db.bloggers[String(bloggerId || "").trim()] || null;
}

function getChannelById(channelId) {
  return db.channels[String(channelId || "").trim()] || null;
}

function getChannelByChatId(chatId) {
  const target = Number(chatId || 0);
  if (!target) return null;
  return listChannels().find((item) => Number(item.chatId || 0) === target) || null;
}

function listChannelsForBlogger(bloggerId) {
  return listChannels()
    .filter((channel) => String(channel?.bloggerId || "") === String(bloggerId || ""))
    .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
}

function getChannelForBlogger(bloggerId) {
  const blogger = getBloggerById(bloggerId);
  if (!blogger?.channelId) return null;
  const direct = getChannelById(blogger.channelId);
  if (direct) return direct;
  const channels = listChannelsForBlogger(blogger?.id);
  return channels[0] || null;
}

function getSessionByToken(token) {
  return db.authSessions[String(token || "").trim()] || null;
}

function getLatestAwaitingSessionForUser(userId) {
  const target = String(userId || "").trim();
  if (!target) return null;

  let latest = null;
  for (const row of Object.values(db.authSessions)) {
    if (row?.status !== "awaiting_channel") continue;
    const tgUserId = String(row?.tgUserId || "").trim();
    const bloggerId = String(row?.bloggerId || "").trim();
    if (tgUserId !== target && bloggerId !== target) continue;
    if (!latest || Number(row.createdAt || 0) > Number(latest.createdAt || 0)) {
      latest = row;
    }
  }
  return latest;
}

function ensureConnectedContext(token) {
  const session = getSessionByToken(token);
  if (!session || session.status !== "connected") return null;
  const blogger = getBloggerById(session.bloggerId);
  if (!blogger) return null;
  const channel = getChannelForBlogger(blogger.id);
  return { session, blogger, channel };
}

function toChannelDto(channel, blogger) {
  return {
    key: channel?.username ? `@${channel.username}` : `channel_${channel?.id || "new"}`,
    title: channel?.title || "Канал не выбран",
    username: channel?.username || "",
    status: channel?.botConnected ? "ready" : "bot_not_connected",
    postingMode: normalizeMode(channel?.postingMode || "auto_with_precheck"),
    weeklyPostLimit: Number(channel?.weeklyPostLimit || 21),
    scheduleSlots: channel?.scheduleSlots?.length ? channel.scheduleSlots : buildDefaultScheduleSlots(),
    blogger: {
      tgUsername: blogger?.tgUsername || null
    },
    botConnected: Boolean(channel?.botConnected),
    botMemberStatus: channel?.botMemberStatus || "unknown"
  };
}

function toOfferDto(offer) {
  const status = String(offer?.status || "");
  const publicationState =
    status === "rewarded"
      ? "published"
      : status === "auto_publish_error" ||
          status === "archived_not_published" ||
          status === "declined_by_blogger" ||
          status === "cancelled_by_advertiser" ||
          status === "cancelled_by_blogger" ||
          status === "expired"
        ? "not_published"
        : null;

  return {
    id: offer.id,
    bloggerId: offer.bloggerId,
    bloggerUsername: offer.bloggerUsername,
    status,
    statusTitle: statusTitle(status),
    mode: offer.modeAtCreation,
    modeTitle: modeTitle(offer.modeAtCreation),
    scheduledAt: offer.scheduledAt,
    scheduledAtText: formatDateTime(offer.scheduledAt),
    cpv: offer.cpv,
    estimatedIncome: offer.estimatedIncome,
    text: offer.textRaw,
    channelId: offer.channelId,
    declineReason: offer.bloggerDeclineReason || null,
    publicationState,
    publicationStateTitle: publicationState === "published" ? "Опубликовано" : publicationState === "not_published" ? "Не опубликовано" : null
  };
}

function listPlannedOffersForBlogger(bloggerId) {
  const now = Date.now();
  return listOffers()
    .filter((offer) => {
      if (!isOfferActive(offer)) return false;
      if (String(offer.bloggerId) !== String(bloggerId || "")) return false;

      const status = String(offer.status || "");
      const scheduledAt = Number(offer.scheduledAt || 0);
      const isDeadlineStatus =
        status === "pending_precheck" ||
        status === "pending_approval" ||
        status === "scheduled";
      if (isDeadlineStatus && Number.isFinite(scheduledAt) && scheduledAt < now) return false;
      return true;
    })
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .map(toOfferDto);
}

function listArchiveOffersForBlogger(bloggerId) {
  return listOffers()
    .filter((offer) => String(offer.bloggerId) === String(bloggerId || ""))
    .filter((offer) => !isOfferActive(offer))
    .sort((a, b) => Number(b.scheduledAt || 0) - Number(a.scheduledAt || 0))
    .map(toOfferDto);
}

function listAllOffersForAdvertiser() {
  return listOffers().sort((a, b) => b.id - a.id).map(toOfferDto);
}

function listConnectedBloggersForAdvertiser() {
  return listBloggers().map((blogger) => {
    const channel = getChannelForBlogger(blogger.id);
    return {
      id: blogger.id,
      tgUsername: blogger.tgUsername,
      tgUserId: blogger.tgUserId,
      chatId: blogger.chatId,
      connectedAt: blogger.connectedAt,
      channel: channel
        ? {
            id: channel.id,
            title: channel.title,
            username: channel.username,
            postingMode: normalizeMode(channel.postingMode),
            weeklyPostLimit: channel.weeklyPostLimit,
            botConnected: Boolean(channel.botConnected)
          }
        : null
    };
  }).sort((a, b) => b.connectedAt - a.connectedAt);
}

function listConnectedChannelsForAdvertiser() {
  return listChannels()
    .map((channel) => {
      const blogger = getBloggerById(channel.bloggerId);
      if (!blogger) return null;
      return {
        id: channel.id,
        title: channel.title || "",
        username: channel.username || "",
        chatId: channel.chatId || null,
        postingMode: normalizeMode(channel.postingMode),
        postingModeTitle: modeTitle(channel.postingMode),
        weeklyPostLimit: Number(channel.weeklyPostLimit || 21),
        scheduleSlots: Array.isArray(channel.scheduleSlots) ? channel.scheduleSlots : [],
        botConnected: Boolean(channel.botConnected),
        botMemberStatus: channel.botMemberStatus || "unknown",
        blogger: {
          id: blogger.id,
          tgUserId: blogger.tgUserId || null,
          tgUsername: blogger.tgUsername || null,
          connectedAt: blogger.connectedAt || 0
        }
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b?.blogger?.connectedAt || 0) - Number(a?.blogger?.connectedAt || 0));
}

function stateSnapshotForToken(token) {
  const ctx = ensureConnectedContext(token);
  return {
    bot: {
      enabled: botState.enabled,
      username: botState.username,
      lastError: botState.lastError,
      delivery: botState.delivery,
      webhookUrl: botState.webhookUrl
    },
    channels: ctx ? [toChannelDto(ctx.channel, ctx.blogger)] : [],
    plannedPosts: ctx ? listPlannedOffersForBlogger(ctx.blogger.id) : [],
    archivePosts: ctx ? listArchiveOffersForBlogger(ctx.blogger.id) : []
  };
}

function advertiserSnapshot() {
  return {
    bloggers: listConnectedBloggersForAdvertiser(),
    channels: listConnectedChannelsForAdvertiser(),
    offers: listAllOffersForAdvertiser()
  };
}

function adminSnapshot() {
  const bloggers = listBloggers().map((blogger) => {
    const channel = getChannelForBlogger(blogger.id);
    const offers = listOffers().filter((offer) => String(offer.bloggerId) === String(blogger.id));
    return {
      id: blogger.id,
      tgUsername: blogger.tgUsername,
      tgUserId: blogger.tgUserId,
      chatId: blogger.chatId,
      connectedAt: blogger.connectedAt,
      totalOffers: offers.length,
      activeOffers: offers.filter((offer) => isOfferActive(offer)).length,
      channel: channel
        ? {
            id: channel.id,
            chatId: channel.chatId,
            title: channel.title,
            username: channel.username,
            postingMode: normalizeMode(channel.postingMode),
            postingModeTitle: modeTitle(channel.postingMode),
            weeklyPostLimit: channel.weeklyPostLimit,
            scheduleSlotsCount: Array.isArray(channel.scheduleSlots) ? channel.scheduleSlots.length : 0,
            scheduleSlots: Array.isArray(channel.scheduleSlots) ? channel.scheduleSlots : [],
            botConnected: Boolean(channel.botConnected),
            botMemberStatus: channel.botMemberStatus || "unknown"
          }
        : null
    };
  }).sort((a, b) => b.connectedAt - a.connectedAt);

  return {
    bot: {
      enabled: botState.enabled,
      username: botState.username,
      userId: botState.userId,
      lastError: botState.lastError,
      webhookUrl: botState.webhookUrl
    },
    totals: {
      bloggers: bloggers.length,
      channels: listChannels().length,
      offers: listOffers().length,
      activeOffers: listOffers().filter((offer) => isOfferActive(offer)).length
    },
    bloggers,
    offers: listAllOffersForAdvertiser()
  };
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/auth.html";
  if (pathname === "/cpvdemo" || pathname === "/cpvdemo/") pathname = "/index.html";
  if (pathname === "/cpvdemo/auth" || pathname === "/cpvdemo/auth/") pathname = "/auth.html";
  if (pathname === "/cpvdemo/advertiser" || pathname === "/cpvdemo/advertiser/") pathname = "/advertiser.html";
  if (pathname === "/cpvdemo/admin" || pathname === "/cpvdemo/admin/") pathname = "/admin.html";
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
    await tgApiWithRetry("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text ? String(text) : undefined
    });
  } catch (err) {
    botState.lastError = formatError(err);
  }
}

async function sendBotMessage(chatId, text, replyMarkup, options) {
  if (!chatId) return null;
  try {
    const payload = {
      chat_id: chatId,
      text: String(text || ""),
      reply_markup: replyMarkup || undefined,
      parse_mode: options?.parseMode || undefined
    };
    if (Number.isInteger(Number(options?.replyToMessageId)) && Number(options.replyToMessageId) > 0) {
      payload.reply_to_message_id = Number(options.replyToMessageId);
    }
    return await tgApiWithRetry("sendMessage", payload);
  } catch (err) {
    botState.lastError = formatError(err);
    console.warn(`Bot sendMessage failed: ${botState.lastError}`);
    return null;
  }
}

async function editBotMessage(chatId, messageId, text, replyMarkup, options) {
  if (!chatId || !messageId) return null;
  try {
    return await tgApiWithRetry("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: String(text || ""),
      reply_markup: replyMarkup || undefined,
      parse_mode: options?.parseMode || undefined
    });
  } catch (err) {
    const message = String(err?.message || "").toLowerCase();
    if (message.includes("message is not modified")) return null;
    botState.lastError = formatError(err);
    return null;
  }
}

function buildChannelRequestKeyboard() {
  const requiredUserRights = {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
    can_post_messages: true,
    can_edit_messages: false,
    can_manage_direct_messages: false
  };

  const requiredBotRights = {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
    can_post_messages: true,
    can_edit_messages: false,
    can_manage_direct_messages: false
  };

  return {
    keyboard: [[{
      text: "Выбрать канал",
      request_chat: {
        request_id: 1,
        chat_is_channel: true,
        user_administrator_rights: requiredUserRights,
        bot_administrator_rights: requiredBotRights,
        request_title: true,
        request_username: true
      }
    }]],
    one_time_keyboard: true,
    resize_keyboard: true
  };
}

function removeKeyboardMarkup() {
  return { remove_keyboard: true };
}

function markSessionsAwaitingChannelForBlogger(bloggerId) {
  let changed = false;
  const now = Date.now();
  for (const row of Object.values(db.authSessions)) {
    if (String(row?.bloggerId || "") !== String(bloggerId || "")) continue;
    if (row.status === "expired") continue;
    if (row.status === "connected") continue;
    row.status = "awaiting_channel";
    row.connectedAt = now;
    row.error = null;
    changed = true;
  }
  if (changed) saveDb(db);
}

function markSessionsConnectedForBlogger(bloggerId) {
  let changed = false;
  const now = Date.now();
  for (const row of Object.values(db.authSessions)) {
    if (String(row?.bloggerId || "") !== String(bloggerId || "")) continue;
    if (row.status === "expired") continue;
    row.status = "connected";
    row.connectedAt = now;
    row.error = null;
    changed = true;
  }
  if (changed) saveDb(db);
}

async function hydrateChannelFromTelegram(channel) {
  if (!channel?.chatId) return;

  try {
    const chat = await tgApi("getChat", { chat_id: channel.chatId });
    channel.title = String(chat?.title || channel.title || "");
    channel.username = String(chat?.username || channel.username || "");
  } catch {
    // ignore
  }

  if (!botState.userId) {
    channel.botConnected = false;
    channel.botMemberStatus = "unknown";
    return;
  }

  try {
    const member = await tgApi("getChatMember", {
      chat_id: channel.chatId,
      user_id: botState.userId
    });
    const status = String(member?.status || "unknown");
    channel.botMemberStatus = status;
    const canPostInChannel =
      status === "creator" ||
      (status === "administrator" && member?.can_post_messages !== false);
    channel.botConnected = Boolean(canPostInChannel);
  } catch {
    channel.botConnected = false;
    channel.botMemberStatus = "unknown";
  }
}

function upsertBlogger(userId, username, privateChatId) {
  const id = String(userId || "").trim();
  if (!id) return null;

  const existing = getBloggerById(id);
  const row = {
    id,
    tgUserId: userId || null,
    tgUsername: String(username || existing?.tgUsername || `blogger_${id}`),
    chatId: Number(privateChatId || existing?.chatId || 0) || null,
    connectedAt: Date.now(),
    channelId: existing?.channelId || null
  };
  db.bloggers[id] = row;
  saveDb(db);
  return row;
}

function ensureChannelForBlogger(blogger, chatId, title, username) {
  const targetChatId = Number(chatId);
  let channel = listChannelsForBlogger(blogger?.id).find((item) => Number(item?.chatId || 0) === targetChatId) || null;
  if (!channel) {
    channel = blogger.channelId ? getChannelById(blogger.channelId) : null;
  }

  if (channel && Number(channel.chatId || 0) !== targetChatId) {
    channel = null;
  }

  if (!channel) {
    const id = String(db.meta.nextChannelId++);
    channel = {
      id,
      bloggerId: blogger.id,
      chatId: targetChatId,
      title: String(title || ""),
      username: String(username || ""),
      postingMode: "auto_with_precheck",
      weeklyPostLimit: 21,
      scheduleSlots: buildDefaultScheduleSlots(),
      botConnected: false,
      botMemberStatus: "unknown",
      autoPausedUntilAt: null,
      autoPauseMessageId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  } else {
    channel.chatId = targetChatId;
    if (title) channel.title = String(title);
    if (username) channel.username = String(username);
    channel.updatedAt = Date.now();
  }

  db.channels[channel.id] = channel;
  blogger.channelId = channel.id;
  db.bloggers[blogger.id] = blogger;
  saveDb(db);
  return channel;
}

function channelLabel(channel) {
  if (!channel) return "Канал";
  if (channel.username) return `@${channel.username}`;
  if (channel.title) return channel.title;
  return `канал ${channel.id || ""}`.trim();
}

function channelModeStatusLine(channel) {
  const pausePart = modeSupportsPause(channel?.postingMode) && isChannelAutoPaused(channel)
    ? `, пауза до ${formatDateTimeHumanRu(channel.autoPausedUntilAt)}`
    : "";
  return `• ${channelLabel(channel)} — ${modeButtonTitle(channel?.postingMode)}${pausePart}`;
}

function channelPauseStatusLine(channel) {
  if (!modeSupportsPause(channel?.postingMode)) {
    return `• ${channelLabel(channel)} — ${modeButtonTitle(channel?.postingMode)}, пауза недоступна`;
  }
  return `• ${channelLabel(channel)} — ${modeButtonTitle(channel?.postingMode)}, ${
    isChannelAutoPaused(channel) ? `на паузе до ${formatDateTimeHumanRu(channel.autoPausedUntilAt)}` : "публикации активны"
  }`;
}

function buildChannelPickerKeyboard(prefix, channels) {
  const rows = [];
  for (const channel of channels) {
    rows.push([{ text: channelLabel(channel), callback_data: `${prefix}:ch:${channel.id}` }]);
  }
  return { inline_keyboard: rows };
}

function buildPauseKeyboard(channel, withBack) {
  const rows = [];
  if (modeSupportsPause(channel?.postingMode)) {
    if (isChannelAutoPaused(channel)) {
      rows.push([{ text: "▶️ Возобновить", callback_data: `pause:set:${channel.id}:resume` }]);
    } else {
      rows.push([{ text: "⏸ Пауза 24 часа", callback_data: `pause:set:${channel.id}:24h` }]);
    }
  }
  if (withBack) {
    rows.push([{ text: "⬅ Каналы", callback_data: "pause:list" }]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

function buildModeKeyboardForChannel(channel, withBack) {
  const rows = [];
  const currentMode = normalizeMode(channel?.postingMode || "auto_with_precheck");
  for (const mode of POSTING_MODES) {
    const mark = currentMode === mode ? "✅ " : "";
    rows.push([{ text: `${mark}${modeButtonTitle(mode)}`, callback_data: `mode:set:${channel.id}:${mode}` }]);
  }
  if (withBack) {
    rows.push([{ text: "⬅ Каналы", callback_data: "mode:list" }]);
  }
  return { inline_keyboard: rows };
}

function buildModeTextForChannel(channel, channels, withStatuses) {
  const lines = [];
  lines.push(`<b>Канал:</b> ${channelLabel(channel)}`);
  lines.push(`<b>Текущий режим:</b> ${modeTitle(channel?.postingMode || "auto_with_precheck")}`);
  if (modeSupportsPause(channel?.postingMode) && isChannelAutoPaused(channel)) {
    lines.push(`<b>Пауза активна до:</b> ${formatDateTimeHumanRu(channel.autoPausedUntilAt)}`);
  }
  lines.push("");
  lines.push("<b>Как работают режимы:</b>");
  lines.push("• Авто — тихий режим: новые офферы не приходят в личку. При необходимости поставьте паузу на 24 часа через /pause.");
  lines.push("• Предпросмотр — бот присылает оффер заранее: можно подтвердить, выбрать другое время или отклонить.");
  lines.push("• Подтверждение — пост выйдет только после вашего подтверждения.");
  lines.push("• Ручная — получаете ERID и публикуете вручную.");
  lines.push("");
  lines.push("Выберите режим публикации:");
  if (withStatuses) {
    lines.push("");
    lines.push("<b>Статусы каналов:</b>");
    for (const item of channels) lines.push(channelModeStatusLine(item));
  }
  return lines.join("\n");
}

function getReservedSlots(exceptOfferId, bloggerId) {
  const set = new Set();
  for (const offer of listOffers()) {
    if (offer.id === exceptOfferId) continue;
    if (String(offer.bloggerId) !== String(bloggerId)) continue;
    if (!isOfferActive(offer)) continue;
    set.add(Number(offer.scheduledAt));
  }
  return set;
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

function buildOfferDatePages(offer) {
  const channel = getChannelById(offer.channelId);
  const availabilityFromAt = Number(offer?.availabilityFromAt);
  const availabilityToAt = Number(offer?.availabilityToAt);

  let slots;
  if (
    Number.isFinite(availabilityFromAt) &&
    Number.isFinite(availabilityToAt) &&
    availabilityToAt >= availabilityFromAt
  ) {
    slots = buildSlotsInRange(channel, availabilityFromAt, availabilityToAt).map((ts) => ({
      ts,
      dateKey: dateKeyFromTs(ts),
      dateLabel: formatDateLabel(ts),
      timeLabel: formatTimeLabel(ts)
    }));
  } else {
    const scheduleSlots = channel?.scheduleSlots?.length ? channel.scheduleSlots : buildDefaultScheduleSlots();
    slots = buildUpcomingScheduleSlots(scheduleSlots, 14);
  }

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

function getOfferUiState(offer) {
  const raw = String(offer?.uiState || "main");
  if (!isOfferAwaitingDecision(offer)) return "main";
  if (raw === "pick_time") return raw;
  return "main";
}

function offerChannelLabel(offer) {
  const channel = getChannelById(offer?.channelId);
  if (channel?.username) return `@${channel.username}`;
  if (channel?.title) return channel.title;
  return `ID ${channel?.chatId || "unknown"}`;
}

function buildOfferKeyboard(offer, pageFromCallback) {
  if (!isOfferActive(offer)) return null;

  const uiState = getOfferUiState(offer);
  const rows = [];

  if (uiState === "pick_time") {
    const pages = buildOfferDatePages(offer);
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
    } else {
      rows.push([{ text: "Нет доступных слотов", callback_data: `of:pd:${offer.id}:0` }]);
    }

    rows.push([{ text: "⬅ Назад", callback_data: `of:tb:${offer.id}` }]);
    return rows.length ? { inline_keyboard: rows } : null;
  }

  if (offer.status === "pending_precheck" || offer.status === "pending_approval") {
    rows.push([{ text: "✅ Подтвердить", callback_data: `of:ap:${offer.id}` }]);
    rows.push([{ text: "🕒 Выбрать другое время", callback_data: `of:tm:${offer.id}` }]);
    rows.push([{ text: "❌ Отклонить", callback_data: `of:dr:${offer.id}` }]);
  } else if (offer.status === "pending_manual_posting") {
    rows.push([{ text: "🏷 Получить ERID", callback_data: `of:me:${offer.id}` }]);
    rows.push([{ text: "🕒 Выбрать другое время", callback_data: `of:tm:${offer.id}` }]);
    rows.push([{ text: "❌ Отклонить", callback_data: `of:dr:${offer.id}` }]);
  } else if (offer.status === "manual_waiting_publication") {
    rows.push([{ text: "✅ Добавил в очередь постинга", callback_data: `of:mq:${offer.id}` }]);
    rows.push([{ text: "🚫 Не публиковать", callback_data: `of:bc:${offer.id}` }]);
  } else if (offer.status === "manual_queued_publication") {
    rows.push([{ text: "🚫 Не публиковать", callback_data: `of:bc:${offer.id}` }]);
  } else if (offer.status === "scheduled") {
    rows.push([{ text: "🚫 Отказаться", callback_data: `of:bc:${offer.id}` }]);
  }

  return rows.length ? { inline_keyboard: rows } : null;
}

function offerSummaryText(offer) {
  const uiState = getOfferUiState(offer);
  const channelLabel = offerChannelLabel(offer);
  const whenText = formatDateTimeHumanRu(offer.scheduledAt);

  if (uiState === "pick_time") {
    return [
      `Подберите другое время для поста в канале ${channelLabel}`,
      "",
      `Текущее время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`,
      "",
      "Выберите слот ниже или нажмите «Назад»."
    ].join("\n");
  }

  if (offer.status === "pending_precheck") {
    return [
      "В вашем канале запланирован пост с оплатой за просмотры:",
      "",
      `Время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`
    ].join("\n");
  }

  if (offer.status === "pending_approval") {
    return [
      `Подтвердите размещение поста в канале ${channelLabel}`,
      "",
      `Время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`,
      "",
      "Подтвердите пост, чтобы не упустить свой доход!"
    ].join("\n");
  }

  if (offer.status === "pending_manual_posting") {
    return [
      `Предложение публикации в канале ${channelLabel}`,
      "",
      `Время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`,
      "",
      "Если вы хотите взять это размещение в работу, нажмите «Получить ERID»."
    ].join("\n");
  }

  if (offer.status === "manual_waiting_publication") {
    return [
      `Ожидаем публикацию в канале ${channelLabel}`,
      "",
      `Время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`,
      `ERID: ${offer.eridTag || `demo-${offer.id}`}`
    ].join("\n");
  }

  if (offer.status === "manual_queued_publication") {
    return [
      `Пост добавлен в очередь публикации в канале ${channelLabel}`,
      "",
      `Время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`,
      `ERID: ${offer.eridTag || `demo-${offer.id}`}`,
      "Спасибо, ждём выхода публикации."
    ].join("\n");
  }

  if (offer.status === "manual_publication_found") {
    return [
      `Публикация в канале ${channelLabel} найдена`,
      "",
      `Время: ${whenText}`,
      `CPM: ${offer.cpv} рублей, прогноз дохода ${offer.estimatedIncome} рублей`,
      `ERID: ${offer.eridTag || `demo-${offer.id}`}`,
      `Ожидаем ${manualHoldDurationText()} до начисления.`
    ].join("\n");
  }

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
    lines.push(`Если не отклоните до ${formatDateTime(offer.decisionDeadlineAt || Date.now())}, пост выйдет автоматически.`);
  }
  if (offer.status === "pending_approval") {
    lines.push("Пост выйдет только после подтверждения.");
  }
  if (offer.status === "pending_manual_posting") {
    lines.push("После принятия пришлю промаркированный текст для ручной публикации.");
  }

  return lines.join("\n");
}

function buildManualPendingReminderText(offer, isLastReminder) {
  const lines = [
    `Оффер #${offer.id}: размещение в запланированное время не состоялось, но оффер всё ещё активен.`,
    "Вы можете выбрать другой слот в доступном периоде или получить ERID и опубликовать вручную."
  ];
  if (isLastReminder) {
    lines.push("");
    lines.push("Это последнее напоминание по этому офферу.");
    lines.push("Далее оффер останется активным до конца доступного периода без дополнительных уведомлений.");
  }
  return lines.join("\n");
}

function buildManualPendingReminderKeyboard(offer) {
  return {
    inline_keyboard: [
      [{ text: "🕒 Выбрать другое время", callback_data: `of:tm:${offer.id}` }],
      [{ text: "🏷 Получить ERID", callback_data: `of:me:${offer.id}` }],
      [{ text: "❌ Отклонить", callback_data: `of:dr:${offer.id}` }]
    ]
  };
}

async function upsertOfferMessage(offer, pageFromCallback) {
  if (offer?.modeAtCreation === "auto") return;
  if (!offer.chatId) return;

  if (!offer.adMessageId) {
    const adSent = await sendBotMessage(offer.chatId, offer.textRaw);
    if (adSent?.message_id) {
      offer.adMessageId = adSent.message_id;
      db.offers[String(offer.id)] = offer;
      saveDb(db);
    }
  }

  const text = offerSummaryText(offer);
  const keyboard = buildOfferKeyboard(offer, pageFromCallback);

  if (offer.messageId) {
    const edited = await editBotMessage(offer.chatId, offer.messageId, text, keyboard);
    if (edited) return;
  }

  const sent = await sendBotMessage(offer.chatId, text, keyboard, {
    replyToMessageId: Number(offer.adMessageId || 0) || undefined
  });
  if (sent?.message_id) {
    offer.messageId = sent.message_id;
    db.offers[String(offer.id)] = offer;
    saveDb(db);
  }
}

function pickAdText() {
  return DEMO_AD_TEXTS[Math.floor(Math.random() * DEMO_AD_TEXTS.length)];
}

function countActiveOffersForBlogger(bloggerId) {
  return listOffers().filter((offer) => String(offer.bloggerId) === String(bloggerId) && isOfferActive(offer)).length;
}

function createOffer({ blogger, channel, scheduledAt, dateFrom, dateTo, textRaw, cpv }) {
  const mode = normalizeMode(channel.postingMode);
  const id = db.meta.nextOfferId++;

  const adText = String(textRaw || "").trim() || pickAdText();
  const valueCpv = Number.isFinite(Number(cpv)) ? Math.max(100, Math.round(Number(cpv))) : 900;
  const estimatedIncome = Math.round(valueCpv * 0.85);

  const status = mode === "auto"
    ? "scheduled"
    : mode === "auto_with_precheck"
      ? "pending_precheck"
      : mode === "manual_approval"
        ? "pending_approval"
        : "pending_manual_posting";

  const offer = {
    id,
    createdAt: Date.now(),
    scheduledAt,
    availabilityFromAt: Number(dateFrom),
    availabilityToAt: Number(dateTo),
    modeAtCreation: mode,
    status,
    cpv: valueCpv,
    estimatedIncome,
    textRaw: adText,
    textMarked: buildMarkedAdText(adText, `demo-${id}`),
    eridTag: `demo-${id}`,
    decisionDeadlineAt: status === "pending_precheck" ? Math.min(scheduledAt, Date.now() + PRECHECK_DECISION_MS) : null,
    selectedDatePage: 0,
    uiState: "main",
    bloggerDeclineReason: null,
    manualReminderCount: 0,
    manualReminderSentAt: null,
    adMessageId: null,
    bloggerId: blogger.id,
    bloggerUsername: blogger.tgUsername,
    chatId: blogger.chatId,
    channelId: channel.id,
    messageId: null
  };

  db.offers[String(id)] = offer;
  saveDb(db);
  return offer;
}

function buildSlotsInRange(channel, dateFrom, dateTo) {
  const from = Number(dateFrom);
  const to = Number(dateTo);
  const out = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return out;

  const start = new Date(from);
  const end = new Date(to);
  const current = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  const schedule = channel?.scheduleSlots?.length ? channel.scheduleSlots : buildDefaultScheduleSlots();

  while (current <= endDay) {
    const day = dayOfWeekMonFirst(current);
    for (const slot of schedule) {
      if (slot.day !== day) continue;
      const dt = new Date(current.getFullYear(), current.getMonth(), current.getDate(), slot.hour, 0, 0, 0);
      const ts = dt.getTime();
      if (ts < from || ts > to) continue;
      if (ts <= Date.now() + 30_000) continue;
      out.push(ts);
    }
    current.setDate(current.getDate() + 1);
  }

  return out.sort((a, b) => a - b);
}

function pickScheduledTimeForBlogger(channel, bloggerId, dateFrom, dateTo, index) {
  const reserved = getReservedSlots(null, bloggerId);
  const slots = buildSlotsInRange(channel, dateFrom, dateTo).filter((ts) => !reserved.has(ts));
  if (!slots.length) return null;
  const idx = clamp(index, 0, slots.length - 1);
  return slots[idx];
}

async function notifyOfferCreated(offer) {
  if (offer.modeAtCreation === "auto") {
    return;
  }
  await upsertOfferMessage(offer, 0);
}

async function approveOffer(offer, reasonText) {
  offer.status = "scheduled";
  offer.decisionDeadlineAt = null;
  offer.uiState = "main";
  db.offers[String(offer.id)] = offer;
  saveDb(db);
  await upsertOfferMessage(offer);
  if (reasonText) await sendBotMessage(offer.chatId, reasonText);
}

async function declineOfferByBlogger(offer) {
  offer.status = "declined_by_blogger";
  offer.decisionDeadlineAt = null;
  offer.uiState = "main";
  offer.bloggerDeclineReason = null;
  db.offers[String(offer.id)] = offer;
  saveDb(db);
  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, `Оффер #${offer.id} отклонён.`);
}

async function cancelOfferByBlogger(offer) {
  offer.status = "cancelled_by_blogger";
  offer.decisionDeadlineAt = null;
  offer.uiState = "main";
  db.offers[String(offer.id)] = offer;
  saveDb(db);
  await upsertOfferMessage(offer);
  await sendBotMessage(offer.chatId, `Публикация по офферу #${offer.id} отменена.`);
}

async function cancelOfferByAdvertiser(offer) {
  offer.status = "cancelled_by_advertiser";
  offer.decisionDeadlineAt = null;
  offer.uiState = "main";
  db.offers[String(offer.id)] = offer;
  saveDb(db);
  await upsertOfferMessage(offer);
  if (offer.modeAtCreation !== "auto") {
    await sendBotMessage(offer.chatId, `Рекламодатель отменил оффер #${offer.id}. Публикация не состоится.`);
  }
}

async function acceptManualPostingOffer(offer) {
  offer.status = "scheduled";
  offer.decisionDeadlineAt = null;
  offer.uiState = "main";
  db.offers[String(offer.id)] = offer;
  saveDb(db);
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
  if (!Number.isFinite(slotTs) || !canUseSlot(offer, slotTs)) return false;
  offer.scheduledAt = slotTs;
  if (offer.status === "pending_precheck") {
    offer.decisionDeadlineAt = Math.min(slotTs, Date.now() + PRECHECK_DECISION_MS);
  }
  offer.uiState = "main";
  db.offers[String(offer.id)] = offer;
  saveDb(db);
  await upsertOfferMessage(offer);
  return true;
}

function buildAutoPublishText(offer) {
  const marked = String(offer?.textMarked || "").trim();
  if (marked) return marked;
  return buildMarkedAdText(offer?.textRaw, offer?.eridTag || `demo-${offer?.id || "unknown"}`);
}

async function publishOfferToChannel(offer) {
  const channel = getChannelById(offer?.channelId);
  if (!channel?.chatId) return null;
  if (!channel.botConnected) return null;
  return sendBotMessage(channel.chatId, buildAutoPublishText(offer));
}

async function processOfferDeadlines() {
  if (offerTickInFlight) return;
  offerTickInFlight = true;

  try {
    const now = Date.now();
    for (const offer of listOffers()) {
      if (offer.status === "pending_precheck" && now >= Number(offer.decisionDeadlineAt || 0)) {
        await approveOffer(offer, `Оффер #${offer.id} автоматически подтверждён: до дедлайна не было отклонения.`);
        continue;
      }

      if (offer.status === "pending_approval" && now >= Number(offer.scheduledAt)) {
        offer.status = "archived_not_published";
        offer.decisionDeadlineAt = null;
        offer.uiState = "main";
        db.offers[String(offer.id)] = offer;
        saveDb(db);
        upsertOfferMessage(offer).catch(() => {});
        sendBotMessage(offer.chatId, `Оффер #${offer.id} не подтверждён вовремя. Публикация перенесена в архив.`).catch(() => {});
        continue;
      }

      if (offer.status === "pending_manual_posting" && now >= Number(offer.scheduledAt)) {
        const windowToAt = Number(offer.availabilityToAt || offer.scheduledAt || 0);
        if (Number.isFinite(windowToAt) && now > windowToAt) {
          offer.status = "archived_not_published";
          offer.decisionDeadlineAt = null;
          offer.uiState = "main";
          db.offers[String(offer.id)] = offer;
          saveDb(db);
          upsertOfferMessage(offer).catch(() => {});
          sendBotMessage(
            offer.chatId,
            `Оффер #${offer.id}: срок размещения завершился, публикация не выполнена. Оффер перенесён в архив.`
          ).catch(() => {});
          continue;
        }

        const hasFutureSlots = buildOfferDatePages(offer).some((page) => Array.isArray(page?.slots) && page.slots.length > 0);
        if (!hasFutureSlots) {
          offer.status = "archived_not_published";
          offer.decisionDeadlineAt = null;
          offer.uiState = "main";
          db.offers[String(offer.id)] = offer;
          saveDb(db);
          upsertOfferMessage(offer).catch(() => {});
          sendBotMessage(
            offer.chatId,
            `Оффер #${offer.id}: в доступном периоде больше нет свободных слотов. Оффер перенесён в архив.`
          ).catch(() => {});
          continue;
        }

        const reminderCount = Number.isInteger(Number(offer.manualReminderCount)) ? Number(offer.manualReminderCount) : 0;
        const lastReminderAt = Number.isFinite(Number(offer.manualReminderSentAt)) ? Number(offer.manualReminderSentAt) : 0;
        const shouldSendReminder = reminderCount < MANUAL_PENDING_REMINDER_MAX &&
          (reminderCount === 0 || now - lastReminderAt >= MANUAL_PENDING_REMINDER_INTERVAL_MS);

        if (shouldSendReminder) {
          offer.manualReminderCount = reminderCount + 1;
          offer.manualReminderSentAt = now;
          offer.uiState = "main";
          db.offers[String(offer.id)] = offer;
          saveDb(db);
          upsertOfferMessage(offer).catch(() => {});
          const isLastReminder = offer.manualReminderCount >= MANUAL_PENDING_REMINDER_MAX;
          sendBotMessage(
            offer.chatId,
            buildManualPendingReminderText(offer, isLastReminder),
            buildManualPendingReminderKeyboard(offer)
          ).catch(() => {});
        }
        continue;
      }

      if (
        (offer.status === "manual_waiting_publication" || offer.status === "manual_queued_publication") &&
        now >= Number(offer.scheduledAt)
      ) {
        offer.status = "archived_not_published";
        offer.uiState = "main";
        db.offers[String(offer.id)] = offer;
        saveDb(db);
        upsertOfferMessage(offer).catch(() => {});
        sendBotMessage(offer.chatId, `Оффер #${offer.id}: мы не нашли публикацию с ERID до времени выхода. Публикация перенесена в архив.`).catch(() => {});
        continue;
      }

      if (offer.status === "scheduled" && now >= Number(offer.scheduledAt)) {
        if (
          offer.modeAtCreation === "auto" ||
          offer.modeAtCreation === "auto_with_precheck" ||
          offer.modeAtCreation === "manual_approval"
        ) {
          const channelMessage = await publishOfferToChannel(offer);
          if (channelMessage?.message_id) {
            offer.status = "rewarded";
            offer.uiState = "main";
            offer.channelPostId = Number(channelMessage.message_id);
            db.offers[String(offer.id)] = offer;
            saveDb(db);
            upsertOfferMessage(offer).catch(() => {});
            sendBotMessage(offer.chatId, `Оффер #${offer.id} опубликован автоматически в канале.`).catch(() => {});
          } else {
            offer.status = "auto_publish_error";
            offer.uiState = "main";
            db.offers[String(offer.id)] = offer;
            saveDb(db);
            upsertOfferMessage(offer).catch(() => {});
            sendBotMessage(
              offer.chatId,
              `Оффер #${offer.id}: автопубликация не выполнена из-за ошибки. Публикация перенесена в архив.`
            ).catch(() => {});
          }
        } else if (offer.modeAtCreation === "manual_posting") {
          offer.status = "archived_not_published";
          offer.uiState = "main";
          db.offers[String(offer.id)] = offer;
          saveDb(db);
          upsertOfferMessage(offer).catch(() => {});
          sendBotMessage(
            offer.chatId,
            `Оффер #${offer.id}: ручная публикация не подтверждена в срок. Публикация перенесена в архив.`
          ).catch(() => {});
        }
        continue;
      }

      if (offer.status === "manual_publication_found") {
        const foundAt = Number(offer.manualPublicationFoundAt || 0);
        if (foundAt > 0 && now - foundAt >= MANUAL_PUBLICATION_HOLD_MS) {
          offer.status = "rewarded";
          offer.uiState = "main";
          db.offers[String(offer.id)] = offer;
          saveDb(db);
          upsertOfferMessage(offer).catch(() => {});
          sendBotMessage(offer.chatId, "Деньги за публикацию начислены, теперь её можно удалить.").catch(() => {});
        }
      }
    }
  } finally {
    offerTickInFlight = false;
  }
}

async function processAutoPauseExpirations() {
  const now = Date.now();
  let changed = false;

  for (const channel of listChannels()) {
    if (!modeSupportsPause(channel.postingMode)) {
      if (channel.autoPausedUntilAt || channel.autoPauseMessageId) {
        channel.autoPausedUntilAt = null;
        channel.autoPauseMessageId = null;
        db.channels[channel.id] = channel;
        changed = true;
      }
      continue;
    }

    const pauseUntilAt = Number(channel?.autoPausedUntilAt || 0);
    if (!Number.isFinite(pauseUntilAt) || pauseUntilAt <= 0) continue;
    if (pauseUntilAt > now) continue;

    const blogger = getBloggerById(channel.bloggerId);
    const chatId = Number(blogger?.chatId || 0);
    const replyToMessageId = Number(channel.autoPauseMessageId || 0) || undefined;

    channel.autoPausedUntilAt = null;
    channel.autoPauseMessageId = null;
    db.channels[channel.id] = channel;
    changed = true;

    if (chatId) {
      await sendBotMessage(
        chatId,
        "Пауза завершена, публикации снова активны.",
        buildPauseKeyboard(channel, false),
        { replyToMessageId }
      );
    }
  }

  if (changed) saveDb(db);
}

async function handleStartMessage(message) {
  const chatId = Number(message?.chat?.id || 0);
  const payload = parseStartPayload(message?.text);

  if (!payload) {
    await sendBotMessage(chatId, "Откройте ссылку авторизации из веб-интерфейса и нажмите Start ещё раз.");
    return;
  }

  markExpiredSessions();
  const session = getSessionByToken(payload);
  if (!session) {
    await sendBotMessage(chatId, "Ссылка авторизации не найдена. Запросите новую в интерфейсе.");
    return;
  }
  if (session.status === "expired") {
    await sendBotMessage(chatId, "Сессия авторизации истекла. Запросите новую ссылку.");
    return;
  }

  const tgUserId = message?.from?.id || null;
  const tgUsername = message?.from?.username || null;
  const blogger = upsertBlogger(tgUserId, tgUsername, chatId);
  if (!blogger) {
    await sendBotMessage(chatId, "Не удалось зафиксировать пользователя.");
    return;
  }

  session.status = "awaiting_channel";
  session.tgUserId = tgUserId;
  session.tgUsername = tgUsername;
  session.connectedAt = Date.now();
  session.error = null;
  session.bloggerId = blogger.id;
  db.authSessions[payload] = session;
  saveDb(db);

  markSessionsAwaitingChannelForBlogger(blogger.id);

  const sent = await sendBotMessage(
    chatId,
    "Авторизация успешна. Теперь выберите канал, где вы админ:",
    buildChannelRequestKeyboard()
  );

  if (!sent) {
    await sendBotMessage(
      chatId,
      "Не удалось отправить кнопку выбора канала. Отправьте /start еще раз."
    );
  }
}

async function handleChatSharedMessage(message) {
  const privateChatId = Number(message?.chat?.id || 0);
  const chatShared = message?.chat_shared;
  const channelChatId = Number(chatShared?.chat_id || 0);
  const fromId = String(message?.from?.id || "").trim();
  const messageTs = Number(message?.date || 0) * 1000;

  if (!fromId || !channelChatId) {
    await sendBotMessage(privateChatId, "Не удалось обработать выбранный канал.");
    return;
  }

  const awaitingSession = getLatestAwaitingSessionForUser(fromId);
  if (!awaitingSession) {
    await sendBotMessage(privateChatId, "Сессия выбора канала не активна. Откройте ссылку авторизации и отправьте /start еще раз.");
    return;
  }
  if (Number.isFinite(messageTs) && messageTs > 0 && messageTs + 2000 < Number(awaitingSession.createdAt || 0)) {
    await sendBotMessage(privateChatId, "Это устаревший выбор канала. Отправьте /start еще раз и повторите выбор.");
    return;
  }

  const blogger = getBloggerById(fromId);
  if (!blogger) {
    await sendBotMessage(privateChatId, "Сначала пройдите /start по ссылке из веба.");
    return;
  }

  const channel = ensureChannelForBlogger(
    blogger,
    channelChatId,
    chatShared?.title,
    chatShared?.username
  );

  markSessionsConnectedForBlogger(blogger.id);

  await hydrateChannelFromTelegram(channel);
  db.channels[channel.id] = channel;
  saveDb(db);

  if (!channel.botConnected) {
    await sendBotMessage(
      privateChatId,
      [
        `Канал подтверждён.`,
        `Добавьте бота @${botState.username || "bot"} в канал как администратора с правом публикации сообщений.`,
        "После этого возвращайтесь в личный кабинет и настройте график публикаций."
      ].join("\n"),
      removeKeyboardMarkup()
    );
    return;
  } else {
    await sendBotMessage(
      privateChatId,
      "Отлично, бот уже подключен к каналу. Настройка завершена, можете возвращаться в личный кабинет.",
      removeKeyboardMarkup()
    );
    return;
  }
}

function buildModeChooserPayload(blogger, selectedChannelId) {
  const channels = listChannelsForBlogger(blogger?.id);
  if (!channels.length) {
    return {
      text: "Сначала выберите канал через /start.",
      keyboard: null,
      parseMode: null
    };
  }

  const multi = channels.length > 1;
  if (!selectedChannelId && multi) {
    const lines = ["Выберите канал для настройки режима:", "", "<b>Статусы каналов:</b>"];
    for (const channel of channels) lines.push(channelModeStatusLine(channel));
    return {
      text: lines.join("\n"),
      keyboard: buildChannelPickerKeyboard("mode", channels),
      parseMode: "HTML"
    };
  }

  const selected = selectedChannelId
    ? channels.find((channel) => String(channel.id) === String(selectedChannelId))
    : channels[0];
  if (!selected) {
    return {
      text: "Канал не найден. Выберите канал заново.",
      keyboard: buildChannelPickerKeyboard("mode", channels),
      parseMode: null
    };
  }

  return {
    text: buildModeTextForChannel(selected, channels, multi),
    keyboard: buildModeKeyboardForChannel(selected, multi),
    parseMode: "HTML"
  };
}

function buildPauseChooserPayload(blogger, selectedChannelId) {
  const channels = listChannelsForBlogger(blogger?.id);
  if (!channels.length) {
    return {
      text: "Сначала выберите канал через /start.",
      keyboard: null,
      parseMode: null
    };
  }

  const multi = channels.length > 1;
  if (!selectedChannelId && multi) {
    const lines = ["Выберите канал для управления паузой:", "", "<b>Статусы каналов:</b>"];
    for (const channel of channels) lines.push(channelPauseStatusLine(channel));
    return {
      text: lines.join("\n"),
      keyboard: buildChannelPickerKeyboard("pause", channels),
      parseMode: "HTML"
    };
  }

  const selected = selectedChannelId
    ? channels.find((channel) => String(channel.id) === String(selectedChannelId))
    : channels[0];
  if (!selected) {
    return {
      text: "Канал не найден. Выберите канал заново.",
      keyboard: buildChannelPickerKeyboard("pause", channels),
      parseMode: null
    };
  }

  if (!modeSupportsPause(selected.postingMode)) {
    const lines = [
      `<b>Канал:</b> ${channelLabel(selected)}`,
      `Режим: ${modeTitle(selected.postingMode)}`,
      "Пауза доступна в режимах «Авто», «Предпросмотр» и «Подтверждение»."
    ];
    if (multi) {
      lines.push("", "<b>Статусы каналов:</b>");
      for (const channel of channels) lines.push(channelPauseStatusLine(channel));
    }
    return {
      text: lines.join("\n"),
      keyboard: multi ? { inline_keyboard: [[{ text: "⬅ Каналы", callback_data: "pause:list" }]] } : null,
      parseMode: "HTML"
    };
  }

  if (isChannelAutoPaused(selected)) {
    const lines = [
      `<b>Канал:</b> ${channelLabel(selected)}`,
      `⏸ Пауза установлена до ${formatDateTimeHumanRu(selected.autoPausedUntilAt)}.`
    ];
    if (multi) {
      lines.push("", "<b>Статусы каналов:</b>");
      for (const channel of channels) lines.push(channelPauseStatusLine(channel));
    }
    return {
      text: lines.join("\n"),
      keyboard: buildPauseKeyboard(selected, multi),
      parseMode: "HTML"
    };
  }

  const lines = [
    `<b>Канал:</b> ${channelLabel(selected)}`,
    "Автопубликации активны. Если нужно, включите паузу на 24 часа."
  ];
  if (multi) {
    lines.push("", "<b>Статусы каналов:</b>");
    for (const channel of channels) lines.push(channelPauseStatusLine(channel));
  }
  return {
    text: lines.join("\n"),
    keyboard: buildPauseKeyboard(selected, multi),
    parseMode: "HTML"
  };
}

async function sendModeChooser(chatId, blogger) {
  if (!blogger) {
    await sendBotMessage(chatId, "Сначала авторизуйтесь через /start и выберите канал.");
    return;
  }
  const payload = buildModeChooserPayload(blogger, null);
  await sendBotMessage(chatId, payload.text, payload.keyboard, {
    parseMode: payload.parseMode || undefined
  });
}

async function handleModeCallback(query, actionData) {
  const fromId = String(query?.from?.id || "").trim();
  const blogger = getBloggerById(fromId);
  if (!blogger) {
    await answerCallbackQuery(query.id, "Сначала авторизуйтесь через /start");
    return;
  }

  const channels = listChannelsForBlogger(blogger.id);
  if (!channels.length) {
    await answerCallbackQuery(query.id, "Сначала выберите канал");
    return;
  }

  const chatId = Number(query?.message?.chat?.id || 0);
  const messageId = Number(query?.message?.message_id || 0);
  const action = String(actionData || "").trim();

  const renderPanel = async (selectedChannelId) => {
    const payload = buildModeChooserPayload(blogger, selectedChannelId);
    if (chatId && messageId) {
      await editBotMessage(chatId, messageId, payload.text, payload.keyboard, {
        parseMode: payload.parseMode || undefined
      });
      return;
    }
    await sendBotMessage(blogger.chatId, payload.text, payload.keyboard, {
      parseMode: payload.parseMode || undefined
    });
  };

  if (action === "list") {
    await renderPanel(null);
    await answerCallbackQuery(query.id);
    return;
  }

  if (action.startsWith("ch:")) {
    const channelId = action.split(":")[1];
    await renderPanel(channelId || null);
    await answerCallbackQuery(query.id);
    return;
  }

  if (POSTING_MODES.includes(action)) {
    const channel = channels.find((item) => String(item.id) === String(blogger.channelId)) || channels[0];
    channel.postingMode = normalizeMode(action);
    if (!modeSupportsPause(channel.postingMode)) {
      channel.autoPausedUntilAt = null;
      channel.autoPauseMessageId = null;
    }
    channel.updatedAt = Date.now();
    db.channels[channel.id] = channel;
    saveDb(db);
    await answerCallbackQuery(query.id, `Режим: ${modeTitle(channel.postingMode)}`);
    await renderPanel(channel.id);
    return;
  }

  if (action.startsWith("set:")) {
    const [, channelId, modeRaw] = action.split(":");
    const channel = channels.find((item) => String(item.id) === String(channelId || ""));
    if (!channel) {
      await answerCallbackQuery(query.id, "Канал не найден");
      return;
    }
    const mode = normalizeMode(modeRaw);
    channel.postingMode = mode;
    if (!modeSupportsPause(channel.postingMode)) {
      channel.autoPausedUntilAt = null;
      channel.autoPauseMessageId = null;
    }
    channel.updatedAt = Date.now();
    db.channels[channel.id] = channel;
    saveDb(db);
    await answerCallbackQuery(query.id, `${channelLabel(channel)}: ${modeTitle(channel.postingMode)}`);
    await renderPanel(channel.id);
    return;
  }

  await answerCallbackQuery(query.id, "Неизвестное действие");
}

async function sendPauseChooser(chatId, blogger) {
  if (!blogger) {
    await sendBotMessage(chatId, "Сначала авторизуйтесь через /start и выберите канал.");
    return;
  }
  const payload = buildPauseChooserPayload(blogger, null);
  await sendBotMessage(chatId, payload.text, payload.keyboard, {
    parseMode: payload.parseMode || undefined
  });
}

async function handlePauseCallback(query, actionData) {
  const blogger = getBloggerById(String(query?.from?.id || ""));
  if (!blogger) {
    await answerCallbackQuery(query.id, "Сначала авторизуйтесь через /start");
    return;
  }

  const channels = listChannelsForBlogger(blogger.id);
  if (!channels.length) {
    await answerCallbackQuery(query.id, "Сначала выберите канал");
    return;
  }

  const chatId = Number(query?.message?.chat?.id || 0);
  const messageId = Number(query?.message?.message_id || 0);
  const action = String(actionData || "").trim();

  const renderPanel = async (selectedChannelId) => {
    const payload = buildPauseChooserPayload(blogger, selectedChannelId);
    if (chatId && messageId) {
      await editBotMessage(chatId, messageId, payload.text, payload.keyboard, {
        parseMode: payload.parseMode || undefined
      });
      return;
    }
    await sendBotMessage(blogger.chatId, payload.text, payload.keyboard, {
      parseMode: payload.parseMode || undefined
    });
  };

  if (action === "list") {
    await renderPanel(null);
    await answerCallbackQuery(query.id);
    return;
  }

  if (action.startsWith("ch:")) {
    const channelId = action.split(":")[1];
    await renderPanel(channelId || null);
    await answerCallbackQuery(query.id);
    return;
  }

  let channel = null;
  let pauseAction = "";
  if (action === "24h" || action === "resume") {
    channel = channels.find((item) => String(item.id) === String(blogger.channelId)) || channels[0];
    pauseAction = action;
  } else if (action.startsWith("set:")) {
    const [, channelId, actionCode] = action.split(":");
    channel = channels.find((item) => String(item.id) === String(channelId || ""));
    pauseAction = String(actionCode || "");
  }

  if (!channel || (pauseAction !== "24h" && pauseAction !== "resume")) {
    await answerCallbackQuery(query.id, "Неизвестное действие");
    return;
  }

  if (!modeSupportsPause(channel.postingMode)) {
    await answerCallbackQuery(query.id, "Пауза доступна только в режимах автопубликации");
    await renderPanel(channel.id);
    return;
  }

  if (pauseAction === "resume") {
    if (!isChannelAutoPaused(channel)) {
      await answerCallbackQuery(query.id, "Пауза не активна");
      await renderPanel(channel.id);
      return;
    }
    channel.autoPausedUntilAt = null;
    channel.autoPauseMessageId = null;
    db.channels[channel.id] = channel;
    saveDb(db);
    await answerCallbackQuery(query.id, `${channelLabel(channel)}: публикации снова активны`);
    await renderPanel(channel.id);
    return;
  }

  if (isChannelAutoPaused(channel)) {
    await answerCallbackQuery(query.id, "Пауза уже включена");
    await renderPanel(channel.id);
    return;
  }

  channel.autoPausedUntilAt = Date.now() + AUTO_PAUSE_DURATION_MS;
  if (chatId && messageId) {
    channel.autoPauseMessageId = messageId;
  } else {
    channel.autoPauseMessageId = null;
  }

  db.channels[channel.id] = channel;
  saveDb(db);
  await answerCallbackQuery(query.id, `${channelLabel(channel)}: пауза до ${formatDateTimeHumanRu(channel.autoPausedUntilAt)}`);
  await renderPanel(channel.id);
}

function parseOfferCallback(data) {
  const parts = String(data || "").split(":");
  if (parts.length < 3 || parts[0] !== "of") return null;
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

  const offer = db.offers[String(parsed.offerId)];
  if (!offer) {
    await answerCallbackQuery(query.id, "Оффер не найден");
    return;
  }

  const queryChatId = Number(query?.message?.chat?.id || 0);
  if (offer.chatId && queryChatId && Number(offer.chatId) !== queryChatId) {
    await answerCallbackQuery(query.id, "Этот оффер не для вас");
    return;
  }

  if (parsed.action === "pd") {
    const page = Number(parsed.arg || 0);
    offer.uiState = "pick_time";
    db.offers[String(offer.id)] = offer;
    saveDb(db);
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

  if (parsed.action === "tm") {
    if (!isOfferAwaitingDecision(offer)) {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    offer.uiState = "pick_time";
    db.offers[String(offer.id)] = offer;
    saveDb(db);
    await upsertOfferMessage(offer);
    await answerCallbackQuery(query.id, "Выберите слот");
    return;
  }

  if (parsed.action === "tb") {
    if (!isOfferActive(offer)) {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    offer.uiState = "main";
    db.offers[String(offer.id)] = offer;
    saveDb(db);
    await upsertOfferMessage(offer);
    await answerCallbackQuery(query.id);
    return;
  }

  if (parsed.action === "dr" || parsed.action === "dc") {
    if (!isOfferAwaitingDecision(offer)) {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    await declineOfferByBlogger(offer);
    await answerCallbackQuery(query.id, "Отклонено");
    return;
  }

  if (parsed.action === "rb") {
    await answerCallbackQuery(query.id, "Шаг больше не используется");
    return;
  }

  if (parsed.action === "rr") {
    await answerCallbackQuery(query.id, "Шаг больше не используется");
    return;
  }

  if (parsed.action === "ap") {
    if (offer.status !== "pending_precheck" && offer.status !== "pending_approval") {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    await approveOffer(offer, `Оффер #${offer.id} подтверждён.`);
    await answerCallbackQuery(query.id, "Подтверждено");
    return;
  }

  if (parsed.action === "me") {
    if (offer.status !== "pending_manual_posting") {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    offer.status = "manual_waiting_publication";
    offer.uiState = "main";
    db.offers[String(offer.id)] = offer;
    saveDb(db);
    await upsertOfferMessage(offer);
    await sendBotMessage(
      offer.chatId,
      [
        `ERID для оффера #${offer.id}: ${offer.eridTag || `demo-${offer.id}`}`,
        "Публикация будет засчитана, когда мы увидим в канале размещение с этим ERID.",
        "",
        "Текст для публикации:",
        offer.textMarked
      ].join("\n")
    );
    await answerCallbackQuery(query.id, "ERID отправлен");
    return;
  }

  if (parsed.action === "mq") {
    if (offer.status !== "manual_waiting_publication") {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    offer.status = "manual_queued_publication";
    offer.uiState = "main";
    db.offers[String(offer.id)] = offer;
    saveDb(db);
    await upsertOfferMessage(offer);
    await sendBotMessage(offer.chatId, "Спасибо, ждём выхода публикации.");
    await answerCallbackQuery(query.id, "Отметили");
    return;
  }

  if (parsed.action === "mp") {
    if (offer.status !== "pending_manual_posting") {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    await acceptManualPostingOffer(offer);
    await answerCallbackQuery(query.id, "Принято");
    return;
  }

  if (parsed.action === "bc") {
    if (!isOfferActive(offer)) {
      await answerCallbackQuery(query.id, offerProcessedCallbackText(offer));
      return;
    }
    await cancelOfferByBlogger(offer);
    await answerCallbackQuery(query.id, "Отменено");
    return;
  }

  await answerCallbackQuery(query.id, "Неизвестное действие");
}

function extractChannelPostText(post) {
  const text = String(post?.text || "").trim();
  const caption = String(post?.caption || "").trim();
  return [text, caption].filter(Boolean).join("\n");
}

async function handleChannelPostUpdate(post) {
  const chatId = Number(post?.chat?.id || 0);
  if (!chatId) return;

  const channel = getChannelByChatId(chatId);
  if (!channel) return;

  const body = extractChannelPostText(post);
  if (!body) return;
  const bodyLower = body.toLowerCase();

  const targets = listOffers()
    .filter((offer) =>
      String(offer.channelId) === String(channel.id) &&
      (offer.status === "manual_waiting_publication" || offer.status === "manual_queued_publication")
    )
    .sort((a, b) => a.id - b.id);

  for (const offer of targets) {
    const eridTag = String(offer.eridTag || `demo-${offer.id}`).toLowerCase();
    if (!eridTag || !bodyLower.includes(eridTag)) continue;

    offer.status = "manual_publication_found";
    offer.uiState = "main";
    offer.manualPublicationFoundAt = Date.now();
    offer.channelPostId = Number(post?.message_id || 0) || null;
    db.offers[String(offer.id)] = offer;
    saveDb(db);

    await upsertOfferMessage(offer);
    await sendBotMessage(
      offer.chatId,
      `Публикация найдена. Она должна провисеть минимум ${manualHoldDurationText()}, чтобы было начислено вознаграждение.`
    );
  }
}

async function processTelegramUpdate(update) {
  if (update?.channel_post) {
    await handleChannelPostUpdate(update.channel_post);
    return;
  }

  if (update?.edited_channel_post) {
    await handleChannelPostUpdate(update.edited_channel_post);
    return;
  }

  const message = update?.message;
  const text = String(message?.text || "");

  if (/^\/start(?:@\w+)?/i.test(text)) {
    await handleStartMessage(message);
    return;
  }

  if (message?.chat_shared) {
    await handleChatSharedMessage(message);
    return;
  }

  if (/^\/mode(?:@\w+)?(?:\s+.*)?$/i.test(text)) {
    const chatId = Number(message?.chat?.id || 0);
    const blogger = getBloggerById(String(message?.from?.id || ""));
    await sendModeChooser(chatId, blogger);
    return;
  }

  if (/^\/pause(?:@\w+)?(?:\s+.*)?$/i.test(text)) {
    const chatId = Number(message?.chat?.id || 0);
    const blogger = getBloggerById(String(message?.from?.id || ""));
    await sendPauseChooser(chatId, blogger);
    return;
  }

  if (update?.callback_query) {
    const query = update.callback_query;
    const data = String(query?.data || "");
    if (data.startsWith("mode:")) {
      await handleModeCallback(query, data.slice(5));
      return;
    }
    if (data.startsWith("pause:")) {
      await handlePauseCallback(query, data.slice(6));
      return;
    }
    await handleOfferCallback(query, parseOfferCallback(data));
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
    botState.userId = me?.id || null;

    const webhookUrl = `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}`;
    botState.webhookUrl = webhookUrl;

    await tgApiWithRetry("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
      secret_token: WEBHOOK_SECRET_TOKEN,
      drop_pending_updates: WEBHOOK_DROP_PENDING_UPDATES
    });

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
    sendJson(res, 200, stateSnapshotForToken(token));
    return;
  }

  if (url.pathname === "/api/advertiser/state" && req.method === "GET") {
    sendJson(res, 200, advertiserSnapshot());
    return;
  }

  if (url.pathname === "/api/admin/state" && req.method === "GET") {
    sendJson(res, 200, adminSnapshot());
    return;
  }

  if (url.pathname === "/api/auth/session" && req.method === "POST") {
    if (!botState.enabled || !botState.username) {
      sendJson(res, 503, { error: botState.lastError || "Bot is not configured" });
      return;
    }

    const token = crypto.randomBytes(8).toString("hex");
    db.authSessions[token] = {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
      status: "pending_start",
      tgUserId: null,
      tgUsername: null,
      bloggerId: null,
      connectedAt: null,
      error: null
    };
    saveDb(db);

    sendJson(res, 200, {
      ok: true,
      token,
      tg: `https://t.me/${botState.username}?start=${encodeURIComponent(token)}`,
      status: "pending_start",
      expiresAt: db.authSessions[token].expiresAt
    });
    return;
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const token = String(url.searchParams.get("token") || "").trim();
    const row = getSessionByToken(token);
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
      web: row.status === "connected" ? `/cpvdemo?token=${encodeURIComponent(token)}` : null
    });
    return;
  }

  if (url.pathname === "/api/test/tick" && req.method === "POST") {
    if (!ALLOW_TEST_API || !isLocalRequest(req)) {
      sendText(res, 404, "Not found");
      return;
    }

    await processOfferDeadlines();
    await processAutoPauseExpirations();
    sendJson(res, 200, {
      ok: true,
      now: Date.now(),
      totals: {
        offers: listOffers().length,
        activeOffers: listOffers().filter((offer) => isOfferActive(offer)).length
      }
    });
    return;
  }

  if (url.pathname === "/api/test/offers" && req.method === "POST") {
    if (!ALLOW_TEST_API || !isLocalRequest(req)) {
      sendText(res, 404, "Not found");
      return;
    }

    const body = await readJsonBody(req);
    const channelId = String(body.channelId || "").trim();
    if (!channelId) {
      sendJson(res, 400, { error: "channelId is required" });
      return;
    }

    const channel = getChannelById(channelId);
    if (!channel) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }

    const blogger = getBloggerById(channel.bloggerId);
    if (!blogger) {
      sendJson(res, 404, { error: "Blogger not found" });
      return;
    }
    if (!blogger.chatId) {
      sendJson(res, 400, { error: "Blogger has no private chat" });
      return;
    }

    const now = Date.now();
    const scheduledAtRaw = Number(body.scheduledAt);
    const scheduledAt = Number.isFinite(scheduledAtRaw) ? Math.floor(scheduledAtRaw) : now + 90_000;
    const dateFromRaw = Number(body.dateFrom);
    const dateToRaw = Number(body.dateTo);
    const dateFrom = Number.isFinite(dateFromRaw) ? Math.floor(dateFromRaw) : Math.max(now - 60_000, scheduledAt - 60 * 60 * 1000);
    const dateTo = Number.isFinite(dateToRaw) ? Math.floor(dateToRaw) : scheduledAt + 6 * 60 * 60 * 1000;
    if (dateTo < dateFrom) {
      sendJson(res, 400, { error: "dateTo must be >= dateFrom" });
      return;
    }

    const cpv = Number(body.cpv);
    const text = String(body.text || "").trim();
    const offer = createOffer({
      blogger,
      channel,
      scheduledAt,
      dateFrom,
      dateTo,
      textRaw: text,
      cpv
    });
    await notifyOfferCreated(offer);
    sendJson(res, 200, { ok: true, offer: toOfferDto(offer) });
    return;
  }

  if (url.pathname === "/api/channel/mode" && req.method === "POST") {
    const body = await readJsonBody(req);
    const ctx = ensureConnectedContext(body.token);
    if (!ctx) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!ctx.channel) {
      sendJson(res, 400, { error: "Channel is not selected yet" });
      return;
    }

    const mode = normalizeMode(body.mode);
    if (!POSTING_MODES.includes(mode)) {
      sendJson(res, 400, { error: "Invalid mode" });
      return;
    }

    ctx.channel.postingMode = mode;
    if (!modeSupportsPause(mode)) {
      ctx.channel.autoPausedUntilAt = null;
      ctx.channel.autoPauseMessageId = null;
    }
    ctx.channel.updatedAt = Date.now();
    db.channels[ctx.channel.id] = ctx.channel;
    saveDb(db);

    sendJson(res, 200, { ok: true, mode });
    return;
  }

  if (url.pathname === "/api/channel/settings" && req.method === "POST") {
    const body = await readJsonBody(req);
    const ctx = ensureConnectedContext(body.token);
    if (!ctx) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!ctx.channel) {
      sendJson(res, 400, { error: "Channel is not selected yet" });
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

    ctx.channel.weeklyPostLimit = weeklyPostLimit;
    ctx.channel.scheduleSlots = scheduleSlots;
    ctx.channel.updatedAt = Date.now();
    db.channels[ctx.channel.id] = ctx.channel;
    saveDb(db);

    sendJson(res, 200, { ok: true, weeklyPostLimit, scheduleSlots });
    return;
  }

  if (url.pathname === "/api/offers/cancel" && req.method === "POST") {
    const body = await readJsonBody(req);
    const ctx = ensureConnectedContext(body.token);
    if (!ctx) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const offerId = Number(body.offerId);
    if (!Number.isInteger(offerId)) {
      sendJson(res, 400, { error: "Invalid offerId" });
      return;
    }

    const offer = db.offers[String(offerId)];
    if (!offer) {
      sendJson(res, 404, { error: "Offer not found" });
      return;
    }
    if (String(offer.bloggerId) !== String(ctx.blogger.id)) {
      sendJson(res, 403, { error: "Offer is assigned to another blogger" });
      return;
    }
    if (!canCancelOffer(offer.status)) {
      sendJson(res, 400, { error: "Offer is not active" });
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

    const channelIds = Array.isArray(body.channelIds)
      ? body.channelIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    const bloggerIds = Array.isArray(body.bloggerIds)
      ? body.bloggerIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    if (!channelIds.length && !bloggerIds.length) {
      sendJson(res, 400, { error: "Select at least one channel" });
      return;
    }

    const text = String(body.text || "").trim();
    const cpv = Number(body.cpv);

    const created = [];
    const skipped = [];

    const targets = [];
    const seenChannels = new Set();

    if (channelIds.length) {
      for (const channelId of channelIds) {
        if (seenChannels.has(channelId)) continue;
        seenChannels.add(channelId);
        const channel = getChannelById(channelId);
        if (!channel) {
          skipped.push({ channelId, reason: "Channel not found" });
          continue;
        }
        const blogger = getBloggerById(channel.bloggerId);
        if (!blogger) {
          skipped.push({ channelId, reason: "Blogger not found" });
          continue;
        }
        targets.push({ blogger, channel, key: channelId });
      }
    } else {
      for (const bloggerId of bloggerIds) {
        const blogger = getBloggerById(bloggerId);
        if (!blogger) {
          skipped.push({ bloggerId, reason: "Blogger not found" });
          continue;
        }
        const channel = getChannelForBlogger(blogger.id);
        if (!channel) {
          skipped.push({ bloggerId: blogger.id, reason: "Channel is not selected" });
          continue;
        }
        if (seenChannels.has(channel.id)) continue;
        seenChannels.add(channel.id);
        targets.push({ blogger, channel, key: channel.id });
      }
    }

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const blogger = target.blogger;
      const channel = target.channel;
      if (!blogger) {
        skipped.push({ target: target.key, reason: "Blogger not found" });
        continue;
      }

      if (!blogger.chatId) {
        skipped.push({ channelId: channel?.id || null, bloggerId: blogger.id, reason: "Blogger has no private chat" });
        continue;
      }

      if (!channel) {
        skipped.push({ bloggerId: blogger.id, reason: "Channel is not selected" });
        continue;
      }

      if (modeSupportsPause(channel.postingMode) && isChannelAutoPaused(channel)) {
        skipped.push({
          channelId: channel.id,
          bloggerId: blogger.id,
          reason: `Autoposting paused until ${formatDateTime(channel.autoPausedUntilAt)}`
        });
        continue;
      }

      if (countActiveOffersForBlogger(blogger.id) >= Number(channel.weeklyPostLimit || 21)) {
        skipped.push({ channelId: channel.id, bloggerId: blogger.id, reason: "Weekly post limit is filled" });
        continue;
      }

      const scheduledAt = pickScheduledTimeForBlogger(channel, blogger.id, dateFrom, dateTo, i);
      if (!scheduledAt) {
        skipped.push({ channelId: channel.id, bloggerId: blogger.id, reason: "No available slots in date range" });
        continue;
      }
      const offer = createOffer({ blogger, channel, scheduledAt, dateFrom, dateTo, textRaw: text, cpv });
      await notifyOfferCreated(offer);
      created.push(toOfferDto(offer));
    }

    sendJson(res, 200, { ok: true, created, skipped });
    return;
  }

  if (url.pathname === "/api/advertiser/offers/cancel" && req.method === "POST") {
    const body = await readJsonBody(req);
    const offerId = Number(body.offerId);
    if (!Number.isInteger(offerId)) {
      sendJson(res, 400, { error: "Invalid offerId" });
      return;
    }

    const offer = db.offers[String(offerId)];
    if (!offer) {
      sendJson(res, 404, { error: "Offer not found" });
      return;
    }

    if (!canCancelOffer(offer.status)) {
      sendJson(res, 400, { error: "Offer is not active" });
      return;
    }

    await cancelOfferByAdvertiser(offer);
    sendJson(res, 200, { ok: true, offer: toOfferDto(offer) });
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

  processOfferDeadlines().catch((err) => {
    botState.lastError = formatError(err);
  });
  processAutoPauseExpirations().catch((err) => {
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
    Promise.resolve()
      .then(() => processOfferDeadlines())
      .then(() => processAutoPauseExpirations())
      .catch((err) => {
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
