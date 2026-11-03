import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";

const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, opts);
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.detail || body || r.statusText);
  return body;
};
const toast = (msg, isError = false, ms = 4000) => {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
  clearTimeout(toast._t); if (ms) toast._t = setTimeout(() => (t.hidden = true), ms);
};
const fmtTime = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };

// ---------------- 3D scene ----------------
const canvas = $("#view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171a);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(150, -200, 300); scene.add(sun);
const prepareGroup = new THREE.Group(), previewGroup = new THREE.Group(), bedGroup = new THREE.Group();
scene.add(bedGroup, prepareGroup, previewGroup);
let bed = { w: 256, d: 256, h: 256, exclude: [] };

function buildBed() {
  bedGroup.clear();
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.w, bed.d), new THREE.MeshStandardMaterial({ color: 0x2a2f35, roughness: .9 }));
  plate.position.set(bed.w / 2, bed.d / 2, -0.05); bedGroup.add(plate);
  const grid = new THREE.GridHelper(Math.max(bed.w, bed.d), Math.max(bed.w, bed.d) / 10, 0x48505a, 0x363c43);
  grid.rotation.x = Math.PI / 2; grid.position.set(bed.w / 2, bed.d / 2, 0); bedGroup.add(grid);
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.w, bed.d, bed.h)), new THREE.LineBasicMaterial({ color: 0x3a4149 }));
  box.position.set(bed.w / 2, bed.d / 2, bed.h / 2); bedGroup.add(box);
  // Exclusion zone (P1S: front-left corner over the purge chute and cutter). The engine keeps parts out of it.
  if (bed.exclude.length >= 3) {
    const shape = new THREE.Shape(bed.exclude.map(([x, y]) => new THREE.Vector2(x, y)));
    const zone = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0xe05252, transparent: true, opacity: .35 }));
    zone.position.z = 0.02; bedGroup.add(zone);
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(bed.exclude.map(([x, y]) => new THREE.Vector3(x, y, 0.05))),
                                       new THREE.LineBasicMaterial({ color: 0xe05252 }));
    bedGroup.add(outline);
  }
  controls.target.set(bed.w / 2, bed.d / 2, 20);
  camera.position.set(bed.w / 2, -bed.d * 0.9, bed.h * 0.9);
}
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ---------------- models ----------------
const models = []; // {id, name, file, object3d}
const modelMat = new THREE.MeshStandardMaterial({ color: 0x19b27a, roughness: .55, metalness: .05 });

async function addFiles(files) {
  for (const file of files) {
    try {
      toast(`Uploading ${file.name}...`, false, 0);
      const fd = new FormData(); fd.append("file", file);
      const up = await api("/api/upload", { method: "POST", body: fd });
      const m = { id: up.id, name: up.name, filament: 1, object3d: await loadPreviewMesh(file) };
      models.push(m);
      if (m.object3d) prepareGroup.add(m.object3d);
      toast(`Added ${file.name}`);
    } catch (e) { toast(`Could not add ${file.name}: ${e.message}`, true, 8000); }
  }
  layoutModels(); renderObjectList(); setView("prepare");
}

async function loadPreviewMesh(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  const buf = await file.arrayBuffer();
  let obj = null;
  if (ext === "stl") obj = new THREE.Mesh(new STLLoader().parse(buf), modelMat);
  else if (ext === "3mf") {
    try { obj = new ThreeMFLoader().parse(buf); } catch { obj = null; }
    obj?.traverse((o) => { if (o.isMesh) o.material = modelMat; });
  }
  if (!obj) return null; // STEP/OBJ/etc: the engine still slices them; there's just no pre-slice preview yet
  const wrap = new THREE.Group(); wrap.add(obj);
  return wrap;
}

// Simple side-by-side layout for the pre-slice view; the engine arranges the real plate.
function layoutModels() {
  let x = 0; const items = models.filter((m) => m.object3d);
  const boxes = items.map((m) => { m.object3d.position.set(0, 0, 0); return new THREE.Box3().setFromObject(m.object3d); });
  const total = boxes.reduce((s, b) => s + (b.max.x - b.min.x) + 10, -10);
  x = bed.w / 2 - total / 2;
  items.forEach((m, i) => {
    const b = boxes[i], w = b.max.x - b.min.x;
    m.object3d.position.set(x - b.min.x, bed.d / 2 - (b.min.y + b.max.y) / 2, -b.min.z);
    x += w + 10;
  });
  $("#dropHint").classList.toggle("hidden", models.length > 0);
  $("#btnSlice").disabled = models.length === 0;
}

function tintModel(m) {
  const color = new THREE.Color(filaments[m.filament - 1]?.color || "#19b27a");
  m.object3d?.traverse((o) => { if (o.isMesh) { o.material = modelMat.clone(); o.material.color = color; } });
}
function renderObjectList() {
  const ul = $("#objectList"); ul.innerHTML = "";
  if (!models.length) { ul.innerHTML = '<li class="muted">No models yet</li>'; return; }
  for (const m of models) {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><select title="Filament"></select><button class="x" title="Remove">×</button>`;
    li.querySelector("span").textContent = m.name + (m.object3d ? "" : " (no preview)");
    const fsel = li.querySelector("select");
    filaments.forEach((_, i) => fsel.add(new Option(`F${i + 1}`, i + 1, false, m.filament === i + 1)));
    if (m.filament > filaments.length) m.filament = 1;
    fsel.onchange = () => { m.filament = +fsel.value; tintModel(m); };
    tintModel(m);
    li.querySelector("button").onclick = () => {
      models.splice(models.indexOf(m), 1); if (m.object3d) prepareGroup.remove(m.object3d);
      layoutModels(); renderObjectList();
    };
    ul.appendChild(li);
  }
}

const vp = $(".viewport");
vp.addEventListener("dragover", (e) => { e.preventDefault(); vp.classList.add("dragging"); });
vp.addEventListener("dragleave", () => vp.classList.remove("dragging"));
vp.addEventListener("drop", (e) => { e.preventDefault(); vp.classList.remove("dragging"); addFiles([...e.dataTransfer.files]); });
$("#fileInput").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };

// ---------------- profiles + settings ----------------
let profileData = null;
const DEFAULT_COLORS = ["#ffffff", "#1a1a1a", "#d43a2f", "#2f6fd4", "#f2c230", "#2fb35a", "#8a4fd4", "#f28c30"];
const filaments = []; // {name, color}

function fillSelect(sel, items, value) {
  sel.innerHTML = ""; for (const it of items) sel.add(new Option(it, it, false, it === value));
}
async function loadProfiles(printerName) {
  profileData = await api(`/api/profiles?printer_name=${encodeURIComponent(printerName)}`);
  fillSelect($("#selPrinter"), profileData.printers, printerName);
  const proc = profileData.processes.includes(localStorage.process) ? localStorage.process
    : profileData.processes.includes(profileData.default_process) ? profileData.default_process : profileData.processes[0];
  fillSelect($("#selProcess"), profileData.processes, proc);
  if (!filaments.length) filaments.push({ name: profileData.default_filament, color: DEFAULT_COLORS[0] });
  filaments.forEach((f) => { if (!profileData.filaments.includes(f.name)) f.name = profileData.default_filament; });
  renderFilaments();
  const area = (profileData.bed.size || []).map((p) => p.split("x").map(Number));
  if (area.length) bed = { w: Math.max(...area.map((p) => p[0])), d: Math.max(...area.map((p) => p[1])), h: Number(profileData.bed.height) || 256,
                           exclude: (profileData.bed.exclude || []).map((p) => p.split("x").map(Number)) };
  buildBed(); layoutModels();
  await loadProcessValues(proc);
}
function renderFilaments() {
  const box = $("#filamentRows"); box.innerHTML = "";
  filaments.forEach((f, i) => {
    const row = document.createElement("div"); row.className = "fil-row";
    row.innerHTML = `<span class="num">${i + 1}</span><input type="color" class="swatch"><select></select>${i ? '<button class="link" title="Remove">×</button>' : ""}`;
    const sel = row.querySelector("select"); fillSelect(sel, profileData.filaments, f.name);
    sel.onchange = () => (f.name = sel.value);
    const sw = row.querySelector("input"); sw.value = f.color; sw.oninput = () => (f.color = sw.value);
    sw.addEventListener("change", renderObjectList);
    row.querySelector("button")?.addEventListener("click", () => { filaments.splice(i, 1); renderFilaments(); renderObjectList(); });
    box.appendChild(row);
  });
}
$("#addFilament").onclick = () => {
  filaments.push({ name: filaments.at(-1)?.name || profileData.default_filament, color: DEFAULT_COLORS[filaments.length % DEFAULT_COLORS.length] });
  renderFilaments(); renderObjectList();
};
$("#selPrinter").onchange = (e) => { localStorage.printer = e.target.value; loadProfiles(e.target.value); };
$("#selProcess").onchange = (e) => { localStorage.process = e.target.value; loadProcessValues(e.target.value); };

const settingInputs = [...document.querySelectorAll("[data-key]")];
const dirty = new Set();
settingInputs.forEach((el) => el.addEventListener("change", () => dirty.add(el.dataset.key)));
async function loadProcessValues(name) {
  const p = await api(`/api/profile?name=${encodeURIComponent(name)}`);
  for (const el of settingInputs) {
    if (dirty.has(el.dataset.key) || el.dataset.webdefault !== undefined) continue; // keep user changes and web-version defaults
    let v = p[el.dataset.key]; if (Array.isArray(v)) v = v[0];
    if (v === undefined) continue;
    if (el.dataset.bool !== undefined) el.checked = v === "1" || v === true;
    else if (el.dataset.suffix) el.value = String(v).replace(el.dataset.suffix, "");
    else el.value = v;
  }
}
function collectOverrides() {
  const o = {};
  for (const el of settingInputs) {
    const k = el.dataset.key;
    if (el.dataset.bool !== undefined) { o[k] = el.checked ? "1" : "0"; continue; } // always sent: web defaults differ from Orca
    if (!dirty.has(k)) continue;
    o[k] = el.value + (el.dataset.suffix || "");
  }
  o._filament_colors = filaments.map((f) => f.color.toUpperCase());
  return o;
}

// ---------------- slicing ----------------
let currentJob = null;
$("#btnSlice").onclick = async () => {
  const btn = $("#btnSlice"); btn.disabled = true; btn.textContent = "Slicing...";
  try {
    let job = await api("/api/slice", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: models.map((m) => m.id), printer: $("#selPrinter").value, process: $("#selProcess").value,
                             filaments: filaments.map((f) => f.name), filament_ids: models.map((m) => m.filament), overrides: collectOverrides() }),
    });
    while (job.status === "queued" || job.status === "slicing") {
      await new Promise((r) => setTimeout(r, 400));
      job = await api(`/api/jobs/${job.id}`);
      btn.textContent = `Slicing... ${job.seconds}s`;
    }
    if (job.status === "error") throw new Error(job.error + (job.log_tail ? "\n" + job.log_tail.split("\n").slice(-6).join("\n") : ""));
    currentJob = job; showResult(job);
    await loadPreview(job.id);
    toast(`Sliced in ${job.seconds}s`);
  } catch (e) { toast(`Slicing failed: ${e.message}`, true, 12000); }
  finally { btn.disabled = models.length === 0; btn.textContent = "Slice"; }
};

function showResult(job) {
  const s = job.stats || {};
  const rows = [["Print time", fmtTime(s.print_time_s)], ["Filament", `${(s.weight_g || 0).toFixed(1)} g`],
                ["Layers", s.layers ?? "-"], ["Filament changes", s.filament_changes ?? 0], ["Slice time", `${job.seconds}s`]];
  const flush = (s.filaments || []).reduce((a, f) => a + (f.flush_g || 0) + (f.prime_tower_g || 0), 0);
  if (flush > 0) rows.splice(2, 0, ["Purge + tower", `${flush.toFixed(1)} g`]);
  $("#stats").innerHTML = rows.map(([k, v]) => `<span class="muted">${k}</span><b>${v}</b>`).join("");
  $("#warnings").textContent = (job.warnings || []).map((w) => w.msg || w.message || JSON.stringify(w)).join("\n");
  $("#dl3mf").href = `/api/jobs/${job.id}/3mf`;
  $("#resultCard").hidden = false;
  renderAmsMap();
}

// ---------------- G-code preview ----------------
let preview = null;
async function loadPreview(jobId) {
  const text = await (await fetch(`/api/jobs/${jobId}/gcode`)).text();
  const data = await new Promise((resolve, reject) => {
    const w = new Worker("gcode-worker.js");
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate(); };
    w.postMessage(text);
  });
  const n = data.features.length, colors = new Float32Array(n * 6), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setHex(data.featureColors[data.features[i]]);
    colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  previewGroup.clear();
  previewGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true })));
  preview = { geo, ...data };
  const sl = $("#layerSlider"); sl.max = data.layerZ.length - 1; sl.value = sl.max; setLayer(+sl.value);
  const used = new Set(data.features);
  $("#legend").innerHTML = data.featureNames.map((name, i) => used.has(i)
    ? `<i style="background:#${data.featureColors[i].toString(16).padStart(6, "0")}"></i><span>${name}</span><span class="t">${fmtTime((currentJob?.stats?.features || {})[name])}</span>` : "").join("");
  $("#tabPreview").disabled = false; setView("preview");
}
function setLayer(i) {
  if (!preview) return;
  preview.geo.setDrawRange(0, preview.layerStart[i + 1] * 2);
  $("#layerLabel").textContent = `Layer ${i + 1} / ${preview.layerZ.length} · ${preview.layerZ[i].toFixed(2)} mm`;
}
$("#layerSlider").oninput = (e) => setLayer(+e.target.value);
window.addEventListener("keydown", (e) => {
  if (!preview || $("#layerBar").hidden || e.target.matches("input, select")) return;
  const sl = $("#layerSlider");
  if (e.key === "ArrowUp") sl.value = Math.min(+sl.max, +sl.value + 1); else if (e.key === "ArrowDown") sl.value = Math.max(0, +sl.value - 1); else return;
  setLayer(+sl.value); e.preventDefault();
});

function setView(v) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  prepareGroup.visible = v === "prepare"; previewGroup.visible = v === "preview";
  $("#layerBar").hidden = $("#legend").hidden = v !== "preview" || !preview;
  $("#dropHint").classList.toggle("hidden", v === "preview" || models.length > 0);
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => !t.disabled && setView(t.dataset.view)));

// ---------------- printer ----------------
let printerStatus = { configured: false };
$("#printerPill").onclick = async () => {
  const cfg = await api("/api/printer/config"); const f = $("#printerForm");
  f.ip.value = cfg.ip; f.serial.value = cfg.serial; f.access_code.value = ""; f.access_code.placeholder = cfg.has_code ? "(saved, leave blank to keep)" : "8 digits";
  f.access_code.required = !cfg.has_code;
  $("#printerDialog").showModal();
};
$("#printerDialog").addEventListener("close", async () => {
  if ($("#printerDialog").returnValue !== "save") return;
  const f = $("#printerForm");
  try {
    await api("/api/printer/config", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ip: f.ip.value, serial: f.serial.value, access_code: f.access_code.value }) });
    toast("Printer saved, connecting...");
  } catch (e) { toast(`Could not save printer: ${e.message}`, true); }
});

async function pollPrinter() {
  try { printerStatus = await api("/api/printer/status"); } catch { printerStatus = { configured: false }; }
  const s = printerStatus, dot = $("#printerDot");
  dot.className = "dot" + (s.connected ? " on" : s.configured ? " err" : "");
  $("#printerPillText").textContent = !s.configured ? "Printer not set up" : !s.connected ? (s.error ? "Printer error" : "Connecting...")
    : s.state === "RUNNING" ? `Printing ${s.percent ?? 0}%` : (s.state || "Connected").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  $("#statusCard").hidden = !s.configured;
  if (s.configured) {
    $("#statusBody").innerHTML = !s.connected ? `<div class="muted">${s.error || "Connecting to printer..."}</div>` : `
      <div class="stats">
        <span class="muted">State</span><b>${s.state ?? "-"}</b>
        <span class="muted">Job</span><b>${s.job || "-"}</b>
        <span class="muted">Progress</span><b>${s.percent ?? 0}% · layer ${s.layer ?? 0}/${s.total_layers ?? 0}</b>
        <span class="muted">Remaining</span><b>${s.remaining_min != null ? fmtTime(s.remaining_min * 60) : "-"}</b>
        <span class="muted">Nozzle</span><b>${Math.round(s.nozzle ?? 0)} / ${Math.round(s.nozzle_target ?? 0)} °C</b>
        <span class="muted">Bed</span><b>${Math.round(s.bed ?? 0)} / ${Math.round(s.bed_target ?? 0)} °C</b>
      </div>`;
  }
  setTimeout(pollPrinter, 3000);
}
document.querySelectorAll("[data-cmd]").forEach((b) => (b.onclick = async () => {
  if (b.dataset.cmd === "stop" && !confirmStop()) return;
  try { await api(`/api/printer/${b.dataset.cmd}`, { method: "POST" }); toast(`Sent ${b.dataset.cmd}`); }
  catch (e) { toast(e.message, true); }
}));
function confirmStop() {
  const b = document.querySelector('[data-cmd="stop"]');
  if (b.dataset.armed) { delete b.dataset.armed; b.textContent = "Stop"; return true; }
  b.dataset.armed = "1"; b.textContent = "Tap again to stop";
  setTimeout(() => { delete b.dataset.armed; b.textContent = "Stop"; }, 3000);
  return false;
}

function renderAmsMap() {
  const box = $("#amsMap"); box.innerHTML = "";
  const slots = printerStatus.ams || [];
  filaments.forEach((f, i) => {
    const lab = document.createElement("label");
    lab.textContent = `Filament ${i + 1} → AMS slot`;
    const sel = document.createElement("select"); sel.dataset.fil = i;
    const opts = slots.length ? slots.map((t) => [t.unit * 4 + t.slot, `AMS ${t.unit + 1} slot ${t.slot + 1}: ${t.type || "empty"}${t.name ? " " + t.name : ""}`])
      : [0, 1, 2, 3, 4, 5, 6, 7].map((n) => [n, `AMS ${Math.floor(n / 4) + 1} slot ${(n % 4) + 1}`]);
    for (const [v, t] of opts) sel.add(new Option(t, v, false, v === i));
    lab.appendChild(sel); box.appendChild(lab);
  });
}

$("#btnPrint").onclick = async () => {
  if (!currentJob) return;
  const msg = $("#printMsg");
  try {
    const mapping = [...document.querySelectorAll("#amsMap select")].map((s) => +s.value);
    await api("/api/print", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      job_id: currentJob.id, name: $("#jobName").value || "orcaweb", use_ams: $("#optAms").checked,
      ams_mapping: $("#optAms").checked ? mapping : null, bed_leveling: $("#optLevel").checked, timelapse: $("#optTimelapse").checked }) });
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const p = await api(`/api/print/${currentJob.id}`);
      if (p.stage === "uploading") msg.textContent = `Uploading to printer... ${Math.round(p.progress * 100)}%`;
      else if (p.stage === "starting") msg.textContent = "Starting print...";
      else if (p.stage === "sent") { msg.textContent = "Print started."; break; }
      else if (p.stage === "error") throw new Error(p.error);
    }
  } catch (e) { msg.textContent = ""; toast(`Print failed: ${e.message}`, true, 10000); }
};

// ---------------- start ----------------
buildBed(); resize();
loadProfiles(localStorage.printer || "Bambu Lab P1S 0.4 nozzle").catch((e) => toast(`Could not load profiles: ${e.message}`, true, 0));
pollPrinter();
