# Voice console

`gateway/public/voice.html` — browser push-to-talk that turns speech into capability
commands through the gateway's normal gates. It never talks to the robot directly.

```
http://127.0.0.1:8788/voice.html
```

If the gateway was started with `GATEWAY_TOKEN`, append `?token=<token>`.

## Flow

```
mic / text → intent → POST /api/v1/robots/:id/commands
                       (lease → mode → capability → validation → audit)
```

The page selects the first simulator by default and takes a **simulate** lease. A
physical robot gets an **observe** lease only; commands are refused by the gateway
until a manual/assisted lease is explicitly acquired with the test-profile
attestation. Voice cannot bypass the software stop, profile locks, or the arm gate.

## Intents

| Phrase | Capability | Payload |
|---|---|---|
| “look left / right / up / down / centre” | `head.gaze` | yaw ±0.5, pitch ±0.3 |
| “open hands” / “close hands” | `hands.grasp` | both, open/close |
| “say …” / “speak …” | `voice.speak` | text |
| “listen on/off” | `voice.listen` | start/stop |
| “status” | read `state` | spoken summary |
| “stop / freeze / halt” | `POST /stop` | latches software stop |

Replies are spoken with the browser's `speechSynthesis`; the robot audio adapter is
still not built, so `voice.speak` on Luka is browser-side only. Microphone capture
uses the Web Speech API (Chrome/Edge); the text field is the fallback and is what the
gateway tests exercise headlessly.

## Verified on the simulator

```
look left                    → head.gaze, yaw +0.5
close hands                  → hands.grasp, both close
say hello from the voice console → speech.text = "hello from the voice console"
status                       → "Luka simulator: online, SIM_RELAX"
```

All four returned 200 through a simulate lease. The microphone path itself still
needs a live browser with mic permission.

## Audio + transcript bridge (`tools/luka-bridge.mjs`)

Runs on the Mac, uses the SSH jump/tunnel, and serves a same-origin dashboard at
**http://<mac-host>:8790/**.

```bash
node tools/luka-bridge.mjs
# BRIDGE_PORT=8790 BRIDGE_HOST=127.0.0.1   # desktop-only
# BRIDGE_HOST=0.0.0.0                     # tablet on the LAN (no auth)
```

What it taps:

| Stream | Source | Notes |
|---|---|---|
| **Heard by Luka** (ASR) | `/agibot/log/agent/agent.log`, `setAsrResult ... text:` | the agent owns the mic; its own ASR is the supported input transcript |
| **Spoken by Luka** (TTS) | same log, `PublishTtsStatus ... Text:` | vendor TTS text, not a re-transcription |
| **Speaker audio** | card 0 loopback (`plughw:0,1`) | silent unless Luka is speaking; browser click required to play |

- SSE: `/events`; snapshot: `/transcript`; WAV stream: `/audio`; health: `/health`.
- The agent's mic is **exclusively** open (`pcmC2D0c` owned by `agent`), so raw input
  audio is not available without altering Luka's voice stack. Input is transcribed
  from the agent's ASR instead.
- The head speaker is audible but is **not exposed as an ALSA capture**. The AIUI USB
  module is capture-only, bluealsa has no PCM objects, card-3 `DSPK1 Mux` is `None` with
  0 channels, and the agent holds the only loopback duplicate (`loop_in` is busy). The
  dashboard’s loopback player is therefore silent for the head speaker; the test tone
  verifies browser audio independently. A raw head-speaker tap would require the vendor
  audio/BT interface or reconfiguring the agent’s loopback.
- Bridge binds `0.0.0.0` by default for tablet access and has **no auth**; switch to
  `BRIDGE_HOST=127.0.0.1` on untrusted networks.

## Custom voice bridge (`/say`) and MCP tool

### Saved Luka voice

The approved default is stored in
[`config/luka-voice.json`](../config/luka-voice.json) and loaded at bridge startup;
starting `npm run voice` preserves that profile. The default is now Grayson at
0.75× speaking rate and −2 semitones. The test sliders still allow temporary
comparisons. LukaChat uses the saved voice and tuning without overriding them
per turn.

In LukaChat, **Menu → Change voice** opens a voice list with **Preview on Luka**
and **Use this voice**. Preview plays a short sample on the robot without saving
the selection. Use this voice saves the selected Inworld voice immediately for
future replies, including after a bridge restart, while keeping rate and pitch.
`POST /voice-profile` accepts only `{ "voice": "Grayson" }`; the MCP tool
`voice.set_default` uses the same endpoint. Voice changes require no robot reboot.

`GET /voice-profile` returns the effective profile without calling the voice
provider. LukaChat should use this endpoint for its initial voice settings.
Explicit `INWORLD_TTS_MODEL`, `INWORLD_VOICE`, `INWORLD_RATE`, and `INWORLD_PITCH`
environment variables override the saved values for a test run.

The bridge synthesises arbitrary text with Inworld or a selected macOS voice and
plays it through Luka’s head speaker via AimDK `PlayMediaFile`.

```bash
node tools/luka-bridge.mjs      # http://<mac>:8790/  (Speak as Luka card)
```

### HTTP

```bash
curl -s http://127.0.0.1:8790/voices

curl -s -X POST http://127.0.0.1:8790/say \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from the bridge."}'
# {"ok":true,"voice":"Samantha","chunks":1,"bytes":118902,"durationMs":3716,...}
```

Requirements found empirically:

- PCM **mono, signed 16-bit little-endian**, using the bridge's `PCM_RATE`
  (currently 24 kHz for the speaker path; browser ASR uploads remain 16 kHz)
- file under `/agibot/data/var/hal_audio/file/`
- `PlayMediaFile` receives the matching `sample_rate` explicitly
- keep files under ~256 KiB; the bridge targets 240 KB and sends a single file
  whenever the whole utterance fits

The bridge serialises calls through playback completion, and splits longer audio
near a low-energy point where possible. This prevents adjacent samples and long
utterance chunks from racing the active playback.

The installed service can return `is_sucess:false` and still queue/play a file.
The transient `tools/luka-playback.py` worker observes that file's trace through
`GetAudioStatus` Playing and End instead of treating the acknowledgement as the
result. A clip is posted once, and the next chunk waits for confirmed completion.

### MCP

`tools/luka-mcp.mjs` is a stdio MCP server exposing:

- `voice.speak_custom` — `{text, voice?, rate?}`
- `voice.list` — available macOS voices

Example client config:

```json
{
  "mcpServers": {
    "luka-voice": {
      "command": "node",
      "args": ["/Users/toby/a2-cockpit/tools/luka-mcp.mjs"]
    }
  }
}
```

The server talks to the bridge at `LUKA_SAY_URL` (default
`http://127.0.0.1:8790/say`). It returns the number of chunks and duration.

### Voice test result

`default_speaker_id` changes in `tts_config.conf` did **not** change the audible
voice on this build; `PlayMediaFile` did. The original config (003) was restored
after the test.
