// Free Gemini suggestions for signed-in Tiers users.
//
// POST /suggest with a Firebase ID token (Google sign-in) and the prompt the
// app built. The Worker checks the token, enforces a per-person daily limit,
// and asks Gemini using its own key, which never reaches the app.

import { SYSTEM } from "../../src/suggest-prompt.js";

export const DAILY_LIMIT = 25;
export const MAX_PROMPT_CHARS = 40_000;
// "-latest" aliases follow Google's current models. The second is a fallback
// if the first is retired or doesn't answer in time.
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
const MODEL_TIMEOUT_MS = 25_000;

export const ALLOWED_ORIGINS = new Set([
  "https://pizza-boy101.github.io", // web / phone
  "tauri://localhost", // desktop, macOS
  "http://tauri.localhost", // desktop, Windows
  "http://localhost:8766", // local development
  "http://127.0.0.1:8766",
]);

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "One or two sentences on the overall plan for the day." },
    suggestions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          task_id: { type: "STRING", description: "The id of a backlog task, copied exactly." },
          reason: { type: "STRING", description: "A short, specific reason to do this one now." },
        },
        required: ["task_id", "reason"],
      },
    },
  },
  required: ["summary", "suggestions"],
};

export class GeminiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Ask Gemini, moving to the next model if one is retired or too slow.
export async function callGemini(apiKey, prompt, fetchImpl = fetch, timeoutMs = MODEL_TIMEOUT_MS) {
  for (const model of MODELS) {
    let res;
    try {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
        }),
      });
    } catch (err) {
      if (err?.name === "TimeoutError") continue;
      throw new GeminiError("upstream", "Couldn't reach Gemini.");
    }
    if (res.status === 404) continue;
    if (res.status === 429) throw new GeminiError("quota", "Gemini's free quota is used up for now.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GeminiError("upstream", data.error?.message || `Gemini returned ${res.status}`);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    try {
      return { ...JSON.parse(text), model };
    } catch {
      throw new GeminiError("upstream", "Gemini returned an unreadable answer.");
    }
  }
  throw new GeminiError("upstream", "No Gemini model is available.");
}

function cors(origin) {
  return origin && ALLOWED_ORIGINS.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
    : {};
}

// deps: verifyToken(token) -> uid, limits (KV: get/put), gemini(prompt), adminToken.
export function createHandler({ verifyToken, limits, gemini, adminToken, now = () => new Date() }) {
  return async function handle(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = cors(origin);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

    // Browsers send an Origin; the desktop app's own HTTP client doesn't.
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json(403, { error: "origin" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    // Lets the project owner check the Gemini key without signing in.
    if (url.pathname === "/selftest" && request.method === "POST") {
      if (!adminToken || request.headers.get("x-admin-token") !== adminToken) return json(401, { error: "unauthorized" });
      try {
        const out = await gemini('Backlog:\n- id=t1 | tier="Must do" | title="Test task"\n\nSuggest up to 1 backlog task.');
        return json(200, { ok: true, model: out.model, suggestions: out.suggestions?.length ?? 0 });
      } catch (err) {
        return json(502, { error: err.code || "upstream", message: err.message });
      }
    }

    if (url.pathname !== "/suggest" || request.method !== "POST") return json(404, { error: "not_found" });

    const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
    let uid;
    try {
      uid = await verifyToken(token);
    } catch {
      return json(401, { error: "unauthorized" });
    }

    let prompt;
    try {
      ({ prompt } = await request.json());
    } catch {
      return json(400, { error: "bad_request" });
    }
    if (typeof prompt !== "string" || !prompt.trim()) return json(400, { error: "bad_request" });
    if (prompt.length > MAX_PROMPT_CHARS) return json(413, { error: "too_large" });

    const key = `${uid}:${now().toISOString().slice(0, 10)}`;
    const used = Number(await limits.get(key)) || 0;
    if (used >= DAILY_LIMIT) return json(429, { error: "daily_limit", remaining: 0, limit: DAILY_LIMIT });

    try {
      const out = await gemini(prompt);
      await limits.put(key, String(used + 1), { expirationTtl: 2 * 86_400 });
      return json(200, { summary: out.summary, suggestions: out.suggestions, model: out.model, remaining: DAILY_LIMIT - used - 1, limit: DAILY_LIMIT });
    } catch (err) {
      return json(err.code === "quota" ? 503 : 502, { error: err.code || "upstream" });
    }
  };
}
