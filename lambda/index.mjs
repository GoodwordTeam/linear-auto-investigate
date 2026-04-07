/**
 * AWS Lambda handler for Linear webhooks.
 *
 * Deploy with a Lambda Function URL (no API Gateway needed).
 * Runtime: Node.js 20.x | Memory: 128 MB | Timeout: 10s
 *
 * Environment variables:
 *   LINEAR_WEBHOOK_SECRET - Secret for verifying webhook signatures
 *   GITHUB_TOKEN          - GitHub PAT with repo + workflow permissions
 *   GITHUB_REPO           - Target repo (e.g. "org/linear-auto-investigate")
 */

import crypto from "crypto";

const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

// --- Shared logic (same as linear-webhook-handler.mjs) ---

function verifySignature(body, signature) {
  if (!LINEAR_WEBHOOK_SECRET) return true;
  const hmac = crypto.createHmac("sha256", LINEAR_WEBHOOK_SECRET);
  hmac.update(body);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const TRIGGER_STATES = ["triage", "bug"];

function isInTriggerState(data) {
  const stateName = (data.state?.name || "").toLowerCase();
  return TRIGGER_STATES.some((s) => stateName === s);
}

function shouldInvestigate(payload) {
  const { action, data, type } = payload;
  if (type !== "Issue") return false;

  const stateName = data.state?.name || "unknown";

  if (action === "create") {
    if (isInTriggerState(data)) {
      console.log(`Triggering: ${data.identifier} created in "${stateName}" state`);
      return true;
    }
    console.log(`Skipping ${data.identifier}: created in "${stateName}" state (not a trigger state)`);
    return false;
  }

  if (action === "update") {
    const updatedFields = payload.updatedFrom || {};
    if (updatedFields.stateId !== undefined && isInTriggerState(data)) {
      console.log(`Triggering: ${data.identifier} moved to "${stateName}" state`);
      return true;
    }
  }

  return false;
}

async function triggerInvestigation(ticketId, ticketData) {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "linear-ticket-investigation",
        client_payload: { ticket_id: ticketId, ...ticketData },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${await response.text()}`
    );
  }
}

// --- Lambda handler ---

export async function handler(event) {
  const body = event.body || "";
  const signature = event.headers?.["linear-signature"] || "";

  if (!verifySignature(body, signature)) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (!shouldInvestigate(payload)) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "skipped", reason: "Not an investigable event" }),
    };
  }

  const ticketId = payload.data?.identifier;
  if (!ticketId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ status: "error", reason: "No ticket identifier" }),
    };
  }

  try {
    console.log(`Triggering investigation for ${ticketId}...`);
    await triggerInvestigation(ticketId, {
      title: payload.data?.title,
      url: payload.url,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "triggered", ticketId }),
    };
  } catch (error) {
    console.error("Webhook error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "error", message: error.message }),
    };
  }
}
