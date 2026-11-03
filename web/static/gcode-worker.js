// Parses Orca/Bambu G-code into line segments grouped by layer, off the main thread.
const FEATURES = [
  ["Outer wall", 0xff7d38], ["Inner wall", 0xffe64d], ["Overhang wall", 0x3a5bff], ["Sparse infill", 0xb03029],
  ["Internal solid infill", 0x9654cc], ["Top surface", 0xff4d4d], ["Bottom surface", 0x7a6bff], ["Bridge", 0x4d80ba],
  ["Internal Bridge", 0x6ea0d6], ["Gap infill", 0xffffff], ["Support", 0x2fbf5a], ["Support interface", 0x1f8f42],
  ["Support transition", 0x3c7a4f], ["Prime tower", 0xb3b3b3], ["Brim", 0x00c8a0], ["Skirt", 0x00a0c8],
  ["Ironing", 0xff9ecb], ["Custom", 0x777777], ["Other", 0x999999],
];
const featIndex = new Map(FEATURES.map((f, i) => [f[0].toLowerCase(), i]));

self.onmessage = (ev) => {
  const text = ev.data;
  let pos = new Float32Array(1 << 20), col = new Uint8Array(1 << 19), n = 0; // n = segments
  const grow = () => {
    const p = new Float32Array(pos.length * 2); p.set(pos); pos = p;
    const c = new Uint8Array(col.length * 2); c.set(col); col = c;
  };
  const push = (x0, y0, z0, x1, y1, z1, f) => {
    if ((n + 1) * 6 > pos.length) grow();
    const o = n * 6; pos[o] = x0; pos[o + 1] = y0; pos[o + 2] = z0; pos[o + 3] = x1; pos[o + 4] = y1; pos[o + 5] = z1;
    col[n] = f; n++;
  };
  let x = 0, y = 0, z = 0, e = 0, absPos = true, absE = false, feat = featIndex.get("other");
  const layerStart = [], layerZ = [], featTime = new Float64Array(FEATURES.length);
  let start = 0, lineNo = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf("\n", start); if (end < 0) end = len;
    const line = text.substring(start, end); start = end + 1; lineNo++;
    const c0 = line.charCodeAt(0);
    if (c0 === 59 /* ; */) {
      if (line.startsWith("; FEATURE: ") || line.startsWith(";TYPE:")) {
        const name = line.substring(line.indexOf(":") + 1).trim().toLowerCase();
        feat = featIndex.has(name) ? featIndex.get(name) : featIndex.get("other");
      } else if (line.startsWith("; Z_HEIGHT: ")) {
        layerStart.push(n); layerZ.push(parseFloat(line.substring(12)));
      }
      continue;
    }
    if (c0 !== 71 && c0 !== 77) continue; // G or M
    const semi = line.indexOf(";");
    const code = (semi >= 0 ? line.substring(0, semi) : line).trim();
    const parts = code.split(/\s+/);
    const cmd = parts[0];
    if (cmd === "G90") { absPos = true; continue; }
    if (cmd === "G91") { absPos = false; continue; }
    if (cmd === "M82") { absE = true; continue; }
    if (cmd === "M83") { absE = false; continue; }
    if (cmd === "G92") { for (const p of parts) if (p[0] === "E") e = parseFloat(p.substring(1)); continue; }
    const isLin = cmd === "G0" || cmd === "G1", isArc = cmd === "G2" || cmd === "G3";
    if (!isLin && !isArc) continue;
    let nx = x, ny = y, nz = z, de = 0, hasE = false, I = 0, J = 0;
    for (let k = 1; k < parts.length; k++) {
      const p = parts[k], v = parseFloat(p.substring(1));
      switch (p[0]) {
        case "X": nx = absPos ? v : x + v; break;
        case "Y": ny = absPos ? v : y + v; break;
        case "Z": nz = absPos ? v : z + v; break;
        case "E": hasE = true; if (absE) { de = v - e; e = v; } else de = v; break;
        case "I": I = v; break;
        case "J": J = v; break;
      }
    }
    if (hasE && de > 0 && layerStart.length) {
      if (isLin) push(x, y, z, nx, ny, nz, feat);
      else {
        // Arc around (x+I, y+J); split into short chords.
        const cx = x + I, cy = y + J, r = Math.hypot(I, J);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
        const cw = cmd === "G2";
        let sweep = a1 - a0;
        if (cw && sweep >= 0) sweep -= 2 * Math.PI;
        if (!cw && sweep <= 0) sweep += 2 * Math.PI;
        const steps = Math.max(2, Math.min(64, Math.ceil(Math.abs(sweep) * r / 0.5)));
        let px = x, py = y;
        for (let s = 1; s <= steps; s++) {
          const a = a0 + sweep * s / steps;
          const qx = s === steps ? nx : cx + r * Math.cos(a), qy = s === steps ? ny : cy + r * Math.sin(a);
          push(px, py, z + (nz - z) * (s - 1) / steps, qx, qy, z + (nz - z) * s / steps, feat);
          px = qx; py = qy;
        }
      }
    }
    x = nx; y = ny; z = nz;
  }
  layerStart.push(n);
  const positions = pos.slice(0, n * 6), features = col.slice(0, n);
  self.postMessage({ positions, features, layerStart, layerZ, featureNames: FEATURES.map(f => f[0]), featureColors: FEATURES.map(f => f[1]) },
                   [positions.buffer, features.buffer]);
};
