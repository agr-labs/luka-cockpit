# Deploy — static build to Cloudflare Pages

**Live: <https://luka.steadwell.cc>** (project `luka-cockpit`, account `2d571f09…`).

The same source runs in two environments, and they behave differently on purpose.

| | **sim** (Pages) | **local** (`node serve.mjs`) |
|---|---|---|
| Origin | static CDN | `127.0.0.1:8787` |
| Gateway `/api/*` | absent | read-only proxy to Luka |
| Live telemetry | **unavailable** — panel says STATIC | works, 0.2 Hz |
| Arm transport | none | none (schema still disabled) |
| Twin, playback, presets, sliders | full | full |
| Boot detection | `meta[name=luka-env]` marker | `/api/health` probe |

Detection happens once at boot in `src/env.js`, `src/landing.js`, `src/luka-sim.js`, and
`src/trellis-engine.js`, and never throws. A static build carries
`<meta name="luka-env" content="static">`, stamped by `tools/package-site.mjs` onto
`index.html` (Application Hub), `cockpit.html` (52-DOF Twin), and `luka-sim.html`
(Upper-Body Embodied Sim), so visitors never fire `/api/*`, `/sim-api/*`, or localhost
port probes that would 404 in the console.

## What CI does

`.github/workflows/deploy.yml` in this repository — runs on pushes to `main`, pull
requests, and manual dispatch. Three jobs:

1. **test** — `node --test gateway/test/*.test.mjs`. No secrets, no model payloads, no
   network. This is the job that must stay green; it is the gateway's contract.
2. **secrets** — checks whether the two Cloudflare secrets exist and exports
   `deploy=true|false`. Missing secrets produce an `::notice::` and `deploy=false`.
3. **deploy** — only runs when the gate says yes, then:
   - `tools/fetch-model.sh` — clones the upstream model repo and restores the gitignored
     payloads (URDF, 47 STLs, 3 recordings, MJCF).
   - `node tools/build-model.mjs` — regenerates `model/generated/*` with count assertions.
   - `node tools/package-site.mjs` — assembles `dist/` (runtime files only; source meshes,
     URDF and MJCF are build inputs and are excluded).
   - `wrangler pages deploy dist` — uploads.

A deploy that never ran is reported as **skipped**, not failed. The previous workflow
failed at a secrets gate on every push, which made a red X the steady state and trained
everyone to ignore CI.

FK verification (`tools/verify-fk.mjs`) is deliberately **not** in the deploy path: it
needs MuJoCo, and a Pages deploy should not depend on a Python simulation stack being
installable. Run it locally after touching the model.

## Current production setup (2026-10-28)

| Item | Value |
|---|---|
| Pages project | `luka-cockpit` |
| Production URL | `https://luka-cockpit.pages.dev` |
| Custom domain | `luka.steadwell.cc` — status **active**, Google cert, HTTP validation |
| DNS | proxied CNAME `luka` → `luka-cockpit.pages.dev` in zone `steadwell.cc` |
| Deployed with | `npx wrangler pages deploy dist --project-name luka-cockpit --branch main` |
| Verified | HTTP 200, SIM badge, twin at 60 fps, 22 MB mesh served, zero failed requests |

Two things learned doing it:

1. Adding the custom domain through the Pages API does **not** create the DNS record when the
   calling token lacks DNS scope. The record was created separately with a token that has it.
   If a future domain is added, expect the same two-step.
2. The locally cached negative DNS answer outlived the record — `curl` and the system resolver
   returned nothing while `1.1.1.1` and the edge served correctly. Flush before concluding
   anything is broken.

## Required configuration

Repo secrets:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages:Edit on the account |
| `CLOUDFLARE_ACCOUNT_ID` | account id |

Repo variable (optional): `CF_PAGES_PROJECT`, defaults to `luka-cockpit`.

Without both secrets the deploy job is skipped with a notice, and the test job still runs.
With them, the deploy is reproducible from `main`; nothing is deployed by hand.

Create the token at *My Profile → API Tokens* with **Account → Cloudflare Pages → Edit**,
then:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo agr-labs/luka-cockpit
gh secret set CLOUDFLARE_ACCOUNT_ID --repo agr-labs/luka-cockpit --body 2d571f0977b553c7565fb74ee54db998
```

## Payload

`node tools/package-site.mjs` prints the sizes and enforces Cloudflare's **25 MiB
per-asset** limit, failing the build if anything exceeds it.

| File | Size |
|---|---|
| `model/generated/luka.mesh.bin` | 20.37 MB ← largest, 5.85 MB of headroom |
| `model/recordings/*.a2rec` | 6.39 / 6.32 / 4.64 MB |
| everything else | < 200 KB |

Total ≈ 38.7 MB across 61 files (including the Application Hub `/`, Upper-Body Sim `/luka-sim.html`, and Full-Body Cockpit `/cockpit.html`). The mesh is served as one binary and parsed on the GPU
side; the recordings are fetched on demand when a user presses play.

If the mesh ever grows past the limit, the options in order of preference: quantise
positions to int16, split the buffer per limb and lazily load, or pre-compress with
Brotli and inflate via `DecompressionStream`. Do not commit the mesh to git to work around
it — it is generated, and `tools/fetch-model.sh` restores it deterministically.

## Headers

`dist/_headers` sets `Cache-Control: public, max-age=86400` for the generated model and
recordings (content is republished per deploy) and `no-cache` for HTML so the shell never
goes stale.

## Local parity check

Before pushing, reproduce what Pages will serve:

```sh
node tools/package-site.mjs
cd dist && python3 -m http.server 8791
# open http://127.0.0.1:8791/ → badge must read SIM, link panel STATIC, no failed requests
```

Then confirm local mode still works from the same source:

```sh
node serve.mjs     # http://127.0.0.1:8787/ → badge LOCAL, connect live works
```

If the badge reads LOCAL on a static host, the marker was not stamped — check that the
deploy ran `package-site.mjs` rather than uploading the repo directory directly.

## What the public build deliberately cannot do

- Reach Luka. There is no gateway, no credentials, and no tunnel. The page cannot address
  `192.168.4.136` from a browser even if the network allowed it: the AimDK gateway sends no
  CORS headers.
- Command motion. `config/arm-schema.json` ships `enabled: false`, and the arm transport is
  a `ROS 2 topic` that only exists robot-side.
- Leak anything sensitive. The schema file contains only public vendor interface facts.
  No passwords, keys, or robot-internal addresses are in the repo or the bundle.
