#!/usr/bin/env node

/**
 * Creates a draft PR for low-hanging fruit tickets using Claude Code.
 * Runs Claude in the workspace root so it can access both web-app and api repos,
 * then creates draft PRs for whichever repos have changes.
 *
 * Usage: node create-draft-pr.mjs <ticket-id> <results-file>
 */

import fs from "fs";
import { execSync, execFileSync } from "child_process";

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

const WORKSPACE = "/tmp/workspace";

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
 */
function parseResults(filePath) {
  let content = fs.readFileSync(filePath, "utf8");

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed.result) {
      content = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
    } else if (typeof parsed === "object" && parsed.suggestedFix) {
      return parsed;
    }
  } catch { /* not a JSON wrapper */ }

  const jsonBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    try { return JSON.parse(jsonBlockMatch[1]); } catch { /* fall through */ }
  }

  try { return JSON.parse(content); } catch { /* fall through */ }

  const summaryIdx = content.indexOf('"summary"');
  if (summaryIdx !== -1) {
    let bracePos = content.lastIndexOf('{', summaryIdx);
    if (bracePos !== -1) {
      const closePos = findMatchingBrace(content, bracePos);
      if (closePos !== -1) {
        try { return JSON.parse(content.slice(bracePos, closePos + 1)); } catch { /* fall through */ }
      }
    }
  }

  return null;
}

/**
 * Read the PR template from a repo if it exists.
 */
function readPRTemplate(repoPath) {
  const templatePaths = [
    `${repoPath}/.github/pull_request_template.md`,
    `${repoPath}/.github/PULL_REQUEST_TEMPLATE.md`,
    `${repoPath}/pull_request_template.md`,
    `${repoPath}/PULL_REQUEST_TEMPLATE.md`,
  ];
  for (const p of templatePaths) {
    if (fs.existsSync(p)) {
      console.log(`Found PR template: ${p}`);
      return fs.readFileSync(p, "utf8");
    }
  }
  return null;
}

/**
 * Read the Linear ticket URL from the investigation ticket data.
 */
function getTicketUrl() {
  try {
    const ticketData = JSON.parse(fs.readFileSync("/tmp/ticket.json", "utf8"));
    return ticketData.url || null;
  } catch {
    return null;
  }
}

function exec(cmd, options = {}) {
  return execSync(cmd, { encoding: "utf8", ...options }).trim();
}

/**
 * Create a branch, commit changes, push, and create a draft PR for a repo.
 * Returns the PR URL or null.
 */
async function createPRForRepo(repoName, branchName, results) {
  const repoPath = `${WORKSPACE}/${repoName}`;
  if (!fs.existsSync(repoPath)) return null;

  const status = exec("git status --porcelain", { cwd: repoPath });
  if (!status.trim()) {
    console.log(`No changes in ${repoName} — skipping`);
    return null;
  }

  console.log(`Changes detected in ${repoName}, creating PR...`);

  // Delete stale remote branch if it exists from a previous run
  try {
    exec(`git push origin --delete ${branchName}`, { cwd: repoPath });
    console.log(`Deleted stale remote branch ${branchName}`);
  } catch {
    // Branch doesn't exist remotely, that's fine
  }

  // Create branch (force reset if it already exists locally)
  try {
    exec(`git branch -D ${branchName}`, { cwd: repoPath });
  } catch {
    // Branch doesn't exist locally, that's fine
  }
  exec(`git checkout -b ${branchName}`, { cwd: repoPath });

  // Commit
  exec("git add -A", { cwd: repoPath });
  execFileSync("git", [
    "commit", "-m",
    `Auto-fix: ${ticketId} - ${(results.summary || "").slice(0, 60)}`,
  ], { cwd: repoPath, encoding: "utf8" });

  // Push
  exec(`git push -u origin ${branchName}`, { cwd: repoPath });

  // Create draft PR via gh CLI (using execFileSync to avoid shell escaping)
  const WEBAPP_REPO = process.env.WEBAPP_REPO || "";
  const API_REPO = process.env.API_REPO || "";
  const ghRepo = repoName === "api" ? API_REPO : WEBAPP_REPO;

  if (!ghRepo) {
    console.error(`No GitHub repo configured for ${repoName}`);
    return null;
  }

  const prTitle = `${ticketId}: ${(results.summary || "").slice(0, 60)}`;

  // Use Claude-generated PR body if available, otherwise fall back to default
  let prBody;
  if (fs.existsSync("/tmp/pr-body.md")) {
    prBody = fs.readFileSync("/tmp/pr-body.md", "utf8");
    console.log("Using Claude-generated PR body from /tmp/pr-body.md");
  } else {
    const ticketUrl = getTicketUrl() || `https://linear.app/issue/${ticketId}`;
    prBody = [
      `## Summary`,
      results.summary,
      ``,
      `## Changes`,
      results.suggestedFix,
      ``,
      `## Relevant Files`,
      ...(results.relevantFiles || []).map((f) => `- ${f}`),
      ``,
      `## Linear Ticket`,
      `[${ticketId}](${ticketUrl})`,
      ``,
      `---`,
      `*Auto-generated by linear-auto-investigate. Review before merging.*`,
    ].join("\n");
  }

  const prUrl = execFileSync("gh", [
    "pr", "create",
    "--draft",
    "--repo", ghRepo,
    "--title", prTitle,
    "--body", prBody,
    "--head", branchName,
  ], {
    cwd: repoPath,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: process.env.GH_PAT },
  }).trim();

  console.log(`Draft PR created for ${repoName}: ${prUrl}`);
  return prUrl;
}

async function main() {
  const results = parseResults(resultsFile);
  if (!results || !results.isLowHangingFruit || !results.suggestedFix) {
    console.log(
      "Not a low-hanging fruit ticket or no suggested fix — skipping PR creation"
    );
    return;
  }

  // Read the PR template from whichever repo has changes (check both)
  const prTemplate =
    readPRTemplate(`${WORKSPACE}/api`) ||
    readPRTemplate(`${WORKSPACE}/web-app`);

  const ticketUrl = getTicketUrl() || `https://linear.app/issue/${ticketId}`;

  // Run Claude from the workspace root so it can access both repos.
  console.log("Running Claude to implement the fix...");

  let prTemplateInstructions = "";
  if (prTemplate) {
    prTemplateInstructions = `
## PR Body Template
After making your code changes, you MUST also write a filled-in PR body to the file /tmp/pr-body.md.
Use the following PR template from the repo and fill in every section based on the changes you made.
Include the Linear ticket link: ${ticketUrl}

--- START PR TEMPLATE ---
${prTemplate}
--- END PR TEMPLATE ---

Fill in the template completely. For any checklist items, check the ones that apply.
Make sure to link the Linear ticket (${ticketId}: ${ticketUrl}) in the appropriate place.
`;
  } else {
    prTemplateInstructions = `
## PR Body
After making your code changes, you MUST also write a PR body to the file /tmp/pr-body.md.
Include:
- A summary of what changed and why
- The Linear ticket link: [${ticketId}](${ticketUrl})
- List of files changed
- Any testing notes
`;
  }

  const implementPrompt = `You are implementing a fix for Linear ticket ${ticketId}.
Linear ticket URL: ${ticketUrl}

## Investigation Summary
${results.summary}

## Suggested Fix
${results.suggestedFix}

## Relevant Files
${(results.relevantFiles || []).map((f) => `- ${f}`).join("\n")}

## Technical Analysis
${results.technicalAnalysis}

## Workspace Layout
The code is in two repos:
- web-app/ — the frontend application
- api/ — the backend API service

File paths from the investigation (e.g., "api/libs/...") correspond directly to paths relative to this workspace root.
${prTemplateInstructions}
## Instructions
1. Use the Edit tool to make the changes described in the suggested fix
2. Keep changes minimal and focused
3. Follow existing code patterns and conventions
4. Do NOT add unnecessary changes, comments, or refactoring
5. Do NOT just describe changes — actually edit the files using the Edit tool
6. AFTER editing code files, write the PR body to /tmp/pr-body.md using the Write tool
`;

  try {
    execFileSync("claude", [
      "-p", implementPrompt,
      "--model", "claude-sonnet-4-6",
      "--max-turns", "20",
      "--allowedTools", "Read,Glob,Grep,Edit,Write,Bash",
    ], {
      cwd: WORKSPACE,
      env: { ...process.env },
      timeout: 600000,
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch (error) {
    console.error(`Claude implementation failed: ${error.message}`);
  }

  // Check both repos for changes and create PRs
  const branchName = `auto-fix/${ticketId.toLowerCase()}`;
  const prUrls = [];

  for (const repoName of ["api", "web-app"]) {
    try {
      const prUrl = await createPRForRepo(repoName, branchName, results);
      if (prUrl) prUrls.push(prUrl);
    } catch (error) {
      console.error(`Failed to create PR for ${repoName}: ${error.message}`);
    }
  }

  if (prUrls.length === 0) {
    console.log("No changes were made in either repo — skipping PR creation");
    return;
  }

  // Link PRs back to the Linear ticket
  try {
    const issue = await findIssue(ticketId);
    if (issue) {
      const prLinks = prUrls.map((url) => `- [${url}](${url})`).join("\n");
      await linearQuery(
        `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        {
          issueId: issue.id,
          body: `## Draft PR Created\n\nDraft PR(s) have been automatically created for this low-hanging fruit ticket:\n\n${prLinks}\n\nPlease review the changes before merging.\n\n---\n*Automated by linear-auto-investigate*`,
        }
      );

      const currentDesc = issue.description || "";
      const prLinksText = prUrls.map((url) => `[${url}](${url})`).join(", ");
      if (!currentDesc.includes(prUrls[0])) {
        await linearQuery(
          `mutation($issueId: String!, $description: String!) {
            issueUpdate(id: $issueId, input: { description: $description }) {
              success
            }
          }`,
          {
            issueId: issue.id,
            description: currentDesc + `\n\n**Draft PR:** ${prLinksText}`,
          }
        );
      }
      console.log(`Linked PR(s) back to Linear ticket ${ticketId}`);
    }
  } catch (error) {
    console.error(`Failed to link PR to Linear: ${error.message}`);
  }
}

main();
