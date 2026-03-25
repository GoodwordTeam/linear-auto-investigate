#!/usr/bin/env node

/**
 * Linear Webhook Handler
 *
 * This script receives Linear webhook events and triggers GitHub Actions
 * investigations for newly created or updated tickets.
 *
 * Deploy this as a serverless function (AWS Lambda, Cloudflare Worker, Vercel, etc.)
 * or run as a standalone server.
 *
 * Linear webhook setup:
 * 1. Go to Linear Settings → API → Webhooks
 * 2. Create a webhook pointing to this handler's URL
 * 3. Select "Issues" events (create, update)
 * 4. Set the webhook secret for signature verification
 *
 * Environment variables:
 * - LINEAR_WEBHOOK_SECRET: Secret for verifying webhook signatures
 * - GITHUB_TOKEN: GitHub PAT with repo and workflow permissions
 * - GITHUB_REPO: Target repo (e.g., "org/linear-auto-investigate")
 */

import crypto from "crypto";
import http from "http";

const PORT = process.env.PORT || 3000;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

/**
 * Verify Linear webhook signature
 */
function verifySignature(body, signature) {
  if (!LINEAR_WEBHOOK_SECRET) return true; // Skip if no secret configured
  const hmac = crypto.createHmac("sha256", LINEAR_WEBHOOK_SECRET);
  hmac.update(body);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Trigger GitHub Actions workflow via repository_dispatch
 */
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
        client_payload: {
          ticket_id: ticketId,
          ...ticketData,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${await response.text()}`
    );
  }
}

/**
 * Determine if a ticket should be investigated
 */
function shouldInvestigate(payload) {
  const { action, data, type } = payload;

  // Only handle issue events
  if (type !== "Issue") return false;

  // Investigate on creation
  if (action === "create") return true;

  // Investigate on update if the ticket was just moved to a "ready" state
  if (action === "update") {
    const updatedFields = payload.updatedFrom || {};
    // Trigger if state changed (e.g., moved to "Todo" or "In Progress")
    if (updatedFields.stateId !== undefined) {
      const newState = (data.state?.name || "").toLowerCase();
      const investigateStates = ["todo", "ready", "in progress", "backlog"];
      return investigateStates.some((s) => newState.includes(s));
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  // Verify signature
  const signature = req.headers["linear-signature"] || "";
  if (!verifySignature(body, signature)) {
    res.writeHead(401);
    res.end("Invalid signature");
    return;
  }

  try {
    const payload = JSON.parse(body);

    if (!shouldInvestigate(payload)) {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "skipped", reason: "Not an investigable event" }));
      return;
    }

    const ticketId = payload.data?.identifier;
    if (!ticketId) {
      res.writeHead(400);
      res.end(JSON.stringify({ status: "error", reason: "No ticket identifier" }));
      return;
    }

    console.log(`Triggering investigation for ${ticketId}...`);
    await triggerInvestigation(ticketId, {
      title: payload.data?.title,
      url: payload.url,
    });

    res.writeHead(200);
    res.end(JSON.stringify({ status: "triggered", ticketId }));
  } catch (error) {
    console.error("Webhook error:", error);
    res.writeHead(500);
    res.end(JSON.stringify({ status: "error", message: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Linear webhook handler listening on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
