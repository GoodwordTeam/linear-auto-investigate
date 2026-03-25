# linear-auto-investigate

Automatic AI investigation workflow that runs when a well-scoped Linear ticket is created. Uses Claude Code to investigate the relevant codebases, Sentry errors, and AWS infrastructure, then updates the ticket with findings and optionally creates draft PRs for low-hanging fruit.

## How It Works

```
Linear Ticket Created/Updated
        │
        ▼
  Linear Webhook
        │
        ▼
  Webhook Handler (linear-webhook-handler.mjs)
        │
        ▼
  GitHub Actions (repository_dispatch)
        │
        ▼
  ┌─────────────────────────────────┐
  │  1. Fetch ticket from Linear    │
  │  2. Validate scope (early exit) │
  │  3. Clone web-app + api repos   │
  │  4. Run Claude investigation    │
  │     - Code analysis             │
  │     - Sentry error lookup       │
  │     - AWS infrastructure check  │
  │  5. Update Linear ticket with:  │
  │     - Tech scoping              │
  │     - Suggested labels          │
  │     - Investigation comment     │
  │  6. If low-hanging fruit:       │
  │     - Create draft PR           │
  │     - Link PR to ticket         │
  └─────────────────────────────────┘
```

## Setup

### 1. GitHub Repository Secrets

Configure these secrets in your GitHub repository settings:

| Secret | Description |
|--------|-------------|
| `LINEAR_API_KEY` | Linear API key ([create one here](https://linear.app/settings/api)) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `SENTRY_AUTH_TOKEN` | Sentry auth token (optional, for error investigation) |
| `SENTRY_ORG` | Sentry organization slug (optional) |
| `AWS_ACCESS_KEY_ID` | AWS access key (optional, for infra investigation) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (optional) |
| `AWS_DEFAULT_REGION` | AWS region (optional, defaults to us-east-1) |

### 2. GitHub Repository Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `WEBAPP_REPO` | GitHub repo for the web app | `org/web-app` |
| `API_REPO` | GitHub repo for the API | `org/api` |

### 3. Linear Webhook Setup

#### Option A: Deploy the Webhook Handler

Deploy `scripts/linear-webhook-handler.mjs` as a serverless function or standalone server:

```bash
# Run locally for testing
LINEAR_WEBHOOK_SECRET=your-secret \
GITHUB_TOKEN=your-github-pat \
GITHUB_REPO=org/linear-auto-investigate \
node scripts/linear-webhook-handler.mjs
```

Then configure Linear:
1. Go to **Linear Settings > API > Webhooks**
2. Create a webhook pointing to `https://your-handler-url/webhook`
3. Select **Issues** events (create, update)
4. Set a webhook secret and match it in `LINEAR_WEBHOOK_SECRET`

#### Option B: Manual Trigger

Trigger an investigation manually using the GitHub Actions UI or the trigger script:

```bash
GITHUB_REPO=org/linear-auto-investigate \
GITHUB_TOKEN=your-github-pat \
./scripts/trigger-investigation.sh ENG-123
```

## Ticket Scope Validation

The system performs early exit for tickets that aren't well-scoped enough for automated investigation. A ticket is skipped if:

- No title or very short title with no description
- No description and no Sentry links
- Appears to be a broad epic/initiative rather than a specific task
- Description is too brief (fewer than 5 words) with no Sentry context
- Open-ended question (title ends with `?`) without sufficient description

When a ticket is skipped, a comment is posted explaining why and what information would help.

## Investigation Output

The AI investigation produces:
- **Summary**: Brief overview of findings
- **Technical Analysis**: Detailed code analysis
- **Relevant Files**: Key files involved
- **Suggested Labels**: Appropriate Linear labels
- **Complexity Estimate**: Low / Medium / High
- **Low-Hanging Fruit Assessment**: Whether this can be auto-fixed
- **Sentry Findings**: Error details if Sentry URLs are present
- **AWS Findings**: Infrastructure insights if relevant

## Project Structure

```
├── .github/workflows/
│   └── investigate.yml          # Main GitHub Actions workflow
├── .claude/
│   └── settings.json            # Claude MCP server config (Sentry)
├── scripts/
│   ├── fetch-ticket.mjs         # Fetch + validate Linear ticket
│   ├── update-linear.mjs        # Update ticket with results
│   ├── create-draft-pr.mjs      # Create draft PR for low-hanging fruit
│   ├── setup-workspace.sh       # Clone repos + configure tools
│   ├── trigger-investigation.sh # Manual trigger script
│   └── linear-webhook-handler.mjs # Webhook receiver
├── CLAUDE.md                    # Investigation instructions for Claude
├── package.json
└── README.md
```

## How the Draft PR Flow Works

When Claude determines a ticket is "low-hanging fruit":
1. Claude implements the suggested fix in the appropriate repo (web-app or api)
2. A new branch `auto-fix/<ticket-id>` is created
3. A draft PR is opened with the investigation summary
4. The PR link is posted back to the Linear ticket as a comment
5. The ticket description is updated with the PR link

Draft PRs always require human review before merging.
