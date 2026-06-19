# Infraestructura — MFE Feature Flags

Infraestructura AWS del piloto de A/B testing con feature flags para micro-frontends React. Gestionada con **AWS CDK v2 (TypeScript)**.

Para instrucciones detalladas de despliegue, valores de salida y configuración de los proyectos dependientes, ver **[Instrucciones.md](./Instrucciones.md)**.

---

## Estructura del proyecto

```
infrastructure/
├── bin/
│   └── app.ts                      # Punto de entrada CDK — instancia los 3 stacks
├── lib/
│   ├── appconfig-stack.ts          # Stack 1: AWS AppConfig (feature flags)
│   ├── hosting-stack.ts            # Stack 2: S3 + CloudFront + RUM + CloudWatch
│   └── api-stack.ts                # Stack 3: API Gateway + Lambda
├── src/
│   ├── edge/
│   │   └── variant-assignment.js   # CF Function JS 2.0 — asigna cookie mfe-variant
│   └── handlers/
│       ├── flag-manager.ts         # Lambda — CRUD de flags sobre AppConfig + KVS
│       └── product-listing.ts      # Lambda — devuelve producto por variante
├── cdk.json                        # Configuración CDK
├── tsconfig.json
├── package.json
├── .gitignore
├── Instrucciones.md                # Guía completa de despliegue y configuración
└── README.md
```

---

## Stacks

| Stack | Nombre en AWS | Recursos principales |
|---|---|---|
| AppConfig | `MfeAppConfig-{env}` | AppConfig Application · Environment · Configuration Profile · Deployment Strategy |
| Hosting | `MfeHosting-{env}` | 4 buckets S3 · CloudFront Distribution · 2 CF Functions · KeyValueStore · Cognito Identity Pool · CloudWatch RUM · Alarmas · Dashboards |
| API | `MfeApi-{env}` | 2 Lambda Functions · API Gateway REST · API Key · Usage Plan |

---

## Inicio rápido

```bash
npm install
npm run deploy:staging
```

Ver [Instrucciones.md](./Instrucciones.md) para prerequisitos, bootstrap de CDK y los valores de salida que deben configurarse en los proyectos dependientes.
