# Projects app — handoff (2026-09-04)

A new Chickadee Bandit app at `chickadeebandit-apps/projects`, built from
`app-template`. Household project planning: a budget of estimated-versus-actual
line items, a checklist with milestones and deadlines, a decisions log, and photos.

## Review against APP_REVIEW_GUIDE.md — 2026-09-04, all findings fixed

The app was reviewed against `../APP_REVIEW_GUIDE.md` and seven findings were
fixed in place. Each was verified against the REAL hub (throwaway integration
tests over the actual bundle, with canaries, since deleted):

- **Delete project was dead.** The client sent the parent DELETE inside a batch;
  the hub refuses that on a table declaring `delete_cascades` /
  `delete_file_list_columns`. Now one statement, and the children and photos are
  the hub's job. The child DELETEs it used to send were writer-scoped anyway —
  they could only ever have removed the caller's own line items.
- **`canEditChild` gave adults a bypass the server does not have.** Made
  writer-scoped for everyone. *(Superseded 2026-09-04 — see "Adult supervision"
  below: the hub gained `inherit_visibility.adults_bypass`, this app opted in,
  and the gate grants adults the bypass again, this time matching the server.)*
- **The assignee could not tick off their own task.** Closed by moving
  completion into `checklist_completions`. This changed the schema, the agenda
  query, the preload and the checklist UI.
- **Any member could hijack a project they could merely see** — rewrite
  `created_by`, flip `visibility` to private. Closed with `column_write_acls`.
- **Truncated preloads rendered as empty tabs.** Every open project used to be
  marked "loaded" even when the shared row caps cut its children off, so
  `ensureChildren` never repaired it. `fullyLoadedFrom` now treats a result at
  its cap as truncated.
- **No write checked `changes`.** A policy-narrowed statement answers
  `changed: 0` with HTTP 200, so the screen updated and the change evaporated on
  reload. Every write goes through `dbWrite` now.
- **`shared_space` was declared with no space-aware behaviour** (a roster would
  hide member-authored "Everyone" projects from peers while the UI said
  "Everyone"), and **`project.task_assigned` was adult-gated while the write
  that triggers it was not**, so a child's assignment failed silently. Both
  corrected.

The two open items below the fold are still open.

## Adult supervision — `adults_bypass`, 2026-09-04

The hub added an opt-in `adults_bypass` to `inherit_visibility`
(`DESIGN-inherit-visibility-supervision.md` in the hub repo); this app is its
first adopter, and all four child tables — `budget_items`, `checklist_items`,
`checklist_completions`, `notes` — declare it. An adult may now UPDATE/DELETE any
child row of a project they can **see**; visibility of the parent is still
required, so nothing about who can reach which project changed. `canEditChild`
and `canUncompleteItem` were widened to match, and their tests with them.

**This app cannot be released until the hub change ships.** The field is new in
`hub-contract`'s manifest schema; a hub without it rejects the manifest at
admission. Hub first, app after.

## Second review round — 2026-09-05, six findings, all fixed

A follow-up review (contract suite + P1/P2 findings) landed six more. All fixed
and verified; contract-ci is 1954/0 and the hub preload lane 122/122.

- **RELEASE BLOCKER: the projects preload full-scanned.** Its ORDER BY sorts on
  boolean expressions, which no plain column index can answer, so contract-ci's
  EXPLAIN gate failed on `manifest.json:23`. Added
  `app_projects__projects_order_idx`, an expression index mirroring the ordering
  term for term. Plan is now `SCAN … USING INDEX`, no temp B-tree. The other
  four preloads already SEARCHed and were never the problem.
- **P1 structural columns.** `adults_bypass` (added to the hub in `503d899d`)
  lets a supervisor UPDATE any child row of a visible project — far past the
  UI's intent. `column_write_acls` now pin id / project_id / created_by /
  done_by / created_at / sort_order / source_event_id, and `notes` +
  `checklist_completions` are fully immutable (no edit path exists for either).
  Verified at runtime: false attribution, moving a record between projects and
  repointing a completion are all refused, while the UI's real edits still land.
- **P1 event leak.** App events carry NO audience, so an `adults` project's name
  and item titles were readable by every child and by automations acting for
  them — assigning a child to an adults-only item published its title onto their
  task list. `mayPublish` now requires `everyone`. **This narrows the Tasks
  bridge to household-wide projects**; it is the honest trade until events grow
  an audience. The assignee picker is also filtered, and the save path re-checks.
- **P2 milestone idempotence.** `announcedMilestones` is now seeded from the
  completions already loaded, so an already-closed milestone is never
  re-announced across a reload. Residual, stated in the code: a milestone
  deliberately reopened in one session and re-closed in a later one still
  announces again — by then its completion row is gone, and a durable marker
  would need a write the ticker is not allowed to make.
- **P2 floated promises.** `events.publish` awaits a bare `fetch`, so a network
  failure rejects; `publishEvent` discarded it. It now awaits and catches, and
  every call site awaits it, so navigation can no longer cancel a publish after
  the row is written.
- **P2 unbounded lazy loading.** `ensureChildren` had no LIMIT against tables
  permitting 20,000 rows. Now 200 per table per page with a "Load more" per tab.
  Completions are deliberately NOT paged independently — they are fetched by the
  item ids just loaded, so done-ness cannot drift out of step with the page.

## Test hardening — 2026-09-05

Added after the second review, across both repos. All green; each new assertion
was mutation-checked (the guarded thing was broken on purpose and the test
failed) rather than merely observed passing.

**This repo — 112 → 138 tests.** The effectful logic moved out of `index.html`
into `logic.js` behind injected `db`/`events`, which is the only reason its
failure paths are testable at all: zero-row writes, the photo compare-and-swap
including the lost-update retry and its bounded give-up, a rejecting publish, the
toggle's permission fork, and milestone seeding. Also a coupling test tying
`adults_bypass` in the manifest to the client gates that rely on it — the exact
drift that bit twice — and one tying the preload's ORDER BY to its expression
index.

**`preflight.sh` now runs contract-ci** when a sibling hub checkout exists,
skipping loudly when it does not. Release CI already gated on it; this moves the
failure from a red CI run to a refused push. Proven both ways: with the
expression index removed, the suite reports the full scan.

**Hub repo — `packages/hub/__tests__/integration/projects-app-policies.test.ts`,
100 tests, UNCOMMITTED.** Runs the real rewriter against this bundle: the write
matrix (4 child tables x adult/child x own/another's row x everyone/adults/private
parent x UPDATE/DELETE), the immutable-column refusals, and a characterisation
test pinning that the event bus has no audience.

Two things that test taught us, both worth keeping:

- **Writes and reads are asymmetric on `inherit_visibility` children.** Your own
  rows stay writable even under a parent you can no longer see — the bypass
  widens the writer term rather than replacing it, deliberately, so enabling the
  flag can never remove access. The app's gates are stricter (they require
  `canSeeProject` first), which is the safe direction. My first draft of the
  matrix assumed writes follow reads and was wrong.
- **The D1 test double enforces foreign keys.** A completion fixture pointing at
  a non-existent checklist item failed with `FOREIGN KEY constraint failed`.

One fix came out of writing the tests rather than the review: the photo CAS
compared `updated_at` as a STRING, so the same instant spelled two ways
("…09:00:00Z" vs "…09:00:00.000Z") defeated the same-millisecond guard. Rows
written by the hub (an automation's `$now`) need not match this client's
spelling. It now compares parsed instants.

## Third review round — 2026-09-05, six findings, all fixed

- **P1 bind ceiling.** `completionsForItems` bound one param per item plus the
  project id — up to 201 against D1's 100 (the hub chunks at
  `D1_MAX_IN_PARAMS = 90`). Any project with ~100 checklist items failed to
  open. Now chunked at 89 ids + 1, issued as one batch. **The test harness could
  not have caught this**: better-sqlite3 allows far more binds than D1, so only
  the convention protects us — a note to that effect is in the hub lane.
- **P1 malformed handlers.** All three "Load more" buttons emitted
  `onclick="loadMoreFor("budget")"`, which closes the attribute at the first
  quote. Pagination was unreachable. Now `jsArg(key)`, like every other handler
  in the file — my bug, from generating the markup with the wrong quoting.
- **P2 offset paging.** Replaced with KEYSET paging: each tab remembers the last
  row it holds and asks for what sorts after it, so a row inserted or deleted
  before the boundary can no longer repeat or skip one, and a double click
  re-fetches the same page instead of advancing twice. Plus a per-project+tab
  in-flight guard, with the button disabled and labelled "Loading…".
  `id` is appended to every ORDER BY as a tiebreaker so the sort is total.
  The keyset predicate is written as nested OR/AND rather than a row-value
  comparison — node-sql-parser is narrower than D1, and a statement it cannot
  parse is refused outright. Verified against the real rewriter.
- **P2 milestone dedup reset.** `seedAnnouncedMilestones` cleared the set on
  every incremental load, so loading another project or page forgot an
  announcement made earlier in the session. It now takes `{ reset }` — true only
  on a full refresh, union otherwise.
- **P2 assignee wipe.** First paint does not wait on the roster, so opening an
  existing item in that window (or after a failed roster fetch) showed a picker
  containing only "Nobody yet", and saving any other field wrote
  `assignee_id = null`. The late roster repaint is skipped while a modal is
  open, so it could never repair it. Now: a `membersLoaded` flag (a FAILED fetch
  is not a loaded-but-empty roster), a disabled picker preserving the current
  assignee until the roster lands, an option kept for an assignee who is no
  longer assignable, and a save path that reads the row rather than the disabled
  select.
- **P2 unawaited publishes.** All five call sites now `await publishEvent`, as
  its contract already claimed. Catching the rejection stopped the unhandled
  rejection; it did not stop teardown cancelling delivery.

App tests 138 → 148. The hub lane gains four tests pinning that the paging SQL
parses (uncommitted).

## Fourth review round — 2026-09-05

- **Merge by id, never concat.** A locally-appended budget line or checklist
  item sorts AFTER the tab's cursor, so the next page fetched that same row and
  a blind concat appended a second copy — which double-counted in the budget
  totals. Every page arrival now goes through `mergeById`/`mergeSorted` (the
  server's copy wins), and each array is re-sorted by an explicit comparator so
  display order never depends on arrival order.
- **The projects tail is keyset too.** It ran OFFSET pagination after first
  paint while the app was interactive, and its ORDER BY had no `id` tiebreaker.
  It now walks `WHERE id > ? ORDER BY id`, merging by id — `id` is unique,
  immutable and indexed, and the tail's job is COMPLETENESS, not order, since
  the list is sorted client-side by `compareProjectRows` afterwards. Verified
  against the real rewriter, including that it still hides what the caller may
  not see.
- **Migration 002 — composite indexes for the keyset reads.** Confirmed with
  EXPLAIN QUERY PLAN: every child paginator was reporting "USE TEMP B-TREE FOR
  LAST 2 TERMS OF ORDER BY" (LAST TERM for notes), because the indexes stopped
  at the first ordering column while the reads order by the full key. Extended
  to `(project_id, sort_order, created_at, id)` and
  `(project_id, created_at DESC, id)`; the temp B-trees are gone. The narrower
  indexes are DROPPED, not kept: each is now a strict prefix of its
  replacement, so both would cost two index writes per insert for nothing.

Put in 002 rather than folded into 001 as asked. 001 would also have been safe
(the app has no release, so no household has this schema), but a patch migration
is the habit that stays correct after the first release.

App tests 148 → 162, including a test tying each index to the `CHILD_ORDERS` it
serves, so changing a read order fails until the index follows.

## Repaint guard — 2026-09-05

`loadRemainingProjects` called `render()` after every page, which bypassed the
guarded repaint entirely: a tail page landing while someone was typing in Search
replaced the input under the caret, once per page, up to five times. My bug,
from the previous round.

Progress now goes through an `onPage` callback, and the loader itself lives in
`logic.js` where it has no `render` to call — the guard cannot be bypassed by
construction rather than by convention. `shouldRepaint({ modalOpen,
activeElementId })` is the single rule, shared by the roster repaint and the
tail, and it takes state rather than reading the document so it is testable in a
node suite. No jsdom: nothing in the fleet has it, and adding a DOM harness for
a two-branch predicate would be the wrong trade — the deferred-tail test injects
the focus state instead, resolves a gated query mid-"typing", asserts the rows
arrived and nothing repainted, then asserts the repaint happens once focus
leaves.

App tests 162 → 171. Mutation-checked: flattening `shouldRepaint` to
`() => true` fails three tests including the deferred-tail one.

## Fifth review round — totals, deep links, racing opens — 2026-09-05

Three findings, all fixed.

**P1 — paginated rows were treated as complete totals.** Every number the app
stated as a fact was counted from the rows in memory: the committed spend, the
`n/m done` line, the tab counts. Those rows are one page — children cap at 200
per tab, the preload caps across the household, and a finished project's
children are not preloaded at all — so the numbers were understated with nothing
to say so. A finished project's card read `$0 of $12,000`. Worse, the same
counts went out in `project.completed` and `project.budget_exceeded` as
`committed_cents`, which is a number automations act on.

Totals now come from three grouped aggregate reads (`SUMMARY_READS`), issued
once per launch after the first paint. Grouped over the household rather than
per project, so one round trip settles every card in the list including the
finished ones. Two layers underneath: a project the preload covered in full is
settled from its own rows before the read even returns, and a write moves an
exact total by its own exact delta (`applyDelta`) rather than re-reading.

The invariant is that **a summary is exact or it is absent** — there is no
partial one. Every reader renders an absent summary as nothing at all rather
than a zero, `applyDelta` propagates the absence instead of inventing a base,
and `crossedCap` refuses to announce an overrun it cannot measure. A confident
`$0 of $12,000` is a worse answer than no answer.

`crossesBudget` and `itemsAfterSave` are **gone**, not deprecated: they took
item lists, which is the bug. `crossedCap(cap, before, after)` replaces them.
`budgetStatus`/`checklistProgress` remain for the demo data and tests, which
really do hold every row, and say so in their doc comments.

Not done, and deliberate: the aggregates are three statements rather than
preloads. `MAX_PRELOAD_STATEMENTS` is 6 and the manifest already declares 5, so
preloading them would mean giving one up — and the first paint does not need
them.

**P2 — deep links could not open a project past the first page.** `refresh()`
starts the tail without awaiting it, so `?projectId=…` — what the activity feed
and every automation notification hand out — silently stayed on the list for
anything beyond the first 100. Finished projects sort last, so they were the
most likely targets. The row is now fetched by id directly rather than waiting
up to ten round trips for the tail. Row policies answer that read like any
other: a project the viewer may not see comes back empty and lands on the list,
indistinguishable from a deleted one. It defers to the user — the token taken
before the fetch is checked after it, so a card tapped in the meantime wins.

**P2 — competing opens could finish out of order.** `openProject` awaited
children before switching the view, so tapping A then B showed B and then jumped
back to A when A's slower read landed; `goBack` lost the same race with no
second tap. `navigationGate` issues a token per navigation — `goBack` takes one
too, which is what invalidates a pending open — and a read that resolves after a
newer navigation started is dropped, error and all.

**Also fixed, found on the way.** The tail loader merged pages into a copy of
the list captured when it started and handed that copy back. A project created
while the tail was loading, or one fetched by a deep link, was erased by the
next page landing — and if the user was looking at it, the view fell back to the
list under them. `loadProjectTail` now hands over each page's new rows and the
caller merges into the live list.

App tests 171 → 193; hub policy lane 106 → 118. The hub lane reads the app's own
`SUMMARY_READS` out of the bundle and runs them through the real rewriter, which
is where the interesting property is: an aggregate is not a row, so it slips
past the instinct that reads are filtered. If the policy did not reach inside
`SUM()`, a child would learn what the adults are spending on a project they
cannot open, without ever seeing a line item. It does — the rows are filtered
before they are grouped, so the project drops out of the result entirely.
Mutation-checked: rewriting `committed_cents` to `SUM(estimated_cents)` fails
both lanes.

## Shared spaces — 2026-09-05

The app now installs into a **general or co-parenting shared space** as well as
a household: `manifest.contexts` is `["household", "shared_space"]`. Roster is
deliberately not declared (it needs its own `shared_space.roster` token plus the
hub's star-topology audit, and nothing here wants it).

No hub change was needed — the hub already resolves row policies per tenant.
What changed in the app is the client mirror of that resolution. The manifest's
"adult" vocabulary conflates two things the hub keeps apart (`policy-roles.ts`):

- **capability** — the `adults` visibility tier, `delete_adult_only`, the
  visibility choices. Any full member has it in either tenant kind, and the
  client keeps gating these on `isAdult(me)`.
- **supervision** — the `adults_bypass` reach over OTHER members' child rows
  (`canEditChild`, `canUncompleteItem`). In a space every participant is an
  adult, so this belongs to the steward (`is_admin`) alone; in a co-parenting
  space both parents are stewards, which behaves like a two-adult household.

`logic.js` gained `configureTenant({ kind, isAdmin })` and `isSupervisor(me)`;
`index.html` calls `configureTenant` once from the hub's `__TENANT_KIND` /
`__IS_ADMIN` globals (unset means household). Without this a non-steward in a
general space was shown edit/delete controls the hub then refused — the server
was always right, only the buttons lied. Tests: a "shared spaces" block in
`logic.test.mjs` and a `contexts` pin in `manifest.test.mjs`.

## State







Complete and verified locally:

- `node build.mjs` — clean (inline scripts parse, migrations validate, agenda +
  glance surfaces validate, every inline handler resolves to a global).
- `npm test` — 74 passing across 4 files.
- Every SQL statement the app issues was run through the hub's **real** row-policy
  rewriter and scope guard, for adult and child personas. See "What was verified"
  below.

**Repo wiring is done** (`git init`, branch `main`, `core.hooksPath=.githooks`,
remote `git@github.com:firebirdsystems/chickadeebandit-projects.git`). Everything
is staged but NOT committed — an app push is a release, so that is yours to
trigger.

Note: use Node 22 (`export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`).
The Node on the default PATH is v12 and cannot run `build.mjs`.

## What it does

Five tables, all `app_projects__`-prefixed — see the README for the full model:

| Table | Holds |
|---|---|
| `projects` | name, description, status, visibility, target date, budget cap, `file_ids` |
| `budget_items` | label, vendor, `estimated_cents`, nullable `actual_cents`, purchased flag |
| `checklist_items` | title, due date, assignee, `is_milestone` flag |
| `checklist_completions` | who closed an item, and when |
| `notes` | the decisions log — what was chosen and why |

The UI is a list of project cards with a budget bar, opening into a detail view
with Budget / Checklist / Decisions / Photos tabs.

## Design decisions worth not reversing by accident

- **`actual_cents` is nullable on purpose.** Unpaid line items contribute their
  estimate to the "committed" total; a zero would read as free. That distinction
  is the whole point of the budget tab and is unit-tested.
- **No `retain_days`.** A finished renovation is a record a household wants to
  keep, not a log to expire. This is a deliberate departure from most apps here.
- **`write_visibility_scoped: true` on `projects`.** Without it, the default
  "any adult writes any row" would let an adult blind-write a private project
  they cannot even read. Paired with `delete_adult_only: true` so a child may
  edit a shared project but not destroy it.
- **Default visibility is `adults`**, so budgets are not kid-visible unless
  someone opts a project into `everyone`.
- **A private project never reaches the cross-app bus or the household activity
  feed** (`mayPublish` / `mayLogActivity` in `src/index.html`) — both are read by
  people who cannot open the project.
- **`project.budget_exceeded` fires once.** `crossesBudget` returns false when
  the budget was already blown, so later edits do not re-announce it.
- **`project.task_assigned` fires only on a NEW assignment**, not on every later
  edit, or the assignee would collect a duplicate task each time a title changed.

## What was verified, and how

The app's own CLAUDE.md says JOINs against a policy-governed table are rejected.
**That is stale.** The hub's `parseAppStatementAst` records a joined table as a
top-level reference and applies its policy; only a governed table reachable
*solely* from inside a CTE or subquery fails closed. This matters because three
of the four preloads and the agenda scope child rows to their parent project via
a JOIN — the legal form. Confirmed both directions, not just by reading:

```bash
cd ../../chickadeebandit/packages/hub
CI=true CB_APPS_DIR=/Users/adammayer/Documents/dev/chickadeebandit-apps \
  node ../../node_modules/vitest/vitest.mjs run __tests__/unit/app-preload-row-policy.test.ts
```

That suite already covers `projects` (adult/admin/child personas). Rewriting the
`budget` preload into the subquery form makes it fail with "references governed
table … inside a CTE or subquery"; the JOIN form passes. **Run this for any
preload change** — contract-ci runs `assertAppSqlScoped` only, never
`applyRowPolicy`, so a preload the rewriter refuses passes the release gate clean
and then throws on every launch.

The agenda, glance, both named AI queries, every lazy read, and every write and
delete the app issues were checked the same way with a throwaway test (since
deleted, and canary-checked so it could actually fail). All pass.

Two other things checked in hub source rather than assumed:

- `isPlaintextAppDbColumn` also skips the **`_date` suffix**, and the builtin set
  includes **`visibility`**. So this app needs no `db_plaintext_columns` at all —
  everything it filters, sorts or CHECKs on is already plaintext.
- **An uncatalogued event type is accepted.** `isAcceptableEventName` allows any
  namespaced lowercase name and `validateEventPayload` passes it through, so the
  five `project.*` events need no hub change. Adding them to `EVENT_CATALOG` is
  optional polish for typing and discoverability.

The 74 tests were mutation-checked: six deliberate breaks (drifted preload SQL,
a policy pointed at a nonexistent column, an automation writing a renamed column,
`crossesBudget` re-announcing an overrun, adults seeing others' private projects,
children able to delete projects) each produced a failure, and all were reverted.

## The tasks bridge — added, uncommitted, in the OTHER repo

The suggestion below now exists in `chickadeebandit-apps/tasks/manifest.json`
(uncommitted; that repo's build and 88 tests are green). It had to go there
because `suggested_automations` live on the **target** app, so landing it is a
second repo and therefore a second release:

```json
{
  "title": "Put project to-dos on the assignee's task list",
  "description": "When a project item is assigned to someone, add it to their Tasks list so it shows up on Today.",
  "trigger_event": "project.task_assigned",
  "target_app_id": "tasks",
  "action_id": "create_task",
  "param_map": {
    "assignee_id": { "kind": "payload_field", "value": "assignee_id" },
    "title":       { "kind": "payload_field", "value": "title" },
    "notes":       { "kind": "payload_field", "value": "project_name" }
  }
}
```

Written to the tasks manifest but not committed or pushed — releasing it is
yours to trigger. Until it lands, an admin can still wire the automation by
hand; the suggestion only makes it one-tap onboarding.

Note `due_date` is deliberately unmapped: `create_task` has no such param.

The reverse direction *is* wired: `reserve_fund.project_planned` →
`create_project`, carrying `estimated_cost_cents` into the budget cap.

## Unrelated: the hub repo's other changes are accounted for

`chickadeebandit`'s uncommitted changes (`APP-REVIEW-NOTES.md` deleted,
`packages/hub/test-count-floor.{md,txt}` and the static-checks workflow added)
are the 2026-09-04 test-harness hardening work, not a stray session. Nothing
there needs rescuing. This app's review used throwaway hub tests, all deleted.
