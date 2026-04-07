#!/usr/bin/env bash
set -euo pipefail

# Deploy the Linear webhook handler as an AWS Lambda with a Function URL.
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - Environment variables (or will prompt):
#       LINEAR_WEBHOOK_SECRET
#       GITHUB_TOKEN
#       GITHUB_REPO
#
# Usage:
#   ./scripts/deploy-lambda.sh                  # First-time deploy (creates everything)
#   ./scripts/deploy-lambda.sh --update         # Update code only

FUNCTION_NAME="linear-webhook-handler"
RUNTIME="nodejs20.x"
HANDLER="index.handler"
TIMEOUT=10
MEMORY=128
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ROLE_NAME="linear-webhook-lambda-role"
ZIP_FILE="/tmp/linear-webhook-lambda.zip"

UPDATE_ONLY=false
if [ "${1:-}" = "--update" ]; then
  UPDATE_ONLY=true
fi

# Check required env vars
: "${LINEAR_WEBHOOK_SECRET:?Set LINEAR_WEBHOOK_SECRET}"
: "${GITHUB_TOKEN:?Set GITHUB_TOKEN}"
: "${GITHUB_REPO:?Set GITHUB_REPO}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$SCRIPT_DIR/../lambda"

echo "==> Packaging Lambda function..."
cd "$LAMBDA_DIR"
zip -j "$ZIP_FILE" index.mjs
cd - > /dev/null

if [ "$UPDATE_ONLY" = true ]; then
  echo "==> Updating function code..."
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$REGION" \
    --no-cli-pager

  echo "==> Updating environment variables..."
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --environment "Variables={LINEAR_WEBHOOK_SECRET=$LINEAR_WEBHOOK_SECRET,GITHUB_TOKEN=$GITHUB_TOKEN,GITHUB_REPO=$GITHUB_REPO}" \
    --region "$REGION" \
    --no-cli-pager

  echo ""
  echo "Done! Function updated."
  exit 0
fi

# --- First-time setup ---

echo "==> Creating IAM role..."
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --query 'Role.Arn' --output text \
  --no-cli-pager 2>/dev/null) || \
ROLE_ARN=$(aws iam get-role \
  --role-name "$ROLE_NAME" \
  --query 'Role.Arn' --output text \
  --no-cli-pager)

# Attach basic execution role for CloudWatch logs
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
  --no-cli-pager 2>/dev/null || true

echo "    Role ARN: $ROLE_ARN"

# IAM role propagation delay
echo "==> Waiting for IAM role to propagate..."
sleep 10

echo "==> Creating Lambda function..."
aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime "$RUNTIME" \
  --handler "$HANDLER" \
  --role "$ROLE_ARN" \
  --zip-file "fileb://$ZIP_FILE" \
  --timeout "$TIMEOUT" \
  --memory-size "$MEMORY" \
  --environment "Variables={LINEAR_WEBHOOK_SECRET=$LINEAR_WEBHOOK_SECRET,GITHUB_TOKEN=$GITHUB_TOKEN,GITHUB_REPO=$GITHUB_REPO}" \
  --region "$REGION" \
  --no-cli-pager

echo "==> Creating Function URL (public, no auth)..."
FUNCTION_URL=$(aws lambda create-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --auth-type NONE \
  --query 'FunctionUrl' --output text \
  --region "$REGION" \
  --no-cli-pager)

# Allow public invocation via Function URL
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id "AllowPublicFunctionUrl" \
  --action "lambda:InvokeFunctionUrl" \
  --principal "*" \
  --function-url-auth-type NONE \
  --region "$REGION" \
  --no-cli-pager

echo ""
echo "========================================="
echo " Deployed successfully!"
echo "========================================="
echo ""
echo " Function URL: $FUNCTION_URL"
echo ""
echo " Next steps:"
echo "   1. Go to Linear Settings > API > Webhooks"
echo "   2. Create a webhook with URL: $FUNCTION_URL"
echo "      (Linear sends POST to the root path, which Lambda Function URL handles)"
echo "   3. Select 'Issues' events (create, update)"
echo "   4. Set the webhook secret to match LINEAR_WEBHOOK_SECRET"
echo ""
echo " To update later:  ./scripts/deploy-lambda.sh --update"
echo " View logs:        aws logs tail /aws/lambda/$FUNCTION_NAME --follow"
echo ""
