const $ = (id) => document.getElementById(id);
let albums = [];
let project = null;
let asset = null;
let page = 1;
let touchX = null;
let cleanupAsset = null;
let cleanupTouchX = null;

const geoState = { latitude: null, longitude: null, radiusKm: 500 };
let geoProjection = null;
let geoPath = null;
let geoReady = false;
const activePointers = new Map();
let pinchStart = null;

const todayWindow = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { sourceAfter: start.toISOString(), sourceBefore: end.toISOString() };
};

const captureRangeWindow = () => {
  const startValue = $("rangeStart").value;
  const endValue = $("rangeEnd").value;
  if (!startValue || !endValue) throw new Error("Choose both a start and end date.");
  const start = new Date(`${startValue}T00:00:00`);
  const end = new Date(`${endValue}T00:00:00`);
  end.setDate(end.getDate() + 1);
  if (start >= end) throw new Error("The end date must be on or after the start date.");
  return { sourceAfter: start.toISOString(), sourceBefore: end.toISOString() };
};

const call = async (path, init) => {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

const post = (path, body) => call(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const showNotice = (message) => { $("notice").textContent = message || ""; };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
})[character]);

const renderAlbums = () => {
  const options = albums.map((album) =>
    `<option value="${album.id}">${escapeHtml(album.albumName)} - ${album.assetCount || 0} photos</option>`
  ).join("");
  $("targetAlbum").innerHTML = options || "<option value=''>No albums yet - create one</option>";
  $("sourceAlbum").innerHTML = options || "<option value=''>No albums available</option>";
};

function svgPointFromEvent(event) {
  const svg = $("geoMap");
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function setGeoCenterFromEvent(event) {
  if (!geoProjection) return;
  const point = svgPointFromEvent(event);
  const coordinates = geoProjection.invert([point.x, point.y]);
  if (!coordinates) return;
  geoState.longitude = Math.max(-180, Math.min(180, coordinates[0]));
  geoState.latitude = Math.max(-85, Math.min(85, coordinates[1]));
  renderGeoSelection();
}

function setRadius(value) {
  geoState.radiusKm = Math.max(5, Math.min(5000, Math.round(value / 5) * 5));
  $("radiusRange").value = String(geoState.radiusKm);
  renderGeoSelection();
}

function renderGeoSelection() {
  $("radiusValue").textContent = `${geoState.radiusKm.toLocaleString()} km`;
  if (geoState.latitude === null || geoState.longitude === null || !geoProjection || !geoPath) {
    $("geoSelection").textContent = "No place selected";
    $("mapPin").classList.add("hidden");
    $("mapRadius").classList.add("hidden");
    $("geoMap").setAttribute("viewBox", "0 0 960 480");
    return;
  }

  const [x, y] = geoProjection([geoState.longitude, geoState.latitude]);
  const radiusShape = d3.geoCircle()
    .center([geoState.longitude, geoState.latitude])
    .radius(Math.min(89, geoState.radiusKm / 111.195))();
  $("mapRadius").setAttribute("d", geoPath(radiusShape));
  $("mapRadius").classList.remove("hidden");
  $("mapPin").setAttribute("cx", x);
  $("mapPin").setAttribute("cy", y);
  $("mapPin").classList.remove("hidden");
  $("geoSelection").textContent =
    `${Math.abs(geoState.latitude).toFixed(2)}°${geoState.latitude >= 0 ? "N" : "S"}, ` +
    `${Math.abs(geoState.longitude).toFixed(2)}°${geoState.longitude >= 0 ? "E" : "W"} - ` +
    `${geoState.radiusKm.toLocaleString()} km`;

  const viewWidth = Math.max(130, Math.min(960, 120 + geoState.radiusKm * 0.22));
  const viewHeight = viewWidth / 2;
  const viewX = Math.max(0, Math.min(960 - viewWidth, x - viewWidth / 2));
  const viewY = Math.max(0, Math.min(480 - viewHeight, y - viewHeight / 2));
  $("geoMap").setAttribute("viewBox", `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);
}

async function initGeoMap() {
  if (geoReady) return;
  const world = await fetch("/vendor/countries-110m.json").then((response) => response.json());
  const countries = topojson.feature(world, world.objects.countries);
  geoProjection = d3.geoEquirectangular().fitExtent([[8, 8], [952, 472]], { type: "Sphere" });
  geoPath = d3.geoPath(geoProjection);
  d3.select("#mapCountries")
    .selectAll("path")
    .data(countries.features)
    .join("path")
    .attr("d", geoPath)
    .attr("class", "country");
  geoReady = true;
  renderGeoSelection();
}

function setupMapInteractions() {
  const map = $("geoMap");
  map.addEventListener("wheel", (event) => {
    event.preventDefault();
    setRadius(geoState.radiusKm * (event.deltaY > 0 ? 1.16 : 0.86));
  }, { passive: false });

  map.addEventListener("pointerdown", (event) => {
    map.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) setGeoCenterFromEvent(event);
    if (activePointers.size === 2) {
      const points = [...activePointers.values()];
      pinchStart = {
        distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
        radius: geoState.radiusKm,
      };
    }
  });

  map.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) {
      setGeoCenterFromEvent(event);
    } else if (activePointers.size === 2 && pinchStart) {
      const points = [...activePointers.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (distance > 5) setRadius(pinchStart.radius * pinchStart.distance / distance);
    }
  });

  const endPointer = (event) => {
    activePointers.delete(event.pointerId);
    if (activePointers.size < 2) pinchStart = null;
  };
  map.addEventListener("pointerup", endPointer);
  map.addEventListener("pointercancel", endPointer);
  $("radiusRange").addEventListener("input", (event) => setRadius(Number(event.target.value)));
  $("radiusSmaller").onclick = () => setRadius(geoState.radiusKm * 0.75);
  $("radiusLarger").onclick = () => setRadius(geoState.radiusKm * 1.34);
  $("mapReset").onclick = () => {
    geoState.latitude = null;
    geoState.longitude = null;
    setRadius(500);
  };
}

async function init() {
  setupMapInteractions();
  const config = await call("/api/config");
  if (!config.configured) {
    $("status").querySelector("span").textContent = "Setup needed";
    $("connectionCopy").textContent = "Add the Immich connection to the server settings.";
    $("beginBtn").disabled = true;
    showNotice("The server connection needs to be completed first.");
  } else {
    $("status").classList.add("ok");
    $("status").querySelector("span").textContent = "Ready";
    try {
      albums = await call("/api/albums");
      renderAlbums();
    } catch (error) {
      showNotice(error.message);
    }
  }
  await loadProjects();
}

const shortDate = (value) => value
  ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  : "";

function projectFilterSummary(savedProject) {
  const scope = {
    all: "All photos",
    favorites: "Immich favorites",
    album: `Album: ${albums.find((album) => album.id === savedProject.source_album_id)?.albumName || "selected album"}`,
    uploaded_today: "Uploaded today",
    pune_wedding: "Pune wedding",
    date_range: "All photos",
    geography: "All photos",
  }[savedProject.source_type] || "Photos";
  const parts = [scope];
  const hasCaptureDates = savedProject.source_after && savedProject.source_before
    && savedProject.source_type !== "uploaded_today";
  if (hasCaptureDates) {
    const inclusiveEnd = new Date(new Date(savedProject.source_before).valueOf() - 86400000);
    parts.push(`${shortDate(savedProject.source_after)}–${shortDate(inclusiveEnd)}`);
  }
  if (savedProject.source_latitude !== null && savedProject.source_latitude !== undefined) {
    parts.push(`Near ${Number(savedProject.source_latitude).toFixed(2)}, ${Number(savedProject.source_longitude).toFixed(2)} (${Number(savedProject.source_radius_km).toLocaleString()} km)`);
  }
  return parts.join(" · ");
}

async function loadProjects() {
  const projects = await call("/api/projects");
  $("resume").innerHTML = projects.map((savedProject) => {
    const currentTargetName = albums.find((album) => album.id === savedProject.target_album_id)?.albumName
      || savedProject.target_album_name;
    return (
    `<button data-id="${savedProject.id}"><b>${escapeHtml(projectFilterSummary(savedProject))}</b><br>` +
    `<small>To ${escapeHtml(currentTargetName)} · ${savedProject.decided || 0} reviewed · ${savedProject.accepted || 0} added</small></button>`
    );
  }).join("");
  $("resume").querySelectorAll("button").forEach((button) => {
    button.onclick = () => resumeProject(Number(button.dataset.id), projects);
  });
}

function resumeProject(id, projects) {
  project = projects.find((savedProject) => Number(savedProject.id) === id);
  openChooser();
}

async function openChooser() {
  $("setup").classList.add("hidden");
  $("review").classList.add("hidden");
  $("triage").classList.remove("hidden");
  $("homeBtn").hidden = false;
  $("reviewBtn").hidden = false;
  $("projectTitle").textContent = projectFilterSummary(project);
  await next();
}

async function next() {
  $("photo").style.opacity = ".3";
  try {
    const data = await call(`/api/projects/${project.id}/next?page=${page}`);
    asset = data.asset;
    page = data.page;
    if (!asset) {
      $("photo").classList.add("hidden");
      $("meta").classList.add("hidden");
      $("empty").classList.remove("hidden");
      $("acceptBtn").disabled = $("rejectBtn").disabled = true;
      return;
    }
    $("empty").classList.add("hidden");
    $("photo").classList.remove("hidden");
    $("meta").classList.remove("hidden");
    $("acceptBtn").disabled = $("rejectBtn").disabled = false;
    $("photo").src = `/api/assets/${asset.id}/thumbnail`;
    $("photo").alt = asset.originalFileName || "Photo to choose";
    $("filename").textContent = asset.originalFileName || "";
    $("date").textContent = asset.fileCreatedAt
      ? new Date(asset.fileCreatedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
      : "";
    $("photo").style.opacity = "1";
  } catch (error) {
    alert(error.message);
  }
  await refreshCount();
}

async function decide(decision) {
  if (!asset) return;
  const current = asset;
  asset = null;
  $("photo").style.opacity = ".35";
  try {
    await post(`/api/projects/${project.id}/decisions`, { assetId: current.id, decision });
    await next();
  } catch (error) {
    asset = current;
    $("photo").style.opacity = "1";
    alert(error.message);
  }
}

async function undo() {
  try {
    await post(`/api/projects/${project.id}/undo`, {});
    await next();
  } catch (error) {
    alert(error.message);
  }
}

async function refreshCount() {
  const selected = await call(`/api/projects/${project.id}/selected`);
  $("selectedCount").textContent = selected.length;
}

async function reviewPicks() {
  $("triage").classList.add("hidden");
  $("review").classList.remove("hidden");
  $("homeBtn").hidden = false;
  const selected = await call(`/api/projects/${project.id}/selected`);
  $("grid").innerHTML = selected.length
    ? selected.map((item) => `<img loading="lazy" src="/api/assets/${item.asset_id}/thumbnail" alt="Chosen photo">`).join("")
    : "<p>You have not added any photos yet.</p>";
}

async function nextCleanup() {
  $("cleanupPhoto").style.opacity = ".3";
  try {
    const data = await call("/api/cleanup/next");
    cleanupAsset = data.asset;
    if (!cleanupAsset) {
      $("cleanupPhoto").classList.add("hidden");
      $("cleanupMeta").classList.add("hidden");
      $("cleanupEmpty").classList.remove("hidden");
      $("cleanupKeepBtn").disabled = $("cleanupTrashBtn").disabled = true;
      return;
    }
    $("cleanupEmpty").classList.add("hidden");
    $("cleanupPhoto").classList.remove("hidden");
    $("cleanupMeta").classList.remove("hidden");
    $("cleanupKeepBtn").disabled = $("cleanupTrashBtn").disabled = false;
    $("cleanupPhoto").src = `/api/assets/${cleanupAsset.id}/thumbnail`;
    $("cleanupPhoto").alt = cleanupAsset.originalFileName || "Random photo";
    $("cleanupFilename").textContent = cleanupAsset.originalFileName || "";
    $("cleanupDate").textContent = cleanupAsset.fileCreatedAt
      ? new Date(cleanupAsset.fileCreatedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
      : "";
    $("cleanupProgress").textContent = `${data.seen || 0} reviewed · ${data.trashed || 0} moved to trash`;
    $("cleanupPhoto").style.opacity = "1";
  } catch (error) {
    alert(error.message);
  }
}

async function cleanupDecide(decision) {
  if (!cleanupAsset) return;
  const current = cleanupAsset;
  cleanupAsset = null;
  $("cleanupPhoto").style.opacity = ".35";
  try {
    await post("/api/cleanup/decision", { assetId: current.id, decision });
    await nextCleanup();
  } catch (error) {
    cleanupAsset = current;
    $("cleanupPhoto").style.opacity = "1";
    alert(error.message);
  }
}

async function cleanupUndo() {
  try {
    await post("/api/cleanup/undo", {});
    await nextCleanup();
  } catch (error) {
    alert(error.message);
  }
}

function openCleanup() {
  $("setup").classList.add("hidden");
  $("triage").classList.add("hidden");
  $("review").classList.add("hidden");
  $("cleanup").classList.remove("hidden");
  $("homeBtn").hidden = false;
  $("reviewBtn").hidden = true;
  nextCleanup();
}

async function goHome() {
  asset = null;
  cleanupAsset = null;
  $("triage").classList.add("hidden");
  $("review").classList.add("hidden");
  $("cleanup").classList.add("hidden");
  $("setup").classList.remove("hidden");
  $("homeBtn").hidden = true;
  $("reviewBtn").hidden = true;
  page = 1;
  await loadProjects();
}

$("sourceType").onchange = async (event) => {
  const value = event.target.value;
  $("sourceAlbumRow").classList.toggle("hidden", value !== "album");
};

$("useDateRange").onchange = (event) => {
  $("dateRangeRow").classList.toggle("hidden", !event.target.checked);
};

$("useGeography").onchange = async (event) => {
  $("geographyRow").classList.toggle("hidden", !event.target.checked);
  if (event.target.checked) {
    try {
      await initGeoMap();
    } catch {
      showNotice("The map could not be loaded. Refresh the page and try again.");
    }
  }
};

$("newAlbumBtn").onclick = () => $("albumDialog").showModal();
$("createAlbumBtn").onclick = async (event) => {
  event.preventDefault();
  try {
    const album = await post("/api/albums", { albumName: $("albumName").value });
    albums.unshift(album);
    renderAlbums();
    $("targetAlbum").value = album.id;
    $("albumDialog").close();
  } catch (error) {
    alert(error.message);
  }
};

$("beginBtn").onclick = async () => {
  const target = albums.find((album) => album.id === $("targetAlbum").value);
  const button = $("beginBtn");
  try {
    const sourceType = $("sourceType").value;
    const window = sourceType === "uploaded_today"
      ? todayWindow()
      : $("useDateRange").checked ? captureRangeWindow() : {};
    if ($("useGeography").checked && geoState.latitude === null) {
      throw new Error("Tap or click a place on the map first.");
    }
    button.disabled = true;
    button.firstChild.textContent = $("useGeography").checked ? "Finding photos in this area " : "Opening your photos ";
    project = await post("/api/projects", {
      sourceType,
      sourceAlbumId: $("sourceAlbum").value,
      ...window,
      sourceLatitude: $("useGeography").checked ? geoState.latitude : null,
      sourceLongitude: $("useGeography").checked ? geoState.longitude : null,
      sourceRadiusKm: $("useGeography").checked ? geoState.radiusKm : null,
      shuffle: $("sourceOrder").value === "shuffle",
      targetAlbumId: target?.id,
      targetAlbumName: target?.albumName,
    });
    await openChooser();
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
    button.firstChild.textContent = "Start choosing ";
  }
};

$("acceptBtn").onclick = () => decide("accepted");
$("rejectBtn").onclick = () => decide("rejected");
$("undoBtn").onclick = undo;
$("reviewBtn").onclick = reviewPicks;
$("backBtn").onclick = openChooser;
$("cleanupBtn").onclick = () => $("cleanupDialog").showModal();
$("startCleanupBtn").onclick = (event) => {
  event.preventDefault();
  $("cleanupDialog").close();
  openCleanup();
};
$("cleanupKeepBtn").onclick = () => cleanupDecide("kept");
$("cleanupTrashBtn").onclick = () => cleanupDecide("trashed");
$("cleanupUndoBtn").onclick = cleanupUndo;
$("cleanupExitBtn").onclick = goHome;
$("homeBtn").onclick = goHome;

document.addEventListener("keydown", (event) => {
  if (!$("triage").classList.contains("hidden") && !event.repeat) {
    if (event.key === "ArrowRight") decide("accepted");
    if (event.key === "ArrowLeft") decide("rejected");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") undo();
  }
  if (!$("cleanup").classList.contains("hidden") && !event.repeat) {
    if (event.key === "ArrowLeft") cleanupDecide("kept");
    if (event.key === "ArrowRight") cleanupDecide("trashed");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") cleanupUndo();
  }
});

$("cleanupPhotoShell").addEventListener("touchstart", (event) => {
  cleanupTouchX = event.touches[0].clientX;
}, { passive: true });
$("cleanupPhotoShell").addEventListener("touchend", (event) => {
  if (cleanupTouchX === null) return;
  const delta = event.changedTouches[0].clientX - cleanupTouchX;
  if (Math.abs(delta) > 70) cleanupDecide(delta > 0 ? "trashed" : "kept");
  cleanupTouchX = null;
}, { passive: true });

$("photoShell").addEventListener("touchstart", (event) => {
  touchX = event.touches[0].clientX;
}, { passive: true });
$("photoShell").addEventListener("touchend", (event) => {
  if (touchX === null) return;
  const delta = event.changedTouches[0].clientX - touchX;
  if (Math.abs(delta) > 70) decide(delta > 0 ? "accepted" : "rejected");
  touchX = null;
}, { passive: true });

init().catch((error) => showNotice(error.message));
