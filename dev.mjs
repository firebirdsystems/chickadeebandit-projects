#!/usr/bin/env node
/**
 * Generic local dev server for Chickadee Bandit apps.
 *
 * Reads the app ID from manifest.json to construct the correct base path.
 *
 * hub-sdk.js is fetched from the deployed hub (its canonical source is
 * packages/hub-contract/src/hub-sdk.js in the hub repo) on first run and cached
 * locally as .hub-sdk.js (gitignored). If the cache is older than 24 hours
 * it is refreshed automatically. Falls back to a stale cache when offline.
 *
 * Usage:
 *   node dev.mjs              # http://localhost:3001
 *   PORT=3002 node dev.mjs
 */

import http  from "http";
import fs    from "fs";
import path  from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT ?? "3001", 10);
const CACHE     = path.join(__dirname, ".hub-sdk.js");
const SDK_URL   = "https://www.chickadeebandit.com/hub-sdk.js";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const APP_BASE  = `/run/${manifest.id}/`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function mime(filepath) {
  return MIME[path.extname(filepath).toLowerCase()] ?? "application/octet-stream";
}

function serve(res, filepath) {
  try {
    const body = fs.readFileSync(filepath);
    res.writeHead(200, { "Content-Type": mime(filepath) });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not found: ${filepath}`);
  }
}

function fetchSdk() {
  return new Promise((resolve, reject) => {
    https.get(SDK_URL, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}

async function ensureSdk() {
  const cacheExists = fs.existsSync(CACHE);
  const cacheAge    = cacheExists ? Date.now() - fs.statSync(CACHE).mtimeMs : Infinity;
  const needsFetch  = !cacheExists || cacheAge > MAX_AGE_MS;

  if (needsFetch) {
    process.stdout.write(cacheExists ? "Refreshing hub-sdk.js… " : "Fetching hub-sdk.js… ");
    try {
      const src = await fetchSdk();
      fs.writeFileSync(CACHE, src, "utf8");
      console.log("done.");
    } catch (e) {
      if (cacheExists) {
        console.log(`fetch failed (${e.message}), using cached copy.`);
      } else {
        console.error(`\nERROR: Could not fetch hub-sdk.js — ${e.message}`);
        console.error(`       Check your internet connection and try again.\n`);
        process.exit(1);
      }
    }
  }
}

await ensureSdk();

http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/hub-sdk.js") {
    serve(res, CACHE);
    return;
  }

  const stripped = url.startsWith(APP_BASE) ? url.slice(APP_BASE.length) : url.replace(/^\//, "");
  serve(res, path.join(__dirname, "src", stripped === "" ? "index.html" : stripped));
}).listen(PORT, () => {
  console.log(`App:        ${manifest.name} (${manifest.id})`);
  console.log(`Dev server: http://localhost:${PORT}`);
});
