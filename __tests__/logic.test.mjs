import { describe, it, expect } from "vitest";
import {
  STATUS_LABELS,
  toCents, fmtDollars, centsInput,
  budgetTotals, budgetStatus, crossesBudget, itemsAfterSave,
  checklistProgress, sortChecklist, isOverdue, nextDueDate,
  completionIndex, completionOf, isDone,
  canSeeProject, canEditProject, canDeleteProject, canAddChild, canEditChild,
  canCompleteItem, canUncompleteItem, visibilityChoicesFor, isUndeletableWhilePrivate,
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

describe("crossesBudget", () => {
  const capped = project({ budget_cap_cents: 10000 });
  const add = (items, item) => crossesBudget(capped, items, itemsAfterSave(items, item));

  it("is true only for the edit that first breaks the budget", () => {
    const items = [line({ id: "b1", estimated_cents: 9000 })];
    expect(add(items, line({ id: "b2", estimated_cents: 2000 }))).toBe(true);
  });

  it("is false when the addition still fits", () => {
    const items = [line({ id: "b1", estimated_cents: 5000 })];
    expect(add(items, line({ id: "b2", estimated_cents: 2000 }))).toBe(false);
  });

  it("is false once the budget is ALREADY blown, so the overrun is announced once", () => {
    // Without this, every later line item would re-publish project.budget_exceeded
    // and the household would be told the same bad news over and over.
    const items = [line({ id: "b1", estimated_cents: 15000 })];
    expect(add(items, line({ id: "b2", estimated_cents: 100 }))).toBe(false);
  });

  it("does not re-announce when the item being edited is the one that broke it", () => {
    // The regression this guards: measuring "before" against the items MINUS
    // the edited one hides the overrun, so editing the $5,000 line's label
    // under a $10,000 cap alongside a $6,000 line re-fired the event on every
    // single save.
    const items = [line({ id: "b1", estimated_cents: 6000 }), line({ id: "b2", estimated_cents: 5000 })];
    expect(add(items, line({ id: "b2", estimated_cents: 5000 }))).toBe(false);
  });

  it("is false when an edit leaves the budget over but does not newly cross it", () => {
    const items = [line({ id: "b1", estimated_cents: 6000 }), line({ id: "b2", estimated_cents: 5000 })];
    expect(add(items, line({ id: "b2", estimated_cents: 7000 }))).toBe(false);
  });

  it("is false with no cap to cross", () => {
    const items = [line({ id: "b1" })];
    expect(crossesBudget(project(), items, itemsAfterSave(items, line({ id: "b2", estimated_cents: 999999 })))).toBe(false);
  });
});

describe("itemsAfterSave", () => {
  it("replaces the row with the same id rather than appending a duplicate", () => {
    const items = [line({ id: "b1", estimated_cents: 100 }), line({ id: "b2", estimated_cents: 200 })];
    const after = itemsAfterSave(items, line({ id: "b2", estimated_cents: 900 }));
    expect(after).toHaveLength(2);
    expect(after.find(i => i.id === "b2").estimated_cents).toBe(900);
  });

  it("appends a row whose id is not present yet", () => {
    const items = [line({ id: "b1" })];
    expect(itemsAfterSave(items, line({ id: "new" }))).toHaveLength(2);
  });

  it("does not mutate the array it was given", () => {
    const items = [line({ id: "b1", estimated_cents: 100 })];
    itemsAfterSave(items, line({ id: "b1", estimated_cents: 900 }));
    expect(items[0].estimated_cents).toBe(100);
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

  it("gives an adult NO bypass over another member's child row", () => {
    // `inherit_visibility` derives its write bypass from privileged_groups
    // alone, and this app configures none — so adults are writer-scoped too.
    // Verified against the real hub: the UPDATE comes back changed: 0.
    expect(canEditChild(line({ created_by: "k1" }), shared, ADULT)).toBe(false);
    expect(canEditChild(line({ created_by: "a1" }), shared, ADULT)).toBe(true);
  });

  it("refuses everything on a project the caller cannot see", () => {
    const priv = project({ visibility: "private", created_by: "a1" });
    expect(canEditChild(line({ created_by: "a2" }), priv, OTHER_ADULT)).toBe(false);
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

  it("lets only whoever closed the item reopen it", () => {
    expect(canUncompleteItem(completion, shared, CHILD)).toBe(true);
    expect(canUncompleteItem(completion, shared, ADULT)).toBe(false);
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
