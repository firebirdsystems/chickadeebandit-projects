import { describe, it, expect } from "vitest";
import {
  STATUS_LABELS,
  toCents, fmtDollars, centsInput,
  budgetTotals, budgetStatus, crossedCap, committedOf,
  summaryFromRows, summaryFromAggregates, applyDelta, budgetStatusFrom, progressFrom,
  navigationGate,
  checklistProgress, sortChecklist, isOverdue, nextDueDate,
  completionIndex, completionOf, isDone,
  canSeeProject, canEditProject, canDeleteProject, canAddChild, canEditChild,
  canCompleteItem, canUncompleteItem, visibilityChoicesFor, isUndeletableWhilePrivate,
  mayPublish, assignableMembers,
  writeOrThrow, rewriteFileIds, parseFileIds, publishBestEffort,
  toggleDecision, announcedMilestoneIds,
  chunk, D1_MAX_BINDS, CHILD_ORDERS, cursorFrom, keysetClause,
  mergeById, mergeSorted, compareBudgetRows, compareNoteRows, compareProjectRows,
  shouldRepaint, loadProjectTail,
  searchableFields,
} from "../src/logic.js";

const ADULT = { id: "a1", role: "adult" };
const OTHER_ADULT = { id: "a2", role: "adult" };
const CHILD = { id: "k1", role: "child" };

/** The completion index the app holds: item_id → the row that closed it. */
const doneMap = (...itemIds) =>
  completionIndex(itemIds.map((itemId, i) => ({
    id: `x${i}`, project_id: "p1", item_id: itemId, done_by: "a1", done_at: "2026-09-04T09:00:00Z",
  })));

const project = (over = {}) => ({
  id: "p1", name: "Bathroom renovation", description: "",
  status: "active", visibility: "adults", target_date: null,
  budget_cap_cents: null, created_by: "a1", completed_at: null, ...over,
});

const line = (over = {}) => ({
  id: "b1", project_id: "p1", label: "Tile", estimated_cents: 1000,
  actual_cents: null, purchased: 0, created_by: "a1", ...over,
});

// ── Money ────────────────────────────────────────────────────────────────────

describe("toCents", () => {
  it("converts a dollars string to integer cents without float drift", () => {
    expect(toCents("12.35")).toBe(1235);
    expect(toCents("0.10")).toBe(10);
    expect(toCents("1234")).toBe(123400);
  });

  it("is NaN for a blank or unparseable amount, so a caller can reject it", () => {
    expect(Number.isNaN(toCents(""))).toBe(true);
    expect(Number.isNaN(toCents(null))).toBe(true);
    expect(Number.isNaN(toCents("abc"))).toBe(true);
  });
});

describe("fmtDollars", () => {
  it("renders an unknown amount as a dash, never as $0.00", () => {
    expect(fmtDollars(null)).toBe("—");
    expect(fmtDollars(undefined)).toBe("—");
    expect(fmtDollars("")).toBe("—");
    // A genuine zero is a real amount and must still print as money.
    expect(fmtDollars(0)).toBe("$0.00");
  });

  it("formats cents as USD", () => expect(fmtDollars(123456)).toBe("$1,234.56"));
});

describe("centsInput", () => {
  it("fills an edit form with two decimal places", () => {
    expect(centsInput(1235)).toBe("12.35");
    expect(centsInput(null)).toBe("0.00");
  });
});

// ── Budget ───────────────────────────────────────────────────────────────────

describe("budgetTotals", () => {
  it("commits the real price where known and the estimate everywhere else", () => {
    const totals = budgetTotals([
      line({ id: "b1", estimated_cents: 1000, actual_cents: 1400 }),
      line({ id: "b2", estimated_cents: 2000, actual_cents: null }),
    ]);
    expect(totals.estimatedCents).toBe(3000);
    expect(totals.actualCents).toBe(1400);
    // 1400 real + 2000 still-estimated — not 3000, and not 1400.
    expect(totals.committedCents).toBe(3400);
    expect(totals.knownActuals).toBe(1);
  });

  it("treats a zero actual as a real price, not as unknown", () => {
    const totals = budgetTotals([line({ estimated_cents: 5000, actual_cents: 0 })]);
    expect(totals.committedCents).toBe(0);
    expect(totals.knownActuals).toBe(1);
  });

  it("counts purchased line items", () => {
    const totals = budgetTotals([line({ id: "b1", purchased: 1 }), line({ id: "b2", purchased: 0 })]);
    expect(totals.purchasedCount).toBe(1);
  });

  it("is all zeroes for an empty project", () => {
    expect(budgetTotals([]).committedCents).toBe(0);
  });
});

describe("budgetStatus", () => {
  it("is null with no cap — an unbudgeted project is not 0% spent", () => {
    expect(budgetStatus(project(), [line()])).toBe(null);
    expect(budgetStatus(project({ budget_cap_cents: 0 }), [line()])).toBe(null);
  });

  it("reports remaining and over against the committed total", () => {
    const status = budgetStatus(project({ budget_cap_cents: 10000 }), [
      line({ id: "b1", estimated_cents: 4000, actual_cents: 6000 }),
      line({ id: "b2", estimated_cents: 2000 }),
    ]);
    expect(status.committedCents).toBe(8000);
    expect(status.remainingCents).toBe(2000);
    expect(status.pct).toBe(80);
    expect(status.over).toBe(false);
  });

  it("caps the bar at 100% while still reporting the overrun", () => {
    const status = budgetStatus(project({ budget_cap_cents: 1000 }), [line({ estimated_cents: 5000 })]);
    expect(status.pct).toBe(100);
    expect(status.over).toBe(true);
    expect(status.remainingCents).toBe(-4000);
  });
});

describe("crossedCap", () => {
  const CAP = 10000;

  it("is true only for the write that first breaks the budget", () => {
    expect(crossedCap(CAP, 9000, 11000)).toBe(true);
  });

  it("is false when the addition still fits", () => {
    expect(crossedCap(CAP, 5000, 7000)).toBe(false);
  });

  it("is false once the budget is ALREADY blown, so the overrun is announced once", () => {
    // Without this, every later line item would re-publish project.budget_exceeded
    // and the household would be told the same bad news over and over.
    expect(crossedCap(CAP, 15000, 15100)).toBe(false);
  });

  it("does not re-announce when the item being edited is the one that broke it", () => {
    // Both sides span the WHOLE project, so re-saving the line that broke the
    // cap measures over-to-over, not under-to-over.
    expect(crossedCap(CAP, 11000, 11000)).toBe(false);
  });

  it("treats landing exactly ON the cap as within it", () => {
    expect(crossedCap(CAP, 5000, 10000)).toBe(false);
    expect(crossedCap(CAP, 10000, 10001)).toBe(true);
  });

  it("is false with no cap to cross", () => {
    expect(crossedCap(null, 0, 999999)).toBe(false);
    expect(crossedCap(0, 0, 999999)).toBe(false);
  });

  it("is false when either total is unknown, rather than guessing", () => {
    // An unknown total means the rows were paged. Announcing an overrun from a
    // number that may be understated is worse than not announcing one: the
    // event carries `committed_cents` into whatever automation is listening.
    expect(crossedCap(CAP, null, 20000)).toBe(false);
    expect(crossedCap(CAP, 100, null)).toBe(false);
  });
});

// ── Exact totals ─────────────────────────────────────────────────────────────

describe("committedOf", () => {
  it("prefers the real price and falls back to the estimate", () => {
    expect(committedOf(line({ estimated_cents: 400, actual_cents: 900 }))).toBe(900);
    expect(committedOf(line({ estimated_cents: 400, actual_cents: null }))).toBe(400);
  });

  it("counts a real price of zero as zero, not as the estimate", () => {
    // A freebie is a known price. Falling back to the estimate here would make
    // a donated item cost the household money it never spent.
    expect(committedOf(line({ estimated_cents: 400, actual_cents: 0 }))).toBe(0);
  });

  it("agrees with budgetTotals, item for item", () => {
    const items = [
      line({ id: "b1", estimated_cents: 400, actual_cents: 900 }),
      line({ id: "b2", estimated_cents: 250 }),
      line({ id: "b3", estimated_cents: 100, actual_cents: 0 }),
    ];
    const summed = items.reduce((total, item) => total + committedOf(item), 0);
    expect(summed).toBe(budgetTotals(items).committedCents);
  });
});

describe("summaryFromAggregates", () => {
  it("reads the aggregate rows the app actually sends", () => {
    const summary = summaryFromAggregates(
      { line_items: 3, committed_cents: 1550, estimated_cents: 1200 },
      { items: 7, done: 4 },
      { notes: 2 },
    );
    expect(summary).toEqual({
      lineItems: 3, committedCents: 1550, estimatedCents: 1200,
      checklistItems: 7, checklistDone: 4, notes: 2,
    });
  });

  it("reads an empty project as zeroes, not as NaN", () => {
    // COUNT over no rows is 0, but SUM over no rows is NULL — the SQL coalesces
    // it and this coalesces again, because a NaN would render as "$NaN".
    const summary = summaryFromAggregates({ line_items: 0, committed_cents: null }, undefined, undefined);
    expect(summary.committedCents).toBe(0);
    expect(summary.checklistItems).toBe(0);
    expect(summary.notes).toBe(0);
  });
});

describe("applyDelta", () => {
  const base = () => summaryFromRows(
    [line({ id: "b1", estimated_cents: 1000 })],
    [{ id: "c1" }, { id: "c2" }],
    doneMap("c1"),
    [{ id: "n1" }],
  );

  it("adds a line item at what it is worth", () => {
    const next = applyDelta(base(), { after: line({ id: "b2", estimated_cents: 250 }) });
    expect(next.lineItems).toBe(2);
    expect(next.committedCents).toBe(1250);
  });

  it("re-prices an edited line item by the difference, not by adding it twice", () => {
    const next = applyDelta(base(), {
      before: line({ id: "b1", estimated_cents: 1000 }),
      after: line({ id: "b1", estimated_cents: 1000, actual_cents: 1800 }),
    });
    expect(next.lineItems).toBe(1);
    expect(next.committedCents).toBe(1800);
  });

  it("removes a deleted line item", () => {
    const next = applyDelta(base(), { before: line({ id: "b1", estimated_cents: 1000 }) });
    expect(next.lineItems).toBe(0);
    expect(next.committedCents).toBe(0);
  });

  it("tracks checklist and decision counts", () => {
    const next = applyDelta(base(), { checklist: 1, done: 1, notes: -1 });
    expect(next.checklistItems).toBe(3);
    expect(next.checklistDone).toBe(2);
    expect(next.notes).toBe(0);
  });

  it("round-trips: applying a delta and its inverse is a no-op", () => {
    const item = line({ id: "b2", estimated_cents: 700, actual_cents: 650 });
    const added = applyDelta(base(), { after: item });
    expect(applyDelta(added, { before: item })).toEqual(base());
  });

  it("keeps an UNKNOWN total unknown instead of inventing a base", () => {
    // This is the whole contract: a summary is exact or it is absent. A delta
    // applied to nothing would produce a total of "just this one item", which
    // reads as a real number and is not one.
    expect(applyDelta(null, { after: line({ estimated_cents: 500 }) })).toBe(null);
  });
});

describe("budgetStatusFrom / progressFrom", () => {
  it("state nothing when the total is not known", () => {
    expect(budgetStatusFrom(project({ budget_cap_cents: 10000 }), null)).toBe(null);
    expect(progressFrom(null)).toBe(null);
  });

  it("read a zero total as a real zero", () => {
    // "Not known" and "nothing spent yet" are different answers, and only the
    // second one gets a progress bar.
    const status = budgetStatusFrom(project({ budget_cap_cents: 10000 }), 0);
    expect(status.committedCents).toBe(0);
    expect(status.pct).toBe(0);
  });

  it("give no progress for an empty checklist rather than 0/0", () => {
    expect(progressFrom(summaryFromAggregates({}, { items: 0, done: 0 }, {}))).toBe(null);
  });

  it("count done items off the summary", () => {
    expect(progressFrom(summaryFromAggregates({}, { items: 4, done: 3 }, {})))
      .toEqual({ done: 3, total: 4, pct: 75 });
  });
});

describe("navigationGate", () => {
  it("keeps the newest navigation and drops the ones it superseded", () => {
    const nav = navigationGate();
    const first = nav.begin();
    const second = nav.begin();
    expect(nav.current(first)).toBe(false);
    expect(nav.current(second)).toBe(true);
  });

  it("lets going back invalidate an open still in flight", () => {
    const nav = navigationGate();
    const open = nav.begin();
    nav.begin();                       // goBack() takes a token of its own
    expect(nav.current(open)).toBe(false);
  });

  it("peeks without starting a navigation, so a deep link defers to the user", () => {
    const nav = navigationGate();
    const seen = nav.peek();
    expect(nav.current(seen)).toBe(true);   // nobody has navigated yet
    nav.begin();                            // the user taps a card
    expect(nav.current(seen)).toBe(false);  // so the link stands down
  });
});

// ── Checklist ────────────────────────────────────────────────────────────────

describe("checklistProgress", () => {
  it("is null for an empty checklist rather than a misleading 0%", () => {
    expect(checklistProgress([], doneMap())).toBe(null);
  });

  it("counts done items from the completion rows, not a column on the item", () => {
    const progress = checklistProgress([{ id: "c1" }, { id: "c2" }], doneMap("c1"));
    expect(progress).toEqual({ done: 1, total: 2, pct: 50 });
  });
});

describe("sortChecklist", () => {
  it("floats milestones above ordinary items so the shape of the job reads first", () => {
    const sorted = sortChecklist([
      { id: "a", is_milestone: 0, sort_order: 0 },
      { id: "b", is_milestone: 1, sort_order: 9 },
    ]);
    expect(sorted.map(i => i.id)).toEqual(["b", "a"]);
  });

  it("falls back to sort_order, then due date", () => {
    const sorted = sortChecklist([
      { id: "late", is_milestone: 0, sort_order: 1, due_date: "2026-01-01" },
      { id: "early", is_milestone: 0, sort_order: 0, due_date: "2026-12-01" },
    ]);
    expect(sorted.map(i => i.id)).toEqual(["early", "late"]);
  });

  it("does not mutate the array it was given", () => {
    const items = [{ id: "a", is_milestone: 0 }, { id: "b", is_milestone: 1 }];
    sortChecklist(items);
    expect(items.map(i => i.id)).toEqual(["a", "b"]);
  });
});

describe("isOverdue", () => {
  const today = "2026-09-04";

  it("is true for an unfinished item due before today", () => {
    expect(isOverdue({ id: "c1", due_date: "2026-09-03" }, today, doneMap())).toBe(true);
  });

  it("is false on the due date itself — today is not late", () => {
    expect(isOverdue({ id: "c1", due_date: today }, today, doneMap())).toBe(false);
  });

  it("is false once the item is done, however late it was", () => {
    expect(isOverdue({ id: "c1", due_date: "2020-01-01" }, today, doneMap("c1"))).toBe(false);
  });

  it("is false for an item with no due date", () => {
    expect(isOverdue({ id: "c1", due_date: null }, today, doneMap())).toBe(false);
  });
});

describe("nextDueDate", () => {
  it("returns the soonest unfinished due date", () => {
    expect(nextDueDate([
      { id: "c1", due_date: "2026-12-01" },
      { id: "c2", due_date: "2026-01-01" },
      { id: "c3", due_date: "2026-06-01" },
    ], doneMap("c2"))).toBe("2026-06-01");
  });

  it("is null when nothing unfinished is dated", () => {
    expect(nextDueDate([{ id: "c1", due_date: null }], doneMap())).toBe(null);
  });
});

// ── Access control ───────────────────────────────────────────────────────────
// These mirror manifest.json's row_policies. A gate more generous than the
// server's renders buttons that 403 on click.

describe("canSeeProject", () => {
  it("shows an everyone project to a child", () => {
    expect(canSeeProject(project({ visibility: "everyone" }), CHILD)).toBe(true);
  });

  it("hides an adults project from a child", () => {
    expect(canSeeProject(project({ visibility: "adults" }), CHILD)).toBe(false);
  });

  it("hides a private project from a DIFFERENT adult, not just from children", () => {
    // adult_values is ["adults"] and does not list "private", so the owner is
    // genuinely alone here — this is what makes a surprise-gift project safe.
    expect(canSeeProject(project({ visibility: "private", created_by: "a1" }), OTHER_ADULT)).toBe(false);
    expect(canSeeProject(project({ visibility: "private", created_by: "a1" }), ADULT)).toBe(true);
  });
});

describe("canEditProject", () => {
  it("follows visibility, because the policy sets write_visibility_scoped", () => {
    expect(canEditProject(project({ visibility: "everyone" }), CHILD)).toBe(true);
    expect(canEditProject(project({ visibility: "adults" }), CHILD)).toBe(false);
  });

  it("does not let an adult write a private project they cannot even read", () => {
    expect(canEditProject(project({ visibility: "private", created_by: "a1" }), OTHER_ADULT)).toBe(false);
  });
});

describe("canDeleteProject", () => {
  it("lets a child edit a shared project but not destroy it (delete_adult_only)", () => {
    const shared = project({ visibility: "everyone" });
    expect(canEditProject(shared, CHILD)).toBe(true);
    expect(canDeleteProject(shared, CHILD)).toBe(false);
    expect(canDeleteProject(shared, ADULT)).toBe(true);
  });
});

describe("canAddChild / canEditChild", () => {
  const shared = project({ visibility: "everyone" });

  it("lets anyone who can see the project add to it (inherit_visibility INSERT)", () => {
    expect(canAddChild(shared, CHILD)).toBe(true);
    expect(canAddChild(project({ visibility: "adults" }), CHILD)).toBe(false);
  });

  it("restricts a non-adult to rows they wrote themselves", () => {
    expect(canEditChild(line({ created_by: "k1" }), shared, CHILD)).toBe(true);
    expect(canEditChild(line({ created_by: "a1" }), shared, CHILD)).toBe(false);
  });

  it("gives an adult the declared bypass over another member's child row", () => {
    // The child tables set `adults_bypass: true`, so an adult may correct a row
    // they did not write — the moderation path this app had none of.
    expect(canEditChild(line({ created_by: "k1" }), shared, ADULT)).toBe(true);
    expect(canEditChild(line({ created_by: "a1" }), shared, ADULT)).toBe(true);
  });

  it("keeps the writer's own row editable — the bypass only ever ADDS", () => {
    // Mirrors the hub: the parent EXISTS is OR-ed onto the writer term, so the
    // author of a row never loses it by an adult gaining reach over it.
    expect(canEditChild(line({ created_by: "k1" }), shared, CHILD)).toBe(true);
  });

  it("refuses everything on a project the caller cannot see", () => {
    const priv = project({ visibility: "private", created_by: "a1" });
    expect(canEditChild(line({ created_by: "a2" }), priv, OTHER_ADULT)).toBe(false);
  });

  it("does NOT let the bypass reach a project the adult cannot see", () => {
    // `adults_bypass` widens WHICH ROWS under a visible parent an adult may
    // write, never WHICH PARENTS they reach. Someone else's private project
    // stays closed, rows they wrote inside it included.
    const priv = project({ visibility: "private", created_by: "a1" });
    expect(canEditChild(line({ created_by: "a2" }), priv, OTHER_ADULT)).toBe(false);
    expect(canEditChild(line({ created_by: "k1" }), priv, OTHER_ADULT)).toBe(false);
  });
});

describe("canCompleteItem / canUncompleteItem", () => {
  const shared = project({ visibility: "everyone" });
  const completion = { id: "x1", item_id: "c1", done_by: "k1", done_at: "2026-09-04T09:00:00Z" };

  it("lets anyone who can see the project tick an item off", () => {
    // This is the point of the separate table: closing an item is an INSERT of
    // the ticker's own row, so the ASSIGNEE can close a task someone else wrote.
    expect(canCompleteItem(shared, CHILD)).toBe(true);
    expect(canCompleteItem(shared, ADULT)).toBe(true);
  });

  it("refuses on a project the caller cannot see", () => {
    expect(canCompleteItem(project({ visibility: "adults" }), CHILD)).toBe(false);
  });

  it("lets whoever closed the item reopen it, and any adult who can see it", () => {
    // `checklist_completions` declares `adults_bypass: true` too, which is what
    // finally lets an adult undo a child's mistaken tick.
    expect(canUncompleteItem(completion, shared, CHILD)).toBe(true);
    expect(canUncompleteItem(completion, shared, ADULT)).toBe(true);
  });

  it("still refuses a non-adult who did not close the item", () => {
    const otherChild = { id: "k2", role: "child" };
    expect(canUncompleteItem(completion, shared, otherChild)).toBe(false);
  });

  it("refuses to reopen on a project the caller cannot see", () => {
    expect(canUncompleteItem(completion, project({ visibility: "adults" }), CHILD)).toBe(false);
  });
});

describe("completionIndex / isDone", () => {
  it("keys completions by the item they close", () => {
    const map = doneMap("c1", "c2");
    expect(completionOf({ id: "c1" }, map)?.item_id).toBe("c1");
    expect(isDone({ id: "c2" }, map)).toBe(true);
    expect(isDone({ id: "c3" }, map)).toBe(false);
  });

  it("treats an absent index as nothing done", () => {
    expect(isDone({ id: "c1" }, completionIndex(undefined))).toBe(false);
  });
});

describe("visibilityChoicesFor / the undeletable-private trap", () => {
  // write_visibility_scoped + delete_adult_only means a child-owned `private`
  // row can be deleted by NOBODY: the child is refused DELETE for not being an
  // adult, and an adult clears that gate only to have the visibility condition
  // appended, which a private row they do not own never satisfies.
  it("does not offer a child private on a NEW project", () => {
    expect(visibilityChoicesFor(CHILD, null)).toEqual(["everyone", "adults"]);
  });

  it("does not offer a child private on a project that is currently shared", () => {
    expect(visibilityChoicesFor(CHILD, project({ visibility: "adults" }))).toEqual(["everyone", "adults"]);
  });

  it("still lists private for a child when the row is ALREADY private, so they can switch out of it", () => {
    // Re-sharing is the only way such a row becomes deletable; hiding its
    // current value would leave the owner unable to name the state they are in.
    expect(visibilityChoicesFor(CHILD, project({ visibility: "private" }))).toContain("private");
  });

  it("offers an adult every value", () => {
    expect(visibilityChoicesFor(ADULT, null)).toEqual(["everyone", "adults", "private"]);
    expect(visibilityChoicesFor(ADULT, project({ visibility: "private" }))).toEqual(["everyone", "adults", "private"]);
  });

  it("flags a child's own private project as undeletable, and nothing else", () => {
    expect(isUndeletableWhilePrivate(project({ visibility: "private", created_by: CHILD.id }), CHILD)).toBe(true);
    // an adult's own private project: they can see AND delete it
    expect(isUndeletableWhilePrivate(project({ visibility: "private", created_by: ADULT.id }), ADULT)).toBe(false);
    // a child looking at someone else's private project (which they cannot see)
    expect(isUndeletableWhilePrivate(project({ visibility: "private", created_by: ADULT.id }), CHILD)).toBe(false);
    // a child's own SHARED project — an adult can see and remove it
    expect(isUndeletableWhilePrivate(project({ visibility: "adults", created_by: CHILD.id }), CHILD)).toBe(false);
    expect(isUndeletableWhilePrivate(project({ visibility: "private", created_by: CHILD.id }), null)).toBe(false);
  });

  it("agrees with canDeleteProject: whatever a child may choose, an adult can delete", () => {
    // The property that closes the trap — every visibility a child can pick
    // leaves the row deletable by some adult.
    for (const v of visibilityChoicesFor(CHILD, null)) {
      const p = project({ visibility: v, created_by: CHILD.id });
      expect(canDeleteProject(p, OTHER_ADULT)).toBe(true);
    }
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe("searchableFields", () => {
  it("matches on the description, which is how a project is remembered", () => {
    const fields = searchableFields({
      name: "Phase 2", description: "Replacing the bathroom tile", status: "active",
    });
    expect(fields).toContain("Replacing the bathroom tile");
    expect(fields).toContain(STATUS_LABELS.active);
  });
});


describe("mayPublish", () => {
  it("publishes row-derived payloads only for everyone projects", () => {
    // App events carry NO audience — the hub scopes them to the household and
    // nothing else — so an `adults` project's name, budget or item title on the
    // bus is readable by every child, and by any automation acting for them.
    expect(mayPublish(project({ visibility: "everyone" }))).toBe(true);
    expect(mayPublish(project({ visibility: "adults" }))).toBe(false);
    expect(mayPublish(project({ visibility: "private" }))).toBe(false);
    expect(mayPublish(null)).toBe(false);
  });
});

describe("assignableMembers", () => {
  const roster = [ADULT, OTHER_ADULT, CHILD];

  it("offers everyone on an everyone project", () => {
    expect(assignableMembers(project({ visibility: "everyone" }), roster).map(m => m.id))
      .toEqual(["a1", "a2", "k1"]);
  });

  it("keeps a child off an adults-only project", () => {
    // The concrete leak: assigning a child here published the item title and
    // project name onto their task list for a project they cannot open.
    expect(assignableMembers(project({ visibility: "adults" }), roster).map(m => m.id))
      .toEqual(["a1", "a2"]);
  });

  it("leaves only the owner on a private project", () => {
    expect(assignableMembers(project({ visibility: "private", created_by: "a1" }), roster).map(m => m.id))
      .toEqual(["a1"]);
  });

  it("tolerates an empty roster", () => {
    expect(assignableMembers(project(), undefined)).toEqual([]);
  });
});


// ── The failure paths ────────────────────────────────────────────────────────
// Each of these governs what happens when a write is refused, a race is lost or
// a publish fails. They took their dependencies as arguments precisely so these
// cases could be provoked without a browser.

describe("writeOrThrow", () => {
  it("throws the caller's refusal when the policy narrowed the write to nothing", async () => {
    // /api/db answers a narrowed statement with `changed: 0` and HTTP 200 —
    // there is no error to catch, which is how a tick used to appear to work
    // and then vanish on reload.
    const db = async () => ({ rows: [], changed: 0 });
    await expect(writeOrThrow(db, { sql: "UPDATE x", params: [], refusal: "nope" }))
      .rejects.toThrow("nope");
  });

  it("passes a write that landed straight through", async () => {
    const db = async () => ({ rows: [], changed: 1 });
    await expect(writeOrThrow(db, { sql: "UPDATE x", params: [], refusal: "nope" }))
      .resolves.toMatchObject({ changed: 1 });
  });

  it("treats demo mode as a success, not a refusal", async () => {
    // No endpoint means every statement reports nothing changed. Treating that
    // as a refusal turned every demo tick and edit into an error dialog.
    let called = false;
    const db = async () => { called = true; return { changed: 0 }; };
    await expect(writeOrThrow(db, { sql: "UPDATE x", params: [], refusal: "nope", live: false }))
      .resolves.toMatchObject({ changed: 1 });
    expect(called).toBe(false);
  });
});

describe("rewriteFileIds", () => {
  const at = (n) => new Date(Date.parse("2026-09-05T09:00:00Z") + n).toISOString();
  const project = (over = {}) => ({ id: "p1", file_ids: "[]", updated_at: at(0), ...over });

  it("guards the UPDATE on the stamp it read", async () => {
    const p = project();
    const seen = [];
    const db = async (sql, params) => { seen.push({ sql, params }); return { changed: 1 }; };
    await rewriteFileIds(db, p, ids => [...ids, "f1"], "no", { now: () => at(1) });
    expect(seen[0].sql).toContain("AND updated_at = ?");
    expect(seen[0].params).toEqual(['["f1"]', at(1), "p1", at(0)]);
    expect(JSON.parse(p.file_ids)).toEqual(["f1"]);
  });

  it("re-reads and retries when another member wrote first", async () => {
    // The lost-update case: without the retry the loser's photo id would erase
    // the winner's, orphaning a file nothing ever reclaims.
    const p = project();
    let attempt = 0;
    const db = async (sql) => {
      if (sql.startsWith("SELECT")) return { rows: [{ id: "p1", file_ids: '["theirs"]', updated_at: at(5) }] };
      return { changed: ++attempt === 1 ? 0 : 1 };
    };
    await rewriteFileIds(db, p, ids => [...ids, "mine"], "no", { now: () => at(9) });
    expect(JSON.parse(p.file_ids)).toEqual(["theirs", "mine"]);
  });

  it("gives up with the caller's refusal once the row is gone", async () => {
    const db = async (sql) => (sql.startsWith("SELECT") ? { rows: [] } : { changed: 0 });
    await expect(rewriteFileIds(db, project(), ids => ids, "gone")).rejects.toThrow("gone");
  });

  it("gives up after a bounded number of attempts rather than spinning", async () => {
    let writes = 0;
    const db = async (sql) => {
      if (sql.startsWith("SELECT")) return { rows: [{ file_ids: "[]", updated_at: at(1) }] };
      writes += 1; return { changed: 0 };
    };
    await expect(rewriteFileIds(db, project(), ids => ids, "busy", { attempts: 4 })).rejects.toThrow("busy");
    expect(writes).toBe(4);
  });

  it("advances past a stamp spelled without milliseconds", async () => {
    // The same instant has more than one ISO spelling, and a row last written
    // by the hub (an automation's `$now`) need not match this client's. Compared
    // as strings, "…09:00:00Z" looked NEWER than the clock and the guard stopped
    // advancing the stamp.
    const p = project({ updated_at: "2026-09-05T09:00:00Z" });
    const db = async (_sql, params) => { p._wrote = params[1]; return { changed: 1 }; };
    await rewriteFileIds(db, p, ids => ids, "no", { now: () => at(0) });
    expect(Date.parse(p._wrote)).toBeGreaterThan(Date.parse("2026-09-05T09:00:00Z"));
  });

  it("never lets a same-millisecond stamp satisfy a racing caller's guard", async () => {
    const p = project();
    const db = async (_sql, params) => { p._wrote = params[1]; return { changed: 1 }; };
    await rewriteFileIds(db, p, ids => ids, "no", { now: () => at(0) });
    expect(p._wrote).toBe(at(1));
  });
});

describe("publishBestEffort", () => {
  it("swallows a rejecting publish instead of leaving it unhandled", async () => {
    // events.publish awaits a bare fetch, so a network failure REJECTS.
    const warned = [];
    const events = { publish: async () => { throw new Error("offline"); } };
    await expect(publishBestEffort(events, "project.created", "p1", {}, (m, e) => warned.push([m, e.message])))
      .resolves.toBe(false);
    expect(warned).toEqual([["could not publish project.created", "offline"]]);
  });

  it("reports a delivered publish", async () => {
    const events = { publish: async () => ({ ok: true }) };
    await expect(publishBestEffort(events, "project.created", "p1", {})).resolves.toBe(true);
  });

  it("awaits the publish rather than floating it", async () => {
    // Floating it let navigation cancel the request after the row was written.
    let settled = false;
    const events = { publish: () => new Promise(r => setTimeout(() => { settled = true; r(null); }, 5)) };
    await publishBestEffort(events, "x.y", "p1", {});
    expect(settled).toBe(true);
  });
});

describe("toggleDecision", () => {
  const shared = project({ visibility: "everyone" });
  const item = { id: "c1" };
  const closedByChild = completionIndex([{ id: "x1", item_id: "c1", done_by: "k1", done_at: "t" }]);

  it("lets anyone who can see the project close an open item", () => {
    expect(toggleDecision(item, shared, CHILD, completionIndex([])).action).toBe("complete");
  });

  it("refuses to close on a project the caller cannot see", () => {
    const d = toggleDecision(item, project({ visibility: "adults" }), CHILD, completionIndex([]));
    expect(d).toMatchObject({ action: "denied" });
  });

  it("lets the member who closed it reopen it", () => {
    expect(toggleDecision(item, shared, CHILD, closedByChild)).toMatchObject({ action: "reopen" });
  });

  it("lets an adult reopen someone else's tick (adults_bypass)", () => {
    expect(toggleDecision(item, shared, ADULT, closedByChild).action).toBe("reopen");
  });

  it("names the closer when it refuses a reopen", () => {
    const other = { id: "k2", role: "child" };
    const d = toggleDecision(item, shared, other, closedByChild, id => `Member ${id}`);
    expect(d).toMatchObject({ action: "denied" });
    expect(d.reason).toContain("Member k1");
  });
});

describe("announcedMilestoneIds", () => {
  const items = [
    { id: "c1", is_milestone: 1 },
    { id: "c2", is_milestone: 0 },
    { id: "c3", is_milestone: 1 },
  ];

  it("seeds already-closed milestones so a reload cannot re-announce them", () => {
    // The bug: the set lived only in memory, so reloading and then reopening
    // and re-ticking republished project.milestone_reached and re-ran every
    // subscribed automation.
    const seeded = announcedMilestoneIds(items, [
      { item_id: "c1", done_by: "a1" },
      { item_id: "c2", done_by: "a1" },
    ]);
    expect([...seeded]).toEqual(["c1"]);       // c2 is closed but not a milestone
  });

  it("leaves an open milestone announceable", () => {
    expect(announcedMilestoneIds(items, []).has("c3")).toBe(false);
  });

  it("is stable across repeated loads of the same rows", () => {
    const completions = [{ item_id: "c1" }, { item_id: "c3" }];
    expect([...announcedMilestoneIds(items, completions)])
      .toEqual([...announcedMilestoneIds(items, completions)]);
  });

  it("tolerates missing inputs", () => {
    expect(announcedMilestoneIds(undefined, undefined).size).toBe(0);
  });
});

describe("parseFileIds", () => {
  it("keeps only string ids and never throws on junk", () => {
    expect(parseFileIds('["a", 3, null, "b"]')).toEqual(["a", "b"]);
    expect(parseFileIds("not json")).toEqual([]);
    expect(parseFileIds(undefined)).toEqual([]);
    expect(parseFileIds('{"a":1}')).toEqual([]);
  });
});


// ── Paging ───────────────────────────────────────────────────────────────────

describe("chunk / D1_MAX_BINDS", () => {
  it("keeps an IN list under D1's bound-parameter ceiling", () => {
    // D1 refuses a statement with more than 100 binds. One is spent on
    // project_id, so an id list is cut at 89 — a full 200-item page in one
    // IN (…) was 201 binds, and any project with ~100 checklist items simply
    // failed to open.
    expect(D1_MAX_BINDS).toBeLessThanOrEqual(100);
    const ids = Array.from({ length: 200 }, (_, i) => `i${i}`);
    const groups = chunk(ids, D1_MAX_BINDS - 1);
    expect(groups.flat()).toEqual(ids);                    // nothing dropped
    for (const g of groups) expect(1 + g.length).toBeLessThanOrEqual(D1_MAX_BINDS);
  });

  it("returns nothing for an empty list and refuses a nonsense size", () => {
    expect(chunk([], 10)).toEqual([]);
    expect(chunk(undefined, 10)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("keysetClause", () => {
  it("resumes after the last row rather than counting from the start", () => {
    // OFFSET names a POSITION, and positions move: a row inserted or deleted
    // before the offset repeats or skips a row on the next page.
    const { sql, params } = keysetClause("budget", [3, "2026-09-05T09:00:00Z", "b7"]);
    expect(sql).toContain("sort_order > ?");
    expect(sql).toContain("created_at > ?");
    expect(sql).toContain("id > ?");
    expect(params).toEqual([3, 3, "2026-09-05T09:00:00Z", "2026-09-05T09:00:00Z", "b7"]);
  });

  it("reverses the comparison for a DESC order", () => {
    const { sql, params } = keysetClause("notes", ["2026-09-05T09:00:00Z", "n2"]);
    expect(sql).toContain("created_at < ?");
    expect(sql).toContain("id > ?");            // the tiebreaker never flips
    expect(params).toEqual(["2026-09-05T09:00:00Z", "2026-09-05T09:00:00Z", "n2"]);
  });

  it("binds exactly as many params as it has placeholders", () => {
    for (const [key, cursor] of [["budget", [1, "t", "a"]], ["checklist", [2, "t", "b"]], ["notes", ["t", "c"]]]) {
      const { sql, params } = keysetClause(key, cursor);
      expect(sql.split("?").length - 1, key).toBe(params.length);
    }
  });

  it("is empty at the top of the list", () => {
    expect(keysetClause("budget", null)).toEqual({ sql: "", params: [] });
    expect(keysetClause("budget", [])).toEqual({ sql: "", params: [] });
    expect(keysetClause("nope", [1])).toEqual({ sql: "", params: [] });
  });

  it("orders every table on a total key, so no page boundary can lose a row", () => {
    // Two rows sharing sort_order AND created_at would otherwise have no
    // defined order between them.
    for (const [key, spec] of Object.entries(CHILD_ORDERS)) {
      expect(spec.keys[spec.keys.length - 1], key).toBe("id");
      expect(spec.order, key).toContain("id");
    }
  });
});

describe("cursorFrom", () => {
  it("reads the ordering columns off the last row of a page", () => {
    const row = { id: "b7", sort_order: 3, created_at: "t", label: "ignored" };
    expect(cursorFrom(row, "budget")).toEqual([3, "t", "b7"]);
    expect(cursorFrom({ id: "n1", created_at: "t" }, "notes")).toEqual(["t", "n1"]);
  });

  it("is null when there is no row or no such tab", () => {
    expect(cursorFrom(null, "budget")).toBe(null);
    expect(cursorFrom({ id: "x" }, "nope")).toBe(null);
  });

  it("round-trips into a clause that binds the same values", () => {
    const cursor = cursorFrom({ id: "b7", sort_order: 3, created_at: "t" }, "budget");
    expect(keysetClause("budget", cursor).params).toEqual([3, 3, "t", "t", "b7"]);
  });
});


describe("mergeById", () => {
  it("does not duplicate a row the next page returns again", () => {
    // The concrete bug: a line item added locally sorts AFTER the tab's cursor,
    // so the next page fetches that same database row — and a concat put a
    // second copy in the array, which double-counted in the budget totals.
    const local = [{ id: "b1", estimated_cents: 100 }];
    const nextPage = [{ id: "b1", estimated_cents: 100 }, { id: "b2", estimated_cents: 50 }];
    const merged = mergeById(local, nextPage);
    expect(merged.map(r => r.id)).toEqual(["b1", "b2"]);
    expect(budgetTotals(merged).estimatedCents).toBe(150);   // not 250
  });

  it("lets the server's copy win over an optimistic local one", () => {
    const merged = mergeById([{ id: "b1", label: "guessed" }], [{ id: "b1", label: "stored" }]);
    expect(merged).toEqual([{ id: "b1", label: "stored" }]);
  });

  it("keeps the existing rows when there is nothing to merge", () => {
    const rows = [{ id: "a" }];
    expect(mergeById(rows, [])).toBe(rows);
    expect(mergeById(undefined, [])).toEqual([]);
  });

  it("is idempotent — merging the same page twice changes nothing", () => {
    const page = [{ id: "a" }, { id: "b" }];
    expect(mergeById(mergeById([], page), page)).toEqual(page);
  });
});

describe("display comparators", () => {
  it("orders budget rows by sort_order, then created_at, then id", () => {
    const rows = [
      { id: "z", sort_order: 1, created_at: "t1" },
      { id: "a", sort_order: 0, created_at: "t2" },
      { id: "b", sort_order: 0, created_at: "t1" },
      { id: "c", sort_order: 0, created_at: "t1" },
    ];
    expect([...rows].sort(compareBudgetRows).map(r => r.id)).toEqual(["b", "c", "a", "z"]);
  });

  it("orders decisions newest first, with a stable id tiebreak", () => {
    const rows = [
      { id: "n1", created_at: "2026-01-01" },
      { id: "n3", created_at: "2026-03-01" },
      { id: "n2", created_at: "2026-03-01" },
    ];
    expect([...rows].sort(compareNoteRows).map(r => r.id)).toEqual(["n2", "n3", "n1"]);
  });

  it("puts open projects first, dated before undated, soonest first", () => {
    // Mirrors the preload's
    // `(completed_at IS NULL) DESC, (target_date IS NULL), target_date, created_at`.
    const rows = [
      { id: "done",    completed_at: "t", target_date: null,         created_at: "1" },
      { id: "undated", completed_at: null, target_date: null,        created_at: "1" },
      { id: "later",   completed_at: null, target_date: "2026-12-01", created_at: "1" },
      { id: "soon",    completed_at: null, target_date: "2026-01-01", created_at: "1" },
    ];
    expect([...rows].sort(compareProjectRows).map(r => r.id))
      .toEqual(["soon", "later", "undated", "done"]);
  });

  it("is a total order, so a merge cannot reshuffle equal rows", () => {
    const rows = [{ id: "b", created_at: "t" }, { id: "a", created_at: "t" }];
    const once = [...rows].sort(compareNoteRows).map(r => r.id);
    const twice = [...rows].reverse().sort(compareNoteRows).map(r => r.id);
    expect(once).toEqual(twice);
  });
});

describe("mergeSorted", () => {
  it("merges then orders, so arrival order never shows through", () => {
    const held = [{ id: "b1", sort_order: 0, created_at: "t" }];
    const late = [{ id: "b0", sort_order: -1, created_at: "t" }, { id: "b1", sort_order: 0, created_at: "t" }];
    expect(mergeSorted(held, late, compareBudgetRows).map(r => r.id)).toEqual(["b0", "b1"]);
  });

  it("leaves order alone when no comparator is given", () => {
    expect(mergeSorted([{ id: "z" }], [{ id: "a" }]).map(r => r.id)).toEqual(["z", "a"]);
  });
});


// ── Late repaints ────────────────────────────────────────────────────────────

describe("shouldRepaint", () => {
  it("allows a background repaint when nothing is being edited", () => {
    expect(shouldRepaint({})).toBe(true);
    expect(shouldRepaint({ activeElementId: "project-list" })).toBe(true);
    expect(shouldRepaint()).toBe(true);
  });

  it("refuses while the search box has focus", () => {
    // A repaint re-creates #root, so it destroys and rebuilds the input the
    // caret is in — the rest of what someone was typing goes with it.
    expect(shouldRepaint({ activeElementId: "search" })).toBe(false);
  });

  it("refuses while a modal is open", () => {
    expect(shouldRepaint({ modalOpen: true })).toBe(false);
    expect(shouldRepaint({ modalOpen: true, activeElementId: "f-name" })).toBe(false);
  });
});

describe("loadProjectTail", () => {
  const project = (id) => ({ id, completed_at: null, target_date: null, created_at: "t" });
  /** A db stub serving fixed pages, with a deferred hook for the race test. */
  const pagedDb = (pages) => {
    const calls = [];
    return {
      calls,
      db: async (sql, params) => {
        calls.push(params[0]);
        return { rows: pages.shift() ?? [] };
      },
    };
  };
  /** The caller's side: a live list the loader merges into, as index.html does. */
  const collector = (held = []) => {
    let list = held;
    return {
      get list() { return list; },
      add(rows) { list = mergeSorted(list, rows, compareProjectRows); },
    };
  };

  it("walks pages until a short one and merges by id", async () => {
    const { db, calls } = pagedDb([[project("a"), project("b")], [project("c")]]);
    const held = collector([project("a")]);
    await loadProjectTail({ db, sql: "S", pageSize: 2 }, ["a"], rows => held.add(rows));
    expect(held.list.map(p => p.id)).toEqual(["a", "b", "c"]);
    expect(calls).toEqual(["", "b"]);            // keyset cursor, not an offset
  });

  it("hands over the page's NEW rows, so the caller merges into the live list", async () => {
    // The bug this closes: the loader used to merge into a copy of the list
    // taken when it started, and hand back that copy. A project created — or
    // deep-linked in — while the tail was loading was erased by the next page.
    const { db } = pagedDb([[project("a")], [project("b")], []]);
    const held = collector([]);
    const walking = loadProjectTail({ db, sql: "S", pageSize: 1 }, [], rows => held.add(rows));
    held.add([project("zz-created-meanwhile")]);
    await walking;
    expect(held.list.map(p => p.id)).toEqual(["a", "b", "zz-created-meanwhile"]);
  });

  it("reports progress ONLY through onRows — it never renders itself", async () => {
    // The loader used to call render() per page, which bypassed the caller's
    // guard entirely.
    const { db } = pagedDb([[project("a")], [project("b")], []]);
    const seen = [];
    await loadProjectTail({ db, sql: "S", pageSize: 1 }, [], rows => seen.push(rows.length));
    expect(seen).toEqual([1, 1]);
  });

  it("does not report a page that added nothing already held", async () => {
    const { db } = pagedDb([[project("a")]]);
    const seen = [];
    await loadProjectTail({ db, sql: "S", pageSize: 2 }, ["a"], () => seen.push(1));
    expect(seen).toEqual([]);
  });

  it("a tail page resolving while Search is focused does not repaint", async () => {
    // The reported failure, end to end: a deferred tail query resolves mid-typing.
    let release;
    const gate = new Promise(r => { release = r; });
    const db = async () => { await gate; return { rows: [project("z")] }; };

    let activeElementId = "search";                 // the user is typing
    const renders = [];
    const held = collector([]);
    const onRows = (rows) => {
      held.add(rows);
      if (!shouldRepaint({ activeElementId })) return;
      renders.push("render");
    };

    const walking = loadProjectTail({ db, sql: "S", pageSize: 99 }, [], onRows);
    release();
    await walking;

    expect(held.list.map(p => p.id)).toEqual(["z"]);   // the rows DID arrive
    expect(renders).toEqual([]);                       // but nothing repainted

    // …and once focus leaves, the caller's own repaint shows them.
    activeElementId = null;
    onRows([]);
    expect(renders).toEqual(["render"]);
  });

  it("stops at the page cap rather than walking forever", async () => {
    let n = 0;
    const db = async () => ({ rows: [{ id: `p${n++}`, completed_at: null, created_at: "t" }] });
    const held = collector([]);
    await loadProjectTail({ db, sql: "S", pageSize: 1, maxPages: 3 }, [], rows => held.add(rows));
    expect(held.list).toHaveLength(3);
  });

  it("stops on an empty page", async () => {
    const { db, calls } = pagedDb([[]]);
    const seen = [];
    await loadProjectTail({ db, sql: "S", pageSize: 5 }, [], rows => seen.push(rows));
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
