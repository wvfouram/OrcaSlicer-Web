"""OrcaSlicer-Web server: serves the browser UI, slices with the engine, sends prints to a Bambu printer on the LAN."""
import asyncio, json, os, re, shutil, sys, uuid, zipfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import Engine, default_engine_path  # noqa: E402
from printer import BambuPrinter  # noqa: E402
from profiles import ProfileStore  # noqa: E402

# Packaged build: the server .exe sits next to static/, profiles/ and engine/. Source checkout: this file is web/server/app.py.
WEB_ROOT = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_ROOT = os.path.dirname(WEB_ROOT)
DATA_DIR = os.environ.get("ORCAWEB_DATA", os.path.join(WEB_ROOT, "data"))
PROFILE_DIR = os.environ.get("ORCA_PROFILES", next(
    p for p in [os.path.join(WEB_ROOT, "profiles", "BBL"), os.path.join(APP_ROOT, "resources", "profiles", "BBL")] if os.path.isdir(p)))
UPLOADS = os.path.join(DATA_DIR, "uploads")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
MODEL_EXT = {".stl", ".3mf", ".step", ".stp", ".obj", ".drc", ".amf"}

os.makedirs(UPLOADS, exist_ok=True)
store = ProfileStore(PROFILE_DIR)
app = FastAPI(title="OrcaSlicer-Web")
engine: Engine | None = None
printer: BambuPrinter | None = None
uploads: dict[str, dict] = {}
send_progress: dict[str, dict] = {}


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=1)


@app.on_event("startup")
async def startup():
    global engine, printer
    engine = Engine(default_engine_path(WEB_ROOT if os.path.isdir(os.path.join(WEB_ROOT, "engine")) else APP_ROOT),
                    store, os.path.join(DATA_DIR, "jobs"))
    p = load_config().get("printer")
    if p and p.get("ip"):
        printer = BambuPrinter(p["ip"], p["serial"], p["access_code"])
        printer.connect()


# ---------------- profiles ----------------
_compat_cache: dict[str, list] = {}


def _compatible(name, printer_name):
    if name not in _compat_cache:
        _compat_cache[name] = store.resolve(name).get("compatible_printers") or []
    comp = _compat_cache[name]
    return not comp or printer_name in comp


@app.get("/api/profiles")
def profiles(printer_name: str = "Bambu Lab P1S 0.4 nozzle"):
    if printer_name not in store.by_name:
        raise HTTPException(404, f"Unknown printer {printer_name}")
    m = store.resolve(printer_name)
    procs = [n for n in store.list("process") if _compatible(n, printer_name)]
    fils = [n for n in store.list("filament") if _compatible(n, printer_name)]
    return {
        "printers": [n for n in store.list("machine") if n.startswith("Bambu Lab")],
        "processes": procs, "filaments": fils,
        "default_process": m.get("default_print_profile"),
        "default_filament": (m.get("default_filament_profile") or [None])[0] if (m.get("default_filament_profile") or [None])[0] in fils else (fils[0] if fils else None),
        "bed": {"size": m.get("printable_area"), "height": m.get("printable_height"), "exclude": m.get("bed_exclude_area") or []},
    }


@app.get("/api/profile")
def profile(name: str):
    if name not in store.by_name:
        raise HTTPException(404)
    return store.flat(name)


# ---------------- models + slicing ----------------
@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in MODEL_EXT:
        raise HTTPException(400, f"Unsupported file type {ext}")
    mid = uuid.uuid4().hex[:12]
    safe = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(file.filename))
    d = os.path.join(UPLOADS, mid)
    os.makedirs(d)
    path = os.path.join(d, safe)
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    uploads[mid] = {"id": mid, "name": safe, "path": path}
    return {"id": mid, "name": safe, "url": f"/api/upload/{mid}"}


@app.get("/api/upload/{mid}")
def get_upload(mid: str):
    if mid not in uploads:
        raise HTTPException(404)
    return FileResponse(uploads[mid]["path"])


class SliceRequest(BaseModel):
    models: list[str]
    printer: str
    process: str
    filaments: list[str]
    filament_ids: list[int] = []
    overrides: dict = {}


@app.post("/api/slice")
async def slice_(req: SliceRequest):
    paths = []
    for mid in req.models:
        if mid not in uploads:
            raise HTTPException(404, f"Model {mid} not found (re-upload it)")
        paths.append(uploads[mid]["path"])
    for n in [req.printer, req.process, *req.filaments]:
        if n not in store.by_name:
            raise HTTPException(400, f"Unknown profile {n}")
    if any(not 1 <= f <= len(req.filaments) for f in req.filament_ids):
        raise HTTPException(400, "Object filament number out of range")
    job = engine.submit(paths, req.printer, req.process, req.filaments, req.overrides, req.filament_ids)
    engine.cleanup()
    return job.public()


def _job(jid):
    job = engine.jobs.get(jid)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    return _job(jid).public()


@app.get("/api/jobs/{jid}/gcode")
def job_gcode(jid: str):
    job = _job(jid)
    if job.status != "done":
        raise HTTPException(409, "Not sliced yet")
    return FileResponse(job.gcode_path, media_type="text/plain")


@app.get("/api/jobs/{jid}/3mf")
def job_3mf(jid: str):
    job = _job(jid)
    if job.status != "done":
        raise HTTPException(409, "Not sliced yet")
    return FileResponse(job.project_path, filename="plate.gcode.3mf")


# ---------------- printer ----------------
class PrinterConfig(BaseModel):
    ip: str
    serial: str
    access_code: str


@app.get("/api/printer/config")
def get_printer_config():
    p = load_config().get("printer") or {}
    return {"ip": p.get("ip", ""), "serial": p.get("serial", ""), "has_code": bool(p.get("access_code"))}


@app.post("/api/printer/config")
def set_printer_config(cfg: PrinterConfig):
    global printer
    c = load_config()
    old = c.get("printer") or {}
    data = cfg.model_dump()
    if not data["access_code"].strip():  # blank = keep the saved code
        data["access_code"] = old.get("access_code", "")
    if not data["access_code"]:
        raise HTTPException(400, "Access code is required")
    c["printer"] = data
    save_config(c)
    if printer:
        printer.disconnect()
    printer = BambuPrinter(data["ip"].strip(), data["serial"].strip(), data["access_code"].strip())
    printer.connect()
    return {"ok": True}


@app.get("/api/printer/status")
def printer_status():
    if not printer:
        return {"configured": False}
    return {"configured": True, **printer.status()}


@app.post("/api/printer/{cmd}")
def printer_cmd(cmd: str):
    if cmd not in ("pause", "resume", "stop"):
        raise HTTPException(404)
    if not printer:
        raise HTTPException(400, "Printer not set up")
    try:
        printer.command(cmd)
    except ConnectionError as e:
        raise HTTPException(503, str(e))
    return {"ok": True}


class PrintRequest(BaseModel):
    job_id: str
    name: str = "orcaweb"
    use_ams: bool = True
    ams_mapping: list[int] | None = None
    bed_leveling: bool = True
    timelapse: bool = False


@app.post("/api/print")
async def start_print(req: PrintRequest):
    job = _job(req.job_id)
    if job.status != "done":
        raise HTTPException(409, "Slice first")
    if not printer:
        raise HTTPException(400, "Printer not set up")
    if not printer.connected:
        raise HTTPException(503, printer.last_error or "Printer not connected")
    remote = re.sub(r"[^A-Za-z0-9_-]", "_", req.name)[:40] + ".gcode.3mf"
    with zipfile.ZipFile(job.project_path) as z:
        md5 = z.read("Metadata/plate_1.gcode.md5").decode().strip()
    send_progress[job.id] = {"stage": "uploading", "progress": 0.0}

    def work():
        printer.upload(job.project_path, remote, progress=lambda f: send_progress[job.id].update(progress=f))
        send_progress[job.id] = {"stage": "starting", "progress": 1.0}
        printer.start_print(remote, md5, use_ams=req.use_ams, ams_mapping=req.ams_mapping,
                            bed_leveling=req.bed_leveling, timelapse=req.timelapse)
        send_progress[job.id] = {"stage": "sent", "progress": 1.0}

    async def run():
        try:
            await asyncio.to_thread(work)
        except Exception as e:
            send_progress[job.id] = {"stage": "error", "error": f"{type(e).__name__}: {e}"}
    asyncio.get_event_loop().create_task(run())
    return {"ok": True}


@app.get("/api/print/{jid}")
def print_progress(jid: str):
    return send_progress.get(jid, {"stage": "idle"})


app.mount("/", StaticFiles(directory=os.path.join(WEB_ROOT, "static"), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("ORCAWEB_HOST", "0.0.0.0")
    port = int(os.environ.get("ORCAWEB_PORT", "8765"))
    print(f"OrcaSlicer-Web running: open http://localhost:{port} on this PC, or http://<this PC's IP>:{port} on your phone")
    uvicorn.run(app, host=host, port=port, log_level="warning")
