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
- **`canEditChild` gave adults a bypass the server does not have.** See the
  README: `inherit_visibility` has none. Now writer-scoped for everyone.
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
