# mobile-3d-testing

A Vite + Three.js playground for trying out 3D ideas in the browser, with a
focus on how they actually behave on phones: touch input, device orientation,
GPU limits, and battery-friendly rendering.

## What's inside

- **Basics** — a lit, tweakable primitive (materials, color, wireframe) as a sanity check.
- **Particle Stress Test** — a point cloud with an adjustable count, for finding where a device's GPU starts to struggle.
- **Touch & Gyro** — visualizes raw multi-touch points and `deviceorientation` sensor data (with the iOS motion-permission prompt wired up).
- **Load Model (GLTF)** — drag & drop a `.glb`/`.gltf` file to inspect it on-device (triangle/node counts, wireframe toggle).
- **Space Sim (Touch Nav)** — a free-flight 6DOF lab: a cube and sphere placed far apart, found via an on-screen bearing compass. Built to A/B touch-navigation schemes: dual floating joysticks (rate-control translate + look, with a second finger on the look stick switching to a twist-to-roll gesture) vs. gyro-look + touch-thrust (device orientation for looking, one thumb for movement). Joysticks apply a logarithmic pseudo-haptic "wall" past their soft limit and synthesize click/thud audio as a Taptic Engine stand-in. Also has four independently toggleable fixes for rate-control overshoot: a gyro fine-trim layer (relative tilt nudges look on top of the stick, instead of replacing it), a time-based rate/position hybrid on the look stick (quick flicks are precise no-momentum nudges; holding promotes to continuous turning), a rotational-inertia mode (momentum while held, fast brake on release) to compare against the default instant-stop response, and a closing-rate readout on the compass so you can see you're approaching a target too fast before you sail past it.
- **Course: Ring Race** — timed run through a fixed slalom of rings, next target shown on an Elite-style 3D scanner (a tilted-disc HUD: bearing + range from the dot's polar position, altitude from a vertical stalk to its ground-plane shadow) rather than a flat compass. Best time persists locally.
- **Course: Structure Run** — timed flight down a winding tunnel (ribbed walls + a few jutting obstacles to dodge); hitting a wall/obstacle adds a time penalty with a brief invulnerability window and a screen flash, rather than resetting your run.
- **Course: Asteroid Shower** — timed run through a continuously-respawning field of drifting rocks to a large glowing finish gate (fly through it, same crossing check as the rings); same hit-penalty-and-flash feedback as Structure Run.

The three courses share a `FlightRig` (the exact touch-nav controls tuned in Space Sim — same GUI, same toggles) and a `CourseTimer` (countdown → racing → finished, hit penalties, localStorage best time).

FlightRig's vertical strafe and roll (the 4th/5th DOF beyond translate+look) have two switchable input modes ("Vertical/roll input" in the GUI):
- **Sliders** (default) — two persistent, always-visible edge sliders, both on the left (the GUI panel is right-anchored and can grow almost full-height, so a right-edge slider would end up fighting it for touches). Touch anywhere on one to jump the handle there and hold it deflected to sustain a rate — roll is rate control here, not position control, so holding a pose is enough; no continued motion needed.
- **Fingers** — the original multi-touch gestures: a second finger in the move-stick zone strafes up/down, a second finger on the look stick twists to roll (this one maps the twist angle directly to roll angle — precise, but physically hard to sustain past a partial turn since twisting fingers around each other runs out of comfortable range fast).

The whole app also blocks double-tap and pinch zoom at the event level (`core/prevent-zoom.ts`) — iOS Safari ignores the viewport meta's `user-scalable=no` since iOS 10, so `touch-action`/viewport settings alone can't be trusted to stop an accidental zoom from derailing the touch controls.

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
