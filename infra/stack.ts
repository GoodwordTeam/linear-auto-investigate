import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from "path";

export interface LinearWebhookStackProps extends cdk.StackProps {
  linearWebhookSecret: string;
  githubToken: string;
  githubRepo: string;
}

export class LinearWebhookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LinearWebhookStackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, "WebhookHandler", {
      functionName: "linear-webhook-handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        LINEAR_WEBHOOK_SECRET: props.linearWebhookSecret,
        GITHUB_TOKEN: props.githubToken,
        GITHUB_REPO: props.githubRepo,
      },
    });

    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new cdk.CfnOutput(this, "FunctionUrl", {
      value: fnUrl.url,
      description: "Lambda Function URL for Linear webhook",
    });
  }
}
