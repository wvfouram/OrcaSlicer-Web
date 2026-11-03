# OrcaSlicer-Web

A browser interface for OrcaSlicer. A small server on your PC runs the OrcaSlicer engine headless;
you open the interface from any browser on your network (PC or phone) to slice and send prints to a
Bambu Lab printer over LAN.

## Run on Windows

1. Download the `OrcaSlicer-Web_Windows_x64` artifact from the newest successful
   "Package OrcaSlicer-Web (Windows)" run under the repository's Actions tab, and unzip it.
2. Double-click `Start OrcaSlicer-Web.bat`. Allow it through Windows Firewall if you want to
   use it from your phone.
3. Open http://localhost:8765 (or `http://<PC IP>:8765` on another device).

## Printer connection

The printer must be in **LAN Only** mode with **Developer Mode** on. Enter its IP, serial number
and access code with the printer button in the top bar. Jobs are uploaded over FTPS (port 990)
and started over MQTT (port 8883). The printer's certificate is self-signed, so the connection is
encrypted but the printer's identity is not verified: only use it on your own network.

## Layout

- `server/app.py`: HTTP API and static file server (FastAPI).
- `server/engine.py`: runs the engine's command-line mode for each slicing job.
- `server/profiles.py`: flattens system profiles (`inherits` and `include`) into the JSON the engine loads.
- `server/printer.py`: Bambu LAN protocol (FTPS upload, MQTT status and commands).
- `static/`: the browser UI (three.js viewer, G-code preview in a web worker).

## Develop

```
pip install -r server/requirements.txt
ORCA_ENGINE=/path/to/orca-slicer python server/app.py
```

`ORCA_PROFILES` overrides the profile folder (default: `web/profiles/BBL`, then `resources/profiles/BBL`).
`ORCAWEB_DATA` sets where uploads, jobs and the printer config are stored (default `web/data`).
