# mobile-3d-testing

A Vite + Three.js playground for trying out 3D ideas in the browser, with a
focus on how they actually behave on phones: touch input, device orientation,
GPU limits, and battery-friendly rendering.

## What's inside

- **Basics** — a lit, tweakable primitive (materials, color, wireframe) as a sanity check.
- **Particle Stress Test** — a point cloud with an adjustable count, for finding where a device's GPU starts to struggle.
- **Touch & Gyro** — visualizes raw multi-touch points and `deviceorientation` sensor data (with the iOS motion-permission prompt wired up).
- **Load Model (GLTF)** — drag & drop a `.glb`/`.gltf` file to inspect it on-device (triangle/node counts, wireframe toggle).

Each scene is a self-contained module in `src/scenes/`; add a new one by
creating a file that exports a `TestScene` (see `src/scenes/types.ts`) and
registering it in `src/scenes/index.ts`. Scenes are lazily loaded, so a new
scene's dependencies don't bloat the initial load.

Shared infrastructure lives in `src/core/`:

- `renderer-context.ts` — renderer, camera, and touch-friendly `OrbitControls` (one-finger rotate, two-finger pinch/pan), with resize handling.
- `ticker.ts` — the render loop; pauses automatically when the tab/app is backgrounded to save battery.
- `fps-meter.ts` — a rolling FPS readout in the topbar; tap it to open a detailed Stats.js panel (FPS/MS/MB).
- `device-info.ts` — an on-demand panel (ⓘ button) showing viewport size, DPR, GPU vendor/renderer, touch points, network info, etc. — handy for reporting bugs from a real device.

## Mobile-specific details

- Viewport meta uses `viewport-fit=cover` with safe-area-aware CSS so the UI clears notches/home indicators.
- `touch-action: none` + `overscroll-behavior: none` stop pull-to-refresh and pinch-zoom from fighting the 3D controls.
- Device pixel ratio is capped at 2 to keep fill-rate sane on high-DPI phones.
- The render loop pauses on `visibilitychange` so a backgrounded tab doesn't drain the battery.
- `vite.config.ts` sets `server.host: true` so `npm run dev` is reachable from a phone on the same network (check the "Network" URL Vite prints).

## Getting started

```bash
npm install
npm run dev       # local dev server; open the printed Network URL on your phone
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build locally
```

## Deploying to Cloudflare Workers

This repo is set up for [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
via `wrangler.jsonc` — no server-side code required, it just serves `dist/`.

```bash
npx wrangler login   # first time only
npm run deploy        # builds, then runs `wrangler deploy`
```

`wrangler.jsonc` also sets `build.command: "npm run build"`, so `wrangler
deploy` runs the Vite build itself before uploading `dist/`. That means if
you connect this repo to a Worker via Cloudflare's Git integration (Workers
Builds), you don't need to configure a Build command in the dashboard at
all — leave it as whatever it defaults to and just make sure the Deploy
command is `npx wrangler deploy`; wrangler builds fresh on every deploy.

`wrangler.jsonc` sets `name: "mobile-3d-testing"`; change it if you want a
different Workers subdomain (`<name>.<your-subdomain>.workers.dev`), or wire
up a custom domain/route in the Cloudflare dashboard afterwards.
