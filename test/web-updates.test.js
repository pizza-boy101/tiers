import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebUpdates } from "../src/web-updates.js";

function fakeServiceWorker({ controlled }) {
  const sw = new EventTarget();
  sw.controller = controlled ? {} : null;
  sw.updates = 0;
  sw.register = async () => ({ update: async () => void sw.updates++ });
  return sw;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a new deploy right after opening reloads by itself", async () => {
  let t = 0;
  const sw = fakeServiceWorker({ controlled: true });
  let reloaded = false;
  const updates = createWebUpdates({ serviceWorker: sw, reload: () => (reloaded = true), now: () => t });
  await tick();
  t = 5_000;
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(reloaded, true);
  assert.equal(updates.getStatus().state, "applying");
});

test("a new deploy while the page is in use shows the update notice", async () => {
  let t = 0;
  const sw = fakeServiceWorker({ controlled: true });
  let reloaded = false;
  const updates = createWebUpdates({ serviceWorker: sw, reload: () => (reloaded = true), now: () => t });
  const seen = [];
  updates.onStatus((s) => seen.push(s.state));
  await tick();
  assert.equal(updates.getStatus().state, "idle");
  t = 20 * 60_000;
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(updates.getStatus().state, "ready");
  assert.equal(reloaded, false, "doesn't reload on its own mid-use");
  assert.deepEqual(seen, ["ready"]);
  await updates.restart();
  assert.equal(reloaded, true);
});

test("the very first install isn't treated as an update", async () => {
  const sw = fakeServiceWorker({ controlled: false });
  const updates = createWebUpdates({ serviceWorker: sw, reload: () => {} });
  await tick();
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(updates.getStatus().state, "idle");
});

test("coming back to the app checks again, at most hourly", async () => {
  let t = 0;
  const sw = fakeServiceWorker({ controlled: true });
  const updates = createWebUpdates({ serviceWorker: sw, reload: () => {}, now: () => t });
  await tick();
  updates.wake();
  assert.equal(sw.updates, 0, "just registered");
  t = 61 * 60_000;
  updates.wake();
  await tick();
  assert.equal(sw.updates, 1);
  updates.wake();
  await tick();
  assert.equal(sw.updates, 1, "not again within the hour");
});
