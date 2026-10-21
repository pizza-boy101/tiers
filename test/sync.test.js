import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { GitHubSync } from "../src/sync.js";

// A tiny in-memory stand-in for the GitHub endpoints sync uses.
function fakeGitHub() {
  const gists = new Map();
  let n = 0;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (pathname === "/login/device/code") {
      return json(200, { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 0.01, expires_in: 60 });
    }
    if (pathname === "/login/oauth/access_token") return json(200, { access_token: "tok" });
    if (init.headers?.Authorization !== "Bearer tok") return json(401, { message: "Bad credentials" });
    if (pathname === "/user") return json(200, { login: "someone" });
    if (pathname === "/gists" && init.method === "GET") return json(200, [...gists.values()]);
    if (pathname === "/gists" && init.method === "POST") {
      const gist = { id: `g${++n}`, description: body.description, files: { "tiers-data.json": { content: body.files["tiers-data.json"].content } } };
      gists.set(gist.id, gist);
      return json(201, gist);
    }
    const gist = gists.get(pathname.split("/")[2]);
    if (!gist) return json(404, { message: "Not Found" });
    if (init.method === "PATCH") gist.files["tiers-data.json"].content = body.files["tiers-data.json"].content;
    return json(200, gist);
  };
  return { fetch, gists };
}

function device(github) {
  const files = new Map();
  const store = new Store({ read: async (k) => files.get(k) ?? null, write: async (k, v) => void files.set(k, v) });
  let saved = null;
  const sync = new GitHubSync({
    store,
    fetch: github.fetch,
    getClientId: () => "client",
    loadAuth: async () => saved,
    saveAuth: async (auth) => void (saved = auth && { ...auth }),
    onStatus: () => {},
    openUrl: () => {},
  });
  return { store, sync };
}

const addTask = (store, id, title) => {
  const v = store.view();
  return store.applyEdit({
    tiers: v.tiers,
    tasks: [...v.tasks, { id, title, tierId: "t_must", date: null, done: false, notes: "", order: 1 }],
    baseRev: v.rev,
  });
};

async function signIn({ sync }) {
  await sync.startLogin();
  for (let i = 0; i < 100 && !sync.status().signedIn; i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 100 && sync.status().syncing; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(sync.status().signedIn, true);
}

test("two devices sync through one private gist", async () => {
  const github = fakeGitHub();
  const a = device(github);
  const b = device(github);
  await a.store.load();
  await b.store.load();

  await addTask(a.store, "a1", "From A");
  await signIn(a);
  assert.equal(github.gists.size, 1, "first sign-in creates the gist");

  await addTask(b.store, "b1", "From B (before sign-in)");
  await signIn(b);
  assert.equal(github.gists.size, 1, "second device finds the same gist");
  assert.deepEqual(b.store.db.tasks.map((t) => t.id).sort(), ["a1", "b1"]);

  await a.sync.sync();
  assert.deepEqual(a.store.db.tasks.map((t) => t.id).sort(), ["a1", "b1"]);

  // Delete on B reaches A
  const v = b.store.view();
  await b.store.applyEdit({ tiers: v.tiers, tasks: v.tasks.filter((t) => t.id !== "a1"), baseRev: v.rev });
  await b.sync.sync();
  await a.sync.sync();
  assert.deepEqual(a.store.db.tasks.map((t) => t.id), ["b1"]);

  // Signing out keeps local data
  await a.sync.signOut();
  assert.equal(a.sync.status().signedIn, false);
  assert.equal(a.store.db.tasks.length, 1);
});

test("a pasted token signs in and finds the existing gist", async () => {
  const github = fakeGitHub();
  const a = device(github);
  const phone = device(github);
  await a.store.load();
  await phone.store.load();
  await addTask(a.store, "a1", "From the desktop");
  await signIn(a);

  await assert.rejects(phone.sync.signInWithToken("wrong"), /didn't accept that token/);
  assert.equal(phone.sync.status().signedIn, false);

  await phone.sync.signInWithToken("  tok  ");
  assert.equal(phone.sync.status().signedIn, true);
  assert.equal(github.gists.size, 1);
  assert.deepEqual(phone.store.db.tasks.map((t) => t.id), ["a1"]);
});
