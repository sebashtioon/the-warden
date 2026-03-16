import SYSTEM_PROMPT from "../prompt/prompt.md";

const THREAD_MEMORY_TTL_SECONDS = 60 * 60 * 24; // 1 day
const THREAD_MEMORY_MAX_MESSAGES = 80;

const WARDEN_USER_ID = "U094HHPS5B8";

const REMINDER_KV_KEY = "warden:daily_reminders";
const DEFAULT_WARDEN_TIME_ZONE = "Australia/Sydney";
const DEFAULT_WARDEN_TIME_ZONE_CODE = "AEDT";

const WARDEN_TYPE_SHORTCUT_CALLBACK_ID = "warden_type_shortcut";
const WARDEN_TYPE_MODAL_CALLBACK_ID = "warden_type_modal";
const WARDEN_TYPE_MODAL_BLOCK_ID = "warden_type_block";
const WARDEN_TYPE_MODAL_ACTION_ID = "warden_type_input";

const COMMANDS_HELP_TEXT = [
  "warden commands:",
  "",
  '- !warden dr "text" yes|no 12:00pm [timezone] -> create daily reminder',
  "- !warden dr-list -> list all reminders",
  "- !warden dr-del <id> -> delete one reminder",
  "- !warden dr-del-all -> delete all reminders",
  "- !warden type <text> -> post as warden bot and delete your command",
  "- !warden help -> show this command list",
  "- !warden forget -> clear memory for this thread (warden only)",
].join("\n");

const TIME_ZONE_ALIASES = {
  AEDT: "Australia/Sydney",
  AEST: "Australia/Sydney",
  UTC: "Etc/UTC",
  GMT: "Etc/UTC",
};

const threadKey = (channel, thread_ts) => `warden:thread:${channel}:${thread_ts}`;
const userIdentityKey = (userId) => `warden:user_identity:${userId}`;
const botNameKey = (botId) => `warden:bot_name:${botId}`;
const repliedKey = (channel, thread_ts) => `warden:replied:${channel}:${thread_ts}`;

const resolveTimeZone = (timeZoneToken) => {
  const trimmed = (timeZoneToken || "").trim();
  if (!trimmed) {
    return { timeZoneCode: DEFAULT_WARDEN_TIME_ZONE_CODE, timeZone: DEFAULT_WARDEN_TIME_ZONE };
  }
  const upper = trimmed.toUpperCase();
  if (TIME_ZONE_ALIASES[upper]) return { timeZoneCode: upper, timeZone: TIME_ZONE_ALIASES[upper] };
  return null;
};

const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const parseDailyReminderCommand = (rawText) => {
  const text = rawText?.trim() || "";
  const match = text.match(
    /^!warden\s+dr\s+"([^"]+)"\s+(yes|no)\s+([0-9]{1,2}:[0-9]{2}(?:am|pm))(?:\s+([A-Za-z_\/+\-]+))?$/i
  );
  if (!match) return { ok: false, reason: "format" };

  const reminderText = match[1].trim();
  const pingWarden = match[2].toLowerCase() === "yes";
  const timeRaw = match[3].toLowerCase();
  const timeZoneRaw = match[4] || DEFAULT_WARDEN_TIME_ZONE_CODE;

  const resolvedTimeZone = resolveTimeZone(timeZoneRaw);
  if (!resolvedTimeZone) return { ok: false, reason: "timezone_alias", providedTimeZone: timeZoneRaw };

  const { timeZoneCode, timeZone } = resolvedTimeZone;
  const timeMatch = timeRaw.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!timeMatch) return { ok: false, reason: "format" };

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3];

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return { ok: false, reason: "format" };
  if (!isValidTimeZone(timeZone)) return { ok: false, reason: "timezone", providedTimeZone: timeZoneRaw };

  if (period === "am") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  return { ok: true, reminderText, pingWarden, time24: `${hh}:${mm}`, timeRaw, timeZoneCode, timeZone };
};

const callSlackApi = async (env, method, payload) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
};

const postSlackMessage = async (env, payload) => callSlackApi(env, "chat.postMessage", payload);

async function getCachedKV(env, key) {
  if (!env.WARDEN_KV) return null;
  try {
    return await env.WARDEN_KV.get(key);
  } catch {
    return null;
  }
}

async function setCachedKV(env, key, value, ttlSeconds) {
  if (!env.WARDEN_KV) return;
  try {
    await env.WARDEN_KV.put(key, value, ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch {}
}

async function getSlackUserIdentity(env, userId) {
  if (!userId) return { username: "unknown", display: "unknown", real: "unknown" };

  const cachedRaw = await getCachedKV(env, userIdentityKey(userId));
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  try {
    const info = await callSlackApi(env, "users.info", { user: userId });
    const user = info?.user;
    const profile = user?.profile;

    // Slack handle/username
    const username = user?.name || userId;
    const display = profile?.display_name || profile?.real_name || username;
    const real = profile?.real_name || display;

    const identity = { username, display, real };
    await setCachedKV(env, userIdentityKey(userId), JSON.stringify(identity), 60 * 60 * 24 * 7);
    return identity;
  } catch (e) {
    console.log("users.info failed:", e);
    return { username: userId, display: userId, real: userId };
  }
}

async function getSlackBotDisplayName(env, botId) {
  if (!botId) return "unknown-bot";
  const cached = await getCachedKV(env, botNameKey(botId));
  if (cached) return cached;

  try {
    const info = await callSlackApi(env, "bots.info", { bot: botId });
    const name = info?.bot?.name || botId;
    await setCachedKV(env, botNameKey(botId), name, 60 * 60 * 24 * 7);
    return name;
  } catch (e) {
    console.log("bots.info failed:", e);
    return botId;
  }
}

function firstSentence(text) {
  const t = (text || "").trim();
  if (!t) return "";
  const first = t.split(/[\n\.\!\?]/)[0].trim();
  return first || t;
}

// Strip the old "Warden (user:...): " prefix so the model stops mimicking it.
function sanitizeHistory(messages) {
  const strip = (s) =>
    String(s || "")
      .replace(/^Warden\s*\(user:[^)]+\):\s*/i, "")
      .replace(/^the warden\s*\(user:[^)]+\):\s*/i, "");

  return (messages || []).map((m) => {
    if (!m || typeof m !== "object") return m;
    if (typeof m.content !== "string") return m;
    return { ...m, content: strip(m.content) };
  });
}

async function loadThreadMessages(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return [];
  if (!channel || !thread_ts) return [];

  const raw = await env.WARDEN_KV.get(threadKey(channel, thread_ts));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    return sanitizeHistory(arr);
  } catch {
    return [];
  }
}

async function saveThreadMessages(env, channel, thread_ts, messages) {
  if (!env.WARDEN_KV) return;
  if (!channel || !thread_ts) return;

  const sanitized = sanitizeHistory(messages);
  const trimmed = sanitized.slice(-THREAD_MEMORY_MAX_MESSAGES);
  await env.WARDEN_KV.put(threadKey(channel, thread_ts), JSON.stringify(trimmed), {
    expirationTtl: THREAD_MEMORY_TTL_SECONDS,
  });
}

async function hasWardenReplied(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return false;
  const replied = await env.WARDEN_KV.get(repliedKey(channel, thread_ts));
  return replied === "1";
}

async function markWardenReplied(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return;
  await env.WARDEN_KV.put(repliedKey(channel, thread_ts), "1", { expirationTtl: 86400 });
}

const loadDailyReminders = async (env) => {
  if (!env.WARDEN_KV) return [];
  const raw = await env.WARDEN_KV.get(REMINDER_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveDailyReminders = async (env, reminders) => {
  if (!env.WARDEN_KV) return;
  await env.WARDEN_KV.put(REMINDER_KV_KEY, JSON.stringify(reminders));
};

const getNowInTimeZone = (timeZone, date = new Date()) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  return { ymd: `${pick("year")}-${pick("month")}-${pick("day")}`, hm: `${pick("hour")}:${pick("minute")}` };
};

export default {
  async fetch(request, env) {
    async function getGrokReply(env, threadMessages) {
      try {
        const res = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.HACKCLUB_AI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "moonshotai/kimi-k2-0905",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "system",
                content:
                  "Style rule: NEVER prefix replies with 'Warden (user:...)', 'the warden:', or any speaker label. Reply with only the message text.",
              },
              ...(threadMessages || []),
            ],
          }),
        });

        const data = await res.json();
        return data?.choices?.[0]?.message?.content ?? "bruh, even the AI doesn't know what to say.";
      } catch (err) {
        console.log("Grok API error:", err);
        return "bruh, even the AI doesn't know what to say.";
      }
    }

    let body;
    const contentType = request.headers.get("content-type") || "";
    try {
      if (contentType.includes("application/json")) {
        body = await request.json();
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const rawForm = await request.text();
        const formParams = new URLSearchParams(rawForm);
        if (formParams.has("payload")) {
          const decoded = decodeURIComponent(formParams.get("payload"));
          body = JSON.parse(decoded);
        } else {
          body = Object.fromEntries(formParams.entries());
        }
      } else {
        throw new Error("Unsupported content-type: " + contentType);
      }
    } catch (e) {
      console.log("Failed to parse JSON:", e);
      return new Response("Invalid JSON", { status: 400 });
    }

    const isSlashCommand = Boolean(body.command);
    const ack = () => new Response(isSlashCommand ? "" : "ok", { status: 200 });

    if (body.type === "url_verification") {
      return new Response(body.challenge, { status: 200 });
    }

    const event = body.event;

    if (event && event.type === "message" && !event.subtype) {
      const channel = event.channel;
      const thread_ts = event.thread_ts || event.ts;
      const rawText = event.text || "";
      const trimmedText = rawText.trim();
      const normalizedText = trimmedText.toLowerCase();

      // ignore "##" (not stored, not replied)
      if (normalizedText.startsWith("##")) return ack();

      const senderUserId = event.user || null;
      const botId = event.bot_id || null;
      const isBotMessage = Boolean(botId);

      // Store EVERY message in thread memory
      if (env.WARDEN_KV && channel && thread_ts) {
        const history = await loadThreadMessages(env, channel, thread_ts);

        const isWardenUserMessage = !isBotMessage && senderUserId === WARDEN_USER_ID;

        if (isWardenUserMessage) {
          // store warden raw only
          history.push({ role: "assistant", content: trimmedText });
        } else if (isBotMessage) {
          const botName = event.username || (await getSlackBotDisplayName(env, botId));
          history.push({ role: "user", content: `${botName} (bot:${botId}): ${trimmedText}` });
        } else {
          const ident = await getSlackUserIdentity(env, senderUserId);
          history.push({
            role: "user",
            content: `@${ident.username} | ${ident.display} (user:${senderUserId}): ${trimmedText}`,
          });
        }

        await saveThreadMessages(env, channel, thread_ts, history);
      }

      // Never reply to bots or itself
      if (isBotMessage || senderUserId === WARDEN_USER_ID) return ack();

      // Warden-only: forget memory for this thread
      if (normalizedText === "!warden forget") {
        if (senderUserId !== WARDEN_USER_ID) {
          await postSlackMessage(env, { channel, thread_ts, text: "nah" });
          return ack();
        }
        if (env.WARDEN_KV) {
          await env.WARDEN_KV.delete(threadKey(channel, thread_ts));
          await env.WARDEN_KV.delete(repliedKey(channel, thread_ts));
        }
        await postSlackMessage(env, { channel, thread_ts, text: "forgot this thread" });
        return ack();
      }

      // Should reply? (C-ish but not spammy)
      // - If warden already participated, keep chatting.
      // - Else respond if message looks like an actual ask (question or short direct ask) or mentions warden.
      const looksLikeQuestion =
        normalizedText.includes("?") || /^\s*(who|what|why|how|when|where|can|do|does|is|are|should)\b/i.test(trimmedText);
      const directAsk = trimmedText.length <= 40;

      let shouldReply = false;
      if (normalizedText.includes("warden")) shouldReply = true;
      else if (await hasWardenReplied(env, channel, thread_ts)) shouldReply = true;
      else if (looksLikeQuestion) shouldReply = true;
      else if (directAsk) shouldReply = true;

      if (!shouldReply) return ack();

      const history = await loadThreadMessages(env, channel, thread_ts);
      const aiReplyRaw = await getGrokReply(env, history);
      const aiReply = firstSentence(aiReplyRaw) || "bruh, even the AI doesn't know what to say.";

      // Store assistant raw only
      history.push({ role: "assistant", content: aiReply });
      await saveThreadMessages(env, channel, thread_ts, history);

      await postSlackMessage(env, { channel, thread_ts, text: aiReply });
      await markWardenReplied(env, channel, thread_ts);

      return ack();
    }

    return ack();
  },

  async scheduled(controller, env) {
    if (!env.WARDEN_KV || !env.SLACK_BOT_TOKEN) return;

    const reminders = await loadDailyReminders(env);
    if (!reminders.length) return;

    const runDate = controller?.scheduledTime ? new Date(controller.scheduledTime) : new Date();
    const prevMinuteDate = new Date(runDate.getTime() - 60_000);

    for (const reminder of reminders) {
      const tz = reminder.timeZone || DEFAULT_WARDEN_TIME_ZONE;
      if (!isValidTimeZone(tz)) continue;

      const now = getNowInTimeZone(tz, runDate);
      const prevMinute = getNowInTimeZone(tz, prevMinuteDate);

      const matchesCurrentMinute = reminder.time24 === now.hm;
      const matchesPreviousMinute = reminder.time24 === prevMinute.hm;
      if (!matchesCurrentMinute && !matchesPreviousMinute) continue;

      const fireYmd = matchesCurrentMinute ? now.ymd : prevMinute.ymd;
      const dedupeKey = `warden:daily_reminder_fired:${reminder.id}:${fireYmd}`;
      const alreadyFired = await env.WARDEN_KV.get(dedupeKey);
      if (alreadyFired) continue;

      const pingPrefix = reminder.pingWarden ? `<@${WARDEN_USER_ID}> ` : "";
      const payload = { channel: reminder.channel, text: `${pingPrefix}${reminder.text}` };

      const data = await postSlackMessage(env, payload);
      if (data.ok) {
        await env.WARDEN_KV.put(dedupeKey, "1", { expirationTtl: 172800 });
      }
    }
  },
};