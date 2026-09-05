# App Development Guide

This document covers the patterns all apps in this monorepo follow. Read it before generating or modifying any app.

## Runtime globals

The hub injects these globals into every app at runtime:

```js
const CONTEXT         = window.__CONTEXT_URL    ?? "";  // fetch family context (members, etc.)
const DB              = window.__DB_URL         ?? "";  // SQL database endpoint (storage:"db" apps only)
const STORE           = window.__STORE_URL      ?? "";  // key-value store
const FILES           = window.__FILES_URL      ?? "";  // file upload endpoint
const DOCS            = window.__DOCS_URL       ?? "";  // hub-native document storage (see below)
const CROSS_WRITE_URL = window.__CROSS_WRITE_URL ?? ""; // cross-app writes (hub-sdk crossWrite uses this)
const APPEND_RECORD   = window.__APPEND_RECORD_URL ?? ""; // append-only D1 records (append_only_records apps only)
const CLAIM_URL       = window.__CLAIM_URL      ?? "";  // atomic capacity claims (slot_claims apps only)
const RELEASE_URL     = window.__RELEASE_URL    ?? "";  // release caller's slot claim
const SWAP_URL        = window.__SWAP_URL       ?? "";  // claim destination slot, then release source slot
const APP_ID          = window.__APP_ID         ?? "my-app";
const ME              = window.__CURRENT_MEMBER ?? null; // { id, name, role }
const EVENTS_URL      = window.__EVENTS_URL     ?? "/api/events";
```

`ME` is null in demo mode (no logged-in user). Always guard against it.

## DB helper

Every app that uses SQL defines this helper:

```js
async function db(sql, params = []) {
  if (!DB) return { rows: [] };
  const res = await fetch(DB, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  return res.json(); // { rows: [...] }
}
```

Schema is managed by hub migrations in `migrations/001_init.sql` — do not run `CREATE TABLE` at runtime.

**Do not add a `household_id` column.** Each household gets its own isolated
Cloudflare D1 (SQLite) database, so every row in your tables already belongs to
exactly one household — there is nothing to scope by, and nothing to filter on.
Primary keys are `TEXT` (`crypto.randomUUID()` client-side). Tenant separation is
the database file; per-member separation is `row_policies`. See "Migration SQL"
under Security constraints.

## hub-sdk.js

Import shared utilities from `/hub-sdk.js`:

```js
import { memberColor, initial, esc, isAdult, hubConfirm, hubAlert, hubToday, formatRelativeDate, fmtMoney, fmtMoneyShort } from "/hub-sdk.js";
```

- `memberColor(memberId, members)` — deterministic color string for a member's avatar
- `initial(name)` — first letter of a name for avatar display
- `esc(str)` — HTML-escape a string before injecting into innerHTML
- `isAdult(member, members)` — returns true if the member has role "adult"
- `hubConfirm({ message, description?, confirmLabel?, destructive? })` — async confirm dialog; returns true/false
- `hubAlert(message, { description?, confirmLabel? })` — async single-button notification dialog. **Always use this instead of `alert()`.** A raw `alert()` fires the browser's native dialog, which inside the hub iframe renders as an "an embedded page at …app… says" popup with stripped-down chrome — confusing and off-brand. `hubAlert` posts to the parent hub frame, which renders the message in the hub's own themed dialog. Same idea for confirmations: use `hubConfirm`, never `confirm()`.
- `hubToday(now?)` — today as `"yyyy-mm-dd"` on the **household's** calendar, the same day the hub binds to `:today` in your declared SQL. Pass an instant to ask which household-day it fell on. Falls back to the device's calendar when the hub published no zone.
- `fmtMoney(cents)` — format integer cents as USD with no decimals: `fmtMoney(125000)` → `"$1,250"`. Returns `"—"` for null.
- `fmtMoneyShort(cents)` — compact format for large amounts: `$450K`, `$1.3M`. Use for summary displays.
- `createStreamHelper(streamUrl, eventType, callback)` — opens an SSE connection to `window.__STREAM_URL` and calls `callback(event)` for each event. Auto-reconnects on close. Returns `{ connect(), disconnect() }`. Pass `null` as `eventType` to receive all event types.

Always use `esc()` when rendering user-provided strings into HTML templates.

### Dates: `hubToday()`, never `toISOString().slice(0, 10)`

`new Date().toISOString().slice(0, 10)` is **UTC**. It names yesterday for the
whole evening west of Greenwich and tomorrow late at night east of it. It is the
single most common date bug in these apps.

The rule:

- **A date you STORE or COMPARE → `hubToday()`** (client) or `:today` (SQL).
  Those name the same day, so a row your UI writes and a row the glance, kiosk,
  cron, or an MCP export reads agree. A wrong stored date never heals: the row
  says one day and every server-side surface says another.
- **Rendering an INSTANT** — clock times, "3h ago" — stays on the device clock.
  That is what a reader expects to see, and it is what `formatRelativeDate` does.

Two more traps in the same family:

- `new Date("2026-08-30")` parses as UTC **midnight**, so formatting it for
  display shows Aug 29 west of Greenwich. Build the Date from parts instead:
  `new Date(y, m - 1, d)`.
- A bare `"yyyy-mm-dd"` column compared against `datetime('now')` is a *lexical*
  compare in which `"2026-08-30"` sorts BEFORE `"2026-08-30 14:22:00"` — so
  "expires on the 30th" silently drops the whole of the 30th. Compare a date to
  a date: `WHERE expires_at >= :today`.

### Updating hub-sdk.js

The **canonical source is `packages/hub-contract/src/hub-sdk.js` in the chickadeebandit hub repo** — edit it there (assumes the hub repo is checked out as a sibling of the apps repo). There is no copy of the SDK in this repo: `dev.mjs` fetches the deployed hub's `/hub-sdk.js` (caching it as the gitignored `.hub-sdk.js`, refreshed every 24 h), and production apps import the same URL directly.

Apps do **not** bundle the SDK — `build.mjs` only packages `manifest.json` + `src/`, and every `dev.mjs` fetches the SDK over the network. So don't add a per-app `hub-sdk.js`; any such copy is vestigial and used by nothing.

After editing the canonical copy, sync the hub's served copy and commit both in the hub repo:

```bash
# in the hub repo, packages/hub:
npm run sync-contract-assets   # copies hub-contract/src/hub-sdk.js → public/hub-sdk.js
```

A local CI guard in the hub repo (`packages/hub/__tests__/unit/hub-sdk-sync.test.ts`) fails if `public/hub-sdk.js` drifts from the package source, so a forgotten sync is caught automatically. A new helper becomes available to apps (dev and prod alike) once the hub deploys.

## Loading members

```js
async function loadMembers() {
  if (!CONTEXT) {
    members = [/* demo fallback */];
    return;
  }
  try {
    const res = await fetch(`${CONTEXT}?keys=family.members`);
    members = ((await res.json())["family.members"]) ?? [];
  } catch { members = []; }
}
```

## Notifications

```js
import { sendHubNotification, hubAppUrl } from "/hub-sdk.js";

await sendHubNotification({
  title: "New event",
  body: "Please RSVP",
  audience: ["member-id-1", "member-id-2"],
  url: hubAppUrl(APP_ID, { eventId }),
});
```

Prefer `sendHubNotification` from `/hub-sdk.js` over hand-written `fetch(window.__NOTIFY_URL...)`
calls. It sends through the app-scoped hub endpoint, defaults click targets to `/open/{APP_ID}`,
and normalizes old `/run/{APP_ID}` URLs so Safari and other browsers open the app in the hub shell
instead of the isolated runtime origin. It returns the hub response JSON (`{ web, expo }`) or `null`
on network failure, so apps may show delivery diagnostics when useful. Notifications are still
best-effort; don't make core data writes depend on them succeeding.

**The default `audience` is `"all"` — the whole household.** Never send the contents of a
restricted item (a private/role/board-only channel message, an adults-only note, etc.)
through the plain `notify` helper: every member's device receives the preview, even members
who can't open the item. To target specific people, pass an explicit member-id list:
`audience: ["member-id-1", "member-id-2"]`. But you usually can't compute
"who follows this channel" on the client (that data is `owner_only`) — use
`subscription_notify` below.

### `subscription_notify` — notify a topic's followers without leaking previews

For "follow this channel / thread / event and get notified of new activity", declare
`subscription_notify`. The hub exposes `POST /run/{appId}/api/notify-subscribers`, which
reads your per-member opt-in table (kept `owner_only`, so the client can't read other
members' rows), unions in any explicit `also_notify` ids (e.g. @mentions), drops the
sender, then **re-checks that each recipient may still see the topic** before pushing only
to them. The caller must also be eligible for the topic (a non-member can't trigger
notifications into a channel they're not in).

**Why you can't do this with the plain `notify` helper:** subscriptions are `owner_only`,
so a member's browser can only read *its own* follow rows — it can't resolve, let alone
fan out to, the full follower list. And `owner_only` lets any member opt into any topic id,
so the recipient list must be re-filtered server-side or a non-member who subscribed to a
private channel would receive its previews.

```jsonc
// manifest.json — the subscription table must have an owner_only row policy
{
  "row_policies": {
    "channel_subscriptions": { "kind": "owner_only", "member_column": "member_id", "adults_bypass": false }
  },
  "subscription_notify": {
    "subscription_table": "channel_subscriptions",
    "topic_column": "channel_id",
    "member_column": "member_id",
    "eligibility": {
      "kind": "channel_membership",
      "channels_table": "channels",
      "membership_type_column": "membership_type",   // must be plaintext (db_plaintext_columns)
      "membership_roles_column": "membership_roles",  // must be plaintext
      "membership_table": "channel_members",
      "membership_channel_column": "channel_id",
      "membership_member_column": "member_id"
    }
  }
}
```

```js
// Follow / unfollow is just an owner_only write of the caller's own row:
await db(`INSERT INTO app_x__channel_subscriptions (channel_id, member_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, [channelId, ME.id]);
await db(`DELETE FROM app_x__channel_subscriptions WHERE channel_id = ? AND member_id = ?`, [channelId, ME.id]);

// After a new message, fan out (fire-and-forget) through the hub:
await fetch(window.__NOTIFY_SUBSCRIBERS_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    topic_id: channelId,
    title: `#${channelName}`,
    body: `${ME.name}: ${text.slice(0, 80)}`,
    url: `/run/${APP_ID}?channelId=${channelId}`,
    also_notify: mentionedMemberIds,   // optional — unioned with followers, still eligibility-checked
  }),
}).catch(() => {});
```

`eligibility.kind: "channel_membership"` mirrors the `channel_scoped` row policy
(`all` / `role` / `custom` membership). `channels_id_column` defaults to `"id"`;
`all_value`/`role_value` default to `"all"`/`"role"`. The `membership_type`/`membership_roles`
columns must be plaintext (the same requirement `channel_scoped` imposes). `group-channels`
is the reference implementation.

## Activity log

Many apps log user actions to an `activity` table:

```js
async function logActivity(recordId, action, detail = "") {
  const id = crypto.randomUUID();
  await db(
    `INSERT INTO activity (id, record_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, recordId, ME?.id ?? "system", action, detail, new Date().toISOString()]
  );
}
```

## Optimistic local state updates

After a main DB write succeeds, update local state immediately and re-render — do **not** reload from the database. A reload adds a full round-trip before the user sees any feedback.

```js
async function createItem(fields) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  // 1. Write to DB
  await db(`INSERT INTO items (id, title, created_at) VALUES (?, ?, ?)`, [id, fields.title, now]);

  // 2. Update local state and render immediately
  items = [{ id, title: fields.title, created_at: now, status: "active" }, ...items];
  closeModal();
  render();

  // 3. Fire side effects in the background — don't block the UI
  Promise.all([
    logActivity(id, "created", `${ME.name} created "${fields.title}"`),
    notify(`New item: ${fields.title}`, `${ME.name} added a new item.`),
    fetch("/api/activity", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "item_created", actor: ME.name,
        description: `${ME.name} created "${fields.title}"`,
        metadata: { deepLink: { appId: APP_ID, params: { itemId: id } } } }),
    }).catch(() => {}),
  ]).catch(() => {});
}
```

For updates and deletes, patch the array in-place:

```js
// update
const idx = items.findIndex(i => i.id === id);
if (idx !== -1) items[idx] = { ...items[idx], title: fields.title, updated_at: now };

// delete
items = items.filter(i => i.id !== id);
```

Never re-fetch the full list from the DB just to reflect a change you already know about.

## Member lookup map

Build a `Map` once after `loadMembers()` completes. Use it everywhere instead of `.find()` — avoids an O(n) scan on every card render.

```js
let members   = [];
let memberMap = new Map();

async function loadMembers() {
  if (!CONTEXT) {
    members = [{ id: "demo-1", name: "Alex", role: "adult" }, /* … */];
    memberMap = new Map(members.map(m => [m.id, m]));
    return;
  }
  try {
    const res = await fetch(`${CONTEXT}?keys=family.members`);
    members = ((await res.json())["family.members"]) ?? [];
  } catch { members = []; }
  memberMap = new Map(members.map(m => [m.id, m]));
}

// Use map lookups everywhere — not .find()
function memberName(id) { return memberMap.get(id)?.name ?? "Unknown"; }
```

That first `keys=family.members` fetch costs no round trip: the hub embeds the
roster in the app document (`window.__CONTEXT_PRELOAD`) and answers a GET of
`__CONTEXT_URL` from it for the first 30 s — the same window the endpoint's
own browser cache already covered — provided **every** key in the request is
preloaded (currently `family.members` and `family.app_members`). A request
that mixes a preloaded key with a non-preloaded one goes to the network as
one call. Nothing to change in the app, and `fetch` keeps working exactly as
before after the window.

## Who is playing vs. who lives here

`family.members` is the whole household roster. A household can narrow an
app's audience (`visible_to`, per-member grants/restrictions, `min_age`,
`default_audience`) without the app hearing about it, so any "has everyone
done this?" computed against the roster can be unreachable forever.

Declare `"family.app_members"` in `data_access.reads` when you need the
participant set: same shape as `family.members`, filtered to the members the
hub would actually let into *your* app. Use it **only** for completeness
("everyone has answered/drawn/voted"); keep `family.members` for naming
people ("drawn by Dana", pickers, rosters) — departed-but-referenced and
restricted members still need names. Admins always appear in
`family.app_members` (the hub always lets them in, even past `visible_to`).
Fall back when the key is absent (older hub) or empty (failed fetch):

```js
const res = await fetch(`${CONTEXT}?keys=family.members,family.app_members`);
const json = await res.json();
members    = json["family.members"] ?? [];
appMembers = json["family.app_members"] ?? null;  // null = unknown, use members
// completeness: (appMembers ?? members)   naming: members
```

## Parallelizing independent async calls

`loadMembers()` and `loadItems()` are independent — run them in parallel at startup:

```js
(async () => {
  await Promise.all([loadMembers(), loadItems()]);
  render();
  handleDeepLink();
})();
```

Side effects like `logActivity`, `notify`, and `/api/activity` are also independent of each other — batch them in a fire-and-forget `Promise.all` after the UI has already updated (see optimistic local state above). Never chain them sequentially with separate `await` calls.

### One request for the first-render reads

Parallel is not free: every `/api/db` request pays the hub's fixed per-request
cost (session, membership, row-policy rewrite) before the SQL runs, so four
first-render SELECTs in a `Promise.all` pay it four times. Send them as **one
batch** — one request, one atomic D1 transaction, results in order:

```js
import { createDbHelper } from "/hub-sdk.js";
const db = createDbHelper(window.__DB_URL);

async function loadItems() {
  const [{ rows: lists }, { rows: items }, { rows: inbox }] = await db.batch([
    { sql: "SELECT * FROM lists ORDER BY sort_order" },
    { sql: "SELECT * FROM items WHERE parent_id IS NULL ORDER BY due_date" },
    { sql: "SELECT * FROM inbox ORDER BY created_at DESC" },
  ]);
  …
}
```

The raw shape, if you post yourself, is `{ statements: [{ sql, params }, …] }`
→ `{ results: [{ rows, changed }, …] }` on the same `/api/db` endpoint (max 25
statements). Each statement is validated and row-policy-rewritten exactly as
it would be on its own; if any fails, none apply.

### Zero requests for the first-render reads (`manifest.preload`)

Better still: declare the first-render reads in the manifest and the hub runs
them **while rendering the document**, embeds the rows as `window.__PRELOAD`,
and answers your matching `/api/db` request from the embedded copy. First
paint then needs no client round trip at all.

```jsonc
// manifest.json
"preload": {
  "lists": { "sql": "SELECT * FROM app_myapp__lists ORDER BY sort_order" },
  "mine":  { "sql": "SELECT * FROM app_myapp__items WHERE assignee_id = ? AND due_date <= ?",
             "params": [":me", ":today"] }
}
```

- Each value is **exactly the `{ sql, params }` your code posts** at first
  render. The hub answers a request whose statement text (whitespace
  collapsed) and params are equal to a declared entry — so keep the two copies
  identical, ideally by defining the SQL once (a `LOCAL_READS` constant) and
  adding a test that the manifest matches it. A drifted copy is not an error;
  it is a preload that silently never answers.
- `params` may use `":me"` (the viewer's member id) and `":today"` (the
  household-local date); the hub resolves them and echoes the resolved values,
  so your code posts the plain values it always did. Tokens go in `params`,
  never in the SQL text.
- Same rules as `/api/db`, enforced at publish: one SELECT/WITH, your own
  tables only, no comments or trailing `;`, no `endpoint_only` or
  `steward_reads_only` tables. Up to **6** statements; the inline payload is
  capped at 256 KB (over it, the whole preload is dropped and your fetches run
  as usual).
- **Each entry answers ONE request**, and any `/api/db` POST the preload does
  not answer (a write, a mixed batch) discards every remaining entry. A re-read
  after a write, a poll, a refresh — all go to the network exactly as before.
  Only the request the document was rendered for changes.
- A `db.batch([...])` is answered too, when **every** statement in it is
  preloaded (in order). A batch that mixes in a non-preloaded statement goes
  to the network whole, never split — so your first-render batch keeps
  working with or without the preload.
- Only member sessions are preloaded (an anonymous visitor or ambient kiosk
  identity is not), so your code must still fetch — the preload is an
  accelerator, not a data source. An app that wants to render before its
  module evaluates may read `window.__PRELOAD.lists.rows` directly and fall
  back to a fetch when the key is absent.
- **Bound every preloaded read.** These run on every launch for every
  household, and D1 bills rows read, so an unbounded `SELECT *` over a table
  that grows with time gets slower and costlier for your heaviest users. Give
  each statement a WHERE that says what the first screen actually needs — a
  recent window (`created_at >= date(?, '-120 days')` with `":today"`, never
  `date('now')`, which is UTC), the open/unarchived rows, this member's rows —
  or, failing that, a LIMIT with a deterministic tiebreak so the page doesn't
  reshuffle between loads. A table that only grows with the roster or with
  hand-entered setup (categories, templates, profiles) is honestly read whole;
  one that grows with use is not. Where the first screen needs none of a
  table's rows, leave it out of `preload` entirely and fetch it when the user
  opens the thing that needs it. Bounding a statement makes it index-eligible,
  so add the matching index in the same change.

## Modal pattern

Most apps use a single `modalEl` variable:

```js
let modalEl = null;
function openModal(html) {
  closeModal();
  modalEl = document.createElement("div");
  modalEl.className = "modal-backdrop";
  modalEl.innerHTML = `<div class="modal">${html}</div>`;
  modalEl.addEventListener("click", e => { if (e.target === modalEl) closeModal(); });
  document.body.appendChild(modalEl);
}
function closeModal() { modalEl?.remove(); modalEl = null; }
```

Use `openModal` for rich, app-styled content (forms, multi-button flows, anything with custom markup). For a one-off message or a yes/no question, **do not reach for the native `alert()`/`confirm()`** — they render as the browser's "an embedded page says" iframe popup. Use `hubAlert(message)` / `hubConfirm(message)` from `/hub-sdk.js` instead; they render in the hub's own themed dialog. Reserve a bespoke `openModal` only when the notification needs an action beyond a plain OK (e.g. the partner-pairing "Waiting for…" modal with a **Check Again** button that re-polls).

## Loading state on submit buttons

Any async submit handler must disable its button immediately so the user knows work is in progress:

```js
window.submitForm = async function(existingId) {
  // 1. validate first — bail before touching UI
  const name = document.getElementById("f-name").value.trim();
  if (!name) { document.getElementById("f-name").focus(); return; }

  // 2. disable the button
  const btn = modalEl?.querySelector('.modal-actions .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // 3. do async work — on success, closeModal() removes the button from DOM
  try {
    await saveRecord({ name });
    closeModal();
    render();
  } catch (e) {
    // restore so user can retry
    if (btn) { btn.disabled = false; btn.textContent = existingId ? 'Save' : 'Create'; }
    throw e;
  }
};
```

For buttons outside a modal (e.g. an inline Add button), find them directly:

```js
const btn = document.querySelector('.add-btn');
if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
await addItem(val);
if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
```

## Hub CSS variables

Apps inherit these CSS custom properties from the hub theme at runtime:

```css
--hub-bg           /* page background */
--hub-surface      /* card/panel background */
--hub-border       /* default border color */
--hub-text         /* primary text */
--hub-text-muted   /* secondary/muted text */
--hub-primary      /* accent color (buttons, links) */
--hub-primary-fg   /* foreground on accent color */
--hub-primary-hover
--hub-radius       /* border-radius for cards/buttons */
--hub-font-size    /* base font size */
--hub-font         /* font-family */
```

Always define fallback values: `var(--hub-bg, #f9fafb)`.

## Deep linking

The hub can open an app at a specific item by appending query params to the iframe URL. Apps that support deep linking should read those params on startup and navigate to the referenced item.

### Handling incoming deep-link params

Read `window.location.search` during init and navigate to the referenced item if params are present:

```js
function handleDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const pollId = params.get("pollId");
  if (pollId) openPoll(pollId);
}

(async () => {
  await Promise.all([loadMembers(), loadItems()]);
  handleDeepLink(); // after data is loaded so the item exists
  render();
})();
```

Pick param names that are specific to your app (e.g. `pollId`, `taskId`, `recipeId`). The hub passes whatever params were in the link — there is no shared namespace.

### Navigating to another app with params

Use the `hub:open` postMessage to send the user to a specific item in another app:

```js
window.parent.postMessage({
  type: "hub:open",
  appId: "grocery",
  params: { listId: "abc123" },
}, "*");
```

The hub navigates to `/open/grocery?listId=abc123`, which passes `?listId=abc123` into the grocery app's iframe.

### Logging activity with a deep link

When you log hub-level activity (via `/api/activity` or a hub SDK helper), include a `deepLink` in the metadata so the activity item and notification bell become clickable links:

```js
await fetch("/api/activity", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "poll_created",
    description: `${ME.name} created a new poll: "${title}"`,
    metadata: {
      deepLink: {
        appId: APP_ID,
        params: { pollId: id },
      },
    },
  }),
}).catch(() => {});
```

The hub renders that activity entry as a link to `/open/{appId}?pollId={id}`. Without `deepLink`, the entry is plain text.

## Events API

Publish cross-app events other apps can consume:

```js
await fetch(EVENTS_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    source_app_id: APP_ID,
    type: "event.type",       // e.g. "allowance.weekly"
    subject_id: memberId,
    payload: { /* ... */ },
  }),
}).catch(() => {});
```

If your manifest declares `publishes` and/or `alert_on`, you **must** call the events endpoint in app code after the relevant action — declaring these fields alone does nothing. Always call it as a fire-and-forget side effect after the UI has already updated.

### `publish_acls` — gating who may emit an event

Any household member can POST to your app's events endpoint. If an event carries value another app acts on (e.g. `reward.earned` → piggy-bank credits allowance), gate it so only adults can emit it:

```json
{
  "publishes": ["reward.earned", "item.closed"],
  "publish_acls": {
    "reward.earned": { "require_role": "adult" },
    "item.closed":   { "require_role": "adult" }
  }
}
```

The hub enforces `require_role` server-side when the events endpoint is called — a child POSTing the event directly gets a 403. Declare `publish_acls` for any event whose payload another app treats as authoritative.

## File uploads

Use `createFilesHelper` from `/hub-sdk.js` for all file operations. It handles correct URL construction, upload error detection, and deletion — do not roll your own `fetch` calls against `FILES`.

```js
import { createFilesHelper } from "/hub-sdk.js";
const files = createFilesHelper(window.__FILES_URL ?? "");
```

**Upload** — resolves with `{ id, url }` or throws on any server error (wrong MIME type → 415, too large → 413, storage limit → 507). Never insert a DB record until `upload()` resolves successfully.

```js
async function uploadFile(file) {
  const { id: fileId, url: fileUrl } = await files.upload(file);
  // now safe to insert into your DB
}
```

**Delete** — takes the file ID (not a URL):

```js
await files.delete(fileId).catch(() => {});
```

**List** — returns `{ files, totalBytes, limit }`:

```js
const { files: fileList, totalBytes, limit } = await files.list();
```

**Get a file URL** — for linking or displaying:

```js
const url = files.url(fileId);  // e.g. /run/{app-id}/api/files/{id}
```

**Show the upload area only when files are available** (guard against demo mode):

```js
const uploadHtml = window.__FILES_URL ? `<div class="upload-area">…</div>` : "";
```

Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx), `text/plain`, `text/markdown`.

## Hub-native document storage

For documents that should persist in the hub (survive app reinstall, appear in the household document library, respect encryption at rest), use `window.__DOCS_URL` instead of — or alongside — your own app DB.

```js
const DOCS = window.__DOCS_URL ?? "";
```

**Create** — POST a document record. `fileKey` is the ID returned by `files.upload()`.

```js
const { id } = await fetch(DOCS, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title:    file.name,           // required
    category: "home",              // required: medical | legal | home | financial | other
    fileKey:  uploadResult.id,     // from files.upload()
    mimeType: file.type,
    sizeBytes: file.size,
    sourceId: itemId,              // optional: link to your own entity (e.g. a maintenance item)
    folder:   "Warranties",        // optional: freeform grouping label
    sharedWith: ["everyone"],      // optional: [] = owner-only, ["everyone"] = whole household
  }),
}).then(r => r.json());
```

**List** — GET with optional filters:

```js
const docs = await fetch(`${DOCS}?sourceId=${itemId}`).then(r => r.json());
// also: ?folder=Warranties
```

**Delete** — DELETE by document ID (also delete the associated file):

```js
await fetch(`${DOCS}/${docId}`, { method: "DELETE" });
await files.delete(doc.fileKey).catch(() => {});
```

Hub documents are automatically deleted when the app is uninstalled. Storage usage counts against the app's `max_docs_bytes` limit (default 100 MB). Guard against demo mode:

```js
const uploadHtml = window.__DOCS_URL ? `<div class="upload-area">…</div>` : "";
```

## Cross-app data sharing

Apps can read and write each other's KV store data. Both sides must declare intent in their manifests; the hub enforces both at runtime.

### Exposing data to other apps

Declare the KV keys you want to make readable (or writable) by other apps:

```json
{
  "exports": ["recipes", "pending_items"]
}
```

Export key names must be lowercase alphanumeric, hyphens, or underscores.

### Reading another app's exported key

Declare the key in `data_access.reads` using the pattern `app.{appId}.{key}`:

```json
{
  "data_access": {
    "reads": ["family.members", "app.recipes.recipes"],
    "writes": []
  }
}
```

Then fetch it the same way as any context key:

```js
const res = await fetch(`${CONTEXT}?keys=app.recipes.recipes`);
const data = await res.json();
const recipes = data["app.recipes.recipes"] ?? [];
```

The hub returns the parsed JSON value of the source app's KV entry for that key. Returns `null` if the key hasn't been written yet.

### Writing to another app's exported key

Declare the key in `data_access.writes`:

```json
{
  "data_access": {
    "reads": [],
    "writes": ["app.grocery.pending_items"]
  }
}
```

Then use `crossWrite` from `/hub-sdk.js`:

```js
import { crossWrite } from "/hub-sdk.js";

await crossWrite("grocery", "pending_items", [
  { op: "array_append", path: "items", value: { name: "Flour", addedBy: "Meal Planner" } },
  { op: "array_append", path: "items", value: { name: "Eggs",  addedBy: "Meal Planner" } },
]);
```

`crossWrite` uses the same patch ops as the KV store PATCH endpoint: `array_append`, `array_remove`, `set`, `increment`, `delete`. The `path` is a dotted path within the JSON blob stored at the key.

Writes count against the **calling** app's daily write quota, not the target app's.

### The inbox pattern (for `storage: db` apps)

DB-storage apps can't receive writes directly into their SQL schema. Instead, expose a KV key as an inbox, then drain it on load:

```js
async function processPendingInbox() {
  if (!STORE) return;
  try {
    const res = await fetch(`${STORE}?key=pending_items`);
    if (!res.ok) return;
    const { value } = await res.json();
    if (!value) return;
    const pending = JSON.parse(value).items ?? [];
    if (!pending.length) return;

    for (const item of pending) {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      await db(`INSERT INTO items (...) VALUES (...)`, [...])
        .catch(() => {}); // silently ignore duplicates
    }

    await fetch(`${STORE}?key=pending_items`, { method: "DELETE" });
  } catch { /* non-fatal */ }
}
```

Call it during init before loading your main data:

```js
(async () => {
  await loadMembers();
  await processPendingInbox(); // drain inbox first
  await loadItems();
  render();
})();
```

The inbox key must be listed in `exports`. Keep inbox processing non-fatal — always wrap in try/catch and never let it block the app from loading.

### Permission escalation

When an app update **adds** new cross-app reads, writes, or exports, the hub automatically queues the update for admin approval even if `requires_approval` is `false` in the manifest. The admin will see a callout in the update review screen explaining what new access was added.

## Resource limits

The hub injects current limits into `window.__RESOURCE_LIMITS`:

```js
const LIMITS = window.__RESOURCE_LIMITS ?? {};
// LIMITS.max_file_bytes      — max bytes per individual upload (default 10 MB)
// LIMITS.max_files_bytes     — max total file storage for this app (default 500 MB)
// LIMITS.max_db_bytes        — max DB storage for this app (default 200 MB)
// LIMITS.max_store_bytes     — max KV storage for this app
// LIMITS.max_store_reads_per_day
// LIMITS.max_store_writes_per_day
```

Apps do not need to enforce these limits themselves — the hub enforces them and returns 507 when exceeded. But apps may read them to display a storage bar or warn the user before an upload.

## Nav label

Every app must include a `nav` field in `manifest.json` so it appears in the hub's left navigation by default:

```json
"nav": { "label": "My App" }
```

Use a short label (1–2 words). Never omit this field — apps without it are invisible in the nav until an admin manually enables them.

## Base href

Every app sets `<base href="/run/{app-id}/">` in `<head>` so relative asset paths resolve correctly inside the hub iframe.

## Extracting testable logic

Apps with non-trivial pure logic should extract it into `src/logic.js` so it can be unit-tested without a browser environment.

**Pattern:**

1. `src/shared.js` — mirrors any `hub-sdk.js` functions used by logic (e.g. `isAdult`, `esc`). Tests import from here instead of the browser-only SDK.

2. `src/logic.js` — exports pure functions. Import from `shared.js`, not `/hub-sdk.js`:

```js
import { isAdult } from "./shared.js";
export { isAdult };

export function canSeeItem(item, me) {
  if (isAdult(me)) return true;
  return item.visibility === "public";
}
```

3. `src/index.html` — imports from both `/hub-sdk.js` (browser globals) and `./logic.js` (pure functions). Use aliased imports to avoid shadowing if you wrap them with local state:

```js
import { esc, isAdult, hubConfirm } from "/hub-sdk.js";
import { canSeeItem as _canSeeItem } from "./logic.js";

// thin wrapper that binds to app state
function canSeeItem(item) { return _canSeeItem(item, ME); }
```

4. `__tests__/logic.test.mjs` — imports from `../src/logic.js`. No DOM, no mocks needed for pure functions.

**When to extract logic:**
- Access control checks (who can see/edit/vote)
- Derived status or computed values from raw data
- Non-trivial filtering or sorting
- Date/money formatting with edge cases

**When not to:** DB calls, render functions, event handlers, and anything that closes over module-level state belong in the HTML script and don't need extraction.

## Adding search to an app

Search in Chickadee is a **per-app convention**, not a protocol or a hub call.
An app filters the rows it already loaded, in the browser, using the one shared
matcher — so search never adds a query, an endpoint, or a security surface (the
rows were already scoped by row policies when the app fetched them). The hub's
own `/search` covers calendar, tasks, inbox, and the app catalog; anything
*inside* an app is found from within that app, which is what this convention is.

Use the shared matcher, `searchMatch(query, fields)`, from `/hub-sdk.js`. It
lower-cases, strips diacritics, and requires every whitespace-separated token to
substring-match at least one field (AND across tokens, OR across fields). It is
deliberately dumb — substring, not fuzzy — because family data is small and
predictability beats cleverness. There is nothing to tune; the only per-app
decision is *which fields are searchable*.

**1. Declare the searchable fields (pure, testable) in `src/logic.js`:**

```js
// Everything a user might type to find this item. Include body text and tags,
// not just the title — that's the whole point of app search.
export function searchableFields(item) {
  return [item.title, item.note, ...(item.tags ?? [])];
}
```

Fields may be `null`/`undefined` (the matcher ignores them). If a field needs
data the row doesn't carry (e.g. a category *name* resolved from an id map),
pass it in as an argument so `searchableFields` stays pure:
`searchableFields(recipe, categoryNames)`.

**2. Add the search row above your list** (canonical `.search-row` /
`.search-input` markup is in `src/index.html`) and filter with the matcher:

```js
import { searchMatch } from "/hub-sdk.js";
import { searchableFields } from "./logic.js";

const list = searchQ ? items.filter(i => searchMatch(searchQ, searchableFields(i))) : items;
```

Re-render **only the list** on each keystroke (not the whole view) so the input
keeps focus. Show a "No items match …" state when the filter empties the list.

**3. Test `searchableFields` in `__tests__/logic.test.mjs`** — assert it matches
beyond the title (a body/tag/category hit), which is the behavior worth locking
in. The matcher itself is already unit-tested in the hub; don't re-test it.

```js
it("is findable by body text, not just title", () => {
  expect(searchableFields({ title: "Wifi", note: "hunter2" })).toContain("hunter2");
});
```

## Behavioral scenarios (`scenarios.json`)

`logic.test.mjs` unit-tests pure front-end functions; it does **not** exercise
the hub runtime, so it cannot prove your `row_policies`, `publishes`, or named
queries actually behave as intended end-to-end. The hub's Layer 2b
**app-exercise** suite already runs a universal pass over every app (installs
it, drives each declared capability against the real runtime, and asserts the
generic per-policy-kind security invariants) — you get that for free with no
per-app files.

For behavior the universal pass can't infer — private-visibility isolation,
couple/party scoping, event→query flows, protocol lifecycles — add an optional
`scenarios.json` **next to `manifest.json`**. Each scenario declares members by
role and a list of steps replayed against the real runtime; expectations are
checked against the result. `build.mjs` ships it in the bundle, and the hub's
nightly fan-in replays it against your published bundle. `contract-ci` lints the
file's shape and references (declared events / named SQL / member aliases) in
your app's own CI — no hub install needed — so a broken spec fails fast.

```jsonc
{
  "scenarios": [
    {
      "name": "private items are hidden from non-owners; shared items are visible",
      "members": { "owner": "adult", "other": "adult" },
      "steps": [
        // seedRaw bypasses row policies — for setting up endpoint_only /
        // protocol-managed tables (e.g. partner_config) the app can't write.
        { "action": "seedRaw", "sql": "INSERT INTO app_x__partner_config (member_id, partner_id) VALUES (?, ?)", "params": ["{{owner}}", "{{other}}"] },
        // db/named/publish/store/context steps run AS a member, THROUGH policies.
        { "action": "db", "as": "owner", "sql": "INSERT INTO app_x__items (id, member_id, visibility) VALUES (?, ?, ?)", "params": ["i1", "{{owner}}", "private"], "expect": { "status": 200 } },
        { "action": "db", "as": "other", "sql": "SELECT id FROM app_x__items", "expect": { "status": 200, "rowCount": 0 } }
      ]
    }
  ]
}
```

Step actions: `seedRaw` (policy-bypassing setup), `db`, `named`
(`{kind, name}` ai_access SQL), `publish` (`{type, subject_id?, payload?}`),
`store` (`{method, key?, value?}`), `context` (`{keys}`). `as` names a member
from `members` (defaults to the first); `{{alias}}` interpolates that member's
id into `params`/`value`. `expect` supports `status`, `rowCount`, `rowsContain`
(subset match), and `errorIncludes`. The schema is `ScenariosFileSchema` in the
hub's `@chickadee/hub-contract`. Reference examples: `tasks/scenarios.json`
(private-visibility) and `couples-bucket-list/scenarios.json` (couple scoping).

## Demo mode

When `DB` and `CONTEXT` are empty strings (local development or demo), the app should work with hardcoded demo data. Never crash or show an error when these are missing — show sample data instead.

## Security constraints

### Migration SQL

Each household gets its own isolated SQLite (Cloudflare D1) database. Migrations live in
`migrations/001_init.sql` (add `002_*.sql`, etc. for later versions) and are applied in
ascending order, skipping versions already applied. Migrations must be additive only
(`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` —
bare `ADD COLUMN` without `IF NOT EXISTS` is correct; the migration runner's version
tracking ensures each migration runs exactly once, so SQL-level idempotency guards are
not needed and SQLite does not support `ADD COLUMN IF NOT EXISTS` anyway).

**Table naming**: every table name — in migrations *and* in app SQL — must be prefixed
with `app_{appId}__` (e.g. app id `streaks` -> `app_streaks__streaks`,
`app_streaks__streak_logs`). The hub's DDL guard rejects any `CREATE TABLE`/`CREATE INDEX`
whose name doesn't start with your app's prefix. IDs are `TEXT` (use
`crypto.randomUUID()` client-side) — there is no `household_id` column; each household's
data already lives in its own database file.

The hub validates and rejects any migration that contains:

- `DROP TABLE` / `DROP COLUMN` / `RENAME COLUMN` / `RENAME TABLE` / `TRUNCATE`
- `CREATE TRIGGER` / `CREATE VIEW` (including the `TEMP` / `TEMPORARY` forms) — trigger and view
  bodies run SQL that the hub cannot scope, so they could read or write other apps' tables and
  bypass per-app table isolation. Do the equivalent work in your app/server code instead.
- `PRAGMA`, `ATTACH DATABASE`, `VACUUM`
- `CREATE TABLE` without `IF NOT EXISTS`
- Any `CREATE`/`DROP`/`ALTER TABLE|INDEX|VIEW|TRIGGER` whose target table name doesn't start with your app's `app_{appId}__` prefix

**Put comments ABOVE the statement they describe — never after the last one.**
The runner splits each migration file on top-level `;` and applies the pieces one
at a time, so whatever trails the final semicolon becomes a statement of its own.
A closing footnote is therefore a comment-only "statement", and D1 answers a
statement with nothing executable in it with `The supplied SQL string contains no
statements`. That used to abort the whole install — and because a migration's
version is recorded only after *every* statement in the file succeeds, the retry
failed identically forever and the app could never be installed. The runner now
skips such a fragment, but it still counts against the per-bundle statement
budget, and relying on that leniency means relying on which hub version you land
on. A statement may *begin* with comments (every example here does); a file must
not *end* with them.

```sql
-- Good: the note explains the index it sits above.
CREATE INDEX IF NOT EXISTS app_myapp__items_created_idx
  ON app_myapp__items (created_at);
```

```sql
CREATE INDEX IF NOT EXISTS app_myapp__items_created_idx
  ON app_myapp__items (created_at);

-- Bad: everything after the last `;` is parsed as its own statement.
-- Move this above the CREATE INDEX.
```

Row-level access restrictions are **not** expressed in SQL (no `CREATE POLICY`/RLS) —
declare them as `row_policies` in `manifest.json` instead; see "Row-level access control"
below. Anything not declared there is fully readable/writable by any household member
whose session calls `/api/db` — DDL and table layout decide *what* exists, `row_policies`
decides *who* can touch which rows.

### App JavaScript

- Always use `esc()` from `/hub-sdk.js` when injecting any user-provided string into `innerHTML`. Never use raw string interpolation with user data in HTML templates.
- Never construct SQL strings from user input — always use parameterized queries via the `db()` helper with the `params` array.
- The `DB` endpoint only runs queries against your app's own schema. You cannot query other apps' tables or hub tables — this is enforced at the database level.
- Do not attempt to read or write `window.__CONTEXT_URL`, `window.__DB_URL`, or other hub globals from another origin — the iframe sandbox blocks it.

### CDN whitelist

`cdn_whitelist` entries in the manifest must be `https://` origins only (e.g. `"https://cdn.jsdelivr.net"`). No paths, no wildcards, no `http://`. The hub rejects manifests with invalid entries and strips any that bypass validation at CSP-build time.

## Row-level access control (storage: db apps)

By default, `/api/db` runs whatever SQL the app sends against the household's
shared D1 database — **any household member can read or write any row in any
table**, regardless of what the app's UI shows. Client-side checks like
`if (isAdult(ME)) { ... }` are cosmetic only: a child can open devtools and
`fetch` your `DB` endpoint directly with arbitrary SQL.

If your app has data that should be restricted by member, role, or
visibility (private notes, financial accounts, votes, board-only records,
etc.), declare a `row_policies` block in `manifest.json`. The hub rewrites
incoming SQL to add the right `WHERE`/`EXISTS` conditions and forces the
right columns on `INSERT`, **before** your SQL ever reaches the database —
app code cannot bypass it, and a malicious client sending raw SQL gets the
same restrictions.

```json
{
  "storage": "db",
  "row_policies": {
    "<unprefixed_table_name>": { "kind": "...", ... }
  }
}
```

- Keys are **unprefixed** table names (`"streaks"`, not `"app_streaks__streaks"`)
  — the hub adds the `app_{appId}__` prefix automatically.
- Tables with no entry are completely unaffected — opt-in, fully backward compatible.
- Unsupported SQL shapes that reference a governed table (JOINs, aliases,
  subqueries in `FROM`) are **rejected outright** (fail closed) rather than
  silently under-enforced — keep queries against governed tables to simple
  single-table `SELECT`/`INSERT`/`UPDATE`/`DELETE`.
- On a policy violation, `/api/db` returns `403` with `{ "error": "..." }`.
- `max_per_member` is an INSERT-only modifier available on any policy kind.
  It enforces at most `limit` rows per member per declared scope inside
  `executeAppSql` (`limit: 1` is the classic "one row per member").
- `max_rows` is an INSERT-only modifier available on any policy kind: a
  table-wide cap on the total number of rows. It also covers rows written by
  external share-link submissions into that table.
- `frozen_when` is a write-freeze modifier available on any policy kind:
  `{ "status_column": "status", "locked_values": ["adopted", "closed"] }`.
  Use it when a row should become immutable after a lifecycle state, such as
  board minutes after adoption, closed trivia rounds, or archived sheets. For
  normal tables, `status_column` lives on that table. For `inherit_visibility`,
  `sealed_until`, and `owner_only_with_fk_check` child tables, it lives on the
  parent/FK table, so child comments, votes, responses, amendments, and records
  cannot be changed after the parent locks. Any other kind can name the parent
  explicitly with `"parent_table"` + `"fk_column"` (declared together). The
  status column must be plaintext: `status` is built in; list custom enum
  columns in `db_plaintext_columns`. For a stamp column such as `archived_at`,
  set `"locked_when_not_null": true` instead of (or as well as) `locked_values`
  — "frozen once set" — rather than storing a sentinel literal in a timestamp
  column. A parent-frozen INSERT is re-checked inside the D1 transaction and
  fails with the same 403 policy error as the pre-check if the parent locked
  mid-flight. A *missing* parent is not frozen — `frozen_when` reads state, it
  does not check existence; use `owner_only_with_fk_check` when the reference
  itself must exist.
- `column_read_acls` is a per-column **read-masking** modifier available on any
  policy kind with an owner column. Each listed column's value is returned as
  `null` unless the caller matches its `visible_to`
  (`"owner"` / `"adult"` / `"privileged"`). Use it when the whole row is
  readable but one column is not — a word-game secret word visible only to the
  setter, a valuation column visible only to adults.
- `column_write_acls` is the write-side counterpart of `column_read_acls`:
  it restricts who may write individual columns on `INSERT`/`UPDATE`.
- `retain_days` is a hub-managed **automatic expiry** modifier: the daily
  maintenance runner deletes rows older than `default` days by `timestamp_column`.
  App SQL never gets this power.
- `steward_writes_only` is a write-lock modifier available on any policy kind:
  `{ "kind": "adult_writable", "steward_writes_only": true }`. When the app is
  installed in a **`roster`** shared space (see “Shared spaces & the roster
  context” below), it restricts all app-originated `INSERT`/`UPDATE`/`DELETE` on
  the table to the space **steward** (the teacher/organizer); everyone else is
  read-only. It is **inert in households and non-roster spaces**, so a dual-context
  app keeps its normal write rules there. Use it for "only the teacher creates X"
  tables — calendar events, sign-up sheets, announcements.

### Policy kinds

#### `endpoint_only` — table written exclusively by a trusted hub endpoint

```json
{ "kind": "endpoint_only" }
{ "kind": "endpoint_only", "read": "adult" }
{ "kind": "endpoint_only", "read": "none" }
```

Rejects **all** app-originated INSERT/UPDATE/DELETE with 403. Use when a table is written only by a trusted manifest-driven hub endpoint (e.g. `anonymous_responses`, `anonymous_ballot`). Trusted hub operations bypass row policies entirely and can still write.

- `read` defaults to `"everyone"` — all members may SELECT
- `read: "adult"` — only adults may SELECT (children get 403)
- `read: "none"` — all reads also blocked; results released only through a trusted endpoint (e.g. secret-ballot tallies, anonymous survey responses before session closure)

Example: `responses` and `ballot` tables written by `anonymous_responses` / `anonymous_ballot` hub endpoints, where `read:"none"` keeps raw answers hidden until the session closes.

#### `adult_writable` — everyone reads, only adults write

```json
{ "kind": "adult_writable" }
```

All members may SELECT. INSERT/UPDATE/DELETE require `memberRole === "adult"` — non-adults get 403. This is the right choice for shared content that adults manage (chore definitions, survey questions, poll configuration, announcements) when you don't need per-row ownership.

Add `"member_read_column": "member_id"` to restrict non-adult reads to only their own rows while adults still see all:

```json
{ "kind": "adult_writable", "member_read_column": "member_id" }
```

Example: `chores` definitions (kids read, only adults create/edit); `piggy_banks` and `transactions` with `member_read_column` (kid reads only their own bank, parents read all).

#### `app_config` — a key/value settings table whose values only an admin may write

```json
{ "kind": "app_config" }
```

Read-all, **write-none via `/api/db`**. The only writer is `POST /run/{app}/api/admin-config`, which requires `isAdmin`. Use this for the settings row that names a privileged group (e.g. `board_group_id`) — if that row used `adult_only` instead, any adult could overwrite the group pointer and grant themselves board access. Pair with manifest `admin_config: { settings_table, keys: ["board_group_id"] }`. Used by `dues-contributions` and `reserve-fund`.

#### `owner_only` — a row belongs to exactly one member

```json
{ "kind": "owner_only", "member_column": "member_id", "adults_bypass": true }
```

- Non-adults: every query is restricted to rows where `member_column = <caller's member id>`; `INSERT` forces `member_column` to the caller.
- Adults: unrestricted by default. Set `"adults_bypass": false` to restrict adults too (e.g. each adult only sees their own rows).
- Add `"privileged_groups": [{ "settings_table": "settings", "settings_key": "board_group_id" }]` to give members of a configurable hub group (e.g. "board", "admins") unrestricted access regardless of `adults_bypass`. Add `"actions": ["insert"]` (any subset of `select`/`insert`/`update`/`delete`) to an entry to scope its privilege to those statement kinds, and list multiple entries for per-role power (treasurer inserts, secretary edits). See [`privileged_groups`](#privileged_groups) below.
- Add `"insert_privileged_only": true` (requires a `privileged_groups` entry covering `"insert"`) to block `INSERT` for everyone except the privileged group — returns 403 for all other callers regardless of adult status. SELECT/UPDATE/DELETE are unaffected. `"delete_privileged_only": true` (requires `"delete"` coverage) does the same for DELETE.
- Add `"endpoint_writes_only": true` to block all app-originated INSERT/UPDATE/DELETE while keeping owner-based read filtering in place. Use this when a table's data must only be written by a trusted hub endpoint (e.g. vote receipts created by `anonymous_responses`), but reads should still be filtered by ownership and `adults_bypass`:

```json
{
  "kind": "owner_only",
  "member_column": "member_id",
  "adults_bypass": false,
  "member_can_update": false,
  "endpoint_writes_only": true
}
```

Example: piggy-bank `piggy_banks`/`transactions` — a child only sees their own bank/transactions; adults (parents) see everyone's. Vote receipts for attributed polls — each member can see their own receipt (confirming they voted), but all receipt creation goes through the `submit-response` hub endpoint.

#### `max_per_member` — at most N rows per member per scope

Use `max_per_member` when the row is **not secret** but each member should only
be able to create a bounded number of rows within a logical scope: one RSVP per
event (`limit: 1`), one rating per watchlist title, one guess per trivia round,
up to three votes per poll, and so on.

```json
{
  "kind": "owner_only",
  "member_column": "member_id",
  "adults_bypass": false,
  "max_per_member": {
    "member_column": "member_id",
    "scope_columns": ["event_id"],
    "limit": 1
  }
}
```

- `limit` is a positive integer — the maximum rows one member may hold within
  the scope. `limit: 1` reproduces the classic "exactly one row per member".
- Applies only to `INSERT`; it does not make existing rows immutable.
- The `member_column` and every `scope_columns` entry must be explicitly present
  in the INSERT column list. The policy first applies the base row policy, so
  owner policies still force the member column to the caller before the count
  check runs.
- The hub counts the member's existing matching rows plus the rows in the same
  multi-row INSERT; if the total would exceed `limit`, `/api/db` returns `403`.
- A scope entry may be a plain column name **or** a derived key
  `{ "column": "date", "transform": "month" }`, which buckets an ISO date/datetime
  column by its `"YYYY-MM"` prefix — e.g. "at most N reservations per amenity per
  calendar month". Derived scopes are compared in JS after decryption, so they
  work on encrypted columns and cannot be dodged with a separate stored column.
- This is for **attributed/non-secret** participation. If the answer or ballot
  must not be linkable to the member, use `anonymous_responses` or
  `anonymous_ballot` with a receipt table instead.
- If the row also has a capacity constraint ("claim iff seats/shifts/slots remain"),
  use `slot_claims` instead. A row policy can bound per-member counts, but it cannot
  atomically check `COUNT(existing claims) < capacity` while inserting.

#### `max_rows` — a table-wide row cap

Add `"max_rows": 200` to any policy to cap the total number of rows the table may
hold. On `INSERT`, the hub counts the current rows plus the rows being inserted;
if the total would exceed the cap it rejects the write with a `DB_LIMIT_EXCEEDED`
error (HTTP `507`). The cap also applies to rows written by external
share-link submissions into that table, so it is the declarative replacement for
ad-hoc "max external submissions" guards. It is a coarse abuse ceiling, not a
per-member limit — combine it with `max_per_member` when you need both.

#### `frozen_when` — immutable after adopted / closed / archived

Use `frozen_when` when a table remains writable during drafting or play, but
must stop accepting app-originated writes after a lifecycle state:

```json
{
  "kind": "owner_or_visibility",
  "member_column": "created_by",
  "visibility_column": "visibility",
  "everyone_values": ["household"],
  "write_visibility_scoped": true,
  "frozen_when": {
    "status_column": "status",
    "locked_values": ["adopted", "closed"]
  }
}
```

- Applies to `UPDATE` and `DELETE` of the row once its current status is locked.
  Transitioning into a locked status is allowed; later writes are blocked.
- On `inherit_visibility` and `owner_only_with_fk_check` child tables, the hub
  checks the parent/FK row's `status_column` instead. This is how comments,
  votes, append-like children, or amendments become immutable after the parent
  board minute, round, sheet, or case closes.
- On `sealed_until` child tables, `frozen_when` also checks the parent row. This
  is the common async-game shape: responses stay private until the round closes,
  then the closed round also freezes further edits.
- The `status_column` must be plaintext. `status` is already plaintext; custom
  lifecycle columns such as `round_state` or `workflow_state` must be listed in
  `db_plaintext_columns` before they can be used by `frozen_when`.
- Do not use `INSERT ... ON CONFLICT DO UPDATE` against a frozen table; the hub
  rejects upsert updates because they could otherwise mutate an already-locked
  row through the conflict tail.

#### `column_read_acls` — mask specific columns while the row stays readable

Use `column_read_acls` when everyone may read the **row** but only some callers
may read a particular **column** — the answer column in a word game, a valuation
or salary column, alumni opt-in contact fields. It is a read-only mask layered on
top of the base policy's row filter.

```json
{
  "kind": "owner_or_visibility",
  "member_column": "member_id",
  "visibility_column": "visibility",
  "everyone_values": ["everyone"],
  "column_read_acls": {
    "secret_word": { "visible_to": ["owner"] }
  }
}
```

- `visible_to` is a non-empty subset of `"owner"`, `"adult"`, `"privileged"`:
  - `"owner"` — the row's owner column equals the caller. The owner column is the
    same one the kind already uses (`member_column`, `self_column`,
    `writer_column`, or `member_read_column` by kind), so `endpoint_only`,
    `adult_only`, and `app_config` cannot use `"owner"`.
  - `"adult"` — `memberRole === "adult"`.
  - `"privileged"` — a member of a `privileged_groups` entry covering `"select"`
    (for `inherit_visibility`, the **parent** table's groups). Masking is a read
    concept, so select privilege is what counts. Requires such a group to be set.
- **Adults get no implicit bypass.** `visible_to: ["owner"]` hides the column from
  adults too — only the row owner (and trusted hub endpoints) see it. List
  `["owner", "adult"]` if adults should also see it.
- The masked value is returned as `null` to non-authorized callers, applied to the
  result rows after decryption. The column may stay encrypted at rest.
- **For a non-authorized caller, a masked column may appear only as a plain
  selected column** (`SELECT secret_word …` or `SELECT *`). Referencing it in
  `WHERE`, `ORDER BY`, `GROUP BY`, `HAVING`, a function/expression
  (`length(secret_word)`), a `JOIN`, a `UNION`, or the right-hand side of an
  `UPDATE ... SET` is rejected with 403 — those would leak the value through a
  comparison or ordering oracle. **Assigning** the column (`INSERT`,
  `UPDATE ... SET secret_word = ?`) is allowed, so the owner can still write it.
- You cannot mask a policy-structural column (the owner column, `visibility_column`,
  a `max_per_member` scope column, `frozen_when.status_column`, etc.) — manifest
  validation rejects it, because the hub itself compares those columns.
- This masks **reads**; it does not make the column immutable. For **write** control
  of a column, use `column_write_acls` (below).

#### `column_write_acls` — per-column write governance (cross-kind modifier)

The write-side counterpart of `column_read_acls`, valid on **every** policy kind.
Restricts who may write individual columns on `INSERT`/`UPDATE`:

```json
"column_write_acls": {
  "status":    { "writable_by": ["adult"] },
  "locked_at": { "writable_by": [], "actions": ["update"] },
  "signed":    { "writable_by": ["owner"], "owner_column": "supervisor_id" }
}
```

- Each key is a column. `writable_by` lists the principals allowed to write it:
  - `"adult"` — `memberRole === "adult"` (capability).
  - `"privileged"` — a `privileged_groups` entry covering the governed write
    action(s) (`insert`/`update`); manifest validation requires such a group.
  - `"owner"` — the row owner. **Fail-closed**: on `INSERT` the row's owner value
    must equal the caller; on `UPDATE` the hub appends `AND <owner_column> = <caller>`
    so the write only lands on the caller's own rows. Defaults to the policy's owner
    column; set `owner_column` to point at a different column (e.g. one participant's
    slot), which is how each party writes only its own agreement flag.
- **Empty `writable_by: []` forbids the write** — the column is immutable for that
  action (or endpoint-only, since trusted hub endpoints bypass row policies). Pair
  with `actions` to make a column *set-once* (`"actions": ["update"]` → writable on
  insert, frozen after) or *set-later-only* (`"actions": ["insert"]` → blocked at
  creation, written later).
- `actions` (optional, default `["insert","update"]`) scopes the ACL to a subset of
  write actions. A caller who satisfies no listed principal gets a 403.
- A single `UPDATE` that writes two owner-columns bound to different owners is
  rejected — a member can only be one owner.

#### `retain_days` — hub-managed automatic expiry (cross-kind modifier)

Declares a retention window for one table; the hub's **daily maintenance runner**
deletes rows whose `timestamp_column` is older than `default` days. App SQL is
never granted this power — the bounded delete runs as trusted code, so a member
cannot use it to purge rows early. Valid on any policy kind.

```json
"retain_days": {
  "default": 90,
  "timestamp_column": "created_at",
  "id_column": "id",
  "override_key": "messages",
  "dependent_tables": [
    { "table": "message_reactions", "foreign_key": "message_id" }
  ]
}
```

- `default` — positive integer number of days to keep a row after
  `timestamp_column`.
- `timestamp_column` — the plaintext date/datetime column the age is measured
  from (`created_at` and other `_at` columns are already plaintext; a custom
  column must be listed in `db_plaintext_columns`).
- `id_column` (optional, default `"id"`) — the primary key used to page the
  delete.
- `override_key` (optional) — a shared name so several tables (or an admin
  setting) resolve to one retention value; all entries under one key must use the
  same `default`.
- `dependent_tables` (optional) — child rows to remove **before** an expired
  parent row, for legacy schemas that can't add `ON DELETE CASCADE` in an
  additive migration. Each is `{ table, foreign_key }` and must itself have a row
  policy.

Use it for ephemeral logs, chat history, location pings, and any table with a
"keep N days" policy. It affects only deletion timing — reads/writes still obey
the base policy kind.

#### `steward_writes_only` — roster steward-only writes (cross-kind modifier)

```json
{ "kind": "adult_writable", "steward_writes_only": true }
```

When the app is installed in a **`roster`** shared space, this locks every
app-originated `INSERT`/`UPDATE`/`DELETE` on the table to the space **steward**
(the teacher/coach/organizer — the space's `is_admin` member); all other members
are read-only. It is a no-op in households and in non-roster spaces, so a
dual-context app keeps its normal write rules everywhere except a roster. Valid on
any policy kind, and it composes with the base kind's read model:

- With `owner_or_visibility`, reads *also* collapse to steward-authored rows in a
  roster (star topology, automatic — see below), so peers never see each other.
  Reference: **calendar** `events` (`owner_or_visibility` + `write_visibility_scoped`
  + `steward_writes_only`; households stay fully open, a roster is teacher-only).
- With `adult_writable`, everyone still reads (so members can see the shared
  content) while only the steward writes. Reference: **volunteer** `sheets`/`slots`
  (members claim via a separate `slot_claims` endpoint, so they can still sign up).

Because it keys on the steward, it is one of only two policy features that consume
the space admin identity — the other being the roster read-collapse. See the
shared-spaces section below.

#### `owner_only_with_fk_check` — like `owner_only`, but the row references another owned row

```json
{
  "kind": "owner_only_with_fk_check",
  "member_column": "member_id",
  "fk_column": "bank_id",
  "fk_table": "piggy_banks",
  "fk_member_column": "member_id"
}
```

Same as `owner_only`, plus on `INSERT`/`UPDATE` the hub verifies the
referenced `fk_table` row (by `fk_column` -> `fk_table.id`) is owned by the
same member via `fk_table.fk_member_column` — prevents a child from writing
a transaction against another member's bank by guessing its id.

#### `owner_or_visibility` — a row is owned by one member but may be shared

```json
{
  "kind": "owner_or_visibility",
  "member_column": "owner_id",
  "visibility_column": "visibility",
  "everyone_values": ["everyone"],
  "adult_values": ["adults", "everyone"],
  "write_owner_only": false,
  "privileged_groups": [{ "settings_table": "settings", "settings_key": "committee_group_id" }],
  "privileged_values": ["private"]
}
```

- `SELECT`: a row is visible if `member_column = <caller>` OR
  `visibility_column` is in `everyone_values` (plus `adult_values` if the
  caller is an adult, plus `privileged_values` if the caller is privileged
  for `select` via `privileged_groups`).
- `UPDATE`/`DELETE`: privileged callers (an entry covering the statement's
  action) can always write any row. Adults can write any row **unless**
  `write_owner_only: true`, in which case adults (like everyone else) are
  restricted to `member_column = <caller>`.
- `INSERT`: always forces `member_column` to the caller — you own what you create.
- Add `"insert_privileged_only": true` (requires a `privileged_groups` entry covering `"insert"`) to block `INSERT` for everyone except the privileged group — returns 403 for all other callers regardless of adult status. The column is still forced to the caller for privileged inserts. SELECT/UPDATE/DELETE are unaffected by this flag.
- Add `"write_visibility_scoped": true` for **writes that follow reads**: a
  caller may `UPDATE`/`DELETE` exactly the rows they can `SEE` (their own, plus
  rows whose `visibility_column` grants them read). This supersedes both
  `write_owner_only` and the default "any adult writes any row" — a member who
  cannot see a row can no longer blind-write or blind-delete it either.
  Privileged members (entry covering the write action) still write any row —
  a select-only entry instead widens the rows such a member may co-edit,
  since writes follow reads; non-adults
  remain bound by `delete_adult_only` (and any `column_write_acls`). Use it for
  **collaboratively-edited, audience-scoped** tables — a group/committee working
  doc, a shared binder — where the whole visible audience co-edits but outsiders
  must not touch rows they can't even see. This is the only way to enforce
  "the audience co-edits, others can't write" without routing writes through an
  endpoint. (Note the fail-safe: if you flip an app-wide setting that widens a
  row's audience, a non-privileged caller who can't yet see a row can't re-key
  it — the failure is over-restrictive, never a disclosure.) `in-case-of-emergency`
  is the reference (`created_by`/`visibility` in `adults`/`group`, all adults or a
  configured group co-edit).

Example: streaks `streaks` (`owner_id`/`visibility` in `private`/`adults`/`everyone`); architectural-review `requests` (`submitted_by`/`visibility` in `public`/`private`, with the committee group privileged to see `private` requests and decide on any request); document-library `documents` (`created_by`/`visibility`, everyone reads, only board group may insert); in-case-of-emergency `entries` (`write_visibility_scoped` — the visible audience co-edits, outsiders can't write).

#### `adult_only` — entire table restricted to adults

```json
{ "kind": "adult_only" }
```

Every operation throws `403` for non-adult callers; adults are unrestricted.
Use for tables with no per-row ownership at all (e.g. shared account
balances, fund snapshots).

#### `couple_scoped` — visible/writable by a member and their configured partner

```json
{
  "kind": "couple_scoped",
  "self_column": "author_id",
  "participant_columns": ["author_id", "recipient_id"],
  "partner_table": "partner_config",
  "partner_member_column": "member_id",
  "partner_id_column": "partner_id"
}
```

A row is visible/writable if any of `participant_columns` equals the
caller's id or their configured partner's id (looked up from
`partner_table`). `INSERT` forces `self_column` to the caller and rejects
any `participant_columns` value that isn't the caller or their partner.
Assumes exactly one partner per member — not for group/throuple apps.

#### `party_scoped` — visible/writable by any of an arbitrary set of named members

```json
{
  "kind": "party_scoped",
  "member_columns": ["borrower_id", "lender_id"],
  "self_column": "borrower_id"
}
```

Like `couple_scoped` but for **N named participants with no configured partner
relationship** — borrow requests, expense splits, marketplace deals. A row is
visible/writable if the caller's id appears in **any** of `member_columns`.
`self_column` (optional) is forced to the caller on `INSERT`. Set
`"endpoint_writes_only": true` to block app-originated writes while keeping the
party-scoped read filter (writes then go through a trusted hub workflow).

Note: `party_scoped` limits *which rows* each party may write, but any party can
still write *any column* on a shared row. When each participant must consent
without being able to forge another's flag, put the consent state in a separate
`endpoint_only` table and use the `agreements` mechanism (see below), or gate the
columns with `column_write_acls` `owner_column`.

#### `channel_scoped` — visibility follows per-channel membership

For chat/forum-style rows whose audience is a channel's membership (all-household,
a role, or an explicit member list):

```json
{
  "kind": "channel_scoped",
  "channels_table": "channels",
  "channel_id_column": "channel_id",
  "membership_type_column": "membership_type",
  "membership_roles_column": "membership_roles",
  "membership_table": "channel_members",
  "membership_channel_column": "channel_id",
  "membership_member_column": "member_id",
  "self_column": "author_id"
}
```

- A row (e.g. a message) is visible/writable iff the caller is a member of the
  channel it references (`channel_id_column` → `channels_table.id`). Channel
  membership is one of: `all_value` (whole household), `role_value` (a role named
  in `membership_roles_column`), or an explicit row in `membership_table`
  (`group_value`). `all_value`/`role_value` default to `"all"`/`"role"`.
- `membership_type_column` and `membership_roles_column` must be plaintext
  (list them in `db_plaintext_columns`) — the hub compares them.
- `self_column` (optional) is forced to the caller on `INSERT`, so a member can't
  post as someone else.
- `group-channels` is the reference implementation; the parallel
  `subscription_notify` `eligibility` block mirrors this shape for follower
  fan-out.

#### `inherit_visibility` — a child row's access follows its parent row

For tables with no `member_id`/`visibility` of their own (votes, comments,
activity logs, streak check-offs) whose access should mirror a parent row
they reference via foreign key:

```json
{
  "kind": "inherit_visibility",
  "fk_column": "request_id",
  "parent_table": "requests",
  "writer_column": "voter_id"
}
```

- `parent_table` (unprefixed) must itself have an `owner_only`,
  `owner_only_with_fk_check`, or `owner_or_visibility` row policy — its
  visibility/ownership rules (and `privileged_groups`/`privileged_values`
  if present, evaluated per the child statement's action) are reused for the
  child table.
- `SELECT`: a child row is visible iff its parent row (matched via
  `fk_column = parent.id`) is visible to the caller.
- `INSERT`: forces `writer_column` to the caller, and rejects the insert
  (`403`) if the referenced parent row isn't visible to the caller (e.g.
  can't vote/comment/log on something you can't see).
- Add `"insert_only_by_parent_column_member": "current_turn_member_id"` for
  turn-scoped child rows: the referenced parent row must have that member-id
  column equal to the caller before any app-originated `INSERT` is accepted.
  This is stricter than visibility and is enforced even for adults/privileged
  callers, so a player cannot insert a move/question/guess when it is not their
  turn by POSTing raw SQL to `/api/db`.
- `UPDATE`/`DELETE`: privileged callers (per the parent policy's
  `privileged_groups`/adult-bypass, for that action) are unrestricted (e.g.
  cascade-delete when the parent is deleted); everyone else is restricted to
  rows where `writer_column = <caller>`.
- Add `"insert_privileged_only": true` to block `INSERT` for everyone except
  the privileged group inherited from the parent policy's `privileged_groups`
  (entries covering `"insert"`). Returns 403 for all other callers. Useful when
  only a designated group should be able to create child rows (e.g. only the
  board uploads document versions).

Examples: architectural-review `votes`/`comments` inherit from `requests`;
officer-elections-style "any visible member can check off a group streak"
(streaks `streak_logs` inherits from `streaks`); violation-tracking
`activity` inherits from `violations` (homeowners see/log activity only on
their own violations; board members see/log on any violation); document-library
`document_versions` inherits from `documents` with `insert_privileged_only: true`
(only the board may upload new versions).

Turn-based game pattern: put `current_turn_member_id` on the parent game/round
table, make moves/questions/guesses an `inherit_visibility` child table, and set
`insert_only_by_parent_column_member: "current_turn_member_id"` on that child
policy. This covers async turn rotation for Word Game / 20 Questions / Draw &
Guess-style apps without a bespoke server endpoint per game. Pair it with
`max_per_member` when the child table also needs one attributed row per round
or turn.

#### `sealed_until` — owners see their response until the parent closes, then everyone sees

Use `sealed_until` for attributed, non-anonymous child rows that should be hidden
from non-owners until a parent row reaches a release state. It is the N-party
version of "mutual reveal": each member can see and edit their own response while
the round/session is open; once the parent says `status = "closed"`, every member
can read all responses.

```json
{
  "kind": "sealed_until",
  "fk_column": "round_id",
  "parent_table": "rounds",
  "writer_column": "member_id",
  "parent_status_column": "status",
  "visible_parent_status_values": ["closed"],
  "max_per_member": {
    "member_column": "member_id",
    "scope_columns": ["round_id"],
    "limit": 1
  },
  "frozen_when": {
    "status_column": "status",
    "locked_values": ["closed"]
  }
}
```

- `SELECT`: the caller sees rows where `writer_column = <caller>`, plus any rows
  whose parent row (matched by `fk_column = parent.id`) has
  `parent_status_column` in `visible_parent_status_values`.
- `INSERT`: forces `writer_column` to the caller.
- `UPDATE`/`DELETE`: remains writer-scoped. Add `frozen_when` so nobody can edit
  or delete responses after the parent round closes.
- `parent_status_column` must be plaintext. `status` is built in; custom release
  columns such as `round_state` must be listed in `db_plaintext_columns`.
- Add `"visible_after_parent_column": "reveal_date"` for a **clock-based reveal**:
  a plaintext ISO date/datetime column on the parent releases all rows once its
  value is at or before the hub's current time, OR'd with the status-based release
  above. The hub enforces the clock — the app cannot make a still-sealed capsule
  open early, and reveal happens even if no one clicks a Reveal button. A plain
  `_date` column ("2026-07-09") opens from the start of that UTC day; a datetime
  column releases at the instant it names. Use it for time capsules and scheduled
  reveals; leave it off for reveals driven purely by a status change. Mirror it in
  any client "is this released?" gate (compare `reveal_date <= new Date().toISOString()`)
  so the UI matches what the hub will actually return. `time-capsule` is the
  reference implementation.
- Pair with `max_per_member` for "one answer/guess/bid per member per round."
  This is still attributed data, so do not use it for anonymous surveys or secret
  ballots; use `anonymous_responses` / `anonymous_ballot` when the response row
  must not identify the member.

Examples: Family Trivia answers, Word Game guesses, 20 Questions answers, Draw &
Guess submissions, and sealed HOA vendor bids. Parent rows are usually
`adult_writable`, `owner_or_visibility`, or another policy appropriate to who may
create/close rounds. If the app also has turn-scoped moves/questions, use
`inherit_visibility` with `insert_only_by_parent_column_member` for those action
rows and `sealed_until` for the final per-member responses.

### Choosing a policy kind

| Your table looks like... | Use |
|---|---|
| Table written only by a trusted hub endpoint; result access controlled separately | `endpoint_only` with appropriate `read` |
| Shared content adults manage, everyone reads (chores, polls, surveys) | `adult_writable` |
| Same, but non-adults should only read their own rows | `adult_writable` with `member_read_column` |
| Settings row that names a privileged group (board_group_id, committee_group_id) | `app_config` |
| One row per member, only that member (and maybe adults) should see it | `owner_only` |
| One attributed submission per member per event/round/title/slot | Any suitable row policy plus `max_per_member` |
| Same, but writes must go through a hub endpoint (e.g. vote receipts) | `owner_only` with `endpoint_writes_only: true` |
| Like the above, but the row references another owned row (e.g. a transaction against a bank) | `owner_only_with_fk_check` |
| A row can be private, shared with adults, or shared with everyone | `owner_or_visibility` |
| The row is readable by all, but one column (secret word, valuation) only by the owner/adults/a group | Any owner-bearing kind plus `column_read_acls` |
| The visible audience (all adults, or a configured group) should co-edit rows, but no one may write a row they can't see | `owner_or_visibility` with `write_visibility_scoped: true` |
| Table-wide, adults-only data (account balances, fund totals) | `adult_only` |
| Shared between exactly two partnered members | `couple_scoped` |
| Shared among an arbitrary set of named members (borrow request, expense split) | `party_scoped` |
| Rows whose audience is a chat/forum channel's membership | `channel_scoped` |
| Cap the total rows a table may hold (incl. external submissions) | any kind plus `max_rows` |
| Auto-expire rows after N days (ephemeral logs, chat history, location pings) | any kind plus `retain_days` |
| Votes/comments/logs/check-offs whose visibility should match a parent record | `inherit_visibility` |
| Turn-based child rows where only the current player may INSERT (moves, questions, guesses) | `inherit_visibility` with `insert_only_by_parent_column_member: "current_turn_member_id"` |
| Attributed responses hidden from everyone except the owner until the parent closes | `sealed_until` with `visible_parent_status_values: ["closed"]`; usually add `max_per_member` and `frozen_when` |
| Sealed entries that must open on a wall-clock date, hub-enforced (time capsule, scheduled reveal) | `sealed_until` with `visible_after_parent_column: "reveal_date"` |
| Anonymous data with no per-row ownership at all (e.g. cast ballots, raw anonymous responses) | `endpoint_only` with `read:"none"` — pair with a receipt table under `owner_only` + `adults_bypass:false` + `member_can_update:false` + `endpoint_writes_only:true`; use `anonymous_responses` or `anonymous_ballot` manifest mechanisms to write both atomically |
| Everyone can read, but only a specific group may INSERT (e.g. board-managed docs) | `owner_or_visibility` with `everyone_values`, `write_owner_only: true`, and `insert_privileged_only: true` |
| Child rows where only a privileged group may create them (e.g. document versions) | `inherit_visibility` with `insert_privileged_only: true` |

### `privileged_groups`

```json
"privileged_groups": [
  { "settings_table": "settings", "settings_key": "board_group_id" }
]
```

Grants unrestricted access to members of a hub group whose id is stored in
this app's own `settings_table` under `settings_key`. Requires your app to
have a `settings` table (key/value, like
`app_violation_tracking__settings`) and a settings UI where an admin/adult
picks a hub group (e.g. "Board", "Committee") to designate as privileged.
If the setting is unset, no one gets this bypass — only the
`adults_bypass`/`adult_values` rules apply.

Available on `owner_only`, `owner_only_with_fk_check`, and
`owner_or_visibility` (and inherited by `inherit_visibility` children from
their parent). Each entry may scope its privilege with `"actions"`, a
non-empty subset of `"select"`/`"insert"`/`"update"`/`"delete"`; omitting
`actions` grants all four. List multiple entries for per-role power — the
caller is privileged for a statement when they belong to **any** entry whose
actions cover that statement's kind:

```json
"privileged_groups": [
  { "settings_table": "settings", "settings_key": "treasurer_group_id", "actions": ["insert"] },
  { "settings_table": "settings", "settings_key": "secretary_group_id", "actions": ["update", "delete"] }
]
```

Rules to know:

- **Visibility follows `select`.** Anything that widens what a caller can
  *see* — `privileged_values`, `column_read_acls` `"privileged"`, the parent
  visibility used by `inherit_visibility`, and the row set writable under
  `write_visibility_scoped` (writes follow reads) — uses `"select"` privilege,
  never the write actions. An insert-only entry grants no extra read access.
- **Gate flags need coverage.** `insert_privileged_only` /
  `delete_privileged_only` require an entry covering that action;
  `write_privileged_only` requires coverage of `insert`, `update`, **and**
  `delete`. Otherwise the manifest is rejected (the flag would lock everyone
  out).
- **Legacy shape.** `"bypass_group_setting": { settings_table, settings_key }`
  is still accepted and is exactly equivalent to one `privileged_groups` entry
  with no `actions`. Declaring both on one policy is a manifest validation
  error — use `privileged_groups` in new apps.

### Verifying your row_policies

`node build.mjs` runs manifest validation, including `row_policies` — it
will catch invalid `kind`, missing required fields, bad identifiers, and
`inherit_visibility.parent_table` not having a compatible parent policy. It
also verifies `sealed_until.parent_status_column` is plaintext and that the
declared parent table has a row policy.
This catches schema mistakes before install, but does **not** test the
actual SQL rewriting — when in doubt, check
`packages/hub/__tests__/unit/cloudflare-row-policy.test.ts` in the hub repo
for worked examples per policy kind.

### Shared spaces & the `roster` context

Your app runs in one of two **tenant kinds**. The app's SQL is identical in both;
only how policies resolve differs.

- **`household`** — the default family tenant. Everything above assumes this.
- **`shared_space`** — a cross-household space, with sub-kinds `general`,
  `coparenting`, and `roster`.

**Opt in first.** An app is installable in a space **only** if its manifest declares:

```json
"contexts": ["household", "shared_space"]
```

Omit `contexts` (or list only `"household"`) and the app is household-only — it
never appears in a space. This is the single switch that makes an app space-capable.

**The steward.** A space has a steward — its `is_admin` member (the teacher, coach,
or organizer). The hub maps household "adult" vocabulary onto spaces automatically:
"adult capability" gates (`adult_writable` writes, `adult_only`) apply to any full
participant, but **supervision** — the adult read-all / write-all / bypass powers —
belongs to the **steward alone** in a space (in a space everyone is nominally an
adult, so "any adult supervises" would mean "everyone," which is wrong). You don't
code this; it's how role resolution behaves per tenant.

**`roster` = star topology.** A roster (classroom / team / clients) is one steward
broadcasting to a flat list of members who must not see or reach each other. Two
behaviors implement it, both **roster-scoped** (inert in households and in
`general`/`coparenting` spaces):

1. **Read-collapse — automatic, no opt-in.** On an `owner_or_visibility` table, a
   non-steward's `everyone`/`adult` visibility collapses to **steward-authored rows +
   their own**, so a member never sees a peer's rows. The steward sees the full
   roster. You declare nothing extra — it happens because the tenant is a roster. If
   your app has a table a roster is *meant* to share among members (e.g. a public
   sign-up list), use `adult_writable`/everyone-read instead, so the collapse doesn't
   hide it.
2. **`steward_writes_only` — opt-in modifier** (documented above): locks writes to
   the steward. This is "only the teacher authors."

**Location defaults OFF in a roster.** If your app consumes location/geofence data,
note the hub resolves the location `collect` flag to `false` by default in a roster
space unless the steward turns it on — so don't assume location is being collected.

**Design checklist for a space-capable app:**
- A table with **no** policy is fully member-read/writable in a roster too — the star
  topology only governs `owner_or_visibility` reads and `steward_writes_only` writes.
  Police every table you don't want members freely editing.
- "Only the steward may do X" → `steward_writes_only` or a server endpoint, never a
  client `canManage` check.
- Peer-privacy on `endpoint_only` / `adult_writable` reads is **not** automatic (the
  collapse is `owner_or_visibility`-only) — hiding who-did-what on those needs
  deliberate design.

### Named AI queries (`ai_access`) obey the same row policies

Your `ai_access` named SQL — `db_exports` (queries), `db_mutations`, `db_inserts`,
`db_deletes` — runs through the **same** `row_policies` enforcement as `/api/db`.
An AI caller does **not** get to bypass a policy. This has practical consequences
for how you write those `.sql` files:

- **The caller must pass a `member_id`.** MCP tokens are household-scoped and carry
  no member identity, so the AI supplies `member_id` per call. A named query that
  touches an `owner_only`, `owner_or_visibility`, or `adult_only` table **returns
  403 ("Member identity required") when `member_id` is absent** — the same as a raw
  `/api/db` call with no session member. Write your named queries assuming a member
  is always provided, and document in the query's purpose which member's view it
  returns.
- **No JOINs or subqueries against a governed table.** The rewriter fails closed on
  governed tables referenced through a JOIN or a subquery/CTE. Keep each named query
  a single-table `SELECT` on the governed table; do lookups/labels in a second query
  or denormalize the label onto the row.
- **`column_read_acls` masking applies here too.** A `db_export` that selects a
  masked column returns `null` for that column unless the passed `member_id` is the
  owner (or an adult/privileged member per `visible_to`). Don't rely on a named
  query to read a secret column on behalf of a non-owner.
- **Named `INSERT`s into `owner_only` tables force the owner column to the caller.**
  Include the member column in the insert and expect the hub to stamp it to
  `member_id`; you cannot insert a row owned by someone else through a named insert.
- `adult_writable` "everyone-read" tables are the exception — their `db_exports`
  need no `member_id` (reads are open); only their writes require an adult.

## Atomic capacity claims — `slot_claims`

For sign-up sheets, shift claims, carpool seats, babysitting co-op coverage, amenity slots, and any "claim iff capacity remains" flow, use the `slot_claims` manifest mechanism instead of writing the claims table directly through `/api/db`.

**Why you can't do this with row_policies alone:** capacity is a cross-row invariant. A browser can read "2 seats left" and then race another browser before inserting; `max_per_member` can prevent duplicate claims by the same member, but it cannot atomically enforce `COUNT(claims) < slots.capacity`.

### How it works

Declare `slot_claims` in `manifest.json`. The hub injects `window.__CLAIM_URL`, `window.__RELEASE_URL`, and `window.__SWAP_URL`. The claim endpoint:

1. Resolves the caller's `member_id` from the session (cannot be spoofed)
2. Runs one atomic `INSERT ... SELECT` that inserts only if the slot exists, is open, capacity remains, and (optionally) the caller has not already claimed that slot
3. Returns `201 { success: true, claim_id }` on success
4. Returns `404` for a missing slot, or `409` with `reason: "slot_closed" | "slot_full" | "already_claimed"` when the guarded insert does not happen

Release deletes only the caller's own claim. Swap claims the destination slot first, then releases the source slot; if the destination is full or closed, the original claim is untouched. Because D1 exposes only single-statement writes here, swap is not a true transaction: the hub best-effort rolls back the new claim if the source release fails.

### Manifest config

```jsonc
{
  "storage": "db",
  "db_plaintext_columns": ["capacity", "note"],
  "row_policies": {
    "slot_claims": { "kind": "endpoint_only", "read": "everyone" }
  },
  "slot_claims": {
    "slot_table": "slots",
    "slot_id_column": "id",
    "capacity_column": "capacity",
    "slot_status_column": "status",
    "slot_open_values": ["open"],
    "claims_table": "slot_claims",
    "claim_id_column": "id",
    "slot_fk_column": "slot_id",
    "member_column": "member_id",
    "created_at_column": "created_at",
    "one_claim_per_member": true,
    "allow_release": true,
    "allowed_columns": ["note"],
    "max_text_lengths": { "note": 200 }
  }
}
```

- Table/column names are **unprefixed** in the manifest.
- The claims table must be `endpoint_only`; otherwise a member can bypass capacity by POSTing raw SQL to `/api/db`.
- `capacity_column`, `slot_status_column`, and every `allowed_columns` payload column must be plaintext. Built-ins like `id`, `status`, `created_at`, and `*_id` already are; custom columns like `capacity` or `note` must be listed in `db_plaintext_columns`.
- `slot_open_values` is required when `slot_status_column` is present.
- `allowed_columns` are optional app-defined payload columns on the claim row. The hub accepts only scalar JSON (`string`, `number`, `boolean`, `null`) and enforces `max_text_lengths`.

### Schema requirements

```sql
CREATE TABLE IF NOT EXISTS app_myapp__slots (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  capacity   INTEGER NOT NULL CHECK (capacity >= 0),
  status     TEXT NOT NULL DEFAULT 'open',
  starts_at  TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_myapp__slot_claims (
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note       TEXT,
  FOREIGN KEY (slot_id) REFERENCES app_myapp__slots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slot_claims_slot
  ON app_myapp__slot_claims (slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_claims_member
  ON app_myapp__slot_claims (member_id);
```

If `one_claim_per_member` is true, the endpoint enforces it. A unique index on `(slot_id, member_id)` is still fine as defense in depth, but do not rely on an index alone for capacity.

### Client helpers

```js
async function claimSlot(slotId, payload = {}) {
  const res = await fetch(window.__CLAIM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot_id: slotId, ...payload }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw Object.assign(new Error(json.error || "Claim failed"), { response: res, json });
  return json; // { success: true, claim_id }
}

async function releaseSlot(slotId) {
  const res = await fetch(window.__RELEASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot_id: slotId }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw Object.assign(new Error(json.error || "Release failed"), { response: res, json });
  return json; // { success: true }
}

async function swapSlot(fromSlotId, toSlotId, payload = {}) {
  const res = await fetch(window.__SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_slot_id: fromSlotId, to_slot_id: toSlotId, ...payload }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw Object.assign(new Error(json.error || "Swap failed"), { response: res, json });
  return json; // { success: true, claim_id }
}
```

Handle `409` reasons explicitly in the UI: `slot_full` means someone else got the last spot, `already_claimed` means the caller already has a claim on that slot, and `slot_closed` means the slot's status is no longer claimable. After a successful claim/release/swap, patch local state optimistically or re-query just the affected slot and claim list.

## Anonymous submissions — `anonymous_responses`

For surveys, polls, and any "one submission per session per member" flow where the submitter's identity must optionally be hidden, use the `anonymous_responses` manifest mechanism instead of writing directly to `/api/db`.

**Why you can't do this with row_policies alone:** a client posting directly to `/api/db` can omit or forge its own `member_id`. The server needs to resolve identity and decide whether to store it.

### How it works

Declare `anonymous_responses` in `manifest.json`. The hub exposes `POST /run/{appId}/api/submit-response`, which:

1. Resolves the caller's `member_id` from the session (cannot be spoofed)
2. Checks the session table: rejects if status ≠ `session_open_value`, or if the optional `session_deadline_column` has passed
3. Checks the receipt table for a duplicate → 409 `already_responded` if found
4. Inserts the receipt row first (fail-safe: a partial failure always blocks retry)
5. Inserts one response row per answer, with `member_id` set or omitted based on anonymity

The hub injects `window.__SUBMIT_RESPONSE_URL` for apps that declare this field.

### Config

```json
{
  "anonymous_responses": {
    "receipt_table":              "response_receipts",
    "session_column":             "survey_id",
    "member_column":              "member_id",
    "created_at_column":          "created_at",
    "response_table":             "responses",
    "response_session_column":    "survey_id",
    "response_question_column":   "question_id",
    "response_member_column":     "member_id",
    "response_answer_column":     "answer",
    "response_id_column":         "id",
    "response_created_at_column": "created_at",
    "session_table":              "surveys",
    "session_id_column":          "id",
    "session_status_column":      "status",
    "session_open_value":         "open",
    "session_anonymous_column":   "anonymous",
    "session_deadline_column":    "closes_at",
    "result_visible_values":      ["closed"]
  }
}
```

- Omit `response_member_column` → always anonymous (member_id never stored in response rows)
- Omit `session_anonymous_column` → same (no per-session toggle)
- Include both → hub reads the session's `anonymous` column at submission time; non-anonymous sessions store `member_id`, anonymous sessions strip it

### Optional deadline — `session_deadline_column`

A nullable timestamp column on the session table. Once it passes the hub does **both** halves at the same instant, with no cron and nobody having to close anything:

- `POST api/submit-response` → 409 `Response deadline has passed`
- `GET api/response-results` → releases the results, even though `status` is still open

Requires `result_visible_values` (a deadline with nowhere to release to is decoration). NULL on a session means "no deadline" — the behaviour every existing row already has. `anonymous_ballot` has the identical field.

**A value with no zone suffix is HOUSEHOLD-LOCAL wall time**, which is exactly what `<input type="datetime-local">` produces: store `2026-08-05T20:00` and the hub resolves 8pm in the household's timezone. Do NOT convert it to UTC before storing — that would put the day-boundary in the wrong place for an `agenda` that filters `substr(closes_at, 1, 10) = :today`.

**Mirror the check in your client.** `status` does not change when a deadline passes, so a client that reads `status` alone keeps offering a submit button the hub now rejects. Surveys' `isSurveyOpen()` treats a passed `closes_at` as closed.

### Schema requirements

```sql
-- Receipt table: one row per (session, member) — immutable proof of submission
CREATE TABLE IF NOT EXISTS app_myapp__response_receipts (
  survey_id  TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (survey_id, member_id)
);

-- Response table: member_id nullable to support anonymous rows
CREATE TABLE IF NOT EXISTS app_myapp__responses (
  id          TEXT NOT NULL PRIMARY KEY,
  survey_id   TEXT NOT NULL,
  question_id TEXT NOT NULL,
  member_id   TEXT,           -- NULL for anonymous submissions
  answer      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Partial unique index: one response per member per question for non-anonymous;
-- NULL member_id rows are unconstrained (SQLite treats each NULL as distinct)
CREATE UNIQUE INDEX IF NOT EXISTS responses_member_unique
  ON app_myapp__responses (survey_id, question_id, member_id)
  WHERE member_id IS NOT NULL;
```

Receipt table row policy — immutable and invisible to everyone including adults, writes blocked except through the hub endpoint:

```json
"response_receipts": {
  "kind": "owner_only",
  "member_column": "member_id",
  "adults_bypass": false,
  "member_can_update": false,
  "endpoint_writes_only": true
}
```

Response table — use `endpoint_only` so app-originated writes are rejected and reads are controlled:

```json
"responses": { "kind": "endpoint_only", "read": "none" }
```

`read: "none"` keeps raw responses hidden until a trusted hub endpoint releases them (e.g. `/api/response-results` after session closure). Use `read: "everyone"` or `read: "adult"` if attributed responses should be readable directly once the session closes. Never leave the response table without a row policy — without it any member can INSERT, UPDATE, or DELETE response rows via `/api/db`.

### Calling the endpoint

```js
const SUBMIT_RESPONSE = window.__SUBMIT_RESPONSE_URL ?? "";

const res = await fetch(SUBMIT_RESPONSE, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    session_id: survey.id,
    responses: questions.map(q => ({
      question_id: q.id,   // only if response_question_column is declared
      answer: answers[q.id],
    })),
  }),
});
if (res.status === 409) { /* already submitted */ }
```

### Critical: "has responded" queries must use the receipt table

For anonymous submissions, `member_id` is NULL in the response table — `COUNT(DISTINCT member_id)` on it always returns 0. Use the receipt table for all response-count and "have I responded" checks, including list views, widgets, and AI export SQL files:

```sql
-- ✅ Correct — works for both anonymous and non-anonymous sessions
EXISTS(
  SELECT 1 FROM app_myapp__response_receipts rr
  WHERE rr.survey_id = s.id AND rr.member_id = ?
) AS i_responded

-- ❌ Wrong — always 0 for anonymous sessions
EXISTS(
  SELECT 1 FROM app_myapp__responses r
  WHERE r.survey_id = s.id AND r.member_id = ?
) AS i_responded
```

## Multi-party agreements — `agreements`

For any flow where two or more named participants must each consent before a record is "locked" (borrow requests, family contracts, parental agreements, shared commitments), use the `agreements` manifest mechanism instead of storing agreement flags in a `party_scoped` table.

**Why prefer the `agreements` mechanism:** it also provides atomic locking, snapshot-freezing of agreed values, and bootstrap-from-source — server-side logic a row policy can't express. If all you need is *forgery prevention* (each party may only write its own flag), you can instead keep a single governed table and add `column_write_acls` giving each flag column `{ "writable_by": ["owner"], "owner_column": "<that party's member column>" }` — the hub then appends a per-party owner guard so a member cannot forge their counterpart's consent via `/api/db`. Reach for the `agreements` endpoint when you also need the locking/snapshot semantics below.

### How it works

Declare `agreements` in `manifest.json`. The hub exposes `POST /run/{appId}/api/agree`, which:

1. Resolves the caller's `member_id` from the session (cannot be spoofed)
2. Reads the agreement row; if it doesn't exist and `init_from_table` is configured, bootstraps it by copying `init_columns` from the source table
3. Verifies the caller is a participant (their id must be in one of the `participant_columns`)
4. Sets only the caller's own flag (`agreement_columns[callerId]`) to `agreed` (true) or `0` (false)
5. If all flags are now true, sets `status_column` to `locked_value` and records `locked_at`

### Table layout

Split into two tables — item details in a `party_scoped` table, agreement state in a separate `endpoint_only` table:

```sql
-- Item details: parties can read/edit terms
CREATE TABLE IF NOT EXISTS app_myapp__requests (
  id          TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL,
  lender_id   TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  -- ... other item-detail columns ...
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'cancelled' | 'returned'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Agreement state: only api/agree may write
CREATE TABLE IF NOT EXISTS app_myapp__request_agreements (
  id              TEXT PRIMARY KEY,  -- same id as requests
  borrower_id     TEXT NOT NULL,     -- copied from requests on init
  lender_id       TEXT NOT NULL,
  borrower_agreed INTEGER NOT NULL DEFAULT 0,
  lender_agreed   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'locked'
  locked_at       TEXT,
  updated_at      TEXT NOT NULL
);
```

### Manifest config

```json
{
  "row_policies": {
    "requests": {
      "kind": "party_scoped",
      "member_columns": ["borrower_id", "lender_id"],
      "self_column": "borrower_id"
    },
    "request_agreements": {
      "kind": "endpoint_only",
      "read": "everyone"
    }
  },
  "agreements": {
    "request_agreements": {
      "participant_columns": ["borrower_id", "lender_id"],
      "agreement_columns": { "borrower_id": "borrower_agreed", "lender_id": "lender_agreed" },
      "status_column": "status",
      "pending_value": "pending",
      "locked_value": "locked",
      "locked_at_column": "locked_at",
      "updated_at_column": "updated_at",
      "init_from_table": "requests",
      "init_columns": ["borrower_id", "lender_id"]
    }
  }
}
```

- `participant_columns` — columns whose values name the valid participants; hub rejects callers not in this set
- `agreement_columns` — maps each participant column name to the boolean flag column that participant controls
- `init_from_table` + `init_columns` — when the agreement row doesn't exist yet, the hub INSERTs it by copying these columns from the named table (same `id`). Required when the agreement table is `endpoint_only` and the client cannot INSERT into it directly.
- `locked_at_column` / `updated_at_column` — optional; hub sets them server-side

### Client flow

```js
// After inserting into the party_scoped table:
await db(`INSERT INTO app_myapp__requests (...) VALUES (...)`, [...]);
// Trigger init_from_table + set caller's own flag:
await fetch(`/run/${APP_ID}/api/agree`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ table: "request_agreements", id, agreed: true }),
});

// When the other party agrees:
await fetch(`/run/${APP_ID}/api/agree`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ table: "request_agreements", id: reqId, agreed: true }),
});
// Hub sets both flags; if both true, sets status='locked', locked_at=now

// When a party edits terms (reset their agreement; other party must re-agree):
await db(`UPDATE app_myapp__requests SET item_name=?, updated_at=? WHERE id=?`, [...]);
await fetch(`/run/${APP_ID}/api/agree`, { ..., body: JSON.stringify({ table: "request_agreements", id: reqId, agreed: false }) });
await fetch(`/run/${APP_ID}/api/agree`, { ..., body: JSON.stringify({ table: "request_agreements", id: reqId, agreed: true }) });
```

### Reading effective status

JOIN the two tables and derive `status` via CASE — the party_scoped table's `status` tracks terminal states (cancelled, returned), while the agreement table tracks the in-progress lock:

```sql
SELECT
  r.*,
  COALESCE(ra.borrower_agreed, 0) AS borrower_agreed,
  COALESCE(ra.lender_agreed, 0)   AS lender_agreed,
  CASE
    WHEN r.status IN ('cancelled', 'returned') THEN r.status
    WHEN ra.status = 'locked'                  THEN 'locked'
    ELSE 'pending'
  END AS status,
  ra.locked_at
FROM app_myapp__requests r
LEFT JOIN app_myapp__request_agreements ra ON ra.id = r.id
WHERE (r.borrower_id = ? OR r.lender_id = ?)
```

Reference implementation: `borrowing` app (`migrations/002_agreement_state.sql`, `manifest.json` `agreements` block, `src/index.html` `loadRequests`/`createRequest`/`updateRequest`/`agreeOnServer`).

## External share links — `shareable`

A share link is a time-boxed opaque token (`/share/{token}`) that lets a **non-member** see a hub-rendered page for ONE row of one of your tables. Adults mint links from inside your app via `createShareHelper` from `/hub-sdk.js`; the hub renders the page itself — you write no public HTML.

Resolution **deliberately bypasses row policies**. The manifest declares the entire public projection, so treat every column you list as published to the internet.

```jsonc
"shareable": {
  "wall": {                            // logical item type, used when minting
    "table": "walls",                  // UNPREFIXED
    "title_column": "title",
    "columns": [                       // the ENTIRE public column surface
      { "column": "occasion_date", "label": "When", "format": "date" },
      { "column": "description", "label": "About", "format": "multiline" }
    ],
    "visible_where": { "column": "status", "values": ["open"] },   // plaintext gate on the row
    "files": { "ids_column": "cover_file_ids", "label": "Photos" }, // JSON array of hub file ids
    "aggregates": [ /* count | sum | list — collapses child rows to one value */ ]
  }
}
```

Basic read-only sharing is **free**. The premium `sharing` capability raises the link/expiry caps and unlocks passwords plus `submit` (external non-members insert one row into a child table). Never put `sharing` in `required_capabilities` — the gate lives inside the share endpoints.

### `feed` — render child rows as entry cards

An `aggregate` collapses children to a number or a joined string. A **feed** shows them: a guestbook, a comment wall, a photo stream.

```jsonc
"feed": {
  "label": "Messages",
  "table": "posts",                    // UNPREFIXED child table
  "fk_column": "wall_id",              // references the shared row's id
  "columns": [
    { "column": "author_name", "label": "From", "role": "heading" },
    { "column": "created_at", "label": "Posted", "format": "datetime", "role": "timestamp" },
    { "column": "body", "label": "Message", "format": "multiline", "role": "body" }
  ],
  "files_column": "file_ids",          // per-entry JSON array of file ids; images render inline
  "where": [                           // ANDed plaintext filters (max 4)
    { "column": "status", "values": ["published"] },
    { "column": "visibility", "values": ["everyone"] }
  ],
  "parent_where": { "column": "post_visibility", "values": ["everyone"] },
  "order_column": "created_at",
  "order": "newest",                   // or "oldest"; default "newest"
  "max_items": 50,                     // capped at 200
  "empty_text": "No messages yet."     // omit and an empty feed hides the section
}
```

Rules worth knowing before you use it:

- **`role` is presentation only.** `heading`/`timestamp`/`body` drop the label; `detail` (the default) renders `Label: value`.
- **`where` is how moderation reaches the public page.** Flipping a post's status to `hidden` unpublishes it — and its photos — on the next page load.
- **`parent_where` gates the WHOLE feed from the shared row.** That is the row's own "visitors may see contributions" switch: when it fails, the item still renders and the child table is never even read.
- **`where`, `parent_where.column` and `order_column` must be plaintext** (built-in name, `_id`/`_at`/`_date`/`_by` suffix, or listed in `db_plaintext_columns`). SQL cannot filter or sort ciphertext, and the failure would be silent. Projected `columns` are decrypted normally and need no such declaration.
- **Entry files are capped** at 12 per entry and 100 across the feed; they stream through the same gated `/api/share/{token}/file/{id}` endpoint as the item-level `files` block.

## Append-only records — `append_only_records`

For immutable history rows, receipts, predictions, audit notes, and other "add a new record, never edit/delete it" data, use `append_only_records` instead of writing the table directly through `/api/db`.

The hub exposes `POST /run/{appId}/api/append-record/{name}` and injects `window.__APPEND_RECORD_URL` when the app declares the manifest field. The endpoint:

- accepts only whitelisted columns
- derives the row id, writer member id, and timestamp server-side
- optionally verifies a parent row exists
- optionally blocks appends when the parent is in a closed status
- enforces string length and enum allowlists
- inserts while bypassing the table's `endpoint_only` write block

Pair each append-only target table with either `row_policies.{table}.kind = "endpoint_only"` or an existing read policy that supports `"endpoint_writes_only": true` so direct app SQL cannot `INSERT`, `UPDATE`, or `DELETE` rows. Use `endpoint_only` for household-readable logs; use `endpoint_writes_only` on policies like `owner_only`, `adult_writable`, or `inherit_visibility` when reads still need owner/private/inherited filtering.

```jsonc
{
  "row_policies": {
    "notes": { "kind": "endpoint_only", "read": "everyone" }
  },
  "append_only_records": {
    "notes": {
      "table": "notes",
      "parent_table": "items",
      "parent_fk_column": "item_id",
      "parent_status_column": "status",
      "parent_blocked_status_values": ["closed", "voided"],
      "allowed_columns": ["item_id", "body", "kind"],
      "writer_column": "created_by",
      "created_at_column": "created_at",
      "write_acl": {
        "require_role": "adult"
      },
      "allowed_values": {
        "kind": ["note", "receipt"]
      },
      "max_text_lengths": {
        "body": 2000,
        "kind": 20
      }
    }
  }
}
```

```js
async function appendRecord(name, data) {
  const res = await fetch(`${window.__APPEND_RECORD_URL}/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || "Append failed");
  return json; // { success: true, id, created_at? }
}

await appendRecord("notes", {
  item_id: itemId,
  kind: "receipt",
  body: "Screenshot saved before the decision changed.",
});
```

Use this for immutable children only. It does not enforce multi-party consent or state-machine decisions; use `agreements`, a more specific generic endpoint, or a new reusable protocol for those.

`write_acl` is optional. Use `"require_role": "adult"` for adult-only appends, or `"require_group_setting": { "settings_table": "settings", "settings_key": "committee_group_id" }` when only members of a configured Hub group may append. Household admins bypass group membership checks.

## Security pitfalls

### Client gates must mirror server policy

A helper like `canManage(item, me)` that returns `true` for the item's `created_by` regardless of role will show action buttons to non-adult creators. When they click, the `adult_writable` policy blocks the write with a silent 403 — misleading UX. The client gate should match the server policy exactly:

```js
// ❌ Wrong — shows controls to a non-adult creator
function canManage(item, me) {
  return item.created_by === me.id || isAdult(me);
}

// ✅ Correct — mirrors adult_writable policy
function canManage(item, me) {
  return !!me && isAdult(me);
}
```

#### Privileged-group gates: no "all adults" fallback when unconfigured

The same trap bites harder for `insert_privileged_only` / `write_privileged_only`
tables gated by `privileged_groups` (board/committee group). The hub treats a
member as privileged **only** when the group is configured, still exists, and the
member is in it — there is **no adult fallback** when the setting is unset or
points at a deleted group (`privileged_groups`: *"If the setting is unset, no
one gets this bypass"*). A client gate that returns `true` for adults when no
group is configured shows write UI the hub then 403s on every INSERT:

```js
// ❌ Wrong — "all adults are board until a group is picked". The hub rejects
//    every privileged INSERT while the group is unset, so adults see add/upload
//    buttons that silently fail.
function isBoard(me, groups, boardGroupId) {
  if (!isAdult(me)) return false;
  if (!boardGroupId) return true;                 // ← divergence from the hub
  const g = groups.find(g => g.id === boardGroupId);
  return g ? g.memberIds.includes(me.id) : true;  // ← dangling group also wrong
}

// ✅ Correct — mirrors the hub's memberInAppGroupSetting exactly.
function isBoard(me, groups, boardGroupId) {
  if (!isAdult(me) || !boardGroupId) return false;
  const g = groups.find(g => g.id === boardGroupId);
  return !!g && g.memberIds.includes(me.id);
}
```

Two consequences to handle in the UI when no group is configured: (1) hide the
privileged write controls and show a "an admin must configure the … group"
notice; (2) keep the group-selection settings reachable by a **hub admin**
(`window.__IS_ADMIN`), not gated behind the privileged role itself — otherwise no
one can ever appoint the first group (bootstrap deadlock).

**Test it.** Every gate fronting a privileged table must satisfy the shared
contract in `__tests__/helpers/privileged-gate.mjs` — call
`testPrivilegedGateContract` from your `logic.test.mjs`. It asserts the gate
returns `false` for the unconfigured and dangling-group cases, which is exactly
the divergence that shipped broken in document-library / amenity-reservations /
architectural-review (fixed 2026-06-28). A single-sided unit test that asserts
the *wrong* contract will pass while the app is broken — the helper pins the
client gate to the hub's actual behavior.

### `publishes` / `alert_on` require an actual endpoint call

Declaring these fields in `manifest.json` does not cause events to be emitted — your code must call the events endpoint after the action. A manifest with `publishes: ["survey.closed"]` but no `publishEvent` call after the status UPDATE means the integration is silently non-functional.

## Column encryption and `db_plaintext_columns`

The hub encrypts most string columns at rest before writing them to the database. This protects sensitive user content (names, notes, titles) if the underlying storage is ever compromised.

### What is already plaintext (never encrypted)

The hub skips encryption automatically for:

- Columns whose name ends in `_id` — foreign keys and member references
- Columns whose name ends in `_at` — timestamps (`created_at`, `updated_at`, etc.)
- Columns whose name ends in `_by` — actor columns (`created_by`, `done_by`)
- A fixed set of well-known columns: `id`, `household_id`, `completed`, `all_day`, `status`, `type`, `category`, `week`, `emoji`, `icon`, `position`, `sort_order`, `pinned`, `key`, `version`

These columns can be safely used in `WHERE` filters and `ORDER BY` clauses in SQL.

### The problem with encrypted columns

Columns that fall outside the list above are stored as ciphertext. That means:

- `WHERE my_col = ?` will never match — the param is plaintext but the stored value is ciphertext
- `ORDER BY my_col` produces an arbitrary order, not the string order you expect
- `CASE my_col WHEN 'breakfast' THEN 1 ...` never matches any branch

If your app has enum or date columns you need to filter or sort on in SQL, declare them as plaintext.

### `db_plaintext_columns`

Add this field to `manifest.json` to opt specific columns out of encryption for your app:

```json
{
  "storage": "db",
  "db_plaintext_columns": ["slot", "plan_date"]
}
```

Column names are matched case-insensitively. The list is app-scoped — it does not affect other apps that happen to have columns with the same name.

**When to use it:**

- Fixed enum columns used in `WHERE` or `ORDER BY` (e.g. `slot`, `status` if your app's `status` values differ from the global `status` skip)
- Date columns that don't end in `_at` (e.g. `plan_date`, `due_date`, `birth_date`) — these are never sensitive and must be comparable in SQL
- Any column you need to compare against a literal value in SQL

**When not to use it:**

- Free-text fields entered by the user (names, notes, titles, messages) — these should remain encrypted
- Columns that are only ever read back whole and displayed, never filtered or sorted

### `db_encryption`

Use this manifest field only when the app's own D1 data does not need app-layer encryption at all:

```json
{
  "storage": "db",
  "db_encryption": "off"
}
```

Omitting the field, or setting it to `"default"`, keeps the normal encrypt-on-write behavior. Setting `"off"` stores app-owned D1 values as plaintext; D1 is still encrypted at rest by Cloudflare, but raw D1 rows are readable to anyone with direct DB access. Use this for low-sensitivity apps where SQL filtering, sorting, indexes, and debugging matter more than app-layer confidentiality. Do not use it for messages, locations, health, finance, ballots, relationship data, documents metadata, or other private household content.

Prefer `db_plaintext_columns` when only a few enum/date/lookup columns need to be queryable. Prefer `db_encryption: "off"` only when the entire app database is intentionally non-sensitive.

**Backward compatibility:** Rows inserted before a column was added to `db_plaintext_columns` have their value stored encrypted. The hub decrypts them correctly on read (it checks each value before decrypting), so old and new rows coexist safely. SQL-level filters and ordering will only work for rows inserted after the column was declared plaintext.

## Household-local dates (`:today`)

Three manifest surfaces let you write a `:today` token into SQL — `agenda`
sources, `glance` sources, and `kiosk_checklist` filters — and it means the same
thing in all of them:

> `:today` is the **household's local calendar date** as `yyyy-mm-dd`, resolved
> from the household's configured timezone and bound as a query parameter.

It is never string-interpolated, and it is never UTC.

That last part matters more than it looks. Your app writes date columns from the
**user's device clock** — `new Date().getFullYear()/getMonth()/getDate()`, or a
`<input type="date">` value the user picked while standing in their kitchen. If
a hub surface compared those against UTC instead, it would stop matching today's
rows from roughly 6pm onward everywhere in the Americas, and before ~9am east of
UTC. This is not hypothetical: the kiosk checklist lane shipped with
`date('now')` on 2026-07-18 and emptied the bedtime-routine tiles every evening,
which is the one time of day anybody looks at them.

So, when you write date-anchored SQL:

- **Use `:today`** rather than SQLite's `date('now')`, `CURRENT_DATE`, or
  `datetime('now')`. Those are UTC and will disagree with your own stored rows.
  (`datetime('now')` is fine for *stamping* a row — it's only comparisons
  against user-entered dates that break.)
- **Store the date the user meant.** Build `yyyy-mm-dd` from local getters, not
  `toISOString().slice(0, 10)` — the latter is UTC and shifts the date for half
  the day.
- **Keep the compared column plaintext** (list it in `db_plaintext_columns`).
  Encrypted columns use a random IV, so `encrypted_col = :today` never matches.

Surfaces that need a *day count* ("12 days until Disney") send the **target
date** to the client and let the device subtract. That way the number reflows at
the viewer's own midnight without the hub's cached payloads having to be busted.

## Coherence checklist (every app, at creation)

The hub reads as one product only when each app plugs into the shared,
cross-app surfaces. Before an app ships, decide each of these five — declare
it, or record why it doesn't fit. Silence is treated as unfinished work, not
as a decision:

1. **`agenda`** — does the app hold anything time-shaped a family should see
   on Today? (See "Today view" below.)
2. **`glance`** — is there one number/line worth a home-strip card? (See
   "Glance widgets" below.)
3. **`publishes`** — which of the app's state changes matter to *other* apps?
   Publish catalogued events for them (see "Events API").
4. **`automation_actions` / `suggested_automations`** — can another app's
   event usefully write here, or should this app's events drive a starter
   automation? Suggestions power the post-install "Connect your apps" sheet,
   so a good one is free onboarding.
5. **`searchableFields`** in `src/logic.js` — the per-app search convention
   (see "Adding search to an app").

Coverage is measured: `npm run coverage:apps` in the hub repo
(`scripts/coverage-report.mjs`) reports every catalog app's declarations, and
deliberate non-fits belong in `scripts/coverage-na.json` with a one-line
reason ("no time-shaped data", "anchor columns are encrypted, due-today is
inexpressible"). An app with an unexcused gap shows up on that report until
someone either builds the surface or writes the reason down.

## Automation actions (`automation_actions`)

An action is a small declarative write recipe the hub runs on your app's behalf
when another app's event fires. Your app ships no server code: the dispatcher
generates the SQL from validated identifiers, and 1–3 ordered steps are allowed
per action (`lookup`, `insert`, `increment`).

Things that are easy to get wrong:

- **Every `:param` a step references must resolve, or the whole run is skipped**
  (recorded as `skipped_missing`). That makes an *optional* `member` param
  unusable in an insert — an unmapped one resolves to nothing and an empty
  string fails the roster check, so every run would skip. Make member params
  `required`, or split the recipe into two actions.
- **Any column compared in SQL must be plaintext.** That covers a `lookup`/
  `increment` WHERE, the `dedupe` column, and an upsert's conflict columns. At
  rest, encryption is AES-GCM with a random IV, so an equality against an
  encrypted column matches nothing — silently and forever.
- **Give the action a dedupe column** (`source_event_id`, nullable, added in a
  migration) and write `$event_id` into it. Without it a retry re-applies the
  event.

Value expressions: `:name`, `-:name`, `$uuid`, `$now`, `$now_plus_days(:name)`,
`$event_id`, `$normalize(:name)`, or a literal. Use `$now_plus_days` for
anything with an expiry — a rule is configured once and fires for months, so a
literal date would expire every row it ever writes on the same day.

**Current-value tables (one row per member) use the upsert form.** `increment`
only adds to a number, and a plain insert collides after the first write:

```json
{
  "op": "insert",
  "table": "statuses",
  "values": { "member_id": ":member_id", "status": ":status", "updated_at": "$now" },
  "on_conflict": { "columns": ["member_id"], "update": ["status", "updated_at"] }
}
```

`update` is an explicit list, not "everything in `values`": such a table usually
holds columns the triggering event knows nothing about (a denormalized display
name, the member's own note), and an overwrite-all upsert would blank them on
every run. Columns outside the list keep whatever the row already holds.

`suggested_automations` belong on the **target** app — the hub only surfaces a
suggestion when the target is installed *and* some installed app publishes the
trigger event. Check the trigger's real payload before mapping fields: several
apps publish only `{ title }`, and milestone-style events carry the member in
`subject_id` rather than the payload (`{ "kind": "subject_id" }`).

The hub does **not** check your action's tables and columns against your
migrations — a renamed column fails only when a rule fires in a real household.
Add a test that walks `automation_actions` against `migrations/*.sql` (see the
`automation_actions match the migrations` block in `tasks`, `calendar`,
`points-recognition`, `announcements`, or `status-board`).

## Today view (`agenda`)

The hub has one chronological **Today** view (a dashboard section plus a `/today`
page) that merges hub-native sources — synced calendar, tasks, date-reminder
occurrences — with rows contributed by installed apps. Your app opts in by
declaring an `agenda` field (a sibling of `glance`): one governed SELECT that
returns today's rows. Apps that don't declare it are never fanned out to.

> **Naming note:** this is the manifest `agenda` *field*, unrelated to the
> meetings app whose id happens to be `agenda`.

```json
{
  "storage": "db",
  "db_plaintext_columns": ["plan_date", "slot"],
  "agenda": {
    "kind": "meal",
    "source": {
      "kind": "sql",
      "query": "SELECT id AS id, meal_name AS title, slot AS subtitle, plan_date AS when_at, assigned_to AS member_id FROM app_family_meals__meal_plan WHERE plan_date = :today ORDER BY CASE slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END LIMIT 10"
    }
  }
}
```

Rules (all enforced at publish time by `node build.mjs` / the hub, so a broken
agenda fails to install rather than silently showing nothing):

- **Single read-only SELECT over your own `app_{id}__` tables**, with a
  `LIMIT` between 1 and 20. No JOINs to other apps' tables, no writes.
- **Required output aliases:** `title` and `when_at`. `when_at` is an ISO
  datetime, a `yyyy-mm-dd` (all-day), or a bare date. Optional aliases:
  `member_id`, `done` (0/1 or a boolean expression), `subtitle`, and a per-row
  `kind`.
- **Day tokens:** `:today` (household-local `yyyy-mm-dd`), `:day_start` /
  `:day_end` (ISO instants bounding the local day). The hub binds them as
  parameters — never string-interpolated.
- **`:me` — the requesting member's id.** Available in `agenda` and `glance`,
  bound the same way. **Reach for it only when the row policy genuinely can't
  answer "is this row mine".** An `owner_only` or `sealed_until` table already
  scopes its rows to the caller, so `:me` there is redundant. It earns its place
  on a table scoped to a *pair* or a *party* (`couple_scoped`, `party_scoped`),
  where the policy correctly shows both people the same rows and only a column
  comparison says which of them it is addressed to — sea-battle's
  `WHERE current_turn_id = :me` ("your move", not "a game exists"), love-notes'
  `WHERE recipient_id = :me AND read_at IS NULL` (without it, the *sender* is
  told their own note is unread). Compare it against a plaintext member-id
  column; publish fails otherwise, for the same random-IV reason as day tokens.
  With no authenticated member (an ambient kiosk identity) `:me` binds SQL NULL,
  so the comparison matches nothing and the surface renders empty — a wall
  screen must never inherit one member's private state.
- **`:me` does not satisfy the day-token filter rule.** An agenda still has to
  filter on a day token; if your rows aren't dated, the answer is usually a
  `glance` badge rather than an agenda (see sea-battle, exquisite-corpse).
- **A day token must actually filter the query** — used in a `WHERE` or
  `JOIN ... ON` comparison (`WHERE plan_date = :today`), not merely selected or
  sorted on. A token that only appears in the SELECT list or `ORDER BY` is
  rejected, because it wouldn't narrow the scan.
- **The compared column must be plaintext.** Encrypted columns store ciphertext
  with a random IV, so `encrypted_col = :today` never matches; publish fails.
  Anchor your agenda on a `*_date`/`*_at` column or one listed in
  `db_plaintext_columns` (dates are never sensitive — see the encryption
  section above).
- **Runs under the requesting member's `row_policies`**, exactly like `/api/db`.
  A member only sees agenda rows they're allowed to see; a restricted or
  owner-scoped row never leaks into another member's Today view. The Today UI's
  per-member filter chips are presentation only — the authorization is the row
  policy. You don't need to (and can't) widen visibility here.
- `kind` (one of `event`/`task`/`chore`/`routine`/`meal`/`reminder`/`other`,
  default `other`) and optional `label` control how the row is grouped/labeled.

Apps that already declare a `calendar_events` export don't also need `agenda`
for those events — the hub merges the export into Today and de-dupes. Use
`agenda` for non-calendar rows (meals, chores, routines, assignments, etc.).

## Glance widgets (`glance`)

A `glance` is the lightweight tier of homepage widget: one governed read-only
SELECT plus a display template, rendered natively by the hub (no iframe, no app
JS). It runs through the same path as `/api/db` — your `row_policies` and column
decryption apply — and a broken glance is dropped rather than breaking the page.

```json
{
  "glance": {
    "source": {
      "kind": "sql",
      "query": "SELECT title AS title, emoji AS emoji, member_id AS member_id, due_date AS at FROM app_myapp__things WHERE done = 0 AND due_date >= :today ORDER BY at LIMIT 3"
    },
    "display": {
      "template": "list",
      "title": "title",
      "when": "at",
      "icon": "emoji",
      "owner": "member_id"
    }
  }
}
```

Templates are `stat` (one featured number), `list` (up to 5 rows), and `badge`
(a count with severity). All column fields name **output aliases** of your
query, and every one of them is checked against the query at publish time.

`list` supports two fields beyond `title`/`subtitle`/`when`:

- **`icon`** — a per-row emoji column, rendered beside the title.
- **`owner`** — the owning member's id. This is consumed by *ambient* surfaces
  only: a kiosk applies its per-device hidden-member list to the rows before
  rendering, so a screen in a shared room can drop one person's entries. Rows
  with no owner value are hidden whenever any member is hidden (fail closed).
  It is **not** a substitute for a row policy — the query still runs under the
  caller's policy auth.

### Ambient cards (`ambient_card`)

A glance can additionally be promoted to a large, read-from-across-the-room card
on kiosk screens. Declare it on the glance, not on a separate lane, so the card
and the homepage widget stay one query:

```json
{
  "glance": {
    "source": { "kind": "sql", "query": "... ORDER BY at LIMIT 3" },
    "display": { "template": "list", "title": "title", "when": "at", "icon": "emoji", "owner": "member_id" },
    "ambient_card": "countdown"
  }
}
```

`"countdown"` is currently the only kind. It requires the `list` template and a
`when` column holding a **`yyyy-mm-dd` target date** — not a day count, not a
timestamp. The device does the day math against its own clock (see the
`:today` section above for why). `icon` supplies the glyph; `owner` enables the
per-device member hiding described above.

The card is still opt-in per device — an admin enables "Count down to upcoming
dates" on each kiosk — so declaring this only makes your app *eligible*. When
the card renders, the hub removes your app's ordinary glance tile from that
screen so the same dates don't appear twice.

## Kiosk checklist (`kiosk_checklist`)

The second PIN-free kiosk lane (alongside `kiosk_quick_add`): a tap-to-complete
checklist. The only write it can perform is flipping **one existing row** between
your declared pending and done values — it cannot insert, edit, or delete.

```json
{
  "kiosk_checklist": {
    "table": "run_steps",
    "label": "Routines",
    "title_column": "title_snapshot",
    "icon_column": "icon_snapshot",
    "sort_column": "sort_order",
    "member_column": "assigned_member_id",
    "timer_column": "timer_minutes",
    "done_by_id_column": "completed_by_member_id",
    "completed_at_column": "completed_at",
    "status": { "column": "status", "done_value": "done", "pending_value": "pending" },
    "parent": {
      "table": "runs",
      "fk_column": "run_id",
      "title_column": "title_snapshot",
      "filter": [
        { "column": "status", "equals": "active" },
        { "column": "run_date", "equals": ":today" }
      ]
    },
    "display": "tiles",
    "authorization": "avatar",
    "audit": "member"
  }
}
```

### Fields

- **`table` / `title_column` / `status`** — required. `status.done_value` and
  `status.pending_value` default to `1`/`0`.
- **`filter`** (and `parent.filter`) — equality conditions ANDed into both the
  read and the toggle. `equals: ":today"` binds the household-local date; see
  the `:today` section. Anchor it on a plaintext column.
- **`member_column`** — makes the surface per-member. With it, the hub scopes
  reads and writes to the acting member *in addition to* your row policy.
- **`parent`** — join one parent row for grouping/filtering (e.g. today's active
  run). The parent's row policy must be read-open (`adult_writable` with no
  `member_read_column`/`column_read_acls`, or ungoverned); anything narrower is
  rejected at publish time rather than failing every tap at runtime.
- **`display`** — `"list"` (default) or `"tiles"` (full-screen emoji tiles for
  pre-readers).
- **`authorization`** — `"ambient"` (no identity; household-wide lists),
  `"avatar"` (a PIN-free "tap your face" session — the pre-reader path), or
  `"member"` (a full PIN escalation). An avatar session can never satisfy a
  `"member"` lane.
- **`done_by_id_column` / `done_by_name_column` / `completed_at_column`** —
  stamped on completion, cleared on undo.
- **`timer_column`** — minutes; renders a per-tile countdown ring.
- **`audit`** — `"member"` records who tapped; `"none"` disables the write-audit
  entry.

### Rules

- The lane is **off until an admin opts your app in per device**, and an app
  with `kiosk: "never"` cannot declare one.
- Row policies remain the authorization boundary. A per-member table that is
  `owner_only` fails closed for the ambient identity — that's why an avatar lane
  shows a "tap your face" rail instead of items, which is the intended flow
  rather than a limitation to route around.
- Every referenced table and column is checked against your migrations at
  publish time.

## Kiosk quick-add (`kiosk_quick_add`)

Shared-device **kiosk** mode has exactly one PIN-free write lane: a card your app
can offer for appending a text row (a grocery item, an inbox task) or flipping a
done flag, without unlocking the kiosk to a member. Declaring the field is only
an *offer* — writes happen solely on kiosk devices whose admin both allowlisted
the app **and** opted it into quick-add (per-device, default off).

The hub builds every statement itself from your column declarations — no client
SQL — and runs them through the governed app-db path under the ambient (or, after
PIN escalation, the member's) `row_policies`. A row-policied target table fails
**closed** for the ambient identity rather than accepting an anonymous write.

```json
{
  "storage": "db",
  "db_encryption": "off",
  "kiosk_quick_add": {
    "table": "items",
    "label": "Grocery list",
    "text_column": "name",
    "actions": ["add", "toggle"],
    "normalized_column": "name_normalized",
    "done_column": "checked",
    "done_by_name_column": "checked_by_name",
    "attribution": { "id_column": "added_by_id", "name_column": "added_by_name" },
    "created_at_column": "created_at"
  }
}
```

### Fields

- `table` (required) — UNPREFIXED table the lane writes to.
- `label` (required, ≤ 80 chars) — the card heading on the kiosk.
- `text_column` (required) — column holding each row's typed text.
- `actions` (required, 1–2, no duplicates) — `["add"]` and/or `"toggle"`.
  `add` appends a row; `toggle` flips `done_column`.
- `normalized_column` (optional) — a column you store `lower(trim(text))` into
  **with a UNIQUE constraint**. When set, adds dedup on conflict instead of
  erroring. On an **add-only** lane a conflict is a no-op *reported* as a
  duplicate. On a **toggle** lane, re-adding a value that matches a *completed*
  row **revives** that row (flips `done_column` back to `0`, clears
  `done_by_name_column`, refreshes `created_at_column`) so a checked-off item
  returns to the active list as one clean row — an active duplicate is still a
  no-op. This is why a toggle lane doesn't need (and shouldn't add) a
  kiosk-side delete: check off items during use, revive them by re-adding, and
  prune with a "clear done" action **in the full app** (the kiosk can't clear).
  Because the whole item lingers until cleared, the UNIQUE index is global; if
  you'd rather completed items not block re-adds at all, use a partial index
  (`... WHERE done = 0`) instead — but then a re-add makes a *second* row rather
  than reviving the first, so prefer the revive behavior above.
- `done_column` (required when `actions` includes `toggle`) — the integer `0`/`1`
  flag the toggle flips atomically.
- `done_by_name_column` (optional, requires `done_column`) — stamped with the
  actor's display name while done, cleared on undo.
- `attribution` (optional) — `{ id_column, name_column }` stamped on add:
  `id_column` gets `kiosk:{deviceId}` (or the escalated member's id), `name_column`
  gets the device (or member) display name. Attribution on the app row is separate
  from the audit trail below.
- `created_at_column` (optional) — stamped `datetime('now')` on add.
- `authorization` (optional) — `"ambient"` (default) lets the unattended device
  use the lane; `"member"` hides the card until a member PIN-escalates the kiosk
  and rejects ambient writes. Use it for anything that shouldn't be writable by a
  walk-up.
- `audit` (optional) — controls the **content-free** entry the hub writes to the
  household write-audit trail on each successful add/toggle. `"device"` (default
  behavior) records the device id; `"member"` also records the escalated member's
  id and **requires** `authorization: "member"`; `"none"` disables it. The typed
  text and actor display name are never in the audit — app rows can stay anonymous
  while operators keep a capability trail.
- `max_items` (optional, 1–50, default 20) — rows returned on a toggle-capable
  card. The hub separately caps a kiosk to 4 quick-add apps and 80 returned items
  total, divided across toggle lanes.

### Encryption

When `db_encryption` is not `"off"`, only the columns the lane **computes in SQL**
must be plaintext (a built-in skip suffix or listed in `db_plaintext_columns`):
`normalized_column`, `done_column`, `done_by_name_column`, and `created_at_column`.
`text_column` and the `attribution` columns are ordinary bound values / whole-column
reads, so they may stay encrypted. Publish fails if a SQL-computed column is
encrypted — a `lower(trim())` dedup or `done = 1` flip against ciphertext silently
matches nothing.

### Rules enforced at publish

- `done_column` is required whenever `actions` includes `toggle`;
  `done_by_name_column` requires `done_column`; `audit: "member"` requires
  `authorization: "member"`.
- The `table` and every referenced column must exist in your migrations, and
  `normalized_column` must carry a UNIQUE constraint (both checked against the
  migration schema).
- An app whose manifest sets `kiosk: "never"` cannot declare a lane.

## AI access (MCP)

Apps are **invisible to AI clients by default**. Opt in explicitly — this is intentional: private apps (couples apps, therapy notes, etc.) should never appear in AI tool listings.

Add `ai_access` to your manifest to enable MCP access:

```json
{
  "ai_access": {
    "allowed": true,
    "mode": "read"
  }
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `allowed` | boolean | `false` | Master switch. Must be `true` for any MCP access. |
| `mode` | `"read"` \| `"read_write"` | `"read"` | `"read"` allows `get_app_data` only. `"read_write"` also allows `set_app_data`. |
| `db_exports` | `string[]` | `[]` | Named SELECT queries exposed via `query_app_db`. DB-storage apps only. |
| `db_mutations` | `string[]` | `[]` | Named UPDATE mutations exposed via `mutate_app_db`. UPDATE-only, no INSERT or DELETE. DB-storage apps only. |
| `db_inserts` | `string[]` | `[]` | Named INSERT operations exposed via `insert_app_db`. Each requires a JSON Schema file for param validation. DB-storage apps only. |
| `requires_admin_approval` | boolean | `false` | If true, the hub admin must explicitly grant AI access after install. |

### KV apps — reading and writing via MCP

With `allowed: true` and `mode: "read"`, an AI client can read any key from your app's KV store via the `get_app_data` tool. With `mode: "read_write"`, it can also write via `set_app_data`.

```json
{
  "ai_access": {
    "allowed": true,
    "mode": "read_write"
  }
}
```

KV access goes through the normal MCP tool layer — no additional app-side work needed.

### DB apps — named query exports

DB-storage apps cannot be queried with raw SQL via MCP. Instead, declare named SELECT queries in `ai_access.db_exports` and put the SQL files in `src/queries/`:

```json
{
  "storage": "db",
  "ai_access": {
    "allowed": true,
    "mode": "read",
    "db_exports": ["open_tasks", "overdue_tasks", "task_summary"]
  }
}
```

Each name maps to `src/queries/{name}.sql`. The build script includes everything under `src/` in the bundle, so these files are automatically packaged and served.

**Query file conventions:**

- Files must be `SELECT` or `WITH ... SELECT` statements — the hub rejects anything else
- **No semicolons anywhere**, not even a trailing one. The hub enforces
  single-statement by rejecting the character outright
- **Fully qualify your tables** with the `app_{appId}__` prefix, exactly as in
  your migrations and your app SQL. Named SQL runs through the same
  `executeAppSql` path as `/api/db`, which rejects any reference to a table
  outside your app's prefix
- **No `household_id` filter** — there is no such column, and no need for one
  (see the DB helper section). Each household is a separate D1 database
- Include `LIMIT` to bound result size
- **No caller-supplied parameters.** `query_app_db` passes an empty params
  array, so a named query is a fixed SELECT. (Mutations, inserts, and deletes
  *do* take positional `$1`, `$2`, … params from the caller.)
- `:today` is available, and binds the **household-local** calendar date — see
  "Household-local dates" above. It works in every named-SQL kind, and it is the
  only correct way to write a date-anchored named query; `date('now')` is UTC
- **Row policies still apply**, which constrains query shape — see "Named AI
  queries (`ai_access`) obey the same row policies" above. A `JOIN` is fine
  against ungoverned tables (the example below) but fails closed against a
  governed one
- **The hub's SQL grammar is narrower than SQLite's.** The hub parses every
  statement with its own parser (node-sql-parser) before executing it, and that
  parser rejects some perfectly valid SQLite. A statement that only SQLite
  accepts dies at runtime with `Could not parse SQL`, even though it prepares
  fine locally. Known-rejected constructs — avoid all of these in `queries/*.sql`,
  `manifest.preload`, and every statement your app posts to `/api/db`:
  - `NULLS LAST` — sort nulls last with a leading `(col IS NULL)` term instead
  - `CROSS JOIN ... ON` — use `JOIN ... ON` or a comma join
  - Window functions (`OVER (...)`)
  - `FILTER (WHERE ...)` on aggregates — use `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`
  - `EXCEPT` (and bare `VALUES` lists as statements)
  - `IS NOT DISTINCT FROM` — spell out the null-safe comparison
  - `INDEXED BY`
  - Reserved words as column aliases: `COUNT(*) AS count` is rejected — pick a
    name like `AS total` or `AS vote_count`

  Safely inside the accepted subset: comma joins, `LEFT JOIN`, CTEs
  (`WITH ... SELECT`), `UNION ALL`, correlated subqueries, subqueries in `FROM`,
  `CASE` (including in `ORDER BY`), `GROUP BY`/`HAVING`, `json_extract`, `IIF()`,
  `LIMIT`/`OFFSET`. The contract gate runs your declared reads through the hub's
  actual parser, so a rejected construct fails your release rather than
  production — but SQL your app posts at runtime is only checked at runtime,
  so stay inside the subset there too

Example (`src/queries/open_tasks.sql`) — the real file from the `tasks` app:

```sql
SELECT
  t.id,
  t.title,
  t.assignee_id,
  t.due_date,
  t.priority,
  l.name AS list_name
FROM app_tasks__tasks t
LEFT JOIN app_tasks__lists l
  ON l.id = t.list_id
WHERE t.completed = 0
ORDER BY
  (t.due_date IS NULL),
  t.due_date,
  t.priority DESC
LIMIT 200
```

### DB apps — named INSERT operations

AI INSERT access requires an additional validation layer because the AI client supplies the data values. Each named insert has two bundle files:

**`src/inserts/{name}.sql`** — the INSERT SQL. User-supplied params use `$1`, `$2`, etc. System values are generated by **SQLite** built-ins — never rely on the AI client to supply ids or timestamps. This is the real `grocery` insert:

```sql
INSERT INTO app_grocery__items (
  id,
  name,
  name_normalized,
  added_by_id,
  added_by_name,
  checked,
  created_at
) VALUES (
  lower(hex(randomblob(16))),
  $1,
  lower(trim($1)),
  'ai',
  'AI',
  0,
  datetime('now')
)
ON CONFLICT (name_normalized) DO NOTHING
```

`lower(hex(randomblob(16)))` is the id idiom (SQLite has no `gen_random_uuid()`),
and `datetime('now')` is the timestamp idiom. `datetime('now')` is UTC, which is
fine for *stamping* a row — but never for comparing against a user-entered date;
use `:today` for that (see "Household-local dates").

**`src/schemas/{name}.json`** — JSON Schema (draft-07) describing the user-supplied params array. The hub validates params against this schema before executing the SQL:

```json
{
  "type": "array",
  "items": [
    { "type": "string", "minLength": 1, "maxLength": 200, "description": "item name" }
  ],
  "minItems": 1,
  "maxItems": 1
}
```

Declare in the manifest:
```json
"ai_access": {
  "allowed": true,
  "mode": "read_write",
  "db_inserts": ["add_item"]
}
```

**Table constraints are your second validation layer.** JS validation in the app
front-end enforces business rules at runtime, but AI inserts bypass the
front-end. Push those rules into the schema so both paths enforce them:

```sql
-- Declared INLINE in CREATE TABLE, in the migration that creates the table.
CREATE TABLE IF NOT EXISTS app_myapp__tasks (
  id       TEXT NOT NULL PRIMARY KEY,
  title    TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  list_id  TEXT NOT NULL REFERENCES app_myapp__lists(id) ON DELETE CASCADE
);
```

Two SQLite realities to plan for:

- **There is no `ALTER TABLE ... ADD CONSTRAINT`.** SQLite cannot bolt a CHECK or
  a foreign key onto an existing table, and migrations are additive-only (no
  table rebuild), so a constraint you didn't declare at `CREATE TABLE` time can
  never be added to households that already installed the app. Get them right in
  `001_init.sql`.
- **A string `CHECK (col IN ('a','b'))` on an encrypted column is a dead app.**
  The stored value is ciphertext (`v1:<iv>:<tag>:<ct>`), never one of the listed
  literals, so every INSERT touching that column fails. The hub now lints for
  this at publish time and rejects the bundle; it shipped twice before the lint
  existed. Numeric allow-lists (`CHECK (flag IN (0,1))`) are safe — numbers are
  the one shape the codec never encrypts. For a string enum, add the column to
  `db_plaintext_columns`.
- **A string literal a migration WRITES into an encrypted column is stored
  plaintext.** Migrations run outside the app-db codec, so
  `INSERT … VALUES ('seed', 'Automations')`, `UPDATE … SET note = '[]'` and
  `kind TEXT DEFAULT 'meeting'` all land in the clear, while every runtime write
  of the same column stores ciphertext — the column then holds both encodings
  and nothing reports it. The hub lints for this at publish time. Legal:
  column-to-column copies (including via subquery), numeric literals, `''`, a
  literal that only chooses the row (a subquery's `WHERE`, a `CASE WHEN …`
  condition), and `DEFAULT ''` / `DEFAULT '[]'` / `DEFAULT '{}'`. To keep a
  knowingly-plaintext value (a seed row, a sentinel), annotate the migration
  with a reason — the annotation is scoped to that migration file:

  ```sql
  -- cb:plaintext-literal <table>.<column> — why this value is knowingly plaintext
  ```

  The bare `<column>` form is accepted but covers ONE table; if the same column
  name takes a literal on two tables in one migration, qualify both. A
  low-entropy enum or colour is usually better off in `db_plaintext_columns`.

**SQL file rules (enforced by hub at runtime and tested by CI):**
- Must start with `INSERT`
- **No semicolons anywhere**, including a trailing one
- Tables must carry the `app_{appId}__` prefix — named SQL runs through the same
  scoping guard as `/api/db`
- User params are positional (`$1`, `$2` — max 50) and are validated against the
  schema file before the SQL runs
- System values always come from SQLite built-ins:
  `lower(hex(randomblob(16)))` for ids, `datetime('now')` for timestamps
- Include `ON CONFLICT DO NOTHING` or `DO UPDATE` where duplicates are possible
  (the conflict target must be a real UNIQUE index on plaintext columns)

**Schema file rules:**
- Must be valid JSON Schema (draft-07)
- Use `items` (array form) for tuple/positional validation, not `prefixItems`
- Declare `minItems` and `maxItems` to match the SQL param count
- Add format constraints (`pattern`, `minLength`, `maxLength`, `minimum`, `maximum`) to catch bad input before it reaches the DB

### Privacy and admin overrides

- Apps with no `ai_access` field (or `allowed: false`) are completely invisible to MCP clients — they do not appear in `list_apps` results and their data cannot be accessed
- A hub admin can set `disabled: true` via `PATCH /api/apps/{id}/ai-access` to block MCP access for any app regardless of its manifest
- Admins cannot *enable* AI access for an app that declared `allowed: false` — only the manifest can grant it
- Consider whether your app contains sensitive content before enabling `ai_access`. Couples apps, therapy journals, and similar private apps should leave `allowed: false`
