"""Bambu Lab printer over LAN (LAN Only + Developer Mode): FTPS upload (port 990) and MQTT control (port 8883).

The printer uses a self-signed certificate on the local network, so TLS here encrypts but does not
verify the printer's identity. Only connect to your own printer's IP on your own LAN.
"""
import ftplib, hashlib, json, os, ssl, threading, time

import paho.mqtt.client as mqtt


def _insecure_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class ImplicitFTPS(ftplib.FTP_TLS):
    """FTP over implicit TLS, as the printer expects. Reuses the control TLS session on data connections."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._sock = None

    @property
    def sock(self):
        return self._sock

    @sock.setter
    def sock(self, value):
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value)
        self._sock = value

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, session=self.sock.session)
        return conn, size


class BambuPrinter:
    def __init__(self, ip, serial, access_code):
        self.ip, self.serial, self.code = ip, serial, access_code
        self.state: dict = {}
        self.connected = False
        self.last_error = ""
        self.last_report = 0.0
        self._client = None
        self._lock = threading.Lock()

    # ---------- file upload ----------
    def upload(self, local_path, remote_name, progress=None):
        ftp = ImplicitFTPS(context=_insecure_ctx(), timeout=30)
        ftp.connect(self.ip, 990)
        ftp.login("bblp", self.code)
        ftp.prot_p()
        size, sent = os.path.getsize(local_path), 0

        def cb(chunk):
            nonlocal sent
            sent += len(chunk)
            if progress:
                progress(sent / size)
        with open(local_path, "rb") as f:
            ftp.storbinary(f"STOR {remote_name}", f, blocksize=64 * 1024, callback=cb)
        try:
            ftp.quit()
        except Exception:
            ftp.close()

    # ---------- MQTT ----------
    def connect(self):
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"orcaweb-{os.getpid()}", protocol=mqtt.MQTTv311)
        c.username_pw_set("bblp", self.code)
        c.tls_set_context(_insecure_ctx())
        c.on_connect = self._on_connect
        c.on_message = self._on_message
        c.on_disconnect = self._on_disconnect
        c.reconnect_delay_set(1, 30)
        c.connect_async(self.ip, 8883, keepalive=30)
        c.loop_start()
        self._client = c

    def disconnect(self):
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()
            self._client = None
        self.connected = False

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            self.connected, self.last_error = True, ""
            client.subscribe(f"device/{self.serial}/report")
            self.request_full_status()
        else:
            self.connected, self.last_error = False, f"MQTT connect refused: {reason_code} (check access code and Developer Mode)"

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected = False

    def _on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload)
        except ValueError:
            return
        with self._lock:
            # P1-series printers send partial updates, so merge them into the last full state.
            _deep_merge(self.state, data)
            self.last_report = time.time()

    def _publish(self, payload):
        if not self._client or not self.connected:
            raise ConnectionError(self.last_error or "Printer is not connected")
        self._client.publish(f"device/{self.serial}/request", json.dumps(payload), qos=1)

    def request_full_status(self):
        self._publish({"pushing": {"sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1}})

    def command(self, name):
        if name not in ("pause", "resume", "stop"):
            raise ValueError(name)
        self._publish({"print": {"sequence_id": "0", "command": name}})

    def start_print(self, remote_name, md5, plate=1, use_ams=True, ams_mapping=None, bed_leveling=True,
                    timelapse=False, flow_cali=False, vibration_cali=False):
        self._publish({"print": {
            "sequence_id": "0", "command": "project_file", "param": f"Metadata/plate_{plate}.gcode",
            "project_id": "0", "profile_id": "0", "task_id": "0", "subtask_id": "0",
            "subtask_name": os.path.splitext(os.path.splitext(remote_name)[0])[0],
            "file": remote_name, "url": f"file:///sdcard/{remote_name}", "md5": md5,
            "timelapse": timelapse, "bed_type": "auto", "bed_levelling": bed_leveling,
            "flow_cali": flow_cali, "vibration_cali": vibration_cali, "layer_inspect": False,
            "use_ams": use_ams, "ams_mapping": ams_mapping if ams_mapping is not None else [0],
        }})

    def status(self):
        with self._lock:
            p = dict(self.state.get("print", {}))
        ams = []
        for unit in (p.get("ams") or {}).get("ams", []) or []:
            for tray in unit.get("tray", []) or []:
                ams.append({"unit": int(unit.get("id", 0)), "slot": int(tray.get("id", 0)),
                            "type": tray.get("tray_type", ""), "color": tray.get("tray_color", ""),
                            "name": tray.get("tray_sub_brands", "")})
        return {
            "connected": self.connected, "error": self.last_error, "age_s": round(time.time() - self.last_report, 1) if self.last_report else None,
            "state": p.get("gcode_state"), "percent": p.get("mc_percent"), "remaining_min": p.get("mc_remaining_time"),
            "layer": p.get("layer_num"), "total_layers": p.get("total_layer_num"), "job": p.get("subtask_name"),
            "nozzle": p.get("nozzle_temper"), "nozzle_target": p.get("nozzle_target_temper"),
            "bed": p.get("bed_temper"), "bed_target": p.get("bed_target_temper"), "ams": ams,
            "print_error": p.get("print_error"),
        }


def file_md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
