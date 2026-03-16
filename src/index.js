import SYSTEM_PROMPT from "../prompt/prompt.md";

const THREAD_MEMORY_TTL_SECONDS = 60 * 60 * 24; // 1 day
const THREAD_MEMORY_MAX_MESSAGES = 60;

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

async function loadThreadMessages(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return [];
  if (!channel || !thread_ts) return [];

  const raw = await env.WARDEN_KV.get(threadKey(channel, thread_ts));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveThreadMessages(env, channel, thread_ts, messages) {
  if (!env.WARDEN_KV) return;
  if (!channel || !thread_ts) return;

  const trimmed = (messages || []).slice(-THREAD_MEMORY_MAX_MESSAGES);
  await env.WARDEN_KV.put(threadKey(channel, thread_ts), JSON.stringify(trimmed), {
    expirationTtl: THREAD_MEMORY_TTL_SECONDS,
  });
}

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

/**
 * Returns:
 * {
 *   username: "sebashtioon",
 *   display: "Seb",
 *   real: "Sebastian ...",
 * }
 */
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

    const username = user?.name || userId; // THIS is the “actual username/handle”
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

async function hasWardenReplied(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return false;
  const repliedKey = `warden:replied:${channel}:${thread_ts}`;
  const replied = await env.WARDEN_KV.get(repliedKey);
  return replied === "1";
}

async function markWardenReplied(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return;
  const repliedKey = `warden:replied:${channel}:${thread_ts}`;
  await env.WARDEN_KV.put(repliedKey, "1", { expirationTtl: 86400 });
}

function firstSentence(text) {
  const t = (text || "").trim();
  if (!t) return "";
  const first = t.split(/[\n\.\!\?]/)[0].trim();
  return first || t;
}

const buildWardenTypeModal = (privateMetadata, initialText = "") => ({
  type: "modal",
  callback_id: WARDEN_TYPE_MODAL_CALLBACK_ID,
  private_metadata: JSON.stringify(privateMetadata),
  title: { type: "plain_text", text: "Warden Type" },
  submit: { type: "plain_text", text: "Send" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: WARDEN_TYPE_MODAL_BLOCK_ID,
      label: { type: "plain_text", text: "Message" },
      element: {
        type: "plain_text_input",
        action_id: WARDEN_TYPE_MODAL_ACTION_ID,
        multiline: true,
        initial_value: initialText,
      },
    },
  ],
});

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
    async function getGrokReply(env, messages) {
      try {
        const res = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.HACKCLUB_AI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "moonshotai/kimi-k2-0905",
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...(messages || [])],
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

    const isSlashCommand = body.command === "/warden";
    const slashCommandEvent = isSlashCommand
      ? { type: "message", user: body.user_id, channel: body.channel_id, thread_ts: body.thread_ts, text: `!warden ${(body.text || "").trim()}` }
      : null;

    const ack = () => new Response(isSlashCommand ? "" : "ok", { status: 200 });

    if (body.type === "url_verification") {
      return new Response(body.challenge, { status: 200 });
    }

    // message shortcut -> open modal
    if (body.type === "message_action" && body.callback_id === WARDEN_TYPE_SHORTCUT_CALLBACK_ID) {
      if (body.user?.id !== WARDEN_USER_ID) return new Response("", { status: 200 });

      const privateMetadata = {
        channel: body.channel?.id,
        thread_ts: body.message?.thread_ts || body.message?.ts || body.message_ts || null,
      };

      const openData = await callSlackApi(env, "views.open", {
        trigger_id: body.trigger_id,
        view: buildWardenTypeModal(privateMetadata, body.message?.text || ""),
      });

      console.log("Slack API response (warden type modal open):", openData);
      return new Response("", { status: 200 });
    }

    // modal submit -> post
    if (body.type === "view_submission" && body.view?.callback_id === WARDEN_TYPE_MODAL_CALLBACK_ID) {
      if (body.user?.id !== WARDEN_USER_ID) {
        return new Response(
          JSON.stringify({
            response_action: "errors",
            errors: { [WARDEN_TYPE_MODAL_BLOCK_ID]: "only warden can use this" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const modalText =
        body.view?.state?.values?.[WARDEN_TYPE_MODAL_BLOCK_ID]?.[WARDEN_TYPE_MODAL_ACTION_ID]?.value?.trim() || "";

      if (!modalText) {
        return new Response(
          JSON.stringify({
            response_action: "errors",
            errors: { [WARDEN_TYPE_MODAL_BLOCK_ID]: "message cant be empty" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      let privateMetadata = {};
      try {
        privateMetadata = JSON.parse(body.view?.private_metadata || "{}");
      } catch {
        privateMetadata = {};
      }

      const payload = { channel: privateMetadata.channel, text: modalText };
      if (privateMetadata.thread_ts) payload.thread_ts = privateMetadata.thread_ts;

      await postSlackMessage(env, payload);

      // store warden message in memory (raw only)
      const channel = privateMetadata.channel;
      const thread_ts = privateMetadata.thread_ts;
      if (env.WARDEN_KV && channel && thread_ts) {
        const history = await loadThreadMessages(env, channel, thread_ts);
        history.push({ role: "assistant", content: modalText });
        await saveThreadMessages(env, channel, thread_ts, history);
      }

      return new Response(JSON.stringify({ response_action: "clear" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const event = body.event || slashCommandEvent;

    // ============================
    // Main message handler
    // ============================
    if (event && event.type === "message" && !event.subtype) {
      const channel = event.channel;
      const thread_ts = event.thread_ts || event.ts;
      const rawText = event.text || "";
      const trimmedText = rawText.trim();
      const normalizedText = trimmedText.toLowerCase();

      // ignore ##
      if (normalizedText.startsWith("##")) return ack();

      const senderUserId = event.user || null;
      const botId = event.bot_id || null;
      const isBotMessage = Boolean(botId);

      // store EVERY message (except ##) with sender identity
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
          // prefer actual username, but include display too
          history.push({
            role: "user",
            content: `@${ident.username} | ${ident.display} (user:${senderUserId}): ${trimmedText}`,
          });
        }

        await saveThreadMessages(env, channel, thread_ts, history);
      }

      // never reply to bots or itself
      if (isBotMessage || senderUserId === WARDEN_USER_ID) return ack();

      // Decide if we should reply
      const isDM = typeof channel === "string" && channel.startsWith("D");

      let shouldReply = false;

      // Always reply in DMs (so you don't have to type "warden")
      if (isDM) {
        shouldReply = true;
      } else if (normalizedText.includes("warden")) {
        shouldReply = true;
      } else if (thread_ts && (await hasWardenReplied(env, channel, thread_ts))) {
        shouldReply = true;
      }

      if (shouldReply) {
        const history = await loadThreadMessages(env, channel, thread_ts);
        const aiReplyRaw = await getGrokReply(env, history);
        const aiReply = firstSentence(aiReplyRaw) || "bruh, even the AI doesn't know what to say.";

        history.push({ role: "assistant", content: aiReply });
        await saveThreadMessages(env, channel, thread_ts, history);

        await postSlackMessage(env, { channel, thread_ts, text: aiReply });
        await markWardenReplied(env, channel, thread_ts);
      }

      return ack();
    }

    // Button interactions
    if (body.type === "block_actions") {
      if (body.actions && body.actions[0].action_id === "hii_button") {
        const userId = body.user.id;
        const channel = body.channel.id;
        const messageTs = body.message.ts;
        await postSlackMessage(env, { channel, thread_ts: messageTs, text: `:hii: from <@${userId}>` });
        return ack();
      }
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
      const resolvedByCode = resolveTimeZone(reminder.timeZoneCode || "");
      const resolvedByStoredValue = resolveTimeZone(reminder.timeZone || "");
      const resolvedReminderTz = isValidTimeZone(reminder.timeZone)
        ? reminder.timeZone
        : (resolvedByCode?.timeZone || resolvedByStoredValue?.timeZone);

      const reminderTimeZone = resolvedReminderTz || DEFAULT_WARDEN_TIME_ZONE;
      if (!isValidTimeZone(reminderTimeZone)) continue;

      const now = getNowInTimeZone(reminderTimeZone, runDate);
      const prevMinute = getNowInTimeZone(reminderTimeZone, prevMinuteDate);

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