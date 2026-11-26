"""Downloads Qwen-Image-Edit-2511 for LingDiffusion's Edit tab into models/qwen-image-edit-2511/
with huggingface_hub: resumable, and every file is checked against the Hub's hash.
(Only the download uses Python; LingDiffusion runs the model inside Ling.)

    python tools/download_edit_model.py
"""
import os

from huggingface_hub import hf_hub_download, snapshot_download

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "qwen-image-edit-2511")
os.makedirs(ROOT, exist_ok=True)

print("official: text encoder, VAE, tokenizer, configs")
snapshot_download(
    "Qwen/Qwen-Image-Edit-2511",
    local_dir=ROOT,
    allow_patterns=["model_index.json", "text_encoder/*", "vae/*", "tokenizer/*", "processor/*", "scheduler/*", "transformer/config.json"],
    max_workers=6,
)
print("transformer (GGUF Q4_K_M)")
hf_hub_download("unsloth/Qwen-Image-Edit-2511-GGUF", "qwen-image-edit-2511-Q4_K_M.gguf", local_dir=os.path.join(ROOT, "transformer"))
print("Lightning LoRAs")
for steps in (8, 4):
    hf_hub_download("lightx2v/Qwen-Image-Edit-2511-Lightning", f"Qwen-Image-Edit-2511-Lightning-{steps}steps-V1.0-bf16.safetensors", local_dir=os.path.join(ROOT, "lightning"))
print("done:", os.path.abspath(ROOT))
