#!/usr/bin/env node
/**
 * Build script — reads manifest.json + src/ files (+ migrations/ for storage:"db"
 * apps) and produces dist/bundle.json.
 *
 * dist/bundle.json format:
 * {
 *   "manifest":    { ...AppManifest },
 *   "migrations":  [ { "version": 1, "sql": "CREATE TABLE IF NOT EXISTS ..." }, ... ],
 *   "files":       { "index.html": "...", "style.css": "..." }
 * }
 *
 * migrations/ naming convention:
 *   001_init.sql, 002_add_notes.sql  — version is the numeric prefix (no leading zeroes in JSON)
 *
 * Upload dist/bundle.json as a GitHub release asset. The hub installs it via
 * POST /api/apps/install with the release asset URL.
 */

import fs from "fs";
import path from "path";

const ROOT = new URL(".", import.meta.url).pathname;
const SRC  = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

// ── Read manifest ─────────────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// ── Read src/ files ───────────────────────────────────────────────────────────
function readDir(dir, base = "") {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, readDir(path.join(dir, entry.name), rel));
    else files[rel] = fs.readFileSync(path.join(dir, entry.name), "utf8");
  }
  return files;
}

const files = readDir(SRC);
if (!files["index.html"]) { console.error("Error: src/index.html is required"); process.exit(1); }

// ── Validate inline scripts parse ─────────────────────────────────────────────
// An app's whole UI is one inline `<script type="module">`, and nothing in the
// pipeline parses it: the bundle treats src/ as opaque strings, the hub
// validates the manifest rather than the markup, and logic.test.mjs never loads
// index.html. A duplicate top-level declaration is a SyntaxError the browser
// raises before the first statement runs — the app installs, renders its static
// markup, and does nothing (tasks 1.5.1: "Identifier 'dbBatch' has already been
// declared"). So every inline script is parsed here, the way the browser will,
// and duplicate top-level declarations are named explicitly.
{
  const { execFileSync } = await import("child_process");
  const os = await import("os");
  const errs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-scripts-"));
  let count = 0;
  try {
    for (const [name, html] of Object.entries(files)) {
      if (!name.endsWith(".html")) continue;
      for (const [, attrs = "", body] of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        // External scripts and non-JS types (JSON, templates) are not compiled as JS.
        if (!body.trim() || /\bsrc\s*=/.test(attrs) || /\btype\s*=\s*"(?!module")/.test(attrs)) continue;
        count++;
        const isModule = /\btype\s*=\s*"module"/.test(attrs);
        const file = path.join(dir, `${count}.${isModule ? "mjs" : "cjs"}`);
        fs.writeFileSync(file, body);
        try {
          execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        } catch (e) {
          const detail = String(e.stderr ?? e.message).trim().split("\n").filter(Boolean).slice(0, 3).join(" | ");
          errs.push(`${name}: inline script does not parse — ${detail}`);
        }
        const decls = [...body.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
          .map((m) => m[1] ?? m[2]);
        const seen = new Set();
        for (const decl of decls) {
          if (seen.has(decl)) errs.push(`${name}: top-level "${decl}" is declared more than once`);
          seen.add(decl);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (errs.length > 0) {
    for (const e of errs) console.error(`Error: ${e}`);
    process.exit(1);
  }
  console.log(`Inline scripts: ${count} parsed ✓`);
}

// ── Read + validate migrations (storage:"db" apps only) ───────────────────────
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
let migrations = [];

if (manifest.storage === "db") {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error('Error: storage:"db" apps must have a migrations/ directory');
    process.exit(1);
  }

  const files_ = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  if (files_.length === 0) {
    console.error("Error: migrations/ must contain at least one .sql file");
    process.exit(1);
  }

  for (const file of files_) {
    const match = file.match(/^(\d+)/);
    if (!match) { console.error(`Error: migration file must start with a number: ${file}`); process.exit(1); }
    const version = parseInt(match[1], 10);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").trim();
    migrations.push({ version, sql });
  }

  // Validate SQL contracts
  const FORBIDDEN = [
    [/\bdrop\s+table\b/i,                      "DROP TABLE is not allowed"],
    [/\bdrop\s+column\b/i,                      "DROP COLUMN is not allowed"],
    [/\brename\s+column\b/i,                    "RENAME COLUMN is not allowed"],
    [/\balter\s+table\b[^;]+\brename\s+to\b/i,  "RENAME TABLE is not allowed"],
    [/\btruncate\b/i,                           "TRUNCATE is not allowed"],
  ];

  for (const m of migrations) {
    for (const [pattern, msg] of FORBIDDEN) {
      if (pattern.test(m.sql)) { console.error(`Error: migration v${m.version}: ${msg}`); process.exit(1); }
    }
    const isCreate = /^\s*create\s+table\b/i.test(m.sql);
    if (isCreate) {
      if (!/\bif\s+not\s+exists\b/i.test(m.sql)) {
        console.error(`Error: migration v${m.version}: CREATE TABLE must use IF NOT EXISTS`); process.exit(1);
      }
    }

  }

  const versions = migrations.map(m => m.version);
  if (new Set(versions).size !== versions.length) {
    console.error("Error: migration versions must be unique"); process.exit(1);
  }

  console.log(`Migrations: ${migrations.length} file(s) validated ✓`);
}

// ── Validate agenda / glance surfaces ─────────────────────────────────────────
// The hub re-validates these at publish time and refuses to install a broken
// one, so without a local check the first sign of a typo is a failed install
// (or, for a display column, a silently dropped widget). These are the
// structural rules only — the hub remains the authority.
function surfaceErrors(m) {
  const errs = [];
  // Output aliases the query actually produces: every explicit `AS name`, plus
  // bare selected columns, which are their own alias (`SELECT title` yields
  // "title", `SELECT b.name` yields "name").
  const aliasesOf = (q) => {
    const out = new Set([...q.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(x => x[1]));
    const sel = /^\s*SELECT\s+([\s\S]*?)\sFROM\s/i.exec(q);
    if (sel) {
      let depth = 0, cur = "";
      const items = [];
      for (const ch of sel[1]) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) { items.push(cur); cur = ""; } else cur += ch;
      }
      items.push(cur);
      for (const raw of items) {
        const t = raw.trim();
        if (/\bAS\b/i.test(t)) continue;
        const bare = /^([A-Za-z_][A-Za-z0-9_]*)\.?([A-Za-z_][A-Za-z0-9_]*)?$/.exec(t);
        if (bare) out.add(bare[2] ?? bare[1]);
      }
    }
    return out;
  };
  const limitOf = (q) => { const x = /\bLIMIT\s+(\d+)\s*$/i.exec(q.trim()); return x ? parseInt(x[1], 10) : null; };

  const checkQuery = (q, where) => {
    if (typeof q !== "string" || !q.trim()) { errs.push(`${where}.source.query must be a non-empty string`); return false; }
    if (!/^\s*SELECT\b/i.test(q)) errs.push(`${where}.source.query must be a single SELECT`);
    if (q.includes(";")) errs.push(`${where}.source.query must not contain a semicolon`);
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(q)) errs.push(`${where}.source.query must be read-only`);
    return true;
  };

  const agenda = m.agenda;
  if (agenda && agenda.source?.kind === "sql") {
    const q = agenda.source.query;
    if (checkQuery(q, "manifest.agenda")) {
      const aliases = aliasesOf(q);
      for (const req of ["title", "when_at"]) {
        if (!aliases.has(req)) errs.push(`manifest.agenda.source.query must select an "${req}" alias`);
      }
      const lim = limitOf(q);
      if (lim === null) errs.push("manifest.agenda.source.query must end with a LIMIT");
      else if (lim < 1 || lim > 20) errs.push(`manifest.agenda.source.query LIMIT must be 1-20 (got ${lim})`);
      // A day token has to narrow the scan, not just be selected or sorted on.
      // It counts as filtering if it appears anywhere in the WHERE / JOIN ... ON
      // region, including nested in a function call -- occasions compares
      // `event_month = CAST(strftime('%m', :today) AS INTEGER)`.
      const tokens = [...q.matchAll(/:(today|day_start|day_end)\b/g)].map(x => x[0]);
      if (tokens.length > 0) {
        const anchor = /\bWHERE\b|\bON\b/i.exec(q);
        const filterRegion = anchor ? q.slice(anchor.index).replace(/\bORDER\s+BY\b[\s\S]*$/i, "") : "";
        if (!tokens.some(t => filterRegion.includes(t))) {
          errs.push(`manifest.agenda.source.query uses ${tokens[0]} but never filters on it`);
        }
      }
    }
  }

  const glance = m.glance;
  if (glance && glance.source?.kind === "sql") {
    const q = glance.source.query;
    if (checkQuery(q, "manifest.glance")) {
      const aliases = aliasesOf(q);
      const d = glance.display ?? {};
      const TEMPLATES = { stat: ["value"], list: ["title"], badge: ["count"] };
      if (!TEMPLATES[d.template]) {
        errs.push('manifest.glance.display.template must be "stat", "list", or "badge"');
      } else {
        for (const req of TEMPLATES[d.template]) {
          if (!d[req]) errs.push(`manifest.glance.display.${req} is required for a ${d.template} glance`);
        }
        // Every display field names an output alias of the query.
        for (const f of ["value", "title", "subtitle", "when", "icon", "owner", "count"]) {
          if (d[f] !== undefined && !aliases.has(d[f])) {
            errs.push(`manifest.glance.display.${f} "${d[f]}" is not one of the query's selected columns`);
          }
        }
        const lim = limitOf(q);
        if (d.template === "list" && lim !== null && lim > 5) {
          errs.push(`manifest.glance.source.query LIMIT must be at most 5 for a list glance (got ${lim})`);
        }
      }
      if (glance.ambient_card !== undefined && glance.ambient_card !== "countdown") {
        errs.push('manifest.glance.ambient_card must be "countdown"');
      }
      if (glance.ambient_card === "countdown" && d.template !== "list") {
        errs.push('manifest.glance.ambient_card "countdown" requires display.template "list"');
      }
    }
  }
  return errs;
}

{
  const errs = surfaceErrors(manifest);
  if (errs.length > 0) {
    for (const e of errs) console.error(`Error: ${e}`);
    process.exit(1);
  }
  if (manifest.agenda || manifest.glance) {
    const which = [manifest.agenda && "agenda", manifest.glance && "glance"].filter(Boolean).join(" + ");
    console.log(`Surfaces: ${which} validated ✓`);
  }
}

// ── Validate inline event handlers resolve to globals ─────────────────────────
// An inline `on*=` attribute is compiled by the browser as a function in GLOBAL
// scope. Everything declared inside `<script type="module">` is module-scoped,
// so such a handler only resolves if the name was explicitly assigned onto
// `window`/`globalThis`. Miss one name out of a bridge block and the app builds,
// installs, and renders perfectly — then throws
// `ReferenceError: Can't find variable: x` the first time a user touches that
// one control. Nothing else in the pipeline can see it: the bundle treats src/
// as opaque strings, the hub validates the manifest rather than the markup, and
// logic.test.mjs has no DOM. So it is checked here.
function inlineHandlerErrors(files) {
  const errs = [];

  // Names an inline handler may reference without the app declaring them.
  const AMBIENT = new Set([
    "event", "this", "window", "document", "console", "navigator", "location", "history",
    "alert", "confirm", "prompt", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "fetch", "requestAnimationFrame", "queueMicrotask", "structuredClone", "getComputedStyle",
    "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date", "RegExp",
    "Map", "Set", "Promise", "Error", "Symbol", "BigInt", "parseInt", "parseFloat",
    "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
    // keywords that can precede a `(` and are not calls
    "if", "for", "while", "switch", "catch", "return", "typeof", "function", "new", "await", "var",
  ]);

  // `${...}` is evaluated when the template string is built, in module scope —
  // it is not part of what the browser compiles as a global handler.
  const stripInterpolations = (s) => {
    let out = "", i = 0;
    while (i < s.length) {
      if (s[i] === "$" && s[i + 1] === "{") {
        let depth = 1; i += 2;
        while (i < s.length && depth > 0) {
          if (s[i] === "{") depth++;
          else if (s[i] === "}") depth--;
          i++;
        }
        out += "0"; // placeholder for the interpolated value
      } else out += s[i++];
    }
    return out;
  };

  // A call can't live inside a string literal (`'var(--accent)'` is not a call).
  const stripStrings = (s) => s.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, "``");

  // Blank out JS comments so a handler quoted in a comment isn't treated as real
  // markup. Only whole-line `//` comments, so a `https://` URL survives intact.
  const stripComments = (js) =>
    js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  for (const [name, html] of Object.entries(files)) {
    if (!name.endsWith(".html")) continue;

    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const classic = scripts.filter(s => !/type\s*=\s*["']module["']/i.test(s[1]));

    // What is actually reachable as a global.
    const globals = new Set();
    for (const m of html.matchAll(/\b(?:window|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      globals.add(m[1]);
    }
    // Top-level declarations in a classic (non-module) script really are globals.
    for (const s of classic) {
      for (const m of s[2].matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) globals.add(m[1]);
      for (const m of s[2].matchAll(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm)) globals.add(m[1]);
    }

    // Scan handlers in static markup and in rendered template markup alike.
    let scanned = html;
    for (const s of scripts) scanned = scanned.replace(s[2], stripComments(s[2]));

    const seen = new Map(); // missing name -> sample handler
    for (const m of scanned.matchAll(/\son([a-z]+)\s*=\s*(["'`])([\s\S]*?)\2/gi)) {
      const body = stripStrings(stripInterpolations(m[3]));
      for (const c of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        const fn = c[1];
        if (AMBIENT.has(fn) || globals.has(fn)) continue;
        if (c.index > 0 && body[c.index - 1] === ".") continue; // method call
        if (!seen.has(fn)) seen.set(fn, `on${m[1]}="${m[3].trim().slice(0, 60)}"`);
      }
    }

    for (const [fn, sample] of seen) {
      errs.push(
        `${name}: inline handler calls "${fn}()" but nothing assigns window.${fn} ` +
        `— it is module-scoped, so this throws ReferenceError at click time (${sample})`
      );
    }
  }
  return errs;
}

{
  const errs = inlineHandlerErrors(files);
  if (errs.length > 0) {
    for (const e of errs) console.error(`Error: ${e}`);
    process.exit(1);
  }
  console.log("Inline handlers: all resolve to globals ✓");
}

// ── Read scenarios.json (optional per-app behavioral specs) ───────────────────
// Shipped in the bundle so the hub's nightly app-exercise fan-in can replay
// scenarios against the published bundle (see hub INTEGRATION_TESTS.md).
let scenarios;
const SCENARIOS_FILE = path.join(ROOT, "scenarios.json");
if (fs.existsSync(SCENARIOS_FILE)) {
  scenarios = JSON.parse(fs.readFileSync(SCENARIOS_FILE, "utf8"));
}

// ── Read ui-scenarios.json (optional per-app browser specs) ───────────────────
// Layer 3b: Playwright drives the app's own UI inside the real hub. Shipped in
// the bundle so the hub can collect scenarios from a published bundle, not just
// from a local app dir (see hub DESIGN-app-ui-scenarios.md).
let uiScenarios;
const UI_SCENARIOS_FILE = path.join(ROOT, "ui-scenarios.json");
if (fs.existsSync(UI_SCENARIOS_FILE)) {
  uiScenarios = JSON.parse(fs.readFileSync(UI_SCENARIOS_FILE, "utf8"));
}

// ── Write bundle ──────────────────────────────────────────────────────────────
const bundle = {
  manifest,
  ...(migrations.length ? { migrations } : {}),
  files,
  ...(scenarios ? { scenarios } : {}),
  ...(uiScenarios ? { ui_scenarios: uiScenarios } : {}),
};

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "bundle.json"), JSON.stringify(bundle, null, 2), "utf8");

const totalBytes = Object.values(files).reduce((s, v) => s + v.length, 0);
console.log(`Built ${Object.keys(files).length} file(s) — ${(totalBytes / 1024).toFixed(1)} KB → dist/bundle.json`);
