// Firebase project used for Google sign-in and sync. These values identify
// the project; they're public by design (access is controlled by the
// Firestore security rules in firestore.rules).

import { initializeApp } from "firebase/app";
import { connectAuthEmulator } from "firebase/auth";

export const firebaseConfig = {
  apiKey: "AIzaSyAygkNLjpt1vvRjHhon-eogmERnBPoDbYQ",
  authDomain: "tiers-7a71e.firebaseapp.com",
  projectId: "tiers-7a71e",
  storageBucket: "tiers-7a71e.firebasestorage.app",
  messagingSenderId: "166085908250",
  appId: "1:166085908250:web:210e5faa981a18fd92fea3",
};

// Local emulators (firebase.json) for development and tests.
export const EMULATOR = { auth: "http://127.0.0.1:9099", firestoreHost: "127.0.0.1", firestorePort: 8080 };

// Each platform picks its auth setup (`makeAuth`) and Firestore client
// (`firestore`: functions from "firebase/firestore", or the request-only
// "firebase/firestore/lite" in the desktop app; see cloud-sync.js).
export function initFirebase({ makeAuth, firestore, emulator = false, name }) {
  const app = initializeApp(emulator ? { ...firebaseConfig, projectId: "demo-tiers" } : firebaseConfig, name);
  const auth = makeAuth(app);
  const db = firestore?.initializeFirestore(app, {});
  if (emulator) {
    connectAuthEmulator(auth, EMULATOR.auth, { disableWarnings: true });
    if (db) firestore.connectFirestoreEmulator(db, EMULATOR.firestoreHost, EMULATOR.firestorePort);
  }
  return { app, auth, db };
}
