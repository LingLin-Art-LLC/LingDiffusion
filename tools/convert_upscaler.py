"""Converts an upscaler saved in PyTorch's old (pre-1.6, non-zip) .pth format to .safetensors,
which LingDiffusion can read. Newer .pth files (RealESRGAN_x4plus*, most of openmodeldb) load as
they are and need no conversion.

    python tools/convert_upscaler.py <old.pth> [out_dir]      (default out_dir: models/ESRGAN)
"""
import os
import sys

import torch
from safetensors.torch import save_file

src = sys.argv[1]
out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "models", "ESRGAN")
sd = torch.load(src, map_location="cpu", weights_only=True)
for k in ("params_ema", "params", "state_dict"):
    if isinstance(sd, dict) and k in sd and isinstance(sd[k], dict):
        sd = sd[k]
sd = {k: v.contiguous() for k, v in sd.items() if torch.is_tensor(v)}
os.makedirs(out_dir, exist_ok=True)
dst = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + ".safetensors")
save_file(sd, dst)
print(f"{len(sd)} tensors -> {os.path.abspath(dst)}")
