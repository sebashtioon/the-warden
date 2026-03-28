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
const AI_FAILURE_REPLY = "bruh, even the AI doesn't know what to say.";
const ALLOWED_REACTION_NAMES = new Set([
  "ultrafastcatppuccinparrot",
  "loll",
  "skulk",
  "noooovanish",
  "thumbup",
  "canberraisbetterthansydney",
]);

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
  return (
    lower.includes("warden") ||
    text.includes(`<@${wardenUserId}>`) ||
    lower.includes(WARDEN_PROFILE_URL.toLowerCase())
  );
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

const threadIsLeft = async (env, channel, thread_ts) => {
  if (!env.WARDEN_KV) return false;
  const val = await env.WARDEN_KV.get(`warden:left:${channel}:${thread_ts}`);
  return val === "1";
};

const markThreadLeft = async (env, channel, thread_ts) => {
  if (!env.WARDEN_KV) return;
  await env.WARDEN_KV.put(`warden:left:${channel}:${thread_ts}`, "1", { expirationTtl: 86400 * 7 });
};

const claimMessageEventReply = async (env, channel, eventTs) => {
  if (!channel || !eventTs) return true;
  if (!env.WARDEN_KV) return true;
  const key = `warden:event_action_claim:${channel}:${eventTs}`;
  const seen = await env.WARDEN_KV.get(key);
  if (seen === "1") return false;
  await env.WARDEN_KV.put(key, "1", { expirationTtl: 3600 });
  return true;
};

/**
 * Parses a comma-separated string into a trimmed, non-empty array of values.
 * @param {string|undefined} value - Raw env var value
 * @returns {string[]}
 */
const parseCommaSeparatedList = (value) =>
  value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];

const WARDEN_USER_ID = "U094HHPS5B8";
const WARDEN_PROFILE_URL = "https://hackclub.enterprise.slack.com/team/U0ALL3K13EJ";
const WARDEN_DEDICATED_CHANNEL_ID = "C0ANV0ZJDR6";
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
  "- !warden leave -> stop replying to this thread",
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

// Backward-compatible alias used by existing command handlers.
const parseDailyReminderCommand = parseReminderCommand;

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
 * Convenience wrapper for reactions.add.
 * @param {object} env - Environment object with SLACK_BOT_TOKEN
 * @param {object} payload - Reaction payload
 * @returns {Promise<object>} Slack API response
 */
const addSlackReaction = async (env, payload) => {
  return slackApiRequest(env, "reactions.add", payload);
};

// Backward-compatible aliases used throughout existing handlers.
const callSlackApi = slackApiRequest;
const postSlackMessage = sendSlackMessage;

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
const fetchGrokReply = async (env, messages, options = {}) => {
  const { requireReply = false } = options;
  const configuredKey = env.HACKCLUB_AI_API_KEY || env.OPENROUTER_API_KEY;
  if (!configuredKey) {
    console.log("Missing AI API key binding (HACKCLUB_AI_API_KEY or OPENROUTER_API_KEY)");
    return requireReply ? `reply: ${AI_FAILURE_REPLY}\nreaction:` : "reply:\nreaction:";
  }

  const isOpenRouterKey = configuredKey.startsWith("sk-or-v1-");
  const aiUrl = isOpenRouterKey
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://ai.hackclub.com/proxy/v1/chat/completions";

  try {
    const res = await fetch(aiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuredKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2-0905",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...(messages || [])],
      }),
      });

    const data = await res.json();
    if (!res.ok) {
      console.log("AI API non-OK response:", {
        status: res.status,
        endpoint: aiUrl,
        error: data?.error || data,
      });
      return requireReply ? `reply: ${AI_FAILURE_REPLY}\nreaction:` : "reply:\nreaction:";
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.log("AI API missing choices content:", { endpoint: aiUrl, response: data });
      return requireReply ? `reply: ${AI_FAILURE_REPLY}\nreaction:` : "reply:\nreaction:";
    }

    return content;
  } catch (err) {
    console.log("Grok API error:", err);
    return requireReply ? `reply: ${AI_FAILURE_REPLY}\nreaction:` : "reply:\nreaction:";
  }
};

/**
 * Parses the model's structured control response into a Slack reply and/or reaction.
 * Expected format:
 * reply: <text or blank>
 * reaction: <custom_emoji_name or blank>
 * @param {string} raw
 * @param {object} [options]
 * @param {boolean} [options.requireReply]
 * @returns {{reply: string, reaction: string}}
 */
const parseAssistantAction = (raw, options = {}) => {
  const { requireReply = false } = options;
  const text = typeof raw === "string" ? raw.split("\r").join("").trim() : "";
  if (!text) {
    return { reply: requireReply ? AI_FAILURE_REPLY : "", reaction: "" };
  }

  const lines = text.split("\n");
  const getStructuredValue = (prefix) => {
    const normalizedPrefix = prefix.toLowerCase();
    for (const line of lines) {
      const trimmedLine = line.trimStart();
      const lowerLine = trimmedLine.toLowerCase();
      if (!lowerLine.startsWith(normalizedPrefix)) continue;

      const remainder = trimmedLine.slice(prefix.length).trimStart();
      if (!remainder.startsWith(":")) continue;
      return remainder.slice(1).trim();
    }
    return "";
  };

  const normalizeReaction = (value) => {
    const trimmed = (value || "").trim();
    let start = 0;
    let end = trimmed.length;

    while (start < end && trimmed[start] === ":") start += 1;
    while (end > start && trimmed[end - 1] === ":") end -= 1;

    const normalized = trimmed.slice(start, end);
    if (!normalized || normalized.toLowerCase() === "none") return "";
    if (!ALLOWED_REACTION_NAMES.has(normalized)) return "";
    return normalized;
  };

  const reply = getStructuredValue("reply");
  const reaction = normalizeReaction(getStructuredValue("reaction"));

  if (!text.toLowerCase().includes("reply:") && !text.toLowerCase().includes("reaction:")) {
    return {
      reply: text,
      reaction: "",
    };
  }

  if (reply || !requireReply) {
    return { reply, reaction };
  }

  const fallbackReply = lines
    .filter((line) => {
      const lower = line.trimStart().toLowerCase();
      return !lower.startsWith("reaction:") && !lower.startsWith("reply:");
    })
    .join("\n")
    .trim();

  return {
    reply: fallbackReply || AI_FAILURE_REPLY,
    reaction,
  };
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

export default {
  async fetch(request, env, ctx) {
    let body;
    const contentType = request.headers.get("content-type") || "";

    try {
      if (contentType.includes("application/json")) {
        body = await request.json();
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const rawForm = await request.text();
        const formParams = new URLSearchParams(rawForm);
        // Interactive events send payload=<urlencoded JSON> while slash commands send plain fields.
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

    // Message shortcut -> open Warden type modal
    if (body.type === "message_action" && body.callback_id === WARDEN_TYPE_SHORTCUT_CALLBACK_ID) {
      if (body.user?.id !== WARDEN_USER_ID) {
        return new Response("", { status: 200 });
      }

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

    // Modal submit -> post as Warden in channel/thread
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

      const sent = await postSlackMessage(env, payload);
      console.log("Slack API response (warden type modal send):", sent);

      return new Response(JSON.stringify({ response_action: "clear" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const isSlashCommand = body.command === "/warden";
    const slashCommandEvent = isSlashCommand
      ? {
          type: "message",
          user: body.user_id,
          channel: body.channel_id,
          thread_ts: body.thread_ts,
          text: `!warden ${(body.text || "").trim()}`,
        }
      : null;

    const ack = () => new Response(isSlashCommand ? "" : "ok", { status: 200 });

    const event = body.event || slashCommandEvent;
    const rulesCanvasUrl =
      env.RULES_CANVAS_URL || "https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0AL6S8QWFR";

    const joinTestChannelId = "C0ALRPWUTC4";
    const joinAnnounceChannelId = env.JOIN_ANNOUNCE_CHANNEL_ID || "C0A7JH50JG4";
    const joinAnnounceChannel = env.JOIN_ANNOUNCE_CHANNEL || joinAnnounceChannelId;
    const extraChannelIds = parseCommaSeparatedList(env.CHANNEL_WHITELIST);
    const allowedChannelIds = new Set([joinTestChannelId, joinAnnounceChannelId, WARDEN_DEDICATED_CHANNEL_ID, ...extraChannelIds]);

    const buildWelcomeMessage = (userId) => ({
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

    const sendWelcomeAndRulesThread = async (channel, userId, logLabel) => {
      const welcomePayload = buildWelcomeMessage(userId);
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

    // Handle users joining the public announce channel
    if (event && event.type === "member_joined_channel" && event.channel === joinAnnounceChannelId) {
      const user = event.user;
      console.log("User joined announce channel:", user, "channel:", event.channel);
      await sendWelcomeAndRulesThread(joinAnnounceChannel, user, "member_joined_channel");
    }

    // Handle keyword replies
    if (event && event.type === "message" && !event.bot_id && !event.subtype) {
      const text = event.text?.toLowerCase() || "";
      const channel = event.channel;
      const thread_ts = event.thread_ts || event.ts;
      const rawText = event.text || "";
      const trimmedText = rawText.trim();
      const normalizedText = trimmedText.toLowerCase();

      if (!allowedChannelIds.has(channel)) {
        return ack();
      }

      // NEW: ignore messages prefixed with "##"
      if (normalizedText.startsWith("##")) {
        console.log("Ignoring ##-prefixed message");
        return ack();
      }

      console.log(`Message in channel ${channel}: "${text}"`);

      // warden command: !warden dr "..." yes|no 12:00pm
      if (normalizedText.startsWith("!warden")) {
        if (normalizedText === "!warden") {
          const bareWarden = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "bro what do you want im tryna sleep",
          });
          console.log("Slack API response (warden bare command):", bareWarden);
          return ack();
        }

        if (normalizedText === "!warden leave") {
          await markThreadLeft(env, channel, thread_ts);
          const leaveReply = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "aight im out :noooovanish:",
          });
          console.log("Slack API response (warden leave):", leaveReply);
          return ack();
        }

        if (event.user !== WARDEN_USER_ID) {
          const denied = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "ay look...\n\nthis guy really tried to use warden commands :loll:",
          });
          console.log("Slack API response (warden unauthorized):", denied);
          return ack();
        }

        const typeMatch = rawText.match(/^!warden\s+type\s+([\s\S]+)$/i);
        if (typeMatch) {
          const typeText = typeMatch[1].trim();
          if (!typeText) {
            const typeHelp = await postSlackMessage(env, {
              channel,
              thread_ts,
              text: "usage: !warden type your message here :loll:",
            });
            console.log("Slack API response (warden type help):", typeHelp);
            return ack();
          }

          const typed = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: typeText,
          });
          console.log("Slack API response (warden type post):", typed);

          if (event.ts) {
            const deleteRes = await fetch("https://slack.com/api/chat.delete", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ channel, ts: event.ts }),
            });
            const deleteData = await deleteRes.json();
            console.log("Slack API response (warden type delete command):", deleteData);
          }
          return ack();
        }

        const wardenRestText = trimmedText.replace(/^!warden\s*/i, "").trim();
        const isKnownSubcommand = /^(help|leave$|dr\s|dr-list$|dr-del-all$|dr-del\s)/i.test(wardenRestText);

        if (wardenRestText && !isKnownSubcommand) {
          const typed = await postSlackMessage(env, { channel, thread_ts, text: wardenRestText });
          console.log("Slack API response (warden inferred type post):", typed);

          if (event.ts) {
            const deleteRes = await fetch("https://slack.com/api/chat.delete", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ channel, ts: event.ts }),
            });
            const deleteData = await deleteRes.json();
            console.log("Slack API response (warden inferred type delete command):", deleteData);
          }

          return ack();
        }

        if (!env.WARDEN_KV) {
          const kvError = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "i cant save reminders yet. bind a KV namespace as WARDEN_KV and redeploy bozo",
          });
          console.log("Slack API response (warden missing kv):", kvError);
          return ack();
        }

        if (normalizedText === "!warden help") {
          const helpReply = await postSlackMessage(env, { channel, thread_ts, text: COMMANDS_HELP_TEXT });
          console.log("Slack API response (warden help):", helpReply);
          return ack();
        }

        const listMatch = trimmedText.match(/^!warden\s+dr-list$/i);
        if (listMatch) {
          const reminders = await loadDailyReminders(env);
          if (!reminders.length) {
            const emptyList = await postSlackMessage(env, {
              channel,
              thread_ts,
              text: "alr bro heres your reminder list:\n\n(no reminders yet)",
            });
            console.log("Slack API response (warden list empty):", emptyList);
            return ack();
          }

          const lines = reminders.map(
            (r, i) =>
              `${i + 1}. id: ${r.id}\n   reminder: "${r.text}"\n   schedule: ${r.timeRaw} (${r.time24}) ${
                r.timeZoneCode || DEFAULT_WARDEN_TIME_ZONE_CODE
              }\n   ping warden: ${r.pingWarden ? "yes" : "no"}`
          );

          const listResponse = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: `alr bro heres your reminder list:\n\n${lines.join("\n\n")}`,
          });

          console.log("Slack API response (warden list):", listResponse);
          return ack();
        }

        const deleteAllMatch = trimmedText.match(/^!warden\s+dr-del-all$/i);
        if (deleteAllMatch) {
          const reminders = await loadDailyReminders(env);
          await saveDailyReminders(env, []);

          const deleteAllText =
            reminders.length === 0
              ? "damn what did all the reminders do?? :noooovanish:\n\n(deleted 0 reminders) :loll:"
              : `damn what did all the reminders do?? :noooovanish:\n\n(deleted ${reminders.length} reminder${
                  reminders.length === 1 ? "" : "s"
                })`;

          const deletedAll = await postSlackMessage(env, { channel, thread_ts, text: deleteAllText });
          console.log("Slack API response (warden delete all):", deletedAll);
          return ack();
        }

        const deleteMatch = trimmedText.match(/^!warden\s+dr-del\s+([a-z0-9-]{8,})$/i);
        if (deleteMatch) {
          const reminderId = deleteMatch[1];
          const reminders = await loadDailyReminders(env);
          const nextReminders = reminders.filter((r) => r.id !== reminderId);

          if (nextReminders.length === reminders.length) {
            const missing = await postSlackMessage(env, {
              channel,
              thread_ts,
              text: `no reminder found with id ${reminderId} :loll:`,
            });
            console.log("Slack API response (warden delete missing):", missing);
            return ack();
          }

          await saveDailyReminders(env, nextReminders);
          const deleted = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: `damn what did the reminder do? :noooovanish:\n\n(deleted reminder ${reminderId})`,
          });
          console.log("Slack API response (warden delete):", deleted);
          return ack();
        }

        const parsedCommand = parseDailyReminderCommand(rawText);
        if (!parsedCommand.ok) {
          if (parsedCommand.reason === "timezone" || parsedCommand.reason === "timezone_alias") {
            const tzError = await postSlackMessage(env, {
              channel,
              thread_ts,
              text: `invalid timezone: ${parsedCommand.providedTimeZone}. use only aliases: AEDT, AEST, UTC, GMT.`,
            });
            console.log("Slack API response (warden invalid timezone):", tzError);
            return ack();
          }

          const help = await postSlackMessage(env, { channel, thread_ts, text: "what the fuck is that command bro??? :loll:" });
          console.log("Slack API response (warden invalid format):", help);
          return ack();
        }

        const reminders = await loadDailyReminders(env);
        const reminder = {
          id: crypto.randomUUID(),
          channel,
          text: parsedCommand.reminderText,
          pingWarden: parsedCommand.pingWarden,
          time24: parsedCommand.time24,
          timeRaw: parsedCommand.timeRaw,
          timeZoneCode: parsedCommand.timeZoneCode,
          timeZone: parsedCommand.timeZone,
          createdBy: event.user,
          createdAt: new Date().toISOString(),
        };

        reminders.push(reminder);
        await saveDailyReminders(env, reminders);

        const savedReply = await postSlackMessage(env, {
          channel,
          thread_ts,
          text: `alr gng ive set a daily reminder for "${reminder.text}" at ${reminder.timeRaw} (${reminder.time24}) ${reminder.timeZoneCode}${
            reminder.pingWarden ? ", and youre getting pinged" : ""
          }`,
        });

        console.log("Slack API response (warden saved):", savedReply);
        return ack();
      }

      const mentionsWarden = messageMentionsWarden(rawText, WARDEN_USER_ID);
      const isThreadFollowUp = Boolean(event.thread_ts) && event.thread_ts !== event.ts;
      const hasWardenThreadContext = isThreadFollowUp && (await threadHasWardenReply(env, channel, thread_ts));
      const wardenHasLeft = await threadIsLeft(env, channel, thread_ts);
      const shouldEvaluateWithAi = !wardenHasLeft && (mentionsWarden || hasWardenThreadContext);

      if (shouldEvaluateWithAi && event.ts) {
        const isFirstDelivery = await claimMessageEventReply(env, channel, event.ts);
        if (!isFirstDelivery) {
          console.log("Skipping duplicate Slack delivery for event:", channel, event.ts);
          return ack();
        }
      }

      if (shouldEvaluateWithAi) {
        console.log("Warden action triggered...");
        const runAiReply = async () => {
          try {
            const history = await loadThreadMessages(env, channel, thread_ts);
            history.push({ role: "user", content: `<@${event.user}>: ${rawText}` });
            const aiReplyRaw = await fetchGrokReply(env, history, { requireReply: false });
            const { reply, reaction } = parseAssistantAction(aiReplyRaw, { requireReply: false });

            if (!reply && !reaction) {
              console.log("Warden chose to ignore message");
              return;
            }

            if (reaction && event.ts) {
              const reactionData = await addSlackReaction(env, {
                channel,
                timestamp: event.ts,
                name: reaction,
              });
              console.log("Slack API response (warden reaction):", reactionData);

              if (reactionData?.ok) {
                history.push({ role: "assistant", content: `[reaction:${reaction}]` });
                await saveThreadMessages(env, channel, thread_ts, history);
                await markThreadWardenReplied(env, channel, thread_ts);
              }
            }

            if (!reply) {
              return;
            }

            history.push({ role: "assistant", content: reply });
            await saveThreadMessages(env, channel, thread_ts, history);

            const messageData = await postSlackMessage(env, {
              channel,
              text: reply,
              thread_ts,
            });
            console.log("Slack API response (warden AI):", messageData);

            await markThreadWardenReplied(env, channel, thread_ts);
          } catch (err) {
            console.log("Async Warden reply failed:", err);
          }
        };

        if (ctx?.waitUntil) {
          ctx.waitUntil(runAiReply());
        } else {
          await runAiReply();
        }
      }

      // test: respond with join message if 'join_test' is in the basement channel only
      if (text.includes("join_test") && channel === joinTestChannelId) {
        console.log("Keyword matched: join_test, sending simulated join reply...");
        const simulatedUser = event.user || "test_user";
        await sendWelcomeAndRulesThread(channel, simulatedUser, "join_test");
      }
    }

    // Handle Slack interaction payloads
    console.log(
      "Slack event type:",
      body.type,
      "actions:",
      body.actions ? body.actions.map((a) => a.action_id) : "none"
    );

    if (body.type === "block_actions") {
      console.log("block_actions event payload:", JSON.stringify(body));
      if (body.actions && body.actions[0].action_id === "hii_button") {
        const userId = body.user.id;
        const channel = body.channel.id;
        const messageTs = body.message.ts;

        console.log(`hii_button clicked by user ${userId} in channel ${channel}, messageTs: ${messageTs}`);

        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel,
            text: `:hii: from <@${userId}>`,
            thread_ts: messageTs,
          }),
        });

        const data = await res.json();
        console.log("Slack API response (hii_button):", data);
        return ack();
      } else {
        console.log(
          "block_actions event received, but action_id is not hii_button:",
          body.actions ? body.actions.map((a) => a.action_id) : "none"
        );
      }
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

export { parseAssistantAction };
