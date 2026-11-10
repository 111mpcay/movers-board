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
  rescheduled: "rescheduled a meeting",
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
  focus: [], // everyone's focus tasks: {task_id, person_key, name, set_at}
  focusNote: null, // why the last star on My Tasks didn't take, until the next one does
  lastRoll: 0, // when this page last asked the board to check for reminders
  rolledDay: "", // and which day that was, so it asks again when the date changes
  windowEntryHref: history.state?.boardWindow ? location.href : null, // this history entry's address, if it was added for a phone's window
  notifyHasEntry: false, // whether the open notifications list has its own history entry
  windows: new Map(),
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

// A task lives in one project and can be mirrored elsewhere: into a task of another project,
// where it shows with that task's subtasks, or into a project's list as a row of its own
// (supabase/015_task_mirrors.sql and 016_mirror_into_tasks.sql). It's one task wherever
// it's opened. A subtask is wherever its task is. A mirror whose task has just been deleted
// here is left out until the board's next read drops it.
const mirrorsOf = (task) => ((task.parent_id ? findTask(task.parent_id)?.mirrors : task.mirrors) || []).filter((m) => !m.task_id || findTask(m.task_id));
const projectsOf = (task) => [task.project_id, ...mirrorsOf(task).map((m) => m.project_id)];
// Whether a task has anything to do with a project: it lives there, or is mirrored somewhere in it.
const isIn = (task, projectId) => projectsOf(task).includes(projectId);
// Whether it's a row of that project's own list, and where in it.
const listMirror = (task, projectId) => task.mirrors?.find((m) => m.project_id === projectId && !m.task_id);
const isListedIn = (task, projectId) => task.project_id === projectId || !!listMirror(task, projectId);
const placeIn = (task, projectId) => (task.project_id === projectId ? task.position : listMirror(task, projectId)?.position ?? task.position);
const tasksIn = (projectId) => state.tasks.filter((t) => !t.parent_id && isListedIn(t, projectId)).sort((a, b) => placeIn(a, projectId) - placeIn(b, projectId));
// The tasks mirrored into a task, in the order they were put there.
function heldBy(taskId) {
  const place = (t) => t.mirrors.find((m) => m.task_id === taskId).position;
  return state.tasks.filter((t) => t.mirrors?.some((m) => m.task_id === taskId)).sort((a, b) => place(a) - place(b));
}
// Where a mirror puts its task, in a few words.
const mirrorPlace = (m) => (m.task_id ? `${findTask(m.task_id)?.title} (${findProject(m.project_id)?.name})` : findProject(m.project_id)?.name);
// What a row says about a mirrored task, seen from one of the lists it's in.
function mirrorNote(task, projectId) {
  if (task.project_id !== projectId) return findProject(task.project_id) ? `Mirrored from ${findProject(task.project_id).name}` : "";
  const others = mirrorsOf(task).map(mirrorPlace).filter(Boolean);
  return others.length ? `Also in ${others.join(", ")}` : "";
}

// The columns a project added for itself.
const ownColumns = (projectId) => findProject(projectId)?.columns?.custom || [];
// And those of every project a task is in, the one it lives in first, each column once.
function ownColumnsOf(task) {
  const seen = new Set();
  return projectsOf(task).flatMap(ownColumns).filter((f) => !seen.has(f.id) && seen.add(f.id));
}
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
  // Puts a file in the folder the server function issues for the task, and says where.
  async function putFile(taskId, file) {
    const { path, upload_url: uploadUrl } = await fileService("upload", { task_id: taskId });
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { apikey: supabaseKey, "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
      body: file,
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return path;
  }
  return {
    isDemo: false,
    setToken(value) { token = value; },
    enter: (pin, name, remember) => rpc("movers_enter_board", { p_pin: pin, p_name: name, p_remember: remember === true }),
    list: (version) => rpc("movers_list_tasks", { p_token: token, p_version: version }),
    // Sends only the fields that changed, so two people editing different
    // fields of the same task don't overwrite each other.
    save: (id, fields) => rpc("movers_save_task", { p_token: token, p_id: id, p_fields: fields }),
    // A mirrored task has a place in each project's list, so this says which list it was moved in.
    move: (id, position, projectId = null) => rpc("movers_move_task", { p_token: token, p_id: id, p_position: position, p_project: projectId }),
    // Everywhere a task is mirrored, as the whole list: {task_id} for inside a task, {project_id} for a project's list.
    mirrorTask: (id, targets) => rpc("movers_mirror_task", { p_token: token, p_id: id, p_targets: targets }),
    // `images` are the uploads to post with it, as uploadImage gave them.
    addUpdate: (id, text, mentions, images) => rpc("movers_add_task_update", { p_token: token, p_id: id, p_text: text, p_mentions: mentions || [], p_images: images || [] }),
    addComment: (taskId, body, mentions, images) => rpc("movers_add_task_comment", { p_token: token, p_task_id: taskId, p_body: body, p_mentions: mentions || [], p_images: images || [] }),
    editUpdate: (taskId, at, text, mentions) => rpc("movers_edit_task_update", { p_token: token, p_task_id: taskId, p_at: at, p_text: text, p_mentions: mentions || [] }),
    deleteUpdate: (taskId, at) => rpc("movers_delete_task_update", { p_token: token, p_task_id: taskId, p_at: at }),
    editComment: (id, body, mentions) => rpc("movers_edit_task_comment", { p_token: token, p_id: id, p_body: body, p_mentions: mentions || [] }),
    deleteComment: (id) => rpc("movers_delete_task_comment", { p_token: token, p_id: id }),
    setReminder: (taskId, remindAt, note) => rpc("movers_set_reminder", { p_token: token, p_task_id: taskId, p_remind_at: remindAt, p_note: note }),
    clearReminder: (taskId) => rpc("movers_clear_reminder", { p_token: token, p_task_id: taskId }),
    likeUpdate: (taskId, at, on) => rpc("movers_like_update", { p_token: token, p_task_id: taskId, p_at: at, p_on: on }),
    setFocus: (taskId, on) => rpc("movers_set_focus", { p_token: token, p_task_id: taskId, p_on: on }),
    taskHistory: (taskId) => rpc("movers_task_history", { p_token: token, p_task_id: taskId }),
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
    completeMeeting: (id, done) => rpc("movers_complete_meeting", { p_token: token, p_id: id, p_done: done }),
    addMeetingNote: (meetingId, body) => rpc("movers_add_meeting_note", { p_token: token, p_meeting_id: meetingId, p_body: body }),
    editMeetingNote: (id, body) => rpc("movers_edit_meeting_note", { p_token: token, p_id: id, p_body: body }),
    deleteMeetingNote: (id) => rpc("movers_delete_meeting_note", { p_token: token, p_id: id }),
    rescheduleMeeting: (id, startsAt, endsAt, reason, askAgain) => rpc("movers_reschedule_meeting", {
      p_token: token, p_id: id, p_starts_at: startsAt, p_ends_at: endsAt, p_reason: reason, p_ask_again: askAgain,
    }),
    async uploadFile(taskId, file) {
      const path = await putFile(taskId, file);
      await rpc("movers_add_file", { p_token: token, p_task_id: taskId, p_path: path, p_name: file.name });
    },
    // Uploads an image pasted into an update or a comment, to be posted with it. The board
    // keeps it once that's posted.
    uploadImage: async (taskId, file) => ({ path: await putFile(taskId, file), name: file.name }),
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
  state.reminders = [];
  state.focus = [];
  state.focusNote = null;
  state.personColors = new Map();
  state.personColorsFor = "";
  state.version = -1;
  state.store.setToken(null);
  $("task-rows").replaceChildren();
  $("week-grid").replaceChildren();
  delete $("week-grid").dataset.sig;
  delete $("week-grid").dataset.week;
  $("my-meetings").replaceChildren();
  delete $("my-meetings").dataset.sig;
  $("calendar-count").hidden = true;
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
// reminder is waiting to go out. Or the time has come for a reminder this person set for
// themselves.
const reminderIsDue = () => state.meetings.some((m) => {
  const start = nextOccurrence(m).getTime();
  return start > Date.now() && start - HOUR_MS <= Date.now() && state.lastRoll < start - HOUR_MS;
}) || (state.reminders || []).some((r) => {
  const at = Date.parse(r.remind_at);
  return at <= Date.now() && state.lastRoll < at;
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
  // Coming to the Calendar from another page shows the week, whatever it showed last.
  if (calendar && $("calendar-view").hidden) state.calendarView = "week";
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
  const tasks = tasksIn(id);
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
  // Deleting is offered to whoever created the project. Everyone else is told who that is.
  const mine = canDelete(project);
  $("delete-project-btn").hidden = !mine;
  $("delete-project-note").hidden = mine;
  $("delete-project-note").textContent = mine ? "" : deleteNote(project, "project");
}

// Only whoever created a task or a project can delete it, and the board refuses anyone
// else. Names are compared as the board compares them: capitals and the spaces around them
// don't matter. A board that doesn't say yet who created a project decides for itself.
const canDelete = (item) => item?.created_by === undefined || personKey(item.created_by) === personKey(state.name);
const deleteNote = (item, what) => (personKey(item.created_by) === personKey(BOARD_ACTOR)
  ? `This ${what} came with the board, so it can't be deleted.`
  : `Only ${item.created_by}, who created this ${what}, can delete it.`);
const refusedDelete = (result) => result.error?.code === "not_creator";

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
  // The tasks that live here go with the project, except the ones mirrored into another
  // project, which move there. Tasks mirrored in from elsewhere just stop showing here.
  const living = state.tasks.filter((t) => t.project_id === id && !t.parent_id);
  const elsewhere = (t) => (t.mirrors || []).filter((m) => m.project_id !== id);
  const moving = new Set(living.filter((t) => elsewhere(t).length).map((t) => t.id));
  const count = living.length - moving.size;
  const plural = (n, word) => (n === 1 ? `1 ${word}` : `${n} ${word}s`);
  const warning = [
    count ? `Delete it and its ${plural(count, "task")} for everyone?` : living.length ? "Delete this project?" : "Delete this empty project?",
    moving.size ? `${plural(moving.size, "mirrored task")} ${moving.size === 1 ? "moves" : "move"} to another project.` : "",
  ].filter(Boolean).join(" ");
  if (!armButton(button, warning, "Delete project")) return;
  button.disabled = true;
  const stays = (t) => moving.has(t.parent_id || t.id);
  const going = state.tasks.filter((t) => t.project_id === id && !stays(t)).map((t) => state.windows.get(t.id)).filter(Boolean);
  going.forEach((w) => { w.deleting = true; });
  state.leavingProject = id;
  const result = await write(() => state.store.removeProject(id), null);
  button.disabled = false;
  button.classList.remove("armed");
  button.textContent = "Delete project";
  if (result.ok) {
    going.forEach(closeWindow);
    state.projects = state.projects.filter((p) => p.id !== id);
    // What the board just did, done here too so nothing flickers before the next read.
    // That read may already have arrived, in which case these have moved and there's nothing to do.
    for (const task of state.tasks.filter((t) => moving.has(t.id) && t.project_id === id && elsewhere(t).length)) {
      const first = elsewhere(task)[0];
      subtasksOf(task.id).forEach((s) => { s.project_id = first.project_id; });
      // It lives there now. If it got there through a task, it stays in that task as well.
      Object.assign(task, { project_id: first.project_id, position: first.position, mirrors: task.mirrors.filter((m) => m.project_id !== first.project_id || m.task_id) });
    }
    state.tasks = state.tasks.filter((t) => t.project_id !== id);
    state.tasks.forEach((t) => { if (t.mirrors) t.mirrors = t.mirrors.filter((m) => m.project_id !== id && (!m.task_id || findTask(m.task_id))); });
    location.hash = "";
    state.store.cleanFiles().catch(() => { /* retried by the next removal */ });
  } else {
    state.leavingProject = null;
    going.forEach((w) => { w.deleting = false; });
    showProjectError("project-error", refusedDelete(result) ? "Only whoever created this project can delete it." : "That project wasn't deleted. Check your connection and try again.");
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
  const field = task && ownColumnsOf(task).find((f) => f.id === control.dataset.custom);
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

// A task's subtasks, and the tasks mirrored into it, which count as part of it.
function subtaskSummary(task) {
  const subtasks = [...subtasksOf(task.id), ...heldBy(task.id)];
  if (!subtasks.length) return "";
  return ` · ${subtasks.filter((s) => s.status === "done").length}/${subtasks.length} subtasks`;
}

function rowSignature(task) {
  return JSON.stringify([
    task.title, task.assignees, task.urgency, task.deadline, task.repeat, task.status, task.progress,
    task.updated_by, timeAgo(task.updated_at), deadlineNote(task)?.text, subtaskSummary(task),
    task.custom, state.columnsSig, mirrorNote(task, state.projectId), focusNames(task.id),
  ]);
}

function rowPicker(task) {
  const picker = namePicker({
    label: `Who ${task.title} is assigned to`,
    names: task.assignees,
    placeholder: "+",
    title: "Assign someone",
    boxClass: "cell-input assign-input",
    roles: "compact",
    onChange(names, cause) {
      // Saving redraws the row, which would otherwise lose the cursor. After a new main the
      // cursor stays on the names, rather than opening the box for typing one.
      const keepCursor = picker.root.contains(document.activeElement);
      updateTask(task.id, { assignees: names });
      if (keepCursor) $("task-rows").querySelector(`[data-id="${CSS.escape(task.id)}"] ${cause === "main" ? "[data-make-main]" : ".name-box"}`)?.focus();
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

// A row of the list that's showing. A mirrored task gets the columns of the project it's
// being looked at in, which may not be the one it lives in.
function renderRow(task) {
  const mirrored = mirrorNote(task, state.projectId);
  const cells = shownColumns(state.projectId).map((column) => {
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
        el("div", { class: "task-meta" }, `${task.updated_by} · ${timeAgo(task.updated_at)}${subtaskSummary(task)}${repeats(task) ? ` · Repeats ${task.repeat}` : ""}${mirrored ? ` · ${mirrored}` : ""}`,
          // Whose focus task it is, which everyone sees.
          focusNames(task.id).length > 0 && el("span", { class: "task-focus" }, ` · ★ Focus: ${focusNames(task.id).join(", ")}`))),
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
  const open = state.tasks.filter((t) => !t.parent_id && t.status !== "done" && (!state.projectId || isListedIn(t, state.projectId)));
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
  const inProject = tasksIn(state.projectId);
  // Under a filter, the tasks that show only because they were just added.
  const outside = new Set(state.filter.length ? inProject.filter((t) => !matchesFilter(t, state.filter)).map((t) => t.id) : []);
  const tasks = inProject.filter((t) => !outside.has(t.id) || state.keepShown.has(t.id));
  renderFilter(inProject);
  renderFilterNote(inProject.length, tasks.length, tasks.filter((t) => outside.has(t.id)).length);
  list.classList.toggle("is-filtered", state.filter.length > 0);
  // Another project's list starts from nothing. A mirrored task is in both, and its row in
  // the last one has that project's columns, even if it's the row that was being edited.
  if (list.dataset.project !== String(state.projectId)) {
    list.dataset.project = String(state.projectId);
    list.replaceChildren();
    showQuickError(null); // a name refused in the last project says nothing about this one
  }
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
    row.classList.toggle("is-outside-filter", outside.has(task.id));
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus();
}

// Says so whenever the filter is hiding tasks in this project. The filter is remembered
// from one visit to the next and applies in every project, so a list with tasks missing
// otherwise looks as if they were never saved. A task that was just added and doesn't
// match stays in view for now, and this warns that it won't after a reload.
function renderFilterNote(total, shown, kept) {
  const hidden = total - shown;
  const note = $("filter-note");
  note.hidden = !state.filter.length || (!hidden && !kept);
  if (note.hidden) return;
  const who = $("filter-btn").textContent.replace(/^Assigned to: /, "");
  const parts = [hidden
    ? `Showing ${shown} of ${total} ${total === 1 ? "task" : "tasks"}: ${hidden === 1 ? "1 is" : `${hidden} are`} hidden because this list is filtered to ${who}.`
    : `This list is filtered to ${who}.`];
  if (kept) parts.push(`${kept === 1 ? "1 task you just added doesn't" : `${kept} tasks you just added don't`} match the filter, and will be hidden when the page reloads.`);
  $("filter-note-text").textContent = parts.join(" ");
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
  renderCalendarCount();
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
  // A new name can't be one another task here already has, and a task can't move to a
  // project that has a task of its name. What was typed or chosen goes back as it was.
  const renamed = "title" in changes && titleKey(changes.title) !== titleKey(task.title);
  const moved = "project_id" in changes && changes.project_id !== task.project_id && !task.parent_id;
  const clash = (renamed || moved) && taskNamed(changes.title ?? task.title, { projectId: changes.project_id ?? task.project_id, parentId: task.parent_id, except: id });
  if (clash) {
    const there = state.projects.find((p) => p.id === changes.project_id)?.name;
    const message = moved
      ? `There's already a task called “${clash.title}” in ${there}. Rename one of them before moving this one.`
      : nameTakenMessage(clash, task.parent_id);
    const w = state.windows.get(id);
    if (w) {
      showWindowError(w, message);
      w.body.querySelector('[data-field="title"]').value = task.title;
      const project = w.body.querySelector('[data-field="project_id"]');
      if (project) project.value = task.project_id;
    } else {
      showSyncNote(message);
    }
    refreshRow(id);
    return;
  }
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
  if ("project_id" in plainDiff) {
    // Moved to a project whose list it was mirrored into: it lives there now, and isn't in
    // that list by a mirror as well. Tasks mirrored into this one go where it goes.
    task.mirrors = (task.mirrors || []).filter((m) => m.project_id !== task.project_id || m.task_id);
    subtasksOf(id).forEach((s) => { s.project_id = task.project_id; });
    heldBy(id).forEach((held) => held.mirrors.forEach((m) => { if (m.task_id === id) m.project_id = task.project_id; }));
  }
  task.custom = Object.fromEntries(Object.entries({ ...task.custom, ...own }).filter(([, value]) => String(value ?? "") !== ""));
  refreshRow(id, focusField);
  renderSummary();
  renderWindows();
  const saved = await write(() => state.store.save(id, diff), null);
  if (!saved.ok && saved.error) {
    showSyncNote(saved.error.code === "duplicate_title"
      ? "There's already a task with that name there, so the change has been undone."
      : "That change didn't save, so it has been undone. Check your connection and try again.");
  }
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
$("filter-note-clear").addEventListener("click", () => {
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

  // A mirrored task has its own place in each project's list, so this is the place in the
  // list that's showing, and moving it here leaves it where it was everywhere else.
  const projectId = state.projectId;
  const placed = (taskId) => { const other = findTask(taskId); return other && { position: placeIn(other, projectId) }; };
  const order = [...rows.children].map((row) => row.dataset.id);
  const index = order.indexOf(id);
  const position = positionBetween(placed(order[index - 1]), placed(order[index + 1]));

  const mirror = task.project_id === projectId ? null : listMirror(task, projectId);
  if (mirror) mirror.position = position;
  else task.position = position;
  await write(() => state.store.move(id, position, projectId), "That move didn't save, so the row has gone back. Check your connection and try again.");
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

// ---------- One name, one task ----------

// A name as it's compared: without regard to capitals, or to spaces at the ends or doubled.
const titleKey = (title) => String(title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const NAME_TAKEN = "There's already a task with that name here. Give this one a different name.";

// The task that already has this name where a task would sit: in a project's list, with
// the tasks mirrored into it, or for a subtask among what its task holds. Two tasks in one
// project can't share a name, and the board refuses it too when it saves.
function taskNamed(title, { projectId = null, parentId = null, except = null }) {
  const key = titleKey(title);
  if (!key) return null;
  const beside = parentId ? [...subtasksOf(parentId), ...heldBy(parentId)] : tasksIn(projectId);
  return beside.find((t) => t.id !== except && titleKey(t.title) === key) ?? null;
}

// Why a name can't be used, in words. When the task that has it is hidden by the filter,
// it says so, since otherwise the name looks free.
function nameTakenMessage(other, parentId = null) {
  if (parentId) return `This task already has a subtask called “${other.title}”. Give this one a different name.`;
  const hidden = state.filter.length > 0 && !matchesFilter(other, state.filter) && !state.keepShown.has(other.id);
  return `There's already a task called “${other.title}” in this project.${hidden ? " It's hidden by the Assigned to filter." : ""} Give this one a different name.`;
}

// The message beside the box at the bottom of the list, in place of its hint.
function showQuickError(message) {
  $("quick-error").textContent = message || "";
  $("quick-error").hidden = !message;
  $("quick-hint-text").hidden = !!message;
}
$("quick-title").addEventListener("input", () => showQuickError(null));

$("quick-add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("quick-title").value.trim();
  if (!title) return $("quick-title").focus();
  const clash = taskNamed(title, { projectId: state.projectId });
  if (clash) {
    showQuickError(nameTakenMessage(clash));
    return $("quick-title").focus();
  }
  showQuickError(null);
  $("quick-submit").disabled = true;
  const added = await write(() => state.store.save(null, { title, project_id: state.projectId }), null);
  $("quick-submit").disabled = false;
  if (added.ok) {
    $("quick-title").value = "";
    keepInView(added.result.id);
  } else if (added.error?.code === "duplicate_title") {
    showQuickError(NAME_TAKEN);
  } else if (added.error) {
    showSyncNote("That task didn't save. Check your connection and try again.");
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
        state.reminders = result.reminders || [];
        state.focus = result.focus || [];
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

  // The first free place in the cascade, so a window opened with none open is always in
  // the same spot, and two open at once don't sit exactly on top of each other.
  const taken = new Set([...state.windows.values()].map((open) => open.step));
  let step = 0;
  while (taken.has(step) && step < 5) step += 1;
  const w = {
    key, root, body, titleEl, chip: null, step,
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
  // Whether anyone has done anything in it, for a form that isn't saved until it's sent.
  const touched = () => { w.dirty = true; };
  root.addEventListener("input", touched);
  root.addEventListener("change", touched);
  root.addEventListener("click", (event) => { if (event.target.closest(".win-body button:not([type='submit'])")) touched(); });
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

// Something typed into a window that closing it would throw away: a form that's been
// touched, or text in one of a task's add boxes that hasn't been sent.
function hasUnsentTyping(w) {
  if (w.body.tagName === "FORM") return !!w.dirty;
  return [...w.body.querySelectorAll("[data-input], [data-assign-input]")].some((input) => input.value.trim());
}

// On a desktop, pressing anywhere outside the open windows closes them, as clicking away
// from a dialog does. Nothing typed is lost: a field of the task that was being edited is
// saved first, and a window holding something unsent stays open. Minimized windows stay in
// the tray. A phone shows a window as a page of its own, with nothing outside it to press.
document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || isPhone() || !state.windows.size) return;
  if (event.target.closest?.(".win, #window-tray")) return;
  // The page's own scrollbars aren't part of the page.
  if (event.clientX >= document.documentElement.clientWidth || event.clientY >= document.documentElement.clientHeight) return;
  const editing = document.activeElement;
  if (editing?.closest?.(".win")) editing.blur(); // leaving a field is what saves it
  for (const w of [...state.windows.values()]) {
    if (!w.root.hidden && !hasUnsentTyping(w)) closeWindow(w);
  }
}, true);

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

// The people on a task: the first is its main assignee, and the others support them.
const mainAssignee = (task) => task?.assignees?.[0] ?? null;
// "Alex (main), Sam, Jo", or just the name of someone on it alone.
const assigneeText = (task) => (task.assignees.length > 1
  ? `${task.assignees[0]} (main), ${task.assignees.slice(1).join(", ")}`
  : task.assignees.join(", "));
// What one person is on a task that several people are on, for a list of their work.
function roleOn(task, key) {
  if (!key || task.assignees.length < 2 || !task.assignees.some((name) => personKey(name) === key)) return null;
  return personKey(mainAssignee(task)) === key ? "Main" : `Supporting ${mainAssignee(task)}`;
}

// Names as removable tags, with a box to add more. Enter, a comma, clicking away or picking
// a suggestion adds what's typed, and names separated by commas add together.
// With roles, the first name is the main assignee and clicking another name puts that person
// first. "full" says so in words, for a task's own window. "compact" is a star, and only
// once there's someone to tell the main apart from, for a row of the task list.
function namePicker({ label, names = [], placeholder = "Add a name", title = null, boxClass = "input", skip = null, onChange = null, roles = null }) {
  let current = [...names];
  const tags = el("ul", { class: "name-tags" });
  const box = textInput({ class: `${boxClass} name-box`, maxlength: "200", list: "people-list", placeholder, title, "aria-label": label });
  const hint = roles === "full" && el("p", { class: "hint name-roles-hint", "data-roles-hint": true, hidden: true },
    "★ is the main assignee, and the others support them. Click a name to make that person the main.");
  const render = () => {
    tags.replaceChildren(...current.map((name, i) => {
      const main = !!roles && i === 0 && (roles === "full" || current.length > 1);
      return el("li", { class: `name-tag${main ? " is-main" : ""}`, style: personColorStyle(personColor(name)), "data-person": name },
        main && el("span", { class: "name-tag-star", "aria-hidden": "true", title: "Main assignee" }, "★"),
        roles && i > 0
          ? el("button", { class: "name-tag-name", type: "button", "data-make-main": name, title: `Make ${name} the main assignee`, "aria-label": `${name}, supporting. Make ${name} the main assignee` }, name)
          : name,
        main && (roles === "full"
          ? el("span", { class: "name-tag-role" }, "Main")
          : el("span", { class: "visually-hidden" }, " (main assignee)")),
        el("button", { class: "name-tag-x", type: "button", "aria-label": `Remove ${name}`, "data-name": name }, "×"));
    }));
    if (hint) hint.hidden = current.length < 2;
  };
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
    // Clicking someone supporting puts them first, which makes them the main assignee.
    const promote = event.target.closest("[data-make-main]");
    if (promote) {
      const name = promote.dataset.makeMain;
      current = [name, ...current.filter((other) => other !== name)];
      render();
      tags.querySelector("[data-make-main]")?.focus();
      return onChange?.([...current], "main");
    }
    const remove = event.target.closest("[data-name]");
    if (!remove) return;
    current = current.filter((name) => name !== remove.dataset.name);
    render();
    box.focus();
    onChange?.([...current]);
  });
  render();
  return {
    root: el("div", { class: "name-picker" }, tags, box, hint),
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

// One task for a meeting. The project comes first, which lists that project's tasks, and
// typing narrows the list. Once picked, the task shows as a tag that can be taken off
// again. Meetings are set for tasks, so subtasks aren't offered: one linked to a subtask
// earlier keeps showing it until it's changed.
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
    return tasksInOrder().filter((t) => !t.parent_id && (everywhere() || isIn(t, project.value)) && t.title.toLowerCase().includes(typed));
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
    // Called "Goal" on the page. The board keeps it under its first name, "details".
    field("Goal", el("textarea", { class: "input", rows: "2", maxlength: "4000", "data-field": "details" })),
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

// Where a task is mirrored, in its window: a pill for each place, and a way to add one by
// choosing the project and then the task in it that should hold this one. It keeps what's
// typed while the board refreshes behind it, and only redraws what has changed.
function mirrorPicker(taskId) {
  let adding = false;
  let projectId = null; // the project chosen so far
  const pills = el("ul", { class: "name-tags mirror-tags", "data-list": "mirrors" });
  const open = el("button", { class: "mirror-add", type: "button", "data-mirror-open": true }, "+ Mirror to a task");
  const prompt = el("p", { class: "mirror-prompt" });
  const projects = el("ul", { class: "name-tags mirror-projects" });
  const search = textInput({ maxlength: "200", placeholder: "Type to narrow the list", "aria-label": "Search the project's tasks", "data-mirror-search": true });
  const options = el("ul", { class: "task-options" });
  const cancel = el("button", { class: "link-btn", type: "button", "data-mirror-cancel": true }, "Cancel");
  const panel = el("div", { class: "mirror-picker", "data-mirror-picker": true, hidden: true }, prompt, projects, search, options, cancel);
  const root = el("div", { class: "field", "data-mirrors": true },
    el("span", { class: "label" }, "Mirrored to"),
    pills, open, panel,
    el("p", { class: "hint" }, "A mirrored task is one task. It shows inside the task it's mirrored to, and a change made from either place shows in both."));

  const places = () => mirrorsOf(findTask(taskId) || {});
  const targetOf = (m) => (m.task_id ? { task_id: m.task_id } : { project_id: m.project_id });
  const inOrder = () => [...state.projects].sort((a, b) => a.position - b.position);
  // The tasks of the chosen project that could hold this one: whole tasks that live there,
  // other than itself and the ones that hold it already.
  function holders() {
    const typed = search.value.trim().toLowerCase();
    const holding = new Set(places().map((m) => m.task_id));
    return state.tasks.filter((t) => t.project_id === projectId && !t.parent_id && t.id !== taskId && !holding.has(t.id) && t.title.toLowerCase().includes(typed))
      .sort((a, b) => a.position - b.position);
  }
  // A project's own list can take it too, unless it lives there or is in that list already.
  const listOffered = () => projectId !== findTask(taskId)?.project_id && !places().some((m) => m.project_id === projectId && !m.task_id);

  function render() {
    const task = findTask(taskId);
    if (!task) return;
    if (projectId && !findProject(projectId)) projectId = null; // the project was deleted meanwhile
    const shown = places().map((m) => [m.project_id, m.task_id, findProject(m.project_id)?.name, findTask(m.task_id)?.title]);
    const choice = !adding ? null : !projectId
      ? inOrder().map((p) => [p.id, p.name])
      : [projectId, findProject(projectId).name, listOffered(), holders().map((t) => [t.id, t.title, t.status]), search.value.trim() !== ""];
    const signature = JSON.stringify([shown, adding, choice]);
    if (root.dataset.sig === signature) return;
    root.dataset.sig = signature;

    pills.replaceChildren(...shown.map(([project, holder, projectName, title], i) => el("li", { class: "name-tag mirror-tag", "data-mirror": holder || project },
      el("span", {}, `${projectName} › ${holder ? title : "task list"}`),
      el("button", { class: "name-tag-x", type: "button", "aria-label": `Stop mirroring to ${holder ? title : projectName}`, "data-unmirror": i }, "×"))));
    open.hidden = adding;
    panel.hidden = !adding;
    if (!adding) return;
    const choosing = !projectId;
    prompt.textContent = choosing ? "Choose the project" : "Now choose the task to mirror it to";
    search.hidden = choosing;
    options.hidden = choosing;
    projects.replaceChildren(...(choosing
      ? inOrder().map((p) => el("li", {}, el("button", { class: "name-tag mirror-tag mirror-choice", type: "button", "data-mirror-project": p.id }, p.name)))
      : [el("li", {}, el("button", { class: "name-tag mirror-tag is-chosen", type: "button", "data-mirror-back": true, "aria-label": `${findProject(projectId).name}. Choose another project` },
        el("span", {}, findProject(projectId).name), el("span", { class: "name-tag-x", "aria-hidden": "true" }, "×")))]));
    if (choosing) return;
    const found = holders();
    options.replaceChildren(...[
      ...found.map((t) => el("li", {}, el("button", { class: "task-option", type: "button", "data-mirror-task": t.id }, t.title, el("span", { class: "win-meta" }, STATUS[t.status])))),
      !found.length && el("li", { class: "task-options-note" }, search.value.trim() ? "No task matches that." : "No tasks in this project to mirror it to."),
      listOffered() && el("li", {}, el("button", { class: "task-option mirror-list-option", type: "button", "data-mirror-list": projectId },
        "Not in a task", el("span", { class: "win-meta" }, "Show it as a row of this project's task list"))),
    ].filter(Boolean));
  }

  function close() {
    adding = false;
    projectId = null;
    search.value = "";
    render();
  }

  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault(); // Enter here picks the first task
    options.querySelector("[data-mirror-task]")?.click();
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    const pick = (selector) => target.closest(selector);
    if (pick("[data-mirror-open]")) {
      adding = true;
      render();
    } else if (pick("[data-mirror-cancel]")) {
      close();
    } else if (pick("[data-mirror-project]")) {
      projectId = pick("[data-mirror-project]").dataset.mirrorProject;
      render();
      search.focus();
    } else if (pick("[data-mirror-back]")) {
      projectId = null;
      search.value = "";
      render();
    } else if (pick("[data-mirror-task]") || pick("[data-mirror-list]")) {
      const added = pick("[data-mirror-task]") ? { task_id: pick("[data-mirror-task]").dataset.mirrorTask } : { project_id: pick("[data-mirror-list]").dataset.mirrorList };
      const next = [...places().map(targetOf), added];
      close();
      setMirrors(taskId, next);
    } else if (pick("[data-unmirror]")) {
      const index = Number(pick("[data-unmirror]").dataset.unmirror);
      setMirrors(taskId, places().filter((_, i) => i !== index).map(targetOf));
    }
  });
  render();
  return { root, render };
}

// Sets everywhere a task is mirrored, as the whole list, here first and then on the board.
async function setMirrors(taskId, targets) {
  const task = findTask(taskId);
  if (!task) return;
  const before = task.mirrors || [];
  const last = Math.max(0, ...state.tasks.flatMap((t) => [t.position, ...(t.mirrors || []).map((m) => m.position)]));
  task.mirrors = targets.map((target, i) => before.find((m) => (target.task_id ? m.task_id === target.task_id : !m.task_id && m.project_id === target.project_id))
    || { project_id: target.task_id ? findTask(target.task_id)?.project_id : target.project_id, task_id: target.task_id || null, position: last + 1000 * (i + 1) });
  renderBoard();
  const saved = await write(() => state.store.mirrorTask(taskId, targets), "That didn't save, so it has been undone. Check your connection and try again.");
  const now = findTask(taskId);
  if (!now) return;
  now.mirrors = saved.ok ? saved.result.mirrors : before;
  renderBoard();
}

// The project's own columns in a task's window. Rebuilt when the project's setup changes,
// and otherwise kept up to date, leaving alone whatever is being typed in.
function renderOwnFields(w, task) {
  const box = w.body.querySelector("[data-custom-fields]");
  const fields = ownColumnsOf(task); // a mirrored task has the columns of every project it's in
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

// A task's window is its name and goal, then sections that fold away. Which ones start
// open is the same for every task: as this person last left them on this device, and
// before that, the parts worked on most (subtasks and updates) open and the rest folded.
const FOLDS_KEY = "board.taskFolds";
const FOLD_DEFAULTS = { info: false, subtasks: true, updates: true, comments: true, meetings: false, files: false, history: false };

function foldStates() {
  try {
    return { ...FOLD_DEFAULTS, ...JSON.parse(readStorage("localStorage", FOLDS_KEY) || "{}") };
  } catch {
    return { ...FOLD_DEFAULTS };
  }
}

function taskFold(name, heading, ...children) {
  return el("details", { class: `win-fold${name === "updates" ? " win-updates" : ""}`, "data-fold": name, open: foldStates()[name] === true },
    el("summary", { class: "win-heading" }, ...heading),
    el("div", { class: "win-fold-body" }, ...children));
}

// ---------- A reminder someone sets for themselves on a subtask ----------

// A small drawn icon. It's made here rather than written into the page, since rows are.
function icon(paths, size = 16) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const attrs = { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
const CALENDAR_ICON = ["M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M4 10h16", "M8 3v4", "M16 3v4"];

// ---------- Acknowledging an update ----------
// The page calls it acknowledging. Underneath, here and on the board, it's kept as a like.

const LIKE_ICON = ["M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z", "M7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7a2 2 0 0 1-2 1.7H7"];

// An update is known by the moment it was posted, to the microsecond, which is finer than a
// Date keeps. This turns either spelling of that moment into the same key.
const stampKey = (iso) => {
  const text = String(iso || "");
  return `${Math.floor(Date.parse(text) / 1000)}.${(text.match(/\.(\d+)/)?.[1] || "").padEnd(6, "0").slice(0, 6)}`;
};
// The people who like an update, in the order they liked it.
const likesOf = (task, entry) => (task.likes || []).filter((l) => stampKey(l.at) === stampKey(entry.at)).map((l) => l.by);

// "you and Alex", "Alex, Jo and Sam": this person first.
function nameList(names) {
  const me = personKey(state.name);
  const said = [...names.filter((n) => personKey(n) === me).map(() => "you"), ...names.filter((n) => personKey(n) !== me)];
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0] || "";
}

// Under an update: an Acknowledge button on someone else's, with who has acknowledged it so
// far. Your own has no button, only who has.
function likeRow(task, entry) {
  const names = likesOf(task, entry);
  if (personKey(entry.by) === personKey(state.name)) {
    return names.length ? el("span", { class: "like-row" }, el("span", { class: "like-note", "data-liked-by": true }, `Acknowledged by ${nameList(names)}`)) : null;
  }
  const mine = names.some((n) => personKey(n) === personKey(state.name));
  return el("span", { class: "like-row" },
    el("button", {
      class: `like-btn${mine ? " is-liked" : ""}`,
      type: "button",
      "data-like": entry.at,
      "aria-pressed": String(mine),
      "aria-label": mine ? `You acknowledged ${entry.by}'s update. Press to take it back` : `Acknowledge ${entry.by}'s update`,
    }, icon(LIKE_ICON, 15), mine ? "Acknowledged" : "Acknowledge", names.length > 0 && el("span", { class: "like-count" }, String(names.length))),
    names.length > 0 && el("span", { class: "like-note", "data-liked-by": true }, capitalize(nameList(names))));
}

// Likes an update, or takes the like back. It shows at once, and the board's answer follows:
// if it didn't save, the next read puts it back as it was.
async function likeUpdate(w, button) {
  const at = button.dataset.like;
  const on = button.getAttribute("aria-pressed") !== "true";
  const task = findTask(w.taskId);
  if (!task) return;
  const mine = (l) => stampKey(l.at) === stampKey(at) && personKey(l.by) === personKey(state.name);
  task.likes = [...(task.likes || []).filter((l) => !mine(l)), ...(on ? [{ at, by: state.name }] : [])];
  renderTaskWindow(w);
  // The list was redrawn, so the keyboard goes back to the button it was on.
  [...w.body.querySelectorAll("[data-like]")].find((b) => b.dataset.like === at)?.focus();
  const result = await write(() => state.store.likeUpdate(w.taskId, at, on), null);
  if (w.root.isConnected) showWindowError(w, result.ok ? null : "That didn't save. Check your connection and try again.");
}

// Each person has their own reminders, and sees only those. One per subtask.
const myReminder = (taskId) => (state.reminders || []).find((r) => r.task_id === taskId);
const reminderWhen = (reminder) => `${formatDay(new Date(reminder.remind_at))}, ${formatTime(new Date(reminder.remind_at))}`;

// The calendar icon on a subtask's row. It's lit while this person has a reminder waiting.
function reminderButton(task) {
  const mine = myReminder(task.id);
  return el("button", {
    class: `remind-btn${mine ? " is-set" : ""}`,
    type: "button",
    "data-remind": task.id,
    title: mine ? `Your reminder: ${reminderWhen(mine)}. Press to change it` : "Remind me about this",
    "aria-label": mine ? `Your reminder for ${task.title}, set for ${reminderWhen(mine)}. Press to change it` : `Remind me about ${task.title}`,
  }, icon(CALENDAR_ICON));
}

// The small window for setting one: when, and a note to yourself. Opened again while one
// is waiting, it shows that one, to change or take off.
function openReminder(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  const key = `remind:${taskId}`;
  let w = state.windows.get(key);
  if (!w) {
    w = createWindow(key, "Reminder");
    w.remindFor = taskId;
    w.width = Math.min(w.width, 400);
    w.height = Math.min(w.height, 430);
    placeWindow(w);
    buildReminderForm(w, task);
  }
  showWindow(w);
  w.body.querySelector('[data-input="date"]').focus();
}

function buildReminderForm(w, task) {
  const mine = myReminder(task.id);
  // To begin with: tomorrow morning at nine.
  const start = mine ? new Date(mine.remind_at) : new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1, 9, 0);
  const form = el("form", { class: "win-body", novalidate: true },
    el("p", { class: "remind-for" }, task.parent_id ? "For the subtask " : "For the task ", el("strong", {}, task.title)),
    el("div", { class: "field" },
      el("span", { class: "label" }, "Remind me on:"),
      el("div", { class: "field-row" },
        el("input", { class: "input", type: "date", "aria-label": "Day to be reminded", "data-input": "date" }),
        el("input", { class: "input", type: "time", "aria-label": "Time to be reminded", "data-input": "time" }))),
    field("Note", el("textarea", { class: "input", rows: "3", maxlength: "500", placeholder: "What to remember (optional)", "data-input": "note" })),
    el("p", { class: "hint" }, "You'll get a notification here at that time. Only you see this reminder."),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "win-new-actions" },
      mine && el("button", { class: "btn btn-danger", type: "button", "data-clear-reminder": true }, "Remove reminder"),
      el("button", { class: "btn btn-primary", type: "submit" }, mine ? "Save reminder" : "Set reminder")));
  w.body.replaceWith(form);
  w.body = form;
  const input = (name) => form.querySelector(`[data-input="${name}"]`);
  input("date").value = dayKey(start);
  input("time").value = clockValue(start);
  input("note").value = mine?.note || "";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const [date, time] = [input("date").value, input("time").value];
    if (!date || !time) {
      showWindowError(w, "Choose a date and a time.");
      return input(date ? "time" : "date").focus();
    }
    const when = new Date(`${date}T${time}`);
    if (!(when > new Date())) {
      showWindowError(w, "Choose a time that's still to come.");
      return input("time").focus();
    }
    showWindowError(w, null);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const saved = await write(() => state.store.setReminder(task.id, when.toISOString(), input("note").value.trim()), null);
    button.disabled = false;
    if (!saved.ok) {
      return showWindowError(w, saved.error?.code === "reminder_in_past" ? "Choose a time that's still to come." : "That reminder wasn't set. Check your connection and try again.");
    }
    // Shown at once, rather than when the next read arrives.
    state.reminders = [...state.reminders.filter((r) => r.task_id !== task.id), saved.result];
    closeWindow(w);
    renderWindows();
  });
  form.addEventListener("click", async (event) => {
    const clear = event.target.closest("[data-clear-reminder]");
    if (!clear) return;
    clear.disabled = true;
    const result = await write(() => state.store.clearReminder(task.id), null);
    clear.disabled = false;
    if (!result.ok) return showWindowError(w, "That reminder wasn't removed. Check your connection and try again.");
    state.reminders = state.reminders.filter((r) => r.task_id !== task.id);
    closeWindow(w);
    renderWindows();
  });
}

// ---------- Comments, and mentioning people in them ----------

// Everyone a comment can mention: the people the board knows, each once.
function knownPeople() {
  const names = new Map();
  for (const name of state.people) {
    const key = personKey(name);
    if (key && !names.has(key)) names.set(key, name.trim());
  }
  return [...names.values()];
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// "@all" mentions everyone on the board at once. It's kept among the names an update or a
// comment mentions, as a name is, and the board tells everyone it knows.
const MENTION_ALL = "all";
const isMentionAll = (name) => personKey(name) === MENTION_ALL;

// Where the given names are mentioned in a comment: each "@Name", the longest name that
// fits, and only where the @ starts a word, so an email address isn't a mention.
function mentionSpans(text, names) {
  const lower = text.toLowerCase();
  const byLength = [...names].sort((a, b) => b.length - a.length);
  const spans = [];
  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && (WORD_CHAR.test(text[at - 1]) || text[at - 1] === ".")) continue;
    const name = byLength.find((n) => n && lower.startsWith(n.toLowerCase(), at + 1) && !WORD_CHAR.test(text[at + 1 + n.length] || ""));
    if (!name) continue;
    spans.push({ start: at, end: at + 1 + name.length, name });
    at += name.length;
  }
  return spans;
}

// The people a comment being posted mentions, each once. The board is told, since a name
// can have spaces in it and only the page knows where one ends. "@all" counts as one.
const mentionsIn = (text) => [...new Map(mentionSpans(text, [...knownPeople(), MENTION_ALL]).map((span) => [personKey(span.name), span.name])).values()];

// A comment's words, with the people it mentions standing out, and this person most.
// "@all" is this person too, unless they wrote it.
function commentBody(comment) {
  const parts = [];
  let from = 0;
  const me = personKey(state.name);
  const isMe = (name) => personKey(name) === me || (isMentionAll(name) && personKey(comment.created_by) !== me);
  for (const span of mentionSpans(comment.body, comment.mentions || [])) {
    if (span.start > from) parts.push(comment.body.slice(from, span.start));
    parts.push(el("span", { class: `mention${isMe(span.name) ? " is-me" : ""}` }, comment.body.slice(span.start, span.end)));
    from = span.end;
  }
  if (from < comment.body.length) parts.push(comment.body.slice(from));
  return parts;
}

// The box a comment or an update is written in. Typing @ lists the people on the board,
// narrowed by what follows it: Enter, Tab or a click puts the name in, and Escape puts the
// list away. The list ends with "all", which mentions everyone on the board at once.
// With `cancel` it's for editing what's already posted: it starts with those
// words in it and has a Cancel button, which Escape presses when no list is open. With
// `images` it takes images pasted into it too, to post with the words.
function mentionForm({ name, placeholder, label, button, maxlength, value = "", cancel = false, images = false }) {
  const input = textInput({ maxlength, placeholder, "aria-label": label, autocomplete: "off", "data-input": "text" });
  input.value = value;
  const cancelButton = cancel ? el("button", { class: "btn btn-quiet", type: "button", "data-cancel-edit": true }, "Cancel") : null;
  const list = el("ul", { class: "mention-options", "data-mention-options": true, hidden: true });
  let found = [];
  let active = 0;

  // The @ being typed: the last one before the caret that starts a word, and what follows it.
  const typing = () => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    const at = before.lastIndexOf("@");
    if (at === -1 || (at > 0 && (WORD_CHAR.test(before[at - 1]) || before[at - 1] === "."))) return null;
    const typed = before.slice(at + 1).toLowerCase();
    return typed.length > 40 ? null : { at, typed };
  };
  const render = () => {
    list.hidden = !found.length;
    list.replaceChildren(...found.map((name, i) => el("li", {},
      el("button", { class: `mention-option${i === active ? " is-active" : ""}`, type: "button", tabindex: "-1", "data-mention": name },
        name, name === MENTION_ALL && el("span", { class: "mention-option-hint" }, "Everyone on the board")))));
  };
  const close = () => {
    found = [];
    render();
  };
  const look = () => {
    const now = typing();
    const me = personKey(state.name);
    const others = knownPeople().filter((name) => personKey(name) !== me && !isMentionAll(name));
    found = now
      ? others
        .filter((name) => personKey(name).startsWith(now.typed) || personKey(name).includes(` ${now.typed}`))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 6)
      : [];
    // "all" comes after the names, so the keys that pick a name stay what they were, and
    // first once it's exactly what was typed. It's offered while there's anyone to tell.
    if (now && others.length && MENTION_ALL.startsWith(now.typed)) {
      if (now.typed === MENTION_ALL) found.unshift(MENTION_ALL);
      else found.push(MENTION_ALL);
    }
    active = 0;
    render();
  };
  const pick = (name) => {
    const now = typing();
    if (!now) return close();
    const caret = input.selectionStart ?? input.value.length;
    const start = `${input.value.slice(0, now.at)}@${name} `;
    input.value = start + input.value.slice(caret);
    input.setSelectionRange(start.length, start.length);
    close();
    input.focus();
  };

  input.addEventListener("input", look);
  input.addEventListener("click", look);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    if (!found.length) {
      if (cancelButton && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation(); // Esc here gives up the edit, not the whole window
        cancelButton.click();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
      render();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault(); // puts the name in, rather than posting the comment or moving on
      pick(found[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Esc here puts the list away, not the whole window
      close();
    }
  });
  // On the way down, before the press would take the caret out of the box.
  list.addEventListener("pointerdown", (event) => {
    const option = event.target.closest("[data-mention]");
    if (!option) return;
    event.preventDefault();
    pick(option.dataset.mention);
  });

  const form = el("form", { class: "win-form mention-form", "data-form": name, novalidate: true },
    input,
    el("button", { class: "btn btn-primary", type: "submit" }, button),
    cancelButton,
    list);
  if (images) takePastedImages(form, input);
  return form;
}

// ---------- Pasting images into an update or a comment ----------

const PASTE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 6;

// Lets a posting box take images from the clipboard, such as a screenshot. They wait under
// the box as small pictures, each with a way to take it off, and are posted with the words.
// `form.pastedImages` is what's waiting, for whoever posts the form.
function takePastedImages(form, input) {
  form.pastedImages = [];
  const tray = el("ul", { class: "paste-tray", "data-paste-list": true, hidden: true });
  const note = el("p", { class: "paste-note", role: "alert", "data-paste-note": true, hidden: true });
  form.append(tray, note);
  const say = (message) => {
    note.textContent = message || "";
    note.hidden = !message;
  };
  const render = () => {
    tray.hidden = !form.pastedImages.length;
    tray.replaceChildren(...form.pastedImages.map((item, i) => el("li", { class: "paste-item", "data-pasted": true },
      el("img", { src: item.preview, alt: "" }),
      el("span", { class: "paste-name" }, item.file.name || "Image"),
      el("button", { class: "win-remove", type: "button", "data-remove-pasted": String(i), "aria-label": `Remove ${item.file.name || "the image"}` }, "Remove"))));
  };
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    // Words go into the box as usual. So does a copy from a spreadsheet or a document,
    // which comes with a picture of itself as well as its words.
    if (!files.length || event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    let problem = null;
    for (const file of files) {
      if (!PASTE_TYPES.includes(file.type)) problem = "Only PNG, JPEG, GIF or WebP images can be pasted here.";
      else if (file.size > MAX_IMAGE_BYTES) problem = `${file.name || "That image"} is too large. Images can be up to 10 MB.`;
      else if (form.pastedImages.length >= MAX_IMAGES) problem = "Six images is the most for one post.";
      else form.pastedImages.push({ file, preview: URL.createObjectURL(file) });
    }
    say(problem);
    render();
  });
  tray.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-pasted]");
    if (!remove) return;
    const [gone] = form.pastedImages.splice(Number(remove.dataset.removePasted), 1);
    if (gone) URL.revokeObjectURL(gone.preview);
    say(null);
    render();
    input.focus();
  });
  // Once it's posted the form is reset, and what was waiting goes with it.
  form.addEventListener("reset", () => {
    form.pastedImages.forEach((item) => URL.revokeObjectURL(item.preview));
    form.pastedImages = [];
    say(null);
    render();
  });
}

// What posting a box does: uploads the images waiting under it, then posts them with the
// words. Images with no words are posted as "Image". Null when there's nothing to post.
function postingWithImages(w, form, post) {
  const typed = form.querySelector('[data-input="text"]').value.trim();
  const waiting = (form.pastedImages || []).map((item) => item.file);
  if (!typed && !waiting.length) return null;
  const text = typed || (waiting.length > 1 ? "Images" : "Image");
  return async () => {
    const images = [];
    for (const file of waiting) images.push(await state.store.uploadImage(w.taskId, file));
    return post(text, images);
  };
}

// A picture posted with an update or a comment is fetched once and kept while the page is
// open, since the address the board gives for it only lasts a few minutes.
const imageAddresses = new Map(); // attachment id → a promise of an address the page can show
function imageAddress(id) {
  if (!imageAddresses.has(id)) {
    const address = state.store.fileUrl(id, false).then((url) => (url.startsWith("blob:") ? url : fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Image failed (${res.status})`);
      return res.blob();
    }).then((blob) => URL.createObjectURL(blob))));
    address.catch(() => imageAddresses.delete(id)); // so it's tried again the next time it's shown
    imageAddresses.set(id, address);
  }
  return imageAddresses.get(id);
}

// The images on an update or a comment, as small pictures. Pressing one opens it full size.
const imagesOnUpdate = (task, entry) => (task.attachments || []).filter((a) => a.kind === "image" && a.update_at && stampKey(a.update_at) === stampKey(entry.at));
const imagesOnComment = (task, comment) => (task.attachments || []).filter((a) => a.kind === "image" && a.comment_id === comment.id);
function postImages(images) {
  if (!images.length) return null;
  return el("span", { class: "post-images" }, ...images.map((a) => {
    const img = el("img", { alt: a.title, loading: "lazy" });
    const button = el("button", { class: "post-image", type: "button", "data-image": a.id, "data-mime": a.mime || "", title: a.title }, img);
    imageAddress(a.id).then((url) => { img.src = url; }, () => {
      button.classList.add("is-missing");
      button.textContent = "Image unavailable";
    });
    return button;
  }));
}

// ---------- Editing or deleting your own update or comment ----------

// Beside the time, once what was posted has been edited. Hovering says when.
function editedMark(editedAt) {
  if (!editedAt) return null;
  const when = new Date(editedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return el("span", { class: "activity-edited", "data-edited": true, title: `Edited ${when}` }, "edited");
}

// On an update that came from a meeting's notes: a tag saying so, and the meeting, which
// opens from here while it's still on the calendar and this person can see it.
function meetingTag(entry) {
  if (!entry.meeting) return null;
  const meeting = findMeeting(entry.meeting.id);
  return el("span", { class: "post-from" },
    el("span", { class: "post-tag" }, "Meeting Notes"),
    meeting
      ? el("button", { class: "link-btn", type: "button", "data-open-meeting": meeting.id }, meeting.title)
      : el("span", { class: "win-meta" }, entry.meeting.title || ""));
}

// Edit and Delete, on what this person posted themselves. `key` says which one: an
// update's moment, or a comment's or a note's id.
function ownActions(kind, key) {
  return el("span", { class: "own-actions" },
    el("button", { class: "link-btn", type: "button", "data-edit-own": kind, "data-key": key }, "Edit"),
    el("button", { class: "win-remove", type: "button", "data-delete-own": kind, "data-key": key }, "Delete"));
}

// The box an update or a comment is edited in, with its words in it.
function ownEditForm(kind, key, text) {
  const form = mentionForm({ name: `edit-${kind}`, placeholder: "", label: `Edit your ${kind}`, button: "Save", maxlength: kind === "update" ? "1000" : "2000", value: text, cancel: true });
  form.dataset.key = key;
  return form;
}

// One update or comment is edited at a time. While it is, its list is left alone, so the
// box and what's typed in it survive the board refreshing.
function startOwnEdit(w, kind, key) {
  w.editing = { list: kind === "update" ? "updates" : "comments", key };
  showWindowError(w, null);
  renderTaskWindow(w);
  const box = w.body.querySelector(`[data-form="edit-${kind}"] [data-input="text"]`);
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function stopOwnEdit(w) {
  const was = w.editing;
  w.editing = null;
  showWindowError(w, null);
  renderTaskWindow(w);
  // The keyboard goes back to the Edit button it came from.
  if (was) [...w.body.querySelectorAll("[data-edit-own]")].find((b) => b.dataset.key === was.key)?.focus();
}

// Why the board wouldn't change or delete an update or a comment, in words.
function ownPostError(error, kind, done) {
  if (error?.code === "not_author") return `Only whoever posted that ${kind} can change it.`;
  if (["update_not_found", "comment_not_found", "note_not_found"].includes(error?.code)) return `That ${kind} is no longer there.`;
  return `That ${kind} wasn't ${done}. Check your connection and try again.`;
}

async function saveOwnEdit(w, form) {
  const kind = form.dataset.form === "edit-update" ? "update" : "comment";
  const key = form.dataset.key;
  const box = form.querySelector('[data-input="text"]');
  const text = box.value.trim();
  if (!text) return box.focus();
  const task = findTask(w.taskId);
  const posted = kind === "update"
    ? (task?.updates || []).find((u) => u.kind === "note" && stampKey(u.at) === stampKey(key))
    : (task?.comments || []).find((c) => c.id === key);
  // The same words: there's nothing to save.
  if (posted && (kind === "update" ? posted.text : posted.body) === text) return stopOwnEdit(w);
  const mentions = mentionsIn(text);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const result = await write(() => (kind === "update" ? state.store.editUpdate(w.taskId, key, text, mentions) : state.store.editComment(key, text, mentions)), null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (!result.ok) return showWindowError(w, ownPostError(result.error, kind, "saved"));
  // Shown at once, rather than when the next read arrives.
  if (posted) Object.assign(posted, { [kind === "update" ? "text" : "body"]: text, mentions, edited_at: new Date().toISOString() });
  stopOwnEdit(w);
}

// Deleting takes a second press, as removing a file does.
async function deleteOwnPost(w, button) {
  const kind = button.dataset.deleteOwn;
  const key = button.dataset.key;
  if (!armButton(button, "Confirm?", "Delete")) return;
  button.disabled = true;
  const result = await write(() => (kind === "update" ? state.store.deleteUpdate(w.taskId, key) : state.store.deleteComment(key)), null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (!result.ok) return showWindowError(w, ownPostError(result.error, kind, "deleted"));
  // Gone at once, rather than when the next read arrives. Its images go with it, and are
  // taken out of storage as a removed file is.
  const task = findTask(w.taskId);
  const itsImage = (a) => a.kind === "image" && (kind === "update" ? !!a.update_at && stampKey(a.update_at) === stampKey(key) : a.comment_id === key);
  if (task?.attachments?.some(itsImage)) {
    task.attachments = task.attachments.filter((a) => !itsImage(a));
    state.store.cleanFiles().catch(() => { /* retried by the next removal */ });
  }
  if (task && kind === "update") {
    task.updates = (task.updates || []).filter((u) => !(u.kind === "note" && stampKey(u.at) === stampKey(key)));
    task.likes = (task.likes || []).filter((l) => stampKey(l.at) !== stampKey(key));
  } else if (task) {
    task.comments = (task.comments || []).filter((c) => c.id !== key);
  }
  showWindowError(w, null);
  renderTaskWindow(w);
}

// Fetches a task's whole history for its window, newest first. It's kept with the count it
// was asked for, so it's fetched again only when the task has a change it doesn't have. One
// that fails isn't tried again until the section is folded and opened.
async function loadHistory(w, total) {
  if (w.historyLoading === total) return;
  w.historyLoading = total;
  try {
    const all = await state.store.taskHistory(w.taskId);
    w.history = { asked: total, entries: [...all].reverse() };
  } catch (error) {
    if (error.code === "session_expired") return showGate("Your session ended. Enter the PIN to continue.");
    w.historyFailed = true;
  } finally {
    w.historyLoading = null;
  }
  if (w.root.isConnected && findTask(w.taskId)) renderTaskWindow(w);
}

// Opens one of a task's sections, to show where someone was mentioned, without that
// counting as how this person keeps the section.
function showSection(taskId, name) {
  const fold = state.windows.get(taskId)?.body.querySelector(`[data-fold="${name}"]`);
  if (!fold) return;
  if (!fold.open) {
    fold.dataset.quiet = "1";
    fold.open = true;
  }
  fold.scrollIntoView({ block: "nearest" });
}

function buildTaskWindow(w, task) {
  const isSubtask = !!task.parent_id;
  w.assignPicker = namePicker({ label: "Assign to", names: task.assignees, roles: "full", onChange: (names) => updateTask(w.taskId, { assignees: names }) });
  const [nameField, detailsField, ...whoAndWhen] = taskFields(w.assignPicker);
  const count = (name) => el("span", { class: "win-count", "data-count": name });
  const parts = [
    isSubtask && el("p", { class: "win-parent" }, "Part of ", el("button", { class: "link-btn", type: "button", "data-open-task": task.parent_id }, "")),
    nameField,
    detailsField,
    // Whose focus task this is, when it's someone's.
    el("p", { class: "focus-for", "data-focus-for": true, hidden: true }),
    // Outside the sections, so it shows whichever of them is folded away.
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    // Who it's for, when it's due and where it stands. Folded, its heading says the gist.
    taskFold("info", ["Assignment and status", el("span", { class: "win-fold-note", "data-info-note": true })],
      ...whoAndWhen,
      !isSubtask && el("div", { class: "field-row" },
        repeatField(),
        field("Project", el("select", { class: "input", "data-field": "project_id" }))),
      // Where else this task is mirrored. It's one task: those places only show it too.
      !isSubtask && (w.mirrorPicker = mirrorPicker(task.id)).root,
      columnField("progress", el("div", { class: "progress-wrap progress-wrap-large" },
        el("output", { class: "progress-label" }, "0%"),
        el("input", { class: "progress-range", type: "range", min: "0", max: "100", step: "5", "data-field": "progress" }))),
      // The project's own columns, when it has any.
      el("div", { class: "own-fields", "data-custom-fields": true, hidden: true })),
    !isSubtask && taskFold("subtasks", ["Subtasks", count("subtasks")],
      el("ul", { class: "win-list", "data-list": "subtasks" }),
      el("form", { class: "win-form", "data-form": "subtask", novalidate: true },
        textInput({ maxlength: "200", placeholder: "Add a subtask", "aria-label": "New subtask", "data-input": "title" }),
        textInput({ class: "input is-narrow", maxlength: "200", list: "people-list", placeholder: "Assign", "aria-label": "Assign the new subtask to, with commas between names", "data-input": "assignee" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Add"))),
    // Where the task stands, as the people working on it post it. Typing @ mentions someone.
    taskFold("updates", ["Updates"],
      mentionForm({ name: "update", placeholder: "Add an update. Type @ to mention, or paste an image", label: "New update", button: "Post", maxlength: "1000", images: true }),
      el("ul", { class: "activity-list", "data-list": "updates" })),
    // What people say about it. Typing @ mentions someone, who is then told.
    taskFold("comments", ["Comments", count("comments")],
      mentionForm({ name: "comment", placeholder: "Write a comment. Type @ to mention, or paste an image", label: "New comment", button: "Comment", maxlength: "2000", images: true }),
      el("ul", { class: "activity-list comment-list", "data-list": "comments" })),
    // The meetings set for this task, and a way to set another without leaving it.
    // Meetings, files and links are declared on the task. A subtask has these two sections
    // only for what was put on it before that, with no way to add more: they stay hidden
    // while it has none.
    taskFold("meetings", ["Meetings", count("meetings")],
      isSubtask && el("p", { class: "hint" }, "Meetings are now set on the task. This one was set for the subtask earlier."),
      el("ul", { class: "win-list", "data-list": "meetings" }),
      !isSubtask && el("div", { class: "win-form" }, el("button", { class: "btn btn-quiet", type: "button", "data-set-meeting": true }, "Set a meeting"))),
    taskFold("files", ["Files and links", count("attachments")],
      isSubtask && el("p", { class: "hint" }, "Files and links now go on the task. These were added to the subtask earlier."),
      el("h4", { class: "win-subheading" }, "Files"),
      el("ul", { class: "win-list", "data-list": "files" }),
      !isSubtask && el("div", { class: "win-form" },
        el("label", { class: "btn btn-quiet win-upload" }, "Upload files", el("input", { type: "file", multiple: true, "data-upload": true }))),
      el("h4", { class: "win-subheading" }, "Links"),
      el("ul", { class: "win-list", "data-list": "links" }),
      !isSubtask && el("form", { class: "win-form", "data-form": "link", novalidate: true },
        textInput({ maxlength: "2000", placeholder: "Paste a link", "aria-label": "Link address", "data-input": "url", inputmode: "url" }),
        textInput({ class: "input is-narrow", maxlength: "255", placeholder: "Title (optional)", "aria-label": "Link title", "data-input": "title" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Add"))),
    // Everything that has happened to it, the newest first: each change the board recorded
    // and each update someone posted. Folded away until it's wanted.
    taskFold("history", ["History", count("history")],
      el("ul", { class: "activity-list", "data-list": "history" })),
    // Deleting is offered to whoever created it. Everyone else is told who that is.
    el("div", { class: "win-foot" }, canDelete(task)
      ? el("button", { class: "btn btn-danger", type: "button", "data-delete-task": true }, isSubtask ? "Delete this subtask" : "Delete this task")
      : el("p", { class: "delete-note", "data-delete-note": true }, deleteNote(task, isSubtask ? "subtask" : "task"))),
  ];
  w.body.append(...parts.filter(Boolean));
  w.body.querySelector('[data-fold="meetings"]').dataset.section = "meetings";
  w.body.addEventListener("change", (event) => onWindowChange(w, event));
  w.body.addEventListener("input", previewProgress);
  w.body.addEventListener("submit", (event) => onWindowSubmit(w, event));
  w.body.addEventListener("click", (event) => onWindowClick(w, event));
  // Opening or folding a section sets how that section starts in every task from now on.
  // The event doesn't travel up the page, so it's caught on the way down.
  w.body.addEventListener("toggle", (event) => {
    const name = event.target.dataset?.fold;
    // Opening History is when the entries the task doesn't carry are fetched, and tried again if that failed.
    if (name === "history" && event.target.open && findTask(w.taskId)) {
      w.historyFailed = false;
      renderTaskWindow(w);
    }
    // Opened by the page itself, to show something: that's not this person's choice to keep.
    if (event.target.dataset?.quiet) return delete event.target.dataset.quiet;
    const states = foldStates();
    if (!name || states[name] === event.target.open) return;
    writeStorage("localStorage", FOLDS_KEY, JSON.stringify({ ...states, [name]: event.target.open }));
  }, true);
}

function showWindowError(w, message) {
  const note = w.body.querySelector("[data-error]");
  note.textContent = message || "";
  note.hidden = !message;
}

// Says what's wrong with one field of a form and goes to it. The message shows down by the
// button, which going to the field scrolls away from, so the field is marked as well until
// something is typed in it.
function fieldError(w, message, name) {
  showWindowError(w, message);
  const box = w.body.querySelector(`[data-input="${name}"]`);
  box.setAttribute("aria-invalid", "true");
  box.addEventListener("input", () => box.removeAttribute("aria-invalid"), { once: true });
  box.focus();
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
  const focusFor = w.body.querySelector("[data-focus-for]");
  const focusers = focusNames(task.id);
  if (focusFor) {
    focusFor.hidden = !focusers.length;
    focusFor.textContent = focusers.length ? `★ A focus task for ${nameList(focusers)}` : "";
  }
  w.mirrorPicker?.render();
  // The gist of the folded section, for its heading: who, when, how urgent, how far along.
  const gist = [
    task.assignees.length ? assigneeText(task) : "Unassigned",
    deadlineNote(task)?.text || (task.deadline ? formatDay(parseDate(task.deadline)) : null),
    URGENCY[task.urgency],
    STATUS[task.status],
    `${task.progress}%`,
  ].filter(Boolean).join(" · ");
  const gistEl = w.body.querySelector("[data-info-note]");
  if (gistEl.textContent !== gist) gistEl.textContent = gist;
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
    const done = isCompleted(m);
    // A completed meeting goes with the ones that are over.
    const past = done || (!repeats(m) && new Date(m.ends_at) <= now);
    const at = repeats(m) ? nextOccurrence(m, now) : first;
    const when = repeats(m)
      ? `${capitalize(repeatPhrase(m.repeat, first))}, ${formatTime(first)}${done ? "" : ` · next ${formatDay(at)}`}`
      : `${formatDay(first)}, ${formatTime(first)}`;
    return { id: m.id, title: m.title, when, past, done, at: at.getTime(), status: meetingStatus(m) };
  }).sort((a, b) => a.past - b.past || (a.past ? b.at - a.at : a.at - b.at));
  setCount(w, "meetings", meetings.length ? String(meetings.length) : "");
  renderList(w, "meetings", meetings, () => (meetings.length ? meetings.map((m) => el("li", { class: `win-item${m.past ? " is-past" : ""}` },
    el("span", { class: "win-item-main" },
      el("button", { class: "link-btn", type: "button", "data-open-meeting": m.id }, m.title)),
    el("span", { class: "win-meta" }, m.when),
    m.past
      ? el("span", { class: "win-meta" }, m.done ? "Completed" : "Past")
      : el("span", { class: `meeting-answer answer-${m.status[1]}` }, m.status[0])))
    : [el("li", { class: "win-empty" }, `No meetings for this ${task.parent_id ? "subtask" : "task"} yet.`)]));

  // Its own subtasks, then the tasks mirrored into it, which count as part of it. A
  // mirrored one is a whole task that lives elsewhere: it says where, and opens as itself.
  const held = new Set(heldBy(task.id).map((t) => t.id));
  const subtasks = [...subtasksOf(task.id), ...heldBy(task.id)];
  const from = (s) => (held.has(s.id) ? findProject(s.project_id)?.name || "" : null);
  setCount(w, "subtasks", subtasks.length ? `${subtasks.filter((s) => s.status === "done").length}/${subtasks.length}` : "");
  // Whoever created a subtask can rename it or delete it from here. Not a task that's only
  // mirrored in, which is renamed and deleted where it lives. While one is being renamed the
  // list is left as it is, so the box and what's typed survive the board refreshing.
  const ownSubtask = (s) => !held.has(s.id) && s.parent_id === task.id && personKey(s.created_by) === personKey(state.name);
  renderList(w, "subtasks", w.editingSubtask ? ["editing", w.editingSubtask] : subtasks.map((s) => [s.id, s.title, s.assignees, s.status, deadlineNote(s)?.text, from(s), myReminder(s.id)?.remind_at, ownSubtask(s)]), () =>
    subtasks.length ? subtasks.map((s) => {
      const due = deadlineNote(s);
      if (w.editingSubtask === s.id) return el("li", { class: "win-item is-editing", "data-subtask-row": s.id }, subtaskEditForm(s));
      return el("li", { class: `win-item${held.has(s.id) ? " is-mirrored" : ""}`, "data-subtask-row": s.id },
        el("input", { type: "checkbox", "data-done": s.id, checked: s.status === "done", "aria-label": `Mark ${s.title} done` }),
        el("span", { class: "win-item-main" },
          el("button", { class: `link-btn${s.status === "done" ? " subtask-done" : ""}`, type: "button", "data-open-task": s.id }, s.title)),
        held.has(s.id) && el("span", { class: "mirror-from" }, `Mirrored from ${from(s)}`),
        s.assignees.length
          ? el("span", { class: "win-meta" }, assigneeText(s))
          : el("button", { class: "link-btn win-meta", type: "button", "data-assign": s.id, "aria-label": `Assign ${s.title}` }, "Unassigned"),
        due && el("span", { class: `due-note due-${due.tone}` }, due.text),
        // A reminder to yourself about this subtask. Not on a task that's only mirrored in.
        !held.has(s.id) && reminderButton(s),
        ownSubtask(s) && el("span", { class: "own-actions subtask-actions" },
          el("button", { class: "link-btn", type: "button", "data-edit-subtask": s.id, "aria-label": `Rename ${s.title}` }, "Edit"),
          el("button", { class: "win-remove", type: "button", "data-delete-subtask": s.id, "aria-label": `Delete ${s.title}` }, "Delete")));
    }) : [el("li", { class: "win-empty" }, "No subtasks yet.")]);

  // Notes people wrote stay in view under Updates. History, a section of its own, has
  // everything the board has kept for this task: those notes and every change, newest first.
  const entries = [...(task.updates || [])].reverse();
  const notes = entries.filter((entry) => entry.kind === "note");
  const entrySignature = (entry) => [entry.at, entry.by, entry.kind, entry.text, entry.mentions, entry.edited_at, timeAgo(entry.at), state.name,
    entry.meeting && [entry.meeting.id, findMeeting(entry.meeting.id)?.title ?? entry.meeting.title]];
  // How long ago, with the exact day and time on hover.
  const when = (entry) => el("span", { class: "activity-time", title: new Date(entry.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) }, timeAgo(entry.at));
  // Whoever posted an update or wrote a comment can edit it or delete it. While one is
  // being edited its list is left as it is, so the box isn't lost when the board refreshes.
  const mine = (name) => personKey(name) === personKey(state.name);
  const editingUpdate = (entry) => w.editing?.list === "updates" && stampKey(w.editing.key) === stampKey(entry.at);
  renderList(w, "updates", w.editing?.list === "updates" ? ["editing", w.editing.key] : notes.map((entry) => [...entrySignature(entry), likesOf(task, entry), imagesOnUpdate(task, entry).map((a) => a.id)]), () =>
    notes.length ? notes.map((entry) => (editingUpdate(entry)
      ? el("li", { class: "is-editing", "data-update": entry.at }, ownEditForm("update", entry.at, entry.text))
      : el("li", { "data-update": entry.at },
        el("strong", {}, entry.by), " ",
        el("span", { class: "activity-time" }, timeAgo(entry.at)),
        editedMark(entry.edited_at),
        mine(entry.by) && ownActions("update", entry.at),
        // One that came from a meeting's notes says so.
        meetingTag(entry),
        // The people an update mentions stand out, as they do in a comment.
        el("span", { class: "activity-note" }, ...commentBody({ body: entry.text, mentions: entry.mentions, created_by: entry.by })),
        postImages(imagesOnUpdate(task, entry)),
        // A way to say it's been seen, and who has.
        likeRow(task, entry)))) : [el("li", { class: "win-empty" }, "No updates yet.")]);
  // A task carries its latest fifty entries, and the board keeps every one. When there are
  // more, the rest are fetched once the section is open, and again when the count moves on.
  const total = task.history_count ?? entries.length;
  const whole = w.history?.asked === total ? w.history.entries : null;
  if (!whole && total > entries.length && !w.historyFailed && w.body.querySelector('[data-fold="history"]').open) loadHistory(w, total);
  // The latest entries are the ones the task carries, which follow an edit or a delete at
  // once. What's older than those comes from the whole history that was fetched.
  const oldest = entries.at(-1);
  const listed = whole && oldest ? [...entries, ...whole.filter((entry) => stampKey(entry.at) < stampKey(oldest.at))] : whole || entries;
  const earlier = Math.max(0, total - listed.length);
  setCount(w, "history", total ? String(total) : "");
  renderList(w, "history", [listed.map(entrySignature), earlier, !!w.historyFailed], () => (listed.length ? [
    ...listed.map((entry) => (entry.kind === "note"
      ? el("li", { class: "activity-posted" }, `${entry.by} posted an update `, when(entry), editedMark(entry.edited_at),
        entry.meeting && el("span", { class: "post-tag post-tag-inline" }, "Meeting Notes"), el("span", { class: "activity-note" }, `“${entry.text}”`))
      : el("li", { class: "activity-system" }, `${entry.by} ${entry.text} `, when(entry)))),
    earlier > 0 && el("li", { class: "win-empty", "data-history-more": true }, w.historyFailed
      ? `The ${earlier} earlier ${earlier === 1 ? "entry" : "entries"} couldn't be loaded. Check your connection, then fold this section and open it again.`
      : `Loading ${earlier} earlier ${earlier === 1 ? "entry" : "entries"}…`),
  ].filter(Boolean) : [el("li", { class: "win-empty" }, "Nothing has happened to it yet.")]));

  // Comments, the newest first, with the people each one mentions standing out.
  const comments = [...(task.comments || [])].reverse();
  setCount(w, "comments", comments.length ? String(comments.length) : "");
  const editingComment = (c) => w.editing?.list === "comments" && w.editing.key === c.id;
  renderList(w, "comments", w.editing?.list === "comments" ? ["editing", w.editing.key] : comments.map((c) => [c.id, c.body, c.mentions, c.created_by, c.edited_at, timeAgo(c.created_at), state.name, imagesOnComment(task, c).map((a) => a.id)]), () =>
    comments.length ? comments.map((c) => (editingComment(c)
      ? el("li", { class: "is-editing", "data-comment": c.id }, ownEditForm("comment", c.id, c.body))
      : el("li", { "data-comment": c.id },
        el("strong", {}, c.created_by), " ",
        el("span", { class: "activity-time" }, timeAgo(c.created_at)),
        editedMark(c.edited_at),
        mine(c.created_by) && ownActions("comment", c.id),
        el("span", { class: "activity-note" }, ...commentBody(c)),
        postImages(imagesOnComment(task, c))))) : [el("li", { class: "win-empty" }, "No comments yet.")]);

  // What's attached to the task itself. An image pasted into an update or a comment is kept
  // the same way, but belongs to that update or comment and shows there.
  const attachments = (task.attachments || []).filter((a) => a.kind !== "image");
  // Meetings, files and links are declared on the task. A subtask shows those sections
  // only while it still has some that were put on it earlier.
  if (task.parent_id) {
    w.body.querySelector('[data-fold="meetings"]').hidden = meetings.length === 0;
    w.body.querySelector('[data-fold="files"]').hidden = attachments.length === 0;
  }
  setCount(w, "attachments", attachments.length ? String(attachments.length) : "");
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
      } else if (w.showNow) {
        // A Reschedule window goes once its meeting is completed, and otherwise keeps
        // saying when the meeting is now.
        if (isCompleted(findMeeting(w.meetingId))) closeWindow(w);
        else w.showNow();
      } else if (!w.isForm) {
        renderMeetingWindow(w);
      }
      continue;
    }
    // A Columns window goes with its project.
    if (w.key === "columns" && !findProject(w.projectId)) closeWindow(w);
    // A reminder's window goes with the subtask it's for.
    if (w.remindFor && !findTask(w.remindFor)) closeWindow(w);
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
    // Two subtasks of one task can't share a name.
    const clash = taskNamed(title, { parentId: w.taskId });
    if (clash) {
      showWindowError(w, nameTakenMessage(clash, w.taskId));
      return input("title").focus();
    }
    const assignees = splitNames(input("assignee").value);
    action = () => state.store.save(null, { title, assignees, parent_id: w.taskId });
    failure = "That subtask didn't save. Check your connection and try again.";
    focusAfter = input("title");
  } else if (form.dataset.form === "update") {
    action = postingWithImages(w, form, (text, images) => state.store.addUpdate(w.taskId, text, mentionsIn(text), images));
    if (!action) return input("text").focus();
    failure = "That update didn't post. Check your connection and try again.";
    focusAfter = input("text");
  } else if (form.dataset.form === "comment") {
    action = postingWithImages(w, form, (text, images) => state.store.addComment(w.taskId, text, mentionsIn(text), images));
    if (!action) return input("text").focus();
    failure = "That comment didn't post. Check your connection and try again.";
    focusAfter = input("text");
  } else if (form.dataset.form === "edit-update" || form.dataset.form === "edit-comment") {
    return saveOwnEdit(w, form);
  } else if (form.dataset.form === "edit-subtask") {
    return saveSubtaskName(w, form);
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
    // The board checks an image as the page does, so these only show if something slipped past.
    const imageProblem = {
      invalid_image: "Only PNG, JPEG, GIF or WebP images can be posted.",
      image_too_large: "One of those images is too large. Images can be up to 10 MB.",
      too_many_images: "Six images is the most for one post.",
    }[result.error?.code];
    showWindowError(w, imageProblem || (result.error?.code === "duplicate_title" ? "This task already has a subtask with that name. Give this one a different name." : failure));
  }
}

function onWindowClick(w, event) {
  const target = event.target;
  const remind = target.closest("[data-remind]");
  if (remind) return openReminder(remind.dataset.remind);
  const editSubtask = target.closest("[data-edit-subtask]");
  if (editSubtask) return startSubtaskEdit(w, editSubtask.dataset.editSubtask);
  if (target.closest("[data-cancel-subtask]")) return stopSubtaskEdit(w);
  const deleteSub = target.closest("[data-delete-subtask]");
  if (deleteSub) return deleteSubtask(w, deleteSub);
  const like = target.closest("[data-like]");
  if (like) return likeUpdate(w, like);
  const image = target.closest("[data-image]");
  if (image) return openFile(w, image.dataset.image, image.dataset.mime);
  const editOwn = target.closest("[data-edit-own]");
  if (editOwn) return startOwnEdit(w, editOwn.dataset.editOwn, editOwn.dataset.key);
  if (target.closest("[data-cancel-edit]")) return stopOwnEdit(w);
  const deleteOwn = target.closest("[data-delete-own]");
  if (deleteOwn) return deleteOwnPost(w, deleteOwn);
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
  // A mirrored task is one task, so deleting it from one project deletes it from them all.
  const everywhere = mirrorsOf(findTask(id) || {}).length > 0 && !findTask(id)?.parent_id;
  if (!armButton(button, everywhere ? "Delete from every project?" : "Delete for everyone?", original)) return;
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
    const what = findTask(id)?.parent_id ? "subtask" : "task";
    showWindowError(w, refusedDelete(result) ? `Only whoever created this ${what} can delete it.` : `That ${what} wasn't deleted. Check your connection and try again.`);
  }
}

// ---------- Renaming or deleting a subtask you created ----------

// The box a subtask is renamed in, with its name in it. Esc gives up the rename.
function subtaskEditForm(subtask) {
  const input = textInput({ maxlength: "200", "aria-label": `New name for ${subtask.title}`, "data-input": "title" });
  input.value = subtask.title;
  const cancel = el("button", { class: "btn btn-quiet", type: "button", "data-cancel-subtask": true }, "Cancel");
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation(); // Esc here gives up the rename, not the whole window
    cancel.click();
  });
  const form = el("form", { class: "win-form subtask-edit", "data-form": "edit-subtask", novalidate: true },
    input, el("button", { class: "btn btn-primary", type: "submit" }, "Save"), cancel);
  form.dataset.key = subtask.id;
  return form;
}

function startSubtaskEdit(w, id) {
  w.editingSubtask = id;
  showWindowError(w, null);
  renderTaskWindow(w);
  const box = w.body.querySelector('[data-form="edit-subtask"] [data-input="title"]');
  if (!box) return;
  box.focus();
  box.select();
}

function stopSubtaskEdit(w) {
  const was = w.editingSubtask;
  w.editingSubtask = null;
  showWindowError(w, null);
  renderTaskWindow(w);
  // The keyboard goes back to the Edit button it came from.
  if (was) w.body.querySelector(`[data-edit-subtask="${CSS.escape(was)}"]`)?.focus();
}

// A new name has to be one no other subtask of this task has, as when it's added.
function saveSubtaskName(w, form) {
  const id = form.dataset.key;
  const box = form.querySelector('[data-input="title"]');
  const title = box.value.trim();
  const subtask = findTask(id);
  if (!title) return box.focus();
  if (!subtask || title === subtask.title) return stopSubtaskEdit(w);
  const clash = taskNamed(title, { parentId: w.taskId, except: id });
  if (clash) {
    showWindowError(w, nameTakenMessage(clash, w.taskId));
    return box.focus();
  }
  w.editingSubtask = null;
  showWindowError(w, null);
  updateTask(id, { title });
  renderTaskWindow(w);
  w.body.querySelector(`[data-edit-subtask="${CSS.escape(id)}"]`)?.focus();
}

// Deleting takes a second press. The board deletes it only for whoever created it, and
// notes it in the task's history.
async function deleteSubtask(w, button) {
  const id = button.dataset.deleteSubtask;
  if (!armButton(button, "Confirm?", "Delete")) return;
  button.disabled = true;
  // Its own window may close during the refresh below, before this function resumes.
  const going = state.windows.get(id);
  if (going) going.deleting = true;
  const result = await write(() => state.store.remove(id), null);
  if (result.ok) {
    if (going) closeWindow(going);
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.store.cleanFiles().catch(() => { /* retried by the next removal */ });
    if (w.root.isConnected && findTask(w.taskId)) {
      showWindowError(w, null);
      renderTaskWindow(w);
    }
  } else {
    if (going) going.deleting = false;
    button.disabled = false;
    if (w.root.isConnected) showWindowError(w, refusedDelete(result) ? "Only whoever created this subtask can delete it." : "That subtask wasn't deleted. Check your connection and try again.");
  }
}

// ---------- Adding a task with more than a name ----------

function openNewTask() {
  const existing = state.windows.get("new");
  if (existing) return showWindow(existing);
  const w = createWindow("new", "Add task");
  w.height = Math.min(w.height, 470);
  placeWindow(w);
  w.assignPicker = namePicker({ label: "Assign to", roles: "full" });
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
  const clash = taskNamed(title, { projectId: state.projectId });
  if (clash) {
    showWindowError(w, nameTakenMessage(clash));
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
  if (!saved.ok) return showWindowError(w, saved.error?.code === "duplicate_title" ? NAME_TAKEN : "That task didn't save. Check your connection and try again.");

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
    .map((f) => [f.name, state.tasks.filter((t) => isIn(t, w.projectId) && String(t.custom?.[f.id] ?? "") !== "").length])
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
// Whoever set a meeting can mark it completed once it's done with. It stays on the week,
// marked as completed, and leaves what's waiting for an answer and My meetings.
const isCompleted = (m) => !!m.completed_at;
// Where a meeting stands, in words, and the name of the color that goes with it.
const meetingStatus = (m) => (isCompleted(m) ? ["Completed", "done"] : isConfirmed(m) ? ["Confirmed", "accepted"]
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

// The meetings waiting for this person's own answer, soonest first. A repeating meeting
// never ends, so it keeps asking until it's answered, or completed.
function waitingInvites() {
  const now = new Date();
  return state.meetings
    .filter((m) => !isCompleted(m) && myInvite(m)?.answer === "waiting" && (repeats(m) || new Date(m.ends_at) > now))
    .map((m) => ({ m, at: nextOccurrence(m, now) }))
    .sort((a, b) => a.at - b.at);
}

// How many of those there are, on the Calendar tab, whichever page is showing.
function renderCalendarCount() {
  const count = waitingInvites().length;
  $("calendar-count").textContent = count;
  $("calendar-count").hidden = !count;
  if (count) $("nav-calendar").setAttribute("aria-label", `Calendar, ${count === 1 ? "1 meeting is" : `${count} meetings are`} waiting for your answer`);
  else $("nav-calendar").removeAttribute("aria-label");
}

function renderWaitingBanner() {
  const waiting = waitingInvites();
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

// ---------- My meetings: the calendar as a list ----------

// The Calendar opens on the week, every time it's come to. The list is a look that lasts
// until the Calendar is left, so the choice isn't kept, and one kept earlier is dropped.
const CALENDAR_VIEW_KEY = "board.calendarView";
const MY_ANSWER = { waiting: "Waiting for your answer", accepted: "You accepted", declined: "You declined" };
writeStorage("localStorage", CALENDAR_VIEW_KEY, null);
state.calendarView = "week";

// Every meeting this person set or is invited to: what's still to come soonest first, then
// what's over, latest first. Meetings other people set between themselves aren't here.
function renderMyMeetings() {
  const now = new Date();
  const mine = state.meetings.filter((m) => isOrganizer(m) || myInvite(m)).map((m) => {
    const first = new Date(m.starts_at);
    const done = isCompleted(m);
    const past = !repeats(m) && new Date(m.ends_at) <= now;
    const at = repeats(m) ? nextOccurrence(m, now) : first;
    const invite = !isOrganizer(m) && myInvite(m);
    const others = m.people.map((p) => p.name);
    return {
      id: m.id,
      title: m.title,
      past,
      done,
      doneAt: done ? Date.parse(m.completed_at) : 0,
      at: at.getTime(),
      when: repeats(m)
        ? `${capitalize(repeatPhrase(m.repeat, first))}, ${formatTime(first)}${done ? "" : ` · next ${formatDay(at)}`}`
        : `${formatDay(first)}, ${formatTime(first)} to ${formatTime(new Date(m.ends_at))}`,
      // Where it stands for this person: their own answer, or how their own meeting is doing.
      status: invite ? [MY_ANSWER[invite.answer], invite.answer] : meetingStatus(m),
      meta: [
        m.place,
        invite ? `Set by ${m.created_by}` : others.length ? `With ${others.join(", ")}` : "Just you",
        findTask(m.task_id) && `Task: ${findTask(m.task_id).title}`,
      ].filter(Boolean).join(" · "),
    };
  });
  // A completed meeting is out of both lists. It's kept in a group of its own at the end,
  // the latest completed first, so it can still be found and reopened.
  const upcoming = mine.filter((m) => !m.done && !m.past).sort((a, b) => a.at - b.at);
  const past = mine.filter((m) => !m.done && m.past).sort((a, b) => b.at - a.at);
  const completed = mine.filter((m) => m.done).sort((a, b) => b.doneAt - a.doneAt);

  // Only rebuilds when something shows differently, so a group stays open across a refresh.
  const box = $("my-meetings");
  const signature = JSON.stringify([upcoming, past, completed]);
  if (box.dataset.sig === signature) return;
  const pastOpen = !!box.querySelector(".mine-past")?.open;
  const doneOpen = !!box.querySelector(".mine-done")?.open;
  box.dataset.sig = signature;
  const row = (m) => el("li", {},
    el("button", { class: `mine-row${m.past || m.done ? " is-past" : ""}`, type: "button", "data-meeting": m.id, "data-at": m.at },
      el("span", { class: "mine-when" }, m.when),
      el("span", { class: "mine-title" }, m.title, m.meta && el("span", { class: "mine-meta" }, m.meta)),
      el("span", { class: `meeting-answer answer-${m.done ? "done" : m.status[1]}` }, m.done ? "Completed" : m.past ? "Past" : m.status[0])));
  box.replaceChildren(...[
    upcoming.length
      ? el("ul", { class: "mine-list", "data-list": "upcoming" }, ...upcoming.map(row))
      : el("p", { class: "win-empty" }, past.length || completed.length ? "Nothing coming up." : "You have no meetings yet. Set one with Set meeting, or wait for an invite."),
    past.length > 0 && el("details", { class: "mine-past", open: pastOpen },
      el("summary", {}, `Past (${past.length})`),
      el("ul", { class: "mine-list", "data-list": "past" }, ...past.map(row))),
    completed.length > 0 && el("details", { class: "mine-done", open: doneOpen },
      el("summary", {}, `Completed (${completed.length})`),
      el("ul", { class: "mine-list", "data-list": "completed" }, ...completed.map(row))),
  ].filter(Boolean));
}

function setCalendarView(view) {
  state.calendarView = view;
  renderCalendar();
}

$("view-week").addEventListener("click", () => setCalendarView("week"));
$("view-mine").addEventListener("click", () => setCalendarView("mine"));
$("my-meetings").addEventListener("click", (event) => {
  const row = event.target.closest("[data-meeting]");
  if (row) openMeeting(row.dataset.meeting);
});

function renderCalendar() {
  if ($("calendar-view").hidden) return;
  renderWaitingBanner();

  // The week and the list share the page: one shows, and the week's own controls go with it.
  // On a phone the week is a list of days, since seven columns of people don't fit.
  const listing = state.calendarView === "mine";
  const phone = isPhone();
  $("view-week").setAttribute("aria-pressed", String(!listing));
  $("view-mine").setAttribute("aria-pressed", String(listing));
  $("my-meetings").hidden = !listing;
  for (const part of [$("week-prev"), $("week-next"), $("week-today")]) part.hidden = listing;
  document.querySelector(".week-scroll").hidden = listing || phone;
  document.querySelector(".week-legend").hidden = listing || phone;
  $("week-days").hidden = listing || !phone;
  if (listing) {
    $("week-title").textContent = "My meetings";
    renderMyMeetings();
    return;
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const short = { month: "short", day: "numeric" };
  const sameYear = days[0].getFullYear() === days[6].getFullYear();
  $("week-title").textContent = `${days[0].toLocaleDateString(undefined, sameYear ? short : { ...short, year: "numeric" })} to ${days[6].toLocaleDateString(undefined, { ...short, year: "numeric" })}`;

  const me = personKey(state.name);
  const today = dayKey(new Date());
  // What's on each day, in order of time: one-time meetings, and this week's turn of repeating ones.
  // A completed meeting that repeats shows the times it was on, and none after the day it
  // was completed.
  const onDay = days.map((date) => state.meetings
    .map((m) => ({ m, at: occurrenceOn(m, date) }))
    .filter(({ m, at }) => at && !(isCompleted(m) && repeats(m) && dayKey(date) > dayKey(new Date(m.completed_at))))
    .sort((a, b) => a.at - b.at || byStart(a.m, b.m)));
  if (phone) return renderWeekDays(days, onDay, today);
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
        done: isCompleted(m),
        movable: isOrganizer(m) && !isCompleted(m), // the person who set a meeting can drag it to another day, until it's completed
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
      ...row.cells.map((chips, i) => el("div", { class: `week-cell${dayKey(days[i]) === today ? " is-today" : ""}`, role: "cell", "data-day": dayKey(days[i]) },
        el("button", {
          class: "week-add",
          type: "button",
          "data-add-day": dayKey(days[i]),
          "data-add-person": row.key === me ? null : row.name,
          "aria-label": `Set a meeting${row.key === me ? "" : ` with ${row.name}`} on ${formatDay(days[i])}`,
        }),
        ...chips.map((chip) => el("button", {
          class: `week-chip${chip.done ? " is-done" : chip.style === "wait" ? " is-waiting" : ""}${chip.movable ? " is-movable" : ""}`,
          type: "button",
          "data-meeting": chip.id,
          title: `${chip.time} ${chip.title}${chip.repeat ? ` (${chip.repeat})` : ""}${chip.task ? ` · Task: ${chip.task}` : ""}${chip.done ? " · Completed" : ""}${chip.movable ? " · Drag to another day to move it" : ""}`,
          "aria-label": (chip.repeat || chip.task || chip.done) && [`${chip.time} ${chip.title}`, chip.repeat, chip.task && `for the task ${chip.task}`, chip.done && "completed"].filter(Boolean).join(", "),
        },
          el("span", { class: "week-chip-time" }, chip.time, chip.repeat && el("span", { class: "week-chip-repeat", "aria-hidden": "true" }, "↻"),
            chip.done && el("span", { class: "week-chip-repeat", "aria-hidden": "true" }, "✓")),
          chip.title)))))));

  setUpMeetingDragging(grid);

  // Too narrow for all seven days: open a week on today, and leave it alone after that.
  if (grid.dataset.week !== dayKey(days[0])) {
    grid.dataset.week = dayKey(days[0]);
    const todayTab = grid.querySelector(".week-day.is-today");
    const scroller = grid.parentElement;
    scroller.scrollLeft = 0;
    if (todayTab) scroller.scrollLeft = todayTab.getBoundingClientRect().left - grid.querySelector(".week-person").getBoundingClientRect().right;
  }
}

// ---------- The week on a phone: a day at a time ----------

// A place that's a web address shows as its site, which is short enough for a phone.
function placeText(place) {
  if (!/^https?:\/\/\S+$/i.test(place || "")) return place || "";
  try { return new URL(place).host.replace(/^www\./, ""); } catch { return place; }
}

// One meeting as a card on its day: when, what, who's in it and where it stands for this person.
function dayCard(m, at) {
  const end = new Date(at.getTime() + (new Date(m.ends_at) - new Date(m.starts_at)));
  const me = personKey(state.name);
  const invite = !isOrganizer(m) && myInvite(m);
  const others = m.people.map((p) => p.name).filter((name) => personKey(name) !== me);
  const with_ = others.length ? `with ${others.join(", ")}` : "";
  const who = isOrganizer(m) ? (others.length ? capitalize(with_) : "Just you")
    : invite ? `Set by ${m.created_by}${with_ ? `, ${with_}` : ""}`
    : `${m.created_by}${with_ ? ` ${with_}` : ""}`;
  const status = isCompleted(m) ? ["Completed", "done"] : invite ? [MY_ANSWER[invite.answer], invite.answer] : meetingStatus(m);
  return {
    id: m.id,
    title: m.title,
    time: `${formatTime(at)} – ${formatTime(end)}`,
    repeat: repeats(m) ? repeatPhrase(m.repeat, new Date(m.starts_at)) : null,
    meta: [who, placeText(m.place), findTask(m.task_id) && `Task: ${findTask(m.task_id).title}`].filter(Boolean),
    status,
  };
}

function renderWeekDays(days, onDay, today) {
  const view = days.map((date, i) => ({
    day: dayKey(date),
    label: formatDay(date),
    today: dayKey(date) === today,
    past: dayKey(date) < today,
    meetings: onDay[i].map(({ m, at }) => dayCard(m, at)),
  }));
  // Only rebuilds when something shows differently, so the keyboard keeps its place.
  const box = $("week-days");
  const signature = JSON.stringify(view);
  if (box.dataset.sig === signature) return;
  box.dataset.sig = signature;
  box.replaceChildren(...view.map((d) => el("section", { class: `day${d.today ? " is-today" : ""}${d.past ? " is-past" : ""}${d.meetings.length ? "" : " is-empty"}`, "data-day": d.day },
    el("div", { class: "day-head" },
      el("h2", { class: "day-name" }, d.label, d.today && el("span", { class: "day-today" }, "Today")),
      !d.meetings.length && el("span", { class: "day-none" }, "No meetings"),
      el("button", { class: "day-add", type: "button", "data-add-day": d.day, "aria-label": `Set a meeting on ${d.label}` }, "+")),
    d.meetings.length > 0 && el("ul", { class: "day-list" }, ...d.meetings.map((c) => el("li", {},
      el("button", { class: `day-meeting is-${c.status[1]}`, type: "button", "data-meeting": c.id },
        el("span", { class: "day-time" }, c.time),
        el("span", { class: "day-status" }, c.status[0]),
        el("span", { class: "day-title" }, c.title, c.repeat && el("span", { class: "day-repeat" }, `↻ ${c.repeat}`)),
        el("span", { class: "day-meta" }, c.meta.join(" · ")))))))));
}

$("week-days").addEventListener("click", (event) => {
  const card = event.target.closest("[data-meeting]");
  if (card) return openMeeting(card.dataset.meeting);
  const add = event.target.closest("[data-add-day]");
  if (add) openMeetingForm({ day: add.dataset.addDay });
});

// Turning a phone on its side, or making a window narrow, swaps the grid and the list.
window.matchMedia("(max-width: 700px)").addEventListener("change", () => {
  renderCalendar();
  renderLayoutSwitch();
});

// ---------- Phone or desktop layout ----------

// On a phone the board is laid out for the phone. Desktop view lays it out as on a computer
// instead, zoomed out to fit, for the whole board: the week as a grid, the tasks as a sheet.
// The choice is kept on this device, and the page is laid out again from the start, which
// the few lines at the top of index.html do before anything is drawn.
const LAYOUT_KEY = "board.layout";
const desktopChosen = () => readStorage("localStorage", LAYOUT_KEY) === "desktop";

// A phone showing the desktop layout has a bar at the very top of the page to go back,
// since the top bar's own buttons may be off to the side. Otherwise the top bar has it.
function renderLayoutSwitch() {
  const desktop = desktopChosen();
  const onPhone = document.documentElement.classList.contains("desktop-on-phone");
  const button = $("layout-btn");
  button.hidden = onPhone || (!desktop && !isPhone());
  button.textContent = desktop ? "Mobile view" : "Desktop view";
  button.title = desktop ? "Lay the board out for this phone again" : "Lay the board out as on a computer, zoomed out to fit";
}

function setLayout(desktop) {
  writeStorage("localStorage", LAYOUT_KEY, desktop ? "desktop" : null);
  renderLayoutSwitch();
  reloadPage();
}

$("layout-btn").addEventListener("click", () => {
  const button = $("layout-btn");
  // Laying the page out again starts it afresh, so a form being filled in would be lost.
  const formOpen = [...state.windows.values()].some((w) => w.body.tagName === "FORM");
  if (formOpen && !armButton(button, "A form is open. Switch anyway?", button.textContent)) return;
  setLayout(!desktopChosen());
});
$("layout-back").addEventListener("click", () => {
  const button = $("layout-back");
  const formOpen = [...state.windows.values()].some((w) => w.body.tagName === "FORM");
  if (formOpen && !armButton(button, "A form is open. Switch anyway?", "Mobile view")) return;
  setLayout(false);
});
renderLayoutSwitch();

// The meetings this person set can be dragged from one day of the week to another. Every
// day cell is somewhere a card can be dropped, on anyone's row: only the day counts.
function setUpMeetingDragging(grid) {
  if (!window.Sortable) return;
  for (const cell of grid.querySelectorAll(".week-cell")) {
    new window.Sortable(cell, {
      group: "week-days",
      sort: false,
      draggable: ".week-chip.is-movable",
      animation: 0,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      delay: 160,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      ghostClass: "chip-ghost",
      dragClass: "chip-drag",
      onStart() {
        state.dragging = true;
        document.body.classList.add("is-dragging");
      },
      onEnd: handleMeetingDrop,
    });
  }
}

// The drag has already put the card in the cell it was dropped on. The week is redrawn
// from the meetings themselves either way, so the page never shows what wasn't saved.
function handleMeetingDrop(event) {
  endDrag();
  delete $("week-grid").dataset.sig;
  const id = event.item?.dataset.meeting;
  const from = event.from?.dataset.day;
  const to = event.to?.dataset.day;
  if (id && from && to && from !== to) moveMeetingToDay(id, from, to);
  else renderCalendar();
}

// Moves a meeting to another day, at the same time of day and for as long. Only the person
// who set it can. The day a repeating meeting is dragged from is one of many, so the whole
// series shifts by as many days.
async function moveMeetingToDay(id, fromDay, toDay) {
  const meeting = findMeeting(id);
  const days = Math.round((parseDate(toDay) - parseDate(fromDay)) / 86400000);
  if (!meeting || !isOrganizer(meeting) || !days) return renderCalendar();
  const shifted = (iso) => {
    const date = new Date(iso);
    date.setDate(date.getDate() + days); // by the calendar, so the clock time survives a change of hour
    return date.toISOString();
  };
  const fields = { starts_at: shifted(meeting.starts_at), ends_at: shifted(meeting.ends_at) };
  Object.assign(meeting, fields);
  renderBoard();
  await write(() => state.store.saveMeeting(id, fields), "That meeting didn't move, so it has gone back. Check your connection and try again.");
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
    w.height = Math.min(w.height, 620);
    placeWindow(w);
    buildMeetingWindow(w);
    renderMeetingWindow(w);
  }
  showWindow(w);
}

function buildMeetingWindow(w) {
  w.body.append(
    el("span", { class: "meeting-status", "data-meeting-status": true }),
    el("p", { class: "meeting-completed", "data-meeting-completed": true, hidden: true }),
    el("p", { class: "meeting-goal", "data-meeting-goal": true, hidden: true }),
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
    // What was said and decided, as the people in the meeting write it down. Separate from
    // the Notes the meeting was set with, which say what it's about.
    section("Meeting notes",
      el("p", { class: "hint", "data-notes-hint": true, hidden: true }),
      el("ul", { class: "activity-list note-list", "data-list": "notes" }),
      el("form", { class: "win-form", "data-form": "add-note", novalidate: true },
        textInput({ maxlength: "1000", placeholder: "Add a note from the meeting", "aria-label": "New meeting note", "data-input": "note" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Add note"))),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "meeting-actions", "data-list": "actions" }));
  w.body.querySelector('[data-list="notes"]').closest("section").dataset.notesSection = "";
  w.body.addEventListener("submit", (event) => {
    const form = event.target.dataset.form;
    if (form === "add-note") return addMeetingNote(w, event);
    if (form === "edit-note") return saveMeetingNote(w, event);
    return addMeetingPerson(w, event);
  });
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

  // Once it's completed: who by, and when.
  const done = isCompleted(m);
  const completed = w.body.querySelector("[data-meeting-completed]");
  completed.hidden = !done;
  completed.textContent = done
    ? `Completed by ${personKey(m.completed_by) === personKey(state.name) ? "you" : m.completed_by} on ${formatDay(new Date(m.completed_at))}`
    : "";

  // What the meeting is for. One set before goals were asked for has none to show.
  const goal = w.body.querySelector("[data-meeting-goal]");
  goal.hidden = !m.goal;
  goal.replaceChildren(...(m.goal ? [el("span", { class: "meeting-goal-label" }, "Goal"), m.goal] : []));

  const start = new Date(m.starts_at), end = new Date(m.ends_at);
  const day = repeats(m) ? capitalize(repeatPhrase(m.repeat, start)) : formatDay(start);
  w.body.querySelector("[data-meeting-when]").textContent = `${day}, ${formatTime(start)} to ${formatTime(end)}`;
  const next = w.body.querySelector("[data-meeting-next]");
  next.hidden = !repeats(m) || done;
  next.textContent = repeats(m) && !done ? `Next: ${formatDay(nextOccurrence(m))}` : "";
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
  w.body.querySelector('[data-form="add-person"]').hidden = !(organizer || mine) || done;

  // Its notes, oldest first, as a record of the meeting. The people in it can add one,
  // completed or not, and whoever wrote one can edit or delete it. While one is being
  // edited the list is left as it is, as a task's updates are.
  const inIt = organizer || !!mine;
  const posted = m.meeting_notes || [];
  const hint = w.body.querySelector("[data-notes-hint]");
  hint.hidden = !task || !inIt;
  hint.textContent = task ? `Notes also go to the updates of ${task.title}, tagged Meeting Notes.` : "";
  renderList(w, "notes", w.editingNote ? ["editing", w.editingNote] : posted.map((n) => [n.id, n.body, n.created_by, n.edited_at, n.on_task, timeAgo(n.created_at), state.name]), () =>
    posted.length ? posted.map((n) => (w.editingNote === n.id
      ? el("li", { class: "is-editing", "data-note": n.id }, noteEditForm(n))
      : el("li", { "data-note": n.id },
        el("strong", {}, n.created_by), " ",
        el("span", { class: "activity-time" }, timeAgo(n.created_at)),
        editedMark(n.edited_at),
        personKey(n.created_by) === personKey(state.name) && ownActions("note", n.id),
        el("span", { class: "activity-note" }, n.body),
        n.on_task && el("span", { class: "win-meta note-on-task", "data-on-task": true }, "Also in the task's updates")))) : [el("li", { class: "win-empty" }, "No notes yet.")]);
  w.body.querySelector('[data-form="add-note"]').hidden = !inIt;

  // A completed meeting has nothing left to answer. Whoever set it can reopen it.
  renderList(w, "actions", [organizer, mine?.answer, done], () => [
    !done && mine?.answer === "waiting" && el("button", { class: "btn btn-accept", type: "button", "data-answer": "accepted" }, "Accept"),
    !done && mine?.answer === "waiting" && el("button", { class: "btn btn-decline", type: "button", "data-answer": "declined" }, "Decline"),
    !done && mine?.answer === "accepted" && el("span", { class: "win-meta" }, "You accepted. ",
      el("button", { class: "link-btn", type: "button", "data-answer": "declined" }, "Change to declined")),
    !done && mine?.answer === "declined" && el("span", { class: "win-meta" }, "You declined. ",
      el("button", { class: "link-btn", type: "button", "data-answer": "accepted" }, "Change to accepted")),
    organizer && !done && el("button", { class: "btn btn-accept", type: "button", "data-complete-meeting": true }, "Complete meeting"),
    organizer && done && el("button", { class: "btn btn-quiet", type: "button", "data-reopen-meeting": true }, "Reopen"),
    organizer && !done && el("button", { class: "btn btn-quiet", type: "button", "data-reschedule-meeting": true }, "Reschedule"),
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
  if (target.closest("[data-reschedule-meeting]")) return openReschedule(w.meetingId);
  const editNote = target.closest('[data-edit-own="note"]');
  if (editNote) return startNoteEdit(w, editNote.dataset.key);
  if (target.closest("[data-cancel-edit]")) return stopNoteEdit(w);
  const deleteNote = target.closest('[data-delete-own="note"]');
  if (deleteNote) return deleteMeetingNote(w, deleteNote);
  const cancel = target.closest("[data-cancel-meeting]");
  if (cancel) return cancelMeeting(w, cancel);
  const complete = target.closest("[data-complete-meeting], [data-reopen-meeting]");
  if (complete) return completeMeeting(w, complete, complete.hasAttribute("data-complete-meeting"));
}

// ---------- A meeting's notes ----------

// The box a note is edited in, with its words in it. Esc gives up the edit.
function noteEditForm(note) {
  const input = textInput({ maxlength: "1000", "aria-label": "Edit your note", "data-input": "text" });
  input.value = note.body;
  const cancel = el("button", { class: "btn btn-quiet", type: "button", "data-cancel-edit": true }, "Cancel");
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation(); // Esc here gives up the edit, not the whole window
    cancel.click();
  });
  const form = el("form", { class: "win-form", "data-form": "edit-note", novalidate: true },
    input, el("button", { class: "btn btn-primary", type: "submit" }, "Save"), cancel);
  form.dataset.key = note.id;
  return form;
}

function startNoteEdit(w, id) {
  w.editingNote = id;
  showWindowError(w, null);
  renderMeetingWindow(w);
  const box = w.body.querySelector('[data-form="edit-note"] [data-input="text"]');
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function stopNoteEdit(w) {
  const was = w.editingNote;
  w.editingNote = null;
  showWindowError(w, null);
  renderMeetingWindow(w);
  if (was) [...w.body.querySelectorAll('[data-edit-own="note"]')].find((b) => b.dataset.key === was)?.focus();
}

// A note goes on the meeting, and when the meeting is for a task it's posted as an update
// on that task too. The board does both; the page shows the note at once.
async function addMeetingNote(w, event) {
  event.preventDefault();
  const form = event.target;
  const input = form.querySelector('[data-input="note"]');
  const body = input.value.trim();
  if (!body) return input.focus();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const result = await write(() => state.store.addMeetingNote(w.meetingId, body), null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (!result.ok) {
    return showWindowError(w, result.error?.code === "not_in_meeting" ? "Only the people in this meeting can add notes to it." : "That note wasn't added. Check your connection and try again.");
  }
  const meeting = findMeeting(w.meetingId);
  const note = result.result;
  if (meeting && note && !(meeting.meeting_notes || []).some((n) => n.id === note.id)) meeting.meeting_notes = [...(meeting.meeting_notes || []), note];
  form.reset();
  showWindowError(w, null);
  renderMeetingWindow(w);
  input.focus();
}

async function saveMeetingNote(w, event) {
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.key;
  const box = form.querySelector('[data-input="text"]');
  const text = box.value.trim();
  if (!text) return box.focus();
  const note = (findMeeting(w.meetingId)?.meeting_notes || []).find((n) => n.id === id);
  // The same words: there's nothing to save.
  if (note && note.body === text) return stopNoteEdit(w);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const result = await write(() => state.store.editMeetingNote(id, text), null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (!result.ok) return showWindowError(w, ownPostError(result.error, "note", "saved"));
  if (note) Object.assign(note, { body: text, edited_at: new Date().toISOString() });
  stopNoteEdit(w);
}

// Deleting takes a second press. A note that's also an update on a task goes from there too.
async function deleteMeetingNote(w, button) {
  const id = button.dataset.key;
  if (!armButton(button, "Confirm?", "Delete")) return;
  button.disabled = true;
  const result = await write(() => state.store.deleteMeetingNote(id), null);
  button.disabled = false;
  if (!w.root.isConnected) return;
  if (!result.ok) return showWindowError(w, ownPostError(result.error, "note", "deleted"));
  const meeting = findMeeting(w.meetingId);
  if (meeting) meeting.meeting_notes = (meeting.meeting_notes || []).filter((n) => n.id !== id);
  showWindowError(w, null);
  renderMeetingWindow(w);
}

// Completing a meeting takes it out of what's waiting for an answer and out of My meetings,
// for everyone in it. It takes one click, since Reopen puts it back.
async function completeMeeting(w, button, done) {
  button.disabled = true;
  const result = await write(() => state.store.completeMeeting(w.meetingId, done), null);
  if (!w.root.isConnected) return;
  button.disabled = false;
  if (!result.ok) {
    return showWindowError(w, `That meeting wasn't ${done ? "completed" : "reopened"}. Check your connection and try again.`);
  }
  // Shown at once, rather than when the next read arrives.
  const meeting = findMeeting(w.meetingId);
  if (meeting && result.result) Object.assign(meeting, { completed_at: result.result.completed_at ?? null, completed_by: result.result.completed_by ?? null });
  showWindowError(w, null);
  renderBoard();
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

// ---------- Rescheduling a meeting ----------

// The time a meeting is being moved from: its own, or for a repeating one its next date.
function rescheduleFrom(m) {
  const start = repeats(m) ? nextOccurrence(m) : new Date(m.starts_at);
  return { start, end: new Date(start.getTime() + (new Date(m.ends_at) - new Date(m.starts_at))) };
}

// A repeating meeting is kept as its first date, so moving its next date means moving that.
// Moved by a few days, the whole series shifts by as many, as when it's dragged to another
// day. Moved further, that would leave an earlier date as the next one, so the series
// starts again from the date chosen.
function seriesStart(m, from, start, length) {
  const days = Math.round((parseDate(dayKey(start)) - parseDate(dayKey(from))) / 86400000);
  const first = new Date(m.starts_at);
  const shifted = new Date(first.getFullYear(), first.getMonth(), first.getDate() + days, start.getHours(), start.getMinutes());
  const next = nextOccurrence({ ...m, starts_at: shifted.toISOString(), ends_at: new Date(shifted.getTime() + length).toISOString() });
  return next.getTime() === start.getTime() ? shifted : start;
}

// The small window for moving a meeting to a new time in one step: when, why, and whether
// the people in it should answer again. Only whoever set the meeting is offered it, and
// not once the meeting is completed.
function openReschedule(id) {
  const meeting = findMeeting(id);
  if (!meeting || !isOrganizer(meeting) || isCompleted(meeting)) return;
  const key = `reschedule:${id}`;
  let w = state.windows.get(key);
  if (!w) {
    w = createWindow(key, "Reschedule");
    w.meetingId = id;
    w.isForm = true;
    w.width = Math.min(w.width, 420);
    w.height = Math.min(w.height, 580);
    placeWindow(w);
    buildRescheduleForm(w, meeting);
  }
  showWindow(w);
  w.body.querySelector('[data-input="date"]').focus();
}

function buildRescheduleForm(w, meeting) {
  const form = el("form", { class: "win-body", novalidate: true },
    el("p", { class: "remind-for" }, "Moving ", el("strong", {}, meeting.title)),
    el("p", { class: "hint", "data-reschedule-now": true }),
    field("New date", el("input", { class: "input", type: "date", "data-input": "date" })),
    el("div", { class: "field-row meeting-times" },
      field("Start", el("input", { class: "input", type: "time", "data-input": "start" })),
      field("End", el("input", { class: "input", type: "time", "data-input": "end" }))),
    el("p", { class: "hint", "data-reschedule-repeat": true, hidden: true }),
    field("Reason", textInput({ maxlength: "200", placeholder: "Why it's moving (optional)", "data-input": "reason" })),
    // With nobody invited there's nobody to ask.
    el("label", { class: "check", hidden: !meeting.people.length },
      el("input", { type: "checkbox", checked: true, "data-input": "again" }),
      el("span", { class: "check-text" }, "Ask everyone to answer again",
        el("span", { class: "hint" }, "Their answers were for the old time. Until someone accepts, only the people in it see the meeting."))),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "win-new-actions" }, el("button", { class: "btn btn-primary", type: "submit" }, "Reschedule")));
  w.body.replaceWith(form);
  w.body = form;

  const input = (name) => form.querySelector(`[data-input="${name}"]`);
  const from = rescheduleFrom(meeting);
  input("date").value = dayKey(from.start);
  input("start").value = clockValue(from.start);
  input("end").value = clockValue(from.end);

  // When the meeting is now, kept right if it changes while this window is open.
  w.showNow = () => {
    const m = findMeeting(w.meetingId);
    const now = rescheduleFrom(m);
    const times = `${formatTime(now.start)} to ${formatTime(now.end)}`;
    form.querySelector("[data-reschedule-now]").textContent = repeats(m)
      ? `It's now ${repeatPhrase(m.repeat, now.start)}, ${times}. Next: ${formatDay(now.start)}.`
      : `It's now on ${formatDay(now.start)}, ${times}.`;
  };
  w.showNow();

  // A repeating meeting moves as a whole, so this says what the date picked makes of it.
  const showRepeat = () => {
    const m = findMeeting(w.meetingId);
    const day = input("date").value && parseDate(input("date").value);
    const note = form.querySelector("[data-reschedule-repeat]");
    note.hidden = !m || !repeats(m) || !day;
    note.textContent = note.hidden ? "" : `It repeats, so every date moves with it: ${repeatPhrase(m.repeat, day)} from ${formatDay(day)}.`;
  };
  input("date").addEventListener("change", showRepeat);
  showRepeat();

  // A new start takes the end with it, so the meeting stays as long as it was.
  const minutes = (value) => { const [hours, mins] = value.split(":").map(Number); return hours * 60 + mins; };
  let length = minutes(input("end").value) - minutes(input("start").value);
  input("end").addEventListener("change", () => {
    const now = minutes(input("end").value) - minutes(input("start").value);
    if (now > 0) length = now;
  });
  input("start").addEventListener("change", () => {
    if (!input("start").value || !(length > 0)) return;
    const end = Math.min(minutes(input("start").value) + length, 23 * 60 + 59);
    input("end").value = `${pad2(Math.floor(end / 60))}:${pad2(end % 60)}`;
  });
  form.addEventListener("submit", (event) => submitReschedule(w, event));
}

async function submitReschedule(w, event) {
  event.preventDefault();
  const meeting = findMeeting(w.meetingId);
  if (!meeting) return;
  const input = (name) => w.body.querySelector(`[data-input="${name}"]`);
  const [date, from, to] = ["date", "start", "end"].map((name) => input(name).value);
  if (!date || !from || !to) return fieldError(w, "Choose a date, a start and an end.", !date ? "date" : from ? "end" : "start");
  if (to <= from) return fieldError(w, "The meeting has to end after it starts.", "end");
  const start = new Date(`${date}T${from}`), end = new Date(`${date}T${to}`);
  const now = rescheduleFrom(meeting);
  if (start.getTime() === now.start.getTime() && end.getTime() === now.end.getTime()) return fieldError(w, "That's the time it already has.", "date");
  if (!(start > new Date())) return fieldError(w, "Choose a time that's still to come.", "date");
  showWindowError(w, null);

  const first = repeats(meeting) ? seriesStart(meeting, now.start, start, end - start) : start;
  const fields = { starts_at: first.toISOString(), ends_at: new Date(first.getTime() + (end - start)).toISOString() };
  const askAgain = meeting.people.length > 0 && input("again").checked;
  const button = w.body.querySelector('button[type="submit"]');
  button.disabled = true;
  const saved = await write(() => state.store.rescheduleMeeting(meeting.id, fields.starts_at, fields.ends_at, input("reason").value.trim(), askAgain), null);
  button.disabled = false;
  if (!saved.ok) {
    const code = saved.error?.code;
    if (code === "meeting_in_past") return fieldError(w, "Choose a time that's still to come.", "date");
    if (code === "invalid_meeting_time") return fieldError(w, "The meeting has to end after it starts.", "end");
    return showWindowError(w, code === "meeting_completed" ? "This meeting is completed. Reopen it to reschedule it."
      : code === "not_organizer" ? "Only whoever set this meeting can reschedule it."
      : "That meeting wasn't rescheduled. Check your connection and try again.");
  }

  // Shown at once, rather than when the next read arrives.
  const moved = findMeeting(meeting.id);
  if (moved) {
    Object.assign(moved, fields);
    if (askAgain) moved.people.forEach((p) => { p.answer = "waiting"; });
  }
  closeWindow(w);
  state.weekStart = startOfWeek(start); // the Calendar goes to the week the meeting is in now
  renderBoard();
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
    w.height = Math.min(w.height, meeting ? 756 : 896);
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
    // What the meeting is for. Every meeting has to say, and the board checks it too.
    field("Goal", textInput({ maxlength: "500", placeholder: "What should it decide or get done?", "data-input": "goal" })),
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
  input("goal").value = meeting?.goal || "";
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
  const fail = (message, name) => fieldError(w, message, name);
  const [title, goal, date, start, end] = ["title", "goal", "date", "start", "end"].map(value);
  if (!title) return fail("Give the meeting a title.", "title");
  if (!goal) return fail("Give the meeting a goal.", "goal");
  if (!date) return fail("Choose a date.", "date");
  if (!start || !end) return fail("Choose a start and end time.", start ? "end" : "start");
  if (end <= start) return fail("The meeting has to end after it starts.", "end");
  showWindowError(w, null);

  const fields = {
    title,
    goal,
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
  if (!saved.ok) {
    if (saved.error?.code === "meeting_goal_required") return fail("Give the meeting a goal.", "goal");
    return showWindowError(w, "That meeting didn't save. Check your connection and try again.");
  }

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
    .filter((task) => isIn(task, projectId)) // the tasks mirrored in as well: their updates are this project's too
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

// ---------- People: your own subtasks ----------

// The People page has two tabs: everyone's workload, and this person's own subtasks. The
// tab last used is the one it opens on next time, on this device.
const PEOPLE_VIEW_KEY = "board.peopleView";
const PEOPLE_VIEWS = ["load", "tasks", "subtasks"];
state.peopleView = PEOPLE_VIEWS.includes(readStorage("localStorage", PEOPLE_VIEW_KEY)) ? readStorage("localStorage", PEOPLE_VIEW_KEY) : "load";

function setPeopleView(view) {
  state.peopleView = view;
  state.focusNote = null;
  writeStorage("localStorage", PEOPLE_VIEW_KEY, view === "load" ? null : view);
  renderPeoplePage();
}

$("people-tab-load").addEventListener("click", () => setPeopleView("load"));
$("people-tab-tasks").addEventListener("click", () => setPeopleView("tasks"));
$("people-tab-subtasks").addEventListener("click", () => setPeopleView("subtasks"));

// Every subtask assigned to this person, in every project: what's still to do under the
// project and the task it belongs to, in the board's order, and what's done folded away.
function renderMySubtasks() {
  const me = personKey(state.name);
  const mine = tasksInOrder().filter((t) => t.parent_id && t.assignees.some((name) => personKey(name) === me));
  const pending = mine.filter((t) => t.status !== "done");
  const done = mine.filter((t) => t.status === "done");
  const overdue = pending.filter((t) => t.deadline && daysUntil(t.deadline) < 0).length;
  const today = pending.filter((t) => t.deadline && daysUntil(t.deadline) === 0).length;
  $("people-summary").textContent = [`${pending.length} pending`, overdue && `${overdue} overdue`, today && `${today} due today`].filter(Boolean).join(" · ");

  // What each subtask shows, grouped by project, then by the task it's part of.
  const grouped = (subtasks) => {
    const projects = [];
    for (const s of subtasks) {
      const parent = findTask(s.parent_id);
      const projectId = parent?.project_id ?? s.project_id ?? "";
      let project = projects.find((p) => p.id === projectId);
      if (!project) projects.push(project = { id: projectId, name: state.projects.find((p) => p.id === projectId)?.name || "No project", tasks: [] });
      let task = project.tasks.find((t) => t.id === s.parent_id);
      if (!task) project.tasks.push(task = { id: s.parent_id, title: parent?.title || "", about: parent ? [assigneeText(parent), STATUS[parent.status]].filter(Boolean).join(" · ") : "", subtasks: [] });
      const reminder = myReminder(s.id);
      task.subtasks.push({
        id: s.id, title: s.title, urgency: s.urgency, done: s.status === "done",
        // On a subtask several people are on, whether this person is the main or supporting, and whom.
        about: [roleOn(s, me), STATUS[s.status], `${s.progress}%`].filter(Boolean).join(" · "),
        due: s.status === "done" ? null : deadlineNote(s),
        reminder: reminder ? reminderWhen(reminder) : null,
      });
    }
    return projects;
  };
  const view = { pending: grouped(pending), done: grouped(done), doneCount: done.length };

  // Only rebuilds when something shows differently, so the Done group and keyboard focus survive a refresh.
  const box = $("my-subtasks");
  const signature = JSON.stringify(view);
  if (box.dataset.sig === signature) return;
  const doneOpen = !!box.querySelector(".mine-done")?.open;
  box.dataset.sig = signature;
  const groups = (projects) => projects.map((project) => el("section", { class: "subtask-group", "data-subtask-project": project.id },
    el("h2", { class: "subtask-project" }, project.name),
    ...project.tasks.map((task) => el("div", { class: "subtask-task", "data-subtask-task": task.id },
      el("p", { class: "subtask-parent" }, "In ",
        el("button", { class: "link-btn", type: "button", "data-open-task": task.id }, task.title), " ",
        el("span", { class: "win-meta" }, task.about)),
      el("ul", { class: "win-list subtask-list" }, ...task.subtasks.map((s) => el("li", { class: "win-item", "data-subtask": s.id },
        el("input", { type: "checkbox", "data-done": s.id, checked: s.done, "aria-label": `Mark ${s.title} done` }),
        el("span", { class: `dot dot-${s.urgency}`, role: "img", "aria-label": `${URGENCY[s.urgency]} urgency`, title: `${URGENCY[s.urgency]} urgency` }),
        el("span", { class: "win-item-main" },
          el("button", { class: `link-btn${s.done ? " subtask-done" : ""}`, type: "button", "data-open-task": s.id }, s.title)),
        el("span", { class: "win-meta" }, s.about),
        s.due && el("span", { class: `due-note due-${s.due.tone}` }, s.due.text),
        !s.done && reminderButton(findTask(s.id)))))))));
  box.replaceChildren(...[
    el("p", { class: "hint my-subtasks-hint" }, "The subtasks assigned to you, in every project. Tick one when it's done."),
    ...(view.pending.length
      ? groups(view.pending)
      : [el("p", { class: "win-empty" }, done.length ? "Nothing pending." : "You have no subtasks. One shows here once it's assigned to you.")]),
    done.length > 0 && el("details", { class: "mine-done", open: doneOpen },
      el("summary", {}, `Done (${done.length})`),
      ...groups(view.done)),
  ].filter(Boolean));
}

$("my-subtasks").addEventListener("click", (event) => {
  const remind = event.target.closest("[data-remind]");
  if (remind) return openReminder(remind.dataset.remind);
  const task = event.target.closest("[data-open-task]");
  if (task) openTask(task.dataset.openTask);
});
$("my-subtasks").addEventListener("change", (event) => {
  const box = event.target.closest("[data-done]");
  if (box) updateTask(box.dataset.done, { status: box.checked ? "done" : "todo" });
});

// ---------- People: your own tasks, and the three you're focusing on ----------

// Each person can tag up to three of their tasks as the ones they're putting first, and
// everyone sees them: on the person's card, and on each task. The board keeps them.
const MAX_FOCUS = 3;
const bySetAt = (a, b) => a.set_at.localeCompare(b.set_at);
// A person's focus tasks, in the order they tagged them.
const focusIdsOf = (key) => (state.focus || []).filter((f) => key && f.person_key === key).sort(bySetAt).map((f) => f.task_id).filter((id) => findTask(id));
// Whose focus task this is, by name, in the order they tagged it.
const focusNames = (taskId) => (state.focus || []).filter((f) => f.task_id === taskId).sort(bySetAt).map((f) => f.name);

// Every task assigned to this person, main or supporting, in every project: the ones they're
// focusing on, then all that are open, the most urgent first and then the soonest due, and
// what's done folded away. Subtasks have a tab of their own.
function renderMyTasks() {
  const me = personKey(state.name);
  const rank = (t) => URGENCY_ORDER.indexOf(t.urgency);
  const mostUrgentFirst = (a, b) => rank(a) - rank(b) || (a.deadline || "9999").localeCompare(b.deadline || "9999") || a.title.localeCompare(b.title);
  const mine = state.tasks.filter((t) => !t.parent_id && t.assignees.some((name) => personKey(name) === me));
  const open = mine.filter((t) => t.status !== "done").sort(mostUrgentFirst);
  const done = mine.filter((t) => t.status === "done").sort((a, b) => String(b.done_at || "").localeCompare(String(a.done_at || "")));
  const focus = focusIdsOf(me).filter((id) => open.some((t) => t.id === id));
  const overdue = open.filter((t) => t.deadline && daysUntil(t.deadline) < 0).length;
  const today = open.filter((t) => t.deadline && daysUntil(t.deadline) === 0).length;
  $("people-summary").textContent = [`${open.length} open`, overdue && `${overdue} overdue`, today && `${today} due today`, `${focus.length} of ${MAX_FOCUS} focus`].filter(Boolean).join(" · ");

  const rowView = (t) => ({
    id: t.id,
    title: t.title,
    urgency: t.urgency,
    done: t.status === "done",
    focus: focus.includes(t.id),
    // On a task several people are on, whether this person is the main or supporting, and whom.
    about: [URGENCY[t.urgency], state.projects.find((p) => p.id === t.project_id)?.name, roleOn(t, me), STATUS[t.status], `${t.progress}%`].filter(Boolean).join(" · "),
    due: t.status === "done" ? null : deadlineNote(t),
  });
  const view = { focus: focus.map((id) => rowView(findTask(id))), open: open.map(rowView), done: done.map(rowView), note: state.focusNote };

  // Only rebuilds when something shows differently, so the Done group and keyboard focus survive a refresh.
  const box = $("my-tasks");
  const signature = JSON.stringify(view);
  if (box.dataset.sig === signature) return;
  const doneOpen = !!box.querySelector(".mine-done")?.open;
  box.dataset.sig = signature;
  const row = (t) => el("li", { class: `my-task${t.focus ? " is-focus" : ""}${t.done ? " is-done" : ""}`, "data-my-task": t.id },
    !t.done && el("button", {
      class: "focus-star",
      type: "button",
      "data-focus": t.id,
      "aria-pressed": String(t.focus),
      "aria-label": t.focus ? `Take ${t.title} off your focus tasks` : `Make ${t.title} a focus task`,
      title: t.focus ? "A focus task. Press to take it off" : "Make this a focus task",
    }, t.focus ? "★" : "☆"),
    el("span", { class: `dot dot-${t.urgency}`, role: "img", "aria-label": `${URGENCY[t.urgency]} urgency`, title: `${URGENCY[t.urgency]} urgency` }),
    el("span", { class: "my-task-main" },
      el("button", { class: `link-btn${t.done ? " subtask-done" : ""}`, type: "button", "data-open-task": t.id }, t.title),
      el("span", { class: "win-meta" }, t.about)),
    t.due && el("span", { class: `due-note due-${t.due.tone}` }, t.due.text));
  box.replaceChildren(...[
    el("section", { class: "focus-box", "data-focus-list": true },
      el("h2", { class: "focus-head" }, "★ Focus", el("span", { class: "focus-count" }, `${view.focus.length} of ${MAX_FOCUS}`)),
      view.focus.length
        ? el("ol", { class: "my-task-list" }, ...view.focus.map(row))
        : el("p", { class: "win-empty" }, "No focus tasks yet. Star up to three of your tasks below: the ones you're putting first. Everyone on the board sees them."),
      el("p", { class: "focus-note", role: "alert", "data-focus-note": true, hidden: !view.note }, view.note || "")),
    el("section", { class: "my-tasks-all", "data-task-list": true },
      el("h2", { class: "subtask-project" }, `All my tasks (${view.open.length})`),
      view.open.length
        ? el("ul", { class: "my-task-list" }, ...view.open.map(row))
        : el("p", { class: "win-empty" }, view.done.length ? "Nothing open." : "You have no tasks. One shows here once it's assigned to you. Subtasks are on their own tab.")),
    view.done.length > 0 && el("details", { class: "mine-done", open: doneOpen },
      el("summary", {}, `Done (${view.done.length})`),
      el("ul", { class: "my-task-list" }, ...view.done.map(row))),
  ].filter(Boolean));
}

// Starring shows at once, and the board's answer follows: if it's refused, the star goes
// back and the reason shows under the focus list.
const FOCUS_REFUSED = {
  focus_full: "You can have three focus tasks. Take one off first.",
  not_assigned: "That task isn't assigned to you any more.",
  task_done: "That task is done, so it can't be a focus task.",
  not_a_task: "A focus task is a task, not a subtask.",
};
async function toggleFocus(button) {
  const id = button.dataset.focus;
  const on = button.getAttribute("aria-pressed") !== "true";
  const me = personKey(state.name);
  if (on && focusIdsOf(me).length >= MAX_FOCUS) {
    state.focusNote = FOCUS_REFUSED.focus_full;
    return renderMyTasks();
  }
  state.focusNote = null;
  const before = state.focus;
  state.focus = on
    ? [...state.focus, { task_id: id, person_key: me, name: state.name, set_at: new Date().toISOString() }]
    : state.focus.filter((f) => !(f.person_key === me && f.task_id === id));
  renderBoard();
  // The list was redrawn, so the keyboard goes back to that task's star in the full list.
  $("my-tasks").querySelector(`[data-task-list] [data-focus="${CSS.escape(id)}"]`)?.focus();
  const result = await write(() => state.store.setFocus(id, on), null);
  if (!result.ok && result.error) {
    state.focus = before;
    state.focusNote = FOCUS_REFUSED[result.error.code] || "That didn't save. Check your connection and try again.";
    renderBoard();
  }
}

$("my-tasks").addEventListener("click", (event) => {
  const star = event.target.closest("[data-focus]");
  if (star) return toggleFocus(star);
  const task = event.target.closest("[data-open-task]");
  if (task) openTask(task.dataset.openTask);
});

function renderPeoplePage() {
  if ($("people-view").hidden) return;
  // The workload, this person's tasks and their subtasks share the page: one shows, and the
  // workload's key goes with it.
  const showing = state.peopleView;
  for (const name of PEOPLE_VIEWS) $(`people-tab-${name}`).setAttribute("aria-pressed", String(showing === name));
  $("my-tasks").hidden = showing !== "tasks";
  $("my-subtasks").hidden = showing !== "subtasks";
  $("people-cards").hidden = showing !== "load";
  document.querySelector(".people-hint").hidden = showing !== "load";
  if (showing === "tasks") return renderMyTasks();
  if (showing === "subtasks") return renderMySubtasks();
  const { open, cards } = workload();
  const urgent = open.filter((t) => t.urgency === "critical" || t.urgency === "high").length;
  const unassigned = open.filter((t) => !t.assignees.length).length;
  $("people-summary").textContent = [`${open.length} open`, `${urgent} urgent`, unassigned && `${unassigned} unassigned`].filter(Boolean).join(" · ");

  // Bars are measured against the busiest person, so the longest bar is the biggest load.
  const most = Math.max(1, ...cards.map((c) => c.tasks.length));
  const me = personKey(state.name);
  const cardsView = cards.map((c) => {
    const focus = focusIdsOf(c.key);
    const place = (t) => (focus.includes(t.id) ? focus.indexOf(t.id) : focus.length);
    return { ...c, focus, tasks: [...c.tasks].sort((a, b) => place(a) - place(b)) };
  });
  const view = cardsView.map((c) => ({
    key: c.key,
    name: c.key === me ? `${c.name} (you)` : c.name,
    focus: c.focus.filter((id) => c.tasks.some((t) => t.id === id)).length,
    person: c.key ? c.name : null,
    count: c.tasks.length,
    urgent: c.urgent,
    levels: c.levels,
    overdue: c.overdue,
    done: c.done,
    width: Math.round((c.tasks.length / most) * 100),
    // On a task several people are on, whether this person is the main or supporting, and whom.
    tasks: c.tasks.map((t) => ({ id: t.id, title: t.title, urgency: t.urgency, focus: c.focus.includes(t.id), about: [roleOn(t, c.key), taskPlace(t), STATUS[t.status], `${t.progress}%`].filter(Boolean).join(" · "), due: deadlineNote(t) })),
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
        c.focus > 0 && el("span", { class: "person-focus", title: `${c.focus} focus ${c.focus === 1 ? "task" : "tasks"}` }, `★ ${c.focus} focus`), " ",
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
        ? el("ul", { class: "person-tasks" }, ...c.tasks.map((t) => el("li", { class: `person-task${t.focus ? " is-focus" : ""}`, "data-person-task": t.id },
          t.focus && el("span", { class: "focus-mark", role: "img", "aria-label": "Focus task", title: "Focus task" }, "★"),
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
    const headline = `${n.by_name} ${MEETING_NOTICE[n.action]}`;
    // A reschedule says when the meeting is now, and the reason given, if any.
    if (n.action === "rescheduled") return [headline, [n.title, `now ${when}`], n.detail ? `“${n.detail}”` : null];
    // An edit says what changed. A notice from before edits said that was only ever sent
    // for a new time, place or repeat, and reads as it did.
    if (n.action === "changed") return [headline, [n.title, n.detail ? when : `now ${when}`], n.detail ? capitalize(n.detail) : null];
    return [headline, [n.title, when]];
  }
  const where = [n.title, n.parent_title && `in ${n.parent_title}`, n.project_name];
  // One this person set for themselves, with the note they wrote.
  if (n.action === "reminder") return ["Reminder you set", where, n.detail ? `“${n.detail}”` : null];
  // Someone has seen an update this person posted, and said so.
  if (n.action === "liked") return [`${n.by_name} acknowledged your update`, where, `“${String(n.detail || "")}”`];
  if (n.action === "mentioned" || n.action === "mentioned_update") {
    return [`${n.by_name} mentioned you in ${n.action === "mentioned" ? "a comment" : "an update"}`, where, `“${String(n.detail || "")}”`];
  }
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
  if (n.action !== "deleted") {
    // On a task several people are on, what this person is on it now: the main, or support.
    const role = roleOn(findTask(n.task_id) || { assignees: [] }, personKey(state.name));
    return [`${n.by_name} assigned you a ${n.kind}${role === "Main" ? " as the main assignee" : role ? ` to support ${role.slice("Supporting ".length)}` : ""}`, where];
  }
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
    : [el("li", { class: "notify-empty" }, "Nothing yet. Assignments, changes to your tasks, mentions in updates and comments, updates of yours that were acknowledged, reminders you set, meeting invites, reminders for tasks that are due and meetings about to start, and deletions of things you created show up here.")]));
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
  // A mention opens the task at the section it was made in, and a like at the updates.
  const mentionedIn = { mentioned: "comments", mentioned_update: "updates", liked: "updates" }[state.notifications.find((n) => n.id === item.dataset.notification)?.action];
  markNotificationsRead([item.dataset.notification]);
  // On a phone the list is its own page, so leave it up when there's nothing to go to.
  if (!isPhone() || findTask(item.dataset.task) || findMeeting(item.dataset.openMeeting)) closeNotifications();
  openTask(item.dataset.task);
  if (mentionedIn) showSection(item.dataset.task, mentionedIn);
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

// ---------- A newer version of the board ----------

// The page is a few files. When newer ones are published, a page that's already open keeps
// running the old ones until it's reloaded, so it looks now and then and offers the update.
// Every publish gives every file a new tag whether or not it changed, so a new tag only
// means it's worth looking: what counts is whether the file is different from the copy this
// page is running.
const WATCHED_FILES = [location.pathname + location.search, "app.js", "styles.css"];
const UPDATE_CHECK_MS = 5 * 60000;
const UPDATE_LABEL = "Update available";
const versions = new Map(); // file -> what this page runs, the tag last compared, and whether it has changed since
let lastUpdateCheck = 0;

const fileTag = (response) => (response.headers.get("etag") || response.headers.get("last-modified") || "").replace(/^W\//, "");
function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

// What this page is running: the browser's own kept copies, which are the ones it loaded.
async function noteRunningVersion() {
  for (const file of WATCHED_FILES) {
    try {
      const response = await fetch(file, { cache: "force-cache" });
      if (response.ok) versions.set(file, { running: fingerprint(await response.text()), tag: fileTag(response), outdated: false });
    } catch { /* offline: this file isn't watched until the page is next loaded */ }
  }
}

async function checkForUpdate() {
  lastUpdateCheck = Date.now();
  for (const [file, version] of versions) {
    try {
      const head = await fetch(file, { method: "HEAD", cache: "no-store" });
      if (!head.ok) continue;
      const tag = fileTag(head);
      if (tag && tag === version.tag) continue; // nothing published since this file was last compared
      const response = await fetch(file, { cache: "no-store" });
      if (!response.ok) continue;
      version.outdated = fingerprint(await response.text()) !== version.running;
      version.tag = fileTag(response) || tag;
    } catch { /* couldn't reach it: the next look will */ }
  }
  renderUpdateOffer();
}

function renderUpdateOffer() {
  const ready = [...versions.values()].some((version) => version.outdated);
  $("update-btn").hidden = !ready;
  $("gate-update").hidden = !ready;
}

function reloadPage() {
  location.reload();
}

// Loads the newer version. A form that's open and not yet saved would go with the reload,
// so that's asked about first. The files are fetched fresh before reloading, or the
// browser would reload from the copies it has kept and nothing would change.
async function applyUpdate(button, label) {
  const formOpen = [...state.windows.values()].some((w) => w.body.tagName === "FORM");
  if (formOpen && !armButton(button, "A form is open. Update anyway?", label)) return;
  button.disabled = true;
  button.textContent = "Updating…";
  await Promise.all([...WATCHED_FILES, "config.js"].map((file) => fetch(file, { cache: "reload" }).catch(() => null)));
  reloadPage();
}

$("update-btn").addEventListener("click", () => applyUpdate($("update-btn"), UPDATE_LABEL));
$("gate-update-btn").addEventListener("click", () => applyUpdate($("gate-update-btn"), "Update now"));

const updateReady = noteRunningVersion().then(checkForUpdate);
setInterval(() => {
  if (!document.hidden && Date.now() - lastUpdateCheck >= UPDATE_CHECK_MS) checkForUpdate();
}, 60000);
// Coming back to the tab is when a waiting update is most worth knowing about.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastUpdateCheck >= 60000) checkForUpdate();
});

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
