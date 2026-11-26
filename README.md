# LingDiffusion

Stable Diffusion in Ling. A rebuild of AUTOMATIC1111's stable-diffusion-webui as a Ling program,
in the LingStationX look, with the same `/sdapi/v1` API.

The web UI and API are Ling (`app.ling`, `controllers/`). The diffusion runs **inside the Ling
interpreter** through the `sd_*` builtins (`../ling/crates/ling-diffusion`, on candle + CUDA).
There is no Python, no external model server, and nothing is shelled out to.

## Run

```
run.bat                       http://127.0.0.1:7860, on the GPU with the most free memory
run.bat --device cuda:1       render on a given GPU
run.bat --listen 0.0.0.0      share on the LAN
```

Other flags: `--port`, `--models <dir>`, `--loras <dir>`, `--vaes <dir>`, `--outputs <dir>`,
`--precision fp16|bf16|fp32`, `--ckpt <name>`. Settings saved from the Settings tab go to
`settings.json`. Flags take priority over it.

By default the app reads the checkpoints, LoRAs and VAEs of the original WebUI install in place
(`E:/MoonAI-Backup/Programs/SannyChat/imagination/models/...`), so nothing is copied.

## What it does

- **Checkpoints:** single-file SD 1.x and SDXL `.safetensors` / `.ckpt`, as the WebUI loads
  them. The dropdown only lists real checkpoints. A LoRA left in the checkpoint folder is
  recognised and skipped. Selecting a checkpoint starts loading it right away.
- **txt2img / img2img:** Euler a, Euler, Heun, DPM++ 2M, DPM++ 2M SDE and DDIM, with the
  Automatic, Uniform, Karras and Exponential schedules. Also CFG, clip skip, batch count and
  size, seeds (-1 = random), and the img2img resize modes.
- **Hires. fix:** upscale with Latent (nearest), Lanczos, or an ESRGAN model, then a second pass.
- **ESRGAN upscalers:** ESRGAN / Real-ESRGAN models (RRDBNet), e.g. `RealESRGAN_x4plus_anime_6B`
  for anime, `RealESRGAN_x4plus`, `4x-AnimeSharp`. They are used by the hires fix, by the Upscale
  button under the result (any factor; ×3 runs the ×4 model, then a Lanczos resize to exactly ×3),
  and by `/sdapi/v1/extra-single-image`. Found in `models/ESRGAN` and in the original install's
  `ESRGAN` and `RealESRGAN` folders. A `.pth` in PyTorch's old pre-1.6 format (such as
  `ESRGAN_4x.pth`) needs a one-time conversion: `python tools/convert_upscaler.py <file.pth>`.
- **Memory:** attention runs in chunks with f16 scores, so 1024² SD 1.5 and SDXL hires at 2048²
  fit on a 24 GB card. A txt2img job unloads the Edit tab's model when it shares the GPU.
- **Prompt syntax:** `(word:1.2)`, `((word))`, `[word]`, `\(`, `BREAK`, and prompts longer
  than 75 tokens (chunked the way the WebUI does it). `<lora:name:0.8>` merges kohya or PEFT
  LoRAs. The LoRA tab inserts the tag for you.
- **Live preview, interrupt, skip, Generate Forever,** and a queue: Generate never blocks
  the server.
- **PNG Info:** every PNG carries WebUI-style `parameters` text. Read Params, PNG Info and
  the Gallery send settings back to txt2img or img2img.
- **Large images:** the VAE always runs in fp32 (the WebUI's `--no-half-vae`). Large images
  are encoded and decoded in tiles, so SDXL at 1024² and hires at 2048² fit in VRAM.

- **Edit tab: instruction editing with Qwen-Image-Edit-2511.** Drop in a picture and write
  what to change: "add a red bow in her hair", "make the hair more detailed", "change her
  eyes to golden". The chips under the prompt fill in common anime edits.
  - "Keep Editing This" chains edits.
  - Hold "Original" to compare with the picture you started from.
  - "Send to Edit" works from any result.

  It runs inside the same Ling engine (`crates/ling-diffusion/src/qwen`):
  - Qwen2.5-VL-7B reads the instruction together with the picture.
  - The 20B MMDiT (GGUF Q4_K_M) runs on candle's quantized CUDA kernels.
  - The Qwen VAE encodes and decodes.

  Speeds:
  - Lightning 8 steps (default)
  - Lightning 4 steps
  - Full 40 steps with true CFG

  Get the model files (about 32 GB) with `python tools/download_edit_model.py` (resumable; every file is checked against the Hub's hash). By default the
  transformer runs on GPU 1 and the encoder on GPU 0 (set in Settings, or with
  `--edit-device` / `--edit-encoder-device`).

- **Video tab: restyle a video frame by frame** (live action to anime, for example). Drop in a
  video, write a style prompt and, if you like, a prompt schedule (`0: …`, `48: …`, `2.5s: … | denoise=0.5, cfg=8, seed=42`).
  Each frame is an img2img job with the selected checkpoint, sampler, size and LoRAs.
  - **Seed lock**: every frame starts from the same noise.
  - **Frame preservation**: the last stylized frame is warped along the video's motion (optical
    flow) and mixed into the next frame's init image.
  - **Identity anchor**: the same, from the first stylized frame of the current prompt line.
  - **Color lock**: each frame's palette is matched to that first frame.
  - **Deflicker**: the result is pulled toward the warped previous result.
  - Every warp has a confidence mask, so new objects, occlusions and cuts are redrawn instead of
    smeared. **Motion tolerance** sets how strict that is.
  - **Keyframe every N** diffuses only every Nth frame and tweens the rest from the two
    neighbouring keyframes, warped along the motion. **Interpolate ×2–×4** adds in-between
    frames to the result.
  - **Test This Frame** tries the settings on the frame under the playhead. Stop / Resume pick
    up where a run left off.
  - **Export WebM** encodes the result with the source's sound. The frames are also saved to
    `outputs/video-images/<date>/<run>/frames`, with the raw keyframes in `keys/` and the
    settings in `run.json`. The log shows an ffmpeg line for an mp4.

  The browser does the decoding, flow, warping and encoding (`static/video.js`), so the server
  still never touches a video file or shells out.

Not ported (yet): SD 2.x, inpainting / outpainting, ControlNet, face restoration (GFPGAN / CodeFormer),
training, and hypernetworks.

## API

The API tab has the full list. The main endpoints:

| | |
|---|---|
| `POST /sdapi/v1/txt2img`, `/img2img` | WebUI-compatible, synchronous: `{images, parameters, info}` |
| `GET /sdapi/v1/progress` | progress and a live preview of the running job |
| `GET /sdapi/v1/sd-models`, `loras`, `samplers`, `schedulers`, `sd-vae`, `upscalers` | lists |
| `POST /sdapi/v1/extra-single-image` | `{image, upscaler_1, upscaling_resize}` → `{image}` |
| `GET/POST /sdapi/v1/options` | `sd_model_checkpoint`, `sd_vae` |
| `POST /api/generate?mode=txt2img` | queued: answers `{job}` at once |
| `GET /api/status?job=ID` | state, step/steps, progress, eta, images, seeds, infotexts |

Because it speaks the WebUI API, LingAnime's SD bridge (`ling-paint`) and `sdai_generate_start`
can point at LingDiffusion as they are.

## Build the engine

`bin\ling-diffusion.exe` is the Ling interpreter built with `--features web,sd-cuda`:

```
tools\build_engine.bat            builds ..\ling into ..\ling\target-diffusion, copies the exe to bin\
tools\build_engine.bat example    only the engine's command-line smoke test
```

The script enters the VS 2022 x64 environment first, because nvcc needs `cl.exe`.

## Layout

```
app.ling                startup, configuration, routes
controllers/models.ling model folders, JSON helpers, output dates
controllers/ui.ling     the page (fills templates/index.html)
controllers/api.ling    the page's queued API (/api/*)
controllers/sdapi.ling  the AUTOMATIC1111 API (/sdapi/v1/*)
controllers/video.ling  the Video tab's run folders (/api/video/frame, /api/video/meta)
static/                 style.css (LingStationX palette and font), app.js, video.js (the Video tab)
tools/selftest.ling     tests for the Ling helpers: bin\ling-diffusion.exe run --interp tools/selftest.ling
models/clip/            CLIP BPE vocabulary (vocab.json, merges.txt)
```
