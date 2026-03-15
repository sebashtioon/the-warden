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
    const joinAnnounceChannel = env.JOIN_ANNOUNCE_CHANNEL || "C0A7JH50JG4";

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
    // Handle new member joins
    // ---------------------------
    if (event && event.type === "team_join") {
      const user = event.user.id;
      console.log("New member joined:", user);
      await sendWelcomeAndRulesThread(joinAnnounceChannel, user, "join");
    }

    // ---------------------------
    // Handle keyword replies
    // ---------------------------
    if (event && event.type === "message" && !event.bot_id && !event.subtype) {
      const text = event.text?.toLowerCase() || "";
      const channel = event.channel;
      const thread_ts = event.ts;

      console.log(`Message in channel ${channel}: "${text}"`);

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
  }
};