import SYSTEM_PROMPT from "../prompt/prompt.md";

const THREAD_MEMORY_TTL_SECONDS = 60 * 60 * 24; // 1 day
const THREAD_MEMORY_MAX_MESSAGES = 80;

const WARDEN_USER_ID = "U094HHPS5B8";

const threadKey = (channel, thread_ts) => `warden:thread:${channel}:${thread_ts}`;
const userIdentityKey = (userId) => `warden:user_identity:${userId}`;
const botNameKey = (botId) => `warden:bot_name:${botId}`;
const repliedKey = (channel, thread_ts) => `warden:replied:${channel}:${thread_ts}`;

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

    const username = user?.name || userId; // actual slack handle
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

// Decide if we should ignore this message event entirely (edits/deletes/etc)
function isIgnorableMessageEvent(event) {
  const subtype = event.subtype;
  // ignore edits/deletes; they cause duplicates/confusion
  if (subtype === "message_changed") return true;
  if (subtype === "message_deleted") return true;
  return false;
}

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

    // Always ack quickly
    const ack = () => new Response(body.command ? "" : "ok", { status: 200 });

    if (body.type === "url_verification") {
      return new Response(body.challenge, { status: 200 });
    }

    // Support both message + app_mention
    const event = body.event;

    // Normalize to a message-like object
    const isAppMention = event && event.type === "app_mention";
    const isMessage = event && event.type === "message";

    if (!event || (!isMessage && !isAppMention)) {
      return ack();
    }

    const channel = event.channel;
    const rawText = event.text || "";
    const trimmedText = rawText.trim();
    const normalizedText = trimmedText.toLowerCase();

    // ignore ##
    if (normalizedText.startsWith("##")) return ack();

    // Determine thread timestamp
    const thread_ts = event.thread_ts || event.ts;

    // If Slack sends message subtypes, ignore only edits/deletes (not everything)
    if (isMessage && isIgnorableMessageEvent(event)) return ack();

    const senderUserId = event.user || null;
    const botId = event.bot_id || null;
    const isBotMessage = Boolean(botId);

    // Store EVERY event as memory (except ignored edits/deletes and ##)
    if (env.WARDEN_KV && channel && thread_ts) {
      const history = await loadThreadMessages(env, channel, thread_ts);

      const isWardenUserMessage = !isBotMessage && senderUserId === WARDEN_USER_ID;

      if (isWardenUserMessage) {
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

    // Decide reply:
    // - Always reply to app_mention
    // - Reply if "warden" appears
    // - Reply if already participating in thread (C-ish)
    const looksLikeQuestion =
      normalizedText.includes("?") || /^\s*(who|what|why|how|when|where|can|do|does|is|are|should)\b/i.test(trimmedText);
    const directAsk = trimmedText.length <= 40;

    let shouldReply = false;
    if (isAppMention) shouldReply = true;
    else if (normalizedText.includes("warden")) shouldReply = true;
    else if (await hasWardenReplied(env, channel, thread_ts)) shouldReply = true;
    else if (looksLikeQuestion || directAsk) shouldReply = true;

    if (!shouldReply) return ack();

    const history = await loadThreadMessages(env, channel, thread_ts);
    const aiReplyRaw = await getGrokReply(env, history);
    const aiReply = firstSentence(aiReplyRaw) || "bruh, even the AI doesn't know what to say.";

    history.push({ role: "assistant", content: aiReply });
    await saveThreadMessages(env, channel, thread_ts, history);

    await postSlackMessage(env, { channel, thread_ts, text: aiReply });
    await markWardenReplied(env, channel, thread_ts);

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