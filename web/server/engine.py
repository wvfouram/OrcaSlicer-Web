"""Runs the OrcaSlicer engine headless (its command-line mode) for one slicing job."""
import asyncio, json, os, shutil, subprocess, sys, time, uuid
from dataclasses import dataclass, field

from profiles import ProfileStore


def default_engine_path(root):
    """Engine shipped next to the web folder: engine/orca-slicer.exe (Windows) or engine/AppRun (Linux)."""
    env = os.environ.get("ORCA_ENGINE")
    if env:
        return env
    names = ["orca-slicer.exe", "OrcaSlicer.exe"] if sys.platform == "win32" else ["AppRun", "orca-slicer", "bin/orca-slicer"]
    for n in names:
        p = os.path.join(root, "engine", n)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f"Slicing engine not found in {os.path.join(root, 'engine')}; set ORCA_ENGINE")


@dataclass
class Job:
    id: str
    dir: str
    status: str = "queued"          # queued | slicing | done | error
    started: float = 0.0
    finished: float = 0.0
    error: str = ""
    result: dict = field(default_factory=dict)
    stats: dict = field(default_factory=dict)
    log_tail: str = ""

    def public(self):
        return {"id": self.id, "status": self.status, "error": self.error,
                "seconds": round((self.finished or time.time()) - self.started, 2) if self.started else 0,
                "warnings": self.result.get("warnings", []), "stats": self.stats,
                "has_gcode": os.path.exists(self.gcode_path), "log_tail": self.log_tail if self.status == "error" else ""}

    @property
    def gcode_path(self):
        return os.path.join(self.dir, "out", "plate_1.gcode")

    @property
    def project_path(self):
        return os.path.join(self.dir, "out", "plate.gcode.3mf")


class Engine:
    def __init__(self, exe, store: ProfileStore, work_dir, max_parallel=1):
        self.exe, self.store, self.work_dir = exe, store, work_dir
        self.jobs: dict[str, Job] = {}
        self._sem = asyncio.Semaphore(max_parallel)
        os.makedirs(work_dir, exist_ok=True)

    def _write_profile(self, name, overrides, out_dir, filename, add_missing=False):
        """Flatten a system profile and apply overrides. Values are strings (or lists of strings), as in Orca's JSON."""
        data = self.store.flat(name)
        for k, v in (overrides or {}).items():
            cur = data.get(k)
            if cur is None and not add_missing:
                continue
            if isinstance(cur, list):
                data[k] = [str(x) for x in v] if isinstance(v, list) else [str(v)] * max(1, len(cur))
            else:
                data[k] = str(v)
        path = os.path.join(out_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
        return path

    def submit(self, model_paths, printer, process, filaments, overrides=None, filament_ids=None):
        job = Job(id=uuid.uuid4().hex[:12], dir=os.path.join(self.work_dir, uuid.uuid4().hex[:12]))
        os.makedirs(os.path.join(job.dir, "out"))
        self.jobs[job.id] = job
        asyncio.get_event_loop().create_task(self._run(job, model_paths, printer, process, filaments, overrides or {}, filament_ids or []))
        return job

    async def _run(self, job, model_paths, printer, process, filaments, overrides, filament_ids):
        async with self._sem:
            job.status, job.started = "slicing", time.time()
            try:
                pdir = os.path.join(job.dir, "profiles")
                os.makedirs(pdir)
                # Quick settings are process settings; a key the process profile omits still applies.
                machine = self._write_profile(printer, {}, pdir, "machine.json")
                proc = self._write_profile(process, overrides, pdir, "process.json", add_missing=True)
                colors = overrides.pop("_filament_colors", None) or []
                # Filament swaps at a given height ("change to F2 at 30 mm"), as the GUI's layer slider makes them.
                layer_changes = overrides.pop("_layer_changes", None) or []
                custom = []
                if layer_changes:
                    custom_path = os.path.join(pdir, "custom_gcodes.json")
                    with open(custom_path, "w", encoding="utf-8") as f:
                        json.dump({"mode": "MultiAsSingle", "gcodes": [
                            {"type": "ToolChange", "print_z": float(c["z"]), "extruder": int(c["filament"]),
                             "color": colors[int(c["filament"]) - 1] if int(c["filament"]) <= len(colors) else "", "extra": ""}
                            for c in sorted(layer_changes, key=lambda c: float(c["z"]))]}, f)
                    custom = ["--load-custom-gcodes", custom_path]
                fils = [self._write_profile(f, {"filament_colour": [colors[i]]} if i < len(colors) else {}, pdir, f"filament_{i}.json")
                        for i, f in enumerate(filaments)]
                out = os.path.join(job.dir, "out")
                args = [self.exe, "--datadir", os.path.join(self.work_dir, "_engine_data"),
                        "--load-settings", f"{machine};{proc}", "--load-filaments", ";".join(fils),
                        "--arrange", "1", "--orient", "0", "--slice", "0", "--export-statistics",
                        *(["--load-filament-ids", ",".join(map(str, filament_ids))] if filament_ids else []), *custom,
                        "--outputdir", out, "--export-3mf", "plate.gcode.3mf", *model_paths]
                # A thread + subprocess.run works under every event loop (Windows selector loops can't spawn processes).
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                p = await asyncio.to_thread(subprocess.run, args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
                job.log_tail = p.stdout.decode(errors="replace")[-4000:]
                res_path = os.path.join(out, "result.json")
                if os.path.exists(res_path):
                    with open(res_path, encoding="utf-8") as f:
                        job.result = json.load(f)
                stats_path = os.path.join(out, "plate_1.statistics.json")
                if os.path.exists(stats_path):
                    with open(stats_path, encoding="utf-8") as f:
                        job.stats = summarize_stats(json.load(f))
                if p.returncode != 0 or job.result.get("return_code", 0) != 0 or not os.path.exists(job.gcode_path):
                    job.status = "error"
                    job.error = job.result.get("error_string") or f"Engine exited with code {p.returncode}"
                else:
                    job.status = "done"
            except Exception as e:  # surfaced to the UI instead of failing silently
                job.status, job.error = "error", f"{type(e).__name__}: {e}"
            finally:
                job.finished = time.time()

    def cleanup(self, keep=20):
        done = sorted((j for j in self.jobs.values() if j.status in ("done", "error")), key=lambda j: j.finished)
        for j in done[:-keep]:
            shutil.rmtree(j.dir, ignore_errors=True)
            self.jobs.pop(j.id, None)


def summarize_stats(s):
    """Headline numbers from plate_N.statistics.json for the UI."""
    sm = s.get("summary", {})
    return {
        "print_time_s": sm.get("time"), "layers": sm.get("layer_count"), "weight_g": sm.get("weight"),
        "cost": sm.get("filament_cost"), "filament_changes": sm.get("filament_changes"),
        "filaments": [{"id": f.get("id"), "weight_g": f.get("weight"), "length_mm": f.get("length"),
                       "flush_g": (f.get("flush") or {}).get("weight"), "prime_tower_g": (f.get("prime_tower") or {}).get("weight")}
                      for f in sm.get("filaments", [])],
        "features": {k: v.get("time") for k, v in sm.get("features", {}).items()},
    }
