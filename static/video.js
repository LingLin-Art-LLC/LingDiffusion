// LingDiffusion — the Video tab. Turns a video into a stylized one (anime from live action, say)
// one frame at a time, through the same engine and queue as img2img.
//
// The browser does all the video work, so the server never touches a video file:
//   decode     the <video> element, seeked frame by frame and drawn to a canvas
//   diffuse    each keyframe is an img2img job: POST /api/generate?mode=video (saved in <run>/keys)
//   stabilize  a small optical-flow estimator (pyramidal block matching on a downscaled luma
//              image) tells where each pixel of the new frame was in an earlier one. With it:
//                Frame preservation  the previous stylized frame, warped along the motion, is
//                                    mixed into the next frame's init image
//                Identity anchor     same, from the first stylized frame of the prompt line
//                Deflicker           the result is pulled toward the warped previous result
//                Color lock          the palette is matched to that first frame (YCbCr mean/std)
//              Each warp comes with a confidence mask (does the warped source match the new
//              source?), so occlusions, new objects and hard cuts are redrawn instead of smeared.
//                Seed lock           every frame starts from the same noise
//   tween      with "Keyframe every N" only every Nth frame is diffused; the frames between are
//              both neighbouring keyframes warped to that frame and blended by time and confidence
//   interp     optional motion-compensated in-between frames (×2…×4) on the finished frames
//   encode     MediaRecorder on a canvas stream, with the source's audio routed through WebAudio
//   keep       the final frames go to outputs/video-images/<date>/<run>/frames (POST /api/video/frame)
(() => {
  "use strict";
  const A = window.LDApp;
  if (!A) return;
  const { api, post, toast, setStatus, getv, setv, changed, fmtTime, toUrl } = A;
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  class Stopped extends Error { constructor() { super("stopped"); } }

  const V = $("#vid-src");
  const viewer = $("#vid-viewer"), outCanvas = $("#vid-out"), outCtx = outCanvas.getContext("2d");
  let src = null;          // the loaded video: { url, name, duration, vw, vh }
  let run = null;          // the current / last run (see newRun)
  let running = false, stopping = false, curJob = null, playing = false, exporting = false;

  // ── loading a video ─────────────────────────────────────────────────────────────────────
  const drop = $("#vid-drop"), fileIn = $("#vid-file");
  drop.addEventListener("click", (e) => { if (!src && !e.target.closest("button")) fileIn.click(); });
  drop.addEventListener("keydown", (e) => { if (!src && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); fileIn.click(); } });
  fileIn.addEventListener("change", () => { if (fileIn.files[0]) loadVideo(fileIn.files[0]); fileIn.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v|ogv|avi)$/i.test(f.name));
    if (f) loadVideo(f); else toast("That is not a video file");
  });
  $("#vid-clear").addEventListener("click", (e) => {
    e.stopPropagation();
    if (running) return toast("Stop the run first");
    if (src) URL.revokeObjectURL(src.url);
    src = null; V.removeAttribute("src"); V.load();
    drop.classList.remove("has");
    info();
  });

  async function loadVideo(file) {
    if (running) return toast("Stop the run first");
    if (src) URL.revokeObjectURL(src.url);
    const url = URL.createObjectURL(file);
    V.src = url;
    try {
      await new Promise((res, rej) => { V.onloadedmetadata = res; V.onerror = () => rej(new Error("the browser cannot play this file (try mp4 / H.264 or webm)")); });
    } catch (e) { toast(e.message); setStatus(e.message, true); URL.revokeObjectURL(url); src = null; drop.classList.remove("has"); return; }
    src = { url, name: file.name, duration: V.duration, vw: V.videoWidth, vh: V.videoHeight };
    drop.classList.add("has");
    if (+getv("vid_start") >= src.duration) setv("vid_start", 0);
    if (+getv("vid_end") > src.duration) setv("vid_end", 0);
    fitSize(false);
    changed();
    info();
  }

  // Width / Height to the video's aspect at about the current pixel count, in multiples of 8
  function fitSize(announce) {
    if (!src) return toast("Load a video first");
    const area = +getv("width") * +getv("height"), ar = src.vw / src.vh;
    const w = clamp(Math.round(Math.sqrt(area * ar) / 8) * 8, 256, 2048), h = clamp(Math.round(Math.sqrt(area / ar) / 8) * 8, 256, 2048);
    const was = `${getv("width")}×${getv("height")}`;
    setv("width", w); setv("height", h); changed();
    if (announce || was !== `${w}×${h}`) toast(`Size ${w}×${h} to match the video`);
    info();
  }

  // the frame range the current settings select
  function plan() {
    const fps = Math.max(1, +getv("vid_fps") || 12);
    const start = clamp(+getv("vid_start") || 0, 0, src ? Math.max(0, src.duration - 0.01) : 0);
    const endSet = +getv("vid_end") || 0;
    const end = src ? (endSet > start ? Math.min(endSet, src.duration) : src.duration) : 0;
    const n = Math.max(1, Math.floor((end - start) * fps + 1e-6));
    const K = clamp(Math.round(+getv("vid_key") || 1), 1, 12);
    const keys = [];
    for (let i = 0; i < n; i += K) keys.push(i);
    if (keys[keys.length - 1] !== n - 1) keys.push(n - 1);
    return { fps, start, end, n, K, keys, W: +getv("width"), H: +getv("height"), fit: getv("vid_fit"), interp: +getv("vid_interp") || 1 };
  }

  function info() {
    const box = $("#vid-info");
    if (!src) { box.textContent = "No video yet."; ui(); return; }
    const p = plan();
    box.textContent = `${src.name} · ${src.vw}×${src.vh} · ${src.duration.toFixed(2)} s  →  ${p.n} frames at ${p.fps} fps (${p.start.toFixed(1)}–${p.end.toFixed(1)} s), ` +
      `${p.keys.length} diffused${p.K > 1 ? ` (every ${p.K}th)` : ""}, ${p.W}×${p.H}` + (p.interp > 1 ? `, played at ${p.fps * p.interp} fps after ×${p.interp} interpolation` : "");
    viewer.style.setProperty("--vid-ar", p.W / p.H);
    ui();
  }
  $("#mixer").addEventListener("input", () => setTimeout(info, 0));
  $("#mixer").addEventListener("change", () => setTimeout(info, 0));

  // ── frames out of the <video> ───────────────────────────────────────────────────────────
  const grab = document.createElement("canvas"), gctx = grab.getContext("2d", { willReadFrequently: true });
  async function seek(t) {
    t = clamp(t, 0, Math.max(0, src.duration - 0.001));
    if (Math.abs(V.currentTime - t) < 1e-4 && V.readyState >= 2) return;
    await new Promise((res) => {
      const done = () => { V.removeEventListener("seeked", done); clearTimeout(to); res(); };
      const to = setTimeout(done, 8000);
      V.addEventListener("seeked", done);
      V.currentTime = t;
    });
  }
  // the frame at time t, drawn at W×H (cropped, letterboxed or stretched)
  async function frameAt(t, W, H, fit) {
    await seek(t);
    grab.width = W; grab.height = H;
    gctx.fillStyle = "#000"; gctx.fillRect(0, 0, W, H);
    const vw = V.videoWidth, vh = V.videoHeight;
    if (fit === "stretch") gctx.drawImage(V, 0, 0, W, H);
    else if (fit === "fit") { const s = Math.min(W / vw, H / vh), dw = vw * s, dh = vh * s; gctx.drawImage(V, 0, 0, vw, vh, (W - dw) / 2, (H - dh) / 2, dw, dh); }
    else { const s = Math.max(W / vw, H / vh), sw = W / s, sh = H / s; gctx.drawImage(V, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H); }
    return gctx.getImageData(0, 0, W, H);
  }
  const timeOf = (i, p) => p.start + (i + 0.5) / p.fps; // the middle of frame i, so rounding never lands on a neighbour

  // ── image helpers ───────────────────────────────────────────────────────────────────────
  const canvasOf = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; c.getContext("2d").putImageData(img, 0, 0); return c; };
  const toDataURL = (img) => canvasOf(img).toDataURL("image/png");
  const toBlob = (img, type = "image/png", q) => new Promise((r) => canvasOf(img).toBlob(r, type, q));
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  async function blobToImg(blob, W, H) {
    const bm = await createImageBitmap(blob);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(bm, 0, 0, W, H);
    bm.close();
    return x.getImageData(0, 0, W, H);
  }

  // ── optical flow ────────────────────────────────────────────────────────────────────────
  // flow(cur, prev): for every pixel of cur, the offset to where it was in prev, so prev can be
  // backward-warped onto cur. Coarse-to-fine block matching on a ≤160 px luma image (sub-pixel by a
  // parabola fit, smoothed with a vector median), then bilinear upsampling to full size.
  const FLOW_SIDE = 160, G = 2, R = 3;
  function lumaSmall(img, sw, sh) {
    const { data, width: W, height: H } = img, out = new Float32Array(sw * sh);
    const bx = W / sw, by = H / sh;
    for (let y = 0; y < sh; y++) {
      const y0 = Math.floor(y * by), y1 = Math.max(y0 + 1, Math.floor((y + 1) * by));
      for (let x = 0; x < sw; x++) {
        const x0 = Math.floor(x * bx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bx));
        let s = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const k = (yy * W + xx) * 4; s += 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2]; n++; }
        out[y * sw + x] = s / n;
      }
    }
    return out;
  }
  function blur3(a, w, h) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; t[i] = (a[y * w + Math.max(0, x - 1)] + 2 * a[i] + a[y * w + Math.min(w - 1, x + 1)]) / 4; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = (t[Math.max(0, y - 1) * w + x] + 2 * t[i] + t[Math.min(h - 1, y + 1) * w + x]) / 4; }
    return o;
  }
  function half(a, w, h) {
    const hw = w >> 1, hh = h >> 1, o = new Float32Array(hw * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) { const i = 2 * y * w + 2 * x; o[y * hw + x] = (a[i] + a[i + 1] + a[i + w] + a[i + w + 1]) / 4; }
    return { a: o, w: hw, h: hh };
  }
  // bilinear sample of a flow grid at pixel position (px, py) of its level
  function gridAt(f, px, py) {
    const gx = clamp((px - G / 2) / G, 0, f.gw - 1), gy = clamp((py - G / 2) / G, 0, f.gh - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(f.gw - 1, x0 + 1), y1 = Math.min(f.gh - 1, y0 + 1), ax = gx - x0, ay = gy - y0;
    const i00 = y0 * f.gw + x0, i10 = y0 * f.gw + x1, i01 = y1 * f.gw + x0, i11 = y1 * f.gw + x1;
    return [
      (f.fx[i00] * (1 - ax) + f.fx[i10] * ax) * (1 - ay) + (f.fx[i01] * (1 - ax) + f.fx[i11] * ax) * ay,
      (f.fy[i00] * (1 - ax) + f.fy[i10] * ax) * (1 - ay) + (f.fy[i01] * (1 - ax) + f.fy[i11] * ax) * ay,
    ];
  }
  function matchLevel(cur, prev, w, h, S, coarse) {
    const gw = Math.ceil(w / G), gh = Math.ceil(h / G), fx = new Float32Array(gw * gh), fy = new Float32Array(gw * gh);
    const D = 2 * S + 1, cost = new Float32Array(D * D), LAMBDA = 0.6;
    for (let gy = 0; gy < gh; gy++) {
      const cy = Math.min(h - 1, gy * G + (G >> 1));
      for (let gx = 0; gx < gw; gx++) {
        const cx = Math.min(w - 1, gx * G + (G >> 1));
        let px = 0, py = 0;
        if (coarse) { const v = gridAt(coarse, cx / 2, cy / 2); px = v[0] * 2; py = v[1] * 2; }
        const bx = Math.round(px), by = Math.round(py);
        let best = Infinity, bdx = 0, bdy = 0;
        for (let dy = -S; dy <= S; dy++) {
          for (let dx = -S; dx <= S; dx++) {
            const ox = bx + dx, oy = by + dy;
            let s = 0, n = 0;
            for (let yy = -R; yy <= R; yy++) {
              const y = cy + yy;
              if (y < 0 || y >= h) continue;
              const y2 = clamp(y + oy, 0, h - 1) * w, yr = y * w;
              for (let xx = -R; xx <= R; xx++) {
                const x = cx + xx;
                if (x < 0 || x >= w) continue;
                const d = cur[yr + x] - prev[y2 + clamp(x + ox, 0, w - 1)];
                s += d < 0 ? -d : d; n++;
              }
            }
            const c = s / n + LAMBDA * (Math.abs(ox - px) + Math.abs(oy - py)) + 0.05 * (Math.abs(ox) + Math.abs(oy));
            cost[(dy + S) * D + dx + S] = c;
            if (c < best) { best = c; bdx = dx; bdy = dy; }
          }
        }
        let sx = 0, sy = 0;
        if (bdx > -S && bdx < S) { const m = cost[(bdy + S) * D + bdx + S - 1], p = cost[(bdy + S) * D + bdx + S + 1], den = m - 2 * best + p; if (den > 1e-6) sx = clamp(0.5 * (m - p) / den, -0.5, 0.5); }
        if (bdy > -S && bdy < S) { const m = cost[(bdy + S - 1) * D + bdx + S], p = cost[(bdy + S + 1) * D + bdx + S], den = m - 2 * best + p; if (den > 1e-6) sy = clamp(0.5 * (m - p) / den, -0.5, 0.5); }
        const gi = gy * gw + gx;
        fx[gi] = bx + bdx + sx; fy[gi] = by + bdy + sy;
      }
    }
    return median({ gw, gh, fx, fy });
  }
  function median(f) {
    const { gw, gh } = f, fx = new Float32Array(f.fx.length), fy = new Float32Array(f.fy.length), bx = [], by = [];
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      bx.length = 0; by.length = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const k = clamp(y + j, 0, gh - 1) * gw + clamp(x + i, 0, gw - 1); bx.push(f.fx[k]); by.push(f.fy[k]); }
      bx.sort((a, b) => a - b); by.sort((a, b) => a - b);
      fx[y * gw + x] = bx[bx.length >> 1]; fy[y * gw + x] = by[by.length >> 1];
    }
    return { gw, gh, fx, fy };
  }
  function flow(cur, prev) {
    const W = cur.width, H = cur.height, sc = Math.min(1, FLOW_SIDE / Math.max(W, H));
    const sw = Math.max(16, Math.round(W * sc)), sh = Math.max(16, Math.round(H * sc));
    const pa = [{ a: blur3(lumaSmall(cur, sw, sh), sw, sh), w: sw, h: sh }], pb = [{ a: blur3(lumaSmall(prev, sw, sh), sw, sh), w: sw, h: sh }];
    while (pa.length < 4 && Math.min(pa[pa.length - 1].w, pa[pa.length - 1].h) >= 40) {
      const a = pa[pa.length - 1], b = pb[pb.length - 1];
      pa.push(half(a.a, a.w, a.h)); pb.push(half(b.a, b.w, b.h));
    }
    let f = null;
    for (let l = pa.length - 1; l >= 0; l--) f = matchLevel(pa[l].a, pb[l].a, pa[l].w, pa[l].h, l === pa.length - 1 ? 4 : 2, f);
    // to full resolution, in full-resolution pixels
    const fx = new Float32Array(W * H), fy = new Float32Array(W * H), kx = W / sw, ky = H / sh;
    for (let y = 0; y < H; y++) {
      const ys = (y + 0.5) / ky - 0.5;
      for (let x = 0; x < W; x++) { const v = gridAt(f, (x + 0.5) / kx - 0.5, ys), i = y * W + x; fx[i] = v[0] * kx; fy[i] = v[1] * ky; }
    }
    return { fx, fy, W, H };
  }
  // backward warp: out(p) = img(p + t·flow(p)), bilinear
  function warp(img, fl, t = 1) {
    const { width: W, height: H, data } = img, out = new ImageData(W, H), o = out.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, sx = clamp(x + t * fl.fx[i], 0, W - 1), sy = clamp(y + t * fl.fy[i], 0, H - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), ax = sx - x0, ay = sy - y0;
      const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, d = (y1 * W + x1) * 4, k = i * 4;
      for (let ch = 0; ch < 3; ch++) o[k + ch] = (data[a + ch] * (1 - ax) + data[b + ch] * ax) * (1 - ay) + (data[c + ch] * (1 - ax) + data[d + ch] * ax) * ay;
      o[k + 3] = 255;
    }
    return out;
  }
  function boxBlur(a, W, H, r) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let y = 0; y < H; y++) { let s = 0; const row = y * W; for (let x = -r; x <= r; x++) s += a[row + clamp(x, 0, W - 1)]; for (let x = 0; x < W; x++) { t[row + x] = s / (2 * r + 1); s += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[clamp(y, 0, H - 1) * W + x]; for (let y = 0; y < H; y++) { o[y * W + x] = s / (2 * r + 1); s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; } }
    return o;
  }
  // 1 where the warped source matches the real one (the motion is trusted), 0 where it does not
  function confidence(cur, warpedSrc) {
    const tol = +getv("vid_motion"), W = cur.width, H = cur.height, a = cur.data, b = warpedSrc.data, d = new Float32Array(W * H);
    for (let i = 0, k = 0; i < d.length; i++, k += 4) d[i] = (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2])) / 3;
    const e = boxBlur(d, W, H, 3), t0 = 4 + 26 * tol, t1 = t0 + 12 + 50 * tol, m = new Float32Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = clamp((t1 - e[i]) / (t1 - t0), 0, 1);
    return boxBlur(m, W, H, 2);
  }
  // base + (over − base)·mask·amount
  function mix(base, over, mask, amount) {
    const W = base.width, H = base.height, out = new ImageData(W, H), o = out.data, a = base.data, b = over.data;
    for (let i = 0, k = 0; i < W * H; i++, k += 4) {
      const w = (mask ? mask[i] : 1) * amount;
      o[k] = a[k] + (b[k] - a[k]) * w; o[k + 1] = a[k + 1] + (b[k + 1] - a[k + 1]) * w; o[k + 2] = a[k + 2] + (b[k + 2] - a[k + 2]) * w; o[k + 3] = 255;
    }
    return out;
  }
  // the palette: mean and spread of Y, Cb, Cr
  function colorStats(img) {
    const d = img.data, s = [0, 0, 0], q = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < d.length; k += 8) {
      const r = d[k], g = d[k + 1], b = d[k + 2], c = [0.299 * r + 0.587 * g + 0.114 * b, -0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];
      for (let j = 0; j < 3; j++) { s[j] += c[j]; q[j] += c[j] * c[j]; }
      n++;
    }
    const mean = s.map((v) => v / n);
    return { mean, sd: q.map((v, j) => Math.sqrt(Math.max(1e-3, v / n - mean[j] * mean[j]))) };
  }
  function colorMatch(img, ref, amount) {
    if (!ref || amount <= 0) return img;
    const st = colorStats(img), k = [0, 1, 2].map((j) => clamp(ref.sd[j] / st.sd[j], 0.6, 1.7));
    const W = img.width, H = img.height, out = new ImageData(W, H), o = out.data, d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const Y = (0.299 * r + 0.587 * g + 0.114 * b - st.mean[0]) * k[0] + ref.mean[0];
      const Cb = (-0.168736 * r - 0.331264 * g + 0.5 * b - st.mean[1]) * k[1] + ref.mean[1];
      const Cr = (0.5 * r - 0.418688 * g - 0.081312 * b - st.mean[2]) * k[2] + ref.mean[2];
      o[i] = r + (Y + 1.402 * Cr - r) * amount;
      o[i + 1] = g + (Y - 0.344136 * Cb - 0.714136 * Cr - g) * amount;
      o[i + 2] = b + (Y + 1.772 * Cb - b) * amount;
      o[i + 3] = 255;
    }
    return out;
  }
  // two warped images blended by time (t toward b) and by how much each warp is trusted
  function blendTween(wa, ca, wb, cb, t) {
    const W = wa.width, H = wa.height, out = new ImageData(W, H), o = out.data, a = wa.data, b = wb.data;
    for (let i = 0, k = 0; i < W * H; i++, k += 4) {
      const ka = (1 - t) * (ca[i] + 0.05), kb = t * (cb[i] + 0.05), s = 1 / (ka + kb);
      o[k] = (a[k] * ka + b[k] * kb) * s; o[k + 1] = (a[k + 1] * ka + b[k + 1] * kb) * s; o[k + 2] = (a[k + 2] * ka + b[k + 2] * kb) * s; o[k + 3] = 255;
    }
    return out;
  }

  // ── the prompt schedule ─────────────────────────────────────────────────────────────────
  // "frame: prompt | denoise=0.5, cfg=8" or "2.5s: prompt"; '#' starts a comment line
  function parseSchedule(text, p) {
    const out = [];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds)?\s*[:=]\s*(.*)$/i);
      if (!m) continue;
      const frame = m[2] ? Math.round((+m[1] - p.start) * p.fps) : Math.round(+m[1]);
      const bar = m[3].indexOf("|");
      const prompt = (bar >= 0 ? m[3].slice(0, bar) : m[3]).trim();
      const params = {};
      if (bar >= 0) for (const kv of m[3].slice(bar + 1).matchAll(/([a-z_]+)\s*=\s*(-?\d+(?:\.\d+)?)/gi)) params[kv[1].toLowerCase()] = +kv[2];
      if (params.denoising !== undefined) params.denoise = params.denoising;
      out.push({ frame, prompt, params });
    }
    out.sort((a, b) => a.frame - b.frame);
    return out.length ? out : [{ frame: 0, prompt: "", params: {} }];
  }
  const joinPrompt = (...parts) => parts.map((s) => String(s || "").trim().replace(/,\s*$/, "")).filter(Boolean).join(", ");
  // a number set on schedule lines, eased linearly between the lines that set it
  function eased(sched, f, key, fallback) {
    let a = null, b = null;
    for (const e of sched) {
      if (e.params[key] === undefined) continue;
      if (e.frame <= f) a = e; else if (!b) b = e;
    }
    if (!a && !b) return fallback;
    if (!a) a = { frame: Math.min(0, b.frame - 1), params: { [key]: fallback } }; // the slider holds until the first line that sets it
    if (!b) return a.params[key];
    return a.params[key] + (b.params[key] - a.params[key]) * ((f - a.frame) / (b.frame - a.frame));
  }
  // everything the engine needs for frame f
  function frameParams(f, r) {
    const sched = r.sched;
    let li = 0;
    for (let i = 0; i < sched.length; i++) if (sched[i].frame <= f) li = i;
    const cur = sched[li], next = sched[li + 1], B = Math.round(+getv("vid_blend") || 0);
    let scheduled = cur.prompt;
    if (next && B > 0 && f > next.frame - B) {
      const w = clamp((f - (next.frame - B)) / B, 0, 1);
      if (w >= 0.98) scheduled = next.prompt;
      else if (w > 0.02 && cur.prompt && next.prompt) scheduled = `(${cur.prompt}:${(1 - w).toFixed(2)}), (${next.prompt}:${w.toFixed(2)})`;
      else if (w > 0.5) scheduled = next.prompt;
    }
    let seed = r.seed;
    for (const e of sched) if (e.frame <= f && e.params.seed !== undefined) seed = Math.trunc(e.params.seed);
    if (!getv("vid_seedlock")) seed += f;
    return {
      line: li,
      prompt: joinPrompt(scheduled, getv("vid_prompt")),
      negative: getv("vid_negative"),
      denoise: clamp(eased(sched, f, "denoise", +getv("vid_denoise")), 0.01, 1),
      cfg: clamp(eased(sched, f, "cfg", +getv("cfg_scale")), 1, 30),
      steps: Math.round(clamp(eased(sched, f, "steps", +getv("steps")), 1, 150)),
      seed,
    };
  }

  // ── one img2img job ─────────────────────────────────────────────────────────────────────
  async function diffuse(init, fp, runName, day, label) {
    const body = {
      prompt: fp.prompt, negative_prompt: fp.negative,
      sampler_name: getv("sampler"), scheduler: getv("scheduler"),
      steps: fp.steps, cfg_scale: fp.cfg, denoising_strength: fp.denoise,
      width: init.width, height: init.height, resize_mode: 0,
      seed: fp.seed, batch_size: 1, n_iter: 1, clip_skip: +getv("clip_skip"),
      checkpoint: $("#ckpt").value, vae: $("#vae").value,
      init_images: [toDataURL(init)], save_images: true,
    };
    const r = await post(`/api/generate?mode=video&date=${day}&run=${encodeURIComponent(runName)}`, body);
    curJob = r.job;
    const root = r.outputs_root || "outputs";
    let lastPv = -1, sentStop = false;
    for (;;) {
      if (stopping && !sentStop) { sentStop = true; await post("/api/interrupt?job=" + curJob).catch(() => {}); }
      let s;
      try { s = await api("/api/status?job=" + curJob); } catch { await sleep(1000); continue; }
      $("#lcd-time").textContent = fmtTime(s.elapsed);
      const msg = s.state === "queued" ? "waiting" : s.state === "loading" ? (s.message || "loading") : s.state === "running" ? `step ${s.step}/${s.steps}` : s.state;
      setStatus(`${label} · ${msg}`);
      if (s.state === "running" && $("#vid-live").checked && s.preview_n !== lastPv) {
        lastPv = s.preview_n;
        api("/api/preview?job=" + curJob).then((pv) => { if (pv.image && running) { $("#vid-pv").src = "data:image/png;base64," + pv.image; viewer.classList.add("show-pv"); } }).catch(() => {});
      }
      if (s.state === "error") { curJob = null; throw new Error(s.error || "the engine failed on this frame"); }
      if (s.state === "interrupted" || s.state === "unknown") { curJob = null; throw new Stopped(); }
      if (s.state === "done") {
        curJob = null;
        if (stopping) throw new Stopped();
        if (!s.images.length || !s.images[0]) throw new Error("the engine returned no image");
        const blob = await (await fetch(toUrl(s.images[0], root))).blob();
        viewer.classList.remove("show-pv");
        return blobToImg(blob, init.width, init.height);
      }
      await sleep(300);
    }
  }

  // ── a run ───────────────────────────────────────────────────────────────────────────────
  function newRun() {
    const p = plan();
    const d = new Date();
    const stamp = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
    const base = src.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "video";
    let seed = Math.trunc(+getv("seed"));
    if (!(seed >= 0)) seed = Math.floor(Math.random() * 0x7fffffff);
    return {
      ...p, name: `${base}-${stamp}`, day: today(), video: src.name, seed,
      sched: parseSchedule(getv("vid_schedule"), p),
      frames: new Array(p.n),      // final frames (PNG blobs) at the processing rate
      srcs: new Array(p.n),        // the source frames (JPEG blobs) for "Hold: Source"
      final: null,                 // after interpolation (or = frames)
      outFps: p.fps,
      nextKey: 0,                  // index into keys of the next keyframe to diffuse
      prev: null,                  // { i, src, out, warp? } the last keyframe
      anchor: null,                // { line, src, out, stats } the first keyframe of the current schedule line
      t0: 0, busySec: 0, done: 0, saved: false,
    };
  }
  const sameShape = (r, p) => r && r.n === p.n && r.W === p.W && r.H === p.H && r.fps === p.fps && r.start === p.start && r.K === p.K && r.fit === p.fit && r.video === (src && src.name);

  async function start(resume) {
    if (running) return;
    if (!src) return toast("Drop a video in first");
    if (!$("#ckpt").value) return toast("No checkpoint selected");
    if (A.isBusy()) return toast("Wait for the current job first");
    const p = plan();
    if (resume) {
      if (!run || run.nextKey >= run.keys.length) return toast("Nothing to resume");
      if (!sameShape(run, p)) return toast("Size, frame rate, range or keyframe spacing changed since that run: start a new one");
      run.sched = parseSchedule(getv("vid_schedule"), p); // prompts may be edited between stop and resume
      run.interp = p.interp;
    } else {
      if (p.n > 20000) return toast("That is over 20 000 frames: lower Frames / sec or set Start / End");
      run = newRun();
    }
    V.pause();
    running = true; stopping = false;
    A.busy(true);
    ui();
    outCanvas.width = run.W; outCanvas.height = run.H;
    $("#vid-pos").max = Math.max(0, run.n - 1);
    log(`Run ${run.name} → outputs/video-images/${run.day}/${run.name}\n${run.n} frames, ${run.keys.length} diffused, seed ${run.seed}${getv("vid_seedlock") ? " (locked)" : " (+1 per frame)"}`);
    post(`/api/video/meta?run=${run.name}&date=${run.day}`, meta()).catch(() => {});
    const t0 = performance.now();
    let err = null;
    try {
      while (run.nextKey < run.keys.length) {
        const i = run.keys[run.nextKey];
        const label = `Frame ${i + 1}/${run.n}`;
        const tk = performance.now();
        const srcI = await frameAt(timeOf(i, run), run.W, run.H, run.fit);
        run.srcs[i] = await toBlob(srcI, "image/jpeg", 0.85);
        const out = await keyframe(i, srcI, label);
        // the frames between the last keyframe and this one
        const a = run.prev;
        if (a && i - a.i > 1) {
          for (let j = a.i + 1; j < i; j++) {
            if (stopping) throw new Stopped();
            setStatus(`Tweening frame ${j + 1}/${run.n}`);
            const sj = await frameAt(timeOf(j, run), run.W, run.H, run.fit);
            run.srcs[j] = await toBlob(sj, "image/jpeg", 0.85);
            const fa = flow(sj, a.src), fb = flow(sj, srcI);
            const tw = blendTween(warp(a.out, fa), confidence(sj, warp(a.src, fa)), warp(out, fb), confidence(sj, warp(srcI, fb)), (j - a.i) / (i - a.i));
            await store(j, tw);
          }
        }
        await store(i, out);
        run.prev = { i, src: srcI, out };
        run.nextKey++;
        run.busySec += (performance.now() - tk) / 1000;
        const left = run.keys.length - run.nextKey, per = run.busySec / Math.max(1, run.nextKey);
        $("#lcd-main").textContent = `${String(i + 1).padStart(String(run.n).length, "0")}/${run.n}`;
        $("#prog-bar").style.width = Math.round(((i + 1) / run.n) * 100) + "%";
        $("#vid-badge").textContent = `${i + 1}/${run.n} · ${per.toFixed(1)} s a keyframe · ETA ${fmtTime(left * per)}`;
      }
    } catch (e) { err = e; }
    running = false;
    curJob = null;
    A.busy(false);
    const secs = (performance.now() - t0) / 1000;
    if (err && !(err instanceof Stopped)) { setStatus(err.message, true); toast(err.message); log(`Stopped at frame ${(run.keys[run.nextKey] ?? 0) + 1}: ${err.message} — fix it and press Resume`); }
    else if (err) { setStatus(`Stopped · ${doneCount()}/${run.n} frames`); log(`Stopped at frame ${doneCount()}/${run.n}. Resume carries on from there.`); }
    stopping = false;
    if (!err) {
      await finishRun();
      setStatus(`Done · ${run.final.length} frames · ${fmtTime(secs)}`);
    } else if (doneCount()) {
      run.final = run.frames.slice(0, doneCount());
      run.outFps = run.fps;
    }
    ui();
  }
  const doneCount = () => { let c = 0; while (run && c < run.n && run.frames[c]) c++; return c; };

  // diffuse keyframe i, with everything that keeps it consistent with what came before
  async function keyframe(i, srcI, label) {
    const fp = frameParams(i, run);
    const preserve = +getv("vid_preserve"), identity = +getv("vid_identity"), colorLock = +getv("vid_color"), deflicker = +getv("vid_deflicker");
    const a = run.prev;
    let init = srcI, wPrev = null, cPrev = null;
    if (a && (preserve > 0 || deflicker > 0)) {
      setStatus(`${label} · tracking motion`);
      const fl = flow(srcI, a.src);
      wPrev = warp(a.out, fl);
      cPrev = confidence(srcI, warp(a.src, fl));
      if (preserve > 0) init = mix(init, wPrev, cPrev, preserve);
    }
    const anc = run.anchor && run.anchor.line === fp.line ? run.anchor : null;
    if (anc && identity > 0 && (!a || anc.i !== a.i)) {
      const fl = flow(srcI, anc.src);
      init = mix(init, warp(anc.out, fl), confidence(srcI, warp(anc.src, fl)), identity);
    }
    if (anc && colorLock > 0) init = colorMatch(init, anc.stats, colorLock * 0.5);
    let out = await diffuse(init, fp, run.name, run.day, label);
    if (wPrev && deflicker > 0) out = mix(out, wPrev, cPrev, deflicker);
    if (anc && colorLock > 0) out = colorMatch(out, anc.stats, colorLock);
    if (!anc) run.anchor = { line: fp.line, i, src: srcI, out, stats: colorStats(out) };
    return out;
  }

  async function store(i, img) {
    run.frames[i] = await toBlob(img);
    show(img);
    $("#vid-pos").value = i;
    $("#vid-pos-lbl").textContent = `${i + 1} / ${run.n}`;
  }
  function show(img) {
    if (outCanvas.width !== img.width || outCanvas.height !== img.height) { outCanvas.width = img.width; outCanvas.height = img.height; }
    outCtx.putImageData(img, 0, 0);
    viewer.classList.add("show-out"); viewer.classList.remove("show-pv");
  }

  async function finishRun() {
    run.final = run.frames.slice();
    run.outFps = run.fps;
    const m = run.interp;
    if (m > 1 && run.final.length > 1) {
      const out = [];
      let prev = await blobToImg(run.final[0], run.W, run.H);
      for (let i = 0; i < run.final.length - 1; i++) {
        if (stopping) break;
        setStatus(`Interpolating ${i + 1}/${run.final.length - 1}`);
        $("#prog-bar").style.width = Math.round(((i + 1) / run.final.length) * 100) + "%";
        const next = await blobToImg(run.final[i + 1], run.W, run.H);
        out.push(run.final[i]);
        const fl = flow(next, prev); // pixel p of the next frame was at p + fl(p) in this one
        for (let k = 1; k < m; k++) {
          const t = k / m;
          const mid = blendTween(warp(prev, fl, t), ones(prev), warp(next, fl, -(1 - t)), ones(prev), t);
          out.push(await toBlob(mid));
        }
        prev = next;
        await sleep(0);
      }
      out.push(run.final[run.final.length - 1]);
      run.final = out;
      run.outFps = run.fps * m;
    }
    $("#vid-pos").max = run.final.length - 1;
    log(`Done: ${run.final.length} frames at ${run.outFps} fps (${(run.final.length / run.outFps).toFixed(2)} s). Saving the frames…`);
    await saveFrames();
  }
  const ones = (img) => new Float32Array(img.width * img.height).fill(1);

  // ── keeping the frames ──────────────────────────────────────────────────────────────────
  async function saveFrames() {
    if (!run || !run.final || !run.final.length) return toast("No frames yet");
    const n = run.final.length;
    for (let i = 0; i < n; i++) {
      setStatus(`Saving frame ${i + 1}/${n}`);
      $("#prog-bar").style.width = Math.round(((i + 1) / n) * 100) + "%";
      try { await post(`/api/video/frame?run=${run.name}&date=${run.day}&i=${i}`, await blobToDataURL(run.final[i])); }
      catch (e) { setStatus("Saving failed: " + e.message, true); return; }
    }
    $("#prog-bar").style.width = "0";
    post(`/api/video/meta?run=${run.name}&date=${run.day}`, meta()).catch(() => {});
    run.saved = true;
    const dir = `outputs/video-images/${run.day}/${run.name}`;
    log(`Saved ${n} frames to ${dir}/frames\nTo make an mp4 with the original sound:\n  ffmpeg -framerate ${run.outFps} -i "${dir}/frames/%05d.png" -ss ${run.start} -t ${(run.n / run.fps).toFixed(3)} -i "<your video>" -map 0:v -map 1:a? -c:v libx264 -pix_fmt yuv420p -crf 16 -c:a aac -shortest "${run.name}.mp4"`);
    setStatus(`Saved ${n} frames`);
  }
  function meta() {
    return JSON.stringify({
      video: run.video, width: run.W, height: run.H, fps: run.fps, start: run.start, end: run.end, frames: run.n,
      framing: run.fit, keyframe_every: run.K, interpolate: run.interp, output_fps: run.outFps, seed: run.seed, seed_lock: !!getv("vid_seedlock"),
      checkpoint: $("#ckpt").value, vae: $("#vae").value, sampler: getv("sampler"), scheduler: getv("scheduler"), steps: +getv("steps"), cfg_scale: +getv("cfg_scale"), clip_skip: +getv("clip_skip"),
      denoise: +getv("vid_denoise"), prompt: getv("vid_prompt"), negative_prompt: getv("vid_negative"), schedule: getv("vid_schedule"), prompt_blend: +getv("vid_blend"),
      frame_preservation: +getv("vid_preserve"), identity_anchor: +getv("vid_identity"), color_lock: +getv("vid_color"), deflicker: +getv("vid_deflicker"), motion_tolerance: +getv("vid_motion"),
    }, null, 2);
  }

  // ── WebM export: frames on a canvas stream, the source's sound through WebAudio ──────────
  async function exportWebm() {
    if (!run || !run.final || !run.final.length) return toast("No frames yet");
    if (exporting || running) return;
    if (typeof MediaRecorder === "undefined") return toast("This browser cannot record video");
    exporting = true; stopPlay(); ui();
    const frames = run.final, fps = run.outFps, n = frames.length, dur = n / fps;
    const c = document.createElement("canvas"); c.width = run.W; c.height = run.H;
    const ctx = c.getContext("2d");
    const stream = c.captureStream(0), track = stream.getVideoTracks()[0];
    let audioEl = null, actx = null;
    try {
      if (getv("vid_audio") && src) {
        audioEl = document.createElement("video");
        audioEl.src = src.url; audioEl.playsInline = true;
        await new Promise((res, rej) => { audioEl.onloadedmetadata = res; audioEl.onerror = rej; });
        actx = new AudioContext();
        await actx.resume().catch(() => {});
        const dest = actx.createMediaStreamDestination();
        actx.createMediaElementSource(audioEl).connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
        await new Promise((res) => { audioEl.onseeked = res; audioEl.currentTime = run.start; setTimeout(res, 3000); });
      }
    } catch { audioEl = null; if (actx) actx.close(); actx = null; toast("No audio: exporting the picture only"); }
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: Math.round(Math.max(6e6, run.W * run.H * fps * 0.25)) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    // decode ahead of the playhead
    const cache = new Map();
    const want = (i) => { if (i < n && !cache.has(i)) cache.set(i, createImageBitmap(frames[i])); };
    for (let i = 0; i < 24; i++) want(i);
    ctx.drawImage(await cache.get(0), 0, 0);
    rec.start(250);
    track.requestFrame && track.requestFrame();
    // the sound sets the clock; if the browser refuses to play it, export the picture on the wall clock
    if (audioEl && !(await audioEl.play().then(() => true, () => false))) { audioEl = null; toast("The browser would not play the sound: exporting the picture only"); }
    const t0 = performance.now();
    let shown = 0;
    setStatus("Exporting WebM (plays in real time)…");
    for (;;) {
      const t = audioEl ? audioEl.currentTime - run.start : (performance.now() - t0) / 1000;
      if (t >= dur || (audioEl && audioEl.ended)) break;
      const idx = Math.min(n - 1, Math.floor(t * fps));
      if (idx !== shown) {
        for (let k = shown; k < idx; k++) { const b = cache.get(k); cache.delete(k); if (b) b.then((x) => x.close()); }
        ctx.drawImage(await (cache.get(idx) || createImageBitmap(frames[idx])), 0, 0);
        track.requestFrame && track.requestFrame();
        shown = idx;
        for (let k = idx + 1; k < idx + 24; k++) want(k);
      }
      $("#prog-bar").style.width = Math.round((t / dur) * 100) + "%";
      await new Promise((r) => requestAnimationFrame(r));
    }
    rec.stop();
    if (audioEl) audioEl.pause();
    await stopped;
    if (actx) actx.close();
    for (const b of cache.values()) b.then((x) => x.close());
    $("#prog-bar").style.width = "0";
    const blob = new Blob(chunks, { type: "video/webm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = run.name + ".webm";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    setStatus(`Exported ${run.name}.webm (${(blob.size / 1048576).toFixed(1)} MB)`);
    exporting = false; ui();
  }

  // ── looking at the result ───────────────────────────────────────────────────────────────
  const frameList = () => (run ? (run.final && !running ? run.final : run.frames) : []);
  async function showIndex(i) {
    const list = frameList();
    if (!list[i]) return;
    const bm = await createImageBitmap(list[i]);
    if (outCanvas.width !== bm.width || outCanvas.height !== bm.height) { outCanvas.width = bm.width; outCanvas.height = bm.height; }
    outCtx.drawImage(bm, 0, 0); bm.close();
    viewer.classList.add("show-out"); viewer.classList.remove("show-pv");
    $("#vid-pos-lbl").textContent = `${i + 1} / ${list.length}`;
  }
  $("#vid-pos").addEventListener("input", (e) => { if (!running) { stopPlay(); showIndex(+e.target.value); } });
  let playT = 0;
  function stopPlay() { playing = false; clearTimeout(playT); $("#vid-play").classList.remove("on"); }
  function togglePlay() {
    if (playing) return stopPlay();
    const list = frameList(), fps = run && run.final && !running ? run.outFps : run ? run.fps : 12;
    if (!list.length || !list[0]) return toast("No frames yet");
    playing = true; $("#vid-play").classList.add("on");
    let i = +$("#vid-pos").value;
    if (i >= list.length - 1) i = 0;
    const t0 = performance.now(), i0 = i;
    const tick = async () => {
      if (!playing) return;
      i = i0 + Math.floor(((performance.now() - t0) / 1000) * fps);
      if (i >= list.length || !list[i]) return stopPlay();
      $("#vid-pos").value = i;
      await showIndex(i);
      playT = setTimeout(tick, 1000 / fps / 2);
    };
    tick();
  }
  // hold to see the source frame under the current one
  const cmp = $("#vid-compare");
  let cmpBack = null;
  async function compare(on) {
    if (!run) return;
    if (!on) { if (cmpBack) { outCtx.putImageData(cmpBack, 0, 0); cmpBack = null; } return; }
    const list = frameList(), i = +$("#vid-pos").value;
    const si = run.final && list === run.final && run.final.length !== run.n ? Math.min(run.n - 1, Math.round(i / (run.interp || 1))) : i;
    if (!run.srcs[si]) return;
    cmpBack = outCtx.getImageData(0, 0, outCanvas.width, outCanvas.height);
    const bm = await createImageBitmap(run.srcs[si]);
    outCtx.drawImage(bm, 0, 0, outCanvas.width, outCanvas.height); bm.close();
  }
  cmp.addEventListener("mousedown", () => compare(true));
  cmp.addEventListener("touchstart", (e) => { e.preventDefault(); compare(true); });
  for (const ev of ["mouseup", "mouseleave", "touchend"]) cmp.addEventListener(ev, () => compare(false));
  outCanvas.addEventListener("click", () => { if (viewer.classList.contains("show-out")) A.openLightbox(outCanvas.toDataURL("image/png"), ""); });

  // ── try the settings on one frame ───────────────────────────────────────────────────────
  async function testFrame() {
    if (!src) return toast("Drop a video in first");
    if (running || A.isBusy()) return toast("Busy — wait for the current job");
    const p = plan(), t = V.currentTime;
    const f = Math.max(0, Math.round((t - p.start) * p.fps - 0.5));
    const r = { sched: parseSchedule(getv("vid_schedule"), p), seed: Math.trunc(+getv("seed")) >= 0 ? Math.trunc(+getv("seed")) : Math.floor(Math.random() * 0x7fffffff) };
    const fp = frameParams(f, r);
    V.pause();
    running = true; stopping = false; A.busy(true); ui();
    try {
      const img = await frameAt(t, p.W, p.H, p.fit);
      const out = await diffuse(img, fp, "test", today(), `Test frame at ${t.toFixed(2)} s`);
      outCanvas.width = p.W; outCanvas.height = p.H;
      show(out);
      setStatus(`Test frame at ${t.toFixed(2)} s · seed ${fp.seed} · denoise ${fp.denoise.toFixed(2)}`);
      log(`Test at ${t.toFixed(2)} s (frame ${f + 1}), seed ${fp.seed}:\n${fp.prompt}`);
    } catch (e) { if (!(e instanceof Stopped)) { setStatus(e.message, true); toast(e.message); } else setStatus("Stopped"); }
    running = false; stopping = false; A.busy(false); ui();
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────
  function log(text) { $("#vid-log").textContent = text; }
  function ui() {
    const has = !!(run && run.final && run.final.length) || (run && run.frames && run.frames[0]);
    $("#vid-run").disabled = running || exporting;
    $("#vid-stop").disabled = !running;
    $("#vid-resume").disabled = running || exporting || !run || run.nextKey >= run.keys.length;
    $("#vid-export").disabled = running || exporting || !has;
    $("#vid-save").disabled = running || exporting || !has;
  }
  function stop() {
    if (!running) return;
    stopping = true;
    setStatus("Stopping…");
    if (curJob) post("/api/interrupt?job=" + curJob).catch(() => {});
  }
  window.LDVideo = {
    busy: () => running || exporting,
    run: () => start(false),
    stop,
    act(name) {
      switch (name) {
        case "vid-test": return testFrame();
        case "vid-fit": return fitSize(true);
        case "vid-resume": return start(true);
        case "vid-export": return exportWebm();
        case "vid-save-frames": if (run && !run.final) { run.final = run.frames.slice(0, doneCount()); run.outFps = run.fps; } return saveFrames();
        case "vid-play": return togglePlay();
      }
    },
  };
  info();
})();
