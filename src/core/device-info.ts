import * as THREE from "three";

function row(label: string, value: string): string {
  return `<div class="info-row"><span>${label}</span><strong>${value}</strong></div>`;
}

/** Reads WebGL vendor/renderer strings when the browser exposes them (often blocked for privacy). */
function readGpuInfo(gl: WebGLRenderingContext | WebGL2RenderingContext): { vendor: string; renderer: string } {
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (!ext) return { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) };
  return {
    vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
    renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
  };
}

export function renderDeviceInfo(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const gpu = readGpuInfo(gl);
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; saveData?: boolean };
  };

  return [
    row("Viewport", `${window.innerWidth}×${window.innerHeight}`),
    row("Screen", `${screen.width}×${screen.height}`),
    row("Device pixel ratio", window.devicePixelRatio.toFixed(2)),
    row("Touch points", String(navigator.maxTouchPoints)),
    row("Orientation", screen.orientation?.type ?? "unknown"),
    row("WebGL", gl instanceof WebGL2RenderingContext ? "WebGL 2" : "WebGL 1"),
    row("GPU vendor", String(gpu.vendor)),
    row("GPU renderer", String(gpu.renderer)),
    row("Device memory", nav.deviceMemory ? `${nav.deviceMemory} GB` : "n/a"),
    row("Network", nav.connection?.effectiveType ?? "n/a"),
    row("Save-Data", nav.connection?.saveData ? "on" : "off"),
    row("User agent", navigator.userAgent),
  ].join("");
}
