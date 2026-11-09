"use strict";

const STATUS = { todo: "To do", doing: "In progress", done: "Done" };
const URGENCY = { low: "Low", normal: "Normal", high: "High", critical: "Critical" };
const REPEATS = { none: "One time", weekly: "Weekly", monthly: "Monthly" };
// The task list's standard columns, in order. A project can rename or hide them and add
// its own (supabase/014_project_columns.sql). Their values stay whatever they're called
// and whether or not they show, since reminders, progress and the People page run on them.
const STANDARD_COLUMNS = [
  { key: "assign", label: "Assign", min: 110, grow: 1 },
  { key: "urgency", label: "Urgency", min: 120, grow: 1 },
  { key: "deadline", label: "Deadline", min: 140, grow: 1.05 },
  { key: "status", label: "Status", min: 130, grow: 1 },
  { key: "progress", label: "Progress", min: 170, grow: 1.5 },
];
// What the standard columns are called in a task's window, where they haven't been renamed.
const WINDOW_LABELS = { assign: "Assign to", urgency: "Urgency", deadline: "Deadline", status: "Status", progress: "Progress" };
const COLUMN_KINDS = { text: "Text", choice: "Choice list", number: "Number", date: "Date" };
const KIND_MIN = { text: 150, choice: 130, number: 110, date: 140 }; // the narrowest each kind reads well, in px
const TITLE_MIN = 240; // and the task names
const MAX_OWN_COLUMNS = 12;
const PLAIN_NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;
const COLUMN_ERRORS = {
  column_name_required: "Give every column of your own a name, or remove it.",
  column_choices_required: "A choice column needs at least one choice.",
  too_many_columns: `A project takes up to ${MAX_OWN_COLUMNS} columns of its own.`,
  invalid_columns: "Those columns couldn't be saved as they are. Check the names and choices.",
  project_not_found: "This project has been deleted.",
};
const ROLL_MS = 10 * 60000; // how often an open page asks the board to check for reminders
const HOUR_MS = 60 * 60000; // how long before a meeting its reminder goes out
// Picked by eye rather than spaced evenly, since evenly spaced hues mostly look green.
const PERSON_HUES = [0, 25, 42, 56, 80, 125, 165, 188, 205, 222, 245, 268, 288, 310, 330, 347];
const PERSON_COLOR_COUNT = PERSON_HUES.length;
const PROJECT_COLORS = { default: "Default", navy: "Navy", blue: "Blue", teal: "Teal", green: "Green", orange: "Orange", red: "Red", pink: "Pink", purple: "Purple" };
const ANSWER = { waiting: "No answer yet", accepted: "Accepted", declined: "Declined" };
const MEETING_NOTICE = {
  invited: "invited you to a meeting",
  accepted: "accepted your meeting",
  declined: "declined your meeting",
  changed: "changed a meeting",
  removed: "removed you from a meeting",
  cancelled: "cancelled a meeting",
};
const POLL_MS = 5000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIN_WINDOW = { width: 340, height: 260 };
const KEEP_ON_SCREEN = 90; // how much of a dragged window always stays reachable
const OPENS_IN_BROWSER = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|video\/mp4)/;

// Demo mode for trying the page without touching real data. It only works on this
// computer: the live site doesn't carry demo-store.js.
const WANTS_DEMO = location.hostname === "localhost" && new URLSearchParams(location.search).has("demo");
const SESSION_KEY = WANTS_DEMO ? "board.session.demo" : "board.session";
const NAME_KEY = "board.lastName";
const FILTER_KEY = "board.assigneeFilter";

const state = {
  store: null,
  projects: [],
  projectId: null, // the project whose page is showing; null on the cards screen
  leavingProject: null, // a project this person is deleting, so its page goes quietly
  tasks: [],
  filter: readFilter(), // the people whose tasks show, as name keys; "" is unassigned, and empty shows everyone
  keepShown: new Set(), // tasks just added, which stay in view under the filter until it's next changed
  meetings: [],
  weekStart: startOfWeek(new Date()), // the Monday of the week the calendar is showing
  notifications: [],
  noticesSeen: null, // the notices at the last read, to tell which are new; nothing before the first
  lastChime: 0, // when the notification sound last played
  deleted: [], // what was deleted lately, so a page that had it open can say who did it
  people: [],
  personColors: new Map(), // each person's slot in the palette
  personColorsFor: "", // who those slots were worked out for
  version: -1,
  name: "",
  dragging: false,
  lastDrop: 0,
  writes: 0, // bumps on every change so a slower, older read can't undo it
  pollTimer: null,
  peopleOpen: new Set(), // whose cards are open on the People page
  lastRoll: 0, // when this page last asked the board to check for reminders
  rolledDay: "", // and which day that was, so it asks again when the date changes
  windowEntryHref: history.state?.boardWindow ? location.href : null, // this history entry's address, if it was added for a phone's window
  notifyHasEntry: false, // whether the open notifications list has its own history entry
  windows: new Map(),
  windowCount: 0,
  topZ: 100,
};

// ---------- Helpers ----------

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function readFilter() {
  try {
    const saved = JSON.parse(readStorage("localStorage", FILTER_KEY));
    return Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function readStorage(area, key) {
  try { return window[area].getItem(key); } catch { return null; }
}
function writeStorage(area, key, value) {
  try {
    if (value == null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch { /* private window: the page still works, it just won't remember */ }
}

// Where this person's session is kept. Normally only this tab has it, so closing the
// browser means entering the PIN again. On a remembered device it's kept on the device,
// and the board keeps it good for as long as the device is in use: 30 days without
// opening the board, and it ends.
function saveSession(token, name, remember) {
  clearSession();
  writeStorage(remember ? "localStorage" : "sessionStorage", SESSION_KEY, JSON.stringify({ token, name }));
}
function savedSession() {
  for (const area of ["localStorage", "sessionStorage"]) {
    try {
      const saved = JSON.parse(readStorage(area, SESSION_KEY));
      if (saved?.token) return saved;
    } catch { /* start fresh */ }
  }
  return null;
}
function clearSession() {
  writeStorage("localStorage", SESSION_KEY, null);
  writeStorage("sessionStorage", SESSION_KEY, null);
}

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysUntil(iso) {
  const target = parseDate(iso);
  const now = new Date();
  const utc = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(target) - utc(now)) / 86400000);
}
function timeAgo(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function startOfWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}
function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const clockValue = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
const formatDay = (date) => date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const formatTime = (date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const repeats = (task) => !!task.repeat && task.repeat !== "none";

// A week or a month from today, for a task set to repeat before it has a deadline.
function firstDeadline(repeat) {
  const now = new Date();
  if (repeat === "weekly") return dayKey(addDays(now, 7));
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate();
  return dayKey(new Date(now.getFullYear(), now.getMonth() + 1, Math.min(now.getDate(), lastDay)));
}

// What a repeating task will do next, in a line under its Repeats choice.
function repeatNote(task) {
  if (!repeats(task)) return "";
  if (task.status !== "done") return `Reopens each ${task.repeat === "weekly" ? "week" : "month"} once it's done and its deadline has passed.`;
  return `Done for this round. It reopens ${task.deadline && daysUntil(task.deadline) < 0 ? "tomorrow" : "the day after its deadline"}.`;
}

const personKey = (name) => String(name || "").trim().toLowerCase();
const splitNames = (text) => String(text || "").split(",").map((name) => name.trim().slice(0, 60)).filter(Boolean);
function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

// The short warning shown under a deadline. Finished tasks and distant dates get none.
function deadlineNote(task) {
  if (!task.deadline || task.status === "done") return null;
  const days = daysUntil(task.deadline);
  if (days < 0) return { text: `Overdue by ${-days} d`, tone: "overdue" };
  if (days === 0) return { text: "Due today", tone: "today" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  if (days <= 3) return { text: `Due in ${days} days`, tone: "soon" };
  return null;
}

// Keeps Status and Progress telling the same story when one of them changes.
function linkStatusAndProgress(task, changes) {
  const linked = { ...changes };
  if ("status" in changes && !("progress" in changes)) {
    if (changes.status === "done") linked.progress = 100;
    else if (changes.status === "todo") linked.progress = 0;
    else if (task.progress === 100) linked.progress = 90; // reopened: no longer complete
  } else if ("progress" in changes && !("status" in changes)) {
    if (changes.progress === 100) linked.status = "done";
    else if (changes.progress === 0 && task.status === "done") linked.status = "todo";
    else if (changes.progress > 0 && task.status !== "doing") linked.status = "doing";
  }
  return linked;
}

function onlyChanged(task, changes) {
  const diff = {};
  for (const [key, value] of Object.entries(changes)) {
    const same = Array.isArray(value) ? JSON.stringify(task[key]) === JSON.stringify(value) : (task[key] ?? "") === (value ?? "");
    if (!same) diff[key] = value;
  }
  return diff;
}

const findTask = (id) => state.tasks.find((t) => t.id === id);
const subtasksOf = (id) => state.tasks.filter((t) => t.parent_id === id).sort((a, b) => a.position - b.position);

const findProject = (id) => state.projects.find((p) => p.id === id);
// The columns a project added for itself.
const ownColumns = (projectId) => findProject(projectId)?.columns?.custom || [];
// What a project calls a standard column, if it gave it a name of its own.
const renamed = (projectId, key) => findProject(projectId)?.columns?.builtin?.[key]?.label || "";

// The columns a project's task list shows, left to right: the standard ones it hasn't
// hidden, then its own.
function shownColumns(projectId) {
  const builtin = findProject(projectId)?.columns?.builtin || {};
  return [
    ...STANDARD_COLUMNS.filter((c) => !builtin[c.key]?.hidden).map((c) => ({ id: c.key, label: renamed(projectId, c.key) || c.label, min: c.min, grow: c.grow })),
    ...ownColumns(projectId).map((f) => ({ id: f.id, label: f.name, min: KIND_MIN[f.type] || KIND_MIN.text, grow: 1, field: f })),
  ];
}

// ---------- Data ----------

function remoteStore({ supabaseUrl, supabaseKey }) {
  let token = null;
  async function rpc(fn, args) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseKey },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(body?.message || `Request failed (${res.status})`);
      error.code = body?.message;
      throw error;
    }
    return body;
  }
  async function fileService(action, details = {}) {
    const res = await fetch(`${supabaseUrl}/functions/v1/movers-board-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseKey },
      body: JSON.stringify({ action, token, ...details }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(body?.message || `Request failed (${res.status})`);
      error.code = body?.message;
      throw error;
    }
    return body;
  }
  return {
    isDemo: false,
    setToken(value) { token = value; },
    enter: (pin, name, remember) => rpc("movers_enter_board", { p_pin: pin, p_name: name, p_remember: remember === true }),
    list: (version) => rpc("movers_list_tasks", { p_token: token, p_version: version }),
    // Sends only the fields that changed, so two people editing different
    // fields of the same task don't overwrite each other.
    save: (id, fields) => rpc("movers_save_task", { p_token: token, p_id: id, p_fields: fields }),
    move: (id, position) => rpc("movers_move_task", { p_token: token, p_id: id, p_position: position }),
    addUpdate: (id, text) => rpc("movers_add_task_update", { p_token: token, p_id: id, p_text: text }),
    remove: (id) => rpc("movers_delete_task", { p_token: token, p_id: id }),
    saveProject: (id, name, color) => rpc("movers_save_project", { p_token: token, p_id: id, p_name: name, p_color: color }),
    saveColumns: (id, columns) => rpc("movers_save_project_columns", { p_token: token, p_id: id, p_columns: columns }),
    moveProject: (id, position) => rpc("movers_move_project", { p_token: token, p_id: id, p_position: position }),
    removeProject: (id) => rpc("movers_delete_project", { p_token: token, p_id: id }),
    addLink: (taskId, title, url) => rpc("movers_add_link", { p_token: token, p_task_id: taskId, p_title: title, p_url: url }),
    removeAttachment: (id) => rpc("movers_remove_attachment", { p_token: token, p_id: id }),
    markRead: (ids) => rpc("movers_mark_notifications_read", { p_token: token, p_ids: ids }),
    rollTasks: (offsetMinutes) => rpc("movers_roll_tasks", { p_token: token, p_offset_minutes: offsetMinutes }),
    saveMeeting: (id, fields) => rpc("movers_save_meeting", { p_token: token, p_id: id, p_fields: fields }),
    answerMeeting: (id, answer) => rpc("movers_answer_meeting", { p_token: token, p_id: id, p_answer: answer }),
    addMeetingPerson: (id, name) => rpc("movers_add_meeting_person", { p_token: token, p_id: id, p_name: name }),
    removeMeetingPerson: (id, name) => rpc("movers_remove_meeting_person", { p_token: token, p_id: id, p_name: name }),
    cancelMeeting: (id) => rpc("movers_cancel_meeting", { p_token: token, p_id: id }),
    async uploadFile(taskId, file) {
      const { path, upload_url: uploadUrl } = await fileService("upload", { task_id: taskId });
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { apikey: supabaseKey, "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await rpc("movers_add_file", { p_token: token, p_task_id: taskId, p_path: path, p_name: file.name });
    },
    fileUrl: async (id, download) => (await fileService("open", { attachment_id: id, download })).url,
    cleanFiles: () => fileService("clean"),
  };
}

async function loadStore() {
  const config = window.BOARD_CONFIG || {};
  if (config.supabaseUrl && !WANTS_DEMO) return remoteStore(config);
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "demo-store.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return window.createDemoStore();
}

// ---------- Entry screen ----------

const pinInputs = [...document.querySelectorAll(".pin-box")];

function showGateError(message, focusTarget) {
  $("gate-error").textContent = message;
  $("gate-error").hidden = false;
  focusTarget?.focus();
}

function clearPin() {
  pinInputs.forEach((input) => { input.value = ""; });
}

// Spreads digits across the boxes. Autofill, paste and some phone keyboards
// deliver several digits in one go, not one keystroke at a time.
function fillPin(text, start) {
  const digits = text.replace(/\D/g, "").slice(0, pinInputs.length - start);
  [...digits].forEach((digit, i) => { pinInputs[start + i].value = digit; });
  if (digits) (pinInputs[start + digits.length] || $("name-input")).focus();
}

pinInputs.forEach((input, index) => {
  input.addEventListener("focus", () => input.select());
  input.addEventListener("click", () => input.select());
  input.addEventListener("input", () => {
    const typed = input.value;
    input.value = "";
    fillPin(typed, index);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value && index > 0) {
      event.preventDefault();
      pinInputs[index - 1].value = "";
      pinInputs[index - 1].focus();
    }
  });
  input.addEventListener("paste", (event) => {
    event.preventDefault();
    fillPin(event.clipboardData.getData("text"), 0);
  });
});

$("gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = pinInputs.map((input) => input.value).join("");
  const name = $("name-input").value.trim();
  const remember = $("remember-device").checked;
  if (pin.length < 4) return showGateError("Enter all 4 digits of the PIN.", pinInputs[pin.length]);
  if (!name) return showGateError("Enter your name so the team can see who changed what.", $("name-input"));

  $("gate-error").hidden = true;
  $("gate-submit").disabled = true;
  try {
    const result = await state.store.enter(pin, name, remember);
    if (result.ok) {
      writeStorage("localStorage", NAME_KEY, result.name);
      saveSession(result.token, result.name, remember);
      clearPin();
      await startBoard(result.token, result.name);
    } else if (result.error === "wrong_pin") {
      clearPin();
      showGateError("That PIN isn't right. Check it and try again.", pinInputs[0]);
    } else if (result.error === "locked") {
      clearPin();
      showGateError("Too many wrong PINs from this connection. Try again in 15 minutes.");
    } else {
      showGateError("Enter your name so the team can see who changed what.", $("name-input"));
    }
  } catch {
    showGateError("Can't reach the board. Check your connection and try again.");
  } finally {
    $("gate-submit").disabled = false;
  }
});

function showGate(message) {
  stopPolling();
  clearSession();
  closeAllWindows();
  closeNotifications();
  setFilterOpen(false);
  document.title = "Movers Board";
  state.projects = [];
  state.projectId = null;
  state.tasks = [];
  state.keepShown.clear();
  state.meetings = [];
  state.weekStart = startOfWeek(new Date());
  state.notifications = [];
  state.noticesSeen = null;
  state.deleted = [];
  state.people = [];
  state.personColors = new Map();
  state.personColorsFor = "";
  state.version = -1;
  state.store.setToken(null);
  $("task-rows").replaceChildren();
  $("week-grid").replaceChildren();
  delete $("week-grid").dataset.sig;
  delete $("week-grid").dataset.week;
  $("people-cards").replaceChildren();
  delete $("people-cards").dataset.sig;
  $("today-list").replaceChildren();
  delete $("today-list").dataset.sig;
  state.peopleOpen.clear();
  $("board-view").hidden = true;
  $("gate").hidden = false;
  $("name-input").value = readStorage("localStorage", NAME_KEY) || "";
  $("remember-device").checked = false;
  clearPin();
  if (message) showGateError(message);
  else $("gate-error").hidden = true;
  pinInputs[0].focus();
}

async function startBoard(token, name) {
  state.store.setToken(token);
  state.name = name;
  $("who-name").textContent = name;
  $("demo-note").hidden = !state.store.isDemo;
  $("gate").hidden = true;
  $("board-view").hidden = false;
  // The "Assigned to me" switch this replaced is carried over as a filter on this person.
  if (readStorage("localStorage", "board.onlyMine") === "1") {
    writeStorage("localStorage", "board.onlyMine", null);
    if (!state.filter.length) {
      state.filter = [personKey(name)];
      writeStorage("localStorage", FILTER_KEY, JSON.stringify(state.filter));
    }
  }
  await rollTasks();
  await refresh();
  startPolling();
}

// Has the board reopen finished repeating tasks, send due-day reminders, and send the
// reminders for meetings starting within the hour. Nothing does that on a timer, so every
// open page asks now and then. It sends how far its clock is from UTC, so the board's
// "today" starts at the team's midnight.
async function rollTasks() {
  state.lastRoll = Date.now();
  state.rolledDay = dayKey(new Date());
  try {
    await state.store.rollTasks(-new Date().getTimezoneOffset());
  } catch { /* the next try comes soon enough */ }
}

// A meeting on this page has come within the hour since the board was last asked, so its
// reminder is waiting to go out.
const reminderIsDue = () => state.meetings.some((m) => {
  const start = nextOccurrence(m).getTime();
  return start > Date.now() && start - HOUR_MS <= Date.now() && state.lastRoll < start - HOUR_MS;
});

const rollIsDue = () => dayKey(new Date()) !== state.rolledDay || Date.now() - state.lastRoll > ROLL_MS || reminderIsDue();

$("leave-btn").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname + location.search);
  showGate();
});

// ---------- Projects ----------

function routeProjectId() {
  return location.hash.match(/^#project=(.+)$/)?.[1] || null;
}

const onCalendar = () => location.hash === "#calendar";
const onPeople = () => location.hash === "#people";

function deletedNote(id, fallback) {
  const gone = state.deleted.find((d) => d.item_id === id);
  return gone ? `${gone.by_name} ${gone.kind === "meeting" ? "cancelled" : "deleted"} the ${gone.kind} "${gone.title}".` : fallback;
}

// The address decides which page shows, so Back and refresh both work.
function syncRoute() {
  const id = routeProjectId();
  const exists = state.projects.some((p) => p.id === id);
  if (id && !exists) {
    history.replaceState(null, "", location.pathname + location.search);
    if (id !== state.leavingProject) showSyncNote(deletedNote(id, "That project is no longer on the board."));
  }
  state.projectId = exists ? id : null;
  const calendar = onCalendar();
  const people = onPeople();
  $("calendar-view").hidden = !calendar;
  $("people-view").hidden = !people;
  $("projects-view").hidden = calendar || people || !!state.projectId;
  $("project-view").hidden = !state.projectId;
  $("add-btn").hidden = !state.projectId;
  $("set-meeting-btn").hidden = !calendar;
  $("nav-projects").classList.toggle("is-current", !calendar && !people);
  $("nav-calendar").classList.toggle("is-current", calendar);
  $("nav-people").classList.toggle("is-current", people);
}

function projectPercent(id) {
  const tasks = state.tasks.filter((t) => t.project_id === id && !t.parent_id);
  if (!tasks.length) return 0;
  return Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length);
}

function renderProjectCards() {
  const projects = [...state.projects].sort((a, b) => a.position - b.position);
  $("no-projects").hidden = projects.length > 0;
  const cards = projects.map((p) => [p.id, p.name, projectPercent(p.id), p.color || "default"]);
  const list = $("project-cards");
  const signature = JSON.stringify(cards);
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren(...cards.map(([id, name, percent, color]) =>
    el("button", { class: `project-card color-${color}`, type: "button", "data-project": id },
      el("span", { class: "project-name" }, name),
      el("span", { class: "project-progress" },
        el("span", { class: "project-bar" }, el("i", { style: `width: ${percent}%` })),
        el("span", { class: "project-percent" }, `${percent}%`)))));
}

function renderProjectPage() {
  const project = state.projects.find((p) => p.id === state.projectId);
  document.title = project ? `${project.name} · Movers Board` : onCalendar() ? "Calendar · Movers Board" : onPeople() ? "People · Movers Board" : "Movers Board";
  if (!project) return;
  const percent = projectPercent(project.id);
  $("project-title").textContent = project.name;
  $("project-bar-fill").style.width = `${percent}%`;
  $("project-percent").textContent = `${percent}%`;
}

function showProjectError(id, message) {
  $(id).textContent = message || "";
  $(id).hidden = !message;
}

function setRenaming(on) {
  $("rename-project-form").hidden = !on;
  $("project-title").hidden = on;
  $("rename-project-btn").hidden = on;
  if (on) {
    const project = state.projects.find((p) => p.id === state.projectId);
    const color = project?.color || "default";
    $("rename-project-form").dataset.color = color;
    $("rename-project-form").querySelector(`[value="${color}"]`).checked = true;
    const input = $("rename-project-name");
    input.value = project?.name || "";
    input.focus();
    input.select();
  }
}

window.addEventListener("hashchange", () => {
  state.windowEntryHref = history.state?.boardWindow ? location.href : null;
  setFilterOpen(false);
  if (!$("gate").hidden) return;
  showProjectError("project-error", null);
  setRenaming(false);
  renderBoard();
  window.scrollTo(0, 0);
});

$("project-cards").addEventListener("click", (event) => {
  const card = event.target.closest("[data-project]");
  // A drag ends with a click on the same card, which shouldn't open the project.
  if (card && !state.dragging && Date.now() - state.lastDrop > 300) {
    location.hash = `project=${card.dataset.project}`;
  }
});

function colorSwatches() {
  return Object.entries(PROJECT_COLORS).map(([color, label]) =>
    el("label", { class: `color-swatch color-${color}`, title: label },
      el("input", { type: "radio", name: "project-color", value: color, checked: color === "default", "aria-label": label }),
      el("i", { "aria-hidden": "true" })));
}
$("new-project-colors").append(...colorSwatches());
$("rename-project-colors").append(...colorSwatches());

function setAddingProject(on) {
  $("new-project-form").hidden = !on;
  $("add-project-btn").hidden = on;
  showProjectError("projects-error", null);
  if (on) $("new-project-name").focus();
  else $("new-project-form").reset();
}

$("add-project-btn").addEventListener("click", () => setAddingProject(true));
$("new-project-cancel").addEventListener("click", () => setAddingProject(false));

$("new-project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("new-project-name").value.trim();
  if (!name) return $("new-project-name").focus();
  const color = $("new-project-form").querySelector('[name="project-color"]:checked').value;
  const saved = await write(() => state.store.saveProject(null, name, color), null);
  if (saved.ok) setAddingProject(false);
  else showProjectError("projects-error", "That project didn't save. Check your connection and try again.");
});

$("rename-project-btn").addEventListener("click", () => setRenaming(true));
$("rename-project-cancel").addEventListener("click", () => setRenaming(false));

$("rename-project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("rename-project-name").value.trim();
  if (!name) return $("rename-project-name").focus();
  const id = state.projectId;
  // Sends the color only if it changed here, so a name change can't undo someone else's color.
  const form = $("rename-project-form");
  const picked = form.querySelector('[name="project-color"]:checked').value;
  const color = picked === form.dataset.color ? undefined : picked;
  const saved = await write(() => state.store.saveProject(id, name, color), null);
  if (saved.ok) {
    showProjectError("project-error", null);
    setRenaming(false);
  } else {
    showProjectError("project-error", "That didn't save. Check your connection and try again.");
  }
});

$("delete-project-btn").addEventListener("click", async () => {
  const button = $("delete-project-btn");
  const id = state.projectId;
  const count = state.tasks.filter((t) => t.project_id === id && !t.parent_id).length;
  const warning = count === 0 ? "Delete this empty project?"
    : `Delete it and its ${count === 1 ? "1 task" : `${count} tasks`} for everyone?`;
  if (!armButton(button, warning, "Delete project")) return;
  button.disabled = true;
  const going = state.tasks.filter((t) => t.project_id === id).map((t) => state.windows.get(t.id)).filter(Boolean);
  going.forEach((w) => { w.deleting = true; });
  state.leavingProject = id;
  const result = await write(() => state.store.removeProject(id), null);
  button.disabled = false;
  button.classList.remove("armed");
  button.textContent = "Delete project";
  if (result.ok) {
    going.forEach(closeWindow);
    state.projects = state.projects.filter((p) => p.id !== id);
    state.tasks = state.tasks.filter((t) => t.project_id !== id);
    location.hash = "";
    state.store.cleanFiles().catch(() => { /* retried by the next removal */ });
  } else {
    state.leavingProject = null;
    going.forEach((w) => { w.deleting = false; });
    showProjectError("project-error", "That project wasn't deleted. Check your connection and try again.");
  }
});

// ---------- The task list ----------

function dotSelect(field, value, options, label) {
  return el("span", { class: "dot-select" },
    el("span", { class: `dot dot-${value}`, "aria-hidden": "true" }),
    el("select", { class: "plain-select", "data-field": field, "aria-label": label },
      ...Object.entries(options).map(([key, text]) => el("option", { value: key, selected: key === value }, text))));
}

function cell(column, ...children) {
  return el("div", { class: `cell${column.id === "progress" ? " cell-progress" : ""}`, role: "cell", "data-label": column.label, "data-col": column.id }, ...children);
}

// The control for one of a project's own columns: small in a row of the list, full size in
// a task's window.
function ownControl(field, value, inRow, label) {
  const shown = String(value ?? "");
  const common = { "data-custom": field.id, "aria-label": label };
  if (field.type === "choice") {
    // A choice the column no longer offers stays on the task until someone picks another.
    const options = !shown || field.options.includes(shown) ? field.options : [shown, ...field.options];
    const select = el("select", { class: inRow ? "plain-select own-select" : "input", ...common },
      el("option", { value: "" }, inRow ? "–" : "None"),
      ...options.map((option) => el("option", { value: option, selected: option === shown }, option)));
    return inRow ? el("span", { class: "dot-select" }, select) : select;
  }
  return el("input", {
    class: inRow ? `cell-input${field.type === "date" ? " date-input" : ""}` : "input",
    type: field.type,
    value: shown,
    ...common,
    ...(field.type === "text" && { maxlength: "200", autocomplete: "off" }),
    ...(field.type === "number" && { step: "any", inputmode: "decimal" }),
    // An empty cell in the list still has to look like somewhere to type.
    ...(inRow && field.type !== "date" && { placeholder: "–" }),
  });
}

// Saves what was put in one of a project's own columns, from the list or a task's window.
function saveOwnValue(taskId, control, focusKey) {
  const task = findTask(taskId);
  const field = ownColumns(task?.project_id).find((f) => f.id === control.dataset.custom);
  if (!field) return;
  const value = control.value.trim();
  const w = state.windows.get(taskId);
  const inWindow = !!w && w.body.contains(control);
  if (field.type === "number" && value && !PLAIN_NUMBER.test(value)) {
    control.value = String(task.custom?.[field.id] ?? "");
    const message = `${field.name} takes a plain number, like 12 or 12.5.`;
    if (inWindow) showWindowError(w, message);
    else showSyncNote(message);
    return;
  }
  if (inWindow) showWindowError(w, null);
  updateTask(taskId, { custom: { [field.id]: value } }, focusKey);
}

function subtaskSummary(task) {
  const subtasks = subtasksOf(task.id);
  if (!subtasks.length) return "";
  return ` · ${subtasks.filter((s) => s.status === "done").length}/${subtasks.length} subtasks`;
}

function rowSignature(task) {
  return JSON.stringify([
    task.title, task.assignees, task.urgency, task.deadline, task.repeat, task.status, task.progress,
    task.updated_by, timeAgo(task.updated_at), deadlineNote(task)?.text, subtaskSummary(task),
    task.custom, state.columnsSig,
  ]);
}

function rowPicker(task) {
  const picker = namePicker({
    label: `Who ${task.title} is assigned to`,
    names: task.assignees,
    placeholder: "+",
    title: "Assign someone",
    boxClass: "cell-input assign-input",
    onChange(names) {
      // Saving redraws the row, which would otherwise lose the cursor.
      const keepCursor = picker.root.contains(document.activeElement);
      updateTask(task.id, { assignees: names });
      if (keepCursor) $("task-rows").querySelector(`[data-id="${CSS.escape(task.id)}"] .name-box`)?.focus();
    },
  });
  return picker.root;
}

// What goes in a row's cell for each standard column.
const STANDARD_CELLS = {
  assign: (task) => [rowPicker(task)],
  urgency: (task, label) => [dotSelect("urgency", task.urgency, URGENCY, label)],
  deadline(task, label) {
    const note = deadlineNote(task);
    return [
      el("input", { class: "cell-input date-input", type: "date", value: task.deadline || "", "data-field": "deadline", "aria-label": label }),
      note && el("span", { class: `due-note due-${note.tone}` }, note.text),
    ];
  },
  status: (task, label) => [dotSelect("status", task.status, STATUS, label)],
  progress: (task, label) => [
    el("div", { class: "progress-wrap" },
      el("output", { class: "progress-label" }, `${task.progress}%`),
      el("input", {
        class: "progress-range",
        type: "range",
        min: "0",
        max: "100",
        step: "5",
        value: task.progress,
        style: `--p: ${task.progress}%`,
        "data-field": "progress",
        "aria-label": label,
      })),
  ],
};

function renderRow(task) {
  const cells = shownColumns(task.project_id).map((column) => {
    const label = `${column.label} of ${task.title}`;
    return column.field
      ? cell(column, ownControl(column.field, task.custom?.[column.id], true, label))
      : cell(column, ...STANDARD_CELLS[column.id](task, label));
  });
  const row = el("div", { class: "task-row", role: "row", "data-id": task.id, "data-sig": rowSignature(task) },
    el("div", { class: "task-cell", role: "cell" },
      el("span", { class: "grip", "aria-hidden": "true" }),
      el("div", { class: "task-text" },
        el("button", { class: "task-title", type: "button" }, task.title),
        el("div", { class: "task-meta" }, `${task.updated_by} · ${timeAgo(task.updated_at)}${subtaskSummary(task)}${repeats(task) ? ` · Repeats ${task.repeat}` : ""}`)),
      // Only shows on phones, in place of the columns.
      el("div", { class: "task-glance", role: "img", "aria-label": `Urgency ${URGENCY[task.urgency]}, status ${STATUS[task.status]}, progress ${task.progress}%${repeats(task) ? `, repeats ${task.repeat}` : ""}` },
        el("span", { class: "task-glance-line" }, el("span", { class: `dot dot-${task.urgency}` }), STATUS[task.status]),
        el("span", { class: "task-glance-line" }, el("span", { class: "task-glance-bar" }, el("i", { style: `width: ${task.progress}%` })), `${task.progress}%`),
        repeats(task) && el("span", { class: "task-glance-line" }, `↻ ${REPEATS[task.repeat]}`))),
    ...cells);
  return row;
}

// The sheet's headings and grid, for the project that's showing.
function renderSheetHead() {
  const sheet = document.querySelector(".sheet");
  const columns = shownColumns(state.projectId);
  const signature = JSON.stringify(columns);
  state.columnsSig = signature;
  if (sheet.dataset.sig !== signature) {
    sheet.dataset.sig = signature;
    const head = sheet.querySelector(".sheet-head");
    head.querySelectorAll(".head-tab").forEach((tab) => tab.remove());
    head.append(...columns.map((c) => el("div", { class: "head-tab", role: "columnheader", "data-col": c.id }, c.label)));
    sheet.classList.toggle("no-columns", !columns.length);
    sheet.style.setProperty("--cols", [`minmax(${TITLE_MIN}px, 2.3fr)`, ...columns.map((c) => `minmax(${c.min}px, ${c.grow}fr)`)].join(" "));
    if (!$("sheet-fit")) document.head.append(el("style", { id: "sheet-fit" }));
    $("sheet-fit").textContent = sheetFitRule(TITLE_MIN + columns.reduce((sum, c) => sum + c.min, 0));
  }
}

// With more columns than the page is wide, the sheet scrolls sideways inside itself and the
// task names stay in view. How wide is wide enough depends on the project's columns, so the
// rule is written here and the browser applies it as the window changes size, with nothing
// to keep in step. Pages under 981px show each row as a card, so they never need it.
function sheetFitRule(needed) {
  const widest = needed + 82; // plus the rail, the page's side padding, and room for a scrollbar
  // The rail down the left goes, as on narrow pages: the names pin to the sheet's own edge,
  // and anything left of them would show the columns sliding past.
  return `@media (min-width: 981px) and (max-width: ${widest}px) {
  .sheet { padding-left: 0; overflow-x: auto; overscroll-behavior-x: contain; }
  .sheet::before, .sheet .task-row::before, .sheet .task-row::after, .sheet .quick-add::before, .sheet .quick-add::after { display: none; }
  .sheet > .sheet-head, .sheet > .task-rows, .sheet > .quick-add { min-width: ${needed}px; }
  .sheet > .sheet-head { position: static; }
  .sheet .task-cell, .sheet .head-title { position: sticky; left: 0; z-index: 2; }
  .sheet .head-title { background: var(--bg); }
}`;
}

function renderSummary() {
  const open = state.tasks.filter((t) => !t.parent_id && t.status !== "done" && (!state.projectId || t.project_id === state.projectId));
  const overdue = open.filter((t) => t.deadline && daysUntil(t.deadline) < 0).length;
  const today = open.filter((t) => t.deadline && daysUntil(t.deadline) === 0).length;
  const parts = [el("span", {}, `${open.length} open`)];
  if (overdue) parts.push(" · ", el("span", { class: "is-overdue" }, `${overdue} overdue`));
  if (today) parts.push(" · ", el("span", {}, `${today} due today`));
  $("summary").replaceChildren(...parts);
}

function renderPeople() {
  const names = new Set([state.name, ...state.people]);
  for (const task of state.tasks) {
    for (const name of [...task.assignees, task.created_by, task.updated_by]) {
      if (name) names.add(name);
    }
  }
  for (const meeting of state.meetings) {
    names.add(meeting.created_by);
    meeting.people.forEach((person) => names.add(person.name));
  }
  $("people-list").replaceChildren(...[...names].sort().map((name) => el("option", { value: name })));
}

// Everyone the given names cover, each once, with this person first.
function peopleFrom(names) {
  const found = new Map();
  for (const name of [state.name, ...names]) {
    const key = personKey(name);
    if (key && !found.has(key)) found.set(key, name.trim());
  }
  const me = personKey(state.name);
  return [...found].map(([key, name]) => ({ key, name }))
    .sort((a, b) => (b.key === me) - (a.key === me) || a.name.localeCompare(b.name));
}

// Whether a task is on the filtered list: one of the chosen people is on it, or on one of
// its subtasks, which they'd otherwise have no way to reach. "" stands for nobody assigned.
function matchesFilter(task, keys) {
  const onIt = (t) => t.assignees.some((name) => keys.includes(personKey(name)));
  return (keys.includes("") && !task.assignees.length) || onIt(task) || subtasksOf(task.id).some(onIt);
}

function setFilter(keys) {
  state.filter = keys;
  writeStorage("localStorage", FILTER_KEY, keys.length ? JSON.stringify(keys) : null);
  state.keepShown.clear();
  renderRows();
}

function setFilterOpen(open) {
  $("filter-panel").hidden = !open;
  $("filter-btn").setAttribute("aria-expanded", String(open));
}

// The dropdown's button and its list: a checkbox for each person, then Unassigned, each
// with how many of this project's tasks it would show.
function renderFilter(inProject) {
  const me = personKey(state.name);
  const options = peopleFrom([...state.people, ...state.tasks.flatMap((t) => t.assignees)])
    .map((p) => ({ ...p, label: p.key === me ? `${p.name} (you)` : p.name, short: p.key === me ? "Me" : p.name }));
  options.push({ key: "", label: "Unassigned", short: "Unassigned" });
  // Someone still ticked who has since left the board stays listed, so they can be unticked.
  for (const key of state.filter) {
    if (!options.some((o) => o.key === key)) options.push({ key, name: key, label: key, short: key });
  }
  const chosen = options.filter((o) => state.filter.includes(o.key));
  const summary = !chosen.length ? "Everyone" : chosen.length > 2 ? `${chosen.length} selected` : chosen.map((o) => o.short).join(", ");
  $("filter-btn").textContent = `Assigned to: ${summary}`;
  $("filter-btn").classList.toggle("is-active", chosen.length > 0);
  $("filter-clear").hidden = !chosen.length;

  const rows = options.map((o) => [o.key, o.label, inProject.filter((t) => matchesFilter(t, [o.key])).length]);
  const list = $("filter-list");
  const signature = JSON.stringify(rows);
  if (list.dataset.sig !== signature) {
    // Rebuilding would otherwise drop the keyboard's place in the list.
    const focused = list.contains(document.activeElement) ? document.activeElement.value : null;
    list.dataset.sig = signature;
    list.replaceChildren(...options.map((o, i) => el("li", {},
      el("label", { class: "filter-option" },
        el("input", { type: "checkbox", value: o.key }),
        o.key === ""
          ? el("span", { class: "filter-none" }, o.label)
          : el("span", { class: "name-tag", style: personColorStyle(personColor(o.name)), "data-person": o.name }, o.label),
        el("span", { class: "filter-count" }, String(rows[i][2]))))));
    if (focused !== null) [...list.querySelectorAll("input")].find((box) => box.value === focused)?.focus();
  }
  for (const box of list.querySelectorAll("input")) box.checked = state.filter.includes(box.value);
}

// A task someone just added stays on screen even if the filter would hide it.
function keepInView(id) {
  state.keepShown.add(id);
  renderRows();
}

// Updates rows in place so someone mid-edit keeps their cursor when another
// person's change arrives. The row being edited catches up when they leave it.
function renderRows() {
  const list = $("task-rows");
  const focused = document.activeElement;
  const activeRow = focused?.closest?.(".task-row") || null;
  const inProject = state.tasks.filter((t) => !t.parent_id && t.project_id === state.projectId).sort((a, b) => a.position - b.position);
  const tasks = state.filter.length ? inProject.filter((t) => matchesFilter(t, state.filter) || state.keepShown.has(t.id)) : inProject;
  renderFilter(inProject);
  list.classList.toggle("is-filtered", state.filter.length > 0);
  const existing = new Map([...list.children].map((row) => [row.dataset.id, row]));
  const wanted = new Set(tasks.map((t) => t.id));
  existing.forEach((row, id) => { if (!wanted.has(id)) row.remove(); });

  let cursor = list.firstElementChild;
  for (const task of tasks) {
    let row = existing.get(task.id);
    if (!row) {
      row = renderRow(task);
    } else if (row !== activeRow && row.dataset.sig !== rowSignature(task)) {
      const fresh = renderRow(task);
      row.replaceWith(fresh);
      if (cursor === row) cursor = fresh;
      row = fresh;
    }
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus();
}

function renderBoard() {
  assignPersonColors();
  renderWindows(); // first, so a deleted project's note replaces the notes for its tasks
  syncRoute();
  renderProjectCards();
  renderProjectPage();
  renderSheetHead(); // before the rows, which are redrawn when the columns change
  renderRows();
  renderSummary();
  renderPeople();
  renderCalendar();
  renderPeoplePage();
  renderToday();
  renderNotifications();
}

function refreshRow(id, focusField) {
  const row = $("task-rows").querySelector(`[data-id="${CSS.escape(id)}"]`);
  const task = findTask(id);
  if (!row || !task) return;
  const fresh = renderRow(task);
  row.replaceWith(fresh);
  // One of the project's own columns is named "own:" and its id.
  if (focusField) fresh.querySelector(focusField.startsWith("own:") ? `[data-custom="${CSS.escape(focusField.slice(4))}"]` : `[data-field="${focusField}"]`)?.focus();
}

async function updateTask(id, changes, focusField) {
  const task = findTask(id);
  if (!task) return;
  // A repeating task needs a deadline to repeat from.
  if (repeats({ repeat: changes.repeat ?? task.repeat }) && !("deadline" in changes ? changes.deadline : task.deadline)) {
    if ("repeat" in changes) {
      changes = { ...changes, deadline: firstDeadline(changes.repeat) };
    } else {
      const message = "A repeating task needs a deadline. To remove it, set Repeats to One time first.";
      const w = state.windows.get(id);
      if (w) {
        showWindowError(w, message);
        w.body.querySelector('[data-field="deadline"]').value = task.deadline;
      } else {
        showSyncNote(message);
      }
      refreshRow(id);
      return;
    }
  }
  // The project's own columns travel together as "custom", and only the ones that changed
  // are sent, so two people filling in different columns don't overwrite each other.
  const { custom: ownChanges, ...plainChanges } = changes;
  const diff = onlyChanged(task, linkStatusAndProgress(task, plainChanges));
  const own = Object.fromEntries(Object.entries(ownChanges || {}).filter(([key, value]) => String(task.custom?.[key] ?? "") !== String(value ?? "")));
  if (Object.keys(own).length) diff.custom = own;
  if (!Object.keys(diff).length) return;

  // Show the change straight away; the next read confirms it.
  const { custom: _own, ...plainDiff } = diff;
  Object.assign(task, plainDiff, { updated_by: state.name, updated_at: new Date().toISOString() });
  task.custom = Object.fromEntries(Object.entries({ ...task.custom, ...own }).filter(([, value]) => String(value ?? "") !== ""));
  refreshRow(id, focusField);
  renderSummary();
  renderWindows();
  await write(() => state.store.save(id, diff), "That change didn't save, so it has been undone. Check your connection and try again.");
}

function fieldValue(control) {
  const field = control.dataset.field;
  if (field === "progress") return Number(control.value);
  if (field === "deadline") return control.value || null;
  if (field === "title" || field === "details") return control.value.trim();
  return control.value;
}

// Moves the bar and the number while a progress slider is being dragged.
function previewProgress(event) {
  if (event.target.dataset.field !== "progress") return;
  event.target.style.setProperty("--p", `${event.target.value}%`);
  event.target.closest(".progress-wrap").querySelector(".progress-label").textContent = `${event.target.value}%`;
}

const rows = $("task-rows");

rows.addEventListener("change", (event) => {
  const own = event.target.closest("[data-custom]");
  if (own) return saveOwnValue(own.closest(".task-row").dataset.id, own, `own:${own.dataset.custom}`);
  const control = event.target.closest("[data-field]");
  if (!control) return;
  const field = control.dataset.field;
  updateTask(control.closest(".task-row").dataset.id, { [field]: fieldValue(control) }, field);
});

rows.addEventListener("input", previewProgress);

$("filter-btn").addEventListener("click", () => setFilterOpen($("filter-panel").hidden));

$("filter-list").addEventListener("change", (event) => {
  const key = event.target.value;
  setFilter(event.target.checked ? [...state.filter, key] : state.filter.filter((other) => other !== key));
});

$("filter-clear").addEventListener("click", () => {
  setFilter([]);
  $("filter-btn").focus();
});

rows.addEventListener("click", (event) => {
  const taskCell = event.target.closest(".task-cell");
  // A drag ends with a click on the same cell, which shouldn't open the task.
  if (taskCell && !state.dragging && Date.now() - state.lastDrop > 300) {
    openTask(taskCell.closest(".task-row").dataset.id);
  }
});

rows.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!state.dragging && state.pollTimer) renderRows();
  }, 0);
});

function setUpDragging() {
  if (!window.Sortable) return;
  const shared = {
    animation: 140,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    delay: 160,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    scrollSensitivity: 70,
    ghostClass: "row-ghost",
    dragClass: "row-drag",
    onStart() {
      state.dragging = true;
      document.body.classList.add("is-dragging");
    },
  };
  new window.Sortable(rows, { ...shared, draggable: ".task-row", handle: ".task-cell", onEnd: handleDrop });
  new window.Sortable($("project-cards"), { ...shared, draggable: ".project-card", onEnd: handleProjectDrop });
}

function endDrag() {
  state.dragging = false;
  state.lastDrop = Date.now();
  document.body.classList.remove("is-dragging");
}

// A position halfway between the new neighbours, so nothing else has to be renumbered.
function positionBetween(before, after) {
  if (before && after) return (before.position + after.position) / 2;
  if (before) return before.position + 1000;
  if (after) return after.position - 1000;
  return 1000;
}

async function handleDrop(event) {
  endDrag();
  if (event.oldIndex === event.newIndex) return;

  const id = event.item.dataset.id;
  const task = findTask(id);
  if (!task) return;

  const order = [...rows.children].map((row) => row.dataset.id);
  const index = order.indexOf(id);
  const position = positionBetween(findTask(order[index - 1]), findTask(order[index + 1]));

  task.position = position;
  await write(() => state.store.move(id, position), "That move didn't save, so the row has gone back. Check your connection and try again.");
}

async function handleProjectDrop(event) {
  endDrag();
  if (event.oldIndex === event.newIndex) return;

  const id = event.item.dataset.project;
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;

  const order = [...$("project-cards").children].map((card) => card.dataset.project);
  const index = order.indexOf(id);
  const findProject = (key) => state.projects.find((p) => p.id === key);
  const position = positionBetween(findProject(order[index - 1]), findProject(order[index + 1]));

  project.position = position;
  await write(() => state.store.moveProject(id, position), "That move didn't save, so the card has gone back. Check your connection and try again.");
}

// Runs a change, then re-reads the list. Failure shows a note instead of hiding the problem.
async function write(action, failureMessage) {
  state.writes += 1;
  try {
    const result = await action();
    showSyncNote(null);
    return { ok: true, result };
  } catch (error) {
    if (error.code === "session_expired") {
      showGate("Your session ended. Enter the PIN to continue.");
      return { ok: false };
    }
    if (failureMessage) showSyncNote(failureMessage);
    return { ok: false, error };
  } finally {
    state.writes += 1;
    state.version = -1;
    refresh();
  }
}

function showSyncNote(message) {
  $("sync-note").textContent = message || "";
  $("sync-note").hidden = !message;
}

$("quick-add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("quick-title").value.trim();
  if (!title) return $("quick-title").focus();
  $("quick-submit").disabled = true;
  const added = await write(() => state.store.save(null, { title, project_id: state.projectId }), "That task didn't save. Check your connection and try again.");
  $("quick-submit").disabled = false;
  if (added.ok) {
    $("quick-title").value = "";
    keepInView(added.result.id);
  }
  $("quick-title").focus();
});

// ---------- Keeping everyone in sync ----------

let refreshing = false;

async function refresh() {
  if (refreshing || !$("gate").hidden) return;
  refreshing = true;
  const startedAt = state.writes;
  try {
    const result = await state.store.list(state.version);
    if (startedAt === state.writes && !state.dragging) {
      if (result.changed) {
        state.version = result.version;
        state.projects = result.projects || [];
        state.tasks = result.tasks;
        state.meetings = result.meetings || [];
        state.notifications = result.notifications || [];
        state.deleted = result.deleted || [];
        state.people = result.people || [];
        announceNotices(state.notifications);
        renderBoard();
      }
      if ($("sync-note").dataset.offline) {
        delete $("sync-note").dataset.offline;
        showSyncNote(null);
      }
    }
  } catch (error) {
    if (error.code === "session_expired") {
      showGate("Your session ended. Enter the PIN to continue.");
    } else {
      $("sync-note").dataset.offline = "1";
      showSyncNote("Can't reach the board right now. Trying again, and new changes may not be saved until it's back.");
    }
  } finally {
    refreshing = false;
    // A change finished while this read was running, so read again.
    if (startedAt !== state.writes && state.pollTimer) refresh();
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
}
function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.pollTimer) return;
  if (rollIsDue()) rollTasks().then(refresh);
  else refresh();
});

// Keeps "5 min ago" and "Due today" correct on a list left open, and has the board check
// for reminders when the day changes, a meeting comes within the hour, or it's been a while.
// A page in the background stops checking for changes, except for this once a minute when
// the notification sound is on, which is the only thing it has to tell anyone there.
function everyMinute() {
  if (!state.pollTimer) return;
  if (document.hidden) {
    if (!soundOn()) return;
    if (rollIsDue()) rollTasks().then(refresh);
    else refresh();
    return;
  }
  if (rollIsDue()) rollTasks().then(refresh);
  if (!state.dragging) renderBoard();
}
setInterval(everyMinute, 60000);

// ---------- Floating windows ----------

const isPhone = () => window.matchMedia("(max-width: 700px)").matches;

function placeWindow(w) {
  const { innerWidth: vw, innerHeight: vh } = window;
  w.width = clamp(w.width, MIN_WINDOW.width, vw - 16);
  w.height = clamp(w.height, MIN_WINDOW.height, vh - 16);
  w.x = clamp(w.x, KEEP_ON_SCREEN - w.width, vw - KEEP_ON_SCREEN);
  w.y = clamp(w.y, 0, vh - 44);
  Object.assign(w.root.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.width}px`, height: `${w.height}px` });
}

// Follows a pointer from pressing on the handle until it's released.
function trackPointer(handle, begin, move) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button") || isPhone()) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    const from = begin();
    handle.setPointerCapture(event.pointerId);
    const onMove = (e) => move(e.clientX - start.x, e.clientY - start.y, from);
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });
}

function focusWindow(w) {
  if (w.root.classList.contains("is-front") && w.root.style.zIndex === String(state.topZ)) return;
  state.windows.forEach((other) => other.root.classList.remove("is-front"));
  w.root.classList.add("is-front");
  w.root.style.zIndex = ++state.topZ;
}

function closeWindow(w) {
  w.chip?.remove();
  w.root.remove();
  state.windows.delete(w.key);
}

function closeAllWindows() {
  [...state.windows.values()].forEach(closeWindow);
}

function minimizeWindow(w) {
  w.root.hidden = true;
  w.hasEntry = false;
  w.chip = el("button", { class: "win-chip", type: "button" }, w.titleEl.textContent);
  w.chip.addEventListener("click", () => showWindow(w));
  $("window-tray").append(w.chip);
}

function showWindow(w) {
  w.chip?.remove();
  w.chip = null;
  w.root.hidden = false;
  focusWindow(w);
  w.root.focus({ preventScroll: true });
  if (isPhone() && !w.hasEntry) {
    addPhoneEntry();
    w.hasEntry = true;
  }
}

// On a phone, windows and the notifications list fill the screen like pages, so the
// phone's Back should close them. Each one gets a history entry for that.
function addPhoneEntry() {
  history.pushState({ boardWindow: true }, "");
  state.windowEntryHref = location.href;
}

// Back closes the window through its history entry, so the two go together.
function goBack(w) {
  if (w.hasEntry) history.back();
  else closeWindow(w);
}

function topWindow() {
  const open = [...state.windows.values()].filter((w) => !w.root.hidden);
  return open.sort((a, b) => Number(b.root.style.zIndex) - Number(a.root.style.zIndex))[0];
}

window.addEventListener("popstate", (event) => {
  const leftEntryHref = state.windowEntryHref;
  state.windowEntryHref = event.state?.boardWindow ? location.href : null;
  if (state.notifyHasEntry) return closeNotifications();
  const top = topWindow();
  if (top?.hasEntry) closeWindow(top);
  // Same address, nothing closed: that entry's window had already gone another way, so this
  // press hasn't done anything yet. A new address means it has, as with tapping a link,
  // which browsers can report here too.
  else if (leftEntryHref === location.href && $("gate").hidden) history.back();
});

function createWindow(key, title) {
  const titleEl = el("span", { class: "win-title" }, title);
  const back = el("button", { class: "win-back", type: "button" }, "‹ Back");
  const minimize = el("button", { class: "win-btn", type: "button", "aria-label": "Minimize" }, "–");
  const close = el("button", { class: "win-btn win-close", type: "button", "aria-label": "Close" }, "×");
  const bar = el("header", { class: "win-bar" }, back, titleEl, minimize, close);
  const body = el("div", { class: "win-body" });
  const grip = el("div", { class: "win-grip", "aria-hidden": "true" });
  const root = el("section", { class: "win", role: "dialog", "aria-label": title, tabindex: "-1" }, bar, body, grip);

  const step = state.windowCount++ % 6;
  const w = {
    key, root, body, titleEl, chip: null,
    x: 48 + step * 32,
    y: 70 + step * 28,
    width: 500,
    height: window.innerHeight - 110,
  };
  w.height = Math.min(w.height, 680);
  $("windows").append(root);
  state.windows.set(key, w);
  placeWindow(w);

  root.addEventListener("pointerdown", () => focusWindow(w));
  root.addEventListener("focusin", () => focusWindow(w));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeWindow(w);
  });
  back.addEventListener("click", () => goBack(w));
  minimize.addEventListener("click", () => minimizeWindow(w));
  close.addEventListener("click", () => closeWindow(w));
  trackPointer(bar, () => ({ x: w.x, y: w.y }), (dx, dy, from) => {
    w.x = from.x + dx;
    w.y = from.y + dy;
    placeWindow(w);
  });
  trackPointer(grip, () => ({ width: w.width, height: w.height }), (dx, dy, from) => {
    w.width = Math.min(from.width + dx, window.innerWidth - w.x);
    w.height = Math.min(from.height + dy, window.innerHeight - w.y);
    placeWindow(w);
  });
  return w;
}

window.addEventListener("resize", () => state.windows.forEach(placeWindow));

function field(label, control, ...rest) {
  return el("label", { class: "field" }, el("span", { class: "label" }, label), control, ...rest);
}

function textInput(attrs) {
  return el("input", { class: "input", type: "text", autocomplete: "off", ...attrs });
}

function optionsSelect(fieldName, options) {
  return el("select", { class: "input", "data-field": fieldName },
    ...Object.entries(options).map(([key, text]) => el("option", { value: key }, text)));
}

function section(heading, ...children) {
  return el("section", { class: "win-section" }, el("h3", { class: "win-heading" }, heading), ...children);
}

function hashName(key) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return hash >>> 0;
}

// Each person starts from a slot worked out from their name and jumps along if it's taken,
// far enough to land on a clearly different color. Going through everyone in the same order
// means every page agrees, and nobody matches until the board has more people than colors.
// Someone new can move a person whose slot they land on, so the colors are only
// recalculated when the list of people changes.
function assignPersonColors() {
  const keys = [...new Set([...state.people, ...state.tasks.flatMap((t) => t.assignees)].map(personKey).filter(Boolean))].sort();
  const everyone = keys.join("\n");
  if (everyone === state.personColorsFor) return;
  state.personColorsFor = everyone;
  const taken = new Set();
  state.personColors = new Map(keys.map((key) => {
    let slot = hashName(key) % PERSON_COLOR_COUNT;
    // A jump of 7 reaches all 16 slots before repeating.
    for (let tries = 0; taken.has(slot) && tries < PERSON_COLOR_COUNT; tries++) slot = (slot + 7) % PERSON_COLOR_COUNT;
    taken.add(slot);
    return [key, slot];
  }));
  document.querySelectorAll(".name-tag[data-person]").forEach((tag) => {
    tag.style.cssText = personColorStyle(personColor(tag.dataset.person));
  });
}

const personColor = (name) => state.personColors.get(personKey(name)) ?? hashName(personKey(name)) % PERSON_COLOR_COUNT;

// Every other color is deeper, so neighbours on the wheel still look different.
const personColorStyle = (slot) => `--person-hue: ${PERSON_HUES[slot]}; --person-tier: ${slot % 2}`;

// Names as removable tags, with a box to add more. Enter, a comma, clicking away or picking
// a suggestion adds what's typed, and names separated by commas add together.
function namePicker({ label, names = [], placeholder = "Add a name", title = null, boxClass = "input", skip = null, onChange = null }) {
  let current = [...names];
  const tags = el("ul", { class: "name-tags" });
  const box = textInput({ class: `${boxClass} name-box`, maxlength: "200", list: "people-list", placeholder, title, "aria-label": label });
  const render = () => tags.replaceChildren(...current.map((name) => el("li", { class: "name-tag", style: personColorStyle(personColor(name)), "data-person": name }, name,
    el("button", { class: "name-tag-x", type: "button", "aria-label": `Remove ${name}`, "data-name": name }, "×"))));
  const add = (text) => {
    const before = current.length;
    for (const name of splitNames(text)) {
      const key = personKey(name);
      if (key !== personKey(skip) && !current.some((other) => personKey(other) === key)) current.push(name);
    }
    if (current.length === before) return;
    render();
    onChange?.([...current]);
  };
  const take = () => {
    const typed = box.value;
    box.value = "";
    add(typed);
  };
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      take();
    }
  });
  box.addEventListener("blur", take);
  // Typing reports what kind of input it was. Picking a suggestion doesn't count as typing.
  // Phone keyboards often don't say which key was pressed, so a comma is spotted in the text.
  box.addEventListener("input", (event) => {
    if (!event.inputType || event.inputType === "insertReplacementText" || box.value.includes(",")) take();
  });
  tags.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-name]");
    if (!remove) return;
    current = current.filter((name) => name !== remove.dataset.name);
    render();
    box.focus();
    onChange?.([...current]);
  });
  render();
  return {
    root: el("div", { class: "name-picker" }, tags, box),
    add,
    names() {
      take();
      return [...current];
    },
    set(next) {
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = [...next];
      render();
    },
  };
}

function repeatField() {
  return field("Repeats", optionsSelect("repeat", REPEATS), el("span", { class: "hint", "data-repeat-note": true }));
}

// Where a task sits, to tell apart tasks with similar names: the task it's under, then its
// project, unless the project is already clear from where this is shown.
function taskPlace(task, withProject = true) {
  const parent = task.parent_id && findTask(task.parent_id);
  return [parent && `in ${parent.title}`, withProject && state.projects.find((p) => p.id === task.project_id)?.name].filter(Boolean).join(" · ");
}

// Every task in board order, each followed by its subtasks.
function tasksInOrder() {
  const projectOrder = new Map([...state.projects].sort((a, b) => a.position - b.position).map((p, i) => [p.id, i]));
  return state.tasks.filter((t) => !t.parent_id)
    .sort((a, b) => (projectOrder.get(a.project_id) ?? 0) - (projectOrder.get(b.project_id) ?? 0) || a.position - b.position)
    .flatMap((t) => [t, ...subtasksOf(t.id)]);
}

// One task or subtask for a meeting. The project comes first, which lists that project's
// tasks, and typing narrows the list. Once picked, the task shows as a tag that can be
// taken off again.
function taskPicker(taskId = null) {
  let current = findTask(taskId) ? taskId : null;
  const projects = [...state.projects].sort((a, b) => a.position - b.position);
  const project = el("select", { class: "input", "aria-label": "Project the task is in", "data-task-project": true },
    el("option", { value: "" }, "Choose a project"),
    ...projects.map((p) => el("option", { value: p.id }, p.name)),
    el("option", { value: "all" }, "All projects"));
  const box = textInput({ maxlength: "200", placeholder: "Type to narrow the list", "aria-label": "Search the tasks listed", "data-task-search": true, hidden: true });
  const list = el("ul", { class: "task-options", hidden: true });
  const chosen = el("div", { class: "task-chosen", hidden: true });
  const everywhere = () => project.value === "all";
  const matches = () => {
    const typed = box.value.trim().toLowerCase();
    return tasksInOrder().filter((t) => (everywhere() || t.project_id === project.value) && t.title.toLowerCase().includes(typed));
  };
  const render = () => {
    const task = findTask(current);
    const browsing = !task && project.value !== "";
    chosen.hidden = !task;
    project.hidden = !!task;
    box.hidden = !browsing;
    list.hidden = !browsing;
    chosen.replaceChildren(...(task ? [
      el("span", { class: "task-chosen-text" }, task.title, el("span", { class: "win-meta" }, taskPlace(task))),
      el("button", { class: "name-tag-x", type: "button", "aria-label": `Unlink ${task.title}`, "data-task-clear": true }, "×"),
    ] : []));
    if (!browsing) return;
    const found = matches();
    const nothing = box.value.trim() ? "No task matches that." : everywhere() ? "There are no tasks yet." : "No tasks in this project yet.";
    list.replaceChildren(...(found.length
      ? found.map((t) => el("li", {},
        el("button", { class: `task-option${t.parent_id ? " is-subtask" : ""}`, type: "button", "data-task-option": t.id },
          t.title, el("span", { class: "win-meta" }, [taskPlace(t, everywhere()), STATUS[t.status]].filter(Boolean).join(" · ")))))
      : [el("li", { class: "task-options-note" }, nothing)]));
  };
  const pick = (id) => {
    current = id;
    box.value = "";
    render();
  };
  project.addEventListener("change", () => {
    box.value = "";
    render();
  });
  box.addEventListener("input", render);
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault(); // Enter here picks a task. It doesn't send the form.
    const first = matches()[0];
    if (first) pick(first.id);
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-task-option]");
    if (option) pick(option.dataset.taskOption);
  });
  chosen.addEventListener("click", (event) => {
    if (!event.target.closest("[data-task-clear]")) return;
    // Back to the list the task came from, to pick a different one.
    const from = findTask(current)?.project_id;
    project.value = projects.some((p) => p.id === from) ? from : "";
    current = null;
    render();
    project.focus();
  });
  render();
  // A task deleted while the form was open counts as no task.
  return {
    root: el("div", { class: "task-picker" }, chosen, project, box, list),
    value: () => (findTask(current) ? current : null),
    set(id) { if (findTask(id)) pick(id); },
  };
}

function taskFields(assignPicker) {
  return [
    field("Task", textInput({ maxlength: "200", "data-field": "title" })),
    field("Details", el("textarea", { class: "input", rows: "2", maxlength: "4000", "data-field": "details" })),
    el("div", { class: "field-row" },
      el("div", { class: "field" }, el("span", { class: "label", "data-col-label": "assign" }, WINDOW_LABELS.assign), assignPicker.root),
      columnField("deadline", el("input", { class: "input", type: "date", "data-field": "deadline" }),
        el("span", { class: "due-note", "data-deadline-note": true }))),
    el("div", { class: "field-row" },
      columnField("urgency", optionsSelect("urgency", URGENCY)),
      columnField("status", optionsSelect("status", STATUS))),
  ];
}

// A field for one of the standard columns. Its label follows what the project calls it.
function columnField(key, control, ...rest) {
  const node = field(WINDOW_LABELS[key], control, ...rest);
  node.querySelector(".label").dataset.colLabel = key;
  return node;
}

function nameColumnFields(root, projectId) {
  for (const label of root.querySelectorAll("[data-col-label]")) {
    const text = renamed(projectId, label.dataset.colLabel) || WINDOW_LABELS[label.dataset.colLabel];
    if (label.textContent !== text) label.textContent = text;
  }
}

// The project's own columns in a task's window. Rebuilt when the project's setup changes,
// and otherwise kept up to date, leaving alone whatever is being typed in.
function renderOwnFields(w, task) {
  const box = w.body.querySelector("[data-custom-fields]");
  const fields = ownColumns(task.project_id);
  const signature = JSON.stringify(fields);
  if (box.dataset.sig !== signature && !box.contains(document.activeElement)) {
    box.dataset.sig = signature;
    box.hidden = !fields.length;
    box.replaceChildren(...fields.map((f) => field(f.name, ownControl(f, task.custom?.[f.id], false, null))));
  }
  for (const control of box.querySelectorAll("[data-custom]")) {
    if (control === document.activeElement) continue;
    const value = String(task.custom?.[control.dataset.custom] ?? "");
    // A choice the column no longer offers still has to show.
    if (control.tagName === "SELECT" && value && ![...control.options].some((o) => o.value === value)) control.add(new Option(value, value), 1);
    if (control.value !== value) control.value = value;
  }
}

// ---------- A task's window ----------

function openTask(id) {
  const task = findTask(id);
  if (!task) return;
  let w = state.windows.get(id);
  if (!w) {
    w = createWindow(id, task.title);
    w.taskId = id;
    w.uploading = [];
    buildTaskWindow(w, task);
    renderTaskWindow(w);
  }
  showWindow(w);
}

function buildTaskWindow(w, task) {
  const isSubtask = !!task.parent_id;
  w.assignPicker = namePicker({ label: "Assign to", names: task.assignees, onChange: (names) => updateTask(w.taskId, { assignees: names }) });
  const parts = [
    isSubtask && el("p", { class: "win-parent" }, "Part of ", el("button", { class: "link-btn", type: "button", "data-open-task": task.parent_id }, "")),
    ...taskFields(w.assignPicker),
    !isSubtask && el("div", { class: "field-row" },
      repeatField(),
      field("Project", el("select", { class: "input", "data-field": "project_id" }))),
    columnField("progress", el("div", { class: "progress-wrap progress-wrap-large" },
      el("output", { class: "progress-label" }, "0%"),
      el("input", { class: "progress-range", type: "range", min: "0", max: "100", step: "5", "data-field": "progress" }))),
    // The project's own columns, when it has any.
    el("div", { class: "own-fields", "data-custom-fields": true, hidden: true }),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    // The meetings set for this task, and a way to set another without leaving it.
    el("section", { class: "win-section", "data-section": "meetings" },
      el("h3", { class: "win-heading" }, "Meetings", el("span", { class: "win-count", "data-count": "meetings" })),
      el("ul", { class: "win-list", "data-list": "meetings" }),
      el("div", { class: "win-form" }, el("button", { class: "btn btn-quiet", type: "button", "data-set-meeting": true }, "Set a meeting"))),
    !isSubtask && el("details", { class: "win-fold" },
      el("summary", { class: "win-heading" }, "Subtasks", el("span", { class: "win-count", "data-count": "subtasks" })),
      el("ul", { class: "win-list", "data-list": "subtasks" }),
      el("form", { class: "win-form", "data-form": "subtask", novalidate: true },
        textInput({ maxlength: "200", placeholder: "Add a subtask", "aria-label": "New subtask", "data-input": "title" }),
        textInput({ class: "input is-narrow", maxlength: "200", list: "people-list", placeholder: "Assign", "aria-label": "Assign the new subtask to, with commas between names", "data-input": "assignee" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Add"))),
    el("section", { class: "win-section win-updates" },
      el("h3", { class: "win-heading" }, "Updates"),
      el("form", { class: "win-form", "data-form": "update", novalidate: true },
        textInput({ maxlength: "1000", placeholder: "Add an update", "aria-label": "New update", "data-input": "text" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Post")),
      el("ul", { class: "activity-list", "data-list": "updates" }),
      el("details", { class: "win-history" },
        el("summary", {}, "History", el("span", { class: "win-count", "data-count": "history" })),
        el("ul", { class: "activity-list", "data-list": "history" }))),
    section("Files",
      el("ul", { class: "win-list", "data-list": "files" }),
      el("div", { class: "win-form" },
        el("label", { class: "btn btn-quiet win-upload" }, "Upload files", el("input", { type: "file", multiple: true, "data-upload": true })))),
    section("Links",
      el("ul", { class: "win-list", "data-list": "links" }),
      el("form", { class: "win-form", "data-form": "link", novalidate: true },
        textInput({ maxlength: "2000", placeholder: "Paste a link", "aria-label": "Link address", "data-input": "url", inputmode: "url" }),
        textInput({ class: "input is-narrow", maxlength: "255", placeholder: "Title (optional)", "aria-label": "Link title", "data-input": "title" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Add"))),
    el("div", { class: "win-foot" },
      el("button", { class: "btn btn-danger", type: "button", "data-delete-task": true }, isSubtask ? "Delete this subtask" : "Delete this task")),
  ];
  w.body.append(...parts.filter(Boolean));
  w.body.addEventListener("change", (event) => onWindowChange(w, event));
  w.body.addEventListener("input", previewProgress);
  w.body.addEventListener("submit", (event) => onWindowSubmit(w, event));
  w.body.addEventListener("click", (event) => onWindowClick(w, event));
}

function showWindowError(w, message) {
  const note = w.body.querySelector("[data-error]");
  note.textContent = message || "";
  note.hidden = !message;
}

function setFieldValue(w, name, value) {
  const control = w.body.querySelector(`[data-field="${name}"]`);
  if (control && control !== document.activeElement) control.value = value ?? "";
}

// Rebuilds one list, but only when its contents changed, so a half-confirmed
// Remove button survives the next refresh.
function renderList(w, name, contents, build) {
  const list = w.body.querySelector(`[data-list="${name}"]`);
  // Someone typing a name in this list catches up when they finish.
  if (!list || list.querySelector("[data-assign-input]")) return;
  const signature = JSON.stringify(contents);
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren(...build());
}

function setCount(w, name, text) {
  const count = w.body.querySelector(`[data-count="${name}"]`);
  if (count) count.textContent = text;
}

function removeButton(attachment) {
  return el("button", { class: "win-remove", type: "button", "data-remove": attachment.id, "data-kind": attachment.kind, "aria-label": `Remove ${attachment.title}` }, "Remove");
}

function renderTaskWindow(w) {
  const task = findTask(w.taskId);
  const title = task.parent_id ? `Subtask: ${task.title}` : task.title;
  w.titleEl.textContent = title;
  w.root.setAttribute("aria-label", title);
  if (w.chip) w.chip.textContent = title;

  const projectSelect = w.body.querySelector('[data-field="project_id"]');
  const projectOptions = JSON.stringify(state.projects.map((p) => [p.id, p.name]));
  if (projectSelect && projectSelect.dataset.sig !== projectOptions && projectSelect !== document.activeElement) {
    projectSelect.dataset.sig = projectOptions;
    projectSelect.replaceChildren(...state.projects.map((p) => el("option", { value: p.id }, p.name)));
    projectSelect.value = task.project_id;
  }
  for (const name of ["title", "details", "deadline", "urgency", "status", "project_id"]) {
    setFieldValue(w, name, task[name]);
  }
  nameColumnFields(w.body, task.project_id);
  renderOwnFields(w, task);
  setFieldValue(w, "repeat", task.repeat || "none");
  const repeatNoteEl = w.body.querySelector("[data-repeat-note]");
  if (repeatNoteEl) repeatNoteEl.textContent = repeatNote(task);
  w.assignPicker.set(task.assignees);
  const range = w.body.querySelector('[data-field="progress"]');
  if (range !== document.activeElement) {
    range.value = task.progress;
    range.style.setProperty("--p", `${task.progress}%`);
    range.closest(".progress-wrap").querySelector(".progress-label").textContent = `${task.progress}%`;
  }
  const note = deadlineNote(task);
  const noteEl = w.body.querySelector("[data-deadline-note]");
  noteEl.textContent = note?.text || "";
  noteEl.className = `due-note${note ? ` due-${note.tone}` : ""}`;
  const parentLink = w.body.querySelector(".win-parent [data-open-task]");
  if (parentLink) parentLink.textContent = findTask(task.parent_id)?.title || "";

  // Meetings linked to this task that this person can see: those still to come soonest
  // first, then the ones that are over.
  const now = new Date();
  const meetings = state.meetings.filter((m) => m.task_id === task.id).map((m) => {
    const first = new Date(m.starts_at);
    const past = !repeats(m) && new Date(m.ends_at) <= now;
    const at = repeats(m) ? nextOccurrence(m, now) : first;
    const when = repeats(m)
      ? `${capitalize(repeatPhrase(m.repeat, first))}, ${formatTime(first)} · next ${formatDay(at)}`
      : `${formatDay(first)}, ${formatTime(first)}`;
    return { id: m.id, title: m.title, when, past, at: at.getTime(), status: meetingStatus(m) };
  }).sort((a, b) => a.past - b.past || (a.past ? b.at - a.at : a.at - b.at));
  setCount(w, "meetings", meetings.length ? String(meetings.length) : "");
  renderList(w, "meetings", meetings, () => (meetings.length ? meetings.map((m) => el("li", { class: `win-item${m.past ? " is-past" : ""}` },
    el("span", { class: "win-item-main" },
      el("button", { class: "link-btn", type: "button", "data-open-meeting": m.id }, m.title)),
    el("span", { class: "win-meta" }, m.when),
    m.past
      ? el("span", { class: "win-meta" }, "Past")
      : el("span", { class: `meeting-answer answer-${m.status[1]}` }, m.status[0])))
    : [el("li", { class: "win-empty" }, `No meetings for this ${task.parent_id ? "subtask" : "task"} yet.`)]));

  const subtasks = subtasksOf(task.id);
  setCount(w, "subtasks", subtasks.length ? `${subtasks.filter((s) => s.status === "done").length}/${subtasks.length}` : "");
  renderList(w, "subtasks", subtasks.map((s) => [s.id, s.title, s.assignees, s.status, deadlineNote(s)?.text]), () =>
    subtasks.length ? subtasks.map((s) => {
      const due = deadlineNote(s);
      return el("li", { class: "win-item" },
        el("input", { type: "checkbox", "data-done": s.id, checked: s.status === "done", "aria-label": `Mark ${s.title} done` }),
        el("span", { class: "win-item-main" },
          el("button", { class: `link-btn${s.status === "done" ? " subtask-done" : ""}`, type: "button", "data-open-task": s.id }, s.title)),
        s.assignees.length
          ? el("span", { class: "win-meta" }, s.assignees.join(", "))
          : el("button", { class: "link-btn win-meta", type: "button", "data-assign": s.id, "aria-label": `Assign ${s.title}` }, "Unassigned"),
        due && el("span", { class: `due-note due-${due.tone}` }, due.text));
    }) : [el("li", { class: "win-empty" }, "No subtasks yet.")]);

  // Notes people wrote stay in view. The automatic record of changes folds away under History.
  const entries = [...(task.updates || [])].reverse();
  const notes = entries.filter((entry) => entry.kind === "note");
  const history = entries.filter((entry) => entry.kind !== "note");
  const entrySignature = (entry) => [entry.at, entry.by, entry.text, timeAgo(entry.at)];
  renderList(w, "updates", notes.map(entrySignature), () =>
    notes.length ? notes.map((entry) => el("li", {},
      el("strong", {}, entry.by), " ",
      el("span", { class: "activity-time" }, timeAgo(entry.at)),
      el("span", { class: "activity-note" }, entry.text))) : [el("li", { class: "win-empty" }, "No updates yet.")]);
  setCount(w, "history", `(${history.length})`);
  renderList(w, "history", history.map(entrySignature), () => history.map((entry) =>
    el("li", { class: "activity-system" }, `${entry.by} ${entry.text} `, el("span", { class: "activity-time" }, timeAgo(entry.at)))));

  const attachments = task.attachments || [];
  const files = attachments.filter((a) => a.kind === "file");
  renderList(w, "files", [files.map((f) => [f.id, f.title]), w.uploading], () => [
    ...files.map((f) => el("li", { class: "win-item" },
      el("span", { class: "win-item-main" },
        el("button", { class: "link-btn", type: "button", "data-file": f.id, "data-mime": f.mime || "" }, f.title)),
      el("span", { class: "win-meta" }, `${formatSize(f.size_bytes)} · ${f.created_by}`),
      removeButton(f))),
    ...w.uploading.map((name) => el("li", { class: "win-item win-uploading" }, `Uploading ${name}…`)),
    !files.length && !w.uploading.length && el("li", { class: "win-empty" }, "No files yet."),
  ].filter(Boolean));

  const links = attachments.filter((a) => a.kind === "link");
  renderList(w, "links", links.map((l) => [l.id, l.title, l.url]), () =>
    links.length ? links.map((l) => el("li", { class: "win-item" },
      el("span", { class: "win-item-main" },
        // The server only accepts http and https addresses, so this can't run script.
        el("a", { class: "link-btn", href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.title)),
      el("span", { class: "win-meta" }, l.created_by),
      removeButton(l))) : [el("li", { class: "win-empty" }, "No links yet.")]);
}

function renderWindows() {
  for (const w of [...state.windows.values()]) {
    if (w.meetingId) {
      if (!findMeeting(w.meetingId)) {
        closeWindow(w);
        if (!w.deleting) showSyncNote(deletedNote(w.meetingId, "A meeting you had open is no longer on the calendar."));
      } else if (!w.isForm) {
        renderMeetingWindow(w);
      }
      continue;
    }
    // A Columns window goes with its project.
    if (w.key === "columns" && !findProject(w.projectId)) closeWindow(w);
    if (!w.taskId) continue;
    if (findTask(w.taskId)) renderTaskWindow(w);
    else {
      closeWindow(w);
      if (!w.deleting) showSyncNote(deletedNote(w.taskId, "A task you had open was deleted by someone else."));
    }
  }
}

function onWindowChange(w, event) {
  const control = event.target;
  if (control.dataset.custom) {
    saveOwnValue(w.taskId, control);
  } else if (control.dataset.field) {
    const name = control.dataset.field;
    const value = fieldValue(control);
    if (name === "title" && !value) {
      showWindowError(w, "Give the task a name.");
      control.value = findTask(w.taskId).title;
      return;
    }
    showWindowError(w, null);
    updateTask(w.taskId, { [name]: value });
  } else if (control.dataset.done) {
    updateTask(control.dataset.done, { status: control.checked ? "done" : "todo" });
  } else if (control.dataset.upload !== undefined) {
    uploadFiles(w, [...control.files]);
    control.value = "";
  }
}

async function onWindowSubmit(w, event) {
  event.preventDefault();
  const form = event.target;
  const input = (name) => form.querySelector(`[data-input="${name}"]`);
  const button = form.querySelector('button[type="submit"]');
  let action, failure, focusAfter;

  if (form.dataset.form === "subtask") {
    const title = input("title").value.trim();
    if (!title) return input("title").focus();
    const assignees = splitNames(input("assignee").value);
    action = () => state.store.save(null, { title, assignees, parent_id: w.taskId });
    failure = "That subtask didn't save. Check your connection and try again.";
    focusAfter = input("title");
  } else if (form.dataset.form === "update") {
    const text = input("text").value.trim();
    if (!text) return input("text").focus();
    action = () => state.store.addUpdate(w.taskId, text);
    failure = "That update didn't post. Check your connection and try again.";
    focusAfter = input("text");
  } else if (form.dataset.form === "link") {
    let url = input("url").value.trim();
    if (!url) return input("url").focus();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    const title = input("title").value.trim();
    action = () => state.store.addLink(w.taskId, title, url);
    failure = "That link wasn't added. Enter a web address starting with http:// or https://.";
    focusAfter = input("url");
  } else {
    return;
  }

  button.disabled = true;
  const result = await write(action, null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (result.ok) {
    form.reset();
    showWindowError(w, null);
    focusAfter.focus();
  } else {
    showWindowError(w, failure);
  }
}

function onWindowClick(w, event) {
  const target = event.target;
  const opener = target.closest("[data-open-task]");
  if (opener) return openTask(opener.dataset.openTask);
  const meeting = target.closest("[data-open-meeting]");
  if (meeting) return openMeeting(meeting.dataset.openMeeting);
  if (target.closest("[data-set-meeting]")) return openMeetingForm({ task: w.taskId });
  const assign = target.closest("[data-assign]");
  if (assign) return startAssigning(w, assign);
  const file = target.closest("[data-file]");
  if (file) return openFile(w, file.dataset.file, file.dataset.mime);
  const remove = target.closest("[data-remove]");
  if (remove) return removeAttachment(w, remove);
  if (target.closest("[data-delete-task]")) return deleteTask(w, target.closest("[data-delete-task]"));
}

// Swaps a subtask's "Unassigned" for a name box. Enter, clicking away or picking a
// suggestion saves the name; Esc or leaving it blank puts "Unassigned" back.
function startAssigning(w, button) {
  const id = button.dataset.assign;
  const input = textInput({
    class: "input win-assign-input",
    maxlength: "200",
    list: "people-list",
    placeholder: "Assign to",
    "aria-label": button.getAttribute("aria-label"),
    "data-assign-input": id,
  });
  let finished = false;
  const finish = (save, refocus) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    input.remove();
    if (!findTask(w.taskId)) return;
    w.body.querySelector('[data-list="subtasks"]').dataset.sig = "";
    if (save && name) {
      updateTask(id, { assignees: splitNames(name) });
    } else {
      renderTaskWindow(w);
      if (refocus) w.body.querySelector(`[data-assign="${CSS.escape(id)}"]`)?.focus();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Esc here cancels the name, not the whole window
      finish(false, true);
    }
  });
  input.addEventListener("blur", () => finish(true));
  // Typing reports what kind of input it was. Picking a suggestion doesn't count as typing.
  input.addEventListener("input", (event) => {
    if (!event.inputType || event.inputType === "insertReplacementText") finish(true);
  });
  button.replaceWith(input);
  input.focus();
}

async function uploadFiles(w, files) {
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showWindowError(w, `${file.name} is too large. Files can be up to 25 MB.`);
      continue;
    }
    w.uploading.push(file.name);
    if (w.root.isConnected) renderTaskWindow(w);
    const result = await write(() => state.store.uploadFile(w.taskId, file), null);
    w.uploading.splice(w.uploading.indexOf(file.name), 1);
    if (!w.root.isConnected) continue;
    if (result.ok) showWindowError(w, null);
    else showWindowError(w, `${file.name} didn't upload. Check your connection and try again.`);
    renderTaskWindow(w);
  }
}

async function openFile(w, id, mime) {
  const inline = OPENS_IN_BROWSER.test(mime);
  // A pop-up blocker only allows this before waiting on the network.
  const tab = inline ? window.open("about:blank", "_blank") : null;
  try {
    const url = await state.store.fileUrl(id, !inline);
    if (tab) {
      tab.opener = null;
      tab.location = url;
    } else if (inline) {
      window.open(url, "_blank", "noopener");
    } else {
      el("a", { href: url }).click();
    }
    showWindowError(w, null);
  } catch (error) {
    tab?.close();
    if (error.code === "session_expired") showGate("Your session ended. Enter the PIN to continue.");
    else showWindowError(w, "That file couldn't be opened. Check your connection and try again.");
  }
}

// Removing takes a second click, which has to come within a few seconds.
function armButton(button, label, resetLabel) {
  if (button.classList.contains("armed")) return true;
  button.classList.add("armed");
  button.textContent = label;
  setTimeout(() => {
    if (!button.isConnected) return;
    button.classList.remove("armed");
    button.textContent = resetLabel;
  }, 4000);
  return false;
}

async function removeAttachment(w, button) {
  if (!armButton(button, "Confirm?", "Remove")) return;
  button.disabled = true;
  const isFile = button.dataset.kind === "file";
  const result = await write(() => state.store.removeAttachment(button.dataset.remove), null);
  button.disabled = false;
  if (result.ok) {
    showWindowError(w, null);
    if (isFile) state.store.cleanFiles().catch(() => { /* retried by the next removal */ });
  } else {
    showWindowError(w, "That wasn't removed. Check your connection and try again.");
  }
}

async function deleteTask(w, button) {
  const id = w.taskId;
  const original = button.textContent;
  if (!armButton(button, "Delete for everyone?", original)) return;
  button.disabled = true;
  // Its own windows may close during the refresh below, before this function resumes.
  const going = [id, ...subtasksOf(id).map((s) => s.id)].map((key) => state.windows.get(key)).filter(Boolean);
  going.forEach((open) => { open.deleting = true; });
  const result = await write(() => state.store.remove(id), null);
  if (result.ok) {
    going.forEach(closeWindow);
    state.tasks = state.tasks.filter((t) => t.id !== id && t.parent_id !== id);
    state.store.cleanFiles().catch(() => { /* retried by the next removal */ });
  } else {
    going.forEach((open) => { open.deleting = false; });
    button.disabled = false;
    showWindowError(w, "That task wasn't deleted. Check your connection and try again.");
  }
}

// ---------- Adding a task with more than a name ----------

function openNewTask() {
  const existing = state.windows.get("new");
  if (existing) return showWindow(existing);
  const w = createWindow("new", "Add task");
  w.height = Math.min(w.height, 470);
  placeWindow(w);
  w.assignPicker = namePicker({ label: "Assign to" });
  const form = el("form", { class: "win-body", novalidate: true },
    ...taskFields(w.assignPicker),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "win-new-actions" }, el("button", { class: "btn btn-primary", type: "submit" }, "Add task")));
  w.body.replaceWith(form);
  w.body = form;
  // A new task always starts as To do, so its Status gives way to how often it repeats.
  w.body.querySelector('[data-field="status"]').closest(".field").replaceWith(repeatField());
  w.body.querySelector('[data-field="urgency"]').value = "normal";
  nameColumnFields(form, state.projectId);
  const repeat = form.querySelector('[data-field="repeat"]');
  const deadline = form.querySelector('[data-field="deadline"]');
  let filled = null; // a deadline this form put in itself, which it can still move or take out
  repeat.addEventListener("change", () => {
    if (!deadline.value || deadline.value === filled) {
      filled = repeat.value === "none" ? null : firstDeadline(repeat.value);
      deadline.value = filled ?? "";
    }
    form.querySelector("[data-repeat-note]").textContent = repeatNote({ repeat: repeat.value });
  });
  form.addEventListener("submit", (event) => submitNewTask(w, event));
  showWindow(w);
  w.body.querySelector('[data-field="title"]').focus();
}

async function submitNewTask(w, event) {
  event.preventDefault();
  const value = (name) => fieldValue(w.body.querySelector(`[data-field="${name}"]`));
  const title = value("title");
  if (!title) {
    showWindowError(w, "Give the task a name.");
    w.body.querySelector('[data-field="title"]').focus();
    return;
  }
  const fields = {
    title,
    project_id: state.projectId,
    details: value("details"),
    assignees: w.assignPicker.names(),
    deadline: value("deadline") || (value("repeat") === "none" ? null : firstDeadline(value("repeat"))),
    urgency: value("urgency"),
    repeat: value("repeat"),
  };
  const button = w.body.querySelector('button[type="submit"]');
  button.disabled = true;
  const saved = await write(() => state.store.save(null, fields), null);
  button.disabled = false;
  if (!saved.ok) return showWindowError(w, "That task didn't save. Check your connection and try again.");

  const { x, y, width } = w;
  closeWindow(w);
  if (!findTask(saved.result.id)) state.tasks.push({ attachments: [], updates: [], ...saved.result });
  keepInView(saved.result.id);
  openTask(saved.result.id);
  const opened = state.windows.get(saved.result.id);
  Object.assign(opened, { x, y, width });
  placeWindow(opened);
}

$("add-btn").addEventListener("click", openNewTask);

// ---------- A project's columns ----------

const newColumnId = () => `c${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;

function openColumns() {
  const project = findProject(state.projectId);
  if (!project) return;
  const existing = state.windows.get("columns");
  if (existing) {
    if (existing.projectId === project.id) return showWindow(existing);
    closeWindow(existing);
  }
  const w = createWindow("columns", `Columns: ${project.name}`);
  w.projectId = project.id;
  w.width = 520;
  placeWindow(w);
  const form = el("form", { class: "win-body", novalidate: true });
  w.body.replaceWith(form);
  w.body = form;
  buildColumnsForm(w, project.columns || {});
  form.addEventListener("submit", (event) => submitColumns(w, event));
  form.addEventListener("click", (event) => onColumnsClick(w, event));
  form.addEventListener("change", (event) => onColumnsChange(w, event));
  // Anything changed after the warning about removing a column means asking again.
  form.addEventListener("input", () => { w.confirmed = null; });
  showWindow(w);
}

// One of the project's own columns, as a row of the Columns window. A column that's been
// saved keeps its kind, since what tasks have in it wouldn't fit another.
function ownColumnRow(f, saved) {
  return el("li", { class: "col-own", "data-custom-row": f.id },
    el("div", { class: "col-own-top" },
      textInput({ maxlength: "30", placeholder: "Column name", value: f.name, "data-custom-name": true, "aria-label": "Column name" }),
      el("select", { class: "input", "data-custom-type": true, "aria-label": "Kind of column", disabled: saved, title: saved ? "A saved column keeps its kind" : null },
        ...Object.entries(COLUMN_KINDS).map(([key, text]) => el("option", { value: key, selected: key === f.type }, text))),
      el("button", { class: "win-remove", type: "button", "data-custom-remove": true }, "Remove")),
    el("div", { class: "col-own-choices", hidden: f.type !== "choice" },
      el("textarea", { class: "input", rows: "3", placeholder: "One choice per line", "data-custom-options": true, "aria-label": "Choices, one per line" }, (f.options || []).join("\n"))));
}

// Fills the window in from a setup: this project's, or another's being copied.
function buildColumnsForm(w, setup, copiedFrom = "") {
  const have = new Set(ownColumns(w.projectId).map((f) => f.id));
  const others = state.projects.filter((p) => p.id !== w.projectId && (Object.keys(p.columns?.builtin || {}).length || p.columns?.custom?.length));
  w.confirmed = null;
  w.body.replaceChildren(...[
    el("p", { class: "hint columns-intro" }, "How the task list looks in this project, for everyone on the board."),
    section("Standard columns",
      el("ul", { class: "col-list" }, ...STANDARD_COLUMNS.map((c) => el("li", { class: "col-row", "data-col-row": c.key },
        el("label", { class: "col-show" },
          el("input", { type: "checkbox", "data-col-show": true, checked: !setup.builtin?.[c.key]?.hidden, "aria-label": `Show ${c.label}` }), "Show"),
        textInput({ maxlength: "30", placeholder: c.label, value: setup.builtin?.[c.key]?.label || "", "data-col-name": true, "aria-label": `Heading for ${c.label}` })))),
      el("p", { class: "hint" }, "Type a heading to rename a column. One that isn't shown keeps its values and stays in each task's window, so reminders and progress carry on.")),
    section("This project's own columns",
      el("ul", { class: "col-list", "data-list": "custom-columns" }, ...(setup.custom || []).map((f) => ownColumnRow(f, have.has(f.id)))),
      el("p", { class: "win-empty", "data-none": true }, "None yet."),
      el("div", { class: "win-form" }, el("button", { class: "btn btn-quiet", type: "button", "data-add-column": true }, "Add a column"))),
    others.length > 0 && field("Copy the columns from another project",
      el("select", { class: "input", "data-copy-from": true },
        el("option", { value: "" }, "Choose a project"),
        ...others.map((p) => el("option", { value: p.id, selected: p.id === copiedFrom }, p.name))),
      copiedFrom && el("span", { class: "hint" }, "Copied in. Nothing changes until you save.")),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "win-new-actions" }, el("button", { class: "btn btn-primary", type: "submit" }, "Save columns")),
  ].filter(Boolean));
  syncColumnsForm(w);
}

function syncColumnsForm(w) {
  const count = w.body.querySelectorAll("[data-custom-row]").length;
  w.body.querySelector("[data-none]").hidden = count > 0;
  w.body.querySelector("[data-add-column]").disabled = count >= MAX_OWN_COLUMNS;
}

function onColumnsClick(w, event) {
  const remove = event.target.closest("[data-custom-remove]");
  if (event.target.closest("[data-add-column]")) {
    const row = ownColumnRow({ id: newColumnId(), name: "", type: "text" }, false);
    w.body.querySelector('[data-list="custom-columns"]').append(row);
    row.querySelector("[data-custom-name]").focus();
  } else if (remove) {
    remove.closest("[data-custom-row]").remove();
  } else {
    return;
  }
  w.confirmed = null;
  syncColumnsForm(w);
}

function onColumnsChange(w, event) {
  const kind = event.target.closest("[data-custom-type]");
  if (kind) kind.closest("[data-custom-row]").querySelector(".col-own-choices").hidden = kind.value !== "choice";
  const copy = event.target.closest("[data-copy-from]");
  if (copy?.value) buildColumnsForm(w, findProject(copy.value)?.columns || {}, copy.value);
}

// The setup the window describes, as the board takes it.
function readColumnsForm(w) {
  const builtin = {};
  for (const row of w.body.querySelectorAll("[data-col-row]")) {
    const standard = STANDARD_COLUMNS.find((c) => c.key === row.dataset.colRow);
    const typed = row.querySelector("[data-col-name]").value.trim();
    const label = typed === standard.label ? "" : typed;
    const hidden = !row.querySelector("[data-col-show]").checked;
    if (label || hidden) builtin[standard.key] = { ...(label && { label }), ...(hidden && { hidden: true }) };
  }
  const custom = [...w.body.querySelectorAll("[data-custom-row]")].map((row) => {
    const type = row.querySelector("[data-custom-type]").value;
    const options = [...new Set(row.querySelector("[data-custom-options]").value.split("\n").map((o) => o.trim()).filter(Boolean))];
    return { id: row.dataset.customRow, name: row.querySelector("[data-custom-name]").value.trim(), type, ...(type === "choice" && { options }) };
  });
  return { builtin, custom };
}

// What's wrong with a setup, in words, or nothing if it can be saved.
function columnsProblem({ builtin, custom }) {
  if (custom.some((f) => !f.name)) return COLUMN_ERRORS.column_name_required;
  const names = [...STANDARD_COLUMNS.map((c) => builtin[c.key]?.label || c.label), ...custom.map((f) => f.name)];
  const twice = names.find((name, i) => names.findIndex((other) => personKey(other) === personKey(name)) !== i);
  if (twice) return `Two columns are called ${twice}. Give one of them another name.`;
  const empty = custom.find((f) => f.type === "choice" && !f.options.length);
  if (empty) return `Add at least one choice for ${empty.name}, one per line.`;
  const crowded = custom.find((f) => f.type === "choice" && (f.options.length > 30 || f.options.some((o) => o.length > 40)));
  if (crowded) return `${crowded.name} takes up to 30 choices of 40 characters each.`;
  return null;
}

async function submitColumns(w, event) {
  event.preventDefault();
  const columns = readColumnsForm(w);
  const problem = columnsProblem(columns);
  if (problem) return showWindowError(w, problem);

  // Removing a column deletes what tasks have in it, so that takes a second press.
  const kept = new Set(columns.custom.map((f) => f.id));
  const filled = ownColumns(w.projectId).filter((f) => !kept.has(f.id))
    .map((f) => [f.name, state.tasks.filter((t) => t.project_id === w.projectId && String(t.custom?.[f.id] ?? "") !== "").length])
    .filter(([, count]) => count > 0);
  const asking = JSON.stringify(filled);
  if (filled.length && w.confirmed !== asking) {
    w.confirmed = asking;
    const which = filled.map(([name, count]) => `${name} is filled in on ${count} ${count === 1 ? "task" : "tasks"}`).join(", and ");
    return showWindowError(w, `${which}. Removing ${filled.length === 1 ? "the column deletes that" : "those columns deletes that"} too. Press Save columns again to go ahead.`);
  }

  const button = w.body.querySelector('button[type="submit"]');
  button.disabled = true;
  const saved = await write(() => state.store.saveColumns(w.projectId, columns), null);
  button.disabled = false;
  if (!saved.ok) {
    if (state.windows.get("columns") === w) showWindowError(w, COLUMN_ERRORS[saved.error?.code] || "The columns didn't save. Check your connection and try again.");
    return;
  }
  const project = findProject(w.projectId);
  if (project) project.columns = saved.result.columns || {};
  closeWindow(w);
  renderBoard();
}

$("columns-btn").addEventListener("click", openColumns);

// ---------- The calendar ----------

const findMeeting = (id) => state.meetings.find((m) => m.id === id);
const isOrganizer = (m) => personKey(m.created_by) === personKey(state.name);
const myInvite = (m) => m.people.find((p) => p.name_key === personKey(state.name));
const isConfirmed = (m) => !m.people.length || m.people.some((p) => p.answer === "accepted");
const byStart = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);
// Where a meeting stands, in words, and the name of the color that goes with it.
const meetingStatus = (m) => (isConfirmed(m) ? ["Confirmed", "accepted"]
  : m.people.every((p) => p.answer === "declined") ? ["Everyone declined", "declined"] : ["Waiting for answers", "waiting"]);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

// How often a repeating meeting is on, in words: "every Monday", or "every month on the
// 9th". Its first date sets the day.
function repeatPhrase(repeat, first) {
  if (repeat === "weekly") return `every ${first.toLocaleDateString(undefined, { weekday: "long" })}`;
  const day = first.getDate();
  return `every month on the ${ordinal(day)}${day > 28 ? " (the last day in shorter months)" : ""}`;
}

// A meeting's day and time for a notice: "Mon, Nov 9, 9:00 AM", or "every Monday, 9:00 AM".
function meetingWhen(repeat, startsAt) {
  const start = new Date(startsAt);
  return `${repeat && repeat !== "none" ? repeatPhrase(repeat, start) : formatDay(start)}, ${formatTime(start)}`;
}

// When a meeting starts on the given day, or null if it isn't on then. A repeating one
// is on the same weekday every week, or the same date every month, from its first day
// on. The board keeps one meeting for the whole series, so these dates are worked out here.
function occurrenceOn(m, date) {
  const first = new Date(m.starts_at);
  const firstDay = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (day < firstDay) return null;
  if (day > firstDay) {
    if (!repeats(m)) return null;
    if (m.repeat === "weekly" && day.getDay() !== first.getDay()) return null;
    if (m.repeat === "monthly") {
      const lastOfMonth = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
      if (day.getDate() !== Math.min(first.getDate(), lastOfMonth)) return null;
    }
  }
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), first.getHours(), first.getMinutes());
}

// The start of the next time a meeting is on: the one running now, or the first still to come.
function nextOccurrence(m, from = new Date()) {
  const first = new Date(m.starts_at);
  if (!repeats(m)) return first;
  const length = new Date(m.ends_at) - first;
  const begin = from > first ? from : first;
  for (let i = 0; i < 64; i++) {
    const at = occurrenceOn(m, addDays(begin, i));
    if (at && at.getTime() + length > from.getTime()) return at;
  }
  return first;
}

// Everyone the board knows about, with this person first.
function calendarPeople() {
  return peopleFrom([...state.people, ...state.meetings.flatMap((m) => [m.created_by, ...m.people.map((p) => p.name)])]);
}

// How a meeting shows on one person's row: solid once they're going, dashed while it's
// still unsettled for them, and only to the people in it. Null keeps it off their row.
function chipStyle(m, key) {
  if (personKey(m.created_by) === key) return isConfirmed(m) ? "ok" : "wait";
  const person = m.people.find((p) => p.name_key === key);
  if (!person || person.answer === "declined") return null;
  if (person.answer === "accepted") return "ok";
  return isOrganizer(m) || myInvite(m) ? "wait" : null;
}

function renderWaitingBanner() {
  // A repeating meeting never ends, so it keeps asking until it's answered.
  const now = new Date();
  const waiting = state.meetings
    .filter((m) => myInvite(m)?.answer === "waiting" && (repeats(m) || new Date(m.ends_at) > now))
    .map((m) => ({ m, at: nextOccurrence(m, now) }))
    .sort((a, b) => a.at - b.at);
  $("meeting-waiting").hidden = !waiting.length;
  if (!waiting.length) return;
  const { m: next, at } = waiting[0];
  const what = repeats(next)
    ? `${next.title}, ${repeatPhrase(next.repeat, new Date(next.starts_at))} from ${formatDay(at)}`
    : `${next.title}, ${formatDay(at)}`;
  $("meeting-waiting-text").textContent = waiting.length === 1
    ? `1 meeting is waiting for your answer: ${what}`
    : `${waiting.length} meetings are waiting for your answer. Next: ${what}`;
  $("meeting-waiting-open").dataset.meeting = next.id;
}

function renderCalendar() {
  if ($("calendar-view").hidden) return;
  renderWaitingBanner();

  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const short = { month: "short", day: "numeric" };
  const sameYear = days[0].getFullYear() === days[6].getFullYear();
  $("week-title").textContent = `${days[0].toLocaleDateString(undefined, sameYear ? short : { ...short, year: "numeric" })} to ${days[6].toLocaleDateString(undefined, { ...short, year: "numeric" })}`;

  const me = personKey(state.name);
  const today = dayKey(new Date());
  // What's on each day, in order of time: one-time meetings, and this week's turn of repeating ones.
  const onDay = days.map((date) => state.meetings
    .map((m) => ({ m, at: occurrenceOn(m, date) }))
    .filter(({ at }) => at)
    .sort((a, b) => a.at - b.at || byStart(a.m, b.m)));
  const rows = calendarPeople().map((person) => ({
    ...person,
    cells: onDay.map((meetings) => meetings
      .map(({ m, at }) => ({
        id: m.id,
        title: m.title,
        time: formatTime(at),
        repeat: repeats(m) ? repeatPhrase(m.repeat, new Date(m.starts_at)) : null,
        task: findTask(m.task_id)?.title ?? null,
        style: chipStyle(m, person.key),
      }))
      .filter((chip) => chip.style)),
  }));

  // Only rebuilds when something shows differently, so keyboard focus survives a refresh.
  const grid = $("week-grid");
  const signature = JSON.stringify([days.map(dayKey), today, rows]);
  if (grid.dataset.sig === signature) return;
  grid.dataset.sig = signature;
  grid.replaceChildren(
    el("div", { class: "week-row", role: "row" },
      el("div", { class: "week-corner", role: "columnheader" }, "People"),
      ...days.map((date) => el("div", { class: `week-day${dayKey(date) === today ? " is-today" : ""}`, role: "columnheader" },
        `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.getDate()}`))),
    ...rows.map((row) => el("div", { class: "week-row", role: "row" },
      el("div", { class: "week-person", role: "rowheader" }, row.key === me ? `${row.name} (you)` : row.name),
      ...row.cells.map((chips, i) => el("div", { class: `week-cell${dayKey(days[i]) === today ? " is-today" : ""}`, role: "cell" },
        el("button", {
          class: "week-add",
          type: "button",
          "data-add-day": dayKey(days[i]),
          "data-add-person": row.key === me ? null : row.name,
          "aria-label": `Set a meeting${row.key === me ? "" : ` with ${row.name}`} on ${formatDay(days[i])}`,
        }),
        ...chips.map((chip) => el("button", {
          class: `week-chip${chip.style === "wait" ? " is-waiting" : ""}`,
          type: "button",
          "data-meeting": chip.id,
          title: `${chip.time} ${chip.title}${chip.repeat ? ` (${chip.repeat})` : ""}${chip.task ? ` · Task: ${chip.task}` : ""}`,
          "aria-label": (chip.repeat || chip.task) && [`${chip.time} ${chip.title}`, chip.repeat, chip.task && `for the task ${chip.task}`].filter(Boolean).join(", "),
        },
          el("span", { class: "week-chip-time" }, chip.time, chip.repeat && el("span", { class: "week-chip-repeat", "aria-hidden": "true" }, "↻")),
          chip.title)))))));

  // Too narrow for all seven days: open a week on today, and leave it alone after that.
  if (grid.dataset.week !== dayKey(days[0])) {
    grid.dataset.week = dayKey(days[0]);
    const todayTab = grid.querySelector(".week-day.is-today");
    const scroller = grid.parentElement;
    scroller.scrollLeft = 0;
    if (todayTab) scroller.scrollLeft = todayTab.getBoundingClientRect().left - grid.querySelector(".week-person").getBoundingClientRect().right;
  }
}

function showWeek(start) {
  state.weekStart = start;
  renderCalendar();
}

$("week-prev").addEventListener("click", () => showWeek(addDays(state.weekStart, -7)));
$("week-next").addEventListener("click", () => showWeek(addDays(state.weekStart, 7)));
$("week-today").addEventListener("click", () => showWeek(startOfWeek(new Date())));
$("meeting-waiting-open").addEventListener("click", (event) => openMeeting(event.target.dataset.meeting));

$("week-grid").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-meeting]");
  if (chip) return openMeeting(chip.dataset.meeting);
  const add = event.target.closest("[data-add-day]");
  if (add) openMeetingForm({ day: add.dataset.addDay, person: add.dataset.addPerson });
});

$("set-meeting-btn").addEventListener("click", () => {
  const thisWeek = dayKey(startOfWeek(new Date())) === dayKey(state.weekStart);
  openMeetingForm({ day: dayKey(thisWeek ? new Date() : state.weekStart) });
});

// ---------- A meeting's window ----------

function openMeeting(id) {
  const meeting = findMeeting(id);
  if (!meeting) return;
  const key = `meeting:${id}`;
  let w = state.windows.get(key);
  if (!w) {
    w = createWindow(key, meeting.title);
    w.meetingId = id;
    w.height = Math.min(w.height, 540);
    placeWindow(w);
    buildMeetingWindow(w);
    renderMeetingWindow(w);
  }
  showWindow(w);
}

function buildMeetingWindow(w) {
  w.body.append(
    el("span", { class: "meeting-status", "data-meeting-status": true }),
    el("div", {},
      el("p", { class: "meeting-when", "data-meeting-when": true }),
      el("p", { class: "meeting-next", "data-meeting-next": true, hidden: true }),
      el("p", { class: "meeting-place", "data-meeting-place": true }),
      el("p", { class: "meeting-notes", "data-meeting-notes": true })),
    el("div", { class: "meeting-task", "data-list": "task", hidden: true }),
    section("People",
      el("ul", { class: "win-list", "data-list": "people" }),
      el("form", { class: "win-form", "data-form": "add-person", novalidate: true },
        textInput({ maxlength: "60", list: "people-list", placeholder: "Add a name", "aria-label": "Person to add", "data-input": "name" }),
        el("button", { class: "btn btn-quiet", type: "submit" }, "Add person"))),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "meeting-actions", "data-list": "actions" }));
  w.body.addEventListener("submit", (event) => addMeetingPerson(w, event));
  w.body.addEventListener("click", (event) => onMeetingClick(w, event));
}

function renderMeetingWindow(w) {
  const m = findMeeting(w.meetingId);
  w.titleEl.textContent = m.title;
  w.root.setAttribute("aria-label", m.title);
  if (w.chip) w.chip.textContent = m.title;

  const status = meetingStatus(m);
  const statusEl = w.body.querySelector("[data-meeting-status]");
  statusEl.textContent = status[0];
  statusEl.className = `meeting-status is-${status[1] === "accepted" ? "confirmed" : status[1]}`;

  const start = new Date(m.starts_at), end = new Date(m.ends_at);
  const day = repeats(m) ? capitalize(repeatPhrase(m.repeat, start)) : formatDay(start);
  w.body.querySelector("[data-meeting-when]").textContent = `${day}, ${formatTime(start)} to ${formatTime(end)}`;
  const next = w.body.querySelector("[data-meeting-next]");
  next.hidden = !repeats(m);
  next.textContent = repeats(m) ? `Next: ${formatDay(nextOccurrence(m))}` : "";
  const place = w.body.querySelector("[data-meeting-place]");
  place.hidden = !m.place;
  place.replaceChildren(/^https?:\/\/\S+$/i.test(m.place)
    ? el("a", { class: "link-btn", href: m.place, target: "_blank", rel: "noopener noreferrer" }, m.place)
    : m.place);
  const notes = w.body.querySelector("[data-meeting-notes]");
  notes.hidden = !m.notes;
  notes.textContent = m.notes;

  // The task this meeting is for, as it stands now: where it is, its status and how far along.
  const task = findTask(m.task_id);
  const due = task && deadlineNote(task);
  w.body.querySelector('[data-list="task"]').hidden = !task;
  renderList(w, "task", task ? [task.id, task.title, taskPlace(task), task.status, task.progress, due] : null, () => (task ? [
    el("span", { class: "meeting-task-label" }, task.parent_id ? "For the subtask" : "For the task"),
    el("button", { class: "link-btn meeting-task-name", type: "button", "data-open-task": task.id }, task.title),
    el("span", { class: "win-meta" }, [taskPlace(task), STATUS[task.status]].filter(Boolean).join(" · "),
      due && " · ", due && el("span", { class: `due-note due-${due.tone}` }, due.text)),
    el("span", { class: "project-progress" },
      el("span", { class: "project-bar" }, el("i", { style: `width: ${task.progress}%` })),
      el("span", { class: "project-percent" }, `${task.progress}%`)),
  ] : []));

  const organizer = isOrganizer(m);
  const mine = myInvite(m);
  const you = (name) => (personKey(name) === personKey(state.name) ? `${name} (you)` : name);
  renderList(w, "people", [m.created_by, m.people, organizer, state.name], () => [
    el("li", { class: "win-item" },
      el("span", { class: "win-item-main" }, you(m.created_by)),
      el("span", { class: "win-meta" }, "Set this meeting")),
    ...m.people.map((p) => el("li", { class: "win-item" },
      el("span", { class: "win-item-main" }, you(p.name)),
      el("span", { class: `meeting-answer answer-${p.answer}` }, ANSWER[p.answer]),
      organizer && el("button", { class: "win-remove", type: "button", "data-remove-person": p.name, "aria-label": `Remove ${p.name}` }, "Remove"))),
  ]);
  w.body.querySelector('[data-form="add-person"]').hidden = !(organizer || mine);

  renderList(w, "actions", [organizer, mine?.answer], () => [
    mine?.answer === "waiting" && el("button", { class: "btn btn-accept", type: "button", "data-answer": "accepted" }, "Accept"),
    mine?.answer === "waiting" && el("button", { class: "btn btn-decline", type: "button", "data-answer": "declined" }, "Decline"),
    mine?.answer === "accepted" && el("span", { class: "win-meta" }, "You accepted. ",
      el("button", { class: "link-btn", type: "button", "data-answer": "declined" }, "Change to declined")),
    mine?.answer === "declined" && el("span", { class: "win-meta" }, "You declined. ",
      el("button", { class: "link-btn", type: "button", "data-answer": "accepted" }, "Change to accepted")),
    organizer && el("button", { class: "btn btn-quiet", type: "button", "data-edit-meeting": true }, "Edit"),
    organizer && el("button", { class: "btn btn-danger", type: "button", "data-cancel-meeting": true }, "Cancel meeting"),
  ].filter(Boolean));
}

function onMeetingClick(w, event) {
  const target = event.target;
  const answer = target.closest("[data-answer]");
  if (answer) return answerMeeting(w, answer);
  const task = target.closest("[data-open-task]");
  if (task) return openTask(task.dataset.openTask);
  const remove = target.closest("[data-remove-person]");
  if (remove) return removeMeetingPerson(w, remove);
  if (target.closest("[data-edit-meeting]")) return openMeetingForm({ meeting: findMeeting(w.meetingId) });
  const cancel = target.closest("[data-cancel-meeting]");
  if (cancel) return cancelMeeting(w, cancel);
}

async function answerMeeting(w, button) {
  button.disabled = true;
  const result = await write(() => state.store.answerMeeting(w.meetingId, button.dataset.answer), null);
  button.disabled = false;
  if (w.root.isConnected) showWindowError(w, result.ok ? null : "Your answer didn't save. Check your connection and try again.");
}

async function addMeetingPerson(w, event) {
  event.preventDefault();
  const input = event.target.querySelector('[data-input="name"]');
  const name = input.value.trim();
  if (!name) return input.focus();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  const result = await write(() => state.store.addMeetingPerson(w.meetingId, name), null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (result.ok) {
    event.target.reset();
    showWindowError(w, null);
    input.focus();
  } else {
    showWindowError(w, "That person wasn't added. Check your connection and try again.");
  }
}

async function removeMeetingPerson(w, button) {
  if (!armButton(button, "Confirm?", "Remove")) return;
  button.disabled = true;
  const result = await write(() => state.store.removeMeetingPerson(w.meetingId, button.dataset.removePerson), null);
  button.disabled = false;
  if (w.root.isConnected) showWindowError(w, result.ok ? null : "That person wasn't removed. Check your connection and try again.");
}

async function cancelMeeting(w, button) {
  const id = w.meetingId;
  if (!armButton(button, "Cancel for everyone?", "Cancel meeting")) return;
  button.disabled = true;
  // Its windows may close during the refresh below, before this function resumes.
  const going = [w, state.windows.get(`edit-meeting:${id}`)].filter(Boolean);
  going.forEach((open) => { open.deleting = true; });
  const result = await write(() => state.store.cancelMeeting(id), null);
  if (result.ok) {
    going.forEach(closeWindow);
    state.meetings = state.meetings.filter((m) => m.id !== id);
    renderCalendar();
  } else {
    going.forEach((open) => { open.deleting = false; });
    button.disabled = false;
    showWindowError(w, "That meeting wasn't cancelled. Check your connection and try again.");
  }
}

// ---------- Setting or editing a meeting ----------

// With a meeting, edits it. Otherwise sets a new one, or adds to the form already open,
// so clicking another day or person updates it rather than losing what's been typed.
function openMeetingForm({ meeting = null, day = null, person = null, task = null } = {}) {
  const key = meeting ? `edit-meeting:${meeting.id}` : "new-meeting";
  let w = state.windows.get(key);
  const fresh = !w;
  if (!w) {
    w = createWindow(key, meeting ? `Edit: ${meeting.title}` : "Set meeting");
    w.height = Math.min(w.height, meeting ? 690 : 830);
    placeWindow(w);
    if (meeting) {
      w.meetingId = meeting.id;
      w.isForm = true;
    }
    buildMeetingForm(w, meeting);
  }
  if (day) {
    w.body.querySelector('[data-input="date"]').value = day;
    w.showRepeatNote();
  }
  if (person) w.invitePicker.add(person);
  // Set from a task's window: the meeting is for that task. A new form starts out named
  // after it, with the people on it ready to invite. One already being filled in keeps
  // what was typed and only changes which task it's for.
  const title = w.body.querySelector('[data-input="title"]');
  const forTask = !meeting && findTask(task);
  if (forTask) {
    w.taskPicker.set(forTask.id);
    if (!title.value.trim() || title.value === w.titleFromTask) {
      title.value = forTask.title;
      w.titleFromTask = forTask.title;
    }
    if (fresh) forTask.assignees.forEach((name) => w.invitePicker.add(name));
  }
  showWindow(w);
  title.focus();
  if (forTask && title.value === w.titleFromTask) title.select(); // typing replaces the suggested title
}

function buildMeetingForm(w, meeting) {
  if (!meeting) w.invitePicker = namePicker({ label: "People to invite", skip: state.name });
  w.taskPicker = taskPicker(meeting?.task_id);
  const form = el("form", { class: "win-body", novalidate: true },
    field("Title", textInput({ maxlength: "200", "data-input": "title" })),
    field("Date", el("input", { class: "input", type: "date", "data-input": "date" })),
    el("div", { class: "field-row meeting-times" },
      field("Start", el("input", { class: "input", type: "time", "data-input": "start" })),
      field("End", el("input", { class: "input", type: "time", "data-input": "end" }))),
    field("Repeats",
      el("select", { class: "input", "data-input": "repeat" }, ...Object.entries(REPEATS).map(([key, text]) => el("option", { value: key }, text))),
      el("span", { class: "hint", "data-repeat-note": true })),
    field("Place or link", textInput({ maxlength: "500", "data-input": "place" })),
    field("Notes", el("textarea", { class: "input", rows: "2", maxlength: "4000", "data-input": "notes" })),
    el("div", { class: "field" },
      el("span", { class: "label" }, "Linked task"),
      w.taskPicker.root,
      el("p", { class: "hint" }, "Optional. Choose the project, then the task. The meeting will show the task and how far along it is.")),
    !meeting && el("div", { class: "field" },
      el("span", { class: "label" }, "People to invite"),
      w.invitePicker.root,
      el("p", { class: "hint" }, "Invite nobody to block out your own time.")),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "win-new-actions" }, el("button", { class: "btn btn-primary", type: "submit" }, meeting ? "Save changes" : "Set meeting")));
  w.body.replaceWith(form);
  w.body = form;

  const input = (name) => form.querySelector(`[data-input="${name}"]`);
  const start = meeting && new Date(meeting.starts_at);
  const end = meeting && new Date(meeting.ends_at);
  input("title").value = meeting?.title || "";
  input("date").value = dayKey(start || new Date());
  input("start").value = start ? clockValue(start) : "09:00";
  input("end").value = end ? clockValue(end) : "10:00";
  input("place").value = meeting?.place || "";
  input("notes").value = meeting?.notes || "";
  input("repeat").value = meeting && repeats(meeting) ? meeting.repeat : "none";

  // Says in words what the choice means for the date picked: which day, and from when.
  w.showRepeatNote = () => {
    const repeat = input("repeat").value;
    const day = input("date").value && parseDate(input("date").value);
    form.querySelector("[data-repeat-note]").textContent = repeat === "none" || !day
      ? ""
      : `${capitalize(repeatPhrase(repeat, day))} from ${formatDay(day)}, until it's cancelled.`;
  };
  input("repeat").addEventListener("change", w.showRepeatNote);
  input("date").addEventListener("change", w.showRepeatNote);
  w.showRepeatNote();

  // A later start pushes the end along, so the meeting keeps its length of an hour.
  input("start").addEventListener("change", () => {
    if (!input("start").value || input("end").value > input("start").value) return;
    const [hours, minutes] = input("start").value.split(":").map(Number);
    input("end").value = hours >= 23 ? "23:59" : `${pad2(hours + 1)}:${pad2(minutes)}`;
  });
  form.addEventListener("submit", (event) => submitMeetingForm(w, meeting, event));
}

async function submitMeetingForm(w, meeting, event) {
  event.preventDefault();
  const form = w.body;
  const value = (name) => form.querySelector(`[data-input="${name}"]`).value.trim();
  const fail = (message, name) => {
    showWindowError(w, message);
    form.querySelector(`[data-input="${name}"]`).focus();
  };
  const [title, date, start, end] = ["title", "date", "start", "end"].map(value);
  if (!title) return fail("Give the meeting a title.", "title");
  if (!date) return fail("Choose a date.", "date");
  if (!start || !end) return fail("Choose a start and end time.", start ? "end" : "start");
  if (end <= start) return fail("The meeting has to end after it starts.", "end");
  showWindowError(w, null);

  const fields = {
    title,
    starts_at: new Date(`${date}T${start}`).toISOString(),
    ends_at: new Date(`${date}T${end}`).toISOString(),
    place: value("place"),
    notes: value("notes"),
    repeat: value("repeat"),
    task_id: w.taskPicker.value(),
  };
  if (!meeting) fields.people = w.invitePicker.names();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const saved = await write(() => state.store.saveMeeting(meeting?.id ?? null, fields), null);
  button.disabled = false;
  if (!saved.ok) return showWindowError(w, "That meeting didn't save. Check your connection and try again.");

  const { x, y, width } = w;
  closeWindow(w);
  const id = saved.result.id;
  if (!findMeeting(id)) {
    state.meetings.push({ ...saved.result, people: (fields.people || []).map((name) => ({ name, name_key: personKey(name), answer: "waiting" })) });
  }
  showWeek(startOfWeek(new Date(fields.starts_at)));
  openMeeting(id);
  const opened = state.windows.get(`meeting:${id}`);
  Object.assign(opened, { x, y, width });
  placeWindow(opened);
  renderWindows(); // so a task window that's open lists its new meeting without waiting
}

// ---------- Today's summary: what changed in a project today ----------

const TODAY_OPEN_KEY = "board.todayOpen";
const BOARD_ACTOR = "Movers Board"; // the name on changes the board makes by itself, like reopening a repeating task

// Today's entries from the history of this project's tasks and subtasks, grouped by task,
// with the task touched most recently first. What the board did by itself is left out.
function todaysUpdates(projectId) {
  const today = dayKey(new Date());
  const newestFirst = (a, b) => new Date(b.at) - new Date(a.at);
  return state.tasks
    .filter((task) => task.project_id === projectId)
    .map((task) => ({
      task,
      // The history is kept oldest first. Turning it round before sorting puts the later of
      // two entries made at the same instant on top.
      entries: [...(task.updates || [])].reverse().filter((entry) => entry.by !== BOARD_ACTOR && dayKey(new Date(entry.at)) === today).sort(newestFirst),
    }))
    .filter((group) => group.entries.length)
    .sort((a, b) => newestFirst(a.entries[0], b.entries[0]));
}

function renderToday() {
  if ($("project-view").hidden) return;
  const groups = todaysUpdates(state.projectId);
  const count = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const some = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  $("today-count").textContent = count ? `${some(count, "update")} on ${some(groups.length, "task")}` : "No updates yet today";

  const view = groups.map(({ task, entries }) => ({
    id: task.id,
    title: task.title,
    about: [taskPlace(task, false), STATUS[task.status], `${task.progress}%`].filter(Boolean).join(" · "),
    entries: entries.map((entry) => ({ who: entry.by, time: formatTime(new Date(entry.at)), text: entry.text, note: entry.kind === "note" })),
  }));
  // Only rebuilds when something shows differently, so keyboard focus survives a refresh.
  const list = $("today-list");
  const signature = JSON.stringify(view);
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren(...view.map((group) => el("section", { class: "today-task", "data-today-task": group.id },
    el("div", { class: "today-task-head" },
      el("button", { class: "link-btn", type: "button", "data-open-task": group.id }, group.title), " ",
      el("span", { class: "win-meta" }, group.about)),
    el("ul", { class: "today-entries" }, ...group.entries.map((entry) => el("li", { class: `today-entry${entry.note ? " is-note" : ""}` },
      el("span", { class: "today-time" }, entry.time), " ",
      el("span", { class: "today-body" },
        el("strong", { class: "today-who" }, entry.who), " ",
        // What someone wrote is quoted. The rest is the board's own record of a change.
        el("span", { class: "today-text" }, entry.note ? `“${entry.text}”` : entry.text))))))));
}

// Folded away until someone opens it. Their choice is kept on this device.
$("today-summary").open = readStorage("localStorage", TODAY_OPEN_KEY) === "1";
$("today-summary").addEventListener("toggle", () => {
  writeStorage("localStorage", TODAY_OPEN_KEY, $("today-summary").open ? "1" : null);
});
$("today-list").addEventListener("click", (event) => {
  const task = event.target.closest("[data-open-task]");
  if (task) openTask(task.dataset.openTask);
});

// ---------- People: who has what ----------

const URGENCY_ORDER = ["critical", "high", "normal", "low"];

// Open work for each person: every task and subtask that isn't done, counted for everyone
// it's assigned to. The heaviest urgent load comes first, since that's where work piles
// up. Work nobody has goes last.
function workload() {
  const open = state.tasks.filter((t) => t.status !== "done");
  const done = state.tasks.filter((t) => t.status === "done");
  const has = (task, key) => task.assignees.some((name) => personKey(name) === key);
  const rank = (task) => URGENCY_ORDER.indexOf(task.urgency);
  const mostUrgentFirst = (a, b) => rank(a) - rank(b) || (a.deadline || "9999").localeCompare(b.deadline || "9999") || a.title.localeCompare(b.title);
  const entry = (key, name, tasks, doneCount) => {
    const levels = Object.fromEntries(URGENCY_ORDER.map((level) => [level, tasks.filter((t) => t.urgency === level).length]));
    return {
      key, name, levels, done: doneCount,
      tasks: [...tasks].sort(mostUrgentFirst),
      urgent: levels.critical + levels.high,
      overdue: tasks.filter((t) => t.deadline && daysUntil(t.deadline) < 0).length,
    };
  };
  const people = peopleFrom([...state.people, ...state.tasks.flatMap((t) => t.assignees)])
    .map(({ key, name }) => entry(key, name, open.filter((t) => has(t, key)), done.filter((t) => has(t, key)).length))
    .sort((a, b) => b.urgent - a.urgent || b.levels.critical - a.levels.critical || b.tasks.length - a.tasks.length || a.name.localeCompare(b.name));
  const nobody = open.filter((t) => !t.assignees.length);
  return { open, cards: nobody.length ? [...people, entry("", "Unassigned", nobody, 0)] : people };
}

function renderPeoplePage() {
  if ($("people-view").hidden) return;
  const { open, cards } = workload();
  const urgent = open.filter((t) => t.urgency === "critical" || t.urgency === "high").length;
  const unassigned = open.filter((t) => !t.assignees.length).length;
  $("people-summary").textContent = [`${open.length} open`, `${urgent} urgent`, unassigned && `${unassigned} unassigned`].filter(Boolean).join(" · ");

  // Bars are measured against the busiest person, so the longest bar is the biggest load.
  const most = Math.max(1, ...cards.map((c) => c.tasks.length));
  const me = personKey(state.name);
  const view = cards.map((c) => ({
    key: c.key,
    name: c.key === me ? `${c.name} (you)` : c.name,
    person: c.key ? c.name : null,
    count: c.tasks.length,
    urgent: c.urgent,
    levels: c.levels,
    overdue: c.overdue,
    done: c.done,
    width: Math.round((c.tasks.length / most) * 100),
    tasks: c.tasks.map((t) => ({ id: t.id, title: t.title, urgency: t.urgency, about: [taskPlace(t), STATUS[t.status], `${t.progress}%`].filter(Boolean).join(" · "), due: deadlineNote(t) })),
  }));

  // Only rebuilds when something shows differently, so an open card and keyboard focus survive a refresh.
  const list = $("people-cards");
  const signature = JSON.stringify(view);
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren(...view.map((c) => el("details", { class: `person-card${c.person ? "" : " is-unassigned"}`, "data-person-card": c.key, open: state.peopleOpen.has(c.key) },
    el("summary", { class: "person-head" },
      c.person
        ? el("span", { class: "name-tag person-name", style: personColorStyle(personColor(c.person)), "data-person": c.person }, c.name)
        : el("span", { class: "person-name person-nobody" }, c.name),
      " ",
      el("span", { class: "person-figures" },
        el("span", { class: `person-urgent${c.urgent ? " has-urgent" : ""}` }, `${c.urgent} urgent`), " ",
        el("span", { class: "person-open" }, `${c.count} open`), " ",
        el("span", { class: "person-toggle", "aria-hidden": "true" })),
      el("span", { class: "load-bar", "aria-hidden": "true" },
        el("span", { class: "load-fill", style: `width: ${c.width}%` },
          ...URGENCY_ORDER.filter((level) => c.levels[level]).map((level) => el("i", { class: `load-${level}`, style: `flex: ${c.levels[level]}` }))))),
    // The row itself stays to one line. The breakdown and the tasks are inside.
    el("div", { class: "person-body" },
      (c.count > 0 || c.done > 0) && el("p", { class: "person-levels" },
        ...URGENCY_ORDER.filter((level) => c.levels[level]).flatMap((level) => [
          el("span", { class: "person-level" }, el("span", { class: `dot dot-${level}`, "aria-hidden": "true" }), `${c.levels[level]} ${URGENCY[level]}`), " "]),
        c.overdue > 0 && el("span", { class: "person-overdue" }, `${c.overdue} overdue`), " ",
        c.done > 0 && el("span", { class: "person-done" }, `${c.done} done`)),
      c.tasks.length
        ? el("ul", { class: "person-tasks" }, ...c.tasks.map((t) => el("li", { class: "person-task", "data-person-task": t.id },
          el("span", { class: `dot dot-${t.urgency}`, role: "img", "aria-label": `${URGENCY[t.urgency]} urgency`, title: `${URGENCY[t.urgency]} urgency` }),
          el("span", { class: "person-task-main" },
            el("button", { class: "link-btn", type: "button", "data-open-task": t.id }, t.title), " ",
            el("span", { class: "win-meta" }, t.about)),
          t.due && el("span", { class: `due-note due-${t.due.tone}` }, t.due.text))))
        : el("p", { class: "win-empty person-none" }, "Nothing open.")))));
}

$("people-cards").addEventListener("click", (event) => {
  const task = event.target.closest("[data-open-task]");
  if (task) openTask(task.dataset.openTask);
});

// Remembers which cards are open, so they stay open when the list is redrawn. Opening and
// closing doesn't bubble up, so it's caught on the way down.
$("people-cards").addEventListener("toggle", (event) => {
  const card = event.target.closest?.("[data-person-card]");
  if (!card) return;
  if (card.open) state.peopleOpen.add(card.dataset.personCard);
  else state.peopleOpen.delete(card.dataset.personCard);
}, true);

// ---------- Notifications ----------

// A notification's two lines: what happened, then which item it's about.
function notificationLines(n) {
  if (n.action === "starting") {
    // A reminder is for one date, so it gives that day even when the meeting repeats.
    const start = new Date(n.starts_at);
    return [`Reminder: your meeting ${start > new Date() ? "starts" : "was"} at ${formatTime(start)}`, [n.title, formatDay(start)]];
  }
  if (n.kind === "meeting") {
    const when = meetingWhen(n.repeat, n.starts_at);
    return [`${n.by_name} ${MEETING_NOTICE[n.action]}`, [n.title, n.action === "changed" ? `now ${when}` : when]];
  }
  const where = [n.title, n.parent_title && `in ${n.parent_title}`, n.project_name];
  if (n.action === "edited" || n.action === "noted") {
    // Changes by the same person fold into one notice: the latest, and a count of the rest.
    const posted = n.action === "noted";
    const text = String(n.detail || "");
    const more = n.earlier_changes ? ` (and ${n.earlier_changes} earlier ${posted ? "update" : "change"}${n.earlier_changes === 1 ? "" : "s"})` : "";
    return [
      posted ? `${n.by_name} posted an update on your ${n.kind}` : `${n.by_name} edited your ${n.kind}`,
      where,
      `${posted ? `“${text}”` : text.charAt(0).toUpperCase() + text.slice(1)}${more}`,
    ];
  }
  if (n.action === "due") {
    const due = daysUntil(n.due_on) === 0 ? "is due today" : `was due ${formatDay(parseDate(n.due_on))}`;
    return [`Reminder: your ${n.kind} ${due}`, where];
  }
  if (n.action === "reopened") {
    const task = findTask(n.task_id);
    return [`Reminder: your ${task && repeats(task) ? task.repeat : "repeating"} task is open again`, [n.title, `due ${formatDay(parseDate(n.due_on))}`, n.project_name]];
  }
  if (n.action !== "deleted") return [`${n.by_name} assigned you a ${n.kind}`, where];
  if (!n.inside_count) return [`${n.by_name} deleted your ${n.kind}`, where];
  const yours = n.inside_count === 1 ? "1 item" : `${n.inside_count} items`;
  return [`${n.by_name} deleted a ${n.kind}`, [...where, `included ${yours} you created`]];
}

// ---------- The sound for a new notification ----------

const SOUND_KEY = "board.sound"; // "0" on a device where it's been turned off
const CHIME_GAP_MS = 15000; // a burst of changes is one sound, not one each
// Browsers only allow sound once someone has clicked or typed on the page, so that's
// when this is made. Until then a notification arrives silently.
let audio = null;
const soundOn = () => readStorage("localStorage", SOUND_KEY) !== "0";

function wakeAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* this browser has no sound to offer */ }
}
window.addEventListener("pointerdown", wakeAudio, true);
window.addEventListener("keydown", wakeAudio, true);

// Two soft notes, the second higher. Says whether it could play.
function chime() {
  if (!audio || audio.state !== "running") return false;
  const start = audio.currentTime + 0.02;
  for (const [pitch, delay] of [[880, 0], [1174.66, 0.16]]) {
    const tone = audio.createOscillator();
    const level = audio.createGain();
    tone.type = "sine";
    tone.frequency.value = pitch;
    level.gain.setValueAtTime(0.0001, start + delay);
    level.gain.exponentialRampToValueAtTime(0.2, start + delay + 0.02);
    level.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.5);
    tone.connect(level).connect(audio.destination);
    tone.start(start + delay);
    tone.stop(start + delay + 0.55);
  }
  return true;
}

// A notice counts as new when it's unread and wasn't there at the last read, or has come
// back to the top with another change. The first read after entering is never news.
const noticeStamp = (n) => `${n.id} ${n.created_at}`;
function announceNotices(notifications) {
  const seen = state.noticesSeen;
  state.noticesSeen = new Set(notifications.map(noticeStamp));
  if (!seen || !soundOn()) return;
  if (!notifications.some((n) => !n.read_at && !seen.has(noticeStamp(n)))) return;
  if (Date.now() - state.lastChime < CHIME_GAP_MS) return;
  state.lastChime = Date.now();
  chime();
}

function renderSoundSwitch() {
  $("notify-sound").setAttribute("aria-pressed", String(soundOn()));
  $("notify-sound").textContent = soundOn() ? "Sound on" : "Sound off";
}

$("notify-sound").addEventListener("click", () => {
  writeStorage("localStorage", SOUND_KEY, soundOn() ? "0" : null);
  renderSoundSwitch();
  // Turning it on plays it, so it's clear what to listen for.
  if (soundOn()) chime();
});
renderSoundSwitch();

function renderNotifications() {
  const unread = state.notifications.filter((n) => !n.read_at).length;
  $("notify-count").textContent = unread;
  $("notify-count").hidden = !unread;
  $("notify-btn").setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
  $("notify-read-all").hidden = !unread;
  $("notify-list").replaceChildren(...(state.notifications.length
    ? state.notifications.map((n) => {
      const [headline, details, change] = notificationLines(n);
      return el("li", {},
        el("button", { class: `notify-item${n.read_at ? "" : " is-unread"}`, type: "button", "data-notification": n.id, "data-task": n.task_id, "data-open-meeting": n.meeting_id },
          headline,
          el("span", { class: "notify-task" }, details.filter(Boolean).join(" · ")),
          change && el("span", { class: "notify-task notify-change" }, change),
          el("span", { class: "notify-time" }, timeAgo(n.created_at))));
    })
    : [el("li", { class: "notify-empty" }, "Nothing yet. Assignments, changes to your tasks, meeting invites, reminders for tasks that are due and meetings about to start, and deletions of things you created show up here.")]));
}

function openNotifications() {
  $("notify-panel").hidden = false;
  $("notify-btn").setAttribute("aria-expanded", "true");
  if (isPhone() && !state.notifyHasEntry) {
    addPhoneEntry();
    state.notifyHasEntry = true;
  }
}

function closeNotifications() {
  $("notify-panel").hidden = true;
  $("notify-btn").setAttribute("aria-expanded", "false");
  state.notifyHasEntry = false;
}

function markNotificationsRead(ids) {
  const now = new Date().toISOString();
  for (const n of state.notifications) {
    if (!n.read_at && (!ids || ids.includes(n.id))) n.read_at = now;
  }
  renderNotifications();
  write(() => state.store.markRead(ids), null);
}

$("notify-btn").addEventListener("click", () => {
  if ($("notify-panel").hidden) openNotifications();
  else closeNotifications();
});

$("notify-back").addEventListener("click", () => {
  if (state.notifyHasEntry) history.back();
  else closeNotifications();
});

$("notify-read-all").addEventListener("click", () => markNotificationsRead(null));

$("notify-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-notification]");
  if (!item) return;
  markNotificationsRead([item.dataset.notification]);
  // On a phone the list is its own page, so leave it up when there's nothing to go to.
  if (!isPhone() || findTask(item.dataset.task) || findMeeting(item.dataset.openMeeting)) closeNotifications();
  openTask(item.dataset.task);
  openMeeting(item.dataset.openMeeting);
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".notify")) closeNotifications();
  if (!event.target.closest(".task-filter")) setFilterOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("notify-panel").hidden) {
    closeNotifications();
    $("notify-btn").focus();
  }
  if (!$("filter-panel").hidden) {
    setFilterOpen(false);
    $("filter-btn").focus();
  }
});

// ---------- Start ----------

async function boot() {
  setUpDragging();
  try {
    state.store = await loadStore();
  } catch {
    showGateError("The board isn't set up yet. Ask whoever shared this link to check it.");
    $("gate-submit").disabled = true;
    return;
  }
  $("name-input").value = readStorage("localStorage", NAME_KEY) || "";

  const saved = savedSession();
  if (saved) await startBoard(saved.token, saved.name);
  else pinInputs[0].focus();
}

boot();
