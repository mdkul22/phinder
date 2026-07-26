import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Phinder requires Node.js 22.13 or newer (current: ${process.versions.node}).`);
  console.error("Install Node.js 24 LTS, then run npm start again.");
  process.exit(1);
}

async function loadLocalEnv() {
  try {
    const contents = await readFile(join(process.cwd(), ".env"), "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await loadLocalEnv();
const { DatabaseSync } = await import("node:sqlite");

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const baseUrl = (process.env.IMMICH_BASE_URL || "").replace(/\/+$/, "");
const apiKey = process.env.IMMICH_API_KEY || "";
const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "triage.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('all','favorites','album','uploaded_today','pune_wedding','date_range','geography')),
    source_album_id TEXT,
    source_after TEXT,
    source_before TEXT,
    source_city TEXT,
    source_state TEXT,
    source_country TEXT,
    source_latitude REAL,
    source_longitude REAL,
    source_radius_km REAL,
    shuffle INTEGER NOT NULL DEFAULT 1,
    target_album_id TEXT NOT NULL,
    target_album_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS decisions (
    project_id INTEGER NOT NULL,
    asset_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
    decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(project_id, asset_id),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

for (const statement of [
  "ALTER TABLE projects ADD COLUMN source_after TEXT",
  "ALTER TABLE projects ADD COLUMN source_before TEXT",
  "ALTER TABLE projects ADD COLUMN shuffle INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE projects ADD COLUMN source_city TEXT",
  "ALTER TABLE projects ADD COLUMN source_state TEXT",
  "ALTER TABLE projects ADD COLUMN source_country TEXT",
  "ALTER TABLE projects ADD COLUMN source_latitude REAL",
  "ALTER TABLE projects ADD COLUMN source_longitude REAL",
  "ALTER TABLE projects ADD COLUMN source_radius_km REAL",
]) {
  try { db.exec(statement); } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }
}

const projectsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get()?.sql || "";
if (!projectsSchema.includes("'geography'") || !projectsSchema.includes("source_latitude")) {
  db.exec(`
    CREATE TABLE projects_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('all','favorites','album','uploaded_today','pune_wedding','date_range','geography')),
      source_album_id TEXT,
      source_after TEXT,
      source_before TEXT,
      source_city TEXT,
      source_state TEXT,
      source_country TEXT,
      source_latitude REAL,
      source_longitude REAL,
      source_radius_km REAL,
      shuffle INTEGER NOT NULL DEFAULT 1,
      target_album_id TEXT NOT NULL,
      target_album_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO projects_next(id,name,source_type,source_album_id,source_after,source_before,source_city,source_state,source_country,source_latitude,source_longitude,source_radius_km,shuffle,target_album_id,target_album_name,created_at)
      SELECT id,name,source_type,source_album_id,source_after,source_before,source_city,source_state,source_country,source_latitude,source_longitude,source_radius_km,shuffle,target_album_id,target_album_name,created_at FROM projects;
    DROP TABLE projects;
    ALTER TABLE projects_next RENAME TO projects;
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS project_candidates (
    project_id INTEGER NOT NULL,
    asset_id TEXT NOT NULL,
    file_created_at TEXT,
    PRIMARY KEY(project_id, asset_id),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS cleanup_decisions (
    asset_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK(decision IN ('kept','trashed')),
    decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const immich = async (path, init = {}) => {
  if (!baseUrl || !apiKey) throw Object.assign(new Error("Immich is not configured"), { status: 503 });
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`Immich returned ${response.status}: ${detail.slice(0, 240)}`), { status: response.status });
  }
  return response;
};

const getProject = (id) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
const decidedIds = (id) => new Set(db.prepare("SELECT asset_id FROM decisions WHERE project_id = ?").all(id).map((r) => r.asset_id));
const distanceKm = (latitudeA, longitudeA, latitudeB, longitudeB) => {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

async function populateGeographyCandidates(projectId, latitude, longitude, radiusKm) {
  let page = 1;
  const insert = db.prepare("INSERT OR IGNORE INTO project_candidates(project_id,asset_id,file_created_at) VALUES(?,?,?)");
  for (let batch = 0; batch < 1000; batch += 1) {
    const response = await immich("/search/metadata", {
      method: "POST",
      body: JSON.stringify({ page, size: 100, type: "IMAGE", withExif: true, order: "asc" }),
    });
    const result = await response.json();
    const matches = (result.assets?.items || []).filter((asset) => {
      const exif = asset.exifInfo || {};
      return Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
        && distanceKm(exif.latitude, exif.longitude, latitude, longitude) <= radiusKm;
    });
    for (const asset of matches) insert.run(projectId, asset.id, asset.fileCreatedAt || null);
    if (!result.assets?.nextPage) break;
    page = Number(result.assets.nextPage);
  }
}

async function sourceAssets(project, page, decided = new Set()) {
  if (project.source_type === "album") {
    const response = await immich(`/albums/${project.source_album_id}?withoutAssets=false`);
    const album = await response.json();
    const items = (album.assets || []).filter((asset) => asset.type === "IMAGE");
    if (project.shuffle) items.sort(() => Math.random() - 0.5);
    return { items, nextPage: null };
  }
  if (project.source_type === "pune_wedding") {
    const items = [];
    let searchPage = 1;
    for (let batch = 0; batch < 100; batch += 1) {
      const response = await immich("/search/metadata", {
        method: "POST",
        body: JSON.stringify({
          page: searchPage,
          size: 100,
          type: "IMAGE",
          takenAfter: "2025-12-12T18:30:00.000Z",
          takenBefore: "2025-12-13T18:30:00.000Z",
          city: "Pune",
          withExif: true,
          order: "asc",
        }),
      });
      const result = await response.json();
      items.push(...(result.assets?.items || []));
      if (!result.assets?.nextPage) break;
      searchPage = Number(result.assets.nextPage);
    }
    if (project.shuffle) items.sort(() => Math.random() - 0.5);
    return { items, nextPage: null };
  }
  if (project.source_type === "geography") {
    const order = project.shuffle ? "RANDOM()" : "c.file_created_at DESC";
    const candidate = db.prepare(`
      SELECT c.asset_id FROM project_candidates c
      LEFT JOIN decisions d ON d.project_id=c.project_id AND d.asset_id=c.asset_id
      WHERE c.project_id=? AND d.asset_id IS NULL
      ORDER BY ${order} LIMIT 1
    `).get(project.id);
    if (!candidate) return { items: [], nextPage: null };
    const assetResponse = await immich(`/assets/${candidate.asset_id}`);
    return { items: [await assetResponse.json()], nextPage: null };
  }
  const filters = {
    type: "IMAGE",
    withExif: true,
    ...(project.source_type === "favorites" ? { isFavorite: true } : {}),
    ...(project.source_type === "uploaded_today" ? {
      createdAfter: project.source_after,
      createdBefore: project.source_before,
    } : {}),
    ...(project.source_type === "date_range" ? {
      takenAfter: project.source_after,
      takenBefore: project.source_before,
    } : {}),
    ...(project.source_type === "geography" ? {
      ...(project.source_city ? { city: project.source_city } : {}),
      ...(project.source_state ? { state: project.source_state } : {}),
      ...(project.source_country ? { country: project.source_country } : {}),
    } : {}),
  };
  if (project.shuffle) {
    const response = await immich("/search/random", {
      method: "POST",
      body: JSON.stringify({ ...filters, size: 100 }),
    });
    const items = await response.json();
    return { items: Array.isArray(items) ? items : [], nextPage: Array.isArray(items) && items.length ? 1 : null };
  }
  const body = {
    page,
    size: 100,
    order: "desc",
    ...filters,
  };
  const response = await immich("/search/metadata", { method: "POST", body: JSON.stringify(body) });
  const result = await response.json();
  return { items: result.assets?.items || [], nextPage: result.assets?.nextPage ?? null };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { configured: Boolean(baseUrl && apiKey), baseUrl: baseUrl || null });
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    const response = await immich("/server/version");
    return json(res, 200, { connected: true, version: await response.json() });
  }
  if (req.method === "GET" && url.pathname === "/api/albums") {
    const response = await immich("/albums");
    return json(res, 200, await response.json());
  }
  if (req.method === "POST" && url.pathname === "/api/albums") {
    const body = await readJson(req);
    if (!body.albumName?.trim()) return json(res, 400, { error: "Album name is required" });
    const response = await immich("/albums", { method: "POST", body: JSON.stringify({ albumName: body.albumName.trim(), description: "Curated with Phinder" }) });
    return json(res, 201, await response.json());
  }
  if (req.method === "GET" && url.pathname === "/api/cleanup/next") {
    const seen = new Set(db.prepare("SELECT asset_id FROM cleanup_decisions").all().map((row) => row.asset_id));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await immich("/search/random", {
        method: "POST",
        body: JSON.stringify({ type: "IMAGE", size: 100, withExif: true }),
      });
      const items = await response.json();
      const asset = (Array.isArray(items) ? items : []).find((item) => !seen.has(item.id) && !item.isTrashed);
      if (asset) {
        const counts = db.prepare(`
          SELECT COUNT(*) seen,
          SUM(CASE WHEN decision='trashed' THEN 1 ELSE 0 END) trashed
          FROM cleanup_decisions
        `).get();
        return json(res, 200, { asset, seen: counts.seen || 0, trashed: counts.trashed || 0 });
      }
    }
    return json(res, 200, { asset: null });
  }
  if (req.method === "POST" && url.pathname === "/api/cleanup/decision") {
    const body = await readJson(req);
    if (!body.assetId || !["kept", "trashed"].includes(body.decision)) {
      return json(res, 400, { error: "Invalid cleanup choice" });
    }
    if (body.decision === "trashed") {
      await immich("/assets", {
        method: "DELETE",
        body: JSON.stringify({ ids: [body.assetId], force: false }),
      });
    }
    db.prepare("INSERT OR REPLACE INTO cleanup_decisions(asset_id,decision,decided_at) VALUES(?,?,CURRENT_TIMESTAMP)")
      .run(body.assetId, body.decision);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/cleanup/undo") {
    const last = db.prepare("SELECT asset_id,decision FROM cleanup_decisions ORDER BY decided_at DESC,rowid DESC LIMIT 1").get();
    if (!last) return json(res, 409, { error: "Nothing to undo" });
    if (last.decision === "trashed") {
      await immich("/trash/restore/assets", {
        method: "POST",
        body: JSON.stringify({ ids: [last.asset_id] }),
      });
    }
    db.prepare("DELETE FROM cleanup_decisions WHERE asset_id=?").run(last.asset_id);
    return json(res, 200, last);
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const rows = db.prepare(`
      SELECT p.*, COUNT(d.asset_id) decided,
      SUM(CASE WHEN d.decision='accepted' THEN 1 ELSE 0 END) accepted,
      SUM(CASE WHEN d.decision='rejected' THEN 1 ELSE 0 END) rejected
      FROM projects p LEFT JOIN decisions d ON p.id=d.project_id GROUP BY p.id ORDER BY p.id DESC
    `).all();
    return json(res, 200, rows);
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(req);
    if (!["all", "favorites", "album", "uploaded_today", "pune_wedding", "date_range", "geography"].includes(body.sourceType) || !body.targetAlbumId || !body.targetAlbumName) {
      return json(res, 400, { error: "Choose a valid source and target album" });
    }
    if (body.sourceType === "album" && !body.sourceAlbumId) return json(res, 400, { error: "Choose a source album" });
    if (body.sourceType === "uploaded_today" && (!body.sourceAfter || !body.sourceBefore)) {
      return json(res, 400, { error: "The local-day time window is required" });
    }
    if (body.sourceType === "date_range") {
      const after = new Date(body.sourceAfter);
      const before = new Date(body.sourceBefore);
      if (!body.sourceAfter || !body.sourceBefore || Number.isNaN(after.valueOf()) || Number.isNaN(before.valueOf()) || after >= before) {
        return json(res, 400, { error: "Choose a valid capture date range" });
      }
    }
    if (body.sourceType === "geography") {
      const latitude = Number(body.sourceLatitude);
      const longitude = Number(body.sourceLongitude);
      const radius = Number(body.sourceRadiusKm);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(radius) || radius < 5 || radius > 10000) {
        return json(res, 400, { error: "Choose a point and radius on the map" });
      }
    }
    const result = db.prepare("INSERT INTO projects(name,source_type,source_album_id,source_after,source_before,source_city,source_state,source_country,source_latitude,source_longitude,source_radius_km,shuffle,target_album_id,target_album_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(body.name?.trim() || "Photo selection", body.sourceType, body.sourceAlbumId || null, body.sourceAfter || null, body.sourceBefore || null, body.sourceCity?.trim() || null, body.sourceState?.trim() || null, body.sourceCountry?.trim() || null, body.sourceLatitude ?? null, body.sourceLongitude ?? null, body.sourceRadiusKm ?? null, body.shuffle === false ? 0 : 1, body.targetAlbumId, body.targetAlbumName);
    if (body.sourceType === "geography") {
      try {
        await populateGeographyCandidates(result.lastInsertRowid, Number(body.sourceLatitude), Number(body.sourceLongitude), Number(body.sourceRadiusKm));
      } catch (error) {
        db.prepare("DELETE FROM projects WHERE id=?").run(result.lastInsertRowid);
        throw error;
      }
    }
    return json(res, 201, getProject(result.lastInsertRowid));
  }
  if (req.method === "POST" && url.pathname === "/api/source-summary") {
    const body = await readJson(req);
    if ((!body.createdAfter || !body.createdBefore) && (!body.takenAfter || !body.takenBefore) && !body.originalFileName) {
      return json(res, 400, { error: "A date window or filename filter is required" });
    }
    let page = 1;
    let total = 0;
    let captureDates = 0;
    let timelineDates = 0;
    let gps = 0;
    let namedLocations = 0;
    let earliestCapture = null;
    let latestCapture = null;
    let suspiciousDates = 0;
    let missingCaptureDates = 0;
    let puneDateMatches = 0;
    let puneLocationMatches = 0;
    let hyderabadDateMatches = 0;
    let hyderabadLocationMatches = 0;
    let outsideWeddingDates = 0;
    let truncated = false;
    for (let batchNumber = 0; batchNumber < 100; batchNumber += 1) {
      const response = await immich("/search/metadata", {
        method: "POST",
        body: JSON.stringify({
          page,
          size: 100,
          type: "IMAGE",
          order: "desc",
          withExif: true,
          ...(body.createdAfter ? { createdAfter: body.createdAfter } : {}),
          ...(body.createdBefore ? { createdBefore: body.createdBefore } : {}),
          ...(body.takenAfter ? { takenAfter: body.takenAfter } : {}),
          ...(body.takenBefore ? { takenBefore: body.takenBefore } : {}),
          ...(body.city ? { city: body.city } : {}),
          ...(body.originalFileName ? { originalFileName: body.originalFileName } : {}),
        }),
      });
      const result = await response.json();
      const items = (result.assets?.items || []).filter((item) =>
        !body.originalFileName || String(item.originalFileName || "").startsWith(body.originalFileName)
      );
      for (const item of items) {
        const exif = item.exifInfo || {};
        total += 1;
        if (item.fileCreatedAt) timelineDates += 1;
        const captureValue = exif.dateTimeOriginal || item.fileCreatedAt;
        if (exif.dateTimeOriginal) {
          captureDates += 1;
          const captured = new Date(exif.dateTimeOriginal);
          if (!Number.isNaN(captured.valueOf())) {
            const iso = captured.toISOString();
            if (!earliestCapture || iso < earliestCapture) earliestCapture = iso;
            if (!latestCapture || iso > latestCapture) latestCapture = iso;
            const nextWeek = Date.now() + 7 * 86400000;
            if (captured.getUTCFullYear() < 1990 || captured.valueOf() > nextWeek) suspiciousDates += 1;
          }
        }
        if (!captureValue) {
          missingCaptureDates += 1;
        } else {
          const localDate = String(captureValue).slice(0, 10);
          if (localDate === "2025-12-13") puneDateMatches += 1;
          else if (localDate === "2025-12-25" || localDate === "2025-12-26") hyderabadDateMatches += 1;
          else outsideWeddingDates += 1;
        }
        if (Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)) gps += 1;
        if (exif.city || exif.state || exif.country) namedLocations += 1;
        const place = `${exif.city || ""} ${exif.state || ""} ${exif.country || ""}`.toLowerCase();
        const nearPune = Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
          && distanceKm(exif.latitude, exif.longitude, 18.5204, 73.8567) <= 100;
        const nearHyderabad = Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
          && distanceKm(exif.latitude, exif.longitude, 17.385, 78.4867) <= 100;
        if (place.includes("pune") || nearPune) puneLocationMatches += 1;
        if (place.includes("hyderabad") || nearHyderabad) hyderabadLocationMatches += 1;
      }
      const nextPage = result.assets?.nextPage;
      if (!nextPage) break;
      page = Number(nextPage);
      if (batchNumber === 99) truncated = true;
    }
    return json(res, 200, {
      total, timelineDates, captureDates, gps, namedLocations, earliestCapture, latestCapture,
      suspiciousDates, missingCaptureDates, puneDateMatches, puneLocationMatches,
      hyderabadDateMatches, hyderabadLocationMatches, outsideWeddingDates, truncated,
    });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)(?:\/(next|decisions|selected|undo))?$/);
  if (!projectMatch) return false;
  const id = Number(projectMatch[1]);
  const action = projectMatch[2];
  const project = getProject(id);
  if (!project) return json(res, 404, { error: "Project not found" });

  if (req.method === "GET" && action === "next") {
    const decided = decidedIds(id);
    let page = Number(url.searchParams.get("page") || 1);
    for (let tries = 0; tries < 20; tries += 1) {
      const batch = await sourceAssets(project, page, decided);
      const asset = batch.items.find((item) => !decided.has(item.id) && item.id !== project.target_album_id);
      if (asset) return json(res, 200, { asset, page, nextPage: batch.nextPage });
      if (!batch.nextPage) return json(res, 200, { asset: null, page, nextPage: null });
      page = Number(batch.nextPage);
    }
    return json(res, 200, { asset: null, page, nextPage: null });
  }
  if (req.method === "POST" && action === "decisions") {
    const body = await readJson(req);
    if (!body.assetId || !["accepted", "rejected"].includes(body.decision)) return json(res, 400, { error: "Invalid decision" });
    if (body.decision === "accepted") {
      await immich(`/albums/${project.target_album_id}/assets`, { method: "PUT", body: JSON.stringify({ ids: [body.assetId] }) });
    }
    db.prepare("INSERT OR REPLACE INTO decisions(project_id,asset_id,decision,decided_at) VALUES(?,?,?,CURRENT_TIMESTAMP)")
      .run(id, body.assetId, body.decision);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && action === "undo") {
    const last = db.prepare("SELECT asset_id,decision FROM decisions WHERE project_id=? ORDER BY decided_at DESC,rowid DESC LIMIT 1").get(id);
    if (!last) return json(res, 409, { error: "Nothing to undo" });
    if (last.decision === "accepted") {
      await immich(`/albums/${project.target_album_id}/assets`, { method: "DELETE", body: JSON.stringify({ ids: [last.asset_id] }) });
    }
    db.prepare("DELETE FROM decisions WHERE project_id=? AND asset_id=?").run(id, last.asset_id);
    return json(res, 200, last);
  }
  if (req.method === "GET" && action === "selected") {
    const rows = db.prepare("SELECT asset_id,decided_at FROM decisions WHERE project_id=? AND decision='accepted' ORDER BY decided_at DESC").all(id);
    return json(res, 200, rows);
  }
  return false;
}

async function serve(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(process.cwd(), "public", relative));
  const publicRoot = normalize(join(process.cwd(), "public"));
  if (!file.startsWith(publicRoot) || !existsSync(file)) return json(res, 404, { error: "Not found" });
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/assets/") && url.pathname.endsWith("/thumbnail")) {
      const id = url.pathname.split("/")[3];
      const response = await immich(`/assets/${id}/thumbnail?size=preview`);
      res.writeHead(200, { "content-type": response.headers.get("content-type") || "image/jpeg", "cache-control": "private, max-age=3600" });
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await api(req, res, url);
      if (handled === false) return json(res, 404, { error: "Not found" });
      return;
    }
    await serve(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.message || "Unexpected error" });
  }
}).listen(port, host, () => console.log(`Phinder listening on http://${host}:${port}`));
