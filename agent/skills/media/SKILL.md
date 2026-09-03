---
name: media
description: Generate images and video with OpenRouter's media endpoints, and save them into the conversation. Use when the user asks for a picture, illustration, logo, diagram-as-image, pixel art, or for a video, animation, animated clip, moving image, or GIF. A request for motion means the video endpoint — never a screenshot of a CSS animation, which is one frame.
allowed-tools: Bash, Read
---

# Generating images and video

The model a conversation runs on is a **text** model — it reasons and calls tools.
Generating a picture is one of those tools: a call to OpenRouter's media endpoints,
not something the chat model does by itself. Asking a chat model for an image gets
you a description of one.

Requires `OPENROUTER_API_KEY`, which is set whenever an OpenRouter key is configured
in Settings → Connectors → Model provider. If it's empty, say so rather than
improvising — no other route exists.

## Images

```bash
curl -s https://openrouter.ai/api/v1/images \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-3.1-flash-image",
    "prompt": "pixel art island at sunset, 8-bit retro game style",
    "n": 1,
    "output_format": "png"
  }' -o /tmp/img.json
```

The image comes back **base64 in `data[0].b64_json`**, with its type in
`data[0].media_type`. Decode it straight into the conversation's uploads folder:

```bash
DIR="/jarvis/agent/workspace/uploads/$JARVIS_CONVERSATION_ID"
mkdir -p "$DIR"
FILE="$DIR/$(uuidgen).png"
python3 -c "import json,base64,sys; open(sys.argv[2],'wb').write(base64.b64decode(json.load(open(sys.argv[1]))['data'][0]['b64_json']))" /tmp/img.json "$FILE"
```

Then reference it in your reply with the **full path**, which the UI rewrites to a
served URL:

```markdown
![Pixel art island at sunset](/jarvis/agent/workspace/uploads/<conversation-id>/<file>.png)
```

**Options worth knowing:** `aspect_ratio` ("16:9", "1:1", "9:16"), `size`/`resolution`
("512", "1K", "2K", "4K"), `quality` ("low", "medium", "high"), `background`
("transparent" for logos and icons), `seed` for a reproducible result.

**Models:** `google/gemini-3.1-flash-image` is fast and cheap and a good default.
`google/gemini-3-pro-image` and `openai/gpt-5.4-image-2` are stronger and cost more.
A generation runs a few cents — mention the cost if the user asks for many.

## Video

Video is asynchronous: submit, then poll.

```bash
curl -s https://openrouter.ai/api/v1/videos \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"google/veo-3.1","prompt":"a serene mountain lake at dawn"}'
```

**Send model and prompt only.** Every other parameter is provider-specific, and a
plausible-looking default is worse than nothing: `"resolution":"720p"` is rejected
outright by some models (Hailuo takes 768p or 480p) with a `400`. Omit them and each
provider uses what it actually supports. Add one only when the user asks for it and
you know that model accepts it.

That returns `202` with `{ "id": "...", "status": "pending" }`. Poll
`GET https://openrouter.ai/api/v1/videos/<id>` until `status` is `completed`
(or `failed` / `cancelled` / `expired` — stop on those and report why). The finished
video arrives as **URLs in `unsigned_urls`**, not base64, so download the first one
into the uploads folder the same way and link it.

Polling takes minutes, not seconds. Tell the user it's running rather than going
silent, and don't poll faster than every 10 seconds.

## Guidelines

- **Write into the conversation's own folder** (`uploads/$JARVIS_CONVERSATION_ID/`).
  Files there are served only to people who can see this conversation.
- **Show the image, don't describe it.** One markdown image line beats a paragraph
  about what you generated.
- **Say what it cost** if the user is generating several, or asked for 4K.
- **A failure is worth reporting plainly** — a 402 means the OpenRouter account is
  out of credit, and no amount of retrying fixes that.
