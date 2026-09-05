import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import { canEditChild, canUncompleteItem, CHILD_ORDERS } from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
const html = readFileSync(join(root, "src/index.html"), "utf-8");

const PREFIX = "app_projects__";

// ── Parse the migrations into { table: Set<column> } ─────────────────────────
// The hub never checks a manifest's tables and columns against the migrations —
// a renamed column fails only when a rule fires in a real household. So it is
// checked here, which is the one place it can be caught before release.
const schema = (() => {
  const sql = readdirSync(join(root, "migrations"))
    .filter(f => f.endsWith(".sql")).sort()
    .map(f => readFileSync(join(root, "migrations", f), "utf-8"))
    .join("\n");
  const tables = {};
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = match;
    const columns = new Set();
    for (const rawLine of body.split("\n")) {
      const lineText = rawLine.replace(/--.*$/, "").trim();
      const column = /^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i.exec(lineText);
      if (column) columns.add(column[1]);
    }
    tables[table.slice(PREFIX.length)] = columns;
  }
  return tables;
})();

const has = (table, column) => schema[table]?.has(column) ?? false;

/** The raw migration text, for the constraints the column parse above drops. */
const migrationSql = readdirSync(join(root, "migrations"))
  .filter(f => f.endsWith(".sql")).sort()
  .map(f => readFileSync(join(root, "migrations", f), "utf-8"))
  .join("\n");

describe("checklist_completions cross-project integrity", () => {
  // The completion row carries BOTH project_id and item_id, and the row policy
  // (`inherit_visibility`) only ever looks at project_id. Nothing in the hub
  // relates the two, so without a composite key a member who can see project A
  // could insert (project_id = A, item_id = <an item of a project they cannot
  // see>). UNIQUE(item_id) then makes that row the authoritative completion for
  // the victim's item: their agenda reads it as done, they can never tick it
  // themselves, and they cannot delete the squatter's row either.
  const collapse = sql => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ");

  it("declares the composite FK that ties item_id to the same project_id", () => {
    expect(collapse(migrationSql)).toContain(
      "FOREIGN KEY (project_id, item_id) REFERENCES app_projects__checklist_items(project_id, id) ON DELETE CASCADE",
    );
  });

  it("gives checklist_items the (project_id, id) parent key that FK requires", () => {
    // SQLite rejects a composite FK whose parent columns are not a UNIQUE key,
    // so dropping this constraint breaks the guarantee above at install time.
    expect(collapse(migrationSql)).toContain("UNIQUE (project_id, id)");
  });

  it("does not ALSO carry a bare item_id foreign key that would let the pair drift", () => {
    // A plain `item_id REFERENCES checklist_items(id)` alongside the composite
    // one would be satisfied by any existing item, which is exactly the check
    // that is too weak here.
    expect(collapse(migrationSql)).not.toContain("item_id TEXT NOT NULL UNIQUE REFERENCES");
  });
});

describe("migrations", () => {
  it("creates every table the manifest governs, all app-prefixed", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "budget_items", "checklist_completions", "checklist_items", "notes", "projects",
    ]);
  });

  it("does not end a migration file with a comment", () => {
    // Everything after the final `;` is parsed as its own statement, and D1
    // answers a comment-only statement with "contains no statements" — which
    // used to make the app permanently uninstallable.
    for (const file of readdirSync(join(root, "migrations")).filter(f => f.endsWith(".sql"))) {
      const text = readFileSync(join(root, "migrations", file), "utf-8").trimEnd();
      expect(text.endsWith(";"), `${file} must end with a semicolon, not a comment`).toBe(true);
    }
  });

  it("puts a string CHECK only on columns the codec leaves plaintext", () => {
    // A CHECK against an encrypted column can never match: the stored value is
    // ciphertext with a random IV, so every INSERT touching it fails forever.
    const sql = readFileSync(join(root, "migrations/001_init.sql"), "utf-8");
    for (const [, column] of sql.matchAll(/CHECK \((\w+) IN \('/g)) {
      expect(isPlaintext(column), `CHECK on encrypted column "${column}"`).toBe(true);
    }
  });
});

// Mirrors the hub's isPlaintextAppDbColumn: built-in skips, the _id/_at/_date/_by
// suffixes, and anything the manifest lists in db_plaintext_columns.
const BUILTIN_PLAINTEXT = new Set([
  "id", "household_id", "created_at", "updated_at", "sent_at", "read_at", "expires_at",
  "last_synced_at", "completed", "all_day", "status", "type", "category", "week", "emoji",
  "icon", "source", "position", "sort_order", "pinned", "key", "version", "visibility",
  "audience", "membership_type", "membership_roles",
]);
function isPlaintext(column) {
  return BUILTIN_PLAINTEXT.has(column)
    || /_(id|at|date|by)$/.test(column)
    || (manifest.db_plaintext_columns ?? []).includes(column);
}

// ── row_policies ─────────────────────────────────────────────────────────────
describe("row_policies", () => {
  it("governs every table — an ungoverned one is readable and writable by anyone", () => {
    expect(Object.keys(manifest.row_policies).sort()).toEqual(Object.keys(schema).sort());
  });

  it("names real columns", () => {
    for (const [table, policy] of Object.entries(manifest.row_policies)) {
      for (const key of ["member_column", "visibility_column", "fk_column", "writer_column"]) {
        if (!policy[key]) continue;
        const owner = key === "fk_column" || key === "writer_column" ? table : table;
        expect(has(owner, policy[key]), `${table}.${policy[key]} (${key})`).toBe(true);
      }
    }
  });

  it("compares only plaintext columns — the hub cannot filter ciphertext", () => {
    for (const policy of Object.values(manifest.row_policies)) {
      if (policy.visibility_column) expect(isPlaintext(policy.visibility_column)).toBe(true);
    }
  });

  it("points every inherit_visibility child at a parent with a compatible policy", () => {
    const COMPATIBLE = ["owner_only", "owner_only_with_fk_check", "owner_or_visibility"];
    for (const [table, policy] of Object.entries(manifest.row_policies)) {
      if (policy.kind !== "inherit_visibility") continue;
      const parent = manifest.row_policies[policy.parent_table];
      expect(parent, `${table} parent ${policy.parent_table} has no policy`).toBeTruthy();
      expect(COMPATIBLE).toContain(parent.kind);
      expect(has(table, policy.fk_column)).toBe(true);
    }
  });

  it("declares every visibility value the schema's CHECK allows", () => {
    // A value the CHECK permits but no policy list mentions is a row nobody but
    // its owner can ever see — a silent black hole rather than an error.
    const policy = manifest.row_policies.projects;
    const declared = new Set([...policy.everyone_values, ...policy.adult_values, "private"]);
    expect([...declared].sort()).toEqual(["adults", "everyone", "private"]);
  });
});

// ── member_references / cascades / files ─────────────────────────────────────
describe("member_references, cascades and file columns", () => {
  const asList = (entry) => (Array.isArray(entry) ? entry : [entry]);

  it("names real tables and columns", () => {
    for (const [table, entry] of Object.entries(manifest.member_references)) {
      expect(schema[table], `member_references table ${table}`).toBeTruthy();
      for (const ref of asList(entry)) {
        expect(has(table, ref.column), `${table}.${ref.column}`).toBe(true);
        if (ref.only_when) expect(has(table, ref.only_when.column)).toBe(true);
      }
    }
  });

  it("cascades every child table when a project is deleted", () => {
    const cascaded = manifest.delete_cascades.projects.map(c => c.table).sort();
    expect(cascaded).toEqual(["budget_items", "checklist_completions", "checklist_items", "notes"]);
    for (const { table, foreign_key } of manifest.delete_cascades.projects) {
      expect(has(table, foreign_key)).toBe(true);
    }
  });

  it("declares the file-list column on both delete and update", () => {
    // Declaring it on delete alone leaks the blob when a photo is swapped out.
    expect(manifest.delete_file_list_columns.projects).toEqual(["file_ids"]);
    expect(manifest.update_file_list_columns.projects).toEqual(["file_ids"]);
    expect(has("projects", "file_ids")).toBe(true);
  });
});

// ── preload ──────────────────────────────────────────────────────────────────
describe("preload mirrors the app's LOCAL_READS", () => {
  const block = html.match(/const LOCAL_READS = (\{[\s\S]*?\n\});/);

  it("is parseable as JSON, in the same keys and order as the manifest", () => {
    expect(block, "LOCAL_READS block not found in src/index.html").toBeTruthy();
    const localReads = JSON.parse(block[1]);
    expect(Object.keys(manifest.preload)).toEqual(Object.keys(localReads));
    for (const [name, sql] of Object.entries(localReads)) {
      expect(manifest.preload[name], name).toEqual({ sql });
    }
  });

  it("keeps every read bounded — these run on every launch, for every household", () => {
    for (const [name, { sql }] of Object.entries(manifest.preload)) {
      expect(sql, name).toMatch(/\bLIMIT \d+$/);
    }
  });

  it("scopes governed tables through a top-level JOIN, never a subquery", () => {
    // The row-policy rewriter rewrites governed tables named at the top level
    // and fails closed on one reachable only from inside a subquery.
    for (const [name, { sql }] of Object.entries(manifest.preload)) {
      expect(sql.includes("SELECT", 6), `${name} has a nested SELECT`).toBe(false);
    }
  });
});

// ── agenda / glance ──────────────────────────────────────────────────────────
describe("agenda and glance", () => {
  const dayTokenColumn = /(\w+)\s*=\s*:today/;

  it("compares the day token against a plaintext column", () => {
    // An encrypted column stores ciphertext under a random IV, so `col = :today`
    // matches nothing and the surface renders silently empty forever.
    const match = dayTokenColumn.exec(manifest.agenda.source.query);
    expect(match, "agenda must filter on :today").toBeTruthy();
    expect(isPlaintext(match[1].replace(/^\w+\./, ""))).toBe(true);
  });

  it("reads only this app's tables", () => {
    for (const query of [manifest.agenda.source.query, manifest.glance.source.query]) {
      for (const [, table] of query.matchAll(/(?:FROM|JOIN)\s+(\w+)/g)) {
        expect(table.startsWith(PREFIX), table).toBe(true);
      }
    }
  });

  it("orders the countdown card by a real yyyy-mm-dd column", () => {
    // ambient_card "countdown" needs `when` to be a target DATE; a timestamp or
    // a day count renders as nonsense on the kiosk.
    expect(manifest.glance.ambient_card).toBe("countdown");
    expect(manifest.glance.display.template).toBe("list");
    expect(has("projects", "target_date")).toBe(true);
  });
});

// ── automations ──────────────────────────────────────────────────────────────
describe("automation_actions match the migrations", () => {
  it("writes only real tables and columns", () => {
    for (const [name, action] of Object.entries(manifest.automation_actions)) {
      for (const step of action.steps) {
        expect(schema[step.table], `${name} → ${step.table}`).toBeTruthy();
        for (const column of Object.keys(step.values ?? {})) {
          expect(has(step.table, column), `${name} → ${step.table}.${column}`).toBe(true);
        }
      }
      expect(has(action.dedupe.table, action.dedupe.column)).toBe(true);
      // The dedupe column is compared in SQL, so ciphertext would never match
      // and every retry would re-apply the event.
      expect(isPlaintext(action.dedupe.column)).toBe(true);
    }
  });

  it("supplies every NOT NULL column that has no default", () => {
    const insert = manifest.automation_actions.create_project.steps[0];
    for (const column of ["id", "name", "created_by", "created_at", "updated_at"]) {
      expect(Object.keys(insert.values)).toContain(column);
    }
  });

  it("maps every required param of the action a suggestion targets", () => {
    // An unmapped required param resolves to nothing and the hub skips the whole
    // run — a suggestion that silently never fires.
    for (const suggestion of manifest.suggested_automations) {
      const action = manifest.automation_actions[suggestion.action_id];
      expect(action, suggestion.action_id).toBeTruthy();
      for (const [param, spec] of Object.entries(action.params)) {
        if (!spec.required) continue;
        expect(Object.keys(suggestion.param_map), `${suggestion.action_id}.${param}`).toContain(param);
      }
    }
  });
});

// ── events ───────────────────────────────────────────────────────────────────
describe("publishes", () => {
  it("is actually called from app code — declaring it alone does nothing", () => {
    for (const type of manifest.publishes) {
      expect(html.includes(`"${type}"`), `${type} is declared but never published`).toBe(true);
    }
  });

  it("gates every declared event with a publish_acl", () => {
    expect(Object.keys(manifest.publish_acls).sort()).toEqual([...manifest.publishes].sort());
  });

  it("uses namespaced lowercase names the hub will accept", () => {
    for (const type of manifest.publishes) {
      expect(type).toMatch(/^[a-z0-9]+([._-][a-z0-9]+)*\.[a-z0-9]+([._-][a-z0-9]+)*$/);
    }
  });
});

describe("completion is its own attributed row", () => {
  it("keeps no done_at/done_by on the item itself", () => {
    // A `done_at` column on the item could only ever be written by whoever
    // CREATED the item — `inherit_visibility` scopes UPDATE to the writer and
    // has no adult bypass — so the assignee could never tick their own task.
    expect(has("checklist_items", "done_at")).toBe(false);
    expect(has("checklist_items", "done_by")).toBe(false);
    expect(has("checklist_completions", "done_at")).toBe(true);
    expect(has("checklist_completions", "done_by")).toBe(true);
  });

  it("puts completion in a table whose writer is the person who closed it", () => {
    expect(manifest.row_policies.checklist_completions).toMatchObject({
      kind: "inherit_visibility",
      parent_table: "projects",
      writer_column: "done_by",
    });
  });

  it("allows at most one completion per item", () => {
    const ddl = migrationSql.match(/CREATE TABLE[^;]*checklist_completions[^;]*;/i)?.[0] ?? "";
    expect(/item_id\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(ddl)).toBe(true);
  });

  it("scopes the completion to a project so the row policy has a parent to inherit", () => {
    // `inherit_visibility` needs an owner-bearing parent, and checklist_items
    // is not one — so the FK the policy follows points at projects.
    expect(has("checklist_completions", "project_id")).toBe(true);
    expect(has("checklist_completions", "item_id")).toBe(true);
  });
});

describe("structural columns on projects", () => {
  it("locks created_by/created_at against UPDATE and visibility to the owner", () => {
    // write_visibility_scoped means anyone who can SEE a project may write it.
    // Without these, a member could rewrite created_by to themselves and flip
    // visibility to private, hiding a shared project from its author.
    const acls = manifest.row_policies.projects.column_write_acls;
    expect(acls.created_by).toEqual({ writable_by: [], actions: ["update"] });
    expect(acls.created_at).toEqual({ writable_by: [], actions: ["update"] });
    expect(acls.visibility).toEqual({ writable_by: ["owner"], actions: ["update"] });
  });
});

describe("the agenda reads done-ness without a subquery", () => {
  it("reaches completions through a LEFT JOIN, not an EXISTS", () => {
    // A governed table reachable ONLY from inside a subquery fails closed and
    // the whole statement is refused; a joined one is rewritten in place, with
    // the policy landing on the JOIN's ON clause so LEFT stays LEFT.
    const q = manifest.agenda.source.query;
    expect(q).toContain("LEFT JOIN app_projects__checklist_completions");
    expect(q).not.toMatch(/EXISTS|IN\s*\(\s*SELECT/i);
  });
});

describe("structural columns are immutable on every table", () => {
  const acls = t => manifest.row_policies[t].column_write_acls ?? {};
  const immutableOnUpdate = (t, col) => {
    const cfg = acls(t)[col];
    return !!cfg && cfg.writable_by.length === 0 && (cfg.actions ?? []).includes("update");
  };

  it("locks the identity and attribution columns the UI never edits", () => {
    // adults_bypass lets a supervisor UPDATE any child row of a project they can
    // see. Without these, that reaches far past the UI's intent: false
    // attribution (created_by/done_by), moving a record to another visible
    // project (project_id), or repointing which item a completion closes.
    for (const t of ["budget_items", "checklist_items"]) {
      for (const col of ["id", "project_id", "created_by", "created_at", "sort_order"]) {
        expect(immutableOnUpdate(t, col), `${t}.${col}`).toBe(true);
      }
    }
    for (const col of ["id", "created_by", "created_at", "source_event_id"]) {
      expect(immutableOnUpdate("projects", col), `projects.${col}`).toBe(true);
    }
  });

  it("forbids UPDATE outright on notes and completions", () => {
    // Neither has an edit path — a decision is retracted and re-logged, a tick
    // is undone and re-made — so every column is immutable and there is no
    // legitimate UPDATE shape left at all. Asserted against the MIGRATION's
    // column list, so a column added later without an ACL fails here.
    for (const t of ["notes", "checklist_completions"]) {
      for (const col of schema[t]) {
        expect(immutableOnUpdate(t, col), `${t}.${col} must be immutable`).toBe(true);
      }
    }
  });

  it("leaves the genuinely editable fields writable", () => {
    for (const col of ["label", "vendor_name", "estimated_cents", "actual_cents", "purchased", "updated_at"]) {
      expect(acls("budget_items")[col], `budget_items.${col}`).toBeUndefined();
    }
    for (const col of ["title", "due_date", "assignee_id", "is_milestone", "updated_at"]) {
      expect(acls("checklist_items")[col], `checklist_items.${col}`).toBeUndefined();
    }
  });
});

describe("the projects preload can use an index", () => {
  it("ships an expression index mirroring its ORDER BY term for term", () => {
    // The ORDER BY sorts on two boolean EXPRESSIONS; a plain column index
    // cannot answer one, so the planner fell back to a full scan plus a temp
    // B-tree and contract-ci failed the release.
    const order = manifest.preload.projects.sql.match(/ORDER BY (.+?) LIMIT/)[1];
    const idx = migrationSql.match(/CREATE INDEX[^;]*projects_order_idx[^;]*;/i)?.[0] ?? "";
    const norm = t => t.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();
    for (const term of order.split(",")) {
      expect(norm(idx)).toContain(norm(term));
    }
  });
});

describe("the client gates and the manifest cannot drift apart", () => {
  // The failure this closes has already happened twice on this app: a client
  // gate that grants adults, over a policy that does not. Nothing in the logic
  // tests notices, because they only ever exercise the gate — so if the flag
  // were dropped from the manifest they would stay green while every adult's
  // Edit button started coming back `changed: 0`.
  const ADULT = { id: "a1", role: "adult" };
  const CHILD = { id: "k1", role: "child" };
  const shared = {
    id: "p1", visibility: "everyone", created_by: "someone-else", completed_at: null,
  };
  const childTables = Object.entries(manifest.row_policies)
    .filter(([, p]) => p.kind === "inherit_visibility");

  it("has child tables to check", () => {
    expect(childTables.length).toBeGreaterThan(0);
  });

  it("declares adults_bypass wherever a gate lets an adult edit another member's row", () => {
    const adultMayEditOthers = canEditChild({ created_by: CHILD.id }, shared, ADULT);
    const adultMayReopenOthers =
      canUncompleteItem({ done_by: CHILD.id, item_id: "c1" }, shared, ADULT);
    if (!adultMayEditOthers && !adultMayReopenOthers) return;  // gates are writer-only: nothing to declare

    for (const [table, policy] of childTables) {
      expect(policy.adults_bypass, `row_policies.${table}.adults_bypass`).toBe(true);
    }
  });

  it("keeps the reverse true: no bypass declared without a gate that uses it", () => {
    // A flag nobody's UI relies on is a widened policy with no reason, which is
    // how a table quietly becomes adult-writable long after anyone remembers.
    const declared = childTables.filter(([, p]) => p.adults_bypass === true);
    if (declared.length === 0) return;
    expect(
      canEditChild({ created_by: CHILD.id }, shared, ADULT)
      || canUncompleteItem({ done_by: CHILD.id }, shared, ADULT),
    ).toBe(true);
  });

  it("still refuses a child on another member's row, bypass or not", () => {
    expect(canEditChild({ created_by: "someone" }, shared, CHILD)).toBe(false);
  });
});

describe("the keyset paging has indexes that cover it", () => {
  // Without the full composite key SQLite seeks to the project and then sorts
  // every one of its rows in a temp B-tree — on tables that permit 20,000 rows
  // each. EXPLAIN lives in the hub's contract runner (this repo has no sqlite),
  // so what is asserted here is the coupling: each index must name the table's
  // complete read order, in order.
  // The LAST definition wins: 002 drops and recreates these names, and reading
  // the first match would assert against the superseded 001 shape.
  const indexOn = (name) => {
    const all = [...migrationSql.matchAll(
      new RegExp(`CREATE INDEX[^;]*?${name}\\s+ON\\s+\\w+\\s*\\(([^)]*)\\)`, "gi"))];
    const last = all[all.length - 1];
    return last ? last[1].replace(/\s+/g, " ").trim() : null;
  };

  it("indexes budget and checklist on project_id + the whole ordering", () => {
    for (const t of ["budget_items", "checklist_items"]) {
      expect(indexOn(`app_projects__${t}_project_idx`), t)
        .toBe("project_id, sort_order, created_at, id");
    }
  });

  it("indexes decisions DESC to match its newest-first read", () => {
    expect(indexOn("app_projects__notes_project_idx"))
      .toBe("project_id, created_at DESC, id");
  });

  it("drops the narrower index it replaces rather than keeping both", () => {
    // Each old index is now a strict prefix of its replacement: keeping both
    // costs an extra index write per insert and buys nothing.
    for (const t of ["budget_items", "checklist_items", "notes"]) {
      expect(migrationSql, t).toContain(`DROP INDEX IF EXISTS app_projects__${t}_project_idx;`);
    }
  });

  it("matches the CHILD_ORDERS the app actually pages by", () => {
    // The coupling that matters: change the read order in logic.js and this
    // fails until the index follows.
    const expected = {
      budget_items: "project_id, sort_order, created_at, id",
      checklist_items: "project_id, sort_order, created_at, id",
      notes: "project_id, created_at DESC, id",
    };
    for (const spec of Object.values(CHILD_ORDERS)) {
      const orderCols = spec.order.replace(/\s+/g, " ").trim();
      expect(indexOn(`app_projects__${spec.table}_project_idx`), spec.table)
        .toBe(`project_id, ${orderCols}`);
      expect(indexOn(`app_projects__${spec.table}_project_idx`)).toBe(expected[spec.table]);
    }
  });
});

// ── The summary aggregates ───────────────────────────────────────────────────
//
// Every total the app states as a fact is one of these three reads. They are
// runtime statements, so nothing in the hub's admission checks sees them: the
// contract suite validates manifest SQL only. What can be checked here is that
// they name columns that exist and filter on a column an index leads with —
// the two ways a rename or a dropped index would turn them into a silent full
// scan or a runtime error. The hub's own suite runs them through the real
// rewriter for the part that matters more: that their counts respect
// visibility.
describe("SUMMARY_READS", () => {
  const reads = (() => {
    const block = /const SUMMARY_READS = \{([\s\S]*?)\n\};/.exec(html)?.[1] ?? "";
    const out = {};
    for (const [, key, sql] of block.matchAll(/(\w+):\s*"((?:[^"\\]|\\.)*)"/g)) out[key] = sql;
    return out;
  })();

  it("declares one read per counted table", () => {
    expect(Object.keys(reads).sort()).toEqual(["budget", "checklist", "notes"]);
  });

  it("names only columns the migrations really define", () => {
    const expected = {
      budget: ["budget_items", ["estimated_cents", "actual_cents", "project_id"]],
      checklist: ["checklist_items", ["project_id"]],
      notes: ["notes", ["project_id"]],
    };
    for (const [key, [table, columns]] of Object.entries(expected)) {
      for (const column of columns) {
        expect(has(table, column), `${key}: ${table}.${column}`).toBe(true);
        expect(reads[key]).toContain(column);
      }
    }
    // The checklist read joins completions on item_id, which is the column the
    // composite FK ties to its project.
    expect(has("checklist_completions", "item_id")).toBe(true);
  });

  it("sums the money columns rather than an encrypted one", () => {
    // Numbers are never encrypted; a TEXT column here would be ciphertext and
    // would SUM to zero for every household, in silence.
    for (const column of ["estimated_cents", "actual_cents"]) {
      expect(new RegExp(`^\\s*${column}\\s+INTEGER\\b`, "mi").test(migrationSql), column).toBe(true);
    }
  });

  it("mirrors budgetTotals: the real price where known, the estimate elsewhere", () => {
    // Two definitions of "committed" — one in SQL, one in logic.js — is a drift
    // waiting to happen, and the drift would show up as a total that changes
    // when a project is opened. This pins the SQL half.
    expect(reads.budget.replace(/\s+/g, " "))
      .toContain("SUM(COALESCE(actual_cents, estimated_cents))");
  });

  it("groups by a column its table's index leads with", () => {
    for (const [key, table] of [["budget", "budget_items"], ["checklist", "checklist_items"], ["notes", "notes"]]) {
      // Grouping by an unindexed column is a scan plus a temporary B-tree, on
      // a read that runs once per launch for every household.
      const index = indexOnTable(table);
      expect(index, `${key}: no index on ${table}`).not.toBe(null);
      expect(index.split(",")[0].trim()).toBe("project_id");
    }
  });

  const indexOnTable = (table) => {
    const all = [...migrationSql.matchAll(
      new RegExp(`CREATE INDEX[^;]*?ON\\s+${PREFIX}${table}\\s*\\(([^;]*?)\\);`, "gi"))];
    const last = all[all.length - 1];
    return last ? last[1].replace(/\s+/g, " ").trim() : null;
  };
});
