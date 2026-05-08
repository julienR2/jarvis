---
name: imagerouter
description: Generate AI images via ImageRouter (multi-model image generation API — Flux, SDXL, DALL·E, etc.). Use when the user asks to generate, create, draw, or render an image, picture, illustration, photo, or artwork.
allowed-tools: Bash, Read, Write
---

# ImageRouter Skill

Generate images through [ImageRouter](https://imagerouter.io) — a unified API in front of many image-generation models (Flux, Stable Diffusion, DALL·E, Ideogram, etc.).

## Credentials

- **API Key:** `${IMAGEROUTER_API_KEY}`
- **API base:** `https://api.imagerouter.io/v1`
- **Auth header:** `Authorization: Bearer ${IMAGEROUTER_API_KEY}`

---

## Generate an image

The endpoint is OpenAI-compatible (`/openai/images/generations`):

```bash
curl -s -X POST https://api.imagerouter.io/v1/openai/images/generations \
  -H "Authorization: Bearer ${IMAGEROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A ghibli-style island with a small village, warm afternoon light",
    "model": "black-forest-labs/FLUX-1-schnell:free",
    "size": "1024x1024",
    "n": 1
  }'
```

The response contains `data[].url` — download it into the uploads dir (see CLAUDE.md for the workspace layout):

```bash
URL=$(curl -s -X POST https://api.imagerouter.io/v1/openai/images/generations \
  -H "Authorization: Bearer ${IMAGEROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"…","model":"black-forest-labs/FLUX-1-schnell:free"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['url'])")

OUT="$WORKSPACE_DIR/uploads/img-$(date +%s).png"
curl -s "$URL" --output "$OUT"
echo "$OUT"
```

Then reference it in your reply with a markdown image link — see CLAUDE.md for the literal path format the chat detects.

---

## Picking a model

| Model | Notes |
|---|---|
| `black-forest-labs/FLUX-1-schnell:free` | Fast, free tier, good general quality |
| `black-forest-labs/FLUX-1-dev` | Higher quality, paid |
| `stabilityai/sdxl` | Stable Diffusion XL — flexible, good for art styles |
| `openai/dall-e-3` | Strongest at text-in-images and prompt fidelity (paid) |
| `ideogram-ai/ideogram-v2` | Best for posters / images with readable text |

For Ghibli/painterly styles, FLUX-dev or SDXL with a `--style ghibli` style prompt works well. For photoreal output, FLUX-dev or DALL·E 3.

List the catalogue at runtime:

```bash
curl -s https://api.imagerouter.io/v1/models \
  -H "Authorization: Bearer ${IMAGEROUTER_API_KEY}"
```

---

## Sizes

Common values for `size`: `512x512`, `1024x1024`, `1024x1792` (portrait), `1792x1024` (landscape). Some models accept arbitrary aspect ratios — check the model card.

---

## Common use cases

| Task | Approach |
|---|---|
| Quick free generation | `FLUX-1-schnell:free`, 1024x1024, n=1 |
| High-quality artwork | `FLUX-1-dev` or `sdxl`, 1024x1024 |
| Image with text | `dall-e-3` or `ideogram-v2` |
| Multiple variations | bump `n` to 2–4 in one request |

## Notes

- Save outputs to `$WORKSPACE_DIR/uploads/` so the chat UI displays them inline.
- Free-tier models have rate limits — back off and retry on 429.
- The API mirrors OpenAI's image-generations schema, so any OpenAI Python SDK pointed at this base URL also works.
