const api = window.api;
const features = api.features || { revealData: true };
document.documentElement.classList.add(`platform-${api.platform}`);

const MODEL_LABELS = {
  "claude-opus-5-5": "Claude Opus 5.5 (best quality)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (faster, cheaper)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (fastest, cheapest)",
};
const ICON_NEXT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICON_BACKLOG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const TIER_PALETTE = ["#e5484d", "#f5a524", "#3e9b4f", "#3e7bfa", "#8e4ec6", "#12a594", "#e93d82", "#978365"];

let state = { tiers: [], tasks: [], settings: {}, sync: {} };
let baseRev = 0; // revision of the data this window's copy is based on
const ui = {
  selected: isoDate(new Date()),
  month: startOfMonth(new Date()),
  addTier: null, // tier id whose inline add field is open in the day view
  weekView: matchMedia("(max-width: 720px)").matches, // phones start with a one-week calendar strip
  suggest: { loading: false, error: null, summary: null, items: [] },
  dragId: null,
};

// ---------- dates ----------

function isoDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function parseIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = parseIso(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
const today = () => isoDate(new Date());

function dayLabel(s, { short = false } = {}) {
  if (s === today()) return "today";
  if (s === addDays(today(), 1)) return "tomorrow";
  if (s === addDays(today(), -1)) return "yesterday";
  return parseIso(s).toLocaleDateString(undefined, short
    ? { month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" });
}

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const uid = () =>
  crypto.randomUUID?.().slice(0, 12) ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const errText = (err) => (typeof err === "string" ? err : err?.message || String(err));
let orderSeq = 0;
const nextOrder = () => Date.now() * 100 + (orderSeq++ % 100);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const tierById = (id) => state.tiers.find((t) => t.id === id) || state.tiers[0];
const tierRank = (id) => {
  const i = state.tiers.findIndex((t) => t.id === id);
  return i === -1 ? state.tiers.length : i;
};
const taskById = (id) => state.tasks.find((t) => t.id === id);

function sortTasks(list) {
  return list.slice().sort((a, b) =>
    tierRank(a.tierId) - tierRank(b.tierId) || Number(a.done) - Number(b.done) || a.order - b.order);
}

let saveTimer = null;
let saving = false;
let editSeq = 0;

const contentKey = (tiers, tasks) => JSON.stringify([tiers, tasks], (k, v) => (k === "updatedAt" ? undefined : v));

// Take a newer copy from the main process, re-rendering only if something visible changed.
function adopt(view) {
  const changed = contentKey(view.tiers, view.tasks) !== contentKey(state.tiers, state.tasks);
  state.tiers = view.tiers;
  state.tasks = view.tasks;
  baseRev = view.rev;
  if (changed) render();
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const seq = editSeq;
  saving = true;
  try {
    const view = await api.saveState({ tiers: state.tiers, tasks: state.tasks, baseRev });
    if (seq === editSeq) adopt(view);
  } catch (err) {
    toast(`Couldn't save: ${errText(err)}`);
  } finally {
    saving = false;
  }
}

function save() {
  editSeq += 1;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 200);
}

function commit() {
  save();
  render();
}

let toastTimer = null;
function toast(message, undo) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
  if (undo) {
    el.querySelector("button").onclick = () => {
      undo();
      el.classList.remove("show");
    };
  }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), undo ? 6000 : 3500);
}

// ---------- task operations ----------

function addTask({ title, tierId, date }) {
  title = title.trim();
  if (!title) return;
  state.tasks.push({
    id: uid(),
    title,
    tierId,
    date: date || null,
    done: false,
    notes: "",
    createdAt: new Date().toISOString(),
    order: nextOrder(),
  });
  commit();
}

function moveTask(id, { date, tierId }) {
  const task = taskById(id);
  if (!task) return;
  if (date !== undefined) {
    task.date = date;
    if (date === null) task.done = false;
  }
  if (tierId) task.tierId = tierId;
  task.order = nextOrder();
  commit();
}

function toggleDone(id) {
  const task = taskById(id);
  if (!task) return;
  task.done = !task.done;
  task.doneAt = task.done ? new Date().toISOString() : null;
  commit();
}

function deleteTask(id) {
  const index = state.tasks.findIndex((t) => t.id === id);
  if (index === -1) return;
  const [removed] = state.tasks.splice(index, 1);
  commit();
  toast(`Deleted “${removed.title}”`, () => {
    state.tasks.splice(index, 0, removed);
    commit();
  });
}

// ---------- rendering ----------

function render() {
  renderCalendar();
  renderDay();
  renderBacklog();
  renderSuggestions();
}

function renderCalendar() {
  const month = ui.month;
  $("#cal-title").textContent = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const byDate = new Map();
  for (const t of state.tasks) {
    if (!t.date) continue;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  const start = new Date(month);
  start.setDate(1 - month.getDay());
  const selectedWeek = Math.floor(Math.round((parseIso(ui.selected) - start) / 86_400_000) / 7);
  $(".calendar-panel").classList.toggle("week-view", ui.weekView);
  $("#cal-toggle").textContent = ui.weekView ? "Show month" : "Show week";
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = isoDate(d);
    const tasks = sortTasks(byDate.get(iso) || []);
    const classes = ["cal-day"];
    if (d.getMonth() !== month.getMonth()) classes.push("other");
    if (iso === today()) classes.push("today");
    if (iso === ui.selected) classes.push("selected");
    if (Math.floor(i / 7) === selectedWeek) classes.push("sel-week");
    const allDone = tasks.length > 0 && tasks.every((t) => t.done);
    if (allDone) classes.push("all-done");
    const dots = allDone ? "" : tasks.slice(0, 8).map((t) =>
      `<span class="dot${t.done ? " done" : ""}" style="--c:${tierById(t.tierId).color}"></span>`).join("");
    const more = !allDone && tasks.length > 8 ? `<span class="more">+${tasks.length - 8}</span>` : "";
    const numStyle = allDone ? ` style="--seal:${sealGradient(tasks)}"` : "";
    const label = `${d.toDateString()}, ${tasks.length} task${tasks.length === 1 ? "" : "s"}${allDone ? ", all done" : ""}`;
    cells.push(`<button type="button" class="${classes.join(" ")}" data-date="${iso}" aria-label="${label}">
      <span class="num"${numStyle}>${d.getDate()}</span><span class="dots">${dots}${more}</span></button>`);
  }
  $("#cal-days").innerHTML = cells.join("");

  $("#tier-legend").innerHTML = state.tiers
    .map((t) => `<span><i style="--c:${t.color}"></i>${esc(t.name)}</span>`).join("");
}

// A soft blend of the tier colors used on a day, so a finished day always matches the palette.
function sealGradient(tasks) {
  const colors = [...new Set(sortTasks(tasks).map((t) => tierById(t.tierId).color))];
  if (colors.length === 1) {
    const c = colors[0];
    return `linear-gradient(145deg, color-mix(in srgb, ${c} 70%, white), ${c})`;
  }
  return `conic-gradient(from 200deg, ${colors.join(", ")}, ${colors[0]})`;
}

function taskRow(task, zone) {
  const tier = tierById(task.tierId);
  const actions = zone === "day"
    ? `<button type="button" data-act="tomorrow" title="Move to the next day" aria-label="Move to the next day">${ICON_NEXT}<span class="label">Next day</span></button>
       <button type="button" data-act="backlog" title="Send back to the backlog" aria-label="Send back to the backlog">${ICON_BACKLOG}<span class="label">Backlog</span></button>`
    : `<button type="button" data-act="schedule" title="Schedule on the selected day">→ ${esc(dayLabel(ui.selected, { short: true }))}</button>`;
  const check = zone === "day"
    ? `<button type="button" class="check" data-act="toggle" aria-label="${task.done ? "Mark not done" : "Mark done"}">${task.done ? "✓" : ""}</button>`
    : `<button type="button" class="check" data-act="schedule" aria-label="Schedule on the selected day" title="Schedule on the selected day">+</button>`;
  return `<div class="task ${zone}${task.done ? " done" : ""}" draggable="true" data-task="${task.id}" style="--c:${tier.color}">
    ${check}
    <span class="title" data-act="edit" title="Edit">${esc(task.title)}</span>
    ${task.notes ? '<span class="note-mark" title="Has notes">✎</span>' : ""}
    <span class="actions">${actions}</span>
  </div>`;
}

function renderDay() {
  const sel = ui.selected;
  const d = parseIso(sel);
  const title = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("#day-title").textContent = sel === today() ? `Today · ${title}` : title;

  const dayTasks = state.tasks.filter((t) => t.date === sel);
  const done = dayTasks.filter((t) => t.done).length;
  const allDone = dayTasks.length > 0 && done === dayTasks.length;
  $("#day-progress").innerHTML = !dayTasks.length
    ? "Nothing planned. Click a tier to add a task, or pull one from the backlog."
    : allDone
      ? `<span class="all-done-badge" style="--seal:${sealGradient(dayTasks)}">✓</span> All ${dayTasks.length} done. Nice work.`
      : `${done} of ${dayTasks.length} done`;
  $("#day-bar").innerHTML = sortTasks(dayTasks)
    .map((t) => `<i class="${t.done ? "on" : ""}" style="--c:${tierById(t.tierId).color}"></i>`).join("");
  $("#day-bar").classList.toggle("complete", allDone);

  const overdue = sel === today() ? state.tasks.filter((t) => t.date && t.date < sel && !t.done) : [];
  $("#carryover").innerHTML = overdue.length
    ? `<div class="banner"><span class="grow">${overdue.length} unfinished task${overdue.length === 1 ? "" : "s"} from earlier days</span>
        <button class="btn small" type="button" data-carry="today">Move to today</button>
        <button class="btn small" type="button" data-carry="backlog">Send to backlog</button></div>`
    : "";

  $("#day-tiers").innerHTML = state.tiers.map((tier) => {
    const tasks = sortTasks(dayTasks.filter((t) => tierById(t.tierId).id === tier.id));
    const open = ui.addTier === tier.id;
    return `<div class="tier-section" data-zone="day" data-tier="${tier.id}" style="--c:${tier.color}">
      <button type="button" class="tier-pill" data-add-tier="${tier.id}" title="Add a task to ${esc(tier.name)}">
        <i></i>${esc(tier.name)}<span class="plus">+</span>
      </button>
      ${tasks.map((t) => taskRow(t, "day")).join("")}
      ${open ? `<form class="add-inline" data-add-form="${tier.id}"><input type="text" placeholder="New ${esc(tier.name)} task…" autocomplete="off"></form>` : ""}
    </div>`;
  }).join("");

  if (ui.addTier) $(`[data-add-form="${ui.addTier}"] input`)?.focus();
}

function renderBacklog() {
  const backlog = state.tasks.filter((t) => !t.date);
  $("#backlog-count").textContent = backlog.length || "";
  $("#backlog-hint").textContent = `${matchMedia("(hover: none)").matches ? "Tap" : "Click"} + on a task to put it on ${dayLabel(ui.selected) === "today" ? "today" : parseIso(ui.selected).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}.`;

  const select = $("#backlog-tier");
  const current = select.value;
  select.innerHTML = state.tiers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  select.value = state.tiers.some((t) => t.id === current) ? current : state.tiers[0]?.id;

  const sections = state.tiers.map((tier) => {
    const tasks = sortTasks(backlog.filter((t) => tierById(t.tierId).id === tier.id));
    if (!tasks.length) return "";
    return `<div class="tier-section" data-zone="backlog" data-tier="${tier.id}" style="--c:${tier.color}">
      <span class="tier-pill" style="cursor:default"><i></i>${esc(tier.name)} <span class="n">${tasks.length}</span></span>
      ${tasks.map((t) => taskRow(t, "backlog")).join("")}
    </div>`;
  }).join("");
  $("#backlog-tiers").innerHTML = sections ||
    '<p class="empty">Your backlog is empty. Add things you want to do someday, then pull them onto a day when you’re ready.</p>';
}

// Free Gemini needs Google sign-in; Claude needs the person's API key.
function suggestionsReady() {
  return state.settings.provider === "claude" ? state.settings.hasApiKey : Boolean(state.sync.signedIn);
}

function renderSuggestions() {
  const s = ui.suggest;
  const ready = suggestionsReady();
  const btn = $("#suggest-btn");
  btn.disabled = s.loading;
  $("#suggest-label").textContent = s.loading
    ? "Thinking…"
    : ready
      ? `Suggest from backlog for ${dayLabel(ui.selected)}`
      : state.settings.provider === "claude" ? "Add an API key to get suggestions" : "Sign in with Google for free suggestions";
  $("#suggest-note").hidden = !ready;

  const box = $("#suggestions");
  if (s.loading) {
    box.innerHTML = '<p class="muted small" style="display:flex;gap:8px;align-items:center"><span class="spinner"></span>Looking through your backlog…</p>';
    return;
  }
  if (s.error) {
    box.innerHTML = `<p class="suggest-error">${esc(s.error)}</p>`;
    return;
  }
  const items = s.items.filter((i) => taskById(i.task_id) && !taskById(i.task_id).date);
  if (!s.summary && !items.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    ${s.summary ? `<p class="suggest-summary">${esc(s.summary)}</p>` : ""}
    ${items.map((i) => {
      const task = taskById(i.task_id);
      const tier = tierById(task.tierId);
      return `<div class="suggestion" style="--c:${tier.color}" data-suggest="${task.id}">
        <span class="s-title">${esc(task.title)}</span>
        <span class="s-reason">${esc(i.reason)}</span>
        <span class="s-actions">
          <button class="btn small primary" type="button" data-s-act="accept">Add to ${esc(dayLabel(s.date, { short: true }))}</button>
          <button class="btn small" type="button" data-s-act="skip">Skip</button>
        </span>
      </div>`;
    }).join("")}
    <div class="suggest-foot">
      ${items.length > 1 ? '<button class="btn small" type="button" data-s-act="accept-all">Add all</button>' : "<span></span>"}
      <button class="btn small ghost" type="button" data-s-act="clear">Clear</button>
    </div>`;
}

// ---------- sync ----------

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderSyncChip() {
  const s = state.sync;
  const chip = $("#sync-chip");
  chip.hidden = !s.signedIn && !s.error;
  chip.classList.toggle("error", Boolean(s.error || s.otherAccount));
  chip.classList.toggle("busy", Boolean(s.syncing));
  $("#sync-chip-label").textContent = s.otherAccount
    ? "Sync paused"
    : s.error
    ? "Sync problem"
    : s.syncing ? "Syncing…" : s.lastSyncAt ? `Synced ${timeAgo(s.lastSyncAt)}` : "Sync on";
  chip.title = s.error || (s.login ? `Signed in as ${s.login}` : "");
}

function renderSyncSettings() {
  const s = state.sync;
  const box = $("#sync-settings");
  if (s.signedIn && s.otherAccount) {
    box.innerHTML = `
      <p class="small">Signed in as <strong>${esc(s.login)}</strong>, but the tasks on this device belong to a different Google account. Sync is paused until you choose:</p>
      <div class="row">
        <button class="btn primary" type="button" data-sync="merge">Add them to this account</button>
        <button class="btn" type="button" data-sync="replace">Use only this account's tasks</button>
      </div>
      <p class="muted small">"Use only this account's tasks" replaces what's on this device. Export a backup below first if you want to keep a copy.</p>
      <div class="row"><button class="btn ghost small" type="button" data-sync="signout">Sign out instead</button></div>`;
  } else if (s.signedIn) {
    box.innerHTML = `
      <p class="small">Signed in as <strong>${esc(s.login)}</strong>. ${s.lastSyncAt ? `Last synced ${timeAgo(s.lastSyncAt)}.` : ""}</p>
      ${s.error ? `<p class="suggest-error">${esc(s.error)}</p>` : ""}
      <div class="row">
        <button class="btn" type="button" data-sync="now">${s.syncing ? "Syncing…" : "Sync now"}</button>
        <button class="btn ghost" type="button" data-sync="signout">Sign out</button>
      </div>`;
  } else if (s.signingIn) {
    box.innerHTML = `
      <p class="small">${api.platform === "web" ? "Finish signing in with Google in the window that opened." : "Finish signing in with Google in your browser, then come back here."}</p>
      <div class="row"><button class="btn ghost small" type="button" data-sync="cancel">Cancel</button></div>`;
  } else {
    box.innerHTML = `
      <p class="muted small">Sign in with the same Google account on each device to keep your tasks in sync.</p>
      ${s.error ? `<p class="suggest-error">${esc(s.error)}</p>` : ""}
      <div class="row"><button class="btn primary" type="button" data-sync="login">Sign in with Google</button></div>`;
  }
}

function applySyncStatus(status) {
  state.sync = status;
  renderSyncChip();
  renderSuggestions();
  if ($("#settings-dialog").open) {
    renderSyncSettings();
    renderProviderFields();
  }
}

function renderProviderFields() {
  const form = $("#settings-form");
  const s = state.settings;
  const provider = form.provider.value;
  $("#claude-fields").hidden = provider !== "claude";
  $("#provider-note").textContent = provider === "claude"
    ? "Uses your own Anthropic API key, billed by Anthropic per use."
    : `Free, no key needed. ${state.sync.signedIn
      ? `${s.freeLeft ?? s.freeDailyLimit} of ${s.freeDailyLimit} left today.`
      : "Needs Google sign-in (below)."} Your backlog is sent to Google's Gemini; on the free tier, Google may use it to improve its products.`;
}

// ---------- updates (desktop) ----------

// The top-right indicator: shows once a new version is found (desktop) or
// deployed (web); the dot pulses when it's ready to install.
function renderUpdateIndicator() {
  const u = state.updates;
  const show = Boolean(u) && ["downloading", "ready", "installed"].includes(u.state);
  $("#update-wrap").hidden = !show;
  if (!show) {
    $("#update-pop").hidden = true;
    return;
  }
  const btn = $("#update-btn");
  const ready = u.state !== "downloading";
  btn.classList.toggle("ready", ready);
  btn.title = ready ? "Update ready" : `Downloading Tiers ${u.available}`;
  btn.setAttribute("aria-label", btn.title);
  if (!$("#update-pop").hidden) renderUpdatePop();
}

function renderUpdatePop() {
  const u = state.updates;
  const downloading = u.state === "downloading";
  const title = u.web ? "New version available" : downloading ? "Update downloading" : "Update ready";
  const line = u.web
    ? "A new version of Tiers is ready. Reload to start using it."
    : downloading
      ? `Tiers ${esc(u.available)} is downloading. It only takes a moment.`
      : u.state === "installed"
        ? `Tiers ${esc(u.available)} is installed. Restart to start using it.`
        : `Tiers ${esc(u.available)} is ready to install.`;
  const action = u.web ? "Reload" : u.state === "installed" ? "Restart now" : "Update now";
  $("#update-pop").innerHTML = `
    <h3 id="update-pop-title">${title}</h3>
    <p>${line}</p>
    ${u.notes ? `<p class="notes"><strong>What's new:</strong> ${esc(u.notes)}</p>` : ""}
    ${!u.web && u.current ? `<p class="muted">You have ${esc(u.current)}.</p>` : ""}
    <div class="row">
      <button class="btn small ghost" type="button" data-update-pop="later">Later</button>
      <button class="btn small primary" type="button" data-update-pop="go" ${downloading ? "disabled" : ""}>${downloading ? "Downloading…" : action}</button>
    </div>`;
}

function toggleUpdatePop(open = $("#update-pop").hidden) {
  if (open) renderUpdatePop();
  $("#update-pop").hidden = !open;
  $("#update-btn").setAttribute("aria-expanded", String(open));
}

function renderUpdateSettings() {
  const u = state.updates;
  $("#update-section").hidden = !u || u.web;
  if (!u) return;
  const checkBtn = '<button class="btn small" type="button" data-update="check">Check for updates</button>';
  const restartBtn = '<button class="btn small primary" type="button" data-update="restart">Restart now</button>';
  const version = u.current ? `Tiers ${esc(u.current)}` : "Tiers";
  const lines = {
    disabled: [`${version}. Updates are off in development builds.`, ""],
    idle: [`${version}. ${u.checkedAt ? "You're up to date." : "Updates install automatically."}`, checkBtn],
    checking: ["Checking for updates…", ""],
    downloading: [`Downloading Tiers ${esc(u.available)}…`, ""],
    ready: [`Tiers ${esc(u.available)} is ready. It installs when you close the app.`, restartBtn.replace("Restart now", "Update now")],
    installed: [`Tiers ${esc(u.available)} is installed. It starts the next time you open the app.`, restartBtn],
    error: [`Couldn't update: ${esc(u.error || "unknown error")}`, checkBtn.replace("Check for updates", "Try again")],
  }[u.state] || [version, checkBtn];
  $("#update-settings").innerHTML = `<p class="small">${lines[0]}</p>${lines[1] ? `<div class="row">${lines[1]}</div>` : ""}`;
}

function applyUpdateStatus(status) {
  state.updates = status;
  renderUpdateIndicator();
  if ($("#settings-dialog").open) renderUpdateSettings();
}

// ---------- suggestions ----------

async function requestSuggestions() {
  if (!suggestionsReady()) {
    openPanel("settings");
    return;
  }
  const date = ui.selected;
  ui.suggest = { loading: true, error: null, summary: null, items: [], date };
  renderSuggestions();
  const result = await api.suggest({ date, note: $("#suggest-note").value, count: 3 })
    .catch((err) => ({ error: errText(err) }));
  if (typeof result.freeLeft === "number") state.settings.freeLeft = result.freeLeft;
  ui.suggest = result.error
    ? { loading: false, error: result.error, summary: null, items: [], date }
    : { loading: false, error: null, summary: result.summary, items: result.suggestions, date };
  renderSuggestions();
}

// ---------- dialogs ----------

function openTaskDialog(id) {
  const task = taskById(id);
  if (!task) return;
  const dlg = $("#task-dialog");
  const form = $("#task-form");
  form.dataset.task = id;
  form.taskTitle.value = task.title;
  form.tierId.innerHTML = state.tiers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  form.tierId.value = tierById(task.tierId).id;
  form.backlog.checked = !task.date;
  form.date.value = task.date || ui.selected;
  form.date.disabled = !task.date;
  form.notes.value = task.notes || "";
  dlg.showModal();
  form.taskTitle.select();
}

function saveTaskDialog() {
  const form = $("#task-form");
  const task = taskById(form.dataset.task);
  if (!task) return;
  task.title = form.taskTitle.value.trim() || task.title;
  task.tierId = form.tierId.value;
  task.notes = form.notes.value.trim();
  const newDate = form.backlog.checked ? null : form.date.value || ui.selected;
  if (newDate !== task.date) {
    task.date = newDate;
    if (!newDate) task.done = false;
    task.order = nextOrder();
  }
  commit();
}

function renderTierList() {
  const list = $("#tier-list");
  list.innerHTML = state.tiers.map((t, i) => `
    <li class="tier-row" data-tier-row="${t.id}">
      <span class="rank">${i + 1}</span>
      <input type="color" value="${t.color}" data-field="color" aria-label="Color for ${esc(t.name)}">
      <input type="text" value="${esc(t.name)}" data-field="name" aria-label="Tier name" maxlength="40">
      <button class="btn ghost icon" type="button" data-tier-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="btn ghost icon" type="button" data-tier-act="down" aria-label="Move down" ${i === state.tiers.length - 1 ? "disabled" : ""}>↓</button>
      <button class="btn ghost icon danger" type="button" data-tier-act="delete" aria-label="Delete tier" ${state.tiers.length === 1 ? "disabled" : ""}>✕</button>
    </li>`).join("");
}

// The Backlog / Tiers / Settings window.
function openPanel(tab = "settings") {
  const dlg = $("#settings-dialog");
  dlg.dataset.tab = tab;
  for (const btn of dlg.querySelectorAll('[role="tab"]')) btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  for (const pane of dlg.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== tab;
  if (tab === "tiers") renderTierList();
  // Refill the settings form each time the window opens, but not when just
  // switching tabs, so unsaved typing survives a look at another tab.
  if (tab === "settings" && (!dlg.open || dlg.dataset.filled !== "1")) fillSettings();
  if (!dlg.open && tab !== "settings") dlg.dataset.filled = "";
  if (!dlg.open) dlg.showModal();
  if (tab === "backlog") $("#backlog-input").focus();
}

function fillSettings() {
  $("#settings-dialog").dataset.filled = "1";
  const form = $("#settings-form");
  const s = state.settings;
  form.apiKey.value = "";
  form.apiKey.placeholder = s.apiKeyHint ? `Saved key ${s.apiKeyHint}. Paste a new one to replace it.` : "sk-ant-…";
  $("#key-status").textContent = s.apiKeySource === "app"
    ? "A key is saved. Suggestions are on."
    : s.apiKeySource === "env"
      ? "Using ANTHROPIC_API_KEY from your environment."
      : "No key yet. Everything else works without one; suggestions turn on once you add it.";
  form.model.innerHTML = (s.models || []).map((m) => `<option value="${m}">${MODEL_LABELS[m] || m}</option>`).join("");
  form.model.value = s.model;
  form.provider.value = s.provider || "gemini";
  renderProviderFields();
  $("#clear-key").hidden = s.apiKeySource !== "app";
  renderSyncSettings();
  renderUpdateSettings();
  $("#data-dir").textContent = s.dataDir || "";
  $("#data-where").hidden = !s.dataDir;
  $("#reveal-btn").hidden = !features.revealData;
}

// ---------- events ----------

function bindEvents() {
  // In the week strip, the arrows move a week; in the month grid, a month.
  $("#cal-prev").onclick = () => {
    if (ui.weekView) return selectDay(addDays(ui.selected, -7));
    ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() - 1, 1);
    renderCalendar();
  };
  $("#cal-next").onclick = () => {
    if (ui.weekView) return selectDay(addDays(ui.selected, 7));
    ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() + 1, 1);
    renderCalendar();
  };
  $("#cal-toggle").onclick = () => {
    ui.weekView = !ui.weekView;
    const d = parseIso(ui.selected);
    ui.month = startOfMonth(d);
    renderCalendar();
  };

  // Swipe left / right on the day to move between days (touch screens).
  let touch = null;
  $(".day-panel").addEventListener("touchstart", (e) => {
    touch = e.target.closest("input, textarea, select, .suggest-box") ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  $(".day-panel").addEventListener("touchend", (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50) selectDay(addDays(ui.selected, dx < 0 ? 1 : -1));
  });
  $("#cal-today").onclick = () => selectDay(today());
  $("#cal-days").onclick = (e) => {
    const cell = e.target.closest("[data-date]");
    if (cell) selectDay(cell.dataset.date);
  };

  // Day view: tier pills open an inline add field; task actions.
  $("#day-tiers").addEventListener("click", (e) => {
    const pill = e.target.closest("[data-add-tier]");
    if (pill) {
      ui.addTier = ui.addTier === pill.dataset.addTier ? null : pill.dataset.addTier;
      renderDay();
      return;
    }
    handleTaskClick(e);
  });
  $("#day-tiers").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target.closest("[data-add-form]");
    const input = form.querySelector("input");
    addTask({ title: input.value, tierId: form.dataset.addForm, date: ui.selected });
  });
  $("#day-tiers").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.closest("[data-add-form]")) {
      ui.addTier = null;
      renderDay();
    }
  });
  $("#day-tiers").addEventListener("focusout", (e) => {
    const form = e.target.closest("[data-add-form]");
    if (form && !e.target.value.trim() && !form.contains(e.relatedTarget)) {
      setTimeout(() => {
        if (ui.addTier === form.dataset.addForm && document.activeElement?.closest("[data-add-form]") !== form) {
          ui.addTier = null;
          renderDay();
        }
      }, 120);
    }
  });

  $("#carryover").onclick = (e) => {
    const btn = e.target.closest("[data-carry]");
    if (!btn) return;
    const target = btn.dataset.carry === "today" ? today() : null;
    for (const t of state.tasks) {
      if (t.date && t.date < today() && !t.done) t.date = target;
    }
    commit();
  };

  $("#backlog-tiers").addEventListener("click", handleTaskClick);
  $("#add-backlog").onsubmit = (e) => {
    e.preventDefault();
    const input = $("#backlog-input");
    addTask({ title: input.value, tierId: $("#backlog-tier").value, date: null });
    input.value = "";
    input.focus();
  };

  $("#suggest-btn").onclick = requestSuggestions;
  $("#suggestions").onclick = (e) => {
    const btn = e.target.closest("[data-s-act]");
    if (!btn) return;
    const act = btn.dataset.sAct;
    const date = ui.suggest.date;
    if (act === "clear") {
      ui.suggest = { loading: false, error: null, summary: null, items: [] };
    } else if (act === "accept-all") {
      for (const i of ui.suggest.items) {
        const t = taskById(i.task_id);
        if (t && !t.date) Object.assign(t, { date, order: nextOrder() });
      }
      ui.suggest.items = [];
    } else {
      const id = btn.closest("[data-suggest]").dataset.suggest;
      if (act === "accept") Object.assign(taskById(id), { date, order: nextOrder() });
      ui.suggest.items = ui.suggest.items.filter((i) => i.task_id !== id);
    }
    if (!ui.suggest.items.length) ui.suggest.summary = null;
    commit();
  };

  bindDragAndDrop();
  bindDialogs();

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") selectDay(addDays(ui.selected, -1));
    else if (e.key === "ArrowRight") selectDay(addDays(ui.selected, 1));
    else if (e.key.toLowerCase() === "t") selectDay(today());
    else if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      openPanel("backlog");
    }
  });

  // Roll "today" over if the app is left open past midnight.
  let lastToday = today();
  setInterval(() => {
    if (today() !== lastToday) {
      if (ui.selected === lastToday) ui.selected = today();
      lastToday = today();
      render();
    }
  }, 60_000);
}

function selectDay(iso) {
  if (iso !== ui.selected && ui.suggest.date !== iso && !ui.suggest.loading) {
    ui.suggest = { loading: false, error: null, summary: null, items: [] };
  }
  ui.selected = iso;
  ui.addTier = null;
  const d = parseIso(iso);
  if (d.getMonth() !== ui.month.getMonth() || d.getFullYear() !== ui.month.getFullYear()) {
    ui.month = startOfMonth(d);
  }
  render();
}

function handleTaskClick(e) {
  const btn = e.target.closest("[data-act]");
  const row = e.target.closest("[data-task]");
  if (!btn || !row) return;
  const id = row.dataset.task;
  switch (btn.dataset.act) {
    case "toggle": return toggleDone(id);
    case "edit": return openTaskDialog(id);
    case "backlog": return moveTask(id, { date: null });
    case "tomorrow": return moveTask(id, { date: addDays(taskById(id).date || ui.selected, 1) });
    case "schedule": return moveTask(id, { date: ui.selected });
  }
}

function dropTargetFor(el) {
  const cal = el.closest(".cal-day[data-date]");
  if (cal) return { el: cal, move: { date: cal.dataset.date } };
  const section = el.closest(".tier-section[data-zone]");
  if (section) {
    const date = section.dataset.zone === "day" ? ui.selected : null;
    return { el: section, move: { date, tierId: section.dataset.tier } };
  }
  const panel = el.closest("[data-drop]");
  if (panel) return { el: panel, move: { date: panel.dataset.drop === "day" ? ui.selected : null } };
  return null;
}

function bindDragAndDrop() {
  let hoverEl = null;
  const setHover = (el) => {
    if (hoverEl === el) return;
    hoverEl?.classList.remove("drop-hover");
    hoverEl = el;
    hoverEl?.classList.add("drop-hover");
  };

  document.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.("[data-task]");
    if (!row) return;
    ui.dragId = row.dataset.task;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.task);
    requestAnimationFrame(() => row.classList.add("dragging"));
  });
  document.addEventListener("dragend", () => {
    ui.dragId = null;
    setHover(null);
    document.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
  });
  document.addEventListener("dragover", (e) => {
    if (!ui.dragId) return;
    const target = dropTargetFor(e.target);
    if (!target) return setHover(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHover(target.el);
  });
  document.addEventListener("drop", (e) => {
    const id = ui.dragId;
    const target = id && dropTargetFor(e.target);
    setHover(null);
    if (!target) return;
    e.preventDefault();
    moveTask(id, target.move);
  });
}

function bindDialogs() {
  // Tiers
  $("#tier-list").addEventListener("input", (e) => {
    const row = e.target.closest("[data-tier-row]");
    const tier = state.tiers.find((t) => t.id === row.dataset.tierRow);
    if (e.target.dataset.field === "color") tier.color = e.target.value;
    if (e.target.dataset.field === "name") tier.name = e.target.value.trim() || "Untitled";
    commit();
  });
  $("#tier-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-tier-act]");
    if (!btn) return;
    const id = btn.closest("[data-tier-row]").dataset.tierRow;
    const i = state.tiers.findIndex((t) => t.id === id);
    const act = btn.dataset.tierAct;
    if (act === "up" && i > 0) {
      [state.tiers[i - 1], state.tiers[i]] = [state.tiers[i], state.tiers[i - 1]];
    } else if (act === "down" && i < state.tiers.length - 1) {
      [state.tiers[i + 1], state.tiers[i]] = [state.tiers[i], state.tiers[i + 1]];
    } else if (act === "delete" && state.tiers.length > 1) {
      const tier = state.tiers[i];
      const fallback = state.tiers[i === 0 ? 1 : 0];
      const count = state.tasks.filter((t) => t.tierId === tier.id).length;
      const msg = count
        ? `Delete “${tier.name}”? Its ${count} task${count === 1 ? "" : "s"} will move to “${fallback.name}”.`
        : `Delete “${tier.name}”?`;
      if (!(await api.confirm(msg))) return;
      for (const t of state.tasks) if (t.tierId === tier.id) t.tierId = fallback.id;
      state.tiers.splice(i, 1);
    }
    renderTierList();
    commit();
  });
  $("#add-tier").onclick = () => {
    const used = new Set(state.tiers.map((t) => t.color));
    const color = TIER_PALETTE.find((c) => !used.has(c)) || TIER_PALETTE[state.tiers.length % TIER_PALETTE.length];
    state.tiers.push({ id: `t_${uid()}`, name: "New tier", color });
    renderTierList();
    commit();
    const inputs = $("#tier-list").querySelectorAll('input[data-field="name"]');
    inputs[inputs.length - 1]?.select();
  };

  // Task edit
  // Save on submit (the Save button), not on the dialog's close event,
  // which some browsers don't always deliver.
  $("#task-form").addEventListener("submit", (e) => {
    if (e.submitter?.value === "save") saveTaskDialog();
  });
  $("#task-form").backlog.onchange = (e) => {
    $("#task-form").date.disabled = e.target.checked;
  };
  $("#task-delete").onclick = () => {
    const id = $("#task-form").dataset.task;
    $("#task-dialog").close("cancel");
    deleteTask(id);
  };

  // Settings
  $("#open-settings").onclick = () => openPanel("settings");
  $("#open-backlog").onclick = () => openPanel("backlog");
  $("#legend-edit").onclick = () => openPanel("tiers");
  $("#panel-close").onclick = () => $("#settings-dialog").close("done");
  $("#settings-dialog").querySelector(".tabs").addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) openPanel(tab.dataset.tab);
  });
  $("#settings-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") return;
    const form = $("#settings-form");
    const patch = { model: form.model.value, provider: form.provider.value };
    if (form.apiKey.value.trim()) patch.apiKey = form.apiKey.value.trim();
    state.settings = await api.saveSettings(patch);
    if (patch.apiKey) toast("API key saved. Suggestions are on.");
    render();
  });
  $("#clear-key").onclick = async () => {
    state.settings = await api.saveSettings({ apiKey: "" });
    $("#settings-dialog").close("cancel");
    toast("API key removed.");
    render();
  };
  $("#export-btn").onclick = async () => {
    if (saveTimer) await flushSave();
    if (await api.exportData()) toast("Backup saved.");
  };
  $("#import-btn").onclick = async () => {
    try {
      if (saveTimer) await flushSave();
      const view = await api.importData();
      if (!view) return;
      $("#settings-dialog").close("cancel");
      adopt(view);
      render();
      toast("Backup imported.");
    } catch (err) {
      toast(errText(err));
    }
  };
  $("#reveal-btn").onclick = () => api.revealData();

  $("#sync-chip").onclick = () => openPanel("settings");
  $("#settings-form").provider.addEventListener("change", renderProviderFields);
  $("#update-btn").onclick = () => toggleUpdatePop();
  $("#update-pop").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-update-pop]");
    if (!btn) return;
    if (btn.dataset.updatePop === "later") return toggleUpdatePop(false);
    btn.disabled = true;
    btn.textContent = "Updating…";
    try {
      await api.updates.restart();
    } catch (err) {
      toast(errText(err));
      renderUpdatePop();
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("#update-pop").hidden && !e.target.closest("#update-wrap")) toggleUpdatePop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#update-pop").hidden) toggleUpdatePop(false);
  });
  $("#update-settings").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-update]");
    if (!btn) return;
    try {
      if (btn.dataset.update === "restart") await api.updates.restart();
      else {
        const result = await api.updates.check();
        if (result.state === "idle") toast("You're on the latest version.");
      }
    } catch (err) {
      toast(errText(err));
    }
  });
  $("#sync-settings").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-sync]");
    if (!btn) return;
    try {
      switch (btn.dataset.sync) {
        case "login":
          await api.sync.login();
          if (state.sync.signedIn) toast("Signed in. Your tasks will sync.");
          break;
        case "cancel": await api.sync.cancel(); break;
        case "signout": await api.sync.signOut(); break;
        case "merge":
          await api.sync.resolveOtherAccount("merge");
          break;
        case "replace":
          if (await api.confirm(`Replace the tasks on this device with the tasks in ${state.sync.login}?`)) {
            await api.sync.resolveOtherAccount("replace");
            toast(`Now showing the tasks in ${state.sync.login}.`);
          }
          break;
        case "now": await api.sync.now(); break;
      }
    } catch (err) {
      toast(errText(err));
    }
  });
}

// ---------- boot ----------

async function boot() {
  const data = await api.getState();
  state = { tiers: data.tiers, tasks: data.tasks, settings: data.settings, sync: data.sync };
  baseRev = data.rev;
  bindEvents();
  render();
  renderSyncChip();
  setInterval(renderSyncChip, 30_000);

  api.sync.onStatus(applySyncStatus);
  api.sync.onNotice?.((message) => toast(message));
  if (api.updates) {
    applyUpdateStatus(api.updates.getStatus());
    api.updates.onStatus(applyUpdateStatus);
  }
  // Changes merged in from another device. If you're mid-edit, the next save
  // merges against them instead, so nothing is lost either way.
  api.onStateChanged((view) => {
    if (!saveTimer && !saving) adopt(view);
  });
}

boot();
