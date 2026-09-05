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
scopes `UPDATE`/`DELETE` on a child table to the member who wrote the row. A
`done_at` column on `checklist_items` could therefore only ever be set by whoever
*created* the item (or, since the tables opted into `adults_bypass`, by an
adult), so a child the task was assigned to could never tick it off. A completion
row the ticker owns fixes that: anyone who can see the project may close an item,
and it is reopened by whoever closed it or by an adult. This is the shape
chore-tracker uses for the same problem.

**All four child tables declare `adults_bypass: true`.** Without it the writer
term is absolute — this app configures no privileged group, and an
`owner_or_visibility` parent grants no other write bypass — which left a bogus
budget line, a mistaken tick and a note with no correction path but deleting the
whole project, and froze a departed member's rows permanently (the writer columns
use `on_removed: "keep"` so attribution survives, and no session ever carries
that id again). The bypass follows the parent's **read** rule: an adult still
needs visibility of the project, so someone else's `private` project hides its
children as before. Note the default is the **inverse** of `owner_only`'s
`adults_bypass`, which is on unless disabled; on `inherit_visibility` it is off
unless declared. `canEditChild` / `canUncompleteItem` in `src/logic.js` mirror it.

**Structural columns are locked.** `projects` uses `write_visibility_scoped`, so
anyone who can *see* a project may edit it. Without `column_write_acls` that also
meant rewriting `created_by` to yourself and flipping `visibility` to `private` —
hiding a shared project from its author and from every adult. `created_by` and
`created_at` are now immutable on `UPDATE`, and `visibility` is owner-only.

**Events only carry `everyone` projects.** App events have no audience — the hub
scopes them to the household and nothing else — so every payload is readable by
every member, a child included, and by any automation acting for them. Putting an
`adults`-only project's name, budget or item title on the bus is a leak, and
assigning a child to an adults-only item used to publish that title straight onto
their task list. So `mayPublish` requires `visibility === "everyone"`. The
consequence is real and intended: **the Tasks bridge fires only for
household-wide projects.** Revisit this if events ever grow an enforced audience.
The assignee picker is filtered to members who can open the project, and the save
path re-checks, because a picker is not a boundary.

**Structural columns are immutable.** `adults_bypass` lets a supervisor UPDATE any
child row of a project they can see, which is far more reach than the UI's edit
buttons imply. `column_write_acls` pins the columns no edit path touches — `id`,
`project_id`, `created_by`/`done_by`, `created_at`, `sort_order`, and the
`source_event_id` automation dedupe key. `notes` and `checklist_completions` have
no edit path at all (a decision is retracted and re-logged; a tick is undone and
re-made), so every one of their columns is immutable and UPDATE has no legitimate
shape left.

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

**The projects preload needs its expression index.** Its `ORDER BY` sorts on two
boolean expressions — open projects first, then dated before undated, which is
SQLite's missing `NULLS LAST`. A plain column index cannot answer an expression,
so the planner falls back to a full scan plus a temp B-tree, and contract-ci
fails the release for it. `app_projects__projects_order_idx` mirrors that
ordering term for term, DESC included. Change one and you must change the other.

**Child tabs page by KEYSET, and the completions read is chunked.** Two platform
limits meet here: D1 refuses a statement with more than 100 bound parameters
(the hub chunks its own `IN (…)` at 90), and the row-policy rewriter parses app
SQL with node-sql-parser, which is narrower than D1 — a statement it cannot
parse is refused outright rather than degraded. So the resume predicate is
nested OR/AND rather than a row-value comparison, every ORDER BY ends in `id` to
make the sort total, and an id list is cut at 89. Change `keysetClause` or
`CHILD_ORDERS` in `logic.js` and you must change the mirrored SQL in the hub's
`projects-app-policies` lane.

**A stated total is exact or it is not stated.** Every number the app presents
as a fact — the committed spend, `n/m done`, the tab counts, and the
`committed_cents` it publishes on `project.completed` and
`project.budget_exceeded` — comes from the grouped aggregate reads in
`SUMMARY_READS`, never from the rows on screen. The rows on screen are one page.
A project whose totals are not known yet renders no total at all: an absent
summary is not a zero, `applyDelta` refuses to build on one, and `crossedCap`
will not announce an overrun it cannot measure. This is why there is no
`crossesBudget(project, itemsBefore, itemsAfter)` any more — taking item lists
was the bug. The aggregates are not preloads because `MAX_PRELOAD_STATEMENTS` is
6 and the manifest already declares 5.

**Pages are merged by id and then sorted, never concatenated.** A row added
locally sorts after the tab's cursor, so the next page returns it again; the
comparators in `logic.js` mirror each table's read order, and migration 002's
composite indexes cover exactly those orders. Change a read order and you must
change both — `schema.test.mjs` fails until you do.

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

## How this app is tested

Three layers, because no single one can see everything:

| Layer | Runs | Catches |
|---|---|---|
| `npm test` (this repo) | 193 tests, no hub dependency | pure logic, the client gates, and every failure path — refused writes, lost-update retries, dropped publishes |
| contract-ci (hub repo) | via `preflight.sh` and again in release CI | manifest validity, migrations, row-policy references, and the **query-plan gate** that EXPLAINs every declared preload |
| `projects-app-policies.test.ts` (hub repo) | hub integration suite | the real row-policy rewriter against this bundle — the write matrix, immutable columns, and the read/write asymmetry |

The split is forced: this repo depends on nothing but vitest, so it cannot
EXPLAIN a query or call `applyRowPolicy`. Anything asserting what the *platform*
does with this manifest has to live in the hub.

Three couplings the app's own tests guard, because each has already drifted once:
a client gate that grants adults over a policy that does not (the logic tests
stay green either way, so `schema.test.mjs` ties the gate to the manifest flag),
the preload's `ORDER BY` against the expression index that serves it; and
`SUMMARY_READS` against the migrations — the columns it sums, their INTEGER
types (a TEXT column would be ciphertext and would sum to nothing, silently),
and an index leading with the column it groups by.

## Development

```bash
make setup     # once after cloning — enables the pre-push hook (build + tests)
npm test       # 193 tests across 4 files
node build.mjs # validates migrations, surfaces and inline handlers
npm run dev    # local dev server with demo data
```

Node 22 is required; `build.mjs` will not run on older runtimes.
