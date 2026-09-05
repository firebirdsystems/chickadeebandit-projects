# Projects

Plan a household project — a renovation, a move, a big purchase — in one place:
a budget of estimated-versus-actual line items, a checklist with deadlines and
milestones, photos of how it went, and a log of what you decided and why.

## The data model

Five tables, all `app_projects__`-prefixed.

| Table | Holds | Row policy |
|---|---|---|
| `projects` | name, description, status, visibility, target date, budget cap, `file_ids` | `owner_or_visibility` |
| `budget_items` | label, vendor, `estimated_cents`, nullable `actual_cents`, purchased flag | `inherit_visibility` |
| `checklist_items` | title, due date, assignee, `is_milestone` flag | `inherit_visibility` |
| `checklist_completions` | who closed an item, and when | `inherit_visibility` |
| `notes` | the decisions log — what was chosen and why | `inherit_visibility` |

## Decisions worth not reversing by accident

**`actual_cents` is nullable on purpose.** An unpaid line item contributes its
*estimate* to the committed total; a zero would read as free. That distinction is
the whole point of the budget tab, and it is unit-tested.

**Completion is its own row, not a column on the item.** `inherit_visibility`
scopes `UPDATE`/`DELETE` on a child table to the member who wrote the row — there
is no adult bypass, and no option to widen it. A `done_at` column on
`checklist_items` could therefore only ever be set by whoever *created* the item,
so the person it was assigned to could never tick off their own task. A
completion row the ticker owns fixes that: anyone who can see the project may
close an item, and only the member who closed it may reopen it. This is the shape
chore-tracker uses for the same problem.

**Structural columns are locked.** `projects` uses `write_visibility_scoped`, so
anyone who can *see* a project may edit it. Without `column_write_acls` that also
meant rewriting `created_by` to yourself and flipping `visibility` to `private` —
hiding a shared project from its author and from every adult. `created_by` and
`created_at` are now immutable on `UPDATE`, and `visibility` is owner-only.

**No `retain_days`.** A finished renovation is a record a household keeps, not a
log that should expire. A deliberate departure from most apps here.

**A private project never reaches the cross-app bus or the activity feed**
(`mayPublish` / `mayLogActivity` in `src/index.html`) — both are read by people
who cannot open the project.

**`project.budget_exceeded` fires once**, and **`project.task_assigned` fires
only on a NEW assignment** — otherwise every later edit would re-announce, and
the assignee would collect a duplicate task each time a title changed.

## Two things to know before changing a query

**The agenda reaches completions through a `LEFT JOIN`, never a subquery.** A
policy-governed table reachable *only* from inside a CTE or subquery fails closed
and the whole statement is refused. A *joined* one is rewritten in place, and the
policy lands on the JOIN's `ON` clause — so the `LEFT` stays `LEFT` and an
un-ticked item still comes back with `done = 0`.

**Run the hub's row-policy lane for any preload or surface change.** The app
release gate runs `assertAppSqlScoped` only, never `applyRowPolicy`, so a preload
the rewriter refuses passes CI clean and then throws on every launch:

```bash
cd ../../chickadeebandit/packages/hub
CI=true CB_APPS_DIR=/path/to/chickadeebandit-apps \
  node ../../node_modules/vitest/vitest.mjs run __tests__/unit/app-preload-row-policy.test.ts
```

## The AI exports need a member

`ai_access.db_exports` (`active_projects`, `budget_summary`) read member-scoped
tables, so there is no household-wide read of them. A household-scoped MCP token
carries no member identity and gets a 403 telling it to pass one; the MCP tools
accept a `member_id` argument, and member-bound tokens supply it implicitly.

## Development

```bash
make setup     # once after cloning — enables the pre-push hook (build + tests)
npm test       # 86 tests across 4 files
node build.mjs # validates migrations, surfaces and inline handlers
npm run dev    # local dev server with demo data
```

Node 22 is required; `build.mjs` will not run on older runtimes.
