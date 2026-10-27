// Runs against the Firebase emulators: npm run test:cloud
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleAuthProvider, inMemoryPersistence, initializeAuth, signInWithCredential } from "firebase/auth";
import * as full from "firebase/firestore";
import * as lite from "firebase/firestore/lite";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { initFirebase } from "../../src/firebase.js";
import { CloudSync } from "../../src/cloud-sync.js";
import { Store } from "../../src/store.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}

// The auth emulator accepts an unsigned JSON "ID token" for Google sign-in.
const googleUser = (sub, email) => GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true }));

let n = 0;
// "web" uses the full client (live listener); "desktop" the request-only lite client.
async function device(sub, email, kind = "web") {
  const fs = kind === "web" ? full : lite;
  const firestore = { initializeFirestore: fs.initializeFirestore, connectFirestoreEmulator: fs.connectFirestoreEmulator,
    doc: fs.doc, runTransaction: fs.runTransaction, serverTimestamp: fs.serverTimestamp, onSnapshot: fs.onSnapshot };
  const { auth, db } = initFirebase({
    emulator: true,
    firestore,
    name: `device-${++n}`,
    makeAuth: (app) => initializeAuth(app, { persistence: inMemoryPersistence }),
  });
  const files = new Map();
  const store = new Store({ read: async (k) => files.get(k) ?? null, write: async (k, v) => void files.set(k, v) });
  await store.load();
  const sync = new CloudSync({
    store, auth, db, firestore, client: kind, onStatus: () => {},
    signIn: (a) => signInWithCredential(a, googleUser(sub, email)),
  });
  await sync.init();
  return { store, sync, auth, db };
}

const addTask = (store, id, title) => {
  const v = store.view();
  return store.applyEdit({ tiers: v.tiers, tasks: [...v.tasks, { id, title, tierId: "t_must", date: null, done: false, notes: "", order: 1 }], baseRev: v.rev });
};
const ids = (store) => store.db.tasks.map((t) => t.id).sort();

test("two devices on one Google account stay in sync, live", async () => {
  const sub = `user-${Date.now()}`;
  const laptop = await device(sub, `${sub}@example.com`);
  const phone = await device(sub, `${sub}@example.com`);

  await addTask(laptop.store, "l1", "Made on the laptop before signing in");
  await laptop.sync.startLogin();
  assert.equal(laptop.sync.status().signedIn, true);
  assert.equal(laptop.sync.status().login, `${sub}@example.com`);
  assert.ok(await until(() => laptop.sync.status().lastSyncAt), "laptop uploads");

  await addTask(phone.store, "p1", "Made on the phone before signing in");
  await phone.sync.startLogin();
  assert.ok(await until(() => ids(phone.store).join() === "l1,p1"), "phone merges both");
  assert.ok(await until(() => ids(laptop.store).join() === "l1,p1"), "laptop receives the phone's task live");

  // A delete on the laptop reaches the phone without any manual sync.
  const v = laptop.store.view();
  await laptop.store.applyEdit({ tiers: v.tiers, tasks: v.tasks.filter((t) => t.id !== "p1"), baseRev: v.rev });
  laptop.sync.syncSoon(0);
  assert.ok(await until(() => ids(phone.store).join() === "l1"), "delete propagates live");

  await laptop.sync.signOut();
  await phone.sync.signOut();
});

test("security rules keep accounts apart", async () => {
  const alice = await device(`alice-${Date.now()}`, "alice@example.com");
  const bob = await device(`bob-${Date.now()}`, "bob@example.com");
  await addTask(alice.store, "a1", "Alice's task");
  await alice.sync.startLogin();
  await bob.sync.startLogin();
  assert.ok(await until(() => alice.sync.status().lastSyncAt));

  const aliceDoc = doc(bob.db, "users", alice.auth.currentUser.uid);
  await assert.rejects(getDoc(aliceDoc), /permission/i, "Bob can't read Alice's data");
  await assert.rejects(setDoc(aliceDoc, { data: "{}", updatedAt: 1, client: "x" }), /permission/i, "or overwrite it");
  await assert.rejects(setDoc(doc(bob.db, "users", bob.auth.currentUser.uid), { data: "{}", sneaky: true }), /permission/i, "extra fields are rejected");

  await alice.sync.signOut();
  await bob.sync.signOut();
});

test("the desktop (request-only client) and the web stay in sync", async () => {
  const sub = `mixed-${Date.now()}`;
  const desktop = await device(sub, `${sub}@example.com`, "desktop");
  const web = await device(sub, `${sub}@example.com`, "web");
  await addTask(desktop.store, "d1", "Desktop task");
  await desktop.sync.startLogin();
  await web.sync.startLogin();
  assert.ok(await until(() => ids(web.store).join() === "d1"), "web gets the desktop's task live");

  await addTask(web.store, "w1", "Web task");
  web.sync.syncSoon(0);
  // The desktop checks every minute and when you switch back to it.
  const picked = await until(async () => {
    await desktop.sync.sync();
    return ids(desktop.store).join() === "d1,w1";
  });
  assert.ok(picked, "desktop picks up the web's task on its next check");

  await desktop.sync.signOut();
  await web.sync.signOut();
});
