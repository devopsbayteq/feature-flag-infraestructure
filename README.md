# Feature Flags MFE — AWS AppConfig + React

Implementación de feature flags con dos variantes A/B para micro-frontends React, usando AWS AppConfig para la gestión de flags y CloudWatch RUM para observabilidad.

---

## Estructura del proyecto

```
feature-flags-mfe/
├── infrastructure/          # CDK stack (AppConfig, RUM, Cognito, CloudWatch)
│   ├── bin/app.ts
│   ├── lib/feature-flags-stack.ts
│   ├── cdk.json
│   └── package.json
└── shell-app/               # React Shell App
    └── src/
        ├── hooks/useFeatureFlags.ts
        ├── services/appConfigService.ts
        ├── mfes/
        │   ├── MfeVariantA.tsx
        │   └── MfeVariantB.tsx
        ├── types/flags.ts
        ├── rum.ts
        ├── App.tsx
        └── main.tsx
```

---

## Requisitos previos

- Node.js 18+
- AWS CLI instalado ([descargar para Windows](https://awscli.amazonaws.com/AWSCLIV2.msi))
- Cuenta AWS con permisos IAM (ver sección [Permisos IAM](#permisos-iam))

---

## Paso 1 — Credenciales AWS

### Opción A: Access Key + Secret (desarrollo local)

1. Ir a [IAM Console](https://us-east-1.console.aws.amazon.com/iam/home#/users) → tu usuario → pestaña **Security credentials**
2. Click **Create access key** → seleccionar _CLI_ → guardar `Access Key ID` y `Secret Access Key`
3. Configurar en la terminal:

```bash
aws configure
# AWS Access Key ID:     AKIAIOSFODNN7EXAMPLE
# AWS Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# Default region name:   us-east-1
# Default output format: json
```

4. Verificar acceso:

```bash
aws sts get-caller-identity
# Respuesta esperada: AccountId, UserId y ARN
```

### Opción B: AWS SSO / Identity Center (organizaciones)

```bash
aws configure sso
# Completar wizard: SSO URL, región, nombre del perfil

aws sso login --profile mi-perfil
```

---

## Paso 2 — Permisos IAM

El usuario que ejecuta el CDK necesita la siguiente policy. Ir a **IAM → tu usuario → Add permissions → Create inline policy → JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CDKBootstrapAndDeploy",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListStacks"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CDKBootstrapBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:PutBucketPolicy",
        "s3:GetBucketPolicy",
        "s3:PutBucketVersioning",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutEncryptionConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-*",
        "arn:aws:s3:::cdk-*/*"
      ]
    },
    {
      "Sid": "CDKBootstrapSSM",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:PutParameter",
        "ssm:DeleteParameter"
      ],
      "Resource": "arn:aws:ssm:*:*:parameter/cdk-bootstrap/*"
    },
    {
      "Sid": "AppConfig",
      "Effect": "Allow",
      "Action": [
        "appconfig:CreateApplication",
        "appconfig:DeleteApplication",
        "appconfig:GetApplication",
        "appconfig:UpdateApplication",
        "appconfig:ListApplications",
        "appconfig:CreateEnvironment",
        "appconfig:DeleteEnvironment",
        "appconfig:GetEnvironment",
        "appconfig:UpdateEnvironment",
        "appconfig:ListEnvironments",
        "appconfig:CreateConfigurationProfile",
        "appconfig:DeleteConfigurationProfile",
        "appconfig:GetConfigurationProfile",
        "appconfig:UpdateConfigurationProfile",
        "appconfig:ListConfigurationProfiles",
        "appconfig:CreateHostedConfigurationVersion",
        "appconfig:DeleteHostedConfigurationVersion",
        "appconfig:GetHostedConfigurationVersion",
        "appconfig:ListHostedConfigurationVersions",
        "appconfig:CreateDeploymentStrategy",
        "appconfig:DeleteDeploymentStrategy",
        "appconfig:GetDeploymentStrategy",
        "appconfig:UpdateDeploymentStrategy",
        "appconfig:ListDeploymentStrategies",
        "appconfig:StartDeployment",
        "appconfig:GetDeployment",
        "appconfig:ListDeployments",
        "appconfig:StopDeployment",
        "appconfig:TagResource",
        "appconfig:UntagResource",
        "appconfig:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchRUM",
      "Effect": "Allow",
      "Action": [
        "rum:CreateAppMonitor",
        "rum:DeleteAppMonitor",
        "rum:GetAppMonitor",
        "rum:UpdateAppMonitor",
        "rum:ListAppMonitors",
        "rum:TagResource",
        "rum:UntagResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CognitoIdentity",
      "Effect": "Allow",
      "Action": [
        "cognito-identity:CreateIdentityPool",
        "cognito-identity:DeleteIdentityPool",
        "cognito-identity:DescribeIdentityPool",
        "cognito-identity:UpdateIdentityPool",
        "cognito-identity:SetIdentityPoolRoles",
        "cognito-identity:GetIdentityPoolRoles",
        "cognito-identity:ListIdentityPools",
        "cognito-identity:TagResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IAMForRumRole",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/MfeFeatureFlags*",
        "arn:aws:iam::*:role/cdk-*"
      ]
    },
    {
      "Sid": "CloudWatchLogsAlarmsDashboard",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DescribeLogGroups",
        "logs:TagLogGroup",
        "logs:ListTagsLogGroup",
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:PutDashboard",
        "cloudwatch:DeleteDashboards",
        "cloudwatch:GetDashboard",
        "cloudwatch:ListDashboards"
      ],
      "Resource": "*"
    },
    {
      "Sid": "STSForCDK",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole"
      ],
      "Resource": "arn:aws:iam::*:role/cdk-*"
    }
  ]
}
```

### Qué cubre cada bloque

| Sid | Propósito |
|-----|-----------|
| `CDKBootstrapAndDeploy` | CloudFormation para crear y actualizar el stack |
| `CDKBootstrapBucket` | Bucket S3 `cdk-*` para assets del stack |
| `CDKBootstrapSSM` | Versión del bootstrap en SSM Parameter Store |
| `AppConfig` | Feature flags: aplicación, entorno, perfil y despliegue |
| `CloudWatchRUM` | App Monitor para observabilidad frontend |
| `CognitoIdentity` | Identity Pool para credenciales guest de RUM |
| `IAMForRumRole` | Rol IAM que usa RUM para enviar métricas |
| `CloudWatchLogsAlarmsDashboard` | Log group, alarmas y dashboard |
| `STSForCDK` | CDK asume roles internos durante el deploy |

---

## Paso 3 — Bootstrap de CDK (solo la primera vez por cuenta/región)

```bash
# Obtener Account ID
aws sts get-caller-identity --query Account --output text

# Ejecutar bootstrap (reemplazar ACCOUNT_ID)
cd feature-flags-mfe/infrastructure
npm install
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

Resultado esperado:
```
✅  Environment aws://123456789012/us-east-1 bootstrapped.
```

---

## Paso 4 — Deploy de la infraestructura

```bash
cd feature-flags-mfe/infrastructure

# Staging (dominio temporal, reemplazar luego)
ENVIRONMENT=staging APP_DOMAIN=localhost npm run deploy:staging

# Una vez que Amplify genera el dominio real:
ENVIRONMENT=staging APP_DOMAIN=d1234567890.amplifyapp.com npm run deploy:staging

# Producción
ENVIRONMENT=production APP_DOMAIN=d1234567890.amplifyapp.com npm run deploy:production
```

Al terminar, copiar los valores de los **Outputs**:

```
Outputs:
MfeFeatureFlags-staging.AppConfigApplicationId = abc123def
MfeFeatureFlags-staging.AppConfigEnvironmentId = xyz789
MfeFeatureFlags-staging.AppConfigProfileId     = qrs456
MfeFeatureFlags-staging.RumAppMonitorId         = arn:aws:rum:...
MfeFeatureFlags-staging.CognitoIdentityPoolId   = us-east-1:xxxxxxxx
MfeFeatureFlags-staging.RumGuestRoleArn          = arn:aws:iam::...
```

---

## Paso 5 — Configurar el Shell App

```bash
cd feature-flags-mfe/shell-app
cp .env.example .env.local
```

Editar `.env.local` con los valores de los Outputs del paso anterior:

```env
VITE_AWS_REGION=us-east-1
VITE_APPCONFIG_APP_ID=<AppConfigApplicationId>
VITE_APPCONFIG_ENV_ID=<AppConfigEnvironmentId>
VITE_APPCONFIG_PROFILE_ID=<AppConfigProfileId>
VITE_RUM_APP_MONITOR_ID=<RumAppMonitorId>
VITE_RUM_IDENTITY_POOL_ID=<CognitoIdentityPoolId>
VITE_RUM_GUEST_ROLE_ARN=<RumGuestRoleArn>
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_APP_VERSION=1.0.0
```

---

## Paso 6 — Ejecutar el Shell App

```bash
cd feature-flags-mfe/shell-app
npm install
npm run dev
```

---

## Tags de recursos AWS

Todos los recursos creados por el stack llevan los siguientes tags:

| Tag | Valor |
|-----|-------|
| `PROYECTO` | `3295` |
| `RESPONSABLE` | `EDUARDO PORTILLA` |
| `Project` | `MFE-React` |
| `ManagedBy` | `CDK` |
| `Environment` | `staging` / `production` |

---

## Verificación de permisos

Si cualquier comando responde `AccessDenied`, el mensaje indica exactamente la `Action` y `Resource` faltante:

```bash
# Verificar credenciales
aws sts get-caller-identity

# Verificar acceso a AppConfig
aws appconfig list-applications --region us-east-1

# Verificar acceso a RUM
aws rum list-app-monitors --region us-east-1
```

---

## Recursos AWS creados

| Recurso | Nombre | Descripción |
|---------|--------|-------------|
| AppConfig Application | `mfe-feature-flags-{env}` | Aplicación de feature flags |
| AppConfig Environment | `{env}` | Entorno staging / production |
| AppConfig Profile | `feature-flags` | Perfil tipo Feature Flags |
| AppConfig Deployment Strategy | `mfe-linear-10min-{env}` | Rollout lineal 10 min |
| CloudWatch RUM | `mfe-monitor-{env}` | Monitoreo real de usuarios |
| Cognito Identity Pool | `mfe_rum_identity_{env}` | Credenciales guest para RUM |
| IAM Role | `MfeFeatureFlags*-RumUnauthRole` | Rol de RUM para guests |
| CloudWatch Log Group | `/aws/rum/mfe-{env}` | Logs del RUM (30 días) |
| CloudWatch Alarm | `mfe-js-errors-{env}` | Alerta de errores JS |
| CloudWatch Alarm | `mfe-page-load-{env}` | Alerta de page load lento |
| CloudWatch Dashboard | `MFE-FeatureFlags-{env}` | Dashboard A/B en tiempo real |
