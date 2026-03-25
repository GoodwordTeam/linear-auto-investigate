#!/usr/bin/env node

/**
 * Updates a Linear ticket with AI investigation results.
 *
 * Usage:
 *   node update-linear.mjs <ticket-id> --results <results-file>
 *   node update-linear.mjs <ticket-id> --skip "<reason>"
 */

import fs from "fs";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.error("ERROR: LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

const ticketId = process.argv[2];
const flag = process.argv[3];
const flagValue = process.argv[4];

if (!ticketId || !flag) {
  console.error(
    "Usage: node update-linear.mjs <ticket-id> --results <file> | --skip <reason>"
  );
  process.exit(1);
}

/**
 * Execute a Linear GraphQL mutation/query
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
 * Find issue by identifier
 */
async function findIssue(identifier) {
  const match = identifier.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) throw new Error(`Invalid identifier: ${identifier}`);
  const [, teamKey, numberStr] = match;

  const data = await linearQuery(
    `query($teamKey: String!, $number: Float!) {
      issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
        nodes {
          id
          identifier
          description
          team {
            id
            labels { nodes { id name } }
          }
          labels { nodes { id name } }
        }
      }
    }`,
    { teamKey: teamKey.toUpperCase(), number: parseInt(numberStr, 10) }
  );

  return data.issues.nodes[0] || null;
}

/**
 * Find the matching closing brace for an opening brace, respecting
 * nesting and JSON string escaping.
 */
function findMatchingBrace(text, openPos) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openPos; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Try to extract a JSON object containing "summary" from a string.
 * Handles: pure JSON, JSON in code blocks, JSON embedded in prose,
 * and Claude --output-format json envelopes.
 */
function parseInvestigationResults(rawContent) {
  let content = rawContent;

  // 1. Handle Claude --output-format json envelope: {"result":"..."}
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed.result) {
      content = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
    } else if (typeof parsed === "object" && parsed.summary) {
      return parsed;
    }
  } catch {
    // Not a JSON wrapper, continue
  }

  // 2. Try markdown code block: ```json ... ```
  const jsonBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch {
      // Fall through
    }
  }

  // 3. Try direct JSON parse
  try {
    return JSON.parse(content);
  } catch {
    // Fall through
  }

  // 4. Find JSON object with "summary" key embedded in text, using brace matching
  const summaryIdx = content.indexOf('"summary"');
  if (summaryIdx !== -1) {
    const bracePos = content.lastIndexOf('{', summaryIdx);
    if (bracePos !== -1) {
      const closePos = findMatchingBrace(content, bracePos);
      if (closePos !== -1) {
        try {
          return JSON.parse(content.slice(bracePos, closePos + 1));
        } catch {
          // Fall through
        }
      }
    }
  }

  // 5. Fallback: return raw text as investigation
  return {
    summary: "Investigation completed (raw output)",
    technicalAnalysis: content,
    relevantFiles: [],
    suggestedLabels: [],
    estimatedComplexity: "medium",
    isLowHangingFruit: false,
    suggestedFix: null,
    sentryFindings: null,
    awsFindings: null,
    additionalContext: null,
  };
}

/**
 * Format investigation results as a Linear comment
 */
function formatComment(results) {
  let comment = `## 🔍 AI Investigation Results\n\n`;
  comment += `**Summary:** ${results.summary}\n\n`;

  if (results.technicalAnalysis) {
    comment += `### Technical Analysis\n${results.technicalAnalysis}\n\n`;
  }

  if (results.relevantFiles?.length > 0) {
    comment += `### Relevant Files\n`;
    for (const file of results.relevantFiles) {
      comment += `- \`${file}\`\n`;
    }
    comment += "\n";
  }

  if (results.sentryFindings) {
    comment += `### Sentry Findings\n${results.sentryFindings}\n\n`;
  }

  if (results.awsFindings) {
    comment += `### AWS Findings\n${results.awsFindings}\n\n`;
  }

  comment += `### Assessment\n`;
  comment += `- **Estimated Complexity:** ${results.estimatedComplexity || "Unknown"}\n`;
  comment += `- **Low-Hanging Fruit:** ${results.isLowHangingFruit ? "Yes ✅" : "No"}\n`;

  if (results.suggestedFix) {
    comment += `\n### Suggested Fix\n${results.suggestedFix}\n`;
  }

  if (results.additionalContext) {
    comment += `\n### Additional Context\n${results.additionalContext}\n`;
  }

  comment += `\n---\n*Automated investigation by linear-auto-investigate*`;
  return comment;
}

async function main() {
  try {
    const issue = await findIssue(ticketId);
    if (!issue) {
      console.error(`Ticket ${ticketId} not found`);
      process.exit(1);
    }

    if (flag === "--skip") {
      const reason = process.argv.slice(4).join(" ");
      await linearQuery(
        `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        {
          issueId: issue.id,
          body: `## ⏭️ AI Investigation Skipped\n\nThis ticket was not investigated automatically because: **${reason}**\n\nTo trigger an investigation, ensure the ticket has:\n- A clear, descriptive title\n- A description with enough detail to scope the work\n- Specific acceptance criteria or steps to reproduce (for bugs)\n\n---\n*Automated by linear-auto-investigate*`,
        }
      );
      console.log(`Posted skip comment to ${ticketId}`);
      return;
    }

    if (flag === "--results") {
      const resultsFile = flagValue;
      if (!resultsFile || !fs.existsSync(resultsFile)) {
        console.error(`Results file not found: ${resultsFile}`);
        process.exit(1);
      }

      const rawContent = fs.readFileSync(resultsFile, "utf8");
      const results = parseInvestigationResults(rawContent);

      // Post the investigation comment
      const comment = formatComment(results);
      await linearQuery(
        `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        { issueId: issue.id, body: comment }
      );
      console.log(`Posted investigation results to ${ticketId}`);

      // Add suggested labels
      if (results.suggestedLabels?.length > 0 && issue.team) {
        const teamLabels = issue.team.labels?.nodes || [];
        const currentLabelIds = (issue.labels?.nodes || []).map((l) => l.id);

        for (const labelName of results.suggestedLabels) {
          const matchingLabel = teamLabels.find(
            (l) => l.name.toLowerCase() === labelName.toLowerCase()
          );
          if (matchingLabel && !currentLabelIds.includes(matchingLabel.id)) {
            currentLabelIds.push(matchingLabel.id);
          }
        }

        await linearQuery(
          `mutation($issueId: String!, $labelIds: [String!]!) {
            issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
              success
            }
          }`,
          { issueId: issue.id, labelIds: currentLabelIds }
        );
        console.log(`Updated labels for ${ticketId}`);
      }

      // Update issue description with tech scoping appendix
      if (results.estimatedComplexity) {
        const currentDesc = issue.description || "";
        if (!currentDesc.includes("AI Tech Scoping")) {
          const techScopingSection = `\n\n---\n### 🤖 AI Tech Scoping\n- **Complexity:** ${results.estimatedComplexity}\n- **Key Files:** ${(results.relevantFiles || []).slice(0, 5).map((f) => `\`${f}\``).join(", ") || "N/A"}\n- **Low-Hanging Fruit:** ${results.isLowHangingFruit ? "Yes" : "No"}`;

          await linearQuery(
            `mutation($issueId: String!, $description: String!) {
              issueUpdate(id: $issueId, input: { description: $description }) {
                success
              }
            }`,
            { issueId: issue.id, description: currentDesc + techScopingSection }
          );
          console.log(`Updated ticket description with tech scoping`);
        }
      }
    }
  } catch (error) {
    console.error(`Error updating ticket: ${error.message}`);
    process.exit(1);
  }
}

main();
