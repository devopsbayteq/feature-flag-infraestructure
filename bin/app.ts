#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AppConfigStack } from "../lib/appconfig-stack";
import { HostingStack } from "../lib/hosting-stack";
import { ApiStack } from "../lib/api-stack";

const app = new cdk.App();
const environmentName = process.env.ENVIRONMENT ?? "staging";

const commonProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.CDK_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  tags: {
    PROYECTO: "3295",
    RESPONSABLE: "EDUARDO PORTILLA",
    Project: "MFE-React",
    ManagedBy: "CDK",
    Environment: environmentName,
  },
};

// ── Stack 1: Feature Flags (AppConfig) ───────────────────────────────────────
const appConfigStack = new AppConfigStack(
  app,
  `MfeAppConfig-${environmentName}`,
  { environmentName, ...commonProps }
);

// ── Stack 2: Hosting (S3 + CloudFront + RUM + Monitoring) ────────────────────
const hostingStack = new HostingStack(app, `MfeHosting-${environmentName}`, {
  environmentName,
  ...commonProps,
});

// ── Stack 3: API (Flag Manager + Product Listing) ────────────────────────────
new ApiStack(app, `MfeApi-${environmentName}`, {
  environmentName,
  appConfigAppId: appConfigStack.appConfigAppId,
  appConfigEnvId: appConfigStack.appConfigEnvId,
  appConfigProfileId: appConfigStack.appConfigProfileId,
  appConfigDeploymentStrategyId: appConfigStack.deploymentStrategyId,
  kvsArn: hostingStack.kvsArn,
  ...commonProps,
});

app.synth();
