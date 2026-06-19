/**
 * CloudFront Function — Asignación de variante A/B en el edge
 * Evento: VIEWER_RESPONSE
 * Runtime: cloudfront-js-2.0
 *
 * Lee splitPercentage desde CloudFront KeyValueStore en cada request.
 * Actualizar el valor en KVS (via PATCH /flags/mfe-variant) cambia el split
 * en tiempo real sin redeployar esta función ni la infraestructura CDK.
 *
 * __KVS_ARN__ es reemplazado por el ARN real del KVS en hosting-stack.ts
 * durante la síntesis de CDK (cdk synth).
 */

import cf from 'cloudfront';

const VALID_VARIANTS = ["A", "B"];
const COOKIE_MAX_AGE = 60 * 2; // 2 minutos en segundos
const DEFAULT_SPLIT = 50;
const KVS_ARN = '__KVS_ARN__';

async function handler(event) {
  var request = event.request;
  var response = event.response;
  var cookies = request.cookies;

  // Si la variante ya está asignada y es válida, respetar la cookie
  if (
    cookies["mfe-variant"] &&
    VALID_VARIANTS.indexOf(cookies["mfe-variant"].value) !== -1
  ) {
    return response;
  }

  // Leer splitPercentage desde KVS — actualizable sin redeploy
  var splitPercentage = DEFAULT_SPLIT;
  try {
    var kv = cf.kvs(KVS_ARN);
    var val = await kv.get('splitPercentage');
    var parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      splitPercentage = parsed;
    }
  } catch (_) {
    // KVS no disponible o clave ausente — usar DEFAULT_SPLIT
  }

  // Hash determinista: mismo userId/IP → misma variante siempre
  var seed =
    (cookies["userId"] && cookies["userId"].value) ||
    (event.viewer && event.viewer.ip) ||
    String(Date.now());

  var hash = 0;
  for (var i = 0; i < seed.length; i++) {
    hash = (((hash * 31) >>> 0) + seed.charCodeAt(i)) >>> 0;
  }

  var variant = (hash % 100) < splitPercentage ? "A" : "B";

  // Asignar cookie en la respuesta (response.cookies requerido en JS_2_0)
  response.cookies["mfe-variant"] = {
    value: variant,
    attributes: "Path=/; Max-Age=" + COOKIE_MAX_AGE + "; SameSite=Lax; Secure",
  };

  return response;
}
