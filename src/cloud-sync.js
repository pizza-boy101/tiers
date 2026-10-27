// Sync through Firestore, signed in with Google. Each account has one
// document, users/{uid}, holding the whole database as JSON. Every device
// merges it with its own copy (last edit wins per task/tier, see store.js).
// With the full Firestore client (web), a live listener pulls in other
// devices' changes as they happen. The desktop app uses the request-only
// "lite" client, because the live connection stalls inside its WebKit
// window. Both also check once a minute while on screen, on returning to
// the app, and after local edits.

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
  constructor({ store, auth, db, firestore, signIn, cancelSignIn, client, onStatus }) {
    Object.assign(this, { store, auth, db, fs: firestore, signIn, cancelSignIn, client, onStatus });
    this.user = null;
    this.state = { syncing: false, signingIn: false, lastSyncAt: null, error: null };
    this.unlisten = null;
    this.pending = null;
  }

  init() {
    const poller = setInterval(() => {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      if (this.user && visible && !this.state.syncing) this.sync();
    }, POLL_EVERY);
    poller.unref?.(); // don't keep Node (tests) running
    return new Promise((resolve) => {
      onAuthStateChanged(this.auth, (user) => {
        this.unlisten?.();
        this.unlisten = null;
        this.user = user;
        if (user) {
          if (this.fs.onSnapshot) this.listen();
          this.syncSoon(0);
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
    this.state = { syncing: false, signingIn: false, lastSyncAt: null, error: null };
    this.emit();
  }

  // ---------- syncing ----------

  ref() {
    return this.fs.doc(this.db, "users", this.user.uid);
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
    if (!this.user) return;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.sync(), delay);
  }

  async sync() {
    if (!this.user) return;
    if (this.state.syncing) {
      this.again = true;
      return;
    }
    this.state.syncing = true;
    this.emit();
    try {
      // Read, merge, and write in one transaction: if another device writes in
      // between, Firestore re-runs this with its data, so nothing is overwritten.
      await this.fs.runTransaction(this.db, async (tx) => {
        const snap = await tx.get(this.ref());
        if (snap.exists()) await this.store.mergeRemote(JSON.parse(snap.data().data));
        const data = JSON.stringify(this.store.db);
        if (!snap.exists() || snap.data().data !== data) {
          tx.set(this.ref(), { data, updatedAt: this.fs.serverTimestamp(), client: this.client });
        }
      });
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
