---
name: elevenlabs
description: Transcribe audio (speech-to-text) and synthesize speech (text-to-speech) via the ElevenLabs API. Use when the user mentions ElevenLabs, transcription, speech-to-text, STT, text-to-speech, TTS, or asks to convert audio to text or generate spoken audio.
allowed-tools: Bash, Read, Write
---

# ElevenLabs Skill

Transcription and voice synthesis via ElevenLabs.

## Credentials

- **API Key:** `${ELEVENLABS_API_KEY}`
- **API base:** `https://api.elevenlabs.io/v1`
- **Auth header:** `xi-api-key: ${ELEVENLABS_API_KEY}`

ElevenLabs replaces Whisper for STT in this Jarvis instance — the backend's `/ws/audio` endpoint already routes to it. This skill is for ad-hoc transcription / synthesis work outside that flow.

---

## Speech-to-text (transcription)

### Transcribe an audio file

```bash
curl -s -X POST https://api.elevenlabs.io/v1/speech-to-text \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -F "model_id=scribe_v1" \
  -F "file=@/path/to/audio.mp3"
```

Returns JSON with `text`, `language_code`, and per-word timestamps.

Supported formats: mp3, wav, m4a, ogg, flac, webm, mp4 (audio track), up to ~25 MB / ~3 hours.

### Useful options

- `language_code=en` — force a language instead of auto-detect
- `diarize=true` — speaker labels on each word
- `tag_audio_events=true` — tag laughter, music, etc.

---

## Text-to-speech

### Synthesize speech to a file

```bash
VOICE_ID="21m00Tcm4TlvDq8ikWAM"   # "Rachel" — default voice
curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is Jarvis.","model_id":"eleven_multilingual_v2"}' \
  --output "$WORKSPACE_DIR/uploads/speech.mp3"
```

Then reference it in your reply with a markdown link — see CLAUDE.md for the literal path format the chat detects.

### List available voices

```bash
curl -s https://api.elevenlabs.io/v1/voices \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}"
```

---

## Models

| Model | Use case |
|---|---|
| `scribe_v1` | Speech-to-text — high quality, multilingual |
| `eleven_multilingual_v2` | TTS — best multilingual quality |
| `eleven_turbo_v2_5` | TTS — low latency, cheaper |
| `eleven_flash_v2_5` | TTS — lowest latency |

## Notes

- Quota is shared across STT and TTS. Check current usage: `GET /v1/user/subscription`.
- For long files, prefer the WebSocket streaming API (not covered here) to avoid 25 MB upload limits.
- Free tier voices are limited; premium voices need a paid subscription.
