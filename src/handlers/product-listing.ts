/**
 * product-listing — Lambda handler
 *
 * GET /products?variant=variant-a | variant-b
 *
 * Devuelve el seguro (producto) asignado a la variante A/B.
 * El campo `variant` lo lee el MFE desde la cookie `mfe-variant`
 * que asignó la CloudFront Function en el edge.
 *
 * ⚠️ Los datos de producto son un placeholder.
 *    Deben reemplazarse con la fuente real (DynamoDB / sistema core del banco)
 *    una vez que el contrato sea validado por el negocio.
 */

interface Product {
  id: string;
  name: string;
  description: string;
  coverageAmount: number;
  monthlyPremium: number;
  features: string[];
}

const PRODUCTS: Record<string, Product> = {
  "A": {
    id: "SEG-001",
    name: "Seguro Básico",
    description: "Cobertura esencial para el hogar con asistencia en caso de siniestro.",
    coverageAmount: 10_000,
    monthlyPremium: 15.99,
    features: [
      "Cobertura contra incendios",
      "Asistencia 8×5",
      "Deducible estándar",
    ],
  },
  "B": {
    id: "SEG-002",
    name: "Seguro Premium",
    description: "Cobertura completa con asistencia 24/7 y deducible reducido.",
    coverageAmount: 50_000,
    monthlyPremium: 39.99,
    features: [
      "Cobertura todo riesgo",
      "Asistencia 24×7",
      "Deducible reducido",
      "Reemplazo de bienes en 48 h",
    ],
  },
};

const VALID_VARIANTS = Object.keys(PRODUCTS);

// Con Lambda proxy, la Lambda debe incluir los headers CORS en cada respuesta.
// API Gateway defaultCorsPreflightOptions solo cubre el preflight OPTIONS.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

export const handler = async (event: {
  queryStringParameters?: Record<string, string>;
}) => {
  const variant = event.queryStringParameters?.variant;

  if (!variant) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        error: "El parámetro 'variant' es requerido",
        validValues: VALID_VARIANTS,
      }),
    };
  }

  const product = PRODUCTS[variant];

  if (!product) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        error: `Variante '${variant}' no válida`,
        validValues: VALID_VARIANTS,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "max-age=60",
      ...CORS_HEADERS,
    },
    body: JSON.stringify(product),
  };
};
