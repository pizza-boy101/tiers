// Sync through Firestore, signed in with Google. Each account has one
// document, users/{uid}, holding the whole database as JSON. Every device
// merges it with its own copy (last edit wins per task/tier, see store.js).
// With the full Firestore client (web), a live listener pulls in other
// devices' changes as they happen. The desktop app uses the request-only
// "lite" client, because the live connection stalls inside its WebKit
// window. Both also check once a minute while on screen, on returning to
// the app, and after local edits.
//
// Each device remembers which account its tasks belong to (linkedAccount).
// Tasks made before ever signing in are added to the account automatically;
// tasks that belong to a different account wait until the person chooses
// to merge them or to replace them with this account's tasks.

import { onAuthStateChanged, signOut } from "firebase/auth";
import { normalize, sameContent } from "./store.js";

const MESSAGES = {
  "auth/operation-not-allowed": "Google sign-in isn't turned on for this Firebase project yet.",
  "auth/popup-blocked": "The sign-in window was blocked. Allow pop-ups for this site and try again.",
  "auth/network-request-failed": "Couldn't reach Google. Check your connection.",
  "auth/unauthorized-domain": "This site isn't on the Firebase project's list of allowed domains.",
  "permission-denied": "The Firestore security rules are blocking sync. See the README.",
  unavailable: "Offline. Changes will sync when you're back online.",
};
const POLL_EVERY = 60_000;
const SILENT = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request", "cancelled"]);

export function friendlyError(err) {
  return MESSAGES[err?.code] || err?.message || String(err);
}

export class CloudSync {
  // signIn: platform-specific, signs `auth` in with Google (popup on the web,
  // the system browser on desktop). cancelSignIn: optional. firestore: the
  // client functions { doc, runTransaction, serverTimestamp, onSnapshot? }.
  // linkedAccount: { get() -> uid|null, set(uid) } stored per device.
  // onNotice: one-off messages for the person (e.g. tasks were added).
  constructor({ store, auth, db, firestore, signIn, cancelSignIn, client, onStatus, linkedAccount, onNotice }) {
    Object.assign(this, { store, auth, db, fs: firestore, signIn, cancelSignIn, client, onStatus, linkedAccount, onNotice });
    this.user = null;
    this.state = { syncing: false, signingIn: false, lastSyncAt: null, error: null, otherAccount: false };
    this.unlisten = null;
    this.pending = null;
  }

  init() {
    const poller = setInterval(() => {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      if (this.user && visible && !this.state.syncing && !this.state.otherAccount) this.sync();
    }, POLL_EVERY);
    poller.unref?.(); // don't keep Node (tests) running
    return new Promise((resolve) => {
      onAuthStateChanged(this.auth, (user) => {
        this.unlisten?.();
        this.unlisten = null;
        this.user = user;
        this.state.otherAccount = false;
        if (user) {
          const linked = this.linkedAccount.get();
          if (linked && linked !== user.uid) {
            this.state.otherAccount = true;
            this.onNotice?.("This device has tasks from a different Google account. Choose what to do with them in Settings.");
          } else {
            this.start();
          }
        }
        this.emit();
        resolve();
      });
    });
  }

  status() {
    return {
      available: true,
      signedIn: Boolean(this.user),
      login: this.user?.email || this.user?.displayName || null,
      pendingCode: null,
      ...this.state,
    };
  }

  emit() {
    this.onStatus(this.status());
  }

  // ---------- sign-in ----------

  async startLogin() {
    this.state.signingIn = true;
    this.state.error = null;
    this.emit();
    try {
      await this.signIn(this.auth);
    } catch (err) {
      if (!SILENT.has(err?.code)) {
        this.state.error = friendlyError(err);
        throw new Error(this.state.error);
      }
    } finally {
      this.state.signingIn = false;
      this.emit();
    }
  }

  cancelLogin() {
    this.cancelSignIn?.();
    this.state.signingIn = false;
    this.emit();
  }

  async signOut() {
    this.unlisten?.();
    this.unlisten = null;
    await signOut(this.auth);
    this.state = { syncing: false, signingIn: false, lastSyncAt: null, error: null, otherAccount: false };
    this.emit();
  }

  // The device's tasks belong to another account. "merge" adds them to this
  // account; "replace" swaps them for this account's tasks.
  async resolveOtherAccount(choice) {
    if (!this.user || !this.state.otherAccount) return;
    if (choice === "replace") {
      let remote = null;
      await this.fs.runTransaction(this.db, async (tx) => {
        const snap = await tx.get(this.ref());
        remote = snap.exists() ? JSON.parse(snap.data().data) : null;
      });
      await this.store.adopt(remote);
      await this.linkedAccount.set(this.user.uid);
    } else {
      await this.linkedAccount.set(null); // treat as never linked: tasks are added
    }
    this.state.otherAccount = false;
    this.start();
    this.emit();
  }

  // ---------- syncing ----------

  ref() {
    return this.fs.doc(this.db, "users", this.user.uid);
  }

  start() {
    if (this.fs.onSnapshot) this.listen();
    this.syncSoon(0);
  }

  listen() {
    this.unlisten = this.fs.onSnapshot(
      this.ref(),
      (snap) => {
        if (snap.metadata.hasPendingWrites || !snap.exists()) return;
        this.applyRemote(JSON.parse(snap.data().data)).catch((err) => this.fail(err));
      },
      (err) => this.fail(err),
    );
  }

  // Merge another device's copy; push back if this device has newer edits.
  async applyRemote(remote) {
    await this.store.mergeRemote(remote);
    if (!sameContent(normalize(remote), this.store.db)) this.syncSoon();
    this.state.lastSyncAt = Date.now();
    this.emit();
  }

  syncSoon(delay = 1500) {
    if (!this.user || this.state.otherAccount) return;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.sync(), delay);
  }

  async sync() {
    if (!this.user || this.state.otherAccount) return;
    if (this.state.syncing) {
      this.again = true;
      return;
    }
    this.state.syncing = true;
    this.emit();
    try {
      // Read, merge, and write in one transaction: if another device writes in
      // between, Firestore re-runs this with its data, so nothing is overwritten.
      const uid = this.user.uid;
      const firstLink = this.linkedAccount.get() !== uid;
      let added = 0;
      await this.fs.runTransaction(this.db, async (tx) => {
        const snap = await tx.get(this.ref());
        const remote = snap.exists() ? JSON.parse(snap.data().data) : null;
        if (firstLink) {
          const inAccount = new Set((remote?.tasks || []).map((t) => t.id));
          added = this.store.db.tasks.filter((t) => !inAccount.has(t.id)).length;
        }
        if (remote) await this.store.mergeRemote(remote);
        const data = JSON.stringify(this.store.db);
        if (!snap.exists() || snap.data().data !== data) {
          tx.set(this.ref(), { data, updatedAt: this.fs.serverTimestamp(), client: this.client });
        }
      });
      if (firstLink) {
        await this.linkedAccount.set(uid);
        if (added > 0) {
          this.onNotice?.(`Your ${added} task${added === 1 ? "" : "s"} on this device ${added === 1 ? "is" : "are"} now in your Google account.`);
        }
      }
      this.state.lastSyncAt = Date.now();
      this.state.error = null;
    } catch (err) {
      this.fail(err);
    } finally {
      this.state.syncing = false;
      this.emit();
      if (this.again) {
        this.again = false;
        this.syncSoon(0);
      }
    }
  }

  fail(err) {
    console.error("Sync failed:", err);
    this.state.error = friendlyError(err);
    this.emit();
  }
}
