// Local data store. Keeps the database in memory, stamps every change with
// `updatedAt`, records deletions as tombstones, and can merge with a copy from
// another device (last edit wins per task/tier).

const TOMBSTONE_TTL = 90 * 86_400_000;
const MAX_SNAPSHOTS = 50;

export function defaultDb() {
  return {
    version: 2,
    tiers: [
      { id: "t_must", name: "Must do", color: "#e5484d", updatedAt: 0 },
      { id: "t_should", name: "Should do", color: "#f5a524", updatedAt: 0 },
      { id: "t_could", name: "Could do", color: "#3e9b4f", updatedAt: 0 },
    ],
    tasks: [],
    tierOrderAt: 0,
    deleted: {},
  };
}

export function isValidDb(db) {
  return (
    db &&
    Array.isArray(db.tiers) &&
    db.tiers.length > 0 &&
    Array.isArray(db.tasks) &&
    db.tiers.every((t) => typeof t.id === "string" && typeof t.name === "string") &&
    db.tasks.every((t) => typeof t.id === "string" && typeof t.title === "string")
  );
}

// Bring older or partial data up to the current shape.
export function normalize(db) {
  return {
    version: 2,
    tiers: db.tiers.map((t) => ({ ...t, updatedAt: t.updatedAt || 0 })),
    tasks: db.tasks.map((t) => ({ ...t, updatedAt: t.updatedAt || 0 })),
    tierOrderAt: db.tierOrderAt || 0,
    deleted: { ...(db.deleted || {}) },
  };
}

const withoutStamp = ({ updatedAt, ...rest }) => JSON.stringify(rest);
const sameOrder = (a, b) => a.length === b.length && a.every((t, i) => t.id === b[i].id);

function mergeItems(a, b, deleted) {
  const byId = new Map();
  for (const item of [...a, ...b]) {
    const prev = byId.get(item.id);
    if (!prev || item.updatedAt > prev.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()].filter((item) => !(deleted[item.id] >= item.updatedAt));
}

// Merge two copies of the database. Pure; returns a new db.
export function merge(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, ts] of Object.entries(b.deleted)) deleted[id] = Math.max(deleted[id] || 0, ts);
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const [id, ts] of Object.entries(deleted)) if (ts < cutoff) delete deleted[id];

  const tierById = new Map(mergeItems(a.tiers, b.tiers, deleted).map((t) => [t.id, t]));
  const ordered = (b.tierOrderAt > a.tierOrderAt ? [b, a] : [a, b]).flatMap((db) => db.tiers.map((t) => t.id));
  const tiers = [...new Set(ordered)].filter((id) => tierById.has(id)).map((id) => tierById.get(id));

  return {
    version: 2,
    tiers: tiers.length ? tiers : defaultDb().tiers,
    tasks: mergeItems(a.tasks, b.tasks, deleted),
    tierOrderAt: Math.max(a.tierOrderAt, b.tierOrderAt),
    deleted,
  };
}

// True when two databases hold the same content (ignores tombstone pruning).
export function sameContent(a, b) {
  const key = (db) => JSON.stringify({
    tiers: db.tiers,
    tasks: [...db.tasks].sort((x, y) => (x.id < y.id ? -1 : 1)),
    tierOrderAt: db.tierOrderAt,
    deleted: Object.keys(db.deleted).sort(),
  });
  return key(a) === key(b);
}

export class Store {
  // `io` reads and writes a named data file: { read(name) -> string|null, write(name, text) }.
  constructor(io, name = "db.json") {
    this.io = io;
    this.name = name;
    this.db = null;
    this.rev = 0;
    this.snapshots = new Map();
    this.listeners = new Set();
    this.writing = Promise.resolve();
  }

  async load() {
    const text = await this.io.read(this.name);
    const raw = text ? JSON.parse(text) : null;
    this.db = isValidDb(raw) ? normalize(raw) : defaultDb();
    this.snapshot();
  }

  snapshot() {
    this.rev += 1;
    this.snapshots.set(this.rev, this.db);
    if (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value);
  }

  // Always a copy: callers edit tasks in place, which must never touch the
  // store's own data or its snapshots.
  view() {
    return structuredClone({ rev: this.rev, tiers: this.db.tiers, tasks: this.db.tasks });
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  // Apply an edit from the window. `baseRev` is the revision the window's copy
  // started from, so edits merged in from another device meanwhile are kept.
  async applyEdit(edit) {
    const { tiers, tasks, baseRev } = structuredClone(edit);
    const base = this.snapshots.get(baseRev) || this.db;
    const now = Date.now();
    const next = structuredClone(this.db);

    const applyList = (key) => {
      const baseById = new Map(base[key].map((t) => [t.id, t]));
      const nextById = new Map(next[key].map((t) => [t.id, t]));
      const incoming = key === "tiers" ? tiers : tasks;
      const incomingIds = new Set(incoming.map((t) => t.id));
      for (const item of incoming) {
        const before = baseById.get(item.id);
        if (!before || withoutStamp(before) !== withoutStamp(item)) {
          nextById.set(item.id, { ...item, updatedAt: now });
        }
      }
      for (const id of baseById.keys()) {
        if (!incomingIds.has(id)) {
          nextById.delete(id);
          next.deleted[id] = now;
        }
      }
      return nextById;
    };

    const taskMap = applyList("tasks");
    const tierMap = applyList("tiers");
    next.tasks = [...taskMap.values()];

    let order = next.tiers.map((t) => t.id);
    if (!sameOrder(base.tiers, tiers)) {
      next.tierOrderAt = now;
      order = [...tiers.map((t) => t.id), ...order];
    } else {
      order = [...order, ...tiers.map((t) => t.id)];
    }
    next.tiers = [...new Set(order)].filter((id) => tierMap.has(id)).map((id) => tierMap.get(id));
    if (!next.tiers.length) throw new Error("At least one tier is required");

    await this.commit(next, "local");
    return this.view();
  }

  // Replace everything (used by backup import). Treated as a fresh edit.
  async replace(db) {
    const now = Date.now();
    const next = normalize(db);
    for (const t of [...next.tiers, ...next.tasks]) t.updatedAt = now;
    next.tierOrderAt = now;
    for (const t of [...this.db.tiers, ...this.db.tasks]) {
      if (!next.tiers.some((x) => x.id === t.id) && !next.tasks.some((x) => x.id === t.id)) next.deleted[t.id] = now;
    }
    await this.commit(next, "local");
    return this.view();
  }

  // Merge in a copy from another device. Returns the merged db.
  async mergeRemote(remote) {
    const merged = merge(this.db, normalize(structuredClone(remote)));
    if (!sameContent(merged, this.db)) await this.commit(merged, "remote");
    return this.db;
  }

  async commit(db, source) {
    this.db = db;
    this.snapshot();
    await this.persist();
    for (const fn of this.listeners) fn(source);
  }

  // Writes go out one at a time, in order, so an older save can never land last.
  persist() {
    const text = JSON.stringify(this.db, null, 2);
    this.writing = this.writing.catch(() => {}).then(() => this.io.write(this.name, text));
    return this.writing;
  }
}
