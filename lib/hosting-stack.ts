import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rum from "aws-cdk-lib/aws-rum";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";
import * as fs from "fs";

export interface HostingStackProps extends cdk.StackProps {
  environmentName: string;
}

// Formato JSON requerido por CloudFront KeyValueStore ImportSource
const kvsInitialData = JSON.stringify({
  data: [{ key: "splitPercentage", value: "50" }],
});

/**
 * HostingStack — alojamiento del MFE y monitoreo.
 *
 * Recursos:
 *  - S3 Bucket (assets React) — acceso solo desde CloudFront (OAC)
 *  - CloudFront Function (viewer-response) — asigna cookie `mfe-variant`
 *    determinísticamente en el edge; sin llamada adicional del cliente
 *  - CloudFront Distribution — HTTPS, SPA fallback, cache optimizado
 *  - Cognito Identity Pool + IAM Role — acceso guest para CloudWatch RUM
 *  - CloudWatch RUM App Monitor — telemetría de performance por variante
 *  - CloudWatch Alarms + Dashboard — monitoreo de PageLoadTime y errores JS
 *
 * Flujo de asignación A/B:
 *  1. Primera visita: CF Function lee cookie `mfe-variant`; si no existe,
 *     asigna variante con hash(userId | IP) y la persiste en Set-Cookie.
 *  2. React lee `document.cookie['mfe-variant']` al montar; llama /products.
 *  3. Visitas siguientes: cookie ya existe → CF Function la respeta → cero latencia.
 *
 * Para hacer el splitPercentage dinámico sin redeployar la CF Function,
 * usar CloudFront KeyValueStore (ver comentario en variant-assignment.js).
 */
export class HostingStack extends cdk.Stack {
  public readonly distributionDomain: string;
  public readonly bucketName: string;
  public readonly mfeSeguroBucketName: string;
  public readonly kvsArn: string;

  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    // ── 1. S3 Bucket ─────────────────────────────────────────────────────────
    const bucket = new s3.Bucket(this, "MfeBucket", {
      bucketName: `mfe-ff-${props.environmentName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    // ── 1b. S3 Bucket — MFE Seguro (remote) ─────────────────────────────────
    const mfeSeguroBucket = new s3.Bucket(this, "MfeProductoBucket", {
      bucketName: `mfe-producto-${props.environmentName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    this.mfeSeguroBucketName = mfeSeguroBucket.bucketName;

    // ── 1c. S3 Buckets — Reto BBol: host + mfe ──────────────────────────────
    const retoHostBucket = new s3.Bucket(this, "RetoHostBucket", {
      bucketName: `seguro-host-${props.environmentName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    const retoMfeBucket = new s3.Bucket(this, "RetoMfeBucket", {
      bucketName: `seguro-mfe-${props.environmentName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    // ── 2. CloudFront KeyValueStore — splitPercentage dinámico ───────────────
    const kvStore = new cloudfront.KeyValueStore(this, "SplitKvStore", {
      keyValueStoreName: `mfe-split-kv-${props.environmentName}`,
      comment: "Almacena splitPercentage para la asignación A/B; actualizable sin redeploy",
      source: cloudfront.ImportSource.fromInline(kvsInitialData),
    });

    this.kvsArn = kvStore.keyValueStoreArn;

    // ── 3. CloudFront Function — asignación de variante en el edge ────────────
    // Lee el código fuente e inyecta el ARN del KVS (token CDK → CloudFormation)
    const rawFnCode = fs.readFileSync(
      path.join(__dirname, "../src/edge/variant-assignment.js"),
      "utf-8"
    );
    const fnCodeWithKvs = rawFnCode.replace("__KVS_ARN__", kvStore.keyValueStoreArn);

    const variantFn = new cloudfront.Function(this, "VariantAssignment", {
      functionName: `mfe-variant-assignment-${props.environmentName}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(fnCodeWithKvs),
      keyValueStore: kvStore,
      comment: "Asigna cookie mfe-variant en el edge; lee splitPercentage del KVS",
    });

    // ── 3b. CloudFront Function — SPA path rewrite para el host Next.js ──────
    // Next.js output:export genera archivos .html sin trailing slash.
    // Esta funcion VIEWER_REQUEST reescribe:
    //   /seguro-host/          → /seguro-host/index.html
    //   /seguro-host/onboarding/antes → /seguro-host/onboarding/antes.html
    // Los assets con extension (.js, .css, .png, etc.) pasan sin cambio.
    const spaRewriteFn = new cloudfront.Function(this, "SpaIndexRewrite", {
      functionName: `spa-index-rewrite-${props.environmentName}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Reescribe rutas SPA Next.js a archivos .html para S3 static export",
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.split('/').pop().indexOf('.') === -1) {
    request.uri = uri + '.html';
  }
  return request;
}
      `.trim()),
    });

    // ── 3. CloudFront Distribution ───────────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `MFE Feature Flags — ${props.environmentName}`,
      defaultRootObject: "index.html",
      defaultBehavior: {
        // ── Reto BBol: host Next.js en la raíz del dominio ──────────────────
        origin: origins.S3BucketOrigin.withOriginAccessControl(retoHostBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            // Reescribe rutas SPA sin extensión a .html antes de consultar S3
            function: spaRewriteFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
          {
            // Asigna cookie mfe-variant en cada respuesta
            function: variantFn,
            eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
          },
        ],
      },
      additionalBehaviors: {
        // MFE feature-flags (proyecto original) — se mantiene por compatibilidad
        "/mfe-producto/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(mfeSeguroBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            {
              function: variantFn,
              eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
            },
          ],
        },

        // ── Reto BBol: MFE chunks (remoteEntry.js + assets federation) ──────
        "/seguro-mfe/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(retoMfeBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: [
            {
              function: variantFn,
              eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
            },
          ],
        },
      },
      // SPA: devolver index.html en 403/404 para que React Router maneje las rutas
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    this.distributionDomain = distribution.distributionDomainName;
    this.bucketName = bucket.bucketName;

    // ── 4. Cognito Identity Pool para RUM (acceso guest anónimo) ─────────────
    const identityPool = new cognito.CfnIdentityPool(this, "RumIdentityPool", {
      identityPoolName: `mfe_rum_${props.environmentName}`,
      allowUnauthenticatedIdentities: true,
    });

    const rumRole = new iam.Role(this, "RumUnauthRole", {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "unauthenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
      description: "Rol para CloudWatch RUM (usuarios anónimos)",
    });

    rumRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["rum:PutRumEvents"],
        resources: [
          `arn:aws:rum:${this.region}:${this.account}:appmonitor/*`,
        ],
      })
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, "RumRoleAttachment", {
      identityPoolId: identityPool.ref,
      roles: { unauthenticated: rumRole.roleArn },
    });

    // ── 5. CloudWatch RUM ────────────────────────────────────────────────────
    new logs.LogGroup(this, "RumLogGroup", {
      logGroupName: `/aws/rum/mfe-${props.environmentName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const rumMonitor = new rum.CfnAppMonitor(this, "RumMonitor", {
      name: `mfe-monitor-${props.environmentName}`,
      domain: distribution.distributionDomainName,
      cwLogEnabled: true,
      // Sin esto, rumClient.recordEvent() es ignorado — custom events estan DISABLED por defecto
      customEvents: {
        status: "ENABLED",
      },
      appMonitorConfiguration: {
        allowCookies: true,
        enableXRay: true,
        sessionSampleRate: 1.0,
        telemetries: ["errors", "performance", "http"],
        identityPoolId: identityPool.ref,
        guestRoleArn: rumRole.roleArn,
        includedPages: [
          `https://${distribution.distributionDomainName}/*`,
        ],
        metricDestinations: [
          {
            destination: "CloudWatch",
            metricDefinitions: [
              {
                name: "PageLoadTime",
                namespace: "RUM/CustomMetrics/MFE/RUM",
                unitLabel: "Milliseconds",
                valueKey: "event_details.duration",
                // dimensionKeys requiere eventPattern — se omite para evitar ValidationException
              },
              {
                name: "JsErrorCount",
                namespace: "RUM/CustomMetrics/MFE/RUM",
                unitLabel: "Count",
                valueKey: "event_details.errorCount",
              },
              // ── Métricas A/B por variante ────────────────────────────────
              // Evento: variant_view { variant, count: 1 }
              // Resultado: métrica VariantViewCount con dimensión Variant=variant-a|variant-b
              // eventPattern DEBE referenciar los mismos campos que dimensionKeys
              // (regla de validacion de CloudWatch RUM)
              {
                name: "VariantViewCount",
                namespace: "RUM/CustomMetrics/MFE/AB",
                unitLabel: "Count",
                valueKey: "event_details.count",
                eventPattern: JSON.stringify({
                  event_type: ["variant_view"],
                  event_details: { variant: ["A", "B"] },
                }),
                dimensionKeys: { "event_details.variant": "Variant" },
              },
              {
                name: "ProductViewCount",
                namespace: "RUM/CustomMetrics/MFE/AB",
                unitLabel: "Count",
                valueKey: "event_details.count",
                eventPattern: JSON.stringify({
                  event_type: ["product_viewed"],
                  event_details: { variant: ["A", "B"] },
                }),
                dimensionKeys: { "event_details.variant": "Variant" },
              },
              // Clicks de botones (Solicitar / Omitir / Anular) por variante
              {
                name: "ButtonClickCount",
                namespace: "RUM/CustomMetrics/MFE/AB",
                unitLabel: "Count",
                valueKey: "event_details.count",
                eventPattern: JSON.stringify({
                  event_type: ["button_click"],
                  event_details: {
                    variant: ["A", "B"],
                    buttonName: ["Solicitar", "Omitir", "Anular"],
                  },
                }),
                dimensionKeys: {
                  "event_details.variant": "Variant",
                  "event_details.buttonName": "Button",
                },
              },
            ],
          },
        ],
      },
    });
    rumMonitor.addDependency(identityPool);

    // ── 6. CloudWatch Alarms ─────────────────────────────────────────────────
    const pageLoadAlarm = new cloudwatch.Alarm(this, "PageLoadAlarm", {
      alarmName: `mfe-page-load-p90-${props.environmentName}`,
      alarmDescription: "Page load p90 > 3 s — revisar variante activa",
      metric: new cloudwatch.Metric({
        namespace: "RUM/CustomMetrics/MFE/RUM",
        metricName: "PageLoadTime",
        statistic: "p90",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3000,
      evaluationPeriods: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const jsErrorAlarm = new cloudwatch.Alarm(this, "JsErrorAlarm", {
      alarmName: `mfe-js-errors-${props.environmentName}`,
      alarmDescription: "Errores JS > 50 en 5 min — considerar rollback del flag",
      metric: new cloudwatch.Metric({
        namespace: "RUM/CustomMetrics/MFE/RUM",
        metricName: "JsErrorCount",
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── 7. CloudWatch Dashboard ──────────────────────────────────────────────
    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `MFE-FeatureFlags-${props.environmentName}`,
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: [
          `# MFE Feature Flags — ${props.environmentName}`,
          `**Dominio:** https://${distribution.distributionDomainName}`,
          "Monitoreo A/B en tiempo real",
        ].join("\n"),
        width: 24,
        height: 2,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: "Estado de Alarmas",
        alarms: [jsErrorAlarm, pageLoadAlarm],
        width: 6,
        height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: "Page Load p90 (ms)",
        width: 9,
        height: 4,
        left: [
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/RUM",
            metricName: "PageLoadTime",
            statistic: "p90",
            label: "p90",
            color: "#1f77b4",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/RUM",
            metricName: "PageLoadTime",
            statistic: "p50",
            label: "p50",
            color: "#aec7e8",
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Errores JS por variante",
        width: 9,
        height: 4,
        left: [
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/RUM",
            metricName: "JsErrorCount",
            dimensionsMap: { Page: "variant-a" },
            statistic: "Sum",
            label: "Variant A",
            color: "#1f77b4",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/RUM",
            metricName: "JsErrorCount",
            dimensionsMap: { Page: "variant-b" },
            statistic: "Sum",
            label: "Variant B",
            color: "#ff7f0e",
          }),
        ],
      })
    );

    // Segunda fila: métricas A/B por variante
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Vistas por Variante (A vs B)",
        width: 12,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "VariantViewCount",
            dimensionsMap: { Variant: "A", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "Variant A",
            color: "#1f77b4",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "VariantViewCount",
            dimensionsMap: { Variant: "B", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "Variant B",
            color: "#ff7f0e",
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Productos Vistos por Variante",
        width: 12,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ProductViewCount",
            dimensionsMap: { Variant: "A", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "Variant A — SEG-001",
            color: "#1f77b4",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ProductViewCount",
            dimensionsMap: { Variant: "B", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "Variant B — SEG-002",
            color: "#ff7f0e",
          }),
        ],
      })
    );

    // Tercera fila: clicks de botones por variante y accion
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Clicks de Botones por Variante",
        width: 24,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ButtonClickCount",
            dimensionsMap: { Variant: "A", Button: "Solicitar", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "A - Solicitar",
            color: "#1f77b4",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ButtonClickCount",
            dimensionsMap: { Variant: "B", Button: "Solicitar", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "B - Solicitar",
            color: "#aec7e8",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ButtonClickCount",
            dimensionsMap: { Variant: "A", Button: "Omitir", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "A - Omitir",
            color: "#ff7f0e",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ButtonClickCount",
            dimensionsMap: { Variant: "B", Button: "Omitir", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "B - Omitir",
            color: "#ffbb78",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ButtonClickCount",
            dimensionsMap: { Variant: "A", Button: "Anular", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "A - Anular",
            color: "#d62728",
          }),
          new cloudwatch.Metric({
            namespace: "RUM/CustomMetrics/MFE/AB",
            metricName: "ButtonClickCount",
            dimensionsMap: { Variant: "B", Button: "Anular", application_name: `mfe-monitor-${props.environmentName}` },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            label: "B - Anular",
            color: "#ff9896",
          }),
        ],
      })
    );

    // ── Dashboard v2 ─────────────────────────────────────────────────────────
    // Dashboard independiente para validar que las metricDefinitions corregidas
    // (RUM/CustomMetrics/MFE/AB) publican datos. Una vez validado, se puede
    // eliminar este dashboard o reemplazar el original.
    const dashboardV2 = new cloudwatch.Dashboard(this, "AbDashboardV2", {
      dashboardName: `mfe-ab-v2-${props.environmentName}`,
    });

    const envName = props.environmentName;
    const appName = `mfe-monitor-${envName}`;

    const mkMetric = (
      metricName: string,
      dims: Record<string, string>,
      label: string,
      color: string
    ) =>
      new cloudwatch.Metric({
        namespace: "RUM/CustomMetrics/MFE/AB",
        metricName,
        dimensionsMap: { ...dims, application_name: appName },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
        label,
        color,
      });

    // Fila 1 — Vistas por variante y productos vistos
    dashboardV2.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Vistas por Variante (A vs B)",
        width: 12,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          mkMetric("VariantViewCount", { Variant: "A" }, "Variant A", "#1f77b4"),
          mkMetric("VariantViewCount", { Variant: "B" }, "Variant B", "#ff7f0e"),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Productos Vistos por Variante",
        width: 12,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          mkMetric("ProductViewCount", { Variant: "A" }, "Variant A — SEG-001", "#1f77b4"),
          mkMetric("ProductViewCount", { Variant: "B" }, "Variant B — SEG-002", "#ff7f0e"),
        ],
      })
    );

    // Fila 2 — Clicks de botones por variante (Solicitar / Omitir / Anular)
    dashboardV2.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Clicks de Botones por Variante",
        width: 24,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        left: [
          mkMetric("ButtonClickCount", { Variant: "A", Button: "Solicitar" }, "A - Solicitar", "#1f77b4"),
          mkMetric("ButtonClickCount", { Variant: "B", Button: "Solicitar" }, "B - Solicitar", "#aec7e8"),
          mkMetric("ButtonClickCount", { Variant: "A", Button: "Omitir"   }, "A - Omitir",    "#ff7f0e"),
          mkMetric("ButtonClickCount", { Variant: "B", Button: "Omitir"   }, "B - Omitir",    "#ffbb78"),
          mkMetric("ButtonClickCount", { Variant: "A", Button: "Anular"   }, "A - Anular",    "#d62728"),
          mkMetric("ButtonClickCount", { Variant: "B", Button: "Anular"   }, "B - Anular",    "#ff9896"),
        ],
      })
    );

    // Fila 3 — Alarmas de rendimiento (reutiliza las ya creadas)
    dashboardV2.addWidgets(
      new cloudwatch.AlarmWidget({
        title: "Page Load p90",
        alarm: pageLoadAlarm,
        width: 12,
        height: 6,
      }),
      new cloudwatch.AlarmWidget({
        title: "JS Errors",
        alarm: jsErrorAlarm,
        width: 12,
        height: 6,
      })
    );

    new cdk.CfnOutput(this, "DashboardV2Url", {
      value: `https://${props.env?.region ?? "us-east-1"}.console.aws.amazon.com/cloudwatch/home#dashboards:name=mfe-ab-v2-${envName}`,
      description: "URL del dashboard v2 — validación de métricas corregidas",
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "DistributionUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "URL del MFE (CloudFront)",
    });
    new cdk.CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
      description: "S3 bucket — subir aquí el build de React (shell-app)",
    });
    new cdk.CfnOutput(this, "MfeProductoBucketName", {
      value: mfeSeguroBucket.bucketName,
      description: "S3 bucket — subir aquí el build del MFE Seguro",
    });
    new cdk.CfnOutput(this, "MfeProductoUrl", {
      value: `https://${distribution.distributionDomainName}/mfe-producto/`,
      description: "URL base del MFE Seguro en CloudFront",
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
      description: "ID de la distribución CloudFront (para invalidaciones)",
    });

    // Outputs para variables de entorno del shell-app (.env)
    new cdk.CfnOutput(this, "RumAppMonitorId", {
      value: rumMonitor.attrId,   // attrId = UUID; ref = nombre (incorrecto para el SDK)
      description: "VITE_RUM_APP_MONITOR_ID — ID del App Monitor de CloudWatch RUM",
    });
    new cdk.CfnOutput(this, "CognitoIdentityPoolId", {
      value: identityPool.ref,
      description: "VITE_RUM_IDENTITY_POOL_ID — ID del Identity Pool de Cognito para RUM",
    });
    new cdk.CfnOutput(this, "RumGuestRoleArn", {
      value: rumRole.roleArn,
      description: "VITE_RUM_GUEST_ROLE_ARN — ARN del rol IAM para usuarios anónimos de RUM",
    });
    new cdk.CfnOutput(this, "KvsArn", {
      value: kvStore.keyValueStoreArn,
      description: "ARN del CloudFront KeyValueStore — usado por el flag-manager Lambda para actualizar splitPercentage",
    });
  }
}
