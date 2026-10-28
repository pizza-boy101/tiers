import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { DAILY_LIMIT, GeminiError, callGemini, createHandler } from "../src/handler.js";
import { verifyFirebaseToken } from "../src/index.js";

// Stand-in for Google's signing keys: tokens signed here verify the same way.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
const keys = createLocalJWKSet({ keys: [jwk] });
const token = (claims = {}, { project = "tiers-7a71e", exp = "1h" } = {}) =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`https://securetoken.google.com/${project}`)
    .setAudience(project)
    .setSubject(claims.sub ?? "user-1")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);

function setup({ gemini } = {}) {
  const kv = new Map();
  const calls = [];
  const handle = createHandler({
    verifyToken: (t) => verifyFirebaseToken(t, keys),
    limits: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    gemini: gemini || (async (prompt) => (calls.push(prompt), { summary: "Plan", suggestions: [{ task_id: "a", reason: "r" }], model: "gemini-test" })),
    adminToken: "admin-secret",
  });
  return { handle, kv, calls };
}
const post = (body, { auth, origin, path = "/suggest" } = {}) =>
  new Request(`https://tiers-ai.example.workers.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

test("only signed-in users of this Firebase project get suggestions", async () => {
  const { handle, calls } = setup();
  assert.equal((await handle(post({ prompt: "x" }))).status, 401, "no token");
  assert.equal((await handle(post({ prompt: "x" }, { auth: "garbage" }))).status, 401, "garbage");
  assert.equal((await handle(post({ prompt: "x" }, { auth: await token({}, { project: "someone-else" }) }))).status, 401, "other project");
  assert.equal((await handle(post({ prompt: "x" }, { auth: await token({}, { exp: "-1m" }) }))).status, 401, "expired");
  const ok = await handle(post({ prompt: "Backlog: ..." }, { auth: await token() }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { summary: "Plan", suggestions: [{ task_id: "a", reason: "r" }], model: "gemini-test", remaining: DAILY_LIMIT - 1, limit: DAILY_LIMIT });
  assert.deepEqual(calls, ["Backlog: ..."]);
});

test("each person gets a daily limit, counted only for answers", async () => {
  let fail = false;
  const { handle, kv } = setup({ gemini: async () => { if (fail) throw new GeminiError("quota", "q"); return { summary: "", suggestions: [], model: "m" }; } });
  const alice = await token({ sub: "alice" });
  fail = true;
  assert.equal((await handle(post({ prompt: "x" }, { auth: alice }))).status, 503, "Gemini quota out");
  assert.equal([...kv.values()].length, 0, "failed requests don't count");
  fail = false;
  for (let i = 0; i < DAILY_LIMIT; i++) assert.equal((await handle(post({ prompt: "x" }, { auth: alice }))).status, 200);
  const blocked = await handle(post({ prompt: "x" }, { auth: alice }));
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "daily_limit");
  assert.equal((await handle(post({ prompt: "x" }, { auth: await token({ sub: "bob" }) }))).status, 200, "Bob has his own limit");
});

test("bad requests and unknown sites are refused", async () => {
  const { handle } = setup();
  const auth = await token();
  assert.equal((await handle(post({ prompt: "" }, { auth }))).status, 400);
  assert.equal((await handle(post({ prompt: 42 }, { auth }))).status, 400);
  assert.equal((await handle(post({ prompt: "x".repeat(40_001) }, { auth }))).status, 413);
  assert.equal((await handle(post({ prompt: "x" }, { auth, origin: "https://evil.example" }))).status, 403);
  assert.equal((await handle(post({ prompt: "x" }, { auth, path: "/other" }))).status, 404);
});

test("the website and desktop app pass CORS", async () => {
  const { handle } = setup();
  for (const origin of ["https://pizza-boy101.github.io", "tauri://localhost", "http://tauri.localhost"]) {
    const pre = await handle(new Request("https://w.example/suggest", { method: "OPTIONS", headers: { Origin: origin } }));
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("Access-Control-Allow-Origin"), origin);
    assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  }
});

test("self-test needs the admin token", async () => {
  const { handle } = setup();
  assert.equal((await handle(post({}, { path: "/selftest" }))).status, 401);
  const ok = await handle(new Request("https://w.example/selftest", { method: "POST", headers: { "x-admin-token": "admin-secret" } }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).model, "gemini-test");
});

test("Gemini calls use the schema, skip retired models, and report quota", async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), key: init.headers["x-goog-api-key"] });
    if (url.includes("gemini-flash-lite-latest")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summary":"S","suggestions":[]}' }] } }] }), { status: 200 });
  };
  const out = await callGemini("KEY", "the prompt", fake);
  assert.equal(out.model, "gemini-flash-latest");
  assert.equal(out.summary, "S");
  assert.equal(seen[1].key, "KEY");
  assert.equal(seen[1].body.contents[0].parts[0].text, "the prompt");
  assert.equal(seen[1].body.generationConfig.responseMimeType, "application/json");
  assert.match(seen[1].body.systemInstruction.parts[0].text, /backlog/);
  await assert.rejects(callGemini("KEY", "p", async () => new Response("{}", { status: 429 })), (e) => e.code === "quota");
});

test("a model that doesn't answer in time falls through to the next", async () => {
  const fake = (url, init) => url.includes("lite")
    ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
    : Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summary":"S","suggestions":[]}' }] } }] })));
  const out = await callGemini("KEY", "p", fake, 50);
  assert.equal(out.model, "gemini-flash-latest");
});
