/**
 * Pure business logic for the Projects app.
 * No DOM, no fetch — importable in both browser and test environments.
 */

import { isAdult } from "./shared.js";
export { isAdult };

export const STATUSES = ["planning", "active", "on_hold", "done"];

export const STATUS_LABELS = {
  planning: "Planning",
  active:   "In progress",
  on_hold:  "On hold",
  done:     "Done",
};

export const VISIBILITY_LABELS = {
  everyone: "Everyone",
  adults:   "Adults only",
  private:  "Only me",
};

// ── Money ────────────────────────────────────────────────────────────────────

/** Integer cents from a dollars string typed into a number input. NaN if unusable. */
export function toCents(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}

/** Cents as "$1,234.56". Renders an unknown amount as "—", never as $0.00. */
export function fmtDollars(cents) {
  if (cents === null || cents === undefined || cents === "") return "—";
  const n = Number(cents);
  if (!Number.isFinite(n)) return "—";
  return (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Cents as the "1234.56" an edit form's number input wants. */
export function centsInput(cents) {
  return (Number(cents ?? 0) / 100).toFixed(2);
}

// ── Budget ───────────────────────────────────────────────────────────────────

/**
 * Roll a project's line items up.
 *
 * `committedCents` is the number a household actually plans against: the real
 * price where one is known, the estimate everywhere else. Summing estimates
 * alone ignores the overrun that has already happened; summing actuals alone
 * pretends the unbought half of the job is free.
 *
 * `actual_cents` is deliberately nullable in the schema, so a line item that
 * has not been paid for yet contributes its estimate rather than a zero.
 */
export function budgetTotals(items) {
  let estimatedCents = 0;
  let actualCents = 0;
  let committedCents = 0;
  let purchasedCount = 0;
  let knownActuals = 0;

  for (const item of items) {
    const est = Number(item.estimated_cents ?? 0);
    const hasActual = item.actual_cents !== null && item.actual_cents !== undefined;
    const act = hasActual ? Number(item.actual_cents) : null;

    estimatedCents += Number.isFinite(est) ? est : 0;
    if (hasActual && Number.isFinite(act)) {
      actualCents += act;
      committedCents += act;
      knownActuals += 1;
    } else {
      committedCents += Number.isFinite(est) ? est : 0;
    }
    if (Number(item.purchased) === 1) purchasedCount += 1;
  }

  return {
    estimatedCents,
    actualCents,
    committedCents,
    purchasedCount,
    knownActuals,
    lineItems: items.length,
  };
}

/**
 * How a project stands against its declared cap, measured over a set of items
 * known to be complete. Returns null when no cap was set — a project without a
 * budget is not "0% spent", it is unbudgeted, and a progress bar claiming
 * otherwise would be a lie.
 *
 * The app itself does not call this: what is on screen is one page, so it goes
 * through `budgetStatusFrom` with an exact total instead. This stays for the
 * paths that really do hold every row — the demo data, and tests.
 */
export function budgetStatus(project, items) {
  return budgetStatusFrom(project, budgetTotals(items).committedCents);
}

// ── Exact totals ─────────────────────────────────────────────────────────────
//
// Every number the app states as a FACT — the committed total, the line-item
// count, "3/7 done" — is read from a summary rather than from the rows on
// screen. The rows on screen are one page: the child reads cap at 200 per tab,
// the preload caps across the whole household, and a finished project's
// children are not preloaded at all. Counting those rows produced totals that
// were understated with nothing to say so, and — worse — shipped inside
// `project.completed` and `project.budget_exceeded`, where a wrong
// `committed_cents` is a number some automation acts on.
//
// A summary is EXACT or it is absent. There is no partial summary: when the app
// cannot state a number it declines to state one, which is why every consumer
// here returns null rather than a zero.

/** What one line item contributes: its real price where known, else its
 *  estimate. Mirrors `budgetTotals`, and is the delta arithmetic's unit. */
export function committedOf(item) {
  const est = Number(item?.estimated_cents ?? 0);
  const hasActual = item?.actual_cents !== null && item?.actual_cents !== undefined;
  const act = hasActual ? Number(item.actual_cents) : null;
  if (hasActual && Number.isFinite(act)) return act;
  return Number.isFinite(est) ? est : 0;
}

/** A summary over a set of rows KNOWN to be complete — the preload covered the
 *  project, or the demo data is all there is. */
export function summaryFromRows(items, checklistItems, byItem, noteRows = []) {
  const totals = budgetTotals(items);
  return {
    lineItems: totals.lineItems,
    committedCents: totals.committedCents,
    estimatedCents: totals.estimatedCents,
    checklistItems: checklistItems.length,
    checklistDone: checklistItems.filter(item => isDone(item, byItem)).length,
    notes: noteRows.length,
  };
}

/** A summary from the two aggregate reads, which count rows the viewer may see
 *  whether or not any of them were fetched. */
export function summaryFromAggregates(budgetRow, checklistRow, notesRow) {
  const n = (value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    lineItems: n(budgetRow?.line_items),
    committedCents: n(budgetRow?.committed_cents),
    estimatedCents: n(budgetRow?.estimated_cents),
    checklistItems: n(checklistRow?.items),
    checklistDone: n(checklistRow?.done),
    notes: n(notesRow?.notes),
  };
}

/**
 * A summary moved on by a write this app just made.
 *
 * Re-reading the aggregates after every tick and every line item would be a
 * round trip per keystroke-sized action. It is also unnecessary: an exact base
 * plus the exact delta of a write we performed ourselves is still exact. The
 * delta is stated in the caller's own terms — the item as it was, the item as
 * it now is — so a save, an edit and a delete are one operation.
 *
 * A null base stays null. Applying a delta to an unknown total would invent a
 * number, which is the failure this whole section exists to prevent.
 */
export function applyDelta(summary, { before = null, after = null, checklist = 0, done = 0, notes = 0 } = {}) {
  if (!summary) return null;
  const removed = before ? committedOf(before) : 0;
  const added = after ? committedOf(after) : 0;
  return {
    lineItems: summary.lineItems + (after ? 1 : 0) - (before ? 1 : 0),
    committedCents: summary.committedCents + added - removed,
    estimatedCents: summary.estimatedCents
      + (after ? Number(after.estimated_cents ?? 0) : 0)
      - (before ? Number(before.estimated_cents ?? 0) : 0),
    checklistItems: summary.checklistItems + checklist,
    checklistDone: summary.checklistDone + done,
    notes: summary.notes + notes,
  };
}

/** `budgetStatus` over an exact total instead of over the rows on hand. Null
 *  when there is no cap to measure against, or no exact total to measure. */
export function budgetStatusFrom(project, committedCents) {
  const cap = project?.budget_cap_cents;
  if (cap === null || cap === undefined || Number(cap) <= 0) return null;
  if (committedCents === null || committedCents === undefined) return null;
  const capCents = Number(cap);
  return {
    capCents,
    committedCents,
    remainingCents: capCents - committedCents,
    pct: Math.min(100, Math.round((committedCents / capCents) * 100)),
    over: committedCents > capCents,
  };
}

/** "3/7 done" from a summary, or null when the counts are not known. */
export function progressFrom(summary) {
  if (!summary || !summary.checklistItems) return null;
  const done = summary.checklistDone;
  const total = summary.checklistItems;
  return { done, total, pct: Math.round((done / total) * 100) };
}

/**
 * Whether a write took the project from within its cap to over it, measured on
 * exact totals. Both sides must be known: with an unknown total there is no
 * honest answer, and answering "no" is the safe one — a missed announcement,
 * not a false one against a number that may be wrong.
 */
export function crossedCap(capCents, beforeCents, afterCents) {
  if (capCents === null || capCents === undefined || Number(capCents) <= 0) return false;
  if (beforeCents === null || beforeCents === undefined) return false;
  if (afterCents === null || afterCents === undefined) return false;
  return Number(beforeCents) <= Number(capCents) && Number(afterCents) > Number(capCents);
}

// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * A token that says whether the navigation a caller started is still the one
 * the user is waiting for.
 *
 * Opening a project awaits its children before switching the view, so two
 * opens race: tapping A then B showed B, then jumped back to A when A's slower
 * read landed. Going back is the same race with no second tap — a pending open
 * would drop the user back into the project they just left.
 *
 * `begin` starts a navigation and invalidates every one still in flight, which
 * is why `goBack` calls it too. `peek` reads the current token WITHOUT starting
 * anything, for work that wants to defer to the user rather than pre-empt them
 * — a deep link resolving after the user has already tapped something.
 */
export function navigationGate() {
  let seq = 0;
  return {
    begin: () => ++seq,
    peek: () => seq,
    current: (token) => token === seq,
  };
}

// ── Checklist ────────────────────────────────────────────────────────────────
//
// Whether an item is done lives in `checklist_completions`, one row per closed
// item, owned by whoever closed it — not in a column on the item. See the
// migration for why. Everything below takes that lookup rather than reading a
// `done_at` off the item.

/** item_id → completion row, from the completions the app is holding. */
export function completionIndex(completions) {
  return new Map((completions ?? []).map(c => [c.item_id, c]));
}

/** The completion closing this item, or null while it is still open. */
export function completionOf(item, byItem) {
  return byItem?.get?.(item?.id) ?? null;
}

export function isDone(item, byItem) {
  return !!completionOf(item, byItem);
}

/** Done/total progress over items known to be complete, or null for an empty
 *  checklist (0% would be misleading). The app pages its checklist, so it reads
 *  `progressFrom` off an exact summary instead; this serves the demo data and
 *  the tests, which really do hold every row. */
export function checklistProgress(items, byItem) {
  if (!items.length) return null;
  const done = items.filter(i => isDone(i, byItem)).length;
  return { done, total: items.length, pct: Math.round((done / items.length) * 100) };
}

/**
 * Checklist order: milestones sit above ordinary items so the shape of the job
 * reads first, then hand-arranged order, then the date it is due.
 */
export function sortChecklist(items) {
  return [...items].sort((a, b) => {
    const am = Number(a.is_milestone ?? 0);
    const bm = Number(b.is_milestone ?? 0);
    if (am !== bm) return bm - am;
    const ao = Number(a.sort_order ?? 0);
    const bo = Number(b.sort_order ?? 0);
    if (ao !== bo) return ao - bo;
    const ad = a.due_date ?? "9999-99-99";
    const bd = b.due_date ?? "9999-99-99";
    if (ad !== bd) return ad.localeCompare(bd);
    return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  });
}

/**
 * Overdue = due strictly before today and not done. `today` is injected rather
 * than read here: the caller passes `hubToday()`, the household's own calendar
 * date, because a device-built date is UTC-shifted for half of every day.
 */
export function isOverdue(item, today, byItem) {
  if (!item.due_date || isDone(item, byItem)) return false;
  return item.due_date < today;
}

/** The soonest unfinished due date in a checklist, or null. */
export function nextDueDate(items, byItem) {
  const dates = items.filter(i => !isDone(i, byItem) && i.due_date).map(i => i.due_date).sort();
  return dates[0] ?? null;
}

// ── Access control ───────────────────────────────────────────────────────────
//
// These mirror the `row_policies` in manifest.json exactly. A client gate that
// is more generous than the server's just renders buttons that 403 on click.

/**
 * Mirrors the `owner_or_visibility` policy on `projects`: the owner always,
 * `everyone` rows for anyone, `adults` rows for adults.
 */
export function canSeeProject(project, me) {
  if (!project) return false;
  if (me && project.created_by === me.id) return true;
  if (project.visibility === "everyone") return true;
  if (project.visibility === "adults") return isAdult(me);
  return false;
}

/**
 * The policy sets `write_visibility_scoped: true`, which supersedes the default
 * "any adult may write any row": a caller may edit exactly the rows they can
 * see, and no one can blind-write a private project they cannot even read.
 */
export function canEditProject(project, me) {
  return canSeeProject(project, me);
}

/** `delete_adult_only: true` — a child may edit a shared project but not destroy it. */
export function canDeleteProject(project, me) {
  return canEditProject(project, me) && isAdult(me);
}

/**
 * The visibility values this member may choose for this project.
 *
 * `private` is deliberately not offered to a child, because the policy pair
 * `write_visibility_scoped` + `delete_adult_only` makes a child-owned private
 * project undeletable by ANYONE: the child is refused DELETE outright for not
 * being an adult, and an adult passes that gate only to have the visibility
 * condition appended — which a `private` row they do not own never satisfies.
 * The row would sit in the household's database with no member able to remove
 * it, holding its photos against the storage quota.
 *
 * A project that is ALREADY private keeps the option listed, so its owner can
 * see the state they are in and switch out of it — re-sharing is the one way
 * such a row becomes deletable (by an adult), and hiding the current value
 * would leave them unable to name it.
 */
export function visibilityChoicesFor(me, project) {
  const all = ["everyone", "adults", "private"];
  if (isAdult(me)) return all;
  return project?.visibility === "private" ? all : ["everyone", "adults"];
}

/**
 * True when this row is in the state described above: private, owned by the
 * viewer, and undeletable by them because they are not an adult. The UI says so
 * rather than leaving a project with no Delete button and no explanation.
 */
export function isUndeletableWhilePrivate(project, me) {
  return !!me
    && project?.visibility === "private"
    && project?.created_by === me.id
    && !isAdult(me);
}

/**
 * Mirrors `inherit_visibility` on the child tables. Creating a child needs only
 * visibility of the parent.
 */
export function canAddChild(project, me) {
  return canSeeProject(project, me);
}

/**
 * Changing or deleting a child row is restricted to the member who wrote it,
 * plus adults: all four child tables declare `adults_bypass: true`, which is
 * `inherit_visibility`'s opt-in supervision over another member's row.
 *
 * Without it the writer term was absolute — this app configures no
 * `privileged_groups`, and an `owner_or_visibility` parent grants no other
 * bypass — so a bogus budget line, a mistaken tick or a note nobody else could
 * retract had no correction path but deleting the whole project. Worse, the
 * writer columns carry `member_references … on_removed: "keep"`, so a departed
 * member's rows were frozen for the life of the household.
 *
 * The bypass follows the parent's READ rule, not its write rule: an adult still
 * needs visibility of the project, so someone else's `private` project hides its
 * children exactly as before. Note the default is the INVERSE of `owner_only`'s
 * `adults_bypass`, which is on unless disabled; here it is off unless declared.
 */
export function canEditChild(row, project, me) {
  if (!canSeeProject(project, me)) return false;
  if (me && isAdult(me)) return true;
  return !!me && row?.created_by === me.id;
}

/**
 * Ticking an item off is an INSERT of a completion the ticker owns, so it needs
 * visibility of the project and nothing else — which is what lets the assignee
 * close their own item without being the person who wrote it.
 */
export function canCompleteItem(project, me) {
  return canAddChild(project, me);
}

/**
 * Un-ticking DELETEs that completion row, and the completions table is
 * `inherit_visibility` too: whoever closed the item can reopen it, and — since
 * that table also declares `adults_bypass: true` — so can any adult who can see
 * the project. Undoing a child's mistaken tick was the case with no remedy.
 */
export function canUncompleteItem(completion, project, me) {
  if (!canSeeProject(project, me)) return false;
  if (me && isAdult(me)) return true;
  return !!me && completion?.done_by === me.id;
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * The description counts as well as the name — a project is looked up by what
 * it was for ("the tile one"), which is rarely in its title.
 */
export function searchableFields(project) {
  return [project.name, project.description, STATUS_LABELS[project.status] ?? project.status];
}

// ── Publication gates ────────────────────────────────────────────────────────

/**
 * App events carry NO audience. The hub scopes them to the household and
 * nothing else (`listEventsWithEpoch`), so every payload published here is
 * readable by every member — a child included — whatever the project's
 * visibility says, and any subscribed automation acts on that payload too. An
 * `adults`-only project therefore may not put its name, its budget or an item
 * title on the bus: assigning a child to an adults-only item used to publish
 * the item title and project name straight onto that child's task list.
 *
 * So row-derived payloads go out only for `everyone` projects. That is a real
 * narrowing — the Tasks bridge fires only for household-wide projects now —
 * and it is the honest one until events grow an enforced audience. It is also
 * why this and `mayLogActivity` have become the same rule.
 */
export function mayPublish(project)  { return !!project && project.visibility === "everyone"; }

/**
 * The members who may be given an item on this project — the ones who can
 * actually open it. Assigning an adults-only job to a child produced a task on
 * their Today and a project they could not open, and it is that payload which
 * carried the leak. Filtering the picker fixes it at the source;
 * `saveChecklistItem` re-checks, because a picker is not a boundary.
 */
export function assignableMembers(project, members) {
  return (members ?? []).filter(m => canSeeProject(project, m));
}

// ── Effectful logic, with its dependencies injected ──────────────────────────
//
// These used to live in index.html, where nothing could reach them: every one
// governs a failure path — a refused write, a lost update, a double tap, a
// dropped publish — and a failure path nobody can test is a failure path nobody
// has checked. They take `db`/`events` rather than importing them, which is the
// app-template's "Extracting testable logic" convention (see shared.js).

/**
 * A write that MUST land. `/api/db` answers a policy-narrowed statement with
 * `changed: 0` and HTTP 200 — no error to catch — so a caller that assumed
 * success would update the screen and let the change evaporate on next load.
 *
 * `live` is false in demo mode, where there is no endpoint and every statement
 * reports nothing changed. That is not a refusal, and treating it as one turned
 * every demo tick, edit and delete into an error dialog.
 */
export async function writeOrThrow(db, { sql, params, refusal, live = true }) {
  if (!live) return { rows: [], changed: 1 };
  const res = await db(sql, params);
  if (Number(res?.changed ?? 0) === 0) throw new Error(refusal);
  return res;
}

/**
 * Compare-and-swap on a project's `file_ids` JSON array.
 *
 * A read-modify-write of a JSON column loses concurrent updates: two members
 * adding a photo at once both read the same array, and the second write erases
 * the first one's id — orphaning a file nothing will ever reclaim. The UPDATE is
 * guarded on the `updated_at` it read, and a zero-row answer means somebody else
 * wrote first (or the row is gone), so it re-reads and retries.
 */
export async function rewriteFileIds(db, project, mutate, refusal, {
  live = true, now = () => new Date().toISOString(), attempts = 4,
} = {}) {
  if (!live) {
    project.file_ids = JSON.stringify(mutate(parseFileIds(project.file_ids)));
    return;
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stamp = project.updated_at;
    const next = JSON.stringify(mutate(parseFileIds(project.file_ids)));
    // Strictly advance the stamp: a write landing in the same millisecond would
    // otherwise leave the guard satisfiable by a racing caller still holding the
    // old value. Compared as INSTANTS, not strings — the same moment has more
    // than one ISO spelling ("…09:00:00Z" vs "…09:00:00.000Z"), and rows written
    // by the hub (an automation's `$now`) need not match this client's.
    const candidate = now();
    const at = Date.parse(candidate) > Date.parse(stamp)
      ? candidate
      : new Date(Date.parse(stamp) + 1).toISOString();
    const res = await db(
      "UPDATE app_projects__projects SET file_ids = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
      [next, at, project.id, stamp],
    );
    if (Number(res?.changed ?? 0) > 0) {
      project.file_ids = next;
      project.updated_at = at;
      return;
    }
    const { rows } = await db(
      "SELECT id, file_ids, updated_at FROM app_projects__projects WHERE id = ?", [project.id]);
    if (!rows?.length) throw new Error(refusal);
    project.file_ids = rows[0].file_ids;
    project.updated_at = rows[0].updated_at;
  }
  throw new Error(refusal);
}

/** JSON array of hub file ids, defensively. Shared by the app and the CAS above. */
export function parseFileIds(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : [];
  } catch { return []; }
}

/**
 * Publishing is best-effort, but the promise may not be dropped on the floor:
 * `events.publish` awaits a bare `fetch`, so a network failure REJECTS, and a
 * discarded rejection is an unhandled one. Dropping it also let navigation
 * cancel the request after the row was written, leaving the database and the
 * bus disagreeing with nothing logged. Never rejects.
 */
export async function publishBestEffort(events, type, subjectId, payload, warn = () => {}) {
  try {
    await events.publish(type, payload, subjectId);
    return true;
  } catch (e) {
    warn(`could not publish ${type}`, e);
    return false;
  }
}

/**
 * What a tap on an item's checkbox should do. Split out from the write so the
 * permission fork is testable: ticking off needs only visibility of the project
 * (which is what lets the ASSIGNEE close their own task), while reopening
 * belongs to whoever closed it, plus adults via `adults_bypass`.
 */
export function toggleDecision(item, project, me, byItem, nameOf = id => id) {
  const completion = completionOf(item, byItem);
  if (completion) {
    if (!canUncompleteItem(completion, project, me)) {
      return {
        action: "denied",
        reason: `Only ${nameOf(completion.done_by)} can reopen this — they are the one who closed it.`,
      };
    }
    return { action: "reopen", completion };
  }
  if (!canCompleteItem(project, me)) {
    return { action: "denied", reason: "You cannot tick off items on this project." };
  }
  return { action: "complete" };
}

/**
 * The milestones already announced, derived from the completions on hand.
 *
 * The in-memory set alone was session-scoped, so a reload emptied it and the
 * next reopen-and-re-tick republished `project.milestone_reached`, re-running
 * every subscribed automation. Seeding from the rows means an ALREADY-closed
 * milestone is never announced twice, which is the case that actually recurs.
 *
 * What it still cannot see is a milestone deliberately reopened in one session
 * and re-closed in a later one: by then its completion row is genuinely gone,
 * and a second close is arguably a second event. Closing that needs a durable
 * per-item marker, and the only row that could carry one is the item — which
 * the person ticking it off may not write.
 */
export function announcedMilestoneIds(checklist, completions) {
  const milestones = new Set(
    (checklist ?? []).filter(c => Number(c.is_milestone) === 1).map(c => c.id),
  );
  const announced = new Set();
  for (const completion of completions ?? []) {
    if (milestones.has(completion.item_id)) announced.add(completion.item_id);
  }
  return announced;
}

// ── Paging ───────────────────────────────────────────────────────────────────

/**
 * D1 refuses a statement with more than 100 bound parameters ("too many SQL
 * variables"); the hub chunks its own `IN (…)` reads at 90 for headroom, and
 * this app follows it. One bind is spent on `project_id`, so an id list is cut
 * at 89.
 */
export const D1_MAX_BINDS = 90;

/** Splits `values` into consecutive runs of at most `size`. */
export function chunk(values, size) {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out = [];
  for (let i = 0; i < (values?.length ?? 0); i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * KEYSET paging, not OFFSET.
 *
 * `LIMIT n OFFSET m` names a POSITION, and positions move: a row inserted or
 * deleted before the offset shifts every later page by one, so paging past a
 * concurrent edit silently repeats a row or steps over one. A keyset names the
 * last row you actually hold and asks for what sorts after it, which cannot
 * drift — and it makes a double-click harmless, because the same cursor
 * re-fetches the same page rather than advancing twice.
 *
 * Each table pages in its own display order, with `id` appended as a
 * tiebreaker so the sort is total (two rows sharing a `sort_order` AND a
 * `created_at` would otherwise have no defined order, and a page boundary
 * falling between them could lose one).
 */
export const CHILD_ORDERS = {
  budget:    { table: "budget_items",    order: "sort_order, created_at, id", keys: ["sort_order", "created_at", "id"], dir: "asc" },
  checklist: { table: "checklist_items", order: "sort_order, created_at, id", keys: ["sort_order", "created_at", "id"], dir: "asc" },
  notes:     { table: "notes",           order: "created_at DESC, id",        keys: ["created_at", "id"],               dir: "desc" },
};

/** The cursor for the last row of a page, or null for "start from the top". */
export function cursorFrom(row, key) {
  const spec = CHILD_ORDERS[key];
  if (!spec || !row) return null;
  return spec.keys.map(col => row[col] ?? null);
}

/**
 * The `AND (…)` that resumes after `cursor`, as SQL plus the params it binds.
 *
 * Written as nested OR/AND rather than a row-value comparison
 * (`(a, b) > (?, ?)`): the row-policy rewriter parses app SQL with
 * node-sql-parser, which is narrower than D1, and a statement it cannot parse
 * is REFUSED outright rather than degraded. This shape is verified against the
 * real rewriter in the hub's projects-app-policies lane.
 *
 * The last key (`id`) always compares ascending — it is a tiebreaker for
 * equality within the primary sort, not part of the user-visible order.
 */
export function keysetClause(key, cursor) {
  const spec = CHILD_ORDERS[key];
  if (!spec || !cursor?.length) return { sql: "", params: [] };
  const cmp = spec.dir === "desc" ? "<" : ">";
  const params = [];
  // Built inside-out: the innermost term is the tiebreaker, and each enclosing
  // key wraps it as "strictly after, or equal and (the rest)".
  let sql = `id > ?`;
  params.unshift(cursor[cursor.length - 1]);
  for (let i = spec.keys.length - 2; i >= 0; i--) {
    const col = spec.keys[i];
    sql = `${col} ${cmp} ? OR (${col} = ? AND (${sql}))`;
    params.unshift(cursor[i], cursor[i]);
  }
  return { sql: ` AND (${sql})`, params };
}

// ── Merging pages ────────────────────────────────────────────────────────────

/**
 * Pages merged by row id, never concatenated.
 *
 * A row added locally sorts wherever its keys put it, which for a new budget
 * line or checklist item is AFTER the cursor the tab is holding — so the next
 * page fetches that same row from the database and a blind concat appended it
 * twice. Two copies of one line item double-count in the budget totals, which
 * is the kind of wrong a household notices and cannot explain.
 *
 * The server's copy wins on a collision: it is the row as stored, including any
 * column the optimistic local copy guessed at.
 */
export function mergeById(existing, incoming) {
  if (!incoming?.length) return existing ?? [];
  const byId = new Map((existing ?? []).map(row => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()];
}

// ── Display order ────────────────────────────────────────────────────────────
//
// Once pages can arrive out of order — a tail fetch, a locally-appended row, a
// merged page — array position stops being a meaningful order. These sort
// explicitly instead, each mirroring the read order its table pages by, so what
// is on screen does not depend on the order the rows happened to arrive in.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Nullish sorts LAST, matching SQL's `(col IS NULL), col`. */
const nullsLast = (a, b) => cmp(a === null || a === undefined, b === null || b === undefined);

/** `sort_order, created_at, id` — the budget tab's read order. */
export function compareBudgetRows(a, b) {
  return cmp(Number(a.sort_order ?? 0), Number(b.sort_order ?? 0))
    || cmp(String(a.created_at ?? ""), String(b.created_at ?? ""))
    || cmp(String(a.id ?? ""), String(b.id ?? ""));
}

/** `created_at DESC, id` — the decisions log, newest first. */
export function compareNoteRows(a, b) {
  return cmp(String(b.created_at ?? ""), String(a.created_at ?? ""))
    || cmp(String(a.id ?? ""), String(b.id ?? ""));
}

/**
 * The project list's order: open projects first, then the ones aimed at a date
 * (soonest first), then oldest-created. Mirrors the preload's
 * `(completed_at IS NULL) DESC, (target_date IS NULL), target_date, created_at`,
 * with `id` appended so the order is total.
 */
export function compareProjectRows(a, b) {
  const open = (p) => (p.completed_at === null || p.completed_at === undefined ? 0 : 1);
  return cmp(open(a), open(b))
    || nullsLast(a.target_date, b.target_date)
    || cmp(String(a.target_date ?? ""), String(b.target_date ?? ""))
    || cmp(String(a.created_at ?? ""), String(b.created_at ?? ""))
    || cmp(String(a.id ?? ""), String(b.id ?? ""));
}

/** Merge, then order — the pair every page-arrival path needs. */
export function mergeSorted(existing, incoming, compare) {
  const merged = mergeById(existing, incoming);
  return compare ? [...merged].sort(compare) : merged;
}

// ── Repainting while the app is in use ───────────────────────────────────────

/**
 * Whether a LATE repaint may run.
 *
 * A repaint re-creates `#root` wholesale, which destroys and rebuilds every
 * input in it. That is harmless on a user-initiated render, where the DOM is
 * being replaced because the user asked for something — but a background load
 * finishing mid-sentence would replace the search box under the caret and drop
 * the rest of what someone was typing. A modal is the same hazard with more to
 * lose: half-filled form fields.
 *
 * Taken as state rather than read from the document so the rule is testable in
 * a node suite — this app has no DOM harness, and adding one for a two-branch
 * predicate would be the wrong trade.
 */
export function shouldRepaint({ modalOpen = false, activeElementId = null } = {}) {
  if (modalOpen) return false;
  if (activeElementId === "search") return false;
  return true;
}

/**
 * The rest of the project list, past the preload's cap.
 *
 * A truncated CHILD read can be repaired lazily — opening the project fetches
 * it — but a project missing from this list has no card to click, so nothing
 * would ever ask for it. Because finished projects sort last, the rows that
 * fell off the cut were the oldest completed ones.
 *
 * Keyset on `id`, not OFFSET: this runs after first paint while the app is
 * interactive, so a project created or deleted between pages would shift an
 * offset and duplicate or skip a row. `id` is unique, immutable and indexed,
 * and the tail's job is COMPLETENESS rather than order — the caller sorts.
 *
 * `onRows` is handed the NEW rows of each page, and is the only way this
 * reports progress. Two things follow from that shape:
 *
 * It must not render. The caller's repaint is guarded (see `shouldRepaint`),
 * and a render from in here would bypass that guard and yank the caret out of
 * the search box — once per page, up to the page cap.
 *
 * And it hands over ROWS rather than a merged list, so the caller merges into
 * whatever the list holds NOW. Merging into a copy captured when the loader
 * started meant anything added to the list mid-flight — a project created while
 * the tail loaded, or one fetched by a deep link — was overwritten by the next
 * page that landed. The row came back on a later page or not at all, and if the
 * user was looking at that project when it vanished, the view fell back to the
 * list under them.
 */
export async function loadProjectTail(deps, seedIds, onRows = () => {}) {
  const { db, sql, pageSize, maxPages = 10 } = deps;
  // Deduped against everything already seen, so a row the caller merged in
  // separately is not handed over twice. Merging is by id anyway, so this is
  // about not doing pointless work rather than about correctness.
  const seen = new Set(seedIds ?? []);
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const { rows } = await db(sql, [cursor]);
    if (!rows?.length) break;
    cursor = rows[rows.length - 1].id;
    const fresh = rows.filter(r => !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    if (fresh.length) onRows(fresh);
    if (rows.length < pageSize) break;
  }
}
