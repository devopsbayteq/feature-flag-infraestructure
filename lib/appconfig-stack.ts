import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as appconfig from "aws-cdk-lib/aws-appconfig";

export interface AppConfigStackProps extends cdk.StackProps {
  environmentName: string;
}

/**
 * AppConfigStack — fuente de verdad de los feature flags.
 *
 * Recursos:
 *  - AppConfig Application + Environment + Configuration Profile (Feature Flags)
 *  - Hosted Configuration Version con schema correcto (no usa variants/splits/rules)
 *  - Deployment Strategy AllAtOnce + Deployment inicial
 *
 * El atributo `splitPercentage` (0–100) es la única forma de controlar el split A/B.
 * Se modifica vía la Flag Manager API (api-stack) sin redeploy.
 */
export class AppConfigStack extends cdk.Stack {
  public readonly appConfigAppId: string;
  public readonly appConfigEnvId: string;
  public readonly appConfigProfileId: string;
  public readonly deploymentStrategyId: string;

  constructor(scope: Construct, id: string, props: AppConfigStackProps) {
    super(scope, id, props);

    // ── 1. Aplicación ────────────────────────────────────────────────────────
    const application = new appconfig.CfnApplication(this, "Application", {
      name: `mfe-feature-flags-${props.environmentName}`,
      description: "Feature flags para micro-frontends React",
    });

    // ── 2. Entorno ───────────────────────────────────────────────────────────
    const environment = new appconfig.CfnEnvironment(this, "Environment", {
      applicationId: application.ref,
      name: props.environmentName,
      description: `Entorno ${props.environmentName}`,
    });

    // ── 3. Perfil de configuración ───────────────────────────────────────────
    const profile = new appconfig.CfnConfigurationProfile(this, "Profile", {
      applicationId: application.ref,
      name: "feature-flags",
      locationUri: "hosted",
      type: "AWS.AppConfig.FeatureFlags",
      description: "Flags con variantes A/B para MFEs",
    });

    // ── 4. Versión inicial — schema válido para AWS.AppConfig.FeatureFlags ───
    //
    // ⚠️  AWS solo acepta: flags / values / version
    //     NO existen: variants, splits, rules (campos inventados)
    //
    // El split A/B se controla con el atributo `splitPercentage`:
    //   usuarios con hash(userId) % 100 < splitPercentage → variant-a
    //   el resto → variant-b
    const flagConfig = {
      flags: {
        "mfe-variant": {
          name: "MFE Variant",
          description: "Controla qué variante del MFE se sirve al usuario",
          attributes: {
            component: {
              constraints: { type: "string", enum: ["variant-a", "variant-b"] },
            },
            enableNewFeatures: {
              constraints: { type: "boolean" },
            },
            splitPercentage: {
              constraints: { type: "number", minimum: 0, maximum: 100 },
            },
          },
        },
      },
      values: {
        "mfe-variant": {
          enabled: true,
          component: "variant-a",
          enableNewFeatures: false,
          splitPercentage: 50, // 50 % variant-a / 50 % variant-b
        },
      },
      version: "1",
    };

    const hostedConfig = new appconfig.CfnHostedConfigurationVersion(
      this,
      "HostedConfig",
      {
        applicationId: application.ref,
        configurationProfileId: profile.ref,
        content: JSON.stringify(flagConfig),
        contentType: "application/json",
        description: "Configuración inicial: split 50/50",
      }
    );

    // ── 5. Estrategia de despliegue — AllAtOnce para cambios en feature flags
    const deploymentStrategy = new appconfig.CfnDeploymentStrategy(
      this,
      "AllAtOnce",
      {
        name: `mfe-all-at-once-${props.environmentName}`,
        deploymentDurationInMinutes: 0,
        growthFactor: 100,
        finalBakeTimeInMinutes: 0,
        replicateTo: "NONE",
        growthType: "LINEAR",
        description: "Despliegue inmediato — feature flags no necesitan rollout gradual",
      }
    );

    // ── 6. Despliegue inicial ────────────────────────────────────────────────
    const deployment = new appconfig.CfnDeployment(this, "InitialDeployment", {
      applicationId: application.ref,
      environmentId: environment.ref,
      configurationProfileId: profile.ref,
      configurationVersion: hostedConfig.ref,
      deploymentStrategyId: deploymentStrategy.ref,
      description: "Despliegue inicial de feature flags",
    });
    deployment.addDependency(hostedConfig);

    // ── Outputs ──────────────────────────────────────────────────────────────
    this.appConfigAppId = application.ref;
    this.appConfigEnvId = environment.ref;
    this.appConfigProfileId = profile.ref;
    this.deploymentStrategyId = deploymentStrategy.ref;

    new cdk.CfnOutput(this, "AppId", {
      value: application.ref,
      description: "AppConfig Application ID",
      exportName: `${id}-AppId`,
    });
    new cdk.CfnOutput(this, "EnvId", {
      value: environment.ref,
      description: "AppConfig Environment ID",
      exportName: `${id}-EnvId`,
    });
    new cdk.CfnOutput(this, "ProfileId", {
      value: profile.ref,
      description: "AppConfig Configuration Profile ID",
      exportName: `${id}-ProfileId`,
    });
    new cdk.CfnOutput(this, "DeploymentStrategyId", {
      value: deploymentStrategy.ref,
      description: "AppConfig Deployment Strategy ID (AllAtOnce)",
      exportName: `${id}-DeploymentStrategyId`,
    });
  }
}
