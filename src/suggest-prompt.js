// The suggestion prompt, shared by every AI provider (Claude in suggest.js,
// Gemini in suggest-gemini.js), and the checks applied to every answer.

export const SYSTEM = `You help a person decide what to pull from their todo backlog onto a given day.

Their tasks are grouped into tiers that they defined themselves. Tiers are listed in the order the person ranked them, first = most important, but use the tier names too: they may describe priority, area of life, effort, or anything else.

Pick tasks only from the backlog, and return their ids exactly as given. Weigh tier rank, how long a task has waited, what is already planned for that day (don't overload it, and balance across tiers when it makes sense), and anything the person says about their time or energy. Keep each reason to one sentence and make it specific to that task.`;

function localIso(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function buildPrompt({ db, date, note, count }) {
  const tierName = new Map(db.tiers.map((t) => [t.id, t.name]));
  const backlog = db.tasks.filter((t) => !t.date && !t.done);
  const planned = db.tasks.filter((t) => t.date === date);
  const weekAgo = new Date(Date.parse(date) - 7 * 86_400_000).toISOString().slice(0, 10);
  const recentDone = db.tasks.filter((t) => t.done && t.date && t.date >= weekAgo && t.date < date);

  const lines = [];
  lines.push(`Day being planned: ${date}`);
  lines.push("");
  lines.push("Tiers, most important first:");
  db.tiers.forEach((t, i) => lines.push(`${i + 1}. ${t.name}`));
  lines.push("");
  lines.push("Backlog:");
  for (const t of backlog) {
    const age = t.createdAt ? daysBetween(localIso(t.createdAt), date) : null;
    const parts = [`id=${t.id}`, `tier="${tierName.get(t.tierId) ?? "none"}"`, `title="${t.title}"`];
    if (age !== null && age >= 0) parts.push(`waiting ${age}d`);
    if (t.notes) parts.push(`notes="${t.notes}"`);
    lines.push(`- ${parts.join(" | ")}`);
  }
  lines.push("");
  lines.push(planned.length ? "Already planned for that day:" : "Nothing is planned for that day yet.");
  for (const t of planned) {
    lines.push(`- [${t.done ? "x" : " "}] ${t.title} (${tierName.get(t.tierId) ?? "none"})`);
  }
  lines.push("");
  lines.push(`Tasks completed in the 7 days before: ${recentDone.length}`);
  if (note) {
    lines.push("");
    lines.push(`What the person says about this day: ${note}`);
  }
  lines.push("");
  lines.push(`Suggest up to ${count} backlog tasks for this day, best first.`);
  return { prompt: lines.join("\n"), backlog };
}

export function checkDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    throw Object.assign(new Error("Invalid date"), { status: 400 });
  }
}

export const EMPTY_BACKLOG = { summary: "Your backlog is empty, so there's nothing to suggest.", suggestions: [] };

// Keep only real backlog ids, without duplicates, best first.
export function cleanSuggestions(suggestions, backlog, count) {
  const ids = new Set(backlog.map((t) => t.id));
  const seen = new Set();
  return (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => typeof s?.task_id === "string" && typeof s?.reason === "string")
    .filter((s) => ids.has(s.task_id) && !seen.has(s.task_id) && seen.add(s.task_id))
    .slice(0, count);
}
