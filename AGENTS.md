# AGENTS.md

## Cursor Cloud specific instructions

This is a purely client-side Vite + TypeScript + Three.js single-page app (no backend, no database). All work happens in one service: the Vite dev server.

- Standard commands live in `package.json` scripts: `dev`, `build`, `typecheck`, `preview`, `deploy`.
- There is no lint script; `npm run typecheck` (`tsc --noEmit`) is the type/static check. `npm run build` also runs `tsc --noEmit` before `vite build`.
- Dev server: `npm run dev` serves on port `5173` (bound to `0.0.0.0` via `server.host: true`). Verify with `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` → `200`.
- The app targets mobile browsers (touch/gyro), but works in desktop Chrome: drag on the canvas to orbit; use the top-left dropdown to switch scenes (lazily loaded from `src/scenes/`).
- `deploy` (Cloudflare Workers via `wrangler`) requires `wrangler login` and is not needed for local development.
