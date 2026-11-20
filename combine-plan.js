// Works out what combining tasks will do, without touching any data.
// The page shows this as a summary before combining, and the demo store uses it
// to do the combine. The database step (supabase/040) follows the same steps in SQL,
// so keep the order and the rules here exactly as they are.
(function (root) {
  const MAX = 50;
  const TITLE_MAX = 200;

  // Same comparison the board uses for names: trim, squash spaces, ignore case.
  function titleKey(title) {
    return String(title).trim().replace(/\s+/g, " ").toLowerCase();
  }

  // "A", "A and B", "A, B and C"
  function andList(items) {
    if (items.length <= 1) return items.join("");
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }

  // Adds a suffix to a name, cutting the name (never the suffix) so the whole
  // thing stays within 200 characters. Counts whole characters, not UTF-16 halves.
  function fitTitle(base, suffix) {
    const room = Math.max(TITLE_MAX - [...suffix].length, 1);
    return [...[...base].slice(0, room).join("") + suffix].slice(0, TITLE_MAX).join("");
  }

  function plan({ tasks, projects, focus, ids, projectId }) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    if (ids.length < 2 || ids.length > MAX || new Set(ids).size !== ids.length) {
      return { ok: false, error: "invalid_selection" };
    }
    if (ids.some((id) => !byId.has(id))) return { ok: false, error: "task_not_found" };
    if (ids.some((id) => byId.get(id).parent_id)) return { ok: false, error: "not_a_task" };

    const idSet = new Set(ids);
    const T = ids.map((id) => byId.get(id));
    const P = projectId;
    const projectName = (id) => {
      const p = projects.find((x) => x.id === id);
      return p ? p.name : "";
    };
    // Sort by position; equal positions fall back to id so the order is always the same.
    const idOrder = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sortBy = (list, pos, idOf) =>
      list.slice().sort((a, b) => pos(a) - pos(b) || idOrder(idOf(a), idOf(b)));
    // Tasks held (mirrored) inside t, in the order they sit there.
    const held = (t) => {
      const rows = [];
      for (const h of tasks) {
        for (const m of h.mirrors || []) if (m.task_id === t.id) rows.push({ h, pos: m.position });
      }
      return sortBy(rows, (r) => r.pos, (r) => r.h).map((r) => r.h);
    };
    const children = (t) => sortBy(tasks.filter((c) => c.parent_id === t.id), (c) => c.position, (c) => c);

    const taken = new Set();
    const movedIn = [];
    const droppedIn = [];
    const seenHeld = new Set();
    // First pass: tasks held inside a ticked task keep their names.
    for (const t of T) {
      for (const h of held(t)) {
        if (idSet.has(h.id) || seenHeld.has(h.id)) continue;
        seenHeld.add(h.id);
        const key = titleKey(h.title);
        if (taken.has(key)) droppedIn.push({ id: h.id, from: t.id });
        else {
          taken.add(key);
          movedIn.push({ id: h.id, from: t.id });
        }
      }
    }

    const items = [];
    const place = (x, kind, from) => {
      let name = x.title;
      if (taken.has(titleKey(name))) {
        const base = fitTitle(x.title, ` (from ${from})`);
        name = base;
        let n = 2;
        while (taken.has(titleKey(name))) {
          name = fitTitle(base, ` ${n}`);
          n++;
        }
      }
      taken.add(titleKey(name));
      items.push({ id: x.id, kind, from, title: name, renamedFrom: name === x.title ? null : x.title });
    };
    for (const t of T) {
      place(t, "ticked", projectName(t.project_id));
      for (const s of children(t)) place(s, "moved_up", t.title);
    }

    const t1 = T[0];
    let position = null;
    if (t1.project_id === P) position = t1.position;
    else {
      const m = (t1.mirrors || []).find((x) => x.project_id === P && !x.task_id);
      position = m ? m.position : null;
    }

    const archived = new Set(projects.filter((p) => p.archived_at).map((p) => p.id));
    const suggestedTargets = [];
    const seenTarget = new Set();
    const suggest = (target, projectOf) => {
      if (archived.has(projectOf) || (projectOf === P && !target.task_id)) return;
      const key = JSON.stringify(target);
      if (seenTarget.has(key)) return;
      seenTarget.add(key);
      suggestedTargets.push(target);
    };
    for (const t of T) {
      if (t.project_id !== P) suggest({ project_id: t.project_id }, t.project_id);
      for (const m of t.mirrors || []) {
        if (!m.task_id) suggest({ project_id: m.project_id }, m.project_id);
        else if (!idSet.has(m.task_id)) suggest({ task_id: m.task_id }, m.project_id);
      }
    }

    const expect = {
      subtasks: items.filter((i) => i.kind === "moved_up").map((i) => i.id),
      moved_project: T.filter((t) => t.project_id !== P).map((t) => t.id),
      repeats_off: T.filter((t) => t.repeat !== "none").map((t) => t.id),
      focus_off: focus
        .filter((f) => idSet.has(f.task_id))
        .map((f) => ({ task_id: f.task_id, person_key: f.person_key })),
      mirrors_off: T.flatMap((t) =>
        (t.mirrors || []).map((m) => ({ task_id: t.id, project_id: m.project_id, into_task: m.task_id ?? null }))
      ),
      moved_in: movedIn.map((m) => m.id),
      dropped_in: droppedIn.map((m) => m.id),
      renames: items.filter((i) => i.renamedFrom !== null).map((i) => ({ id: i.id, title: i.title })),
    };

    return { ok: true, ticked: T, items, movedIn, droppedIn, position, suggestedTargets, expect };
  }

  // True when two expectations list the same things, whatever order they come in.
  function sameExpect(a, b) {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keys = ["subtasks", "moved_project", "repeats_off", "focus_off", "mirrors_off", "moved_in", "dropped_in", "renames"];
    const sorted = (v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v;
    const norm = (list) => (list || []).map((x) => JSON.stringify(sorted(x))).sort();
    return keys.every((k) => {
      const x = norm(a[k]);
      const y = norm(b[k]);
      return x.length === y.length && x.every((v, i) => v === y[i]);
    });
  }

  root.MoversCombine = { MAX, titleKey, andList, fitTitle, plan, sameExpect };
})(typeof window !== "undefined" ? window : globalThis);
