# RH56 hand model — provenance

- **Source:** https://github.com/ookkshirsagar/rh56dfx_description (MIT)
- **Asset:** Inspire RH56DFX dexterous hand, 6 actuated DoF, 12 finger joints
- **Licence:** MIT — see `LICENSE` in this directory
- **What is vendored:** the hand subtree only (`*_hand_base` and descendants), with the
  wrist adapters removed; URDF in `rh56_hand.urdf`, STL visuals in `meshes/`
- **Processing:** STL visual meshes were vertex-merged and quadric-decimated to ~10% of
  their triangle count (`fast-simplification`), preserving the bounding box. Total 3.8 MB.
  This is a display mesh, not the vendor CAD.
- **Actuated joints:** thumb_1, thumb_2, index_1, middle_1, ring_1, little_1.
  Mimic: thumb_3 (×1.1425 of thumb_2), thumb_4 (×0.7508 of thumb_3), each finger _2
  (×1.1169 of its _1).
- **Not included:** the wrist_base / wrist_yaw adapters, inertials, collision meshes.

## Why it is not yet mounted

Luka's welded hand STL measures **163 × 210 × 55 mm**; this RH56 model measures
**82 × 159 × 101 mm**. The channel layout matches (AGIBOT `AgibotHandState`: thumb ×2 +
four fingers), but the geometry does not. Mounting it as-is would replace a wide, flat
hand with a smaller, thicker one.

It is mounted in the twin as a deliberate approximation (`HAND_SCALE = 1.32`, rotated 180°
about the finger axis so the palm faces inward, proximal end aligned to the wrist). Rebuild with `HAND=0 node tools/build-model.mjs` to restore the
welded A2 hand plus synthetic fingers. Replace the mount/scale here if the real AgiHand
model is obtained.
