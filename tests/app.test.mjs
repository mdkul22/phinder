import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("API key is not shipped to the browser", async () => {
  const files = await Promise.all(["public/index.html", "public/app.js", "public/styles.css"].map((f) => readFile(f, "utf8")));
  assert.equal(files.join("\n").includes("x-api-key"), false);
});

test("MVP controls and safety copy are present", async () => {
  const html = await readFile("public/index.html", "utf8");
  for (const text of ["Start choosing", "Filters", "Uploaded today", "Pune wedding", "Capture-date range", "Geographic area", "Surprise me", "Skip", "Add to album", "Your picks", "Nothing is deleted, moved, or copied"]) assert.match(html, new RegExp(text, "i"));
  assert.doesNotMatch(html, />[^<]*triage[^<]*</i);
  assert.doesNotMatch(html, /Check metadata|metadataSummary|auditNote/);
  assert.match(html, /id="homeBtn"/);
  assert.doesNotMatch(html, /Name this selection/i);
  assert.match(html, /id="useDateRange"/);
  assert.match(html, /id="useGeography"/);
});

test("cleanup is random, recoverable, and keeps the API key server-side", async () => {
  const [html, server, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("server.mjs", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  assert.match(html, /Clean up random photos/i);
  assert.match(html, /Move to trash/i);
  assert.match(html, /recoverable in Immich/i);
  assert.match(server, /\/search\/random/);
  assert.match(server, /method: "DELETE"/);
  assert.match(server, /force: false/);
  assert.match(server, /\/trash\/restore\/assets/);
  assert.doesNotMatch(app, /IMMICH_API_KEY/);
});

test("map, touch controls, and iOS app icon are wired", async () => {
  const [html, script, manifest] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/manifest.webmanifest", "utf8"),
  ]);
  assert.match(html, /id="geoMap"/);
  assert.match(script, /pointerdown/);
  assert.match(script, /pointermove/);
  assert.match(script, /wheel/);
  assert.match(html, /apple-touch-icon/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  assert.match(html, /<title>Phinder<\/title>/);
  assert.equal(JSON.parse(manifest).short_name, "Phinder");
});
