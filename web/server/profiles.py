"""Resolve Orca system profiles (inherits + include templates) into flat JSON the engine CLI accepts."""
import json, os, glob

META_KEYS = {"inherits", "include", "instantiation", "from"}

class ProfileStore:
    def __init__(self, vendor_dir):
        self.by_name = {}
        for path in glob.glob(os.path.join(vendor_dir, "**", "*.json"), recursive=True):
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(data, dict) and "name" in data and "type" in data:
                self.by_name[data["name"]] = data

    def resolve(self, name, _seen=None):
        _seen = _seen or set()
        if name in _seen:
            raise ValueError(f"profile inheritance loop at {name!r}")
        _seen.add(name)
        raw = self.by_name[name]
        out = {}
        if raw.get("inherits"):
            out.update(self.resolve(raw["inherits"], _seen))
        for inc in raw.get("include", []):
            out.update({k: v for k, v in self.resolve(inc, set(_seen)).items() if k not in ("name", "type")})
        out.update({k: v for k, v in raw.items() if k not in META_KEYS})
        return out

    def flat(self, name):
        d = self.resolve(name)
        d["from"] = "system"
        d["name"] = name
        return d

    def list(self, type_, instantiable_only=True):
        return sorted(n for n, d in self.by_name.items()
                      if d["type"] == type_ and (not instantiable_only or d.get("instantiation") == "true"))

    def write_flat(self, name, out_dir):
        path = os.path.join(out_dir, f"{name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.flat(name), f, indent=1)
        return path
