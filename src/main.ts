import * as THREE from "three";
import GUI from "lil-gui";
import { RendererContext } from "./core/renderer-context.ts";
import { Ticker } from "./core/ticker.ts";
import { FpsMeter } from "./core/fps-meter.ts";
import { renderDeviceInfo } from "./core/device-info.ts";
import { sceneRegistry } from "./scenes/index.ts";
import type { SceneInstance } from "./scenes/types.ts";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const select = document.querySelector<HTMLSelectElement>("#scene-select")!;
const fpsLabel = document.querySelector<HTMLElement>("#fps")!;
const guiToggle = document.querySelector<HTMLButtonElement>("#gui-toggle")!;
const infoToggle = document.querySelector<HTMLButtonElement>("#info-toggle")!;
const infoPanel = document.querySelector<HTMLElement>("#info-panel")!;
const fullscreenToggle = document.querySelector<HTMLButtonElement>("#fullscreen-toggle")!;
const dropHint = document.querySelector<HTMLElement>("#drop-hint")!;

const rendererCtx = new RendererContext(canvas);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0b0d12");
scene.fog = new THREE.Fog("#0b0d12", 8, 30);

const ticker = new Ticker();
const fps = new FpsMeter(fpsLabel);

let gui = new GUI({ title: "Controls" });
let active: SceneInstance | null = null;

select.innerHTML = sceneRegistry.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");

let loadToken = 0;

async function loadScene(id: string): Promise<void> {
  const token = ++loadToken;
  const meta = sceneRegistry.find((s) => s.id === id) ?? sceneRegistry[0];
  const def = await meta.load();
  if (token !== loadToken) return; // a newer switch happened while this was loading

  active?.dispose?.();
  active = null;

  gui.destroy();
  gui = new GUI({ title: "Controls" });
  guiOpen ? gui.show() : gui.hide();

  // Reset shared scene graph, keep camera/controls persistent across switches.
  scene.clear();

  dropHint.hidden = def.id !== "model-loader";
  active = await def.setup({
    scene,
    camera: rendererCtx.camera,
    renderer: rendererCtx.renderer,
    controls: rendererCtx.controls,
    gui,
    canvas,
  });
}

let guiOpen = true;
guiToggle.addEventListener("click", () => {
  guiOpen = !guiOpen;
  guiOpen ? gui.show() : gui.hide();
});

let infoOpen = false;
function refreshInfoPanel(): void {
  if (infoOpen) infoPanel.innerHTML = renderDeviceInfo(rendererCtx.renderer);
}
infoToggle.addEventListener("click", () => {
  infoOpen = !infoOpen;
  infoPanel.hidden = !infoOpen;
  refreshInfoPanel();
});
window.addEventListener("resize", refreshInfoPanel);
screen.orientation?.addEventListener("change", refreshInfoPanel);

fullscreenToggle.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {
      /* fullscreen not available (e.g. iOS Safari) — ignore */
    });
  }
});

select.addEventListener("change", () => void loadScene(select.value));

canvas.addEventListener("dragover", (e) => e.preventDefault());
canvas.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && active?.onFileDrop) active.onFileDrop(file);
});

ticker.add((delta, elapsed) => {
  fps.beginFrame();
  active?.update?.(delta, elapsed);
  rendererCtx.controls.update();
  rendererCtx.render(scene);
  fps.endFrame();
});

void loadScene(sceneRegistry[0].id).then(() => ticker.start());
