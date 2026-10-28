// Free suggestions with Gemini, through the project's Cloudflare Worker
// (worker/). The Worker holds the Gemini key, checks the Google sign-in, and
// limits each person to a number of suggestions a day.

import { SUGGEST_URL } from "./ai-config.js";
import { EMPTY_BACKLOG, buildPrompt, checkDate, cleanSuggestions } from "./suggest-prompt.js";

const fail = (message) => Object.assign(new Error(message), { userMessage: message });

function errorFor(status, data) {
  if (status === 401) return "Your Google sign-in has expired. Sign out and back in, then try again.";
  if (data.error === "daily_limit") return `You've used today's ${data.limit} free suggestions. More tomorrow, or switch to Claude in Settings.`;
  if (status === 503) return "Gemini's free quota is used up for now. Try again later, or switch to Claude in Settings.";
  if (status === 413) return "Your backlog is too long to send. Try again with fewer backlog tasks.";
  return "Couldn't get suggestions from Gemini. Try again in a bit.";
}

// getIdToken: the signed-in user's Firebase ID token. fetch: the platform's HTTP client.
export async function suggestWithGemini({ getIdToken, fetch, db, date, note, count }) {
  checkDate(date);
  const { prompt, backlog } = buildPrompt({ db, date, note, count });
  if (backlog.length === 0) return EMPTY_BACKLOG;

  let res;
  try {
    res = await fetch(SUGGEST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getIdToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    throw fail("Couldn't reach the suggestion server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(fail(errorFor(res.status, data)), { remaining: data.remaining });
  return {
    summary: String(data.summary || ""),
    suggestions: cleanSuggestions(data.suggestions, backlog, count),
    model: data.model,
    remaining: data.remaining,
  };
}
