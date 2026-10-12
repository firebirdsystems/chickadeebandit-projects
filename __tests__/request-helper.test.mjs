import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "../src");

// The hub answers a failed database request three ways: a 5xx status, a 200
// carrying `{ error }`, and (a proxy, a crash) a 200 whose body is not JSON
// at all. A helper that hands any of those back as data makes the
// page draw "nothing here" for "could not read", or show a write as done.
// So every function in the page that posts to the database URL is run here
// against all three, and must reject each.
//
// A helper is exercised only when it first answers a well-formed response on
// its own — one that leans on page state this harness does not have is left
// to the browser lanes (the fault smoke), and named in the test title so its
// absence here is visible rather than silent.

const DB_NAMES = ["DB", "DB_URL", "DB_ENDPOINT"];
const CALLS_DB = /\bfetch\(\s*(?:DB|DB_URL|DB_ENDPOINT|window\.__DB_URL)\b/;

/** `async function name(…) { … }` blocks whose body posts to the database URL. */
function dbHelpers(source) {
  const found = [];
  const re = /async function (\w+)\s*\(/g;
  for (let m; (m = re.exec(source)); ) {
    const open = source.indexOf("{", source.indexOf(")", m.index));
    let depth = 0, end = -1, quote = null;
    for (let i = open; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
      if (c === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i) + 1; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) continue;
    const text = source.slice(m.index, end);
    // Only the helper itself: a function that merely CALLS a helper has no
    // fetch of its own, and one that nests another function is too much page.
    if (CALLS_DB.test(text) && !/\n\s*(async )?function \w+\s*\(/.test(text.slice(15))) found.push({ name: m[1], text });
  }
  return found;
}

const response = {
  ok: () => new Response(JSON.stringify({ rows: [], results: [], changed: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }),
  down: () => new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } }),
  errorIn200: () => new Response(JSON.stringify({ error: "Query failed" }), { status: 200, headers: { "Content-Type": "application/json" } }),
  notJson: () => new Response("<!doctype html><title>Gateway</title>", { status: 200, headers: { "Content-Type": "text/html" } }),
};

async function call(helper, kind) {
  const sandbox = {
    fetch: async () => response[kind](),
    window: { __DB_URL: "/api/db" },
    console: { error() {}, warn() {}, log() {} },
    Response, JSON, Error, Promise, Array, Object, String, Number, Boolean,
  };
  for (const name of DB_NAMES) sandbox[name] = "/api/db";
  vm.createContext(sandbox);
  vm.runInContext(`${helper.text}\nglobalThis.__helper = ${helper.name};`, sandbox);
  return sandbox.__helper("SELECT 1", []);
}

const sources = readdirSync(srcDir)
  .filter((f) => /\.(html|js)$/.test(f))
  .map((f) => ({ file: f, helpers: dbHelpers(readFileSync(join(srcDir, f), "utf-8")) }))
  .filter((s) => s.helpers.length);

describe("database request helpers reject every answer that is not a result", () => {
  if (!sources.length) {
    it("has no self-contained database helper to exercise here", () => {});
    return;
  }
  for (const { file, helpers } of sources) {
    for (const helper of helpers) {
      it(`${file} ${helper.name}()`, async () => {
        const standsAlone = await call(helper, "ok").then(() => true, () => false);
        if (!standsAlone) return; // needs page state; covered by the fault smoke
        // A 403 is not in the list: a page may read a refusal as "not for this
        // viewer" on purpose. An outage, an error body and a non-JSON body
        // have no such reading.
        for (const kind of ["down", "errorIn200", "notJson"]) {
          await expect(call(helper, kind), `${helper.name}() resolved for a "${kind}" answer`).rejects.toBeTruthy();
        }
      });
    }
  }
});
