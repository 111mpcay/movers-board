"use strict";

const STATUS = { todo: "To do", doing: "In progress", done: "Done" };
const URGENCY = { low: "Low", normal: "Normal", high: "High", critical: "Critical" };
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

const state = {
  store: null,
  tasks: [],
  notifications: [],
  people: [],
  version: -1,
  name: "",
  dragging: false,
  lastDrop: 0,
  writes: 0, // bumps on every change so a slower, older read can't undo it
  pollTimer: null,
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

function readStorage(area, key) {
  try { return window[area].getItem(key); } catch { return null; }
}
function writeStorage(area, key, value) {
  try {
    if (value == null) window[area].removeItem(key);
    else window[area].setItem(key, value);
  } catch { /* private window: the page still works, it just won't remember */ }
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
    if ((task[key] ?? "") !== (value ?? "")) diff[key] = value;
  }
  return diff;
}

const findTask = (id) => state.tasks.find((t) => t.id === id);
const subtasksOf = (id) => state.tasks.filter((t) => t.parent_id === id).sort((a, b) => a.position - b.position);

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
    enter: (pin, name) => rpc("movers_enter_board", { p_pin: pin, p_name: name }),
    list: (version) => rpc("movers_list_tasks", { p_token: token, p_version: version }),
    // Sends only the fields that changed, so two people editing different
    // fields of the same task don't overwrite each other.
    save: (id, fields) => rpc("movers_save_task", { p_token: token, p_id: id, p_fields: fields }),
    move: (id, position) => rpc("movers_move_task", { p_token: token, p_id: id, p_position: position }),
    addUpdate: (id, text) => rpc("movers_add_task_update", { p_token: token, p_id: id, p_text: text }),
    remove: (id) => rpc("movers_delete_task", { p_token: token, p_id: id }),
    addLink: (taskId, title, url) => rpc("movers_add_link", { p_token: token, p_task_id: taskId, p_title: title, p_url: url }),
    removeAttachment: (id) => rpc("movers_remove_attachment", { p_token: token, p_id: id }),
    markRead: (ids) => rpc("movers_mark_notifications_read", { p_token: token, p_ids: ids }),
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
  if (pin.length < 4) return showGateError("Enter all 4 digits of the PIN.", pinInputs[pin.length]);
  if (!name) return showGateError("Enter your name so the team can see who changed what.", $("name-input"));

  $("gate-error").hidden = true;
  $("gate-submit").disabled = true;
  try {
    const result = await state.store.enter(pin, name);
    if (result.ok) {
      writeStorage("localStorage", NAME_KEY, result.name);
      writeStorage("sessionStorage", SESSION_KEY, JSON.stringify({ token: result.token, name: result.name }));
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
  writeStorage("sessionStorage", SESSION_KEY, null);
  closeAllWindows();
  closeNotifications();
  state.tasks = [];
  state.notifications = [];
  state.people = [];
  state.version = -1;
  state.store.setToken(null);
  $("task-rows").replaceChildren();
  $("board-view").hidden = true;
  $("gate").hidden = false;
  $("name-input").value = readStorage("localStorage", NAME_KEY) || "";
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
  await refresh();
  startPolling();
}

$("leave-btn").addEventListener("click", () => showGate());

// ---------- The task list ----------

function dotSelect(field, value, options, label) {
  return el("span", { class: "dot-select" },
    el("span", { class: `dot dot-${value}`, "aria-hidden": "true" }),
    el("select", { class: "plain-select", "data-field": field, "aria-label": label },
      ...Object.entries(options).map(([key, text]) => el("option", { value: key, selected: key === value }, text))));
}

function cell(label, ...children) {
  return el("div", { class: "cell", role: "cell", "data-label": label }, ...children);
}

function subtaskSummary(task) {
  const subtasks = subtasksOf(task.id);
  if (!subtasks.length) return "";
  return ` · ${subtasks.filter((s) => s.status === "done").length}/${subtasks.length} subtasks`;
}

function rowSignature(task) {
  return JSON.stringify([
    task.title, task.assignee, task.urgency, task.deadline, task.status, task.progress,
    task.updated_by, timeAgo(task.updated_at), deadlineNote(task)?.text, subtaskSummary(task),
  ]);
}

function renderRow(task) {
  const note = deadlineNote(task);
  const progress = el("input", {
    class: "progress-range",
    type: "range",
    min: "0",
    max: "100",
    step: "5",
    value: task.progress,
    style: `--p: ${task.progress}%`,
    "data-field": "progress",
    "aria-label": `Progress of ${task.title}`,
  });
  const row = el("div", { class: "task-row", role: "row", "data-id": task.id, "data-sig": rowSignature(task) },
    el("div", { class: "task-cell", role: "cell" },
      el("span", { class: "grip", "aria-hidden": "true" }),
      el("div", { class: "task-text" },
        el("button", { class: "task-title", type: "button" }, task.title),
        el("div", { class: "task-meta" }, `${task.updated_by} · ${timeAgo(task.updated_at)}${subtaskSummary(task)}`))),
    cell("Assign", el("input", {
      class: "cell-input assign-input",
      type: "text",
      maxlength: "60",
      list: "people-list",
      placeholder: "Assign",
      value: task.assignee || "",
      autocomplete: "off",
      "data-field": "assignee",
      "aria-label": `Who ${task.title} is assigned to`,
    })),
    cell("Urgency", dotSelect("urgency", task.urgency, URGENCY, `Urgency of ${task.title}`)),
    cell("Deadline",
      el("input", {
        class: "cell-input date-input",
        type: "date",
        value: task.deadline || "",
        "data-field": "deadline",
        "aria-label": `Deadline of ${task.title}`,
      }),
      note && el("span", { class: `due-note due-${note.tone}` }, note.text)),
    cell("Status", dotSelect("status", task.status, STATUS, `Status of ${task.title}`)),
    el("div", { class: "cell cell-progress", role: "cell", "data-label": "Progress" },
      el("div", { class: "progress-wrap" },
        el("output", { class: "progress-label" }, `${task.progress}%`),
        progress)));
  return row;
}

function renderSummary() {
  const open = state.tasks.filter((t) => !t.parent_id && t.status !== "done");
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
    for (const name of [task.assignee, task.created_by, task.updated_by]) {
      if (name) names.add(name);
    }
  }
  $("people-list").replaceChildren(...[...names].sort().map((name) => el("option", { value: name })));
}

// Updates rows in place so someone mid-edit keeps their cursor when another
// person's change arrives. The row being edited catches up when they leave it.
function renderRows() {
  const list = $("task-rows");
  const focused = document.activeElement;
  const activeRow = focused?.closest?.(".task-row") || null;
  const tasks = state.tasks.filter((t) => !t.parent_id).sort((a, b) => a.position - b.position);
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
  renderRows();
  renderSummary();
  renderPeople();
  renderNotifications();
  renderWindows();
}

function refreshRow(id, focusField) {
  const row = $("task-rows").querySelector(`[data-id="${CSS.escape(id)}"]`);
  const task = findTask(id);
  if (!row || !task) return;
  const fresh = renderRow(task);
  row.replaceWith(fresh);
  if (focusField) fresh.querySelector(`[data-field="${focusField}"]`)?.focus();
}

async function updateTask(id, changes, focusField) {
  const task = findTask(id);
  if (!task) return;
  const diff = onlyChanged(task, linkStatusAndProgress(task, changes));
  if (!Object.keys(diff).length) return;

  // Show the change straight away; the next read confirms it.
  Object.assign(task, diff, { updated_by: state.name, updated_at: new Date().toISOString() });
  refreshRow(id, focusField);
  renderSummary();
  renderWindows();
  await write(() => state.store.save(id, diff), "That change didn't save, so it has been undone. Check your connection and try again.");
}

function fieldValue(control) {
  const field = control.dataset.field;
  if (field === "progress") return Number(control.value);
  if (field === "deadline") return control.value || null;
  if (field === "assignee" || field === "title" || field === "details") return control.value.trim();
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
  const control = event.target.closest("[data-field]");
  if (!control) return;
  const field = control.dataset.field;
  updateTask(control.closest(".task-row").dataset.id, { [field]: fieldValue(control) }, field);
});

rows.addEventListener("input", previewProgress);

rows.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.dataset.field === "assignee") {
    event.preventDefault();
    event.target.blur();
  }
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
  new window.Sortable(rows, {
    draggable: ".task-row",
    handle: ".task-cell",
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
    onEnd: handleDrop,
  });
}

async function handleDrop(event) {
  state.dragging = false;
  state.lastDrop = Date.now();
  document.body.classList.remove("is-dragging");
  if (event.oldIndex === event.newIndex) return;

  const id = event.item.dataset.id;
  const task = findTask(id);
  if (!task) return;

  const order = [...rows.children].map((row) => row.dataset.id);
  const index = order.indexOf(id);
  const before = findTask(order[index - 1]);
  const after = findTask(order[index + 1]);
  let position = 1000;
  if (before && after) position = (before.position + after.position) / 2;
  else if (before) position = before.position + 1000;
  else if (after) position = after.position - 1000;

  task.position = position;
  await write(() => state.store.move(id, position), "That move didn't save, so the row has gone back. Check your connection and try again.");
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
  const added = await write(() => state.store.save(null, { title }), "That task didn't save. Check your connection and try again.");
  $("quick-submit").disabled = false;
  if (added.ok) $("quick-title").value = "";
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
        state.tasks = result.tasks;
        state.notifications = result.notifications || [];
        state.people = result.people || [];
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
  if (!document.hidden && state.pollTimer) refresh();
});

// Keeps "5 min ago" and "Due today" correct on a list left open.
setInterval(() => {
  if (state.pollTimer && !state.dragging && !document.hidden) renderBoard();
}, 60000);

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
}

function createWindow(key, title) {
  const titleEl = el("span", { class: "win-title" }, title);
  const minimize = el("button", { class: "win-btn", type: "button", "aria-label": "Minimize" }, "–");
  const close = el("button", { class: "win-btn", type: "button", "aria-label": "Close" }, "×");
  const bar = el("header", { class: "win-bar" }, titleEl, minimize, close);
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

function taskFields() {
  return [
    field("Task", textInput({ maxlength: "200", "data-field": "title" })),
    field("Details", el("textarea", { class: "input", rows: "2", maxlength: "4000", "data-field": "details" })),
    el("div", { class: "field-row" },
      field("Assign to", textInput({ maxlength: "60", list: "people-list", "data-field": "assignee" })),
      field("Deadline", el("input", { class: "input", type: "date", "data-field": "deadline" }),
        el("span", { class: "due-note", "data-deadline-note": true }))),
    el("div", { class: "field-row" },
      field("Urgency", optionsSelect("urgency", URGENCY)),
      field("Status", optionsSelect("status", STATUS))),
  ];
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
  const parts = [
    isSubtask && el("p", { class: "win-parent" }, "Part of ", el("button", { class: "link-btn", type: "button", "data-open-task": task.parent_id }, "")),
    ...taskFields(),
    field("Progress", el("div", { class: "progress-wrap progress-wrap-large" },
      el("output", { class: "progress-label" }, "0%"),
      el("input", { class: "progress-range", type: "range", min: "0", max: "100", step: "5", "data-field": "progress" }))),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    !isSubtask && el("details", { class: "win-fold" },
      el("summary", { class: "win-heading" }, "Subtasks", el("span", { class: "win-count", "data-count": "subtasks" })),
      el("ul", { class: "win-list", "data-list": "subtasks" }),
      el("form", { class: "win-form", "data-form": "subtask", novalidate: true },
        textInput({ maxlength: "200", placeholder: "Add a subtask", "aria-label": "New subtask", "data-input": "title" }),
        textInput({ class: "input is-narrow", maxlength: "60", list: "people-list", placeholder: "Assign", "aria-label": "Assign the new subtask to", "data-input": "assignee" }),
        el("button", { class: "btn btn-primary", type: "submit" }, "Add"))),
    section("Updates",
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
  if (!list) return;
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

  for (const name of ["title", "details", "assignee", "deadline", "urgency", "status"]) {
    setFieldValue(w, name, task[name]);
  }
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

  const subtasks = subtasksOf(task.id);
  setCount(w, "subtasks", subtasks.length ? `${subtasks.filter((s) => s.status === "done").length}/${subtasks.length}` : "");
  renderList(w, "subtasks", subtasks.map((s) => [s.id, s.title, s.assignee, s.status, deadlineNote(s)?.text]), () =>
    subtasks.length ? subtasks.map((s) => {
      const due = deadlineNote(s);
      return el("li", { class: "win-item" },
        el("input", { type: "checkbox", "data-done": s.id, checked: s.status === "done", "aria-label": `Mark ${s.title} done` }),
        el("span", { class: "win-item-main" },
          el("button", { class: `link-btn${s.status === "done" ? " subtask-done" : ""}`, type: "button", "data-open-task": s.id }, s.title)),
        el("span", { class: "win-meta" }, s.assignee || "Unassigned"),
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
    if (!w.taskId) continue;
    if (findTask(w.taskId)) renderTaskWindow(w);
    else {
      closeWindow(w);
      if (!w.deleting) showSyncNote("A task you had open was deleted by someone else.");
    }
  }
}

function onWindowChange(w, event) {
  const control = event.target;
  if (control.dataset.field) {
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
    const assignee = input("assignee").value.trim();
    action = () => state.store.save(null, { title, assignee, parent_id: w.taskId });
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
  const file = target.closest("[data-file]");
  if (file) return openFile(w, file.dataset.file, file.dataset.mime);
  const remove = target.closest("[data-remove]");
  if (remove) return removeAttachment(w, remove);
  if (target.closest("[data-delete-task]")) return deleteTask(w, target.closest("[data-delete-task]"));
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
  const form = el("form", { class: "win-body", novalidate: true },
    ...taskFields(),
    el("p", { class: "form-error", role: "alert", "data-error": true, hidden: true }),
    el("div", { class: "win-new-actions" }, el("button", { class: "btn btn-primary", type: "submit" }, "Add task")));
  w.body.replaceWith(form);
  w.body = form;
  w.body.querySelector('[data-field="status"]').closest(".field").remove();
  w.body.querySelector('[data-field="urgency"]').value = "normal";
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
    details: value("details"),
    assignee: value("assignee"),
    deadline: value("deadline"),
    urgency: value("urgency"),
  };
  const button = w.body.querySelector('button[type="submit"]');
  button.disabled = true;
  const saved = await write(() => state.store.save(null, fields), null);
  button.disabled = false;
  if (!saved.ok) return showWindowError(w, "That task didn't save. Check your connection and try again.");

  const { x, y, width } = w;
  closeWindow(w);
  if (!findTask(saved.result.id)) state.tasks.push({ attachments: [], updates: [], ...saved.result });
  openTask(saved.result.id);
  const opened = state.windows.get(saved.result.id);
  Object.assign(opened, { x, y, width });
  placeWindow(opened);
}

$("add-btn").addEventListener("click", openNewTask);

// ---------- Notifications ----------

function renderNotifications() {
  const unread = state.notifications.filter((n) => !n.read_at).length;
  $("notify-count").textContent = unread;
  $("notify-count").hidden = !unread;
  $("notify-btn").setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
  $("notify-read-all").hidden = !unread;
  $("notify-list").replaceChildren(...(state.notifications.length
    ? state.notifications.map((n) => el("li", {},
      el("button", { class: `notify-item${n.read_at ? "" : " is-unread"}`, type: "button", "data-notification": n.id, "data-task": n.task_id },
        `${n.by_name} assigned you a ${n.kind}`,
        el("span", { class: "notify-task" }, n.parent_title ? `${n.title} · in ${n.parent_title}` : n.title),
        el("span", { class: "notify-time" }, timeAgo(n.created_at)))))
    : [el("li", { class: "notify-empty" }, "Nothing yet. When someone assigns you a task or subtask, it shows up here.")]));
}

function closeNotifications() {
  $("notify-panel").hidden = true;
  $("notify-btn").setAttribute("aria-expanded", "false");
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
  const opening = $("notify-panel").hidden;
  $("notify-panel").hidden = !opening;
  $("notify-btn").setAttribute("aria-expanded", String(opening));
});

$("notify-read-all").addEventListener("click", () => markNotificationsRead(null));

$("notify-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-notification]");
  if (!item) return;
  markNotificationsRead([item.dataset.notification]);
  closeNotifications();
  openTask(item.dataset.task);
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".notify")) closeNotifications();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("notify-panel").hidden) {
    closeNotifications();
    $("notify-btn").focus();
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

  let saved = null;
  try { saved = JSON.parse(readStorage("sessionStorage", SESSION_KEY)); } catch { /* start fresh */ }
  if (saved?.token) await startBoard(saved.token, saved.name);
  else pinInputs[0].focus();
}

boot();
