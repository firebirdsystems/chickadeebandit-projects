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
 * How a project stands against its declared cap. Returns null when no cap was
 * set — a project without a budget is not "0% spent", it is unbudgeted, and a
 * progress bar claiming otherwise would be a lie.
 */
export function budgetStatus(project, items) {
  const cap = project?.budget_cap_cents;
  if (cap === null || cap === undefined || Number(cap) <= 0) return null;
  const capCents = Number(cap);
  const { committedCents } = budgetTotals(items);
  return {
    capCents,
    committedCents,
    remainingCents: capCents - committedCents,
    pct: Math.min(100, Math.round((committedCents / capCents) * 100)),
    over: committedCents > capCents,
  };
}

/**
 * True when adding `addedCents` to the project's committed total crosses its cap
 * for the first time. The caller publishes `project.budget_exceeded` on a true —
 * so this has to be false when the budget was already blown, or every later edit
 * would re-announce the same overrun.
 */
export function crossesBudget(project, itemsBefore, addedCents) {
  const before = budgetStatus(project, itemsBefore);
  if (!before) return false;
  if (before.over) return false;
  return before.committedCents + Number(addedCents ?? 0) > before.capCents;
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

/** Done/total progress, or null for an empty checklist (0% would be misleading). */
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
 * Mirrors `inherit_visibility` on the child tables. Creating a child needs only
 * visibility of the parent.
 */
export function canAddChild(project, me) {
  return canSeeProject(project, me);
}

/**
 * Changing or deleting a child row is restricted to the member who wrote it —
 * for EVERYONE, adults included. `inherit_visibility` derives its write bypass
 * from `privileged_groups` alone (this app configures none), so `isAdult` grants
 * nothing here; a gate that returned true for adults just rendered buttons whose
 * every click came back with zero rows changed.
 */
export function canEditChild(row, project, me) {
  if (!canSeeProject(project, me)) return false;
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
 * `inherit_visibility` too — only whoever closed the item can reopen it.
 */
export function canUncompleteItem(completion, project, me) {
  if (!canSeeProject(project, me)) return false;
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
