import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { EMPTY_BACKLOG, SYSTEM, buildPrompt, checkDate, cleanSuggestions } from "./suggest-prompt.js";

const SuggestionSchema = z.object({
  summary: z.string().describe("One or two sentences on the overall plan for the day."),
  suggestions: z.array(
    z.object({
      task_id: z.string().describe("The id of a backlog task, copied exactly."),
      reason: z.string().describe("A short, specific reason to do this one now."),
    }),
  ),
});

export async function suggestFromBacklog({ apiKey, model, db, date, note, count, fetch }) {
  checkDate(date);
  const { prompt, backlog } = buildPrompt({ db, date, note, count });
  if (backlog.length === 0) return EMPTY_BACKLOG;

  // Runs inside the app window; requests go through the app's own HTTP client.
  const client = new Anthropic({ apiKey, fetch, dangerouslyAllowBrowser: true });
  let response;
  try {
    response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(SuggestionSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      err.userMessage = "The API key was rejected. Check it in Settings.";
    } else if (err instanceof Anthropic.RateLimitError) {
      err.userMessage = "Rate limited by the API. Try again in a minute.";
    } else if (err instanceof Anthropic.APIConnectionError) {
      err.userMessage = "Couldn't reach the Anthropic API. Check your connection.";
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("The model declined this request."), { status: 422 });
  }
  const parsed = response.parsed_output;
  if (!parsed) {
    throw Object.assign(new Error("The model returned an unexpected response."), { status: 502 });
  }

  return { summary: parsed.summary, suggestions: cleanSuggestions(parsed.suggestions, backlog, count), model: response.model };
}
