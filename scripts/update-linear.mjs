#!/usr/bin/env node

/**
 * Updates a Linear ticket with AI investigation results.
 *
 * Usage:
 *   node update-linear.mjs <ticket-id> --results <results-file>
 *   node update-linear.mjs <ticket-id> --skip "<reason>"
 */

import fs from "fs";
import { LinearClient } from "@linear/sdk";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.error("ERROR: LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

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
 * Parse the investigation results from Claude's output.
 * Claude may output raw JSON or JSON embedded in markdown code blocks.
 */
function parseInvestigationResults(rawContent) {
  let content = rawContent;

  // If it's already an object (e.g., from --output-format json), extract the text
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed.result) {
      content = parsed.result;
    } else if (typeof parsed === "object" && parsed.summary) {
      return parsed; // Already the right format
    }
  } catch {
    // Not JSON wrapper, continue
  }

  // Try to extract JSON from markdown code blocks
  const jsonBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch {
      // Fall through
    }
  }

  // Try direct JSON parse
  try {
    return JSON.parse(content);
  } catch {
    // Return a fallback structure with the raw text
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

/**
 * Look up an issue by its identifier (e.g., "ENG-1447").
 */
async function findIssueByIdentifier(identifier) {
  const match = identifier.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid ticket identifier format: ${identifier}`);
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
    // Find the issue
    const issue = await findIssueByIdentifier(ticketId);
    if (!issue) {
      console.error(`Ticket ${ticketId} not found`);
      process.exit(1);
    }

    if (flag === "--skip") {
      // Post a comment explaining why we skipped
      const reason = process.argv.slice(4).join(" ");
      await client.commentCreate({
        issueId: issue.id,
        body: `## ⏭️ AI Investigation Skipped\n\nThis ticket was not investigated automatically because: **${reason}**\n\nTo trigger an investigation, ensure the ticket has:\n- A clear, descriptive title\n- A description with enough detail to scope the work\n- Specific acceptance criteria or steps to reproduce (for bugs)\n\n---\n*Automated by linear-auto-investigate*`,
      });
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
      await client.commentCreate({
        issueId: issue.id,
        body: comment,
      });
      console.log(`Posted investigation results to ${ticketId}`);

      // Add suggested labels
      if (results.suggestedLabels?.length > 0) {
        const team = await issue.team;
        if (team) {
          const teamLabels = await team.labels();
          const existingLabelNames = new Set(
            teamLabels.nodes.map((l) => l.name.toLowerCase())
          );

          for (const labelName of results.suggestedLabels) {
            // Only add labels that exist on the team
            const matchingLabel = teamLabels.nodes.find(
              (l) => l.name.toLowerCase() === labelName.toLowerCase()
            );
            if (matchingLabel) {
              const currentLabels = await issue.labels();
              const currentLabelIds = currentLabels.nodes.map((l) => l.id);
              if (!currentLabelIds.includes(matchingLabel.id)) {
                await client.issueUpdate(issue.id, {
                  labelIds: [...currentLabelIds, matchingLabel.id],
                });
                console.log(`Added label: ${labelName}`);
              }
            }
          }
        }
      }

      // Update issue description with tech scoping appendix
      if (results.estimatedComplexity) {
        const currentDesc = issue.description || "";
        const techScopingSection = `\n\n---\n### 🤖 AI Tech Scoping\n- **Complexity:** ${results.estimatedComplexity}\n- **Key Files:** ${(results.relevantFiles || []).slice(0, 5).map((f) => `\`${f}\``).join(", ") || "N/A"}\n- **Low-Hanging Fruit:** ${results.isLowHangingFruit ? "Yes" : "No"}`;

        // Only append if not already present
        if (!currentDesc.includes("AI Tech Scoping")) {
          await client.issueUpdate(issue.id, {
            description: currentDesc + techScopingSection,
          });
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
