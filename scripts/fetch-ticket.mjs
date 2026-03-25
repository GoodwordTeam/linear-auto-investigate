#!/usr/bin/env node

/**
 * Fetches a Linear ticket by ID and validates whether it's well-scoped
 * enough for automated investigation.
 *
 * Usage: node fetch-ticket.mjs <ticket-id>
 * Output: JSON object with ticket data and validation results
 */

import { LinearClient } from "@linear/sdk";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.error("ERROR: LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

const ticketId = process.argv[2];
if (!ticketId) {
  console.error("Usage: node fetch-ticket.mjs <ticket-id>");
  process.exit(1);
}

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

/**
 * Determines if a ticket is well-scoped enough for AI investigation.
 * Returns { wellScoped: boolean, skipReason?: string }
 */
function validateTicketScope(issue) {
  const title = issue.title || "";
  const description = issue.description || "";

  // Must have a title
  if (!title.trim()) {
    return { wellScoped: false, skipReason: "Ticket has no title" };
  }

  // Title-only tickets with very short titles are not well-scoped
  if (title.length < 10 && !description.trim()) {
    return {
      wellScoped: false,
      skipReason: "Ticket has a very short title and no description",
    };
  }

  // Must have some description or be a clear bug report with Sentry link
  const hasSentryLink =
    description.includes("sentry.io") || title.includes("Sentry");
  if (!description.trim() && !hasSentryLink) {
    return {
      wellScoped: false,
      skipReason:
        "Ticket has no description. Add details about what needs to be done.",
    };
  }

  // Tickets that are just epics/initiatives (too broad)
  const broadIndicators = [
    "epic",
    "initiative",
    "roadmap",
    "phase 1",
    "phase 2",
    "q1",
    "q2",
    "q3",
    "q4",
  ];
  const lowerTitle = title.toLowerCase();
  const lowerDesc = description.toLowerCase();
  for (const indicator of broadIndicators) {
    if (lowerTitle.includes(indicator) && description.length < 100) {
      return {
        wellScoped: false,
        skipReason: `Ticket appears to be a broad ${indicator} rather than a specific task`,
      };
    }
  }

  // Tickets with just a question mark (exploratory)
  if (title.endsWith("?") && description.length < 50) {
    return {
      wellScoped: false,
      skipReason:
        "Ticket appears to be an open question rather than a scoped task",
    };
  }

  // Check minimum substance in description (at least a sentence)
  const descWords = description.trim().split(/\s+/).length;
  if (descWords < 5 && !hasSentryLink) {
    return {
      wellScoped: false,
      skipReason: "Ticket description is too brief for meaningful investigation",
    };
  }

  return { wellScoped: true };
}

/**
 * Extract Sentry URLs from ticket description
 */
function extractSentryUrls(description) {
  if (!description) return [];
  const sentryRegex = /https?:\/\/[^\s]*sentry\.io[^\s)>]*/g;
  return [...new Set(description.match(sentryRegex) || [])];
}

/**
 * Look up an issue by its identifier (e.g., "ENG-1447").
 * Parses the team key and issue number and uses a filter query
 * to avoid the issueSearch serialization bug.
 */
async function findIssueByIdentifier(identifier) {
  const match = identifier.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid ticket identifier format: ${identifier}. Expected format: ENG-123`
    );
  }
  const [, teamKey, numberStr] = match;
  const number = parseInt(numberStr, 10);

  const issues = await client.issues({
    filter: {
      team: { key: { eq: teamKey.toUpperCase() } },
      number: { eq: number },
    },
    first: 1,
  });

  return issues.nodes[0] || null;
}

async function main() {
  try {
    // Look up the issue by identifier (e.g., "ENG-1447")
    const issue = await findIssueByIdentifier(ticketId);

    if (!issue) {
      console.error(`Ticket ${ticketId} not found`);
      process.exit(1);
    }
    const team = await issue.team;
    const labels = await issue.labels();
    const assignee = await issue.assignee;
    const state = await issue.state;

    // Validate scope
    const validation = validateTicketScope(issue);

    // Build output
    const output = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      teamName: team?.name || "Unknown",
      teamId: team?.id || null,
      labels: labels.nodes.map((l) => l.name),
      assignee: assignee?.name || null,
      state: state?.name || null,
      sentryUrls: extractSentryUrls(issue.description),
      url: issue.url,
      wellScoped: validation.wellScoped,
      skipReason: validation.skipReason || null,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(`Error fetching ticket: ${error.message}`);
    process.exit(1);
  }
}

main();
