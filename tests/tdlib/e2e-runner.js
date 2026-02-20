#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env") });

const BASE_URL = String(
  process.env.CPVDEMO_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3030}`
).replace(/\/+$/, "");
const WEBHOOK_SECRET_TOKEN = String(process.env.WEBHOOK_SECRET_TOKEN || "").trim();

const TDLIB_PATH = process.env.TDLIB_PATH || "/home/mike/td/build/libtdjson.so";
const TDLIB_AUTH_MODE = process.env.TDLIB_AUTH_MODE || "user";
const TDLIB_BOT_TOKEN = process.env.TDLIB_BOT_TOKEN || process.env.BOT_TOKEN || "";
const TDLIB_DATABASE_DIR = process.env.TDLIB_DATABASE_DIR || path.join(process.cwd(), "tdlib", "e2e-db");
const TDLIB_FILES_DIR = process.env.TDLIB_FILES_DIR || path.join(process.cwd(), "tdlib", "e2e-files");
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID || 2749123);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "1cdcd76b0683d0e66570bcb5e453350d";
const TDLIB_TEST_CHANNEL = String(process.env.TDLIB_TEST_CHANNEL || "").trim();

const HOLD_WAIT_MS = Math.max(1000, Number(process.env.TDLIB_E2E_HOLD_WAIT_MS || 12_000));
const WAIT_LONG_MS = Math.max(5_000, Number(process.env.TDLIB_E2E_WAIT_LONG_MS || 30_000));
const WAIT_SHORT_MS = Math.max(2_000, Number(process.env.TDLIB_E2E_WAIT_SHORT_MS || 15_000));
const OFFER_DELAY_MS = Math.max(3_000, Number(process.env.TDLIB_E2E_OFFER_DELAY_MS || 15_000));
const USE_TEST_API = String(process.env.CPVDEMO_USE_TEST_API || "true").trim().toLowerCase() !== "false";

const DEFAULT_SCENARIOS = [
  "precheck_confirm",
  "precheck_decline",
  "manual_erid_reward",
  "manual_no_action_until_slot",
  "advertiser_cancel",
  "auto_pause_skip"
];

const MODE_AUTO = "auto";
const MODE_GUIDED = "guided";

const stats = {
  total: 0,
  passed: 0,
  failed: 0,
  failures: []
};

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensure(value, message) {
  if (!value) throw new Error(message);
}

function ask(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askStep(promptText) {
  while (true) {
    const answer = String(await ask(`${promptText} [Y/s/q]: `)).trim().toLowerCase();
    if (!answer || answer === "y" || answer === "yes" || answer === "д" || answer === "да") return "y";
    if (answer === "s" || answer === "skip" || answer === "tick") return "s";
    if (answer === "q" || answer === "quit" || answer === "exit") return "q";
    console.log("Введите Y (готово), s (tick) или q (выход).");
  }
}

function parseArgs(argv) {
  const out = {
    mode: MODE_AUTO,
    scenarios: DEFAULT_SCENARIOS.slice()
  };

  for (const token of argv) {
    if (token.startsWith("--scenarios=")) {
      const list = token.split("=")[1] || "";
      out.scenarios = list.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (token.startsWith("--mode=")) {
      const mode = token.split("=")[1] || "";
      out.mode = mode === MODE_GUIDED ? MODE_GUIDED : MODE_AUTO;
    }
  }

  return out;
}

function loadTdl() {
  const candidates = [
    path.join(process.cwd(), "node_modules", "tdl"),
    "/home/mike/suggestpost/node_modules/tdl",
    "/home/mike/tgstat/node_modules/tdl",
    "tdl"
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_error) {
      // next candidate
    }
  }
  throw new Error("Не удалось загрузить модуль tdl (проверь /home/mike/suggestpost/node_modules/tdl)");
}

async function apiGet(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}: ${body?.error || "unknown"}`);
  return body;
}

async function apiPost(pathname, payload) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status}: ${body?.error || "unknown"}`);
  return body;
}

async function safeTick() {
  if (!USE_TEST_API) return false;
  try {
    await apiPost("/api/test/tick", {});
    return true;
  } catch (_error) {
    return false;
  }
}

async function webhookInject(update) {
  ensure(WEBHOOK_SECRET_TOKEN, "WEBHOOK_SECRET_TOKEN is required for chat_shared injection");
  const res = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET_TOKEN
    },
    body: JSON.stringify(update)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook inject failed: ${res.status} ${text}`);
  }
}

function getType(value) {
  return (value && (value["@type"] || value._)) || "";
}

function normalizeUsername(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("@")) return raw.slice(1);
  if (/^[a-zA-Z0-9_]{3,32}$/.test(raw)) return raw;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (url.hostname === "t.me") {
      return (url.pathname || "").replace(/^\//, "").split("/")[0] || "";
    }
  } catch (_error) {
    // noop
  }
  return "";
}

function decodeCallbackData(raw) {
  if (raw == null) return "";
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.from(raw).toString("utf8");
  if (typeof raw !== "string") return String(raw || "");
  if (raw.includes(":")) return raw;
  if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded.includes(":")) return decoded;
    } catch (_error) {
      // noop
    }
  }
  return raw;
}

function iterInlineButtons(message) {
  const replyMarkup = message?.reply_markup;
  if (!replyMarkup) return [];

  const rows = Array.isArray(replyMarkup.rows)
    ? replyMarkup.rows
    : Array.isArray(replyMarkup.inline_keyboard)
      ? replyMarkup.inline_keyboard
      : [];

  const buttons = [];
  for (const row of rows) {
    const rowButtons = Array.isArray(row?.buttons) ? row.buttons : Array.isArray(row) ? row : [];
    for (const button of rowButtons) {
      const type = button?.type || {};
      if (getType(type) !== "inlineKeyboardButtonTypeCallback") continue;
      buttons.push({
        text: String(button?.text || ""),
        rawData: type.data,
        data: decodeCallbackData(type.data)
      });
    }
  }
  return buttons;
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function getRecentMessages(client, chatId, limit = 50) {
  const resp = await client.invoke({
    _: "getChatHistory",
    chat_id: chatId,
    from_message_id: 0,
    offset: 0,
    limit,
    only_local: false
  });
  return Array.isArray(resp?.messages) ? resp.messages : [];
}

async function findMessageWithButton(client, chatId, filter, timeoutMs = WAIT_SHORT_MS) {
  return waitFor(async () => {
    const messages = await getRecentMessages(client, chatId, 60);
    for (const message of messages) {
      const buttons = iterInlineButtons(message);
      const hit = buttons.find(filter);
      if (hit) return { message, button: hit };
    }
    return null;
  }, timeoutMs, 600);
}

async function clickInlineButton(client, chatId, message, button) {
  await client.invoke({
    _: "getCallbackQueryAnswer",
    chat_id: chatId,
    message_id: message.id,
    payload: {
      _: "callbackQueryPayloadData",
      data: button.rawData
    }
  });
}

async function loginTdlib(client) {
  if (TDLIB_AUTH_MODE === "bot") {
    ensure(TDLIB_BOT_TOKEN, "TDLIB_AUTH_MODE=bot but BOT token is missing");
    await client.login(() => ({ type: "bot", getToken: async () => TDLIB_BOT_TOKEN }));
    return;
  }

  await client.login(async (retry) => {
    if (retry?.error) log(`TDLib auth error: ${retry.error.message || retry.error}`);
    return {
      type: "user",
      getPhoneNumber: async () => ask("Введите номер телефона (+7...): "),
      getAuthCode: async () => ask("Введите код из Telegram: "),
      getPassword: async () => {
        const value = await ask("Введите 2FA пароль (если нет — Enter): ");
        return value || undefined;
      }
    };
  });
}

async function resolveChannel(client, channelInput) {
  const username = normalizeUsername(channelInput);
  ensure(username, "TDLIB_TEST_CHANNEL must be @username or t.me/... username");

  const chat = await client.invoke({ _: "searchPublicChat", username });
  ensure(chat, "Test channel not found");
  ensure(getType(chat.type) === "chatTypeSupergroup", "Provided channel is not a supergroup/channel chat");

  const supergroup = await client.invoke({ _: "getSupergroup", supergroup_id: chat.type.supergroup_id });
  ensure(supergroup?.is_channel, "Provided chat is not a channel");

  const channelUsername = supergroup?.usernames?.active_usernames?.[0] || username;
  return {
    chatId: Number(chat.id),
    title: chat.title || "",
    username: channelUsername
  };
}

function build24x7Slots() {
  const slots = [];
  for (let day = 1; day <= 7; day += 1) {
    for (let hour = 0; hour <= 23; hour += 1) {
      slots.push({ day, hour });
    }
  }
  return slots;
}

async function getOfferById(offerId) {
  const state = await apiGet("/api/advertiser/state");
  return (state?.offers || []).find((item) => Number(item.id) === Number(offerId)) || null;
}

async function waitOfferStatusAuto(offerId, allowed, timeoutMs = WAIT_LONG_MS) {
  const wanted = new Set(Array.isArray(allowed) ? allowed : [allowed]);
  const result = await waitFor(async () => {
    await safeTick();
    const offer = await getOfferById(offerId);
    if (!offer) return null;
    return wanted.has(String(offer.status || "")) ? offer : null;
  }, timeoutMs, 600);

  if (!result) {
    throw new Error(`Offer #${offerId} did not reach expected status: ${Array.from(wanted).join(", ")}`);
  }
  return result;
}

async function waitOfferStatusGuided(offerId, allowed, label) {
  const wanted = new Set(Array.isArray(allowed) ? allowed : [allowed]);
  while (true) {
    const offer = await getOfferById(offerId);
    const status = String(offer?.status || "missing");
    log(`offer #${offerId} status=${status}${label ? ` (${label})` : ""}`);

    if (wanted.has(status)) return offer;

    const step = await askStep("Статус ещё не целевой. Нажмите Y после действия в Telegram, s для test tick, q для выхода");
    if (step === "q") throw new Error(`Interrupted by user while waiting offer #${offerId}`);
    if (step === "s") {
      const ok = await safeTick();
      log(ok ? "test tick done" : "test tick unavailable");
    }
  }
}

async function waitOfferStatus(ctx, offerId, allowed, timeoutMs = WAIT_LONG_MS, label = "") {
  if (ctx.mode === MODE_GUIDED) return waitOfferStatusGuided(offerId, allowed, label);
  return waitOfferStatusAuto(offerId, allowed, timeoutMs);
}

async function createOfferForChannel(channelId, textSuffix, options = {}) {
  const scheduledAt = Number.isFinite(Number(options.scheduledAt))
    ? Math.floor(Number(options.scheduledAt))
    : Date.now() + OFFER_DELAY_MS;
  const dateFrom = Number.isFinite(Number(options.dateFrom))
    ? Math.floor(Number(options.dateFrom))
    : scheduledAt - 60 * 60 * 1000;
  const dateTo = Number.isFinite(Number(options.dateTo))
    ? Math.floor(Number(options.dateTo))
    : scheduledAt + 6 * 60 * 60 * 1000;

  if (USE_TEST_API) {
    const res = await apiPost("/api/test/offers", {
      channelId: String(channelId),
      scheduledAt,
      dateFrom,
      dateTo,
      cpv: 900,
      text: `[TDLIB E2E] ${textSuffix}`
    });
    if (!res?.offer?.id) throw new Error(`Test offer not created for channel=${channelId}`);
    return res.offer;
  }

  const from = Date.now() + 60_000;
  const to = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const payloadDateFrom = Number.isFinite(Number(options.dateFrom)) ? dateFrom : from;
  const payloadDateTo = Number.isFinite(Number(options.dateTo)) ? dateTo : to;
  const payload = {
    dateFrom: payloadDateFrom,
    dateTo: Math.max(payloadDateFrom, payloadDateTo),
    cpv: 900,
    text: `[TDLIB E2E] ${textSuffix}`,
    channelIds: [String(channelId)]
  };
  const res = await apiPost("/api/advertiser/offers", payload);
  if (!Array.isArray(res.created) || !res.created.length) {
    const skipped = JSON.stringify(res.skipped || []);
    throw new Error(`Offer not created for channel=${channelId}. skipped=${skipped}`);
  }
  return res.created[0];
}

async function findOfferButtonAndClick(client, botChatId, offerId, actionPrefix) {
  const found = await findMessageWithButton(
    client,
    botChatId,
    (button) => button.data.startsWith(`of:${actionPrefix}:${offerId}`) || button.data.includes(`:${offerId}`),
    WAIT_LONG_MS
  );

  if (!found) throw new Error(`Button not found for offer #${offerId}, action=${actionPrefix}`);

  const targetButton =
    iterInlineButtons(found.message).find((button) => button.data.startsWith(`of:${actionPrefix}:${offerId}`)) || found.button;
  await clickInlineButton(client, botChatId, found.message, targetButton);
}

async function ensureConnectedFlowAuto(client, botUsername, channel) {
  const auth = await apiPost("/api/auth/session", {});
  ensure(auth?.token, "Failed to create auth session");

  const botChat = await client.invoke({ _: "searchPublicChat", username: botUsername });
  ensure(botChat?.id, "Bot chat not found in TDLib");

  await client.invoke({
    _: "sendMessage",
    chat_id: botChat.id,
    input_message_content: {
      _: "inputMessageText",
      text: { _: "formattedText", text: `/start ${auth.token}` }
    }
  });

  const me = await client.invoke({ _: "getMe" });
  const nowSec = Math.floor(Date.now() / 1000);
  const update = {
    update_id: Date.now(),
    message: {
      message_id: Math.floor(Date.now() / 10),
      date: nowSec,
      chat: { id: Number(me.id), type: "private" },
      from: { id: Number(me.id), is_bot: false, first_name: me.first_name || "E2E" },
      chat_shared: {
        request_id: 1,
        chat_id: channel.chatId,
        title: channel.title,
        username: channel.username
      }
    }
  };

  await webhookInject(update);

  const connected = await waitFor(async () => {
    const row = await apiGet(`/api/auth/session?token=${encodeURIComponent(auth.token)}`);
    return row?.status === "connected" ? row : null;
  }, WAIT_LONG_MS, 700);

  ensure(connected, "Auth session did not become connected after /start + chat_shared");

  await apiPost("/api/channel/settings", {
    token: auth.token,
    weeklyPostLimit: 28,
    scheduleSlots: build24x7Slots()
  });

  const admin = await apiGet("/api/admin/state");
  const blogger = (admin?.bloggers || []).find((item) => String(item.tgUserId || "") === String(me.id));
  ensure(blogger?.channel?.id, "Connected blogger/channel not found in admin state");

  return {
    mode: MODE_AUTO,
    token: auth.token,
    botChatId: Number(botChat.id),
    userId: Number(me.id),
    channelId: String(blogger.channel.id),
    channelChatId: Number(channel.chatId),
    botUsername
  };
}

async function waitConnectedAuthGuided(token) {
  section("GUIDED AUTH");
  while (true) {
    const row = await apiGet(`/api/auth/session?token=${encodeURIComponent(token)}`);
    const status = String(row?.status || "unknown");
    log(`auth session status=${status}`);
    if (status === "connected") return row;

    const action = await askStep("Заверши шаги в Telegram (Start + выбор канала), затем нажми Y. s=test tick, q=выход");
    if (action === "q") throw new Error("Interrupted by user during auth");
    if (action === "s") {
      const ok = await safeTick();
      log(ok ? "test tick done" : "test tick unavailable");
    }
  }
}

async function ensureConnectedFlowGuided(botUsername) {
  const auth = await apiPost("/api/auth/session", {});
  ensure(auth?.token, "Failed to create auth session");

  section("GUIDED MODE");
  console.log("Открой ссылку авторизации и выполни onboarding в Telegram:");
  console.log(`https://t.me/${botUsername}?start=${encodeURIComponent(auth.token)}`);

  const connected = await waitConnectedAuthGuided(auth.token);
  const userId = Number(connected?.tgUserId || 0);
  ensure(userId > 0, "Connected auth has no tgUserId");

  await apiPost("/api/channel/settings", {
    token: auth.token,
    weeklyPostLimit: 28,
    scheduleSlots: build24x7Slots()
  });

  const admin = await apiGet("/api/admin/state");
  const blogger = (admin?.bloggers || []).find((item) => Number(item.tgUserId || 0) === userId);
  ensure(blogger?.channel?.id, "Connected blogger/channel not found in admin state");

  return {
    mode: MODE_GUIDED,
    token: auth.token,
    userId,
    channelId: String(blogger.channel.id),
    channelChatId: Number(blogger.channel.chatId || 0),
    botUsername
  };
}

async function setMode(token, mode) {
  await apiPost("/api/channel/mode", { token, mode });
}

async function scenarioPrecheckConfirm(ctx) {
  await setMode(ctx.token, "auto_with_precheck");
  const created = await createOfferForChannel(ctx.channelId, "precheck confirm");

  if (ctx.mode === MODE_AUTO) {
    await findOfferButtonAndClick(ctx.client, ctx.botChatId, created.id, "ap");
  } else {
    section("SCENARIO precheck_confirm");
    console.log(`Оффер #${created.id} создан. В боте нажми: ✅ Подтвердить`);
  }

  await waitOfferStatus(ctx, created.id, "scheduled", WAIT_LONG_MS, "expected=scheduled/confirmed");
}

async function scenarioPrecheckDecline(ctx) {
  await setMode(ctx.token, "auto_with_precheck");
  const created = await createOfferForChannel(ctx.channelId, "precheck decline");

  if (ctx.mode === MODE_AUTO) {
    await findOfferButtonAndClick(ctx.client, ctx.botChatId, created.id, "dr");
  } else {
    section("SCENARIO precheck_decline");
    console.log(`Оффер #${created.id} создан. В боте нажми: ❌ Отклонить`);
  }

  await waitOfferStatus(ctx, created.id, "declined_by_blogger", WAIT_LONG_MS, "expected=declined");
}

async function scenarioManualEridReward(ctx) {
  await setMode(ctx.token, "manual_posting");
  const created = await createOfferForChannel(ctx.channelId, "manual reward");

  if (ctx.mode === MODE_AUTO) {
    await findOfferButtonAndClick(ctx.client, ctx.botChatId, created.id, "me");
  } else {
    section("SCENARIO manual_erid_reward");
    console.log(`Оффер #${created.id} создан. В боте нажми: 🏷 Получить ERID`);
  }

  await waitOfferStatus(
    ctx,
    created.id,
    ["manual_waiting_publication", "manual_queued_publication"],
    WAIT_LONG_MS,
    "expected=manual waiting"
  );

  if (ctx.mode === MODE_AUTO) {
    await ctx.client.invoke({
      _: "sendMessage",
      chat_id: ctx.channelChatId,
      input_message_content: {
        _: "inputMessageText",
        text: { _: "formattedText", text: `Тестовая публикация ERID: demo-${created.id}` }
      }
    });
  } else {
    console.log(`Опубликуй в канале текст с ERID: demo-${created.id}`);
  }

  await waitOfferStatus(ctx, created.id, "manual_publication_found", WAIT_LONG_MS, "expected=publication found");
  await waitOfferStatus(ctx, created.id, "rewarded", HOLD_WAIT_MS, "expected=rewarded");
}

async function scenarioManualNoActionUntilSlot(ctx) {
  await setMode(ctx.token, "manual_posting");

  // Short placement window to reach archive quickly in E2E.
  const scheduledAt = Date.now() + OFFER_DELAY_MS;
  const created = await createOfferForChannel(ctx.channelId, "manual no action until slot", {
    scheduledAt,
    dateFrom: scheduledAt - 10_000,
    dateTo: scheduledAt + 2_000
  });

  if (ctx.mode === MODE_GUIDED) {
    section("SCENARIO manual_no_action_until_slot");
    console.log(`Оффер #${created.id} создан. Ничего не нажимай в боте (ни получить ERID, ни отклонить).`);
    console.log("Жми s для ускорения времени (test tick), пока оффер не перейдёт в архив.");
  }

  await waitOfferStatus(ctx, created.id, "archived_not_published", WAIT_LONG_MS, "expected=archived_not_published");
}

async function scenarioAdvertiserCancel(ctx) {
  await setMode(ctx.token, "manual_approval");
  const created = await createOfferForChannel(ctx.channelId, "advertiser cancel");
  await apiPost("/api/advertiser/offers/cancel", { offerId: created.id });
  await waitOfferStatus(ctx, created.id, "cancelled_by_advertiser", WAIT_LONG_MS, "expected=cancelled_by_advertiser");
}

async function scenarioAutoPauseSkip(ctx) {
  await setMode(ctx.token, "auto");

  if (ctx.mode === MODE_AUTO) {
    await ctx.client.invoke({
      _: "sendMessage",
      chat_id: ctx.botChatId,
      input_message_content: {
        _: "inputMessageText",
        text: { _: "formattedText", text: "/pause" }
      }
    });

    const pauseUi = await findMessageWithButton(
      ctx.client,
      ctx.botChatId,
      (button) => button.data.startsWith("pause:set:") && button.data.endsWith(":24h"),
      WAIT_LONG_MS
    );
    ensure(pauseUi, "Pause UI with 24h button not found");
    await clickInlineButton(ctx.client, ctx.botChatId, pauseUi.message, pauseUi.button);
    await sleep(1000);
  } else {
    section("SCENARIO auto_pause_skip");
    console.log("В боте отправь /pause и нажми ⏸ Пауза 24 часа.");
    const step = await askStep("После включения паузы нажми Y");
    if (step === "q") throw new Error("Interrupted by user");
    if (step === "s") {
      const ok = await safeTick();
      log(ok ? "test tick done" : "test tick unavailable");
    }
  }

  const from = Date.now() + 60_000;
  const to = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const result = await apiPost("/api/advertiser/offers", {
    dateFrom: from,
    dateTo: to,
    cpv: 900,
    text: "[TDLIB E2E] auto pause skip",
    channelIds: [String(ctx.channelId)]
  });

  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const pausedSkip = skipped.find((item) => String(item.reason || "").includes("Autoposting paused until"));
  ensure(pausedSkip, `Expected paused skip reason, got: ${JSON.stringify(skipped)}`);

  if (ctx.mode === MODE_AUTO) {
    const resumeUi = await findMessageWithButton(
      ctx.client,
      ctx.botChatId,
      (button) => button.data.startsWith("pause:set:") && button.data.endsWith(":resume"),
      WAIT_SHORT_MS
    );
    if (resumeUi) {
      await clickInlineButton(ctx.client, ctx.botChatId, resumeUi.message, resumeUi.button);
    }
  }
}

const SCENARIOS = {
  precheck_confirm: scenarioPrecheckConfirm,
  precheck_decline: scenarioPrecheckDecline,
  manual_erid_reward: scenarioManualEridReward,
  manual_no_action_until_slot: scenarioManualNoActionUntilSlot,
  advertiser_cancel: scenarioAdvertiserCancel,
  auto_pause_skip: scenarioAutoPauseSkip
};

async function runScenario(name, ctx) {
  const fn = SCENARIOS[name];
  ensure(fn, `Unknown scenario: ${name}`);

  stats.total += 1;
  log(`SCENARIO START: ${name}`);
  try {
    await fn(ctx);
    stats.passed += 1;
    log(`SCENARIO PASS: ${name}`);
  } catch (error) {
    stats.failed += 1;
    const message = error?.stack || error?.message || String(error);
    stats.failures.push({ name, message });
    log(`SCENARIO FAIL: ${name} -> ${error?.message || error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensure(TDLIB_TEST_CHANNEL, "Set TDLIB_TEST_CHANNEL in .env (e.g. @mytestchannel)");

  const admin = await apiGet("/api/admin/state");
  const botUsername = String(admin?.bot?.username || "").trim();
  ensure(botUsername, "Bot username is empty. Ensure cpvdemo server is running and bot is connected.");

  let client = null;
  let ctx = null;

  if (args.mode === MODE_AUTO) {
    const tdl = loadTdl();
    if (TDLIB_PATH && fs.existsSync(TDLIB_PATH)) {
      tdl.configure({ tdjson: TDLIB_PATH });
    }

    fs.mkdirSync(TDLIB_DATABASE_DIR, { recursive: true });
    fs.mkdirSync(TDLIB_FILES_DIR, { recursive: true });

    client = tdl.createClient({
      apiId: TELEGRAM_API_ID,
      apiHash: TELEGRAM_API_HASH,
      databaseDirectory: TDLIB_DATABASE_DIR,
      filesDirectory: TDLIB_FILES_DIR,
      tdlibParameters: {
        use_test_dc: false,
        use_file_database: true,
        use_chat_info_database: true,
        use_message_database: true,
        use_secret_chats: false,
        system_language_code: "ru",
        device_model: `nodejs ${process.version}`,
        system_version: `${process.platform} ${process.arch}`,
        application_version: "cpvdemo-tdlib-e2e-0.2.0",
        enable_storage_optimizer: true,
        ignore_file_names: false
      }
    });

    client.on("error", (error) => {
      log(`TDLib error: ${error?.message || error}`);
    });

    await loginTdlib(client);
    const channel = await resolveChannel(client, TDLIB_TEST_CHANNEL);
    ctx = await ensureConnectedFlowAuto(client, botUsername, channel);
    ctx.client = client;
  } else {
    ctx = await ensureConnectedFlowGuided(botUsername);
  }

  try {
    log(`E2E context ready: mode=${ctx.mode} user=${ctx.userId} channel=${ctx.channelId} bot=@${botUsername}`);
    log(`Scenarios: ${args.scenarios.join(", ")}`);
    for (const scenario of args.scenarios) {
      await runScenario(scenario, ctx);
    }

    log(`RESULT: total=${stats.total} passed=${stats.passed} failed=${stats.failed}`);
    if (stats.failed > 0) {
      for (const failure of stats.failures) {
        console.error(`\n[${failure.name}]\n${failure.message}\n`);
      }
      process.exitCode = 1;
    }
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (_error) {
        // noop
      }
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
