import {
  AppConfigClient,
  GetHostedConfigurationVersionCommand,
  CreateHostedConfigurationVersionCommand,
  StartDeploymentCommand,
  ListHostedConfigurationVersionsCommand,
} from "@aws-sdk/client-appconfig";
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";

const client = new AppConfigClient({});
const kvsClient = new CloudFrontKeyValueStoreClient({ region: "us-east-1" });
const KVS_ARN = process.env.KVS_ARN ?? "";

const APP_ID = process.env.APP_ID!;
const ENV_ID = process.env.ENV_ID!;
const PROFILE_ID = process.env.PROFILE_ID!;
const DEPLOYMENT_STRATEGY_ID = process.env.DEPLOYMENT_STRATEGY_ID!;

interface FlagValues {
  enabled: boolean;
  component: string;
  enableNewFeatures: boolean;
  splitPercentage: number;
}

interface FlagConfig {
  flags: Record<string, unknown>;
  values: Record<string, FlagValues>;
  version: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getLatestVersion(): Promise<{ version: number; config: FlagConfig }> {
  const list = await client.send(
    new ListHostedConfigurationVersionsCommand({
      ApplicationId: APP_ID,
      ConfigurationProfileId: PROFILE_ID,
      MaxResults: 1,
    })
  );

  const latest = list.Items?.[0];
  if (!latest?.VersionNumber) throw new Error("No hosted configuration versions found");

  const raw = await client.send(
    new GetHostedConfigurationVersionCommand({
      ApplicationId: APP_ID,
      ConfigurationProfileId: PROFILE_ID,
      VersionNumber: latest.VersionNumber,
    })
  );

  const content = new TextDecoder().decode(raw.Content as Uint8Array);
  return { version: latest.VersionNumber, config: JSON.parse(content) };
}

async function saveAndDeploy(config: FlagConfig): Promise<void> {
  const created = await client.send(
    new CreateHostedConfigurationVersionCommand({
      ApplicationId: APP_ID,
      ConfigurationProfileId: PROFILE_ID,
      Content: Buffer.from(JSON.stringify(config)),
      ContentType: "application/json",
    })
  );

  await client.send(
    new StartDeploymentCommand({
      ApplicationId: APP_ID,
      EnvironmentId: ENV_ID,
      ConfigurationProfileId: PROFILE_ID,
      ConfigurationVersion: String(created.VersionNumber),
      DeploymentStrategyId: DEPLOYMENT_STRATEGY_ID,
    })
  );
}

function ok(body: unknown, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function err(message: string, status = 400) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}

// ── Handler principal ────────────────────────────────────────────────────────

export const handler = async (event: {
  httpMethod: string;
  pathParameters?: { flagKey?: string };
  body?: string;
}) => {
  const method = event.httpMethod;
  const flagKey = event.pathParameters?.flagKey;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // GET /flags — lista todos los flags con su estado actual
    if (method === "GET" && !flagKey) {
      const { config } = await getLatestVersion();
      const flags = Object.entries(config.values).map(([key, values]) => ({
        key,
        ...(config.flags[key] as object),
        values,
      }));
      return ok({ flags });
    }

    // POST /flags — crea un nuevo flag
    if (method === "POST") {
      const { flagKey: newKey, name, attributes, initialValues } = body;
      if (!newKey || !name || !initialValues) {
        return err("Campos requeridos: flagKey, name, initialValues");
      }

      const { config } = await getLatestVersion();

      if (config.flags[newKey]) {
        return err(`El flag '${newKey}' ya existe`, 409);
      }

      config.flags[newKey] = { name, attributes: attributes ?? {} };
      config.values[newKey] = {
        enabled: initialValues.enabled ?? true,
        component: initialValues.component ?? "variant-a",
        enableNewFeatures: initialValues.enableNewFeatures ?? false,
        splitPercentage: initialValues.splitPercentage ?? 50,
      };

      await saveAndDeploy(config);
      return ok({ flagKey: newKey, values: config.values[newKey] }, 201);
    }

    // PATCH /flags/{flagKey} — actualiza enabled y/o splitPercentage
    if (method === "PATCH" && flagKey) {
      const { enabled, splitPercentage } = body;

      if (enabled === undefined && splitPercentage === undefined) {
        return err("Proporciona al menos: enabled o splitPercentage");
      }
      if (
        splitPercentage !== undefined &&
        (splitPercentage < 0 || splitPercentage > 100)
      ) {
        return err("splitPercentage debe estar entre 0 y 100");
      }

      const { config } = await getLatestVersion();

      if (!config.values[flagKey]) {
        return err(`Flag '${flagKey}' no encontrado`, 404);
      }

      if (enabled !== undefined) config.values[flagKey].enabled = enabled;
      if (splitPercentage !== undefined)
        config.values[flagKey].splitPercentage = splitPercentage;

      await saveAndDeploy(config);

      // Sincronizar splitPercentage con el KVS para que la CF Function lo lea en tiempo real
      if (splitPercentage !== undefined && KVS_ARN) {
        try {
          const describe = await kvsClient.send(
            new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN })
          );
          await kvsClient.send(
            new PutKeyCommand({
              KvsARN: KVS_ARN,
              Key: "splitPercentage",
              Value: String(splitPercentage),
              IfMatch: describe.ETag!,
            })
          );
        } catch (kvsErr) {
          // No fallar el PATCH si KVS falla; AppConfig ya fue actualizado
          console.warn("[flag-manager] No se pudo actualizar el KVS:", kvsErr);
        }
      }

      return ok({ flagKey, values: config.values[flagKey] });
    }

    return err("Método o ruta no soportado", 404);
  } catch (e) {
    console.error(e);
    return err("Error interno del servidor", 500);
  }
};
