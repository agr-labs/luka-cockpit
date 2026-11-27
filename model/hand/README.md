# Hand model candidate

`rh56_hand.urdf` + `meshes/` — Inspire RH56DFX, pruned to the hand subtree and decimated
for the web bundle. MIT licensed.

It **is wired into the twin** as an approximation: mounted at each wrist, scaled 1.32,
with six driven joints and URDF mimic couplings. Rebuild without it via
`HAND=0 node tools/build-model.mjs`. See `PROVENANCE.md` for the dimensional caveat.

If it is mounted later, the six AGIBOT hand channels map as:

| Channel | Joint (per side) |
|---|---|
| `thumb_pos_0` | `thumb_1` (yaw) |
| `thumb_pos_1` | `thumb_2` (flexion) |
| `index_pos` | `index_1` |
| `middle_pos` | `middle_1` |
| `ring_pos` | `ring_1` |
| `pinky_pos` | `little_1` |

with `_2`/`_3`/`_4` driven by the URDF mimic multipliers.
