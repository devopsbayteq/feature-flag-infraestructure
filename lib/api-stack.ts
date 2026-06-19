import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";

export interface ApiStackProps extends cdk.StackProps {
  environmentName: string;
  appConfigAppId: string;
  appConfigEnvId: string;
  appConfigProfileId: string;
  appConfigDeploymentStrategyId: string;
  /** ARN del CloudFront KeyValueStore — para actualizar splitPercentage desde el flag-manager */
  kvsArn: string;
}

/**
 * ApiStack — servicios backend del piloto.
 *
 * Endpoints:
 *  GET    /flags              Lista todos los feature flags activos
 *  POST   /flags              Crea un nuevo feature flag
 *  PATCH  /flags/{flagKey}    Actualiza enabled / splitPercentage sin redeploy
 *
 *  GET    /products?variant=  Devuelve el seguro asignado a la variante (público)
 *
 * Autenticación:
 *  - /flags: requiere header `x-api-key`
 *  - /products: público (sin API key)
 */
export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const appConfigEnv: Record<string, string> = {
      APP_ID: props.appConfigAppId,
      ENV_ID: props.appConfigEnvId,
      PROFILE_ID: props.appConfigProfileId,
      DEPLOYMENT_STRATEGY_ID: props.appConfigDeploymentStrategyId,
      ENVIRONMENT: props.environmentName,
      KVS_ARN: props.kvsArn,
    };

    // ── 1. Lambda: Flag Manager ──────────────────────────────────────────────
    const flagManagerFn = new lambdaNodejs.NodejsFunction(
      this,
      "FlagManager",
      {
        functionName: `mfe-flag-manager-${props.environmentName}`,
        entry: path.join(__dirname, "../src/handlers/flag-manager.ts"),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: appConfigEnv,
        bundling: { minify: true, sourceMap: false },
        description: "CRUD de feature flags sobre AWS AppConfig",
      }
    );

    flagManagerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "appconfig:ListHostedConfigurationVersions",
          "appconfig:GetHostedConfigurationVersion",
          "appconfig:CreateHostedConfigurationVersion",
          "appconfig:StartDeployment",
          "appconfig:GetDeployment",
          "appconfig:ListDeployments",
        ],
        resources: ["*"],
      })
    );

    // Permiso para actualizar el KVS cuando cambia splitPercentage
    flagManagerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudfront-keyvaluestore:DescribeKeyValueStore",
          "cloudfront-keyvaluestore:PutKey",
        ],
        resources: [props.kvsArn],
      })
    );

    // ── 2. Lambda: Product Listing ───────────────────────────────────────────
    const productListingFn = new lambdaNodejs.NodejsFunction(
      this,
      "ProductListing",
      {
        functionName: `mfe-product-listing-${props.environmentName}`,
        entry: path.join(__dirname, "../src/handlers/product-listing.ts"),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(5),
        memorySize: 128,
        environment: { ENVIRONMENT: props.environmentName },
        bundling: { minify: true, sourceMap: false },
        description: "Devuelve el seguro asignado a cada variante A/B",
      }
    );

    // ── 3. API Gateway ───────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, "MfeApi", {
      restApiName: `mfe-api-${props.environmentName}`,
      description: "Feature Flag Manager + Product Listing API",
      deployOptions: {
        stageName: props.environmentName,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
        allowHeaders: ["Content-Type", "x-api-key"],
      },
    });

    // ── 3a. API Key + Usage Plan ─────────────────────────────────────────────
    const apiKey = api.addApiKey("MfeApiKey", {
      apiKeyName: `mfe-api-key-${props.environmentName}`,
      description: "Clave de acceso al Feature Flag Manager",
    });

    const usagePlan = api.addUsagePlan("UsagePlan", {
      name: `mfe-usage-plan-${props.environmentName}`,
      throttle: { rateLimit: 100, burstLimit: 200 },
      quota: { limit: 10000, period: apigateway.Period.DAY },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ api, stage: api.deploymentStage });

    // ── 3b. /flags ───────────────────────────────────────────────────────────
    const flagsResource = api.root.addResource("flags");

    flagsResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(flagManagerFn),
      { apiKeyRequired: true }
    );

    flagsResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(flagManagerFn),
      { apiKeyRequired: true }
    );

    // /flags/{flagKey}
    const flagKeyResource = flagsResource.addResource("{flagKey}");
    flagKeyResource.addMethod(
      "PATCH",
      new apigateway.LambdaIntegration(flagManagerFn),
      { apiKeyRequired: true }
    );

    // ── 3c. /products — público ──────────────────────────────────────────────
    const productsResource = api.root.addResource("products");
    productsResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(productListingFn),
      {
        apiKeyRequired: false,
        requestParameters: {
          "method.request.querystring.variant": true, // requerido
        },
        requestValidatorOptions: {
          validateRequestParameters: true,
        },
      }
    );

    this.apiUrl = api.url;

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "URL base de la API",
    });
    new cdk.CfnOutput(this, "ApiKeyId", {
      value: apiKey.keyId,
      description:
        "ID de la API key — obtener el valor en: Consola → API Gateway → API Keys",
    });
    new cdk.CfnOutput(this, "FlagsEndpoint", {
      value: `${api.url}flags`,
      description: "Endpoint de administración de feature flags",
    });
    new cdk.CfnOutput(this, "ProductsEndpoint", {
      value: `${api.url}products`,
      description: "Endpoint público de listado de seguros",
    });
  }
}
