// Free suggestions with Gemini through Firebase AI Logic. The Gemini key
// stays with Google: the app only sends the request to the Firebase project,
// so every user shares the project's free daily quota.

import { GoogleAIBackend, Schema, getAI, getGenerativeModel } from "firebase/ai";
import { EMPTY_BACKLOG, SYSTEM, buildPrompt, checkDate, cleanSuggestions } from "./suggest-prompt.js";

// Tried in order; the second covers the first being retired.
const MODELS = ["gemini-2.5-flash", "gemini-flash-lite-latest"];
const TIMEOUT = 45_000;

const responseSchema = Schema.object({
  properties: {
    summary: Schema.string({ description: "One or two sentences on the overall plan for the day." }),
    suggestions: Schema.array({
      items: Schema.object({
        properties: {
          task_id: Schema.string({ description: "The id of a backlog task, copied exactly." }),
          reason: Schema.string({ description: "A short, specific reason to do this one now." }),
        },
      }),
    }),
  },
});

function friendly(err) {
  const text = String(err?.message || err);
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(text)) return "Today's free suggestions are used up. Try again tomorrow.";
  if (/App Check/i.test(text)) return "Free suggestions are switched off for this project right now.";
  if (/network|fetch|Failed to fetch|timed out/i.test(text)) return "Couldn't reach Google. Check your connection.";
  return "Couldn't get suggestions from Gemini. Try again in a bit.";
}

export async function suggestWithGemini({ app, db, date, note, count }) {
  checkDate(date);
  const { prompt, backlog } = buildPrompt({ db, date, note, count });
  if (backlog.length === 0) return EMPTY_BACKLOG;

  const ai = getAI(app, { backend: new GoogleAIBackend() });
  let lastError;
  for (const model of MODELS) {
    try {
      const gemini = getGenerativeModel(ai, {
        model,
        systemInstruction: SYSTEM,
        generationConfig: { responseMimeType: "application/json", responseSchema },
      }, { timeout: TIMEOUT });
      const result = await gemini.generateContent(prompt);
      const parsed = JSON.parse(result.response.text());
      return { summary: String(parsed.summary || ""), suggestions: cleanSuggestions(parsed.suggestions, backlog, count), model };
    } catch (err) {
      lastError = err;
      if (!/not.?found|404/i.test(String(err?.message))) break; // only retired models fall through
    }
  }
  console.error("Gemini suggestions failed:", lastError);
  throw Object.assign(new Error(friendly(lastError)), { userMessage: friendly(lastError) });
}
