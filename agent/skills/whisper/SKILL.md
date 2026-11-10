---
name: whisper
description: Transcribe audio (speech-to-text) using the local self-hosted speech-to-text service bundled with Jarvis. Use when the user asks to transcribe with Whisper, or wants local/offline/private speech-to-text that does not call an external API.
allowed-tools: Bash, Read, Write
---

# Whisper Skill — Local Speech-to-Text

Transcribe audio files with the self-hosted speech-to-text service that ships with Jarvis. It runs entirely on the local Docker network — no external API, no API key, nothing leaves the box. Prefer this when the user explicitly asks for Whisper or wants private/local transcription; otherwise the `elevenlabs` skill is the cloud alternative (it adds speaker labels and timestamps).

The name is historical: the service used to be Whisper, and now runs NVIDIA Parakeet v3, which is faster and more accurate on this CPU. It keeps Whisper's `/asr` endpoint.

## Service

- **Base URL:** `http://stt:9000` (internal Docker DNS — reachable directly from this agent)
- **Model:** NVIDIA Parakeet TDT 0.6B v3 (sherpa-onnx, CPU)
- **Languages:** 25 European ones, English and French among them — detected automatically, per piece of audio
- **Auth:** none

## Transcribe an audio file

```bash
curl -s -X POST "http://stt:9000/asr?output=txt" \
  -F "audio_file=@/path/to/audio.m4a"
```

The plain-text transcript is returned in the response body. The path of a shared/attached file is given to you in the prompt (under `[Attached file: ...]`) — pass that exact path to `audio_file`.

### Options

- `output=txt` — plain text (default); `output=json` gives `{ "text": "…" }`

There is no translation, forced language, timestamps or subtitle output. For subtitles or speaker labels, use the `elevenlabs` skill.

## Notes

- Supported formats: mp3, wav, m4a, ogg, flac, webm, mp4 and more (ffmpeg-backed).
- Long recordings are fine: they are cut at pauses and transcribed piece by piece.
- This is the same engine the backend uses for voice input.
