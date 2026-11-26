// LingDiffusion — the page. The server (app.ling) renders the shell; this drives it:
// queue a job with /api/generate, poll /api/status (+ /api/preview), show the results.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LD = window.LD || {};
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ld." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ld." + k, JSON.stringify(v)); } catch { /* private window */ } },
  };
  const api = async (path, opts = {}) => {
    const r = await fetch(path, opts);
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { error: t }; }
    if (!r.ok) throw new Error(j.detail || j.error || r.statusText);
    return j;
  };
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) });
  const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  let toastT = 0;
  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); };
  const setStatus = (msg, err) => { const s = $("#status"); s.textContent = msg; s.classList.toggle("err", !!err); s.title = msg; };

  // ── sliders: [range][number] pairs built from .slider[data-id] ──
  const DEFAULTS = {};
  for (const el of $$(".slider")) {
    const { id, min, max, step, val } = el.dataset;
    DEFAULTS[id] = +val;
    const r = Object.assign(document.createElement("input"), { type: "range", min, max, step, value: val });
    const n = Object.assign(document.createElement("input"), { type: "number", min, max, step, value: val, id });
    r.setAttribute("aria-label", el.textContent.trim());
    const paint = () => r.style.setProperty("--p", ((r.value - min) / (max - min)) * 100 + "%");
    r.addEventListener("input", () => { n.value = r.value; paint(); changed(); });
    n.addEventListener("input", () => { r.value = n.value; paint(); });
    n.addEventListener("change", () => { const v = Math.min(+max, Math.max(+min, +n.value || +min)); n.value = v; r.value = v; paint(); changed(); });
    n._sync = () => { r.value = n.value; paint(); };
    el.append(r, n);
    paint();
  }
  let upscalerNames = [];
  const FIELDS = ["prompt", "negative", "sampler", "scheduler", "seed", "resize_mode", "enable_hr", "hr_upscaler", "edit_mode",
    "vid_prompt", "vid_negative", "vid_schedule", "vid_fit", "vid_seedlock", "vid_interp", "vid_audio", ...Object.keys(DEFAULTS)];
  const el = (id) => document.getElementById(id);
  const getv = (id) => { const e = el(id); return e.type === "checkbox" ? e.checked : e.value; };
  const setv = (id, v) => {
    const e = el(id); if (!e || v == null) return;
    if (e.type === "checkbox") e.checked = !!v; else e.value = v;
    if (e._sync) e._sync();
    if (e.tagName === "SELECT" && e.value !== String(v)) {
      const o = [...e.options].find((o) => o.value.toLowerCase() === String(v).toLowerCase() || o.text.toLowerCase() === String(v).toLowerCase());
      if (o) e.value = o.value;
    }
  };

  // ── persistence: every field is remembered per browser ──
  let saveT = 0;
  function changed() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { const s = {}; for (const f of FIELDS) s[f] = getv(f); store.set("fields", s); }, 250);
    hrInfo();
  }
  function restore() {
    const s = store.get("fields", null);
    if (s) for (const f of FIELDS) if (f in s) setv(f, s[f]);
    hrCard();
  }
  for (const f of FIELDS) { const e = el(f); e.addEventListener("change", changed); if (e.tagName === "TEXTAREA") e.addEventListener("input", changed); }

  // ── tabs ──
  let tab = "txt2img";
  function setTab(t) {
    tab = t;
    for (const b of $$("#tabs button")) b.classList.toggle("on", b.dataset.tab === t);
    const gen = t === "txt2img" || t === "img2img" || t === "edit";
    document.body.className = document.body.className.replace(/\btab-\S+/g, "").trim() + " tab-" + t;
    $("#pane-gen").classList.toggle("hidden", !gen);
    for (const p of ["pnginfo", "gallery", "settings", "api", "video"]) el("pane-" + p).classList.toggle("hidden", t !== p);
    $("#gen-title").textContent = t === "edit" ? "Edit · Qwen-Image-Edit" : t;
    editFull();
    if (t === "gallery") loadGallery();
    if (t === "settings") loadSettings();
    store.set("tab", t);
  }
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });

  // ── menus (click to open, hover to move between open menus, LingStationX style) ──
  const menus = $$(".menu");
  const closeMenus = () => menus.forEach((m) => m.classList.remove("open"));
  for (const m of menus) {
    $(".menu-title", m).addEventListener("click", (e) => { e.stopPropagation(); const was = m.classList.contains("open"); closeMenus(); if (!was) m.classList.add("open"); });
    m.addEventListener("mouseenter", () => { if (menus.some((x) => x.classList.contains("open"))) { closeMenus(); m.classList.add("open"); } });
  }
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeMenus(); });

  // ── actions: anything with data-act ──
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (b.tagName === "A" && a === "save") { if (!b.href || b.getAttribute("href") === "#") e.preventDefault(); return; }
    e.preventDefault();
    closeMenus();
    act(a);
  });
  function act(a) {
    const [name, arg] = a.split(":");
    switch (name) {
      case "generate": return generate();
      case "interrupt": return interrupt();
      case "skip": return job && post("/api/skip?job=" + job.id).then(() => toast("Skipping this batch"));
      case "forever": return setForever(!forever);
      case "unload": return post("/api/unload").then(() => { toast("Checkpoint unloaded"); refreshEngine(); });
      case "refresh": return refreshModels(true);
      case "tab": return setTab(arg);
      case "toggle": return toggleView(arg);
      case "text": return textSize(arg);
      case "reload": return location.reload();
      case "save": { const a2 = $("#a-save"); if (a2.href && a2.getAttribute("href") !== "#") a2.click(); else toast("Nothing to save yet"); return; }
      case "paste": return pasteParams($("#prompt").value, true);
      case "last": { const l = store.get("last", null); if (!l) return toast("No previous run"); applyParams(l); return toast("Restored the last run"); }
      case "swap": { const w = getv("width"); setv("width", getv("height")); setv("height", w); return changed(); }
      case "clear": setv("prompt", ""); setv("negative", ""); countTokens(); return changed();
      case "defaults": for (const [k, v] of Object.entries(DEFAULTS)) setv(k, v); setv("seed", -1); setv("sampler", "Euler a"); setv("scheduler", "Automatic"); setv("enable_hr", false); hrCard(); return changed();
      case "seed-random": setv("seed", -1); return changed();
      case "reuse-seed": { const s = shown && shown.seed; if (s == null) return toast("No image yet"); setv("seed", s); changed(); return toast("Seed " + s); }
      case "to-img2img": return sendImage(shown && shown.url, "img2img");
      case "to-edit": return sendImage(shown && shown.url, "edit");
      case "upscale": return upscaleShown();
      case "edit-continue": return sendImage(shown && shown.url, "edit").then(() => { $("#prompt").focus(); });
      case "to-txt2img": if (shown) { pasteParams(shown.info, false); setTab("txt2img"); } return;
      case "open-full": if (shown) window.open(shown.url, "_blank"); return;
      case "png-to": return pngTo(arg);
      case "gal-prev": galPage = Math.max(0, galPage - 1); return loadGallery();
      case "gal-next": galPage += 1; return loadGallery();
      case "lb-close": return $("#lightbox").classList.add("hidden");
      case "lb-to": { const lb = $("#lightbox"); pasteParams(lb._info || "", false); if (arg === "img2img") sendImage(lb._url, "img2img"); else setTab("txt2img"); lb.classList.add("hidden"); return; }
      case "about": return modal("About LingDiffusion", "<p>Stable Diffusion written in <b>Ling</b>: the page and API are a Ling program (app.ling), and the diffusion runs inside the Ling interpreter itself — SD 1.5 and SDXL checkpoints, k-diffusion samplers, LoRA, hires fix — on candle and CUDA, with no Python.</p><p class='dim'>A rebuild of AUTOMATIC1111's stable-diffusion-webui, in the LingStationX look.</p>");
      case "modal-close": return $("#modal").classList.add("hidden");
      default: if (name.startsWith("vid-") && window.LDVideo) return window.LDVideo.act(name);
    }
  }

  function toggleView(which) {
    const cls = which === "sidebar" ? "no-sidebar" : "no-mixer";
    document.body.classList.toggle(cls);
    const on = !document.body.classList.contains(cls);
    el("tog-" + which).classList.toggle("on", on);
    store.set("view." + which, on);
  }
  function textSize(how) {
    let k = store.get("text", 13);
    k = how === "+" ? Math.min(20, k + 1) : how === "-" ? Math.max(10, k - 1) : 13;
    document.documentElement.style.setProperty("--fs", k + "px");
    store.set("text", k);
  }
  function modal(title, html) { $("#modal-title").textContent = title; $("#modal-body").innerHTML = html; $("#modal").classList.remove("hidden"); }

  // ── models ──
  const kindOf = () => { const o = $("#ckpt").selectedOptions[0]; return o ? o.dataset.kind : ""; };
  function sizePresets() {
    const xl = kindOf() === "sdxl";
    const list = xl ? [[1024, 1024], [896, 1152], [1152, 896], [832, 1216], [1216, 832], [768, 1344]] : [[512, 512], [512, 768], [768, 512], [640, 640], [768, 768]];
    $("#size-presets").innerHTML = list.map(([w, h]) => `<button data-w="${w}" data-h="${h}">${w}×${h}</button>`).join("");
  }
  $("#size-presets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; setv("width", b.dataset.w); setv("height", b.dataset.h); changed(); });

  let loadJob = null;
  async function selectModel(path, quiet) {
    const prevKind = kindOf();
    if (path) $("#ckpt").value = path;
    const kind = kindOf();
    // moving between SD 1.5 and SDXL: switch to that family's native size
    if (prevKind !== kind) {
      const w = +getv("width"), h = +getv("height");
      if (kind === "sdxl" && w <= 768 && h <= 768) { setv("width", w === h ? 1024 : (w > h ? 1216 : 832)); setv("height", w === h ? 1024 : (w > h ? 832 : 1216)); }
      if (kind !== "sdxl" && (w >= 1024 || h >= 1024)) { setv("width", w === h ? 512 : (w > h ? 768 : 512)); setv("height", w === h ? 512 : (w > h ? 512 : 768)); }
      changed();
    }
    sizePresets();
    for (const it of $$("#side-models .item")) it.classList.toggle("on", it.dataset.path === $("#ckpt").value);
    const name = ($("#ckpt").selectedOptions[0] || {}).text || "";
    $("#title-model").textContent = name.replace(/\.(safetensors|ckpt)$/i, "");
    document.title = "LingDiffusion - " + $("#title-model").textContent;
    if (quiet) return;
    try {
      const r = await post("/api/models/select", { checkpoint: $("#ckpt").value, vae: $("#vae").value });
      loadJob = r.job;
      watchLoad();
    } catch (e) { setStatus(e.message, true); }
  }
  async function watchLoad() {
    if (!loadJob || job) return;
    const s = await api("/api/status?job=" + loadJob).catch(() => null);
    if (!s) return;
    if (s.state === "queued" || s.state === "loading") { setStatus(s.message ? s.message + "…" : "Loading checkpoint…"); setTimeout(watchLoad, 500); return; }
    if (s.state === "error") setStatus(s.error, true); else setStatus("Loaded " + (s.model || ""));
    loadJob = null;
    refreshEngine();
  }
  $("#ckpt").addEventListener("change", () => selectModel(null));
  $("#vae").addEventListener("change", () => selectModel(null));
  $("#side-models").addEventListener("click", (e) => { const it = e.target.closest(".item"); if (it) selectModel(it.dataset.path); });
  $("#side-loras").addEventListener("click", (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const p = $("#prompt"), tag = `<lora:${it.dataset.lora}:1>`;
    if (p.value.includes(`<lora:${it.dataset.lora}:`)) { p.value = p.value.replace(new RegExp(`\\s*,?\\s*<lora:${it.dataset.lora.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[^>]*>`), ""); toast("Removed " + it.dataset.lora); }
    else { p.value = (p.value.trim() ? p.value.replace(/\s*$/, ", ") : "") + tag; toast("Added " + tag); }
    changed(); countTokens();
  });
  for (const b of $$(".side-tabs button")) b.addEventListener("click", () => {
    for (const x of $$(".side-tabs button")) x.classList.toggle("on", x === b);
    $("#side-models").classList.toggle("hidden", b.dataset.side !== "models");
    $("#side-loras").classList.toggle("hidden", b.dataset.side !== "loras");
  });
  $("#side-q").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    for (const it of $$(".side-list .item")) it.classList.toggle("hidden", q && !it.textContent.toLowerCase().includes(q));
  });

  async function refreshModels(announce) {
    try {
      const r = await api("/api/models");
      const cur = $("#ckpt").value;
      $("#ckpt").innerHTML = r.models.length ? r.models.map((m) => `<option value="${esc(m.filename)}" data-kind="${m.kind}">${esc(m.title)}</option>`).join("") : `<option value="">No checkpoints found</option>`;
      if ([...$("#ckpt").options].some((o) => o.value === cur)) $("#ckpt").value = cur; else if (r.current) $("#ckpt").value = r.current;
      const vcur = $("#vae").value;
      $("#vae").innerHTML = `<option value="">Automatic</option>` + r.vaes.map((v) => `<option value="${esc(v.filename)}">${esc(v.model_name)}</option>`).join("");
      $("#vae").value = vcur;
      if (r.upscalers) {
        const hu = $("#hr_upscaler"), want = hu.value || (store.get("fields", {}) || {}).hr_upscaler;
        const names = ["Latent (nearest)", "Lanczos", ...r.upscalers.filter((u) => u.model_path).map((u) => u.name)];
        hu.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
        setv("hr_upscaler", want);
        upscalerNames = names.slice(2);
      }
      $("#side-models").innerHTML = `<div class="tree-folder">▾ <span>Stable-diffusion</span><b>${r.models.length}</b></div>` +
        r.models.map((m) => `<button class="item${m.filename === $("#ckpt").value ? " on" : ""}" data-path="${esc(m.filename)}" data-kind="${m.kind}" title="${esc(m.filename)}"><i class="sq k-${m.kind}"></i><span class="nm">${esc(m.model_name)}</span><b class="badge">${esc(m.label)}</b></button>`).join("");
      $("#side-loras").innerHTML = `<div class="tree-folder">▾ <span>Lora</span><b>${r.loras.length}</b></div>` +
        r.loras.map((l) => `<button class="item" data-lora="${esc(l.name)}" title="Add &lt;lora:${esc(l.name)}:1&gt;"><i class="sq k-lora"></i><span class="nm">${esc(l.name)}</span><b class="badge">+</b></button>`).join("");
      engineLine(r.engine);
      sizePresets();
      if (announce) toast(`${r.models.length} checkpoints, ${r.loras.length} LoRAs`);
    } catch (e) { setStatus(e.message, true); }
  }
  async function refreshEngine() { try { engineLine(await api("/api/engine")); } catch { /* server gone */ } }
  function engineLine(e) {
    if (!e) return;
    const dev = (LD.settings && LD.settings.device) || "auto";
    $("#engine-line").textContent = (e.checkpoint ? `Engine ${e.cuda ? dev : "cpu"} · ${e.arch} · ${e.checkpoint.split("/").pop().replace(/\.\w+$/, "")}` : `Engine ${e.cuda ? dev : "cpu (no CUDA)"} · nothing loaded yet`) + (e.edit ? ` · Edit: ${e.edit}` : "");
    if (e.edit) $("#edit-engine").textContent = "Loaded: " + e.edit;
    const info = $("#engine-info");
    if (info) info.textContent = e.checkpoint ? `${e.checkpoint}\n${e.arch} on ${e.device}${e.vae ? "\nVAE " + e.vae : ""}${e.loras.length ? "\nLoRA " + e.loras.join(", ") : ""}\nqueue ${e.queue}` : "Nothing loaded.";
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── prompt token counters ──
  let tokT = 0;
  function countTokens() {
    clearTimeout(tokT);
    tokT = setTimeout(async () => {
      for (const [id, out] of [["prompt", "#tok-p"], ["negative", "#tok-n"]]) {
        try { const r = await post("/api/tokens", getv(id)); const o = $(out); o.textContent = `${r.tokens}/${r.max}`; o.classList.toggle("over", r.max > 75); } catch { /* ignore */ }
      }
    }, 300);
  }
  $("#prompt").addEventListener("input", countTokens);
  $("#negative").addEventListener("input", countTokens);

  // ── hires fix card ──
  function hrCard() { el("enable_hr").closest(".card").classList.toggle("hr-on", el("enable_hr").checked); hrInfo(); }
  function hrInfo() {
    const s = +getv("hr_scale"), w = +getv("width"), h = +getv("height");
    $("#hr-size").textContent = `${w}×${h} → ${Math.floor((w * s) / 8) * 8}×${Math.floor((h * s) / 8) * 8}`;
  }
  el("enable_hr").addEventListener("change", hrCard);

  // ── Edit tab ──
  function editFull() { document.body.classList.toggle("edit-full", getv("edit_mode") === "full"); }
  el("edit_mode").addEventListener("change", editFull);
  $("#edit-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-chip]");
    if (!b) return;
    const p = $("#prompt");
    p.value = e.shiftKey && p.value.trim() ? p.value.trim().replace(/[.,]?$/, ", ") + b.dataset.chip : b.dataset.chip;
    changed();
    p.focus();
  });
  // hold to see the picture you started from
  const cmp = $("#btn-compare");
  const showOrig = (on) => {
    if (!shown || !initData) return;
    $("#out-img").src = on ? initData : shown.url;
  };
  cmp.addEventListener("mousedown", () => showOrig(true));
  cmp.addEventListener("touchstart", (e) => { e.preventDefault(); showOrig(true); });
  for (const ev of ["mouseup", "mouseleave", "touchend"]) cmp.addEventListener(ev, () => showOrig(false));

  // ── img2img / edit source image ──
  let initData = null;
  function setInit(dataUrl) {
    initData = dataUrl;
    const d = $("#init-drop");
    $("#init-img").src = dataUrl || "";
    d.classList.toggle("has", !!dataUrl);
  }
  const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  function dropZone(zone, input, onData) {
    zone.addEventListener("click", (e) => { if (!e.target.closest("button")) input.click(); });
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", async () => { if (input.files[0]) onData(await readFile(input.files[0]), input.files[0]); input.value = ""; });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault(); zone.classList.remove("over");
      const f = e.dataTransfer.files[0];
      if (f) return onData(await readFile(f), f);
      const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
      if (url) onData(await urlToData(url));
    });
  }
  dropZone($("#init-drop"), $("#init-file"), (d) => setInit(d));
  $("#init-clear").addEventListener("click", (e) => { e.stopPropagation(); setInit(null); });
  document.addEventListener("paste", async (e) => {
    const item = [...(e.clipboardData || {}).items || []].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const data = await readFile(item.getAsFile());
    if (tab === "pnginfo") return pngInfo(data);
    if (tab === "video") return;
    if (tab !== "img2img" && tab !== "edit") setTab("img2img");
    setInit(data);
    toast("Pasted the image into " + tab);
  });
  const urlToData = async (url) => readFile(await (await fetch(url)).blob());
  async function sendImage(url, to) {
    if (!url) return toast("No image yet");
    setInit(await urlToData(url));
    setTab(to);
    toast("Sent to " + to);
  }

  // ── upscale (ESRGAN) the picture on screen ──
  async function upscaleShown() {
    if (!shown || !shown.url) return toast("No image yet");
    if (job) return toast("Busy — wait for the current job");
    let up = getv("hr_upscaler");
    if (/^latent/i.test(up)) up = upscalerNames.find((n) => /anime/i.test(n)) || upscalerNames[0] || "Lanczos";
    const factor = +getv("hr_scale") > 1 ? +getv("hr_scale") : 2;
    busy(true);
    setStatus(`Upscaling ×${factor} with ${up}`);
    try {
      const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const r = await post(`/api/generate?mode=extras&date=${day}`, { init_images: [await urlToData(shown.url)], upscaler: up, upscaling_resize: factor });
      const img = $("#out-img");
      job = { id: r.job, w: (img.naturalWidth || 512) * factor, h: (img.naturalHeight || 512) * factor };
      outRoot = r.outputs_root || LD.outputs_root || "outputs";
      lastPreviewN = -1;
      results = [];
      poll();
    } catch (e) { busy(false); setStatus(e.message, true); }
  }

  // ── generation ──
  let job = null, shown = null, forever = false, pollT = 0, lastPreviewN = -1, results = [], outRoot = LD.outputs_root || "outputs";
  function setForever(on) {
    forever = on;
    $("#btn-forever").classList.toggle("on", on);
    $$(".forever-state").forEach((k) => (k.textContent = on ? "on" : "off"));
    toast(on ? "Generate forever: on" : "Generate forever: off");
    if (on && !job) generate();
  }
  function collect() {
    if (tab === "edit") {
      const full = getv("edit_mode") === "full";
      const e = {
        prompt: getv("prompt"),
        init_images: [initData],
        edit_mode: getv("edit_mode"),
        megapixels: +getv("megapixels"),
        seed: Math.trunc(+getv("seed")),
        n_iter: +getv("n_iter"),
        save_images: true,
      };
      if (full) { e.negative_prompt = getv("negative") || " "; e.cfg_scale = +getv("edit_cfg"); e.steps = +getv("edit_steps"); }
      return e;
    }
    const p = {
      prompt: getv("prompt"),
      negative_prompt: getv("negative"),
      sampler_name: getv("sampler"),
      scheduler: getv("scheduler"),
      steps: +getv("steps"),
      cfg_scale: +getv("cfg_scale"),
      width: +getv("width"),
      height: +getv("height"),
      seed: Math.trunc(+getv("seed")),
      batch_size: +getv("batch_size"),
      n_iter: +getv("n_iter"),
      clip_skip: +getv("clip_skip"),
      checkpoint: $("#ckpt").value,
      vae: $("#vae").value,
      save_images: true,
    };
    if (tab === "img2img") {
      p.init_images = [initData];
      p.denoising_strength = +getv("denoising_strength");
      p.resize_mode = +getv("resize_mode");
    } else if (getv("enable_hr")) {
      p.enable_hr = true;
      p.hr_scale = +getv("hr_scale");
      p.hr_upscaler = getv("hr_upscaler");
      p.hr_second_pass_steps = +getv("hr_second_pass_steps");
      p.denoising_strength = +getv("hr_denoise");
    }
    return p;
  }
  async function generate() {
    if (window.LDVideo && window.LDVideo.busy()) return toast("The video is processing — Stop it first");
    if (tab === "video" && window.LDVideo) { if (job) return toast("Wait for the current job first"); return window.LDVideo.run(); }
    if (job) return toast("Already generating — Interrupt (Esc) first, or turn on Generate Forever");
    const mode = tab === "img2img" ? "img2img" : tab === "edit" ? "edit" : "txt2img";
    if (tab !== "txt2img" && tab !== "img2img" && tab !== "edit") setTab("txt2img");
    if ((mode === "img2img" || mode === "edit") && !initData) { setForever(false); return toast("Drop a picture into " + mode + " first"); }
    if (mode === "edit" && !getv("prompt").trim()) return toast("Write what to change, e.g. \"add a red bow in her hair\"");
    if (mode !== "edit" && !$("#ckpt").value) return toast("No checkpoint selected");
    const p = collect();
    store.set("last", { ...p, init_images: undefined });
    busy(true);
    setStatus("Queued");
    try {
      const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const r = await post(`/api/generate?mode=${mode}&date=${day}`, p);
      job = { id: r.job, w: (p.width || 1024) * (p.enable_hr ? p.hr_scale : 1), h: (p.height || 1024) * (p.enable_hr ? p.hr_scale : 1) };
      outRoot = r.outputs_root || LD.outputs_root || "outputs";
      lastPreviewN = -1;
      results = [];
      poll();
    } catch (e) { busy(false); setStatus(e.message, true); setForever(false); }
  }
  async function interrupt() {
    if (forever) setForever(false);
    if (window.LDVideo && window.LDVideo.busy()) return window.LDVideo.stop();
    if (!job) return;
    await post("/api/interrupt?job=" + job.id).catch(() => {});
    setStatus("Interrupting…");
  }
  function busy(on) {
    $("#btn-generate").classList.toggle("busy", on);
    $("#btn-interrupt").disabled = !on;
    $("#btn-skip").disabled = !on;
    if (!on) { $("#prog-bar").style.width = "0"; $("#viewer-progress").textContent = ""; }
  }
  const toUrl = (path, root) => {
    path = String(path).replace(/\\/g, "/");
    root = String(root).replace(/\\/g, "/").replace(/\/$/, "");
    return "/outputs" + (path.startsWith(root) ? path.slice(root.length) : "/" + path.split("/").slice(-3).join("/"));
  };
  async function poll() {
    if (!job) return;
    let s;
    try { s = await api("/api/status?job=" + job.id); } catch (e) { setStatus("Lost the server: " + e.message, true); pollT = setTimeout(poll, 1500); return; }
    const total = s.steps * Math.max(1, s.batches);
    const done = s.batch * s.steps + s.step;
    $("#lcd-main").textContent = s.state === "running" || s.state === "decoding" ? `${String(s.step).padStart(2, "0")}/${s.steps}` : s.state === "loading" ? "LOAD" : s.state === "queued" ? "QUEUE" : $("#lcd-main").textContent;
    $("#lcd-time").textContent = fmtTime(s.elapsed);
    $("#prog-bar").style.width = Math.round((s.progress || 0) * 100) + "%";
    const batchTxt = s.batches > 1 ? ` · batch ${s.batch + 1}/${s.batches}` : "";
    if (s.state === "queued") setStatus(s.queue > 1 ? `Waiting (${s.queue - 1} ahead)` : "Starting…");
    else if (s.state === "loading") setStatus((s.message || "Loading") + "…");
    else if (s.state === "running" && /^upscaling/.test(s.message || "")) setStatus(s.message[0].toUpperCase() + s.message.slice(1) + "…");
    else if (s.state === "running") setStatus(`Sampling ${s.step}/${s.steps}${batchTxt} · ETA ${fmtTime(s.eta)}${s.message && /hires/.test(s.message) ? " · " + s.message : ""}`);
    else if (s.state === "decoding") setStatus("Decoding" + batchTxt);
    $("#viewer-progress").textContent = s.state === "running" ? `${Math.round(s.progress * 100)}%  ·  ${done}/${total}` : "";
    if (s.images.length !== results.length) showResults(s, false);
    if (s.state === "running" && $("#opt-preview").checked && s.preview_n !== lastPreviewN) {
      lastPreviewN = s.preview_n;
      api("/api/preview?job=" + job.id).then((r) => { if (r.image && job) showPreview("data:image/png;base64," + r.image); }).catch(() => {});
    }
    if (["done", "interrupted", "error", "unknown"].includes(s.state)) return finish(s);
    pollT = setTimeout(poll, 350);
  }
  function showPreview(src) {
    const v = $("#viewer"), img = $("#out-preview");
    img.src = src;
    const sc = Math.min(v.clientWidth / job.w, v.clientHeight / job.h, 1);
    img.style.width = job.w * sc + "px"; img.style.height = job.h * sc + "px";
    v.classList.add("show-pv"); v.classList.remove("show-out");
  }
  function showResults(s, final) {
    results = s.images.map((p, i) => ({ url: p ? toUrl(p, outRoot) : "", path: p, seed: s.seeds[i], info: s.infotexts[i] }));
    renderThumbs();
    if (results.length) select(final ? 0 : results.length - 1);
  }
  function renderThumbs() {
    $("#thumbs").innerHTML = results.length > 1 ? results.map((r, i) => `<img src="${r.url}" data-i="${i}" alt="seed ${r.seed}" title="seed ${r.seed}">`).join("") : "";
  }
  $("#thumbs").addEventListener("click", (e) => { const t = e.target.closest("img"); if (t) select(+t.dataset.i); });
  function select(i) {
    if (i < 0 || !results[i]) return;
    shown = results[i];
    const v = $("#viewer");
    $("#out-img").src = shown.url;
    v.classList.add("show-out"); v.classList.remove("show-pv");
    $("#infotext").textContent = shown.info || "";
    const a = $("#a-save"); a.href = shown.url; a.download = (shown.path || "image.png").split("/").pop();
    $$("#thumbs img").forEach((t) => t.classList.toggle("on", +t.dataset.i === i));
    store.set("shown", shown);
  }
  $("#out-img").addEventListener("click", () => shown && openLightbox(shown.url, shown.info));
  function finish(s) {
    const elapsed = s.elapsed;
    job = null;
    busy(false);
    $("#lcd-main").textContent = s.state === "error" ? "ERR" : `${String(s.step).padStart(2, "0")}/${s.steps}`;
    if (s.state === "error") { setStatus(s.error || "Error", true); toast(s.error || "Error"); setForever(false); $("#viewer").classList.remove("show-pv"); if (shown) $("#viewer").classList.add("show-out"); return; }
    showResults(s, true);
    $("#notes").textContent = (s.notes || []).join("\n");
    setStatus(`${s.state === "interrupted" ? "Interrupted" : "Done"} · ${s.images.length} image${s.images.length === 1 ? "" : "s"} · ${elapsed.toFixed(1)} s${s.model ? " · " + s.model : ""}`);
    if (!s.images.length) $("#viewer").classList.remove("show-pv");
    refreshEngine();
    if (forever && s.state === "done") setTimeout(generate, 150);
  }

  // ── WebUI infotext → fields ("Read Params", PNG Info, Send to …) ──
  function parseInfotext(text) {
    const lines = String(text || "").trim().split("\n");
    let li = lines.length - 1;
    while (li >= 0 && !/^\s*Steps: /.test(lines[li])) li--;
    if (li < 0) return null;
    const head = lines.slice(0, li).join("\n");
    const ni = head.search(/^Negative prompt:/m);
    const out = { prompt: ni >= 0 ? head.slice(0, ni).trim() : head.trim(), negative_prompt: ni >= 0 ? head.slice(ni + 16).trim() : "" };
    const re = /\s*([\w ./-]+):\s*("(?:\\.|[^\\"])*"|[^,]*)(?:,|$)/g;
    let m;
    const kv = {};
    while ((m = re.exec(lines.slice(li).join(", ")))) { if (!m[1]) break; kv[m[1].trim()] = m[2].trim().replace(/^"|"$/g, ""); if (m.index === re.lastIndex) re.lastIndex++; }
    const num = (k) => (k in kv ? +kv[k] : undefined);
    if (kv.Steps) out.steps = num("Steps");
    if (kv.Sampler) {
      let s = kv.Sampler;
      const sch = s.match(/ (Karras|Exponential)$/);
      if (sch) { s = s.slice(0, -sch[0].length); out.scheduler = sch[1]; }
      out.sampler_name = s;
    }
    if (kv["Schedule type"]) out.scheduler = kv["Schedule type"];
    if (kv["CFG scale"]) out.cfg_scale = num("CFG scale");
    if (kv.Seed) out.seed = num("Seed");
    if (kv.Size) { const [w, h] = kv.Size.split("x").map(Number); out.width = w; out.height = h; }
    if (kv["Clip skip"]) out.clip_skip = num("Clip skip");
    if (kv["Denoising strength"]) out.denoising_strength = num("Denoising strength");
    if (kv["Hires upscale"]) { out.enable_hr = true; out.hr_scale = num("Hires upscale"); out.hr_denoise = out.denoising_strength; }
    if (kv["Hires steps"]) out.hr_second_pass_steps = num("Hires steps");
    if (kv["Hires upscaler"]) out.hr_upscaler = kv["Hires upscaler"];
    if (kv.Model) out.model = kv.Model;
    return out;
  }
  function applyParams(p) {
    if (!p) return;
    const map = { prompt: "prompt", negative_prompt: "negative", sampler_name: "sampler", scheduler: "scheduler", steps: "steps", cfg_scale: "cfg_scale", seed: "seed", width: "width", height: "height", clip_skip: "clip_skip", batch_size: "batch_size", n_iter: "n_iter", hr_scale: "hr_scale", hr_upscaler: "hr_upscaler", hr_second_pass_steps: "hr_second_pass_steps", hr_denoise: "hr_denoise", enable_hr: "enable_hr", resize_mode: "resize_mode" };
    for (const [k, id] of Object.entries(map)) if (p[k] !== undefined) setv(id, p[k]);
    if (p.denoising_strength !== undefined && !p.enable_hr) setv("denoising_strength", p.denoising_strength);
    if (p.model) {
      const o = [...$("#ckpt").options].find((o) => o.text.replace(/\.\w+$/, "").split("/").pop().toLowerCase() === String(p.model).toLowerCase());
      if (o && o.value !== $("#ckpt").value) selectModel(o.value);
    }
    if (p.checkpoint && [...$("#ckpt").options].some((o) => o.value === p.checkpoint) && p.checkpoint !== $("#ckpt").value) selectModel(p.checkpoint);
    hrCard(); changed(); countTokens();
  }
  function pasteParams(text, announce) {
    const p = parseInfotext(text);
    if (!p) { if (announce) toast("Paste a generation infotext (it ends with a 'Steps: …' line) into the prompt first"); return false; }
    applyParams(p);
    if (announce) toast("Read the parameters");
    return true;
  }

  // ── PNG info ──
  let pngData = null, pngText = "";
  async function pngInfo(data) {
    pngData = data;
    $("#png-img").src = data;
    $("#png-drop").classList.add("has");
    try { const r = await post("/api/png-info", data); pngText = r.info; $("#png-text").textContent = r.info || "This PNG carries no generation parameters."; }
    catch (e) { $("#png-text").textContent = e.message; }
  }
  dropZone($("#png-drop"), $("#png-file"), (d) => pngInfo(d));
  function pngTo(where) {
    if (!pngText) return toast("No parameters to send");
    pasteParams(pngText, false);
    if (where === "img2img" && pngData) setInit(pngData);
    setTab(where);
  }

  // ── gallery ──
  let galPage = 0, galMode = "txt2img";
  async function loadGallery() {
    try {
      const r = await api(`/api/gallery?mode=${galMode}&page=${galPage}`);
      const pages = Math.max(1, Math.ceil(r.total / r.per));
      if (galPage >= pages) { galPage = pages - 1; return loadGallery(); }
      $("#gal-page").textContent = `${galPage + 1} / ${pages}  ·  ${r.total} images`;
      $("#gallery").innerHTML = r.images.length ? r.images.map((im) => `<figure data-url="${esc(im.url)}" data-path="${esc(im.path)}"><img loading="lazy" decoding="async" src="${esc(im.url)}" alt=""><figcaption>${esc(im.name)}</figcaption></figure>`).join("") : `<div class="empty">Nothing in ${galMode} yet.</div>`;
    } catch (e) { $("#gallery").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  $("#gal-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; galMode = b.dataset.mode; galPage = 0; $$("#gal-mode button").forEach((x) => x.classList.toggle("on", x === b)); loadGallery(); });
  $("#gallery").addEventListener("click", async (e) => {
    const f = e.target.closest("figure"); if (!f) return;
    let info = "";
    try { info = (await post("/api/png-info", f.dataset.path)).info; } catch { /* no info */ }
    openLightbox(f.dataset.url, info);
  });
  function openLightbox(url, info) {
    const lb = $("#lightbox");
    lb._url = url; lb._info = info;
    $("#lb-img").src = url;
    $("#lb-info").textContent = info || "";
    $("#lb-save").href = url; $("#lb-save").download = url.split("/").pop();
    lb.classList.remove("hidden");
  }
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") e.currentTarget.classList.add("hidden"); });

  // ── settings ──
  async function loadSettings() {
    try {
      const s = await api("/api/settings");
      const f = $("#settings-form");
      for (const k of ["models_dir", "lora_dir", "vae_dir", "outputs_root", "device", "precision", "edit_device", "edit_encoder_device", "idle_unload_minutes"]) if (f.elements[k]) f.elements[k].value = s[k] ?? "";
      f.elements.sliced_attention.checked = !!s.sliced_attention;
      refreshEngine();
    } catch (e) { $("#settings-msg").textContent = e.message; }
  }
  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, body = {};
    for (const k of ["models_dir", "lora_dir", "vae_dir", "outputs_root", "device", "precision", "edit_device", "edit_encoder_device"]) body[k] = f.elements[k].value.trim();
    body.idle_unload_minutes = Math.max(0, +f.elements.idle_unload_minutes.value || 0);
    body.sliced_attention = f.elements.sliced_attention.checked;
    try { const s = await post("/api/settings", body); LD.settings = s; $("#settings-msg").textContent = "Saved. New folders are scanned now; device and precision apply on the next run."; refreshModels(); }
    catch (err) { $("#settings-msg").textContent = err.message; }
  });

  // ── keyboard ──
  document.addEventListener("keydown", (e) => {
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k === "Enter") { e.preventDefault(); return generate(); }
    if (k === "Escape") {
      if (!$("#lightbox").classList.contains("hidden")) return $("#lightbox").classList.add("hidden");
      if (!$("#modal").classList.contains("hidden")) return $("#modal").classList.add("hidden");
      if (menus.some((m) => m.classList.contains("open"))) return closeMenus();
      return interrupt();
    }
    if (k === "F2") { e.preventDefault(); return toggleView("sidebar"); }
    if (k === "F3") { e.preventDefault(); return toggleView("mixer"); }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") { e.preventDefault(); return act("save"); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "+" || k === "=")) { e.preventDefault(); return textSize("+"); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "_" || k === "-")) { e.preventDefault(); return textSize("-"); }
    if ((e.ctrlKey || e.metaKey) && k === "0") { e.preventDefault(); return textSize("0"); }
  });

  // the Video tab (static/video.js) drives the same engine with these
  window.LDApp = { api, post, toast, setStatus, getv, setv, changed, fmtTime, toUrl, esc, store, openLightbox, getTab: () => tab, isBusy: () => !!job, busy, el };

  // ── start ──
  restore();
  if (!store.get("view.sidebar", true)) toggleView("sidebar");
  if (!store.get("view.mixer", true)) toggleView("mixer");
  document.documentElement.style.setProperty("--fs", store.get("text", 13) + "px");
  setTab(store.get("tab", "txt2img") === "settings" ? "txt2img" : store.get("tab", "txt2img"));
  selectModel(null, true);
  hrInfo();
  countTokens();
  engineLine(LD.engine);
  const last = store.get("shown", null);
  if (last && last.url) { results = [last]; select(0); }
})();
