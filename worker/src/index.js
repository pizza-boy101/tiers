import { createRemoteJWKSet, jwtVerify } from "jose";
import { callGemini, createHandler } from "./handler.js";

const PROJECT_ID = "tiers-7a71e";
// Google's public keys for Firebase ID tokens.
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export async function verifyFirebaseToken(token, keys = FIREBASE_KEYS) {
  const { payload } = await jwtVerify(token, keys, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
    algorithms: ["RS256"],
  });
  if (!payload.sub) throw new Error("no subject");
  return payload.sub;
}

export default {
  fetch(request, env) {
    return createHandler({
      verifyToken: (token) => verifyFirebaseToken(token),
      limits: env.LIMITS,
      gemini: (prompt) => callGemini(env.GEMINI_API_KEY, prompt),
      adminToken: env.ADMIN_TOKEN,
    })(request);
  },
};
