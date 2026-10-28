// Chooses the AI for "Suggest from backlog": free Gemini through the
// project's Worker (needs Google sign-in; the Worker limits each person per
// day) or Claude with the person's own API key.

import { suggestFromBacklog } from "./suggest.js";
import { suggestWithGemini } from "./suggest-gemini.js";

export const PROVIDERS = ["gemini", "claude"];
export const FREE_DAILY_LIMIT = 25; // enforced by the Worker; shown in Settings

// People who already saved a Claude key keep Claude until they switch.
export const providerFor = (settings, hasApiKey) => settings.provider || (hasApiKey ? "claude" : "gemini");

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// What the Worker last reported as left today (resets each day).
export function freeUsesLeft(settings) {
  return settings.freeLeft?.date === today() ? settings.freeLeft.remaining : FREE_DAILY_LIMIT;
}

export function createSuggester({ settings, saveSettings, getApiKey, getIdToken, isSignedIn, fetch, defaultModel }) {
  return async function suggest(req) {
    const s = settings();
    const provider = providerFor(s, Boolean(getApiKey()));
    const args = {
      db: req.db,
      date: req?.date,
      note: typeof req?.note === "string" ? req.note.slice(0, 1000) : "",
      count: Math.min(Math.max(Number(req?.count) || 3, 1), 8),
    };
    const remember = async (remaining) => {
      if (typeof remaining !== "number") return;
      s.freeLeft = { date: today(), remaining };
      await saveSettings();
    };
    try {
      if (provider === "gemini") {
        if (!isSignedIn()) return { error: "Sign in with Google in Settings to use free suggestions." };
        try {
          const result = await suggestWithGemini({ getIdToken, fetch, ...args });
          await remember(result.remaining);
          return { ...result, freeLeft: freeUsesLeft(s) };
        } catch (err) {
          await remember(err.remaining);
          throw err;
        }
      }
      const apiKey = getApiKey();
      if (!apiKey) return { error: "Add an Anthropic API key in Settings first." };
      return await suggestFromBacklog({ apiKey, fetch, model: s.model || defaultModel, ...args });
    } catch (err) {
      console.error("Suggest failed:", err);
      return { error: err.userMessage || err.message || "Suggestion request failed" };
    }
  };
}
