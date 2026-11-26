"""Reference tensors from diffusers / transformers, used only to check the Ling engine's
Qwen-Image-Edit port (crates/ling-diffusion/src/qwen). LingDiffusion itself never runs this.

    python tools/qwen_reference.py vae <model_dir> <image> <rust.safetensors>
    python tools/qwen_reference.py vl  <model_dir> <rust.safetensors> "<prompt>"
"""
import sys

import numpy as np
import torch
from safetensors.torch import load_file


def stats(name, a, b):
    a = a.float().flatten()
    b = b.float().flatten()
    cos = torch.nn.functional.cosine_similarity(a, b, dim=0).item()
    print(f"{name}: shape ok, max|diff|={(a - b).abs().max().item():.4f} mean|diff|={(a - b).abs().mean().item():.5f} cos={cos:.6f}")


def vae(model_dir, image, rust):
    from diffusers import AutoencoderKLQwenImage
    from PIL import Image

    r = load_file(rust)
    m = AutoencoderKLQwenImage.from_pretrained(model_dir + "/vae", torch_dtype=torch.float32).to("cuda:1")
    img = Image.open(image).convert("RGB")
    w, h = img.width // 16 * 16, img.height // 16 * 16
    x = torch.from_numpy(np.asarray(img.crop((0, 0, w, h)))).permute(2, 0, 1).float() / 127.5 - 1
    x = x[None, :, None].to("cuda:1")
    with torch.no_grad():
        mu = m.encode(x).latent_dist.mode()
        mean = torch.tensor(m.config.latents_mean).view(1, 16, 1, 1, 1).to(mu)
        std = torch.tensor(m.config.latents_std).view(1, 16, 1, 1, 1).to(mu)
        z = (mu - mean) / std
        stats("latent", z[:, :, 0].cpu(), r["latent"])
        y = m.decode(r["latent"][:, :, None].to("cuda:1") * std + mean).sample[:, :, 0]
        stats("decoded (from the rust latent)", y.cpu(), r["decoded"])


def vl(model_dir, rust, prompt):
    from transformers import Qwen2_5_VLForConditionalGeneration, Qwen2VLProcessor
    from PIL import Image

    r = load_file(rust)
    px = r["pixels"].numpy()
    img = Image.fromarray(px)
    proc = Qwen2VLProcessor.from_pretrained(model_dir + "/processor")
    m = Qwen2_5_VLForConditionalGeneration.from_pretrained(model_dir + "/text_encoder", torch_dtype=torch.bfloat16).to("cuda:1")
    tmpl = "<|im_start|>system\nDescribe the key features of the input image (color, shape, size, texture, objects, background), then explain how the user's text instruction should alter or modify the image. Generate a new image that meets the user's requirements while maintaining consistency with the original input where appropriate.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
    txt = tmpl.format("Picture 1: <|vision_start|><|image_pad|><|vision_end|>" + prompt)
    # the image is already at a 28-multiple size, so the processor does not resize it again
    inp = proc(text=[txt], images=[img], padding=True, return_tensors="pt").to("cuda:1")
    print("grid", inp.image_grid_thw.tolist(), "tokens", inp.input_ids.shape)
    with torch.no_grad():
        out = m(input_ids=inp.input_ids, attention_mask=inp.attention_mask, pixel_values=inp.pixel_values, image_grid_thw=inp.image_grid_thw, output_hidden_states=True)
    hs = out.hidden_states[-1][0, 64:].float().cpu()
    print("ref", tuple(hs.shape), "rust", tuple(r["hidden"].shape))
    n = min(hs.shape[0], r["hidden"].shape[0])
    stats("hidden", hs[:n], r["hidden"][:n])
    per_tok = torch.nn.functional.cosine_similarity(hs[:n], r["hidden"][:n].float(), dim=1)
    print("per-token cos min/mean", per_tok.min().item(), per_tok.mean().item())


def dit(model_dir, rust, blocks):
    """The first `blocks` MMDiT blocks with the GGUF's weights (dequantized), zero_cond_t as in
    current diffusers (patched in: diffusers 0.36 predates it)."""
    import gguf
    from diffusers import QwenImageTransformer2DModel
    from diffusers.models.transformers import transformer_qwenimage as tq

    nb = int(blocks)
    r = load_file(rust)
    rd = gguf.GGUFReader(model_dir + "/transformer/qwen-image-edit-2511-Q4_K_M.gguf")
    sd = {}
    for t in rd.tensors:
        if t.name.startswith("transformer_blocks."):
            if int(t.name.split(".")[1]) >= nb:
                continue
        if t.name.startswith("__"):
            continue
        a = gguf.quants.dequantize(t.data, t.tensor_type)
        sd[t.name] = torch.from_numpy(np.ascontiguousarray(a)).reshape(list(reversed([int(x) for x in t.shape])))
    m = QwenImageTransformer2DModel(num_layers=nb, out_channels=16, guidance_embeds=False)
    missing, unexpected = m.load_state_dict(sd, strict=False)
    print("missing", [k for k in missing if "pos_embed" not in k][:5], "unexpected", unexpected[:5])
    m = m.to("cuda:1", torch.bfloat16).eval()

    def modulate(self, x, mod_params, index=None):
        shift, scale, gate = mod_params.chunk(3, dim=-1)
        if index is not None:
            b = shift.size(0) // 2
            ix = index.unsqueeze(-1)
            pick = lambda t: torch.where(ix == 0, t[:b].unsqueeze(1), t[b:].unsqueeze(1))
            shift, scale, gate = pick(shift), pick(scale), pick(gate)
        else:
            shift, scale, gate = shift.unsqueeze(1), scale.unsqueeze(1), gate.unsqueeze(1)
        return x * (1 + scale) + shift, gate

    def block_fwd(self, hidden_states, encoder_hidden_states, temb, image_rotary_emb, modulate_index):
        img_mod_params = self.img_mod(temb)
        txt_mod_params = self.txt_mod(torch.chunk(temb, 2, dim=0)[0] if modulate_index is not None else temb)
        img_mod1, img_mod2 = img_mod_params.chunk(2, dim=-1)
        txt_mod1, txt_mod2 = txt_mod_params.chunk(2, dim=-1)
        img_modulated, img_gate1 = modulate(self, self.img_norm1(hidden_states), img_mod1, modulate_index)
        txt_modulated, txt_gate1 = modulate(self, self.txt_norm1(encoder_hidden_states), txt_mod1)
        img_attn, txt_attn = self.attn(hidden_states=img_modulated, encoder_hidden_states=txt_modulated, encoder_hidden_states_mask=None, image_rotary_emb=image_rotary_emb)
        hidden_states = hidden_states + img_gate1 * img_attn
        encoder_hidden_states = encoder_hidden_states + txt_gate1 * txt_attn
        m2, g2 = modulate(self, self.img_norm2(hidden_states), img_mod2, modulate_index)
        hidden_states = hidden_states + g2 * self.img_mlp(m2)
        t2, tg2 = modulate(self, self.txt_norm2(encoder_hidden_states), txt_mod2)
        encoder_hidden_states = encoder_hidden_states + tg2 * self.txt_mlp(t2)
        return encoder_hidden_states, hidden_states

    x = r["x"].to("cuda:1", torch.bfloat16)
    ctx = r["ctx"].to("cuda:1", torch.bfloat16)
    n = r["v"].shape[1]
    gh, gw = 16, 12
    img_shapes = [[(1, gh, gw), (1, gh, gw)]]
    with torch.no_grad():
        h = m.img_in(x)
        t = torch.tensor([0.7], device="cuda:1", dtype=torch.bfloat16)
        t = torch.cat([t, t * 0])
        index = torch.tensor([[0] * n + [1] * n], device="cuda:1", dtype=torch.int)
        c = m.txt_in(m.txt_norm(ctx))
        temb = m.time_text_embed(t, h)
        rope = m.pos_embed(img_shapes, [ctx.shape[1]], device="cuda:1")
        for b in m.transformer_blocks:
            c, h = block_fwd(b, h, c, temb, rope, index)
        h = m.norm_out(h, temb.chunk(2, dim=0)[0])
        v = m.proj_out(h)[:, :n]
    stats("velocity", v.float().cpu(), r["v"])


if __name__ == "__main__":
    {"vae": lambda: vae(*sys.argv[2:5]), "vl": lambda: vl(*sys.argv[2:5]), "dit": lambda: dit(*sys.argv[2:5])}[sys.argv[1]]()
