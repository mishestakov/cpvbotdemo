(function (global) {
  "use strict";

  function normalizeUsername(value) {
    return String(value || "").replace(/^@/, "").replace(/^\/+/, "").trim();
  }

  function buildFromUsernameStart(username, startToken) {
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername) return { deep: "", web: "" };

    const start = String(startToken || "");
    const deep =
      `tg://resolve?domain=${encodeURIComponent(cleanUsername)}` +
      (start ? `&start=${encodeURIComponent(start)}` : "");
    const web =
      `https://t.me/${cleanUsername}` +
      (start ? `?start=${encodeURIComponent(start)}` : "");
    return { deep, web };
  }

  function buildFromTelegramUrl(rawTgLink) {
    const raw = String(rawTgLink || "").trim();
    if (!raw) return { deep: "", web: "" };

    try {
      const url = new URL(raw);
      const username = normalizeUsername(url.pathname || "");
      const start = String(url.searchParams.get("start") || "");
      if (!username) return { deep: raw, web: raw };
      return buildFromUsernameStart(username, start);
    } catch {
      return { deep: raw, web: raw };
    }
  }

  function openDeepLink(deep) {
    if (!deep) return;
    global.location.href = deep;
  }

  global.TelegramLinks = {
    buildFromUsernameStart,
    buildFromTelegramUrl,
    openDeepLink
  };
})(window);

