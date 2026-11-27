# LukaChat: first conversation interface

Preview: `http://127.0.0.1:8790/chat`. The existing audio test dashboard links to
it, and LukaChat's menu links back to that test page.

## Accepted layout direction

The operator requested on 2026-11-06 that head movement and other secondary
features live in the menu on every viewport. Future controls belong on the
connected controller's sticks/buttons, preserving the screen for the conversation.

The current layout follows that direction:

* Top: LukaChat, connection status, Menu.
* Center: current operator message and Luka's reply, with explicit page buttons
  for text longer than the available space. The body never scrolls.
* Bottom: hold-to-talk and the current input/turn state. Cancel appears while
  recording or waiting for transcription/reasoning.
* Menu: head controls, typing, model choice, saved voice with a quick voice picker, controller
  information and the original voice testing page.

**Menu → Change voice** groups available voices, shows their descriptions, and
offers a short preview through Luka’s speaker. **Use this voice** saves the
selection immediately for future replies; rate and pitch stay at their saved
values. The picker opens in its own panel so it does not crowd the conversation
or the menu. Grayson is the default male voice.

Touch/pointer and Space are supported. Standard 8BitDo profiles use LT for
hold-to-talk, RB plus the right stick for head movement, Menu to open settings,
B/east for back/cancel, Y/north for speak-again, and D-pad left/right for reader
pages. Existing Kishi/other standard profiles retain A/south for talk. Every new
connection, focus return and setup change requires released buttons before a
new action; analog triggers use hysteresis to avoid splitting one hold.

**Menu → Controller setup** shows live button/axis input and allows each action
to be assigned. Stick calibration captures center, right and up, including axis
indices and direction. Dead zone, pan inversion, tilt inversion and the head
hold requirement are adjustable. Profiles are stored locally per controller ID,
connection mapping and input dimensions. Unknown/raw Bluetooth layouts start
unassigned; they never inherit standard movement indices. No controller speech
or head command runs during setup. Calibration cancels on focus/visibility loss.

The menu's **8BitDo right stick · Luka's head** switch (generic wording for other
controllers) acquires the same bounded head lease as the manual arrows. It starts
off after reload. Release the guard and center the stick before steering;
releasing RB stops new jogs and an off-center stick must return to center before
rearming. These remain 2° position steps at 350–650 ms intervals, with one axis
and one command at a time, inside the existing ±10° pan / ±5° tilt envelope.
Menu/setup panels suppress movement. Disconnecting/changing controllers, hiding
the page or losing focus releases head control.

macOS identified the attached device as **8BitDo Ultimate 2C Wireless**, Bluetooth
LE, VID `2dc8` / PID `301b`. Its [official manual](https://download.8bitdo.com/Manual/Controller/Ultimate/Ultimate-2C-Wireless-Controller.pdf)
documents Windows and Android connection modes. macOS HID discovery is verified;
the actual browser input layout still needs a button press and a physical check
in Controller setup. L4/R4 must be checked through live input rather than assigned
assumed browser indices.

The menu's **Look toward visible faces** switch starts a local detector on the
robot's forward `interactive` camera. The current relay sends roughly one
keyframe per second. The bridge decodes frames in memory and runs OpenCV YuNet
locally; images are not shown to the browser, written to disk, sent to a cloud
service, or used to identify people. It follows the largest confident face
after two detections, with the existing 2° jog and ±10° pan / ±5° tilt limits.
If the face disappears, the feed goes stale, the page loses focus, or its
heartbeat expires, Luka returns to the captured start pose and releases the
head lease. Manual controls take priority. Face following starts off and stops
on page close or reload.

This is a limited first pass: the forward camera's rigid relationship to the
moving neck has not been calibrated, and the one-frame-per-second feed makes
tracking slow. The menu states this before activation. Do not treat the current
camera-to-joint mapping as calibrated; that physical follow check is still
outstanding.

## Conversation flow

Device microphone → 16 kHz mono WAV → local Whisper → Prism (or selected
reasoning provider) → saved Luka voice → robot speaker.

The app reuses Pose Lab's tested recording/ASR/reasoning design. It adds an
ASR-only `/transcribe` endpoint to Pose Lab's bridge at 4182, so LukaChat never
generates its old browser TTS as a second spoken reply. Proxy routes at 8790 are
same-origin, bounded and provider-allowlisted. The voice test page's `/turn`
pipeline remains available.

Input states are opening microphone, listening, transcribing, thinking,
preparing voice, speaking and idle/error. A press released while microphone
permission is pending is discarded. Pointer cancellation, Escape, visibility
loss and gamepad disconnect discard an active recording. Releasing sends a clip
only after 300 ms; recording caps at 20 seconds. Tracks close before inference.
Only one turn runs at a time, and the talk button waits while Luka speaks.

Cancel during transcription/reasoning prevents that turn from later speaking.
The current interface does not offer an interruption button once physical
playback is underway. The reply stays readable on a speaker failure, and
**Speak again** retries its audio without requesting another model answer.

The reasoning request carries the last six dialogue messages. This is recent
session context, not the future CoRa/Trellis durable memory integration.
Microphone capture uses the operator's device; the onboard microphone remains
owned by Luka's native agent. The eventual native-chat cutover is a separate
integration step.

## Playback finding from the live check

Luka's installed TTS service can return `is_sucess:false` for a request that is
actually queued, then report that trace as Playing and End with no error. Treating
the initial response as refusal stopped later chunks and falsely reported a
speaker error. The bridge now observes each unique playback trace through its
End status. It never blindly reposts a clip after that ambiguous acknowledgement.
The UI's speaking state comes from actual Playing/End observation, and the queue
stays occupied until completion. PCM rate and voice settings follow the current
bridge/profile configuration.

## Validation and next iteration

Desktop, portrait phone and landscape browser checks cover menu-only head
controls, no page/reader overflow, pagination, typed turns, microphone release
during a permission prompt, Space capture, recording cancellation, cancellation
while reasoning, and standard gamepad A. The right-stick movement mapping is
supports standard Gamepad API axes and saved custom calibration; it has not yet
been calibrated with the physical Kishi controller. Nine controller tests cover neutral rearming,
trigger hysteresis, raw-layout interlocks, saved-profile isolation, duplicate
bindings, guard separation and calibrated directions. Browser checks confirmed
button learning, stick calibration, persistence, guarded jogging, menu suppression
and disconnect release against intercepted head APIs; no robot motion was sent.
Focus-return trigger gating, calibration cancellation and portrait/landscape
menu bounds also passed; see [controller evidence](evidence/lukachat-8bitdo-controls-2026-11-07.json).
The physical 8BitDo-to-neck path is pending restored SSH access. Face following has not yet been validated
against a live person in Luka's camera feed.

A recorded browser turn traversed real Whisper, Prism, the saved voice profile,
and Luka's speaker. The completed utterance had two PCM chunks, both confirmed
through playback status. See
[`evidence/lukachat-conversation-2026-11-06.json`](evidence/lukachat-conversation-2026-11-06.json).

Phone/tablet microphone access needs a reachable HTTPS origin; the bridge can be
reached on the Mac's current LAN address or localhost at port 8790. PWA installation/hosting,
physical controller calibration, durable memory and camera integration are the
next layers after reviewing this screen.

Checks: `npm test`, `npm run test:head`, `npm run test:chat`, and
`npm run test:playback`, and `npm run test:controller`.
