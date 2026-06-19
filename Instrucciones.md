# Instrucciones de despliegue — Infraestructura MFE Feature Flags

Este proyecto contiene toda la infraestructura AWS del piloto de A/B testing con feature flags para micro-frontends. Se gestiona con **AWS CDK v2 (TypeScript)** y despliega tres stacks independientes.

---

## Prerequisitos

| Herramienta | Versión mínima | Verificar |
|---|---|---|
| Node.js | 20.x | `node --version` |
| AWS CLI | 2.x | `aws --version` |
| AWS CDK | 2.140.0 | `cdk --version` |

Además se necesita:
- Una cuenta AWS con permisos de administrador (o los suficientes para crear IAM roles, S3, CloudFront, Lambda, API Gateway, AppConfig, Cognito y CloudWatch).
- AWS CLI configurado con credenciales válidas: `aws configure` o variables de entorno `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

---

## Instalación

```bash
git clone <url-del-repositorio>
cd infrastructure
npm install
```

---

## Stacks desplegados

El proyecto crea tres stacks en este orden (el orden importa por las dependencias entre ellos):

```
MfeAppConfig-{env}   →   MfeHosting-{env}   →   MfeApi-{env}
```

| Stack | Recursos principales |
|---|---|
| `MfeAppConfig-{env}` | AWS AppConfig — aplicación, entorno, perfil de feature flags, versión inicial (split 50/50), estrategia de despliegue |
| `MfeHosting-{env}` | 4 buckets S3 · CloudFront Distribution · 2 CF Functions · KeyValueStore · Cognito Identity Pool · IAM Role · CloudWatch RUM · 2 Alarmas · 2 Dashboards |
| `MfeApi-{env}` | 2 Lambda Functions · API Gateway REST · API Key · Usage Plan |

---

## Despliegue desde cero

### 1. Bootstrap de la cuenta (solo la primera vez)

Si la cuenta nunca ha usado CDK, ejecutar primero:

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
# Ejemplo:
cdk bootstrap aws://452644825489/us-east-1
```

### 2. Desplegar todos los stacks

```bash
# Staging (entorno por defecto)
npm run deploy:staging

# Si se quiere pasar la región/cuenta explícitamente:
CDK_DEFAULT_ACCOUNT=452644825489 CDK_DEFAULT_REGION=us-east-1 npm run deploy:staging
```

Esto equivale a ejecutar `cdk deploy --all --require-approval never` con `ENVIRONMENT=staging`.

### 3. Despliegue individual por stack

```bash
# Solo el stack de AppConfig
ENVIRONMENT=staging npx cdk deploy MfeAppConfig-staging --require-approval never

# Solo el stack de Hosting
ENVIRONMENT=staging npx cdk deploy MfeHosting-staging --require-approval never

# Solo el stack de API
ENVIRONMENT=staging npx cdk deploy MfeApi-staging --require-approval never
```

### 4. Ver diferencias sin desplegar

```bash
npm run diff
```

---

## Outputs — valores a guardar

Al finalizar cada `cdk deploy`, la consola imprime los outputs de cada stack. **Copiar y guardar estos valores**: son necesarios para configurar los proyectos de aplicación.

### MfeHosting-staging

| Output | Descripción | Variable de entorno en el proyecto |
|---|---|---|
| `DistributionUrl` | URL pública de CloudFront (dominio del sitio) | Configurar en el `.env` del host como dominio base |
| `DistributionId` | ID de la distribución CloudFront | Necesario para invalidaciones manuales: `aws cloudfront create-invalidation --distribution-id <ID>` |
| `BucketName` | Bucket S3 para la shell-app (proyecto feature-flags-mfe original) | Destino del `aws s3 sync` en el deploy del host original |
| `MfeProductoBucketName` | Bucket S3 para el MFE producto (proyecto original) | Destino del `aws s3 sync` del MFE producto |
| `RumAppMonitorId` | UUID del App Monitor de CloudWatch RUM | `NEXT_PUBLIC_RUM_APP_MONITOR_ID` |
| `CognitoIdentityPoolId` | ID del Identity Pool de Cognito | `NEXT_PUBLIC_RUM_IDENTITY_POOL_ID` |
| `RumGuestRoleArn` | ARN del rol IAM para usuarios anónimos de RUM | `NEXT_PUBLIC_RUM_GUEST_ROLE_ARN` |
| `KvsArn` | ARN del CloudFront KeyValueStore | Pasado automáticamente al stack MfeApi; no se requiere en el frontend |
| `DashboardV2Url` | URL directa al dashboard `mfe-ab-v2-staging` en CloudWatch | Acceso rápido al monitoreo A/B |

### MfeApi-staging

| Output | Descripción | Variable de entorno en el proyecto |
|---|---|---|
| `ApiUrl` | URL base de la API (incluye el stage) | `NEXT_PUBLIC_API_BASE_URL` y `NEXT_PUBLIC_METRICS_BASE_URL` |
| `FlagsEndpoint` | Endpoint completo para administrar flags | `PATCH <FlagsEndpoint>/mfe-variant` para cambiar el split |
| `ProductsEndpoint` | Endpoint público de productos por variante | Usado internamente por el MFE |
| `ApiKeyId` | ID de la API key (el **valor** se obtiene en la consola) | Ver paso siguiente |

#### Obtener el valor de la API Key

El output `ApiKeyId` entrega solo el identificador, no el valor secreto. Para obtenerlo:

```bash
aws apigateway get-api-key \
  --api-key <ApiKeyId> \
  --include-value \
  --region us-east-1 \
  --query "value" \
  --output text
```

Guardar este valor como secreto (`API_KEY`) en el repositorio o en un gestor de secretos. Se usa en el header `x-api-key` para llamar a `/flags`.

---

## Buckets S3 creados y su uso

| Bucket | Patrón de nombre | Behavior CloudFront | Proyecto que lo usa |
|---|---|---|---|
| `seguro-host-{env}-{account}` | Default (`/*`) | Host Next.js — challenge-ab-testing (shell) | `challenge-ab-testing` (host) |
| `seguro-mfe-{env}-{account}` | `/seguro-mfe/*` | MFE chunks de Module Federation | `challenge-ab-testing` (MFE) |
| `mfe-ff-{env}-{account}` | (behavior heredado) | Shell-app del proyecto feature-flags original | Proyecto feature-flags-mfe original |
| `mfe-producto-{env}-{account}` | `/mfe-producto/*` | MFE producto del proyecto original | Proyecto feature-flags-mfe original |

---

## Configurar los proyectos de aplicación

Con los valores obtenidos de los outputs, crear o actualizar el `.env` de cada proyecto:

### challenge-ab-testing (host + MFE)

```env
# ── AWS Region ─────────────────────────────────────────────
NEXT_PUBLIC_AWS_REGION=us-east-1

# ── API Gateway ─────────────────────────────────────────────
NEXT_PUBLIC_API_BASE_URL=<MfeApi-staging.ApiUrl>
NEXT_PUBLIC_METRICS_BASE_URL=<MfeApi-staging.ApiUrl>
NEXT_PUBLIC_SEGURO_API_BASE_URL=<url-del-api-gateway-de-seguros>
NEXT_PUBLIC_PRODUCTOS_API_BASE_URL=<url-del-api-gateway-de-seguros>
NEXT_PUBLIC_USE_API_MOCK=false

# ── CloudWatch RUM ──────────────────────────────────────────
NEXT_PUBLIC_RUM_APP_MONITOR_ID=<MfeHosting-staging.RumAppMonitorId>
NEXT_PUBLIC_RUM_IDENTITY_POOL_ID=<MfeHosting-staging.CognitoIdentityPoolId>
NEXT_PUBLIC_RUM_GUEST_ROLE_ARN=<MfeHosting-staging.RumGuestRoleArn>

# ── App ─────────────────────────────────────────────────────
NEXT_PUBLIC_APP_VERSION=1.0.0
NEXT_MFE_PUBLIC_URL=<MfeHosting-staging.DistributionUrl>/seguro-mfe
```

### GitHub Actions — secrets requeridos

Añadir en **Settings → Secrets and variables → Actions** de cada repositorio:

| Secret | Valor |
|---|---|
| `AWS_ACCESS_KEY_ID` | Credencial de despliegue en AWS |
| `AWS_SECRET_ACCESS_KEY` | Credencial de despliegue en AWS |
| `RUM_APP_MONITOR_ID` | Output `RumAppMonitorId` |
| `RUM_IDENTITY_POOL_ID` | Output `CognitoIdentityPoolId` |
| `RUM_GUEST_ROLE_ARN` | Output `RumGuestRoleArn` |
| `SONAR_TOKEN` | Token de SonarCloud del proyecto |
| `NVD_API_KEY` | API key de NVD para OWASP Dependency Check |

---

## Ajustar el split A/B sin redeploy

El porcentaje de usuarios que recibe la Variante A se controla en caliente mediante la API:

```bash
curl -X PATCH <MfeApi-staging.FlagsEndpoint>/mfe-variant \
  -H "x-api-key: <valor-de-la-api-key>" \
  -H "Content-Type: application/json" \
  -d '{ "splitPercentage": 80 }'
```

Esto actualiza el CloudFront KeyValueStore. El cambio es efectivo en segundos para todos los nuevos requests en el edge, sin redeploy de ningún stack.

---

## Destruir el entorno

```bash
npm run destroy:staging
```

> Los buckets S3 se crean con `autoDeleteObjects: true` y `removalPolicy: DESTROY`, por lo que se vacían y eliminan automáticamente al destruir el stack. Revisar que no haya contenido que necesite preservarse antes de ejecutar este comando.

---

## Estructura del proyecto

```
infrastructure/
├── bin/
│   └── app.ts                  # Punto de entrada CDK — instancia los 3 stacks
├── lib/
│   ├── appconfig-stack.ts      # Stack 1: AWS AppConfig (feature flags)
│   ├── hosting-stack.ts        # Stack 2: S3 + CloudFront + RUM + CloudWatch
│   └── api-stack.ts            # Stack 3: API Gateway + Lambda
├── src/
│   ├── edge/
│   │   └── variant-assignment.js   # CF Function JS 2.0 — asigna cookie mfe-variant
│   └── handlers/
│       ├── flag-manager.ts         # Lambda — CRUD de flags sobre AppConfig + KVS
│       └── product-listing.ts      # Lambda — devuelve producto por variante
├── cdk.json                    # Configuración CDK
├── tsconfig.json
└── package.json
```
