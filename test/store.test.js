import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

const dir = path.join(os.tmpdir(), "tiers-store-test");

// File-backed storage, the same shape the app gets from Tauri.
const fileIo = (folder) => ({
  read: (name) => fs.readFile(path.join(folder, name), "utf8").catch((err) => (err.code === "ENOENT" ? null : Promise.reject(err))),
  write: async (name, text) => {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, name), text);
  },
});
test("two devices merge edits, deletes, and tier changes", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const task = (id, title, extra = {}) => ({ id, title, tierId: "t_must", date: null, done: false, notes: "", order: 1, ...extra });

  const A = new Store(fileIo(`${dir}/a`)); await A.load();
  const B = new Store(fileIo(`${dir}/b`)); await B.load();
  const edit = async (s, fn) => { const v = s.view(); const tiers = structuredClone(v.tiers), tasks = structuredClone(v.tasks); fn(tiers, tasks); return s.applyEdit({ tiers, tasks, baseRev: v.rev }); };

  // 1. Both devices add different tasks offline -> union
  await edit(A, (_, t) => t.push(task("a1", "From A")));
  await edit(B, (_, t) => t.push(task("b1", "From B")));
  await A.mergeRemote(B.db); await B.mergeRemote(A.db);
  assert.deepEqual(A.db.tasks.map((t) => t.id).sort(), ["a1", "b1"]);
  assert.deepEqual(B.db.tasks.map((t) => t.id).sort(), ["a1", "b1"]);

  // 2. Delete on A propagates and is not resurrected by B's stale copy
  await sleep(5);
  await edit(A, (_, t) => t.splice(t.findIndex((x) => x.id === "b1"), 1));
  await B.mergeRemote(A.db); await A.mergeRemote(B.db);
  assert.deepEqual(A.db.tasks.map((t) => t.id), ["a1"]);
  assert.deepEqual(B.db.tasks.map((t) => t.id), ["a1"]);

  // 3. Later edit wins
  await sleep(5); await edit(A, (_, t) => (t[0].title = "A edit"));
  await sleep(5); await edit(B, (_, t) => (t[0].title = "B edit later"));
  await A.mergeRemote(B.db); await B.mergeRemote(A.db);
  assert.equal(A.db.tasks[0].title, "B edit later");
  assert.equal(B.db.tasks[0].title, "B edit later");

  // 4. Window edit based on an old revision keeps a task that arrived from sync meanwhile
  const stale = A.view();
  await sleep(5);
  await edit(B, (_, t) => t.push(task("b2", "Arrived via sync")));
  await A.mergeRemote(B.db);
  const tasks = structuredClone(stale.tasks); tasks[0].done = true;
  await A.applyEdit({ tiers: stale.tiers, tasks, baseRev: stale.rev });
  assert.deepEqual(A.db.tasks.map((t) => t.id).sort(), ["a1", "b2"], "remote task kept");
  assert.equal(A.db.tasks.find((t) => t.id === "a1").done, true, "local edit applied");

  // 5. Tier rename + reorder
  await sleep(5);
  await edit(A, (tiers) => { tiers.reverse(); tiers[0].name = "Someday"; });
  await B.mergeRemote(A.db);
  assert.deepEqual(B.db.tiers.map((t) => t.name), ["Someday", "Should do", "Must do"]);

  // 6. Tier added on B while A reorders -> both kept, A's order first
  await sleep(5); await edit(B, (tiers) => tiers.push({ id: "t_new", name: "Health", color: "#000" }));
  await sleep(5); await edit(A, (tiers) => tiers.reverse());
  await A.mergeRemote(B.db);
  assert.deepEqual(A.db.tiers.map((t) => t.name), ["Must do", "Should do", "Someday", "Health"]);

  // 6b. Editing a view in place (as the window does) is still detected as a change
  const live = A.view();
  live.tasks[0].title = "Edited in place";
  await A.applyEdit({ tiers: live.tiers, tasks: live.tasks, baseRev: live.rev });
  const edited = A.db.tasks.find((t) => t.id === live.tasks[0].id);
  assert.equal(edited.title, "Edited in place");
  assert.ok(edited.updatedAt > 0, "in-place edit gets a fresh timestamp");
  live.tasks[0].title = "Mutated after saving";
  assert.equal(A.db.tasks.find((t) => t.id === live.tasks[0].id).title, "Edited in place", "store keeps its own copy");

  // 7. Persisted + reload
  const A2 = new Store(fileIo(`${dir}/a`)); await A2.load();
  assert.deepEqual(A2.db, A.db);

  // 8. Old v1 file loads
  await fs.mkdir(`${dir}/v1`, { recursive: true });
  await fs.writeFile(`${dir}/v1/db.json`, JSON.stringify({ version: 1, tiers: [{ id: "x", name: "X", color: "#111" }], tasks: [task("t", "Old")] }));
  const V = new Store(fileIo(`${dir}/v1`)); await V.load();
  assert.equal(V.db.tasks[0].updatedAt, 0); assert.deepEqual(V.db.deleted, {});
});
