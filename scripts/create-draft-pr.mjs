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
import { LinearClient } from "@linear/sdk";

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

const client = new LinearClient({ apiKey: LINEAR_API_KEY });

/**
 * Parse investigation results to extract fix details
 */
function parseResults(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed.result) {
      const jsonMatch = parsed.result.match(
        /```(?:json)?\s*\n?([\s\S]*?)\n?```/
      );
      if (jsonMatch) return JSON.parse(jsonMatch[1]);
    }
    if (parsed.suggestedFix) return parsed;
  } catch {
    // Try extracting from raw text
  }
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Fall through
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

  // Check if it's primarily frontend or backend
  const frontendIndicators = [
    "component",
    "tsx",
    "jsx",
    "css",
    "scss",
    "react",
    "next",
    "pages/",
    "src/components",
    "web-app",
  ];
  const backendIndicators = [
    "controller",
    "service",
    "model",
    "migration",
    "endpoint",
    "api/",
    "routes/",
    "middleware",
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
    // Branch may already exist
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
        timeout: 600000, // 10 minute timeout
      }
    );
  } catch (error) {
    console.error(`Claude implementation failed: ${error.message}`);
    // Still try to create PR if there are changes
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
    const match = ticketId.match(/^([A-Za-z]+)-(\d+)$/);
    const lookupIssues = match
      ? await client.issues({
          filter: {
            team: { key: { eq: match[1].toUpperCase() } },
            number: { eq: parseInt(match[2], 10) },
          },
          first: 1,
        })
      : { nodes: [] };
    const issue = lookupIssues.nodes[0];
    if (issue) {
      await client.commentCreate({
        issueId: issue.id,
        body: `## 🍒 Draft PR Created\n\nA draft PR has been automatically created for this low-hanging fruit ticket:\n\n**[${prUrl}](${prUrl})**\n\nPlease review the changes before merging.\n\n---\n*Automated by linear-auto-investigate*`,
      });

      // Also attach the PR URL to the issue
      const currentDesc = issue.description || "";
      if (!currentDesc.includes(prUrl)) {
        await client.issueUpdate(issue.id, {
          description:
            currentDesc + `\n\n**Draft PR:** [${prUrl}](${prUrl})`,
        });
      }
      console.log(`Linked PR back to Linear ticket ${ticketId}`);
    }
  } catch (error) {
    console.error(`Failed to create PR: ${error.message}`);
  }
}

main();
