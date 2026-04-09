#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LinearWebhookStack } from "./stack";

const app = new cdk.App();

new LinearWebhookStack(app, "LinearWebhookStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  githubToken: process.env.GITHUB_TOKEN!,
  githubRepo: process.env.GITHUB_REPO!,
});
