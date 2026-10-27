import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, cleanSuggestions } from "../src/suggest-prompt.js";
import { FREE_DAILY_LIMIT, freeUsesLeft, providerFor } from "../src/suggestions.js";

const db = {
  tiers: [{ id: "t1", name: "Must do" }, { id: "t2", name: "Someday" }],
  tasks: [
    { id: "a", title: "Renew passport", tierId: "t1", date: null, done: false, notes: "expires in May", createdAt: "2026-10-01T10:00:00Z" },
    { id: "b", title: "Learn Spanish", tierId: "t2", date: null, done: false, createdAt: "2026-10-20T10:00:00Z" },
    { id: "c", title: "Pay rent", tierId: "t1", date: "2026-10-27", done: true },
  ],
};

test("the prompt carries the backlog, each task's age, and the day", () => {
  const { prompt, backlog } = buildPrompt({ db, date: "2026-10-27", note: "low energy", count: 3 });
  assert.deepEqual(backlog.map((t) => t.id), ["a", "b"]);
  assert.match(prompt, /Day being planned: 2026-10-27/);
  assert.match(prompt, /id=a \| tier="Must do" \| title="Renew passport" \| waiting 26d \| notes="expires in May"/);
  assert.match(prompt, /id=b .*waiting 7d/);
  assert.match(prompt, /\[x\] Pay rent/);
  assert.match(prompt, /low energy/);
});

test("answers are limited to real backlog ids, without duplicates", () => {
  const backlog = db.tasks.filter((t) => !t.date);
  const out = cleanSuggestions([
    { task_id: "b", reason: "quick win" },
    { task_id: "zzz", reason: "made up" },
    { task_id: "b", reason: "again" },
    { task_id: "c", reason: "already scheduled" },
    { task_id: "a", reason: "deadline" },
    { reason: "no id" },
  ], backlog, 3);
  assert.deepEqual(out.map((s) => s.task_id), ["b", "a"]);
  assert.deepEqual(cleanSuggestions(undefined, backlog, 3), []);
});

test("the free daily cap resets each day", () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(freeUsesLeft({}), FREE_DAILY_LIMIT);
  assert.equal(freeUsesLeft({ freeUses: { date: today, count: 5 } }), FREE_DAILY_LIMIT - 5);
  assert.equal(freeUsesLeft({ freeUses: { date: "2000-01-01", count: 99 } }), FREE_DAILY_LIMIT);
  assert.equal(freeUsesLeft({ freeUses: { date: today, count: 99 } }), 0);
});

test("people with a saved Claude key keep Claude; everyone else starts on free Gemini", () => {
  assert.equal(providerFor({}, false), "gemini");
  assert.equal(providerFor({}, true), "claude");
  assert.equal(providerFor({ provider: "gemini" }, true), "gemini");
  assert.equal(providerFor({ provider: "claude" }, false), "claude");
});
