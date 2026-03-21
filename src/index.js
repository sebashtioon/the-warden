// --- Generic KV JSON helpers ---
const getKVJson = async (kv, key, fallback = []) => {
  if (!kv) return fallback;
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const putKVJson = async (kv, key, value, options = {}) => {
  if (!kv) return;
  await kv.put(key, JSON.stringify(value), options);
};
import SYSTEM_PROMPT from "../prompt/prompt.md";

const THREAD_MEMORY_TTL_SECONDS = 60 * 60 * 24; // 1 day
const THREAD_MEMORY_MAX_MESSAGES = 20;

/**
 * Generates a unique KV storage key for a Slack thread's message history.
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Slack thread timestamp
 * @returns {string} KV key
 */
const getThreadKey = (channel, thread_ts) => `warden:thread:${channel}:${thread_ts}`;


/**
 * Retrieves and parses the JSON message history for a specific thread from KV storage.
 * @param {object} env - Environment object with WARDEN_KV
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Slack thread timestamp
 * @returns {Promise<Array>} Message history array
 */
const loadThreadMessages = async (env, channel, thread_ts) => {
  if (!env.WARDEN_KV || !channel || !thread_ts) return [];
  return getKVJson(env.WARDEN_KV, getThreadKey(channel, thread_ts));
};


/**
 * Trims history to the maximum allowed and persists the JSON array to KV storage with a 1-day TTL.
 * @param {object} env - Environment object with WARDEN_KV
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Slack thread timestamp
 * @param {Array} messages - Message history array
 */
const saveThreadMessages = async (env, channel, thread_ts, messages) => {
  if (!env.WARDEN_KV || !channel || !thread_ts) return;
  const trimmed = messages.slice(-THREAD_MEMORY_MAX_MESSAGES);
  await putKVJson(env.WARDEN_KV, getThreadKey(channel, thread_ts), trimmed, { expirationTtl: THREAD_MEMORY_TTL_SECONDS });
};


/**
 * Checks if "warden" or the bot's specific User ID is present in a text string.
 * @param {string} text - Message text
 * @param {string} wardenUserId - Bot user ID
 * @returns {boolean}
 */
const messageMentionsWarden = (text, wardenUserId) => {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes("warden") || text.includes(`<@${wardenUserId}>`);
};


/**
 * Checks KV storage for a flag indicating the bot has already participated in a specific thread.
 * @param {object} env - Environment object with WARDEN_KV
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Slack thread timestamp
 * @returns {Promise<boolean>}
 */
const threadHasWardenReply = async (env, channel, thread_ts) => {
  if (!env.WARDEN_KV) return false;
  const repliedKey = `warden:replied:${channel}:${thread_ts}`;
  const replied = await env.WARDEN_KV.get(repliedKey);
  return replied === "1";
};

/**
 * Sets a flag in KV storage (1-day TTL) to mark that the bot has replied to a thread.
 * @param {object} env - Environment object with WARDEN_KV
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Slack thread timestamp
 */
const markThreadWardenReplied = async (env, channel, thread_ts) => {
  if (!env.WARDEN_KV) return;
  const repliedKey = `warden:replied:${channel}:${thread_ts}`;
  await env.WARDEN_KV.put(repliedKey, "1", { expirationTtl: 86400 });
};

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

/**
 * Maps common aliases (e.g., AEDT, UTC) to IANA time zone strings or returns the default.
 * @param {string} timeZoneToken
 * @returns {object|null}
 */
const resolveTimeZone = (timeZoneToken) => {
  const trimmed = (timeZoneToken || "").trim();
  if (!trimmed) {
    return {
      timeZoneCode: DEFAULT_WARDEN_TIME_ZONE_CODE,
      timeZone: DEFAULT_WARDEN_TIME_ZONE,
    };
  }

  const upper = trimmed.toUpperCase();
  if (TIME_ZONE_ALIASES[upper]) {
    return {
      timeZoneCode: upper,
      timeZone: TIME_ZONE_ALIASES[upper],
    };
  }

  return null;
};

/**
 * Validates if a string is a valid IANA time zone using Intl.DateTimeFormat.
 * @param {string} timeZone
 * @returns {boolean}
 */
const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

/**
 * Regex parser for the !warden dr command. Extracts reminder text, pings, time, and timezone.
 * @param {string} rawText
 * @returns {object}
 */
const parseReminderCommand = (rawText) => {
  const text = rawText?.trim() || "";
  const match = text.match(
    /^!warden\s+dr\s+"([^"]+)"\s+(yes|no)\s+([0-9]{1,2}:[0-9]{2}(?:am|pm))(?:\s+([A-Za-z_\/+\-]+))?$/i
  );
  if (!match) {
    return { ok: false, reason: "format" };
  }

  const reminderText = match[1].trim();
  const pingWarden = match[2].toLowerCase() === "yes";
  const timeRaw = match[3].toLowerCase();
  const timeZoneRaw = match[4] || DEFAULT_WARDEN_TIME_ZONE_CODE;

  const resolvedTimeZone = resolveTimeZone(timeZoneRaw);
  if (!resolvedTimeZone) {
    return {
      ok: false,
      reason: "timezone_alias",
      providedTimeZone: timeZoneRaw,
    };
  }

  const { timeZoneCode, timeZone } = resolvedTimeZone;
  const timeMatch = timeRaw.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!timeMatch) {
    return { ok: false, reason: "format" };
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3];

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return { ok: false, reason: "format" };
  }

  if (!isValidTimeZone(timeZone)) {
    return {
      ok: false,
      reason: "timezone",
      providedTimeZone: timeZoneRaw,
    };
  }

  if (period === "am") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  return {
    ok: true,
    reminderText,
    pingWarden,
    time24: `${hh}:${mm}`,
    timeRaw,
    timeZoneCode,
    timeZone,
  };
};

/**
 * Generic wrapper for POST requests to the Slack API using the bot token.
 * @param {object} env - Environment object with SLACK_BOT_TOKEN
 * @param {string} method - Slack API method
 * @param {object} payload - Request payload
 * @returns {Promise<object>} Slack API response
 */
const slackApiRequest = async (env, method, payload) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return res.json();
};

/**
 * Convenience wrapper for chat.postMessage.
 * @param {object} env - Environment object with SLACK_BOT_TOKEN
 * @param {object} payload - Message payload
 * @returns {Promise<object>} Slack API response
 */
const sendSlackMessage = async (env, payload) => {
  return slackApiRequest(env, "chat.postMessage", payload);
};

/**
 * Returns a JSON block kit object defining the "Warden Type" modal interface.
 * @param {object} privateMetadata
 * @param {string} [initialText]
 * @returns {object}
 */
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

/**
 * Retrieves the global list of active daily reminders from KV storage.
 * @param {object} env - Environment object with WARDEN_KV
 * @returns {Promise<Array>} Reminders array
 */
const loadDailyReminders = async (env) => {
  if (!env.WARDEN_KV) return [];
  return getKVJson(env.WARDEN_KV, REMINDER_KV_KEY);
};

/**
 * Persists the global list of daily reminders to KV storage.
 * @param {object} env - Environment object with WARDEN_KV
 * @param {Array} reminders
 */
const saveDailyReminders = async (env, reminders) => {
  if (!env.WARDEN_KV) return;
  await putKVJson(env.WARDEN_KV, REMINDER_KV_KEY, reminders);
};

/**
 * Uses Intl.DateTimeFormat to format a date into YYYY-MM-DD and HH:mm for a specific timezone.
 * @param {string} timeZone
 * @param {Date} [date]
 * @returns {object}
 */
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
  return {
    ymd: `${pick("year")}-${pick("month")}-${pick("day")}`,
    hm: `${pick("hour")}:${pick("minute")}`,
  };
};


// --- Top-level helpers moved out of fetch ---
/**
 * Calls the Hack Club AI proxy with a system prompt and message history.
 */
const fetchGrokReply = async (env, messages) => {
  try {
    const res = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HACKCLUB_AI_API_KEY}`,
        "Content-Type": "application/json",
      },
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
};

/**
 * Returns the Block Kit JSON for new member join messages.
 */
const createWelcomeMessage = (userId) => ({
  text: `welcome to the basement <@${userId}>`,
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `welcome to the basement <@${userId}>\n\n\n\n*you find yourself in a dimly lit basement...*\nyoure stuck here forever btw there is no leaving. _throws away keys_\n\nanyways everyone welcome our newest captive! :hii::ultrafastcatppuccinparrot::agadance::seb-when-dubstep:`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":hii:" },
          action_id: "hii_button",
        },
      ],
    },
  ],
});

/**
 * Posts a welcome message and then a threaded reply with rules context.
 */
const postWelcomeAndRulesThread = async (env, channel, userId, logLabel, rulesCanvasUrl) => {
  const welcomePayload = createWelcomeMessage(userId);
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, ...welcomePayload }),
  });

  const data = await res.json();
  console.log(`Slack API response (${logLabel}):`, data);

  if (data.ok && data.ts) {
    const rulesText = `oh btw <@${userId}> read the <${rulesCanvasUrl}|rules> if you want`;
    const threadRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: data.channel || channel,
        thread_ts: data.ts,
        text: rulesText,
      }),
    });

    const threadData = await threadRes.json();
    console.log(`Slack API response (${logLabel} thread):`, threadData);
  }
};

// --- Modular event handlers ---
const handleSlashCommand = async (body, env) => {
  // ...existing logic for slash command...
};

const handleMessageEvent = async (event, env, body, ack, rulesCanvasUrl, joinTestChannelId, joinAnnounceChannelId, joinAnnounceChannel) => {
  // ...existing logic for message event...
};

const handleBlockActions = async (body, env, ack) => {
  // ...existing logic for block_actions...
};

const handleMemberJoin = async (event, env, joinAnnounceChannel, rulesCanvasUrl) => {
  // ...existing logic for member_joined_channel...
};

const handleModalSubmission = async (body, env) => {
  // ...existing logic for view_submission...
};

export default {
  async fetch(request, env) {
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

    // log every event Slack sends
    console.log("Received Slack event:", JSON.stringify(body));

    // Slack URL verification
    if (body.type === "url_verification") {
      return new Response(body.challenge, { status: 200 });
    }

    // Dispatcher pattern
    const isSlashCommand = body.command === "/warden";
    const ack = () => new Response(isSlashCommand ? "" : "ok", { status: 200 });
    const event = body.event || (isSlashCommand ? {
      type: "message",
      user: body.user_id,
      channel: body.channel_id,
      thread_ts: body.thread_ts,
      text: `!warden ${(body.text || "").trim()}`,
    } : null);
    const rulesCanvasUrl = env.RULES_CANVAS_URL || "https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0AL6S8QWFR";
    const joinTestChannelId = "C0ALRPWUTC4";
    const joinAnnounceChannelId = env.JOIN_ANNOUNCE_CHANNEL_ID || "C0A7JH50JG4";
    const joinAnnounceChannel = env.JOIN_ANNOUNCE_CHANNEL || joinAnnounceChannelId;

    if (isSlashCommand) {
      return handleSlashCommand(body, env);
    }
    if (event && event.type === "member_joined_channel" && event.channel === joinAnnounceChannelId) {
      return handleMemberJoin(event, env, joinAnnounceChannel, rulesCanvasUrl);
    }
    if (event && event.type === "message" && !event.bot_id && !event.subtype) {
      return handleMessageEvent(event, env, body, ack, rulesCanvasUrl, joinTestChannelId, joinAnnounceChannelId, joinAnnounceChannel);
    }
    if (body.type === "block_actions") {
      return handleBlockActions(body, env, ack);
    }
    if (body.type === "view_submission" && body.view?.callback_id === WARDEN_TYPE_MODAL_CALLBACK_ID) {
      return handleModalSubmission(body, env);
    }
    return ack();
  },

  async scheduled(controller, env) {
    if (!env.WARDEN_KV || !env.SLACK_BOT_TOKEN) {
      console.log("Scheduled: missing WARDEN_KV or SLACK_BOT_TOKEN binding");
      return;
    }

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
      if (!isValidTimeZone(reminderTimeZone)) {
        console.log("Skipping reminder with invalid timezone:", reminder.id, reminderTimeZone);
        continue;
      }

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
      console.log("Slack API response (daily reminder):", data);

      if (data.ok) {
        await env.WARDEN_KV.put(dedupeKey, "1", { expirationTtl: 172800 });
      }
    }
  },
};