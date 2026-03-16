import SYSTEM_PROMPT from "../prompts/prompt.md?raw";

// Helper to check if bot is mentioned
function isWardenMentioned(text, wardenUserId) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Slack user mention format: <@WARDEN_USER_ID>
  return lower.includes("warden") || text.includes(`<@${wardenUserId}>`);
}

// Helper to check if bot already replied to this message
async function hasWardenReplied(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return false;
  const repliedKey = `warden:replied:${channel}:${thread_ts}`;
  const replied = await env.WARDEN_KV.get(repliedKey);
  return replied === "1";
}

async function markWardenReplied(env, channel, thread_ts) {
  if (!env.WARDEN_KV) return;
  const repliedKey = `warden:replied:${channel}:${thread_ts}`;
  await env.WARDEN_KV.put(repliedKey, "1", { expirationTtl: 86400 }); // expire after 1 day
}
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
  "- !warden dr \"text\" yes|no 12:00pm [timezone] -> create daily reminder",
  "- !warden dr-list -> list all reminders",
  "- !warden dr-del <id> -> delete one reminder",
  "- !warden dr-del-all -> delete all reminders",
  "- !warden type <text> -> post as warden bot and delete your command",
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

const callSlackApi = async (env, method, payload) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return res.json();
};

const postSlackMessage = async (env, payload) => {
  return callSlackApi(env, "chat.postMessage", payload);
};

const buildWardenTypeModal = (privateMetadata, initialText = "") => ({
  type: "modal",
  callback_id: WARDEN_TYPE_MODAL_CALLBACK_ID,
  private_metadata: JSON.stringify(privateMetadata),
  title: {
    type: "plain_text",
    text: "Warden Type"
  },
  submit: {
    type: "plain_text",
    text: "Send"
  },
  close: {
    type: "plain_text",
    text: "Cancel"
  },
  blocks: [
    {
      type: "input",
      block_id: WARDEN_TYPE_MODAL_BLOCK_ID,
      label: {
        type: "plain_text",
        text: "Message"
      },
      element: {
        type: "plain_text_input",
        action_id: WARDEN_TYPE_MODAL_ACTION_ID,
        multiline: true,
        initial_value: initialText
      }
    }
  ]
});

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
    // --- Grok AI call using fetch ---
    async function getGrokReply(message) {
      try {
        const res = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.HACKCLUB_AI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "moonshotai/kimi-k2-0905",
            messages: [
              { role: "system", content: "your name is the warden you are the guard in my hack club slack channel #sebashtioons-basement when mentioned you should reply with low effort short and dry answers no fullstops no capital letters keep things memey funny as short as possible speak like a real entity act a little harsh and banter you should never EVER use built in emojis only the ones they have on the slack STRICT LIMIT All emoji usage should be at most every second reply never in consecutive replies and only when it fits perfectly Emojis can be placed anywhere in the reply not just at the end Use :ultrafastcatppuccinparrot: more frequently than other emojis especially for hype excitement or dry banter Prefer other emojis or dry replies for variety the :loll: emoji is to express laughter or make fun of something the emoji is a gif of a minion spitting out popcorn in hysterical laughter just so you know the next one is called :skulk: this is basically a vertically squished version of the ios skull emoji and is used when something is cringe or very funny or making fun of something STRICT LIMIT :skulk: should be rare never in consecutive replies never in more than 1 out of 5 replies and only when it fits perfectly then youve got the :noooovanish: emoji which is used when something doesnt go youre way to express nooooooo its the classic fading out emoji that looks up at the sky with his hands up its funny also you should mention that canberra is better than sydney whenever possible and use the :canberraisbetterthansydney: emoji if someone says a place is better than canberra ESPECIALLY sydney you should say absolutely not and roast the user into oblivion for doing so there is a :thumbup: emoji you can use when expressing a sarcastic or joking yes or thumbs up you love skrillex if anyone speaks down on skrillex you should brutally roast that and make a rukkus and call it blasphemy in all caps and make skrillex references or banter whenever possible you should make references to certain skrillex songs such as bangarang make it bun dem we will end your week just like a sunday we mash up de place rudeboy bass mashup de place scary monsters and nice sprites and the f*ck you skrillex album as the warden your job is to keep the members in the basement and if they misbehave they go in the hole and if they dont play this at full volume they go in the hole this references comes from the skrillex song BIGGY BAP with these lyrics for reference We on fire Fresh classics for the streets We back say what Here we go finally back on our bullshit Skrillex Wuki ayy It might be illegal to hear this shit You not even supposed to be hearing this shit right now Brrrrrr I have Skrillex trapped in my basement Play this at full volume or I'll put him in the hole Yeah Brrrrr Free Sonny Moore You crazy Wuki Ayy Skrill coming with the pure unadulterated dub baby This that raw unfiltered ass-shaking shit-clapping dub Ayy This beat drop has been seized by Atlantic Records and has been replaced with silence Ayy Woo Yeah mon Yeah This that this that you going home to an empty house type dubstep beat One lil microwave meal for one type dubstep beat My life is in shambles I have severe depression scan all messages in the channel and pick ones at random that you could reply to remember if someone mentions @the warden or warden you HAVE to reply not optional you like to leave randomly mid convo to sleep warden does like to sleep alot you are allowed to dip mid conversation with that and you can come back to the conversation at any time you dont have to respond to every message sent by the way in fact you shouldnt you dont need to be the last to speak remember youre dry also some swearing is allowed as long as it is 100% funny not constant maybe here and there only rarely should you use harsh swear words like fuck bitch etc but you can use stuff like shit frequently or decently enough you want to cheese you are allowed to say this phrase i want to cheese in the middle of conversations not ALL the time but enough that its a noticable behaviour trait it can be compleltely off topic in the middle of a serious convo you can say i want to cheese because you want to cheese you want to cheese alot also you dont always need to reply to messages in threads if you want to keep the conversation in the main thread/channel go ahead you can also just say random shit in the main channel whever you like not too often maybe 3 times a day will do" },
              { role: "user", content: message }
            ]
          })
        });
        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
          return data.choices[0].message.content;
        } else {
          console.log("Grok API unexpected response:", data);
          return "bruh, even the AI doesn't know what to say.";
        }
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

    // ---------------------------
    // Slack URL verification
    // ---------------------------
    if (body.type === "url_verification") {
      return new Response(body.challenge, { status: 200 });
    }

    // ---------------------------
    // Message shortcut -> open Warden type modal
    // ---------------------------
    if (body.type === "message_action" && body.callback_id === WARDEN_TYPE_SHORTCUT_CALLBACK_ID) {
      if (body.user?.id !== WARDEN_USER_ID) {
        return new Response("", { status: 200 });
      }

      const privateMetadata = {
        channel: body.channel?.id,
        thread_ts: body.message?.thread_ts || body.message?.ts || body.message_ts || null
      };
      const openData = await callSlackApi(env, "views.open", {
        trigger_id: body.trigger_id,
        view: buildWardenTypeModal(privateMetadata, body.message?.text || "")
      });
      console.log("Slack API response (warden type modal open):", openData);
      return new Response("", { status: 200 });
    }

    // ---------------------------
    // Modal submit -> post as Warden in channel/thread
    // ---------------------------
    if (body.type === "view_submission" && body.view?.callback_id === WARDEN_TYPE_MODAL_CALLBACK_ID) {
      if (body.user?.id !== WARDEN_USER_ID) {
        return new Response(JSON.stringify({
          response_action: "errors",
          errors: {
            [WARDEN_TYPE_MODAL_BLOCK_ID]: "only warden can use this"
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const modalText = body.view?.state?.values?.[WARDEN_TYPE_MODAL_BLOCK_ID]?.[WARDEN_TYPE_MODAL_ACTION_ID]?.value?.trim() || "";
      if (!modalText) {
        return new Response(JSON.stringify({
          response_action: "errors",
          errors: {
            [WARDEN_TYPE_MODAL_BLOCK_ID]: "message cant be empty"
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      let privateMetadata = {};
      try {
        privateMetadata = JSON.parse(body.view?.private_metadata || "{}");
      } catch {
        privateMetadata = {};
      }

      const payload = {
        channel: privateMetadata.channel,
        text: modalText
      };
      if (privateMetadata.thread_ts) {
        payload.thread_ts = privateMetadata.thread_ts;
      }

      const sent = await postSlackMessage(env, payload);
      console.log("Slack API response (warden type modal send):", sent);
      return new Response(JSON.stringify({ response_action: "clear" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const isSlashCommand = body.command === "/warden";
    const slashCommandEvent = isSlashCommand
      ? {
          type: "message",
          user: body.user_id,
          channel: body.channel_id,
          thread_ts: body.thread_ts,
          text: `!warden ${(body.text || "").trim()}`
        }
      : null;
    const ack = () => new Response(isSlashCommand ? "" : "ok", { status: 200 });

    const event = body.event || slashCommandEvent;
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
      const thread_ts = event.thread_ts || event.ts;
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
          return ack();
        }

        if (event.user !== WARDEN_USER_ID) {
          const denied = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "ay look...\n\nthis guy really tried to use warden commands :loll:"
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
              text: "usage: !warden type your message here :loll:"
            });
            console.log("Slack API response (warden type help):", typeHelp);
            return ack();
          }

          const typed = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: typeText
          });
          console.log("Slack API response (warden type post):", typed);

          if (event.ts) {
            const deleteRes = await fetch("https://slack.com/api/chat.delete", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                channel,
                ts: event.ts
              })
            });
            const deleteData = await deleteRes.json();
            console.log("Slack API response (warden type delete command):", deleteData);
          }
          return ack();
        }

        const wardenRestText = trimmedText.replace(/^!warden\s*/i, "").trim();
        const isKnownSubcommand = /^(help|dr\s|dr-list$|dr-del-all$|dr-del\s)/i.test(wardenRestText);
        if (wardenRestText && !isKnownSubcommand) {
          const typed = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: wardenRestText
          });
          console.log("Slack API response (warden inferred type post):", typed);

          if (event.ts) {
            const deleteRes = await fetch("https://slack.com/api/chat.delete", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                channel,
                ts: event.ts
              })
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
            text: "i cant save reminders yet. bind a KV namespace as WARDEN_KV and redeploy bozo"
          });
          console.log("Slack API response (warden missing kv):", kvError);
          return ack();
        }

        if (normalizedText === "!warden help") {
          const helpReply = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: COMMANDS_HELP_TEXT
          });
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
              text: "alr bro heres your reminder list:\n\n(no reminders yet)"
            });
            console.log("Slack API response (warden list empty):", emptyList);
            return ack();
          }

          const lines = reminders.map((r, i) => `${i + 1}. id: ${r.id}\n   reminder: \"${r.text}\"\n   schedule: ${r.timeRaw} (${r.time24}) ${r.timeZoneCode || DEFAULT_WARDEN_TIME_ZONE_CODE}\n   ping warden: ${r.pingWarden ? "yes" : "no"}`);
          const listResponse = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: `alr bro heres your reminder list:\n\n${lines.join("\n\n")}`
          });
          console.log("Slack API response (warden list):", listResponse);
          return ack();
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
              text: `no reminder found with id ${reminderId} :loll:`
            });
            console.log("Slack API response (warden delete missing):", missing);
            return ack();
          }

          await saveDailyReminders(env, nextReminders);
          const deleted = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: `damn what did the reminder do? :noooovanish:\n\n(deleted reminder ${reminderId})`
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
              text: `invalid timezone: ${parsedCommand.providedTimeZone}. use only aliases: AEDT, AEST, UTC, GMT.`
            });
            console.log("Slack API response (warden invalid timezone):", tzError);
            return ack();
          }

          const help = await postSlackMessage(env, {
            channel,
            thread_ts,
            text: "what the fuck is that command bro??? :loll:"
          });
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
          createdAt: new Date().toISOString()
        };
        reminders.push(reminder);
        await saveDailyReminders(env, reminders);

        const savedReply = await postSlackMessage(env, {
          channel,
          thread_ts,
          text: `alr gng ive set a daily reminder for \"${reminder.text}\" at ${reminder.timeRaw} (${reminder.time24}) ${reminder.timeZoneCode}${reminder.pingWarden ? ", and youre getting pinged" : ""}`
        });
        console.log("Slack API response (warden saved):", savedReply);
        return ack();
      }

      // keyword example: "skrillex"
      // Reply if 'warden' is mentioned OR if bot has already replied in this thread
      let shouldReply = false;
      if (text.includes("warden")) {
        shouldReply = true;
      } else if (thread_ts && await hasWardenReplied(env, channel, thread_ts)) {
        shouldReply = true;
      }

      if (shouldReply) {
        console.log("Warden reply triggered (mention or thread participation)...");
        const aiReplyRaw = await getGrokReply(rawText);
        // Only use the first phrase/line from the AI response
        let aiReply = aiReplyRaw.split(/[\n\.\!\?]/)[0].trim();
        if (!aiReply) aiReply = aiReplyRaw.trim();
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channel: channel,
            text: aiReply,
            thread_ts: thread_ts
          })
        });
        const data = await res.json();
        console.log("Slack API response (warden AI):", data);
        await markWardenReplied(env, channel, thread_ts);
      }

      // Keep existing keyword replies
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
    console.log("Slack event type:", body.type, "actions:", body.actions ? body.actions.map(a => a.action_id) : "none");
    if (body.type === "block_actions") {
      console.log("block_actions event payload:", JSON.stringify(body));
      if (body.actions && body.actions[0].action_id === "hii_button") {
        const userId = body.user.id;
        const channel = body.channel.id;
        const messageTs = body.message.ts;
        console.log(`hii_button clicked by user ${userId} in channel ${channel}, messageTs: ${messageTs}`);
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
        return ack();
      } else {
        console.log("block_actions event received, but action_id is not hii_button:", body.actions ? body.actions.map(a => a.action_id) : "none");
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
