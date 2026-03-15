const WARDEN_USER_ID = "U094HHPS5B8";
const REMINDER_KV_KEY = "warden:daily_reminders";
const DEFAULT_WARDEN_TIME_ZONE = "Australia/Sydney";
const DEFAULT_WARDEN_TIME_ZONE_CODE = "AEDT";
const COMMANDS_HELP_TEXT = [
  "warden commands:",
  "",
  "- !warden dr \"text\" yes|no 12:00pm [timezone] -> create daily reminder",
  "- !warden dr-list -> list all reminders",
  "- !warden dr-del <id> -> delete one reminder",
  "- !warden dr-del-all -> delete all reminders",
  "- !warden help -> show this command list"
].join("\n");

const TIME_ZONE_ALIASES = {
  AEDT: "Australia/Sydney",
  AEST: "Australia/Sydney",
  UTC: "Etc/UTC",
  GMT: "Etc/UTC"
};

const resolveTimeZone = (timeZoneToken) => {
  const trimmed = (timeZoneToken || "").trim();
  if (!trimmed) {
    return {
      timeZoneCode: DEFAULT_WARDEN_TIME_ZONE_CODE,
      timeZone: DEFAULT_WARDEN_TIME_ZONE
    };
  }

  const upper = trimmed.toUpperCase();
  if (TIME_ZONE_ALIASES[upper]) {
    return {
      timeZoneCode: upper,
      timeZone: TIME_ZONE_ALIASES[upper]
    };
  }

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
  const match = text.match(/^!warden\s+dr\s+"([^"]+)"\s+(yes|no)\s+([0-9]{1,2}:[0-9]{2}(?:am|pm))(?:\s+([A-Za-z_\/+\-]+))?$/i);
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
      providedTimeZone: timeZoneRaw
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
      providedTimeZone: timeZoneRaw
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
    timeZone
  };
};

const postSlackMessage = async (env, payload) => {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return res.json();
};

const loadDailyReminders = async (env) => {
  if (!env.WARDEN_KV) {
    return [];
  }

  const raw = await env.WARDEN_KV.get(REMINDER_KV_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveDailyReminders = async (env, reminders) => {
  if (!env.WARDEN_KV) {
    return;
  }

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
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    ymd: `${pick("year")}-${pick("month")}-${pick("day")}`,
    hm: `${pick("hour")}:${pick("minute")}`
  };
};

export default {
  async fetch(request, env) {
    let body;
    const contentType = request.headers.get("content-type") || "";
    try {
      if (contentType.includes("application/json")) {
        body = await request.json();
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await request.text();
        // Slack sends payload as: payload=<urlencoded JSON>
        const match = formData.match(/payload=([^&]*)/);
        if (match) {
          const decoded = decodeURIComponent(match[1]);
          body = JSON.parse(decoded);
        } else {
          throw new Error("No payload found in form data");
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

    // ---------------------------
    // Slack URL verification
    // ---------------------------
    if (body.type === "url_verification") {
      return new Response(body.challenge, { status: 200 });
    }

    const event = body.event;
    const rulesCanvasUrl = env.RULES_CANVAS_URL || "https://hackclub.enterprise.slack.com/docs/T0266FRGM/F0AL6S8QWFR";
    const joinTestChannelId = "C0ALRPWUTC4";
    const joinAnnounceChannelId = env.JOIN_ANNOUNCE_CHANNEL_ID || "C0A7JH50JG4";
    const joinAnnounceChannel = env.JOIN_ANNOUNCE_CHANNEL || joinAnnounceChannelId;

    const buildWelcomeMessage = (userId) => ({
      text: `welcome to the basement <@${userId}>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `welcome to the basement <@${userId}>\n\n\n\n*you find yourself in a dimly lit basement...*\nyoure stuck here forever btw there is no leaving. _throws away keys_\n\nanyways everyone welcome our newest captive! :hii::ultrafastcatppuccinparrot::agadance::seb-when-dubstep:`
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: ":hii:"
              },
              action_id: "hii_button"
            }
          ]
        }
      ]
    });

    const sendWelcomeAndRulesThread = async (channel, userId, logLabel) => {
      const welcomePayload = buildWelcomeMessage(userId);
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          channel,
          ...welcomePayload
        })
      });
      const data = await res.json();
      console.log(`Slack API response (${logLabel}):`, data);

      if (data.ok && data.ts) {
        const rulesText = `oh btw <@${userId}> read the <${rulesCanvasUrl}|rules> if you want`;
        const threadRes = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channel: data.channel || channel,
            thread_ts: data.ts,
            text: rulesText
          })
        });
        const threadData = await threadRes.json();
        console.log(`Slack API response (${logLabel} thread):`, threadData);
      }
    };

    // ---------------------------
    // Handle users joining the public announce channel
    // ---------------------------
    if (event && event.type === "member_joined_channel" && event.channel === joinAnnounceChannelId) {
      const user = event.user;
      console.log("User joined announce channel:", user, "channel:", event.channel);
      await sendWelcomeAndRulesThread(joinAnnounceChannel, user, "member_joined_channel");
    }

    // ---------------------------
    // Handle keyword replies
    // ---------------------------
    if (event && event.type === "message" && !event.bot_id && !event.subtype) {
      const text = event.text?.toLowerCase() || "";
      const channel = event.channel;
      const thread_ts = event.ts;
      const rawText = event.text || "";
      const trimmedText = rawText.trim();
      const normalizedText = trimmedText.toLowerCase();

      console.log(`Message in channel ${channel}: "${text}"`);

      // warden command: !warden dr "..." yes|no 12:00pm
      if (normalizedText.startsWith("!warden")) {
        if (normalizedText === "!warden") {
          const bareWarden = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "bro what do you want im tryna sleep"
          });
          console.log("Slack API response (warden bare command):", bareWarden);
          return new Response("ok", { status: 200 });
        }

        if (event.user !== WARDEN_USER_ID) {
          const denied = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "ay look...\n\nthis guy really tried to use warden commands :loll:"
          });
          console.log("Slack API response (warden unauthorized):", denied);
          return new Response("ok", { status: 200 });
        }

        if (!env.WARDEN_KV) {
          const kvError = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "i cant save reminders yet. bind a KV namespace as WARDEN_KV and redeploy bozo"
          });
          console.log("Slack API response (warden missing kv):", kvError);
          return new Response("ok", { status: 200 });
        }

        if (normalizedText === "!warden help") {
          const helpReply = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: COMMANDS_HELP_TEXT
          });
          console.log("Slack API response (warden help):", helpReply);
          return new Response("ok", { status: 200 });
        }

        const listMatch = trimmedText.match(/^!warden\s+dr-list$/i);
        if (listMatch) {
          const reminders = await loadDailyReminders(env);
          if (!reminders.length) {
            const emptyList = await postSlackMessage(env, {
              channel,
              thread_ts,
              text: "alr bro heres your reminder list:\n\n(no reminders yet)"
            });
            console.log("Slack API response (warden list empty):", emptyList);
            return new Response("ok", { status: 200 });
          }

          const lines = reminders.map((r, i) => `${i + 1}. id: ${r.id}\n   reminder: \"${r.text}\"\n   schedule: ${r.timeRaw} (${r.time24}) ${r.timeZoneCode || DEFAULT_WARDEN_TIME_ZONE_CODE}\n   ping warden: ${r.pingWarden ? "yes" : "no"}`);
          const listResponse = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: `alr bro heres your reminder list:\n\n${lines.join("\n\n")}`
          });
          console.log("Slack API response (warden list):", listResponse);
          return new Response("ok", { status: 200 });
        }

        const deleteAllMatch = trimmedText.match(/^!warden\s+dr-del-all$/i);
        if (deleteAllMatch) {
          const reminders = await loadDailyReminders(env);
          await saveDailyReminders(env, []);
          const deleteAllText = reminders.length === 0
            ? "damn what did all the reminders do?? :noooovanish:\n\n(deleted 0 reminders) :loll:"
            : `damn what did all the reminders do?? :noooovanish:\n\n(deleted ${reminders.length} reminder${reminders.length === 1 ? "" : "s"})`;
          const deletedAll = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: deleteAllText
          });
          console.log("Slack API response (warden delete all):", deletedAll);
          return new Response("ok", { status: 200 });
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
              text: `no reminder found with id ${reminderId} :loll:`
            });
            console.log("Slack API response (warden delete missing):", missing);
            return new Response("ok", { status: 200 });
          }

          await saveDailyReminders(env, nextReminders);
          const deleted = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: `damn what did the reminder do? :noooovanish:\n\n(deleted reminder ${reminderId})`
          });
          console.log("Slack API response (warden delete):", deleted);
          return new Response("ok", { status: 200 });
        }

        const parsedCommand = parseDailyReminderCommand(rawText);
        if (!parsedCommand.ok) {
          if (parsedCommand.reason === "timezone" || parsedCommand.reason === "timezone_alias") {
            const tzError = await postSlackMessage(env, {
              channel,
              thread_ts,
              text: `invalid timezone: ${parsedCommand.providedTimeZone}. use only aliases: AEDT, AEST, UTC, GMT.`
            });
            console.log("Slack API response (warden invalid timezone):", tzError);
            return new Response("ok", { status: 200 });
          }

          const help = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "invalid format. use: !warden dr \"do something useful stinky\" yes 12:00pm [timezone] :loll:"
          });
          console.log("Slack API response (warden invalid format):", help);
          return new Response("ok", { status: 200 });
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
          createdAt: new Date().toISOString()
        };
        reminders.push(reminder);
        await saveDailyReminders(env, reminders);

        const ack = await postSlackMessage(env, {
          channel,
          thread_ts,
          text: `alr gng ive set a reminder for \"${reminder.text}\" at ${reminder.timeRaw} (${reminder.time24}) ${reminder.timeZoneCode}, and ping warden is ${reminder.pingWarden ? "on" : "off"}.`
        });
        console.log("Slack API response (warden saved):", ack);
        return new Response("ok", { status: 200 });
      }

      // keyword example: "skrillex"
      if (text.includes("skrillex")) {
        console.log("Keyword matched: skrillex, sending reply...");
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channel: channel,
            text: "THE GOAT",
            thread_ts: thread_ts
          })
        });
        const data = await res.json();
        console.log("Slack API response (keyword):", data);
      }

      if (text.includes("bangarang")) {
        console.log("Keyword matched: bangarang, sending random reply...");
        const bangarangReplies = [
          "bass",
          "salsa on my balls boys, weed brownie"
        ];
        const randomReply = bangarangReplies[Math.floor(Math.random() * bangarangReplies.length)];

        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channel: channel,
            text: randomReply,
            thread_ts: thread_ts
          })
        });
        const data = await res.json();
        console.log("Slack API response (bangarang keyword):", data);
      }
      
        // test: respond with join message if 'join_test' is in the basement channel only
        if (text.includes("join_test") && channel === joinTestChannelId) {
          console.log("Keyword matched: join_test, sending simulated join reply...");
          const simulatedUser = event.user || "test_user";
          await sendWelcomeAndRulesThread(channel, simulatedUser, "join_test");
        }
      }

    // ---------------------------
    // Handle Slack interaction payloads
    // ---------------------------
    if (body.type === "block_actions" && body.actions && body.actions[0].action_id === "hii_button") {
      const userId = body.user.id;
      const channel = body.channel.id;
      const messageTs = body.message.ts;
      // Reply to the bot's message in thread
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          channel: channel,
          text: `:hii: from <@${userId}>`,
          thread_ts: messageTs
        })
      });
      const data = await res.json();
      console.log("Slack API response (hii_button):", data);
      return new Response("ok", { status: 200 });
    }

    return new Response("ok", { status: 200 });
  },

  async scheduled(controller, env) {
    if (!env.WARDEN_KV || !env.SLACK_BOT_TOKEN) {
      console.log("Scheduled: missing WARDEN_KV or SLACK_BOT_TOKEN binding");
      return;
    }

    const reminders = await loadDailyReminders(env);
    if (!reminders.length) {
      return;
    }

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
      if (!matchesCurrentMinute && !matchesPreviousMinute) {
        continue;
      }

      const fireYmd = matchesCurrentMinute ? now.ymd : prevMinute.ymd;
      const dedupeKey = `warden:daily_reminder_fired:${reminder.id}:${fireYmd}`;
      const alreadyFired = await env.WARDEN_KV.get(dedupeKey);
      if (alreadyFired) {
        continue;
      }

      const pingPrefix = reminder.pingWarden ? `<@${WARDEN_USER_ID}> ` : "";
      const payload = {
        channel: reminder.channel,
        text: `${pingPrefix}${reminder.text}`
      };
      const data = await postSlackMessage(env, payload);
      console.log("Slack API response (daily reminder):", data);

      if (data.ok) {
        await env.WARDEN_KV.put(dedupeKey, "1", { expirationTtl: 172800 });
      }
    }
  }
};