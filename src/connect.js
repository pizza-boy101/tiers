// The website's connect page, opened by the desktop app in the browser.
// Google sign-in works here; the resulting Google ID token is handed back to
// the app's one-time listener on 127.0.0.1 (see src-tauri/src/lib.rs).

import { GoogleAuthProvider, browserPopupRedirectResolver, inMemoryPersistence, initializeAuth, signInWithPopup } from "firebase/auth";
import { initFirebase } from "./firebase.js";

const params = new URLSearchParams(location.search);
const port = params.get("port") || "";
const state = params.get("state") || "";
const button = document.getElementById("sign-in");
const status = document.getElementById("status");

function show(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

if (!/^\d{2,5}$/.test(port) || !/^[a-f0-9]{32}$/.test(state)) {
  button.disabled = true;
  show("Open this page from the Tiers app (Settings → Sign in with Google).", true);
} else {
  const { auth } = initFirebase({
    name: "connect",
    emulator: ["localhost", "127.0.0.1"].includes(location.hostname),
    // Nothing is kept in this browser; the sign-in is only passed to the app.
    makeAuth: (app) => initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver }),
  });

  button.addEventListener("click", async () => {
    button.disabled = true;
    show("Waiting for Google…");
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = GoogleAuthProvider.credentialFromResult(result)?.idToken;
      if (!idToken) throw new Error("Google didn't return a sign-in token.");
      show("Signed in. Handing over to Tiers…");
      location.replace(`http://127.0.0.1:${port}/callback#${new URLSearchParams({ state, id_token: idToken })}`);
    } catch (err) {
      button.disabled = false;
      const closed = err?.code === "auth/popup-closed-by-user" || err?.code === "auth/cancelled-popup-request";
      show(closed ? "" : err?.code === "auth/operation-not-allowed"
        ? "Google sign-in isn't turned on for this Firebase project yet."
        : `Sign-in failed: ${err?.message || err}`, !closed);
    }
  });
}
