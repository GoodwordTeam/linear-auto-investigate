#!/usr/bin/env bash
set -euo pipefail

# Setup the investigation workspace by cloning the target repositories
# and configuring tools (Sentry MCP, AWS CLI).

WORKSPACE="/tmp/workspace"
mkdir -p "$WORKSPACE"

echo "=== Setting up investigation workspace ==="

# Clone web-app repo
if [ -n "${WEBAPP_REPO:-}" ]; then
  echo "Cloning web-app from $WEBAPP_REPO..."
  if [ -d "$WORKSPACE/web-app" ]; then
    echo "web-app already exists, pulling latest..."
    cd "$WORKSPACE/web-app" && git pull origin main || git pull origin master || true
    cd -
  else
    git clone --depth 50 "https://x-access-token:${GITHUB_TOKEN}@github.com/${WEBAPP_REPO}.git" "$WORKSPACE/web-app"
  fi
  echo "web-app cloned successfully"
else
  echo "WARNING: WEBAPP_REPO not set, skipping web-app clone"
fi

# Clone API repo
if [ -n "${API_REPO:-}" ]; then
  echo "Cloning api from $API_REPO..."
  if [ -d "$WORKSPACE/api" ]; then
    echo "api already exists, pulling latest..."
    cd "$WORKSPACE/api" && git pull origin main || git pull origin master || true
    cd -
  else
    git clone --depth 50 "https://x-access-token:${GITHUB_TOKEN}@github.com/${API_REPO}.git" "$WORKSPACE/api"
  fi
  echo "api cloned successfully"
else
  echo "WARNING: API_REPO not set, skipping api clone"
fi

# Copy investigation CLAUDE.md into workspace root
cp "$(dirname "$0")/../CLAUDE.md" "$WORKSPACE/CLAUDE.md"

# Setup Claude config with MCP servers
CLAUDE_CONFIG_DIR="$WORKSPACE/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Configure Sentry MCP if credentials are available
if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "Configuring Sentry MCP server..."
  cat > "$CLAUDE_CONFIG_DIR/settings.json" << SETTINGS_EOF
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server"],
      "env": {
        "SENTRY_AUTH_TOKEN": "${SENTRY_AUTH_TOKEN}",
        "SENTRY_ORG": "${SENTRY_ORG:-}"
      }
    }
  }
}
SETTINGS_EOF
  echo "Sentry MCP configured"
else
  echo "WARNING: SENTRY_AUTH_TOKEN not set, Sentry MCP will not be available"
  echo '{}' > "$CLAUDE_CONFIG_DIR/settings.json"
fi

# Verify AWS CLI is available if credentials are set
if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  echo "AWS credentials detected, verifying AWS CLI..."
  if command -v aws &> /dev/null; then
    echo "AWS CLI available: $(aws --version)"
  else
    echo "Installing AWS CLI..."
    curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
    unzip -q /tmp/awscliv2.zip -d /tmp/aws-install
    /tmp/aws-install/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
    echo "AWS CLI installed: $(aws --version)"
  fi
else
  echo "WARNING: AWS credentials not set, AWS investigation will not be available"
fi

echo ""
echo "=== Workspace ready ==="
echo "Contents:"
ls -la "$WORKSPACE"
