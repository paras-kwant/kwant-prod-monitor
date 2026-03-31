require("dotenv").config();
const fetch = require("node-fetch");

const EMAIL = process.env.APP_EMAIL;
const PASSWORD = process.env.APP_PASSWORD;
const BASE_URL = "https://app.kwant.ai";
const PROJECT_ID = process.env.APP_PROJECT_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function log(level, message, data = null) {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Kathmandu" });
  const prefix = { info: "🔹", success: "✅", error: "❌", warn: "⚠️" }[level] || "•";
  const line = `[${timestamp} NPT] ${prefix} ${message}`;
  if (data) {
    console.log(line, JSON.stringify(data, null, 2));
  } else {
    console.log(line);
  }
}

async function sendSlackAlert({ step, error, responseTimes, attemptCount }) {
  if (!SLACK_WEBHOOK_URL) {
    log("warn", "SLACK_WEBHOOK_URL not set — skipping Slack alert");
    return;
  }

  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kathmandu",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const rtLines = Object.entries(responseTimes)
    .map(([k, v]) => `• *${k}:* ${v}ms`)
    .join("\n");

  const payload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 Kwant Monitor — System Alert",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Status:*\n❌ DOWN`,
          },
          {
            type: "mrkdwn",
            text: `*Environment:*\n${BASE_URL}`,
          },
          {
            type: "mrkdwn",
            text: `*Project ID:*\n${PROJECT_ID}`,
          },
          {
            type: "mrkdwn",
            text: `*Attempts:*\n${attemptCount} of 2 failed`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Failed Step:*\n\`${step}\`\n\n*Error:*\n\`\`\`${error}\`\`\``,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Response Times:*\n${rtLines || "_No data collected_"}`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `🕐 *Time (NPT):* ${timestamp}  |  👤 *Monitored by:* ${EMAIL}`,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      log("success", "Slack alert sent");
    } else {
      log("warn", `Slack alert failed with status ${res.status}`);
    }
  } catch (err) {
    log("warn", `Slack alert error: ${err.message}`);
  }
}

async function login(responseTimes) {
  log("info", "Logging in...");
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`,
  });
  responseTimes["Login"] = Date.now() - start;
  if (!res.ok) throw new Error(`Login failed with status ${res.status}`);
  const data = await res.json();
  if (data.returnVal !== "SUCCESS") throw new Error(`Login rejected: ${data.returnMessage}`);
  log("success", `Logged in as ${EMAIL} (${responseTimes["Login"]}ms)`);
  return data.token.token;
}

async function getApiKey(authToken, responseTimes) {
  log("info", `Fetching API key for project ${PROJECT_ID}...`);
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/apiuser`, {
    method: "POST",
    headers: {
      "x-auth-token": authToken,
      "x-auth-project": PROJECT_ID,
      "Content-Type": "application/json",
    },
  });
  responseTimes["API Key"] = Date.now() - start;
  if (!res.ok) throw new Error(`API key fetch failed with status ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error("No API key in response");
  log("success", `API key obtained (${responseTimes["API Key"]}ms)`);
  return data.token;
}

async function fetchWorkers(authToken, apiKey, responseTimes) {
  log("info", "Fetching project task trades...");
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/projectTaskTrade/filter?sort=name,asc&page=0&size=100`, {
    method: "POST",
    headers: {
      "x-auth-token": authToken,
      "x-auth-project": PROJECT_ID,
      "api-key": apiKey,
    },
  });
  responseTimes["Fetch Workers"] = Date.now() - start;
  if (!res.ok) throw new Error(`Workers fetch failed with status ${res.status}`);
  const data = await res.json();
  log("success", `Workers fetched (${responseTimes["Fetch Workers"]}ms)`);
  return data;
}

function summarizeWorkers(raw) {
  const workers = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.content)
    ? raw.content
    : Array.isArray(raw.data)
    ? raw.data
    : [];

  if (workers.length === 0) {
    log("warn", "No workers found or unrecognized response shape");
    return;
  }

  const active = workers.filter(w => w.status === "ACTIVE").length;
  const inactive = workers.filter(w => w.status === "INACTIVE").length;
  const onSite = workers.reduce((sum, w) => sum + (w.totalOnSiteWorkers || 0), 0);
  const totalHeadcount = workers.reduce((sum, w) => sum + (w.totalWorkers || 0), 0);

  log("success", "Workers summary", {
    totalTrades: workers.length,
    active,
    inactive,
    totalHeadcount,
    totalOnSite: onSite,
    breakdown: workers.map(w => ({
      name: w.name,
      status: w.status,
      totalWorkers: w.totalWorkers,
      onSite: w.totalOnSiteWorkers,
    })),
  });
}

async function runCheck() {
  if (!EMAIL || !PASSWORD) throw new Error("APP_EMAIL or APP_PASSWORD env vars not set");
  const responseTimes = {};
  const authToken = await login(responseTimes);
  const apiKey = await getApiKey(authToken, responseTimes);
  const workers = await fetchWorkers(authToken, apiKey, responseTimes);
  summarizeWorkers(workers);
  return responseTimes;
}

async function monitor() {
  log("info", "Starting Kwant monitor...");
  let responseTimes = {};

  try {
    responseTimes = await runCheck();
    log("success", "Kwant system is healthy ✓");
  } catch (firstErr) {
    log("warn", `First attempt failed: ${firstErr.message} — retrying in 10 seconds...`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    try {
      responseTimes = await runCheck();
      log("success", "Kwant system is healthy ✓ (recovered on retry)");
    } catch (secondErr) {
      log("error", `Kwant system check FAILED after 2 attempts: ${secondErr.message}`);

      await sendSlackAlert({
        step: secondErr.message.split(":")[0],
        error: secondErr.message,
        responseTimes,
        attemptCount: 2,
      });

      process.exit(1);
    }
  }
}

monitor();
