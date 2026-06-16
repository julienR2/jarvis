---
name: whisper
description: Transcribe audio (speech-to-text) using the local self-hosted Whisper ASR service bundled with Jarvis. Use when the user asks to transcribe with Whisper, or wants local/offline/private speech-to-text that does not call an external API.
allowed-tools: Bash, Read, Write
---

# Whisper Skill — Local Speech-to-Text

Transcribe audio files with the self-hosted Whisper ASR web service that ships with Jarvis. It runs entirely on the local Docker network — no external API, no API key, nothing leaves the box. Prefer this when the user explicitly asks for Whisper or wants private/local transcription; otherwise the `elevenlabs` skill is the higher-quality cloud alternative.

## Service

- **Base URL:** `http://whisper:9000` (internal Docker DNS — reachable directly from this agent)
- **Engine:** faster-whisper, model `small`
- **Auth:** none

## Transcribe an audio file

```bash
curl -s -X POST "http://whisper:9000/asr?task=transcribe&output=txt" \
  -F "audio_file=@/path/to/audio.m4a"
```

The plain-text transcript is returned in the response body. The path of a shared/attached file is given to you in the prompt (under `[Attached file: ...]`) — pass that exact path to `audio_file`.

### Useful options

- `output=txt` — plain text (default here); also `json`, `srt`, `vtt`, `tsv`
- `task=transcribe` — keep the source language; use `task=translate` to render English
- `language=fr` — force a language instead of auto-detect
- `word_timestamps=true` — per-word timing (with `output=json`)

## Notes

- Supported formats: mp3, wav, m4a, ogg, flac, webm, mp4 and more (ffmpeg-backed).
- For subtitles, use `output=srt` or `output=vtt` and save the file to `$WORKSPACE_DIR/uploads/` so the user can download it.
- This is the same engine the backend falls back to for voice input when ElevenLabs is unavailable.
