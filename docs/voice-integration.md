# Voice, skills and MCP integration review

Read-only investigation on 2026-11-06 against Luka (`ubuntu-orin`, AimDK on x86
`192.168.100.100:56322`). No robot config was changed.

## Current audio/voice stack

```
AIUI / Maono mic ──► agent (iFlytek AIUI ASR) ──► LLM (Omnis pipeline / Azure / Volcano)
                         │                                   │
                         └──────────── TTS (Baidu/Volcano/iFlytek) ──► hal_audio
                                                                        │
                                                multiplay_def → multi_def ├─► playback_def_plug (dmix APE) → head speaker
                                                                          └─► loop_out (10%) → loop_in → agent
```

- The head speaker is the **APE** path via `multiplay_def → multi_def → playback_def_plug`.
  It is not AIUI USB and not bluealsa.
- `loop_out` (`hw:Loopback,0,2`) already carries a 10% duplicate for the agent’s
  echo/ASR path, and `loop_in` (`hw:Loopback,1,2`) is held by the agent. **There is no
  free ALSA monitor.** Enabling one requires either a second duplicate in
  `/etc/asound.conf` + a hal_audio restart, or stopping/reconfiguring the agent.
- `AIUI-USB-MC` (card 4) is **capture-only** (one isochronous IN endpoint); no playback PCM.
- `bluealsa` runs but exposes **no PCM objects**; no paired device. It is not the head speaker.
- `DSPK1 Mux = None`, 0 channels while idle; it is not the audible path.
- `audio_send_ip/port = 127.0.0.1:9595` is configured, but no listener was present at
  rest; the TTS transport must be observed during an utterance.

## Plugin seams in the agent

| Seam | File / service | What it gives us |
|---|---|---|
| TTS voices | `config/agent/tts_config.conf` | engines `baidu_tts`, `volcano_tts`, `iflytek`; `speaker_list` 001/002/003; default `003` |
| TTS RPC | `TTSService` over AimRT HTTP :59301 | speak arbitrary text with the robot’s current audio path |
| ASR control | `AsrControl`, `WakeControl`, `QuitVoiceRequest` | start/stop listening, wake control |
| Mic source | `GetMicSourceRequest`, `SetMicSourceRequest` | inspect/select capture device |
| LLM | `config/agent/llm.config` | Azure OpenAI GPT-4o-mini, Volcano Ark, Omnis pipeline endpoint |
| Skills | `config/agent/skill.conf` | native task skills (intro, cancel, next stop, …) |
| Function calling | `config/agent/function_call.conf`, `volcano_function_call.conf` | **OpenAI-compatible JSON tool schemas** |
| RPC control | `SkillControl`, `FunctionCallControl` | invoke/control native skills and function calls |

No native MCP support was found in the config tree.

## Voice options

1. **Native speaker swap (lowest risk).** Add/select a speaker in `tts_config.conf`
   (`default_speaker_id`, `speaker_list`, engine). Requires editing config and restarting
   the agent. Existing engines are Baidu / Volcano / iFlytek.
2. **External TTS (custom voice) — working.** `PlayMediaFile` plays PCM files from
   `/agibot/data/var/hal_audio/file/`; it needs `sample_rate: 16000` in the request and
   files under ~256 KB. The bridge (`/say`, `tools/luka-mcp.mjs`) uses this. The config
   `default_speaker_id` did not affect the audible voice on this build.
3. **TTS RPC.** `TTSService/PlayTTS` works for the robot’s own voice, but the loaded
   `default_speaker_id` did not change its timbre. `SetTTSParameters` returned
   `CommonState_UNKNOWN` and did not change `GetTTSParameters`.

## MCP / skills options

**A. Function-call bridge (least invasive).** Translate MCP tool schemas into
`function_call.conf` entries. The file is already in OpenAI `tools` format, so the schema
mapping is direct. Remaining question: the agent executes a fixed set of function names;
unknown tools need a dispatcher behind `FunctionCallControl` or a custom skill.

**B. OpenAI-compatible orchestrator (recommended).** Keep Luka’s AIUI mic, wake word,
ASR and TTS; point the agent’s LLM at a local OpenAI-compatible server that we control.
That server is the MCP client and owns skills/tools:

```
AIUI ASR ─► agent ─► our /v1/chat/completions (MCP client) ─► reply text
                                                        └─► agent TTS ─► APE head speaker
```

- Tools call the gateway (`head.gaze`, `hands.grasp`, `arms.joints`, `voice.speak`,
  `motion.state`, domain skills), which keeps leases, validation, audit and the e-stop in
  one place.
- Voice identity remains Luka’s current TTS; add speakers in `tts_config.conf` for variety.
- Risks: `llm_type`/`LLMType_Pipeline` may not honour `openai_config` without a vendor
  flag; changing it needs a maintenance window. Suppress the native LLM/NLG path to avoid
  double replies.

**C. Full voice replacement (most invasive).** Stop/disable the agent, run our own
Whisper/LLM/TTS/MCP, use card 4 capture and APE playback. The agent currently owns the mic
and the loop duplicate, so this needs exclusive-device coordination and a rollback plan.

## MCP tool surface (proposed)

```
robot.state            → GET /api/v1/robots/:id/state
robot.joints           → GET /api/v1/robots/:id/joints
head.gaze              → POST commands (head.gaze)
hands.grasp            → POST commands (hands.grasp)
arms.joints            → POST commands (arms.joints)
voice.speak            → POST commands (voice.speak)
robot.stop             → POST /stop
robot.lease            → POST /leases
```

All motion tools stay behind the gateway’s leases and profile locks; physical Luka is
currently **observe-only** (0 commandable), so motion tools fail closed until authority is
explicitly granted.

## Phased plan

1. Probe `TTSService` / `AsrControl` AimRT HTTP paths (read-only requests, log responses).
2. Build a gateway MCP server and an OpenAI-compatible orchestrator; test locally on the
   simulator first.
3. Test `playback_def` mixing with a short tone in a maintenance window; if it works,
   external TTS voices can be injected without agent code changes.
4. Add a speaker entry in `tts_config.conf` as a low-risk native voice test; restart agent
   only with a rollback copy.
5. If the LLM endpoint swap is supported, point it at the orchestrator and disable the
   native LLM reply; otherwise fall back to the function-call bridge.

## Risks / notes

- Agent config contains cloud credentials; never commit the files or keys.
- `tts_config.conf` warns that raising volume above 1.0 can damage the speaker.
- Restarting `agent`/`hal_audio` interrupts voice and wake word; do it only with a
  maintenance window and a rollback.
- `loop_in` is exclusive; raw speaker capture is not available today.
