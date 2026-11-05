"use strict";

const STATUS = { todo: "To do", doing: "In progress", done: "Done" };
const URGENCY = { low: "Low", normal: "Normal", high: "High", critical: "Critical" };
const POLL_MS = 5000;
const SESSION_KEY = "board.session";
const NAME_KEY = "board.lastName";

const state = {
  store: null,
  tasks: [],
  version: -1,
  name: "",
  dragging: false,
  writes: 0, // bumps on every change so a slower, older read can't undo it
  editingId: null,
  pollTimer: null,
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
  };
}

async function loadStore() {
  const config = window.BOARD_CONFIG || {};
  if (config.supabaseUrl) return remoteStore(config);
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
  if ($("task-dialog").open) $("task-dialog").close();
  state.tasks = [];
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

function rowSignature(task) {
  return JSON.stringify([
    task.title, task.assignee, task.urgency, task.deadline, task.status, task.progress,
    task.updated_by, timeAgo(task.updated_at), deadlineNote(task)?.text,
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
        el("button", { class: "task-title", type: "button", "data-open": true }, task.title),
        el("div", { class: "task-meta" }, `${task.updated_by} · ${timeAgo(task.updated_at)}`))),
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
  const open = state.tasks.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.deadline && daysUntil(t.deadline) < 0).length;
  const today = open.filter((t) => t.deadline && daysUntil(t.deadline) === 0).length;
  const parts = [el("span", {}, `${open.length} open`)];
  if (overdue) parts.push(" · ", el("span", { class: "is-overdue" }, `${overdue} overdue`));
  if (today) parts.push(" · ", el("span", {}, `${today} due today`));
  $("summary").replaceChildren(...parts);
}

function renderPeople() {
  const names = new Set([state.name]);
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
  const tasks = [...state.tasks].sort((a, b) => a.position - b.position);
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
  await write(() => state.store.save(id, diff), "That change didn't save, so it has been undone. Check your connection and try again.");
}

const rows = $("task-rows");

rows.addEventListener("change", (event) => {
  const control = event.target.closest("[data-field]");
  if (!control) return;
  const id = control.closest(".task-row").dataset.id;
  const field = control.dataset.field;
  let value = control.value;
  if (field === "progress") value = Number(value);
  if (field === "assignee") value = value.trim();
  if (field === "deadline") value = value || null;
  updateTask(id, { [field]: value }, field);
});

// Moves the bar and the number while the slider is being dragged.
rows.addEventListener("input", (event) => {
  if (event.target.dataset.field !== "progress") return;
  event.target.style.setProperty("--p", `${event.target.value}%`);
  event.target.closest(".progress-wrap").querySelector(".progress-label").textContent = `${event.target.value}%`;
});

rows.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.dataset.field === "assignee") {
    event.preventDefault();
    event.target.blur();
  }
});

rows.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-open]");
  if (opener && !state.dragging) openTask(opener.closest(".task-row").dataset.id);
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
        renderBoard();
        if (state.editingId) renderActivity();
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

// ---------- Add and edit in the dialog ----------

const dialog = $("task-dialog");

function setDialogProgress(value) {
  $("task-progress").value = value;
  $("task-progress").style.setProperty("--p", `${value}%`);
  $("task-progress-label").textContent = `${value}%`;
}

function resetDelete() {
  $("task-delete").classList.remove("armed");
  $("task-delete").textContent = "Delete";
}

function openTask(id) {
  const task = id ? findTask(id) : null;
  if (id && !task) return;
  state.editingId = id || null;
  $("dialog-title").textContent = task ? "Edit task" : "Add task";
  $("task-title").value = task?.title || "";
  $("task-details").value = task?.details || "";
  $("task-assignee").value = task?.assignee || "";
  $(`urgency-${task?.urgency || "normal"}`).checked = true;
  $("task-deadline").value = task?.deadline || "";
  $("task-status").value = task?.status || "todo";
  setDialogProgress(task?.progress ?? 0);
  $("task-save").textContent = task ? "Save changes" : "Add task";
  $("task-error").hidden = true;
  $("task-delete").hidden = !task;
  $("activity").hidden = !task;
  $("update-input").value = "";
  resetDelete();
  if (task) renderActivity();
  dialog.showModal();
  if (!task) $("task-title").focus();
}

function renderActivity() {
  const task = findTask(state.editingId);
  if (!task) return;
  const items = [...(task.updates || [])].reverse().map((entry) => {
    const time = el("span", { class: "activity-time" }, timeAgo(entry.at));
    if (entry.kind === "note") {
      return el("li", {}, el("strong", {}, entry.by), " ", time,
        el("span", { class: "activity-note" }, entry.text));
    }
    return el("li", { class: "activity-system" }, `${entry.by} ${entry.text} `, time);
  });
  $("activity-list").replaceChildren(...items);
}

function closeDialog() {
  state.editingId = null;
  dialog.close();
}

$("dialog-close").addEventListener("click", closeDialog);
$("task-cancel").addEventListener("click", closeDialog);
// Covers closing with Esc. The event arrives late, possibly after another task
// has been opened, and that task must stay the one being edited.
dialog.addEventListener("close", () => {
  if (!dialog.open) state.editingId = null;
});

$("task-status").addEventListener("change", () => {
  const current = { progress: Number($("task-progress").value) };
  const linked = linkStatusAndProgress(current, { status: $("task-status").value });
  if ("progress" in linked) setDialogProgress(linked.progress);
});
$("task-progress").addEventListener("input", () => {
  const value = Number($("task-progress").value);
  setDialogProgress(value);
  const linked = linkStatusAndProgress({ status: $("task-status").value }, { progress: value });
  if (linked.status) $("task-status").value = linked.status;
});

$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("task-title").value.trim();
  if (!title) {
    $("task-error").textContent = "Give the task a name.";
    $("task-error").hidden = false;
    $("task-title").focus();
    return;
  }
  const fields = {
    title,
    details: $("task-details").value.trim(),
    assignee: $("task-assignee").value.trim(),
    urgency: new FormData($("task-form")).get("urgency"),
    deadline: $("task-deadline").value || null,
    status: $("task-status").value,
    progress: Number($("task-progress").value),
  };
  const task = findTask(state.editingId);
  const payload = task ? onlyChanged(task, fields) : fields;
  if (!Object.keys(payload).length) return closeDialog();

  $("task-save").disabled = true;
  const saved = await write(() => state.store.save(state.editingId, payload), null);
  $("task-save").disabled = false;
  if (saved.ok) {
    closeDialog();
  } else if (dialog.open) {
    $("task-error").textContent = "That task didn't save. Check your connection and try again.";
    $("task-error").hidden = false;
  }
});

$("task-delete").addEventListener("click", async () => {
  const button = $("task-delete");
  if (!button.classList.contains("armed")) {
    button.classList.add("armed");
    button.textContent = "Delete for everyone?";
    return;
  }
  const id = state.editingId;
  button.disabled = true;
  const deleted = await write(() => state.store.remove(id), null);
  button.disabled = false;
  if (deleted.ok) {
    closeDialog();
  } else if (dialog.open) {
    $("task-error").textContent = "That task wasn't deleted. Check your connection and try again.";
    $("task-error").hidden = false;
  }
});

async function postUpdate() {
  const text = $("update-input").value.trim();
  const id = state.editingId;
  if (!text || !id) return;
  $("update-post").disabled = true;
  const posted = await write(() => state.store.addUpdate(id, text), "That update didn't post. Check your connection and try again.");
  $("update-post").disabled = false;
  if (posted.ok) $("update-input").value = "";
}

$("update-post").addEventListener("click", postUpdate);
$("update-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    postUpdate();
  }
});

$("add-btn").addEventListener("click", () => openTask(null));

// ---------- Start ----------

async function boot() {
  for (const [key, label] of Object.entries(STATUS)) {
    $("task-status").append(el("option", { value: key }, label));
  }
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
