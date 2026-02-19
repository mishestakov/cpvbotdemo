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
const AUTH_SESSION_TTL_MS = Math.max(60_000, Number(process.env.AUTH_SESSION_TTL_MS || 30 * 60 * 1000));

const channelState = {
  key: "@demo_channel",
  title: "Демо канал CPV",
  username: "demo_channel",
  status: "ready",
  postingMode: "preapproval",
  weeklyPostLimit: 7,
  scheduleSlots: buildDefaultScheduleSlots(),
  blogger: {
    tgUsername: "demo_admin"
  }
};

const authSessions = new Map();
const botState = {
  enabled: false,
  username: null,
  lastError: null
};

let botLaunchInFlight = false;
let botPollRunning = false;
let botPollAbort = null;
let botUpdateOffset = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function snapshot(token) {
  return {
    bot: {
      enabled: botState.enabled,
      username: botState.username,
      lastError: botState.lastError
    },
    channels: token === CPVDEMO_TOKEN ? [channelState] : []
  };
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/auth.html";
  if (pathname === "/cpvdemo" || pathname === "/cpvdemo/") pathname = "/index.html";
  if (pathname === "/cpvdemo/auth" || pathname === "/cpvdemo/auth/") pathname = "/auth.html";
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

async function tgApi(method, payload = {}, signal) {
  if (!BOT_TOKEN) {
    const err = new Error("BOT_TOKEN is missing");
    err.code = "BOT_TOKEN_MISSING";
    throw err;
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
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

async function sendBotMessage(chatId, text) {
  if (!chatId) return;
  try {
    await tgApi("sendMessage", { chat_id: chatId, text: String(text || "") });
  } catch (err) {
    botState.lastError = formatError(err);
  }
}

async function handleStartMessage(message) {
  const chatId = message?.chat?.id;
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

  if (row.tgUsername) {
    channelState.blogger = { tgUsername: row.tgUsername };
  }

  await sendBotMessage(chatId, "Канал авторизован. Возвращайтесь в браузер, страница обновится автоматически.");
}

async function pollBotUpdates(signal) {
  while (!signal.aborted) {
    try {
      const updates = await tgApi(
        "getUpdates",
        {
          timeout: 25,
          offset: botUpdateOffset,
          allowed_updates: ["message"]
        },
        signal
      );

      botState.enabled = true;
      botState.lastError = null;

      for (const update of Array.isArray(updates) ? updates : []) {
        const updateId = Number(update?.update_id);
        if (Number.isInteger(updateId)) {
          botUpdateOffset = updateId + 1;
        }

        const text = String(update?.message?.text || "");
        if (/^\/start(?:@\w+)?/i.test(text)) {
          await handleStartMessage(update.message);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      botState.enabled = false;
      botState.lastError = formatError(err);
      await sleep(2000);
    }
  }
}

async function startBot() {
  if (botLaunchInFlight) return;
  botLaunchInFlight = true;

  try {
    const me = await tgApi("getMe", {});
    botState.username = me?.username || null;
    botState.enabled = true;
    botState.lastError = null;

    if (!botPollRunning) {
      botPollAbort = new AbortController();
      botPollRunning = true;
      pollBotUpdates(botPollAbort.signal)
        .catch((err) => {
          botState.enabled = false;
          botState.lastError = formatError(err);
        })
        .finally(() => {
          botPollRunning = false;
        });
    }

    console.log(`Bot connected: @${botState.username || "unknown"}`);
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

  if (url.pathname === "/api/state" && req.method === "GET") {
    const token = String(url.searchParams.get("token") || "").trim();
    sendJson(res, 200, snapshot(token));
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

    const mode = String(body.mode || "");
    if (mode !== "auto" && mode !== "preapproval") {
      sendJson(res, 400, { error: "Invalid mode" });
      return;
    }

    channelState.postingMode = mode;
    if (mode === "auto") {
      channelState.status = "ready";
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/channel/recheck" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (String(body.token || "") !== CPVDEMO_TOKEN) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    channelState.status = "ready";
    sendJson(res, 200, { ok: true });
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
    if (botPollRunning && botState.enabled) return;
    startBot().catch((err) => {
      botState.enabled = false;
      botState.lastError = formatError(err);
    });
  }, 15_000);
  retryTimer.unref();

  const shutdown = () => {
    clearInterval(retryTimer);
    if (botPollAbort) {
      try {
        botPollAbort.abort();
      } catch {
        // ignore
      }
    }
    server.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

boot().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
