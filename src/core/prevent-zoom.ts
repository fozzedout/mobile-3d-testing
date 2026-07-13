/**
 * iOS Safari deliberately ignores `user-scalable=no` / `maximum-scale=1` in
 * the viewport meta tag (an accessibility override since iOS 10), so it
 * can't be relied on alone to stop double-tap and pinch zoom from disrupting
 * the touch controls. This blocks both at the event level, app-wide.
 */
export function preventZoomGestures(): void {
  let lastTouchEnd = 0;
  document.addEventListener(
    "touchend",
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );

  // Safari-specific pinch-zoom gesture events (no standard equivalent).
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
}
