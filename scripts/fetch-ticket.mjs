#!/usr/bin/env node

/**
 * Fetches a Linear ticket by ID and validates whether it's well-scoped
 * enough for automated investigation.
 *
 * Usage: node fetch-ticket.mjs <ticket-id>
 * Output: JSON object with ticket data and validation results
 */

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

/**
 * Execute a Linear GraphQL query
 */
async function linearQuery(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join(", "));
  }
  return json.data;
}

/**
 * Determines if a ticket is well-scoped enough for AI investigation.
 */
function validateTicketScope(issue) {
  const title = issue.title || "";
  const description = issue.description || "";

  if (!title.trim()) {
    return { wellScoped: false, skipReason: "Ticket has no title" };
  }

  if (title.length < 10 && !description.trim()) {
    return {
      wellScoped: false,
      skipReason: "Ticket has a very short title and no description",
    };
  }

  const hasSentryLink =
    description.includes("sentry.io") || title.includes("Sentry");
  if (!description.trim() && !hasSentryLink) {
    return {
      wellScoped: false,
      skipReason:
        "Ticket has no description. Add details about what needs to be done.",
    };
  }

  const broadIndicators = [
    "epic", "initiative", "roadmap",
    "phase 1", "phase 2", "q1", "q2", "q3", "q4",
  ];
  const lowerTitle = title.toLowerCase();
  for (const indicator of broadIndicators) {
    if (lowerTitle.includes(indicator) && description.length < 100) {
      return {
        wellScoped: false,
        skipReason: `Ticket appears to be a broad ${indicator} rather than a specific task`,
      };
    }
  }

  if (title.endsWith("?") && description.length < 50) {
    return {
      wellScoped: false,
      skipReason:
        "Ticket appears to be an open question rather than a scoped task",
    };
  }

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

async function main() {
  try {
    const match = ticketId.match(/^([A-Za-z]+)-(\d+)$/);
    if (!match) {
      console.error(
        `Invalid ticket identifier: ${ticketId}. Expected format: ENG-123`
      );
      process.exit(1);
    }
    const [, teamKey, numberStr] = match;
    const number = parseInt(numberStr, 10);

    const data = await linearQuery(
      `query($teamKey: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
          nodes {
            id
            identifier
            title
            description
            priority
            priorityLabel
            url
            team { id name }
            labels { nodes { id name } }
            assignee { name }
            state { name }
          }
        }
      }`,
      { teamKey: teamKey.toUpperCase(), number }
    );

    const issue = data.issues.nodes[0];
    if (!issue) {
      console.error(`Ticket ${ticketId} not found`);
      process.exit(1);
    }

    const validation = validateTicketScope(issue);

    const output = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      teamName: issue.team?.name || "Unknown",
      teamId: issue.team?.id || null,
      labels: (issue.labels?.nodes || []).map((l) => l.name),
      assignee: issue.assignee?.name || null,
      state: issue.state?.name || null,
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
