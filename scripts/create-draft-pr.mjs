#!/usr/bin/env node

/**
 * Creates a draft PR for low-hanging fruit tickets using Claude Code.
 * Runs Claude in the appropriate repo to implement the suggested fix,
 * then creates a draft PR and links it back to the Linear ticket.
 *
 * Usage: node create-draft-pr.mjs <ticket-id> <results-file>
 */

import fs from "fs";
import { execSync } from "child_process";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const GH_PAT = process.env.GH_PAT;

if (!LINEAR_API_KEY) {
  console.error("ERROR: LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

const ticketId = process.argv[2];
const resultsFile = process.argv[3];

if (!ticketId || !resultsFile) {
  console.error("Usage: node create-draft-pr.mjs <ticket-id> <results-file>");
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
        nodes { id identifier description }
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
 * Parse investigation results to extract fix details.
 * Handles: pure JSON, JSON in code blocks, JSON embedded in prose,
 * and Claude --output-format json envelopes.
 */
function parseResults(filePath) {
  let content = fs.readFileSync(filePath, "utf8");

  // 1. Handle Claude --output-format json envelope
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed.result) {
      content = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
    } else if (typeof parsed === "object" && parsed.suggestedFix) {
      return parsed;
    }
  } catch {
    // Not a JSON wrapper
  }

  // 2. Try markdown code block
  const jsonBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch { /* fall through */ }
  }

  // 3. Try direct JSON parse
  try {
    return JSON.parse(content);
  } catch { /* fall through */ }

  // 4. Find JSON object with "summary" key embedded in text, using brace matching
  const summaryIdx = content.indexOf('"summary"');
  if (summaryIdx !== -1) {
    // Walk backwards to find the opening brace
    let bracePos = content.lastIndexOf('{', summaryIdx);
    if (bracePos !== -1) {
      const closePos = findMatchingBrace(content, bracePos);
      if (closePos !== -1) {
        try {
          return JSON.parse(content.slice(bracePos, closePos + 1));
        } catch { /* fall through */ }
      }
    }
  }

  return null;
}

/**
 * Determine which repo to target based on relevant files
 */
function determineTargetRepo(results) {
  const files = results.relevantFiles || [];
  const analysis = (results.technicalAnalysis || "").toLowerCase();
  const fix = (results.suggestedFix || "").toLowerCase();

  const frontendIndicators = [
    "component", "tsx", "jsx", "css", "scss", "react",
    "next", "pages/", "src/components", "web-app",
  ];
  const backendIndicators = [
    "controller", "service", "model", "migration",
    "endpoint", "api/", "routes/", "middleware",
  ];

  let frontendScore = 0;
  let backendScore = 0;

  const allText = files.join(" ") + " " + analysis + " " + fix;
  for (const indicator of frontendIndicators) {
    if (allText.includes(indicator)) frontendScore++;
  }
  for (const indicator of backendIndicators) {
    if (allText.includes(indicator)) backendScore++;
  }

  return backendScore > frontendScore ? "api" : "web-app";
}

function exec(cmd, options = {}) {
  return execSync(cmd, { encoding: "utf8", ...options }).trim();
}

async function main() {
  const results = parseResults(resultsFile);
  if (!results || !results.isLowHangingFruit || !results.suggestedFix) {
    console.log(
      "Not a low-hanging fruit ticket or no suggested fix — skipping PR creation"
    );
    return;
  }

  const targetRepo = determineTargetRepo(results);
  const repoPath = `/tmp/workspace/${targetRepo}`;

  if (!fs.existsSync(repoPath)) {
    console.error(`Target repo not found at ${repoPath}`);
    process.exit(1);
  }

  // Create a branch for the fix
  const branchName = `auto-fix/${ticketId.toLowerCase()}`;
  console.log(
    `Creating branch ${branchName} in ${targetRepo} for ${ticketId}...`
  );

  try {
    exec(`git checkout -b ${branchName}`, { cwd: repoPath });
  } catch {
    exec(`git checkout ${branchName}`, { cwd: repoPath });
  }

  // Run Claude to implement the fix
  console.log("Running Claude to implement the fix...");
  const implementPrompt = `
You are implementing a fix for Linear ticket ${ticketId}.

## Investigation Summary
${results.summary}

## Suggested Fix
${results.suggestedFix}

## Relevant Files
${(results.relevantFiles || []).map((f) => `- ${f}`).join("\n")}

## Technical Analysis
${results.technicalAnalysis}

## Instructions
1. Implement the suggested fix
2. Keep changes minimal and focused
3. Follow existing code patterns and conventions
4. Do NOT add unnecessary changes, comments, or refactoring
5. Make sure the code compiles/lints correctly
`;

  try {
    exec(
      `claude -p ${JSON.stringify(implementPrompt)} --model claude-sonnet-4-6 --max-turns 20 --allowedTools "Read,Glob,Grep,Edit,Write,Bash"`,
      {
        cwd: repoPath,
        env: { ...process.env },
        timeout: 600000,
      }
    );
  } catch (error) {
    console.error(`Claude implementation failed: ${error.message}`);
  }

  // Check if there are any changes
  const status = exec("git status --porcelain", { cwd: repoPath });
  if (!status.trim()) {
    console.log("No changes were made — skipping PR creation");
    return;
  }

  // Commit the changes
  exec("git add -A", { cwd: repoPath });
  exec(
    `git commit -m "Auto-fix: ${ticketId} - ${results.summary.slice(0, 60)}"`,
    { cwd: repoPath }
  );

  // Push the branch
  exec(`git push -u origin ${branchName}`, { cwd: repoPath });

  // Create draft PR via GitHub CLI
  const WEBAPP_REPO = process.env.WEBAPP_REPO || "";
  const API_REPO = process.env.API_REPO || "";
  const ghRepo = targetRepo === "api" ? API_REPO : WEBAPP_REPO;

  if (!ghRepo) {
    console.error(
      `No GitHub repo configured for ${targetRepo}. Set WEBAPP_REPO or API_REPO env var.`
    );
    return;
  }

  const prBody = `## Auto-Investigation Fix for ${ticketId}

### Summary
${results.summary}

### Changes
${results.suggestedFix}

### Relevant Files
${(results.relevantFiles || []).map((f) => `- \`${f}\``).join("\n")}

### Complexity Assessment
- **Estimated Complexity:** ${results.estimatedComplexity}
- **Classification:** Low-hanging fruit 🍒

---
*This draft PR was automatically generated by [linear-auto-investigate](https://github.com/${process.env.GITHUB_REPOSITORY || ""}). Please review carefully before merging.*

Linear: ${results.ticketUrl || ticketId}`;

  try {
    const prUrl = exec(
      `gh pr create --draft --repo "${ghRepo}" --title "Auto-fix: ${ticketId} - ${results.summary.slice(0, 50)}" --body ${JSON.stringify(prBody)} --head ${branchName}`,
      { cwd: repoPath }
    );

    console.log(`Draft PR created: ${prUrl}`);

    // Link the PR back to the Linear ticket
    const issue = await findIssue(ticketId);
    if (issue) {
      await linearQuery(
        `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        {
          issueId: issue.id,
          body: `## 🍒 Draft PR Created\n\nA draft PR has been automatically created for this low-hanging fruit ticket:\n\n**[${prUrl}](${prUrl})**\n\nPlease review the changes before merging.\n\n---\n*Automated by linear-auto-investigate*`,
        }
      );

      const currentDesc = issue.description || "";
      if (!currentDesc.includes(prUrl)) {
        await linearQuery(
          `mutation($issueId: String!, $description: String!) {
            issueUpdate(id: $issueId, input: { description: $description }) {
              success
            }
          }`,
          {
            issueId: issue.id,
            description: currentDesc + `\n\n**Draft PR:** [${prUrl}](${prUrl})`,
          }
        );
      }
      console.log(`Linked PR back to Linear ticket ${ticketId}`);
    }
  } catch (error) {
    console.error(`Failed to create PR: ${error.message}`);
  }
}

main();
