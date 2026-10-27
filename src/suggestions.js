// Chooses the AI for "Suggest from backlog": free Gemini through Firebase
// (needs Google sign-in; capped per device per day to protect the shared
// quota) or Claude with the person's own API key.

import { suggestFromBacklog } from "./suggest.js";
import { suggestWithGemini } from "./suggest-gemini.js";

export const PROVIDERS = ["gemini", "claude"];
export const FREE_DAILY_LIMIT = 25;

// People who already saved a Claude key keep Claude until they switch.
export const providerFor = (settings, hasApiKey) => settings.provider || (hasApiKey ? "claude" : "gemini");

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// settings: the backend's settings object (provider, freeUses, model).
export function freeUsesLeft(settings) {
  const used = settings.freeUses?.date === today() ? settings.freeUses.count : 0;
  return Math.max(0, FREE_DAILY_LIMIT - used);
}

export function createSuggester({ settings, saveSettings, getApiKey, getApp, isSignedIn, fetch, defaultModel }) {
  return async function suggest(req) {
    const s = settings();
    const provider = providerFor(s, Boolean(getApiKey()));
    const args = {
      db: req.db,
      date: req?.date,
      note: typeof req?.note === "string" ? req.note.slice(0, 1000) : "",
      count: Math.min(Math.max(Number(req?.count) || 3, 1), 8),
    };
    try {
      if (provider === "gemini") {
        if (!isSignedIn()) return { error: "Sign in with Google in Settings to use free suggestions." };
        if (freeUsesLeft(s) === 0) {
          return { error: `You've used today's ${FREE_DAILY_LIMIT} free suggestions on this device. More tomorrow, or switch to Claude in Settings.` };
        }
        const result = await suggestWithGemini({ app: getApp(), ...args });
        if (result.model) {
          s.freeUses = { date: today(), count: FREE_DAILY_LIMIT - freeUsesLeft(s) + 1 };
          await saveSettings();
        }
        return { ...result, freeLeft: freeUsesLeft(s) };
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
