(() => {
  "use strict";

  // Allow normal page/list scrolling, without pinch or double-tap page zoom.
  document.documentElement.style.touchAction = "pan-x pan-y";
  const preventZoom = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  document.addEventListener("gesturestart", preventZoom, { passive: false });
  document.addEventListener("gesturechange", preventZoom, { passive: false });
  document.addEventListener("touchmove", (event) => {
    if (event.touches.length > 1) preventZoom(event);
  }, { passive: false });

  // Older WKWebViews do not implement overscroll-behavior. Consume a drag only
  // when no inner scroller can move in that direction; leave long lists intact.
  if (window.CSS?.supports("overscroll-behavior", "none")) return;
  let previousTouch = null;
  document.addEventListener("touchstart", (event) => {
    previousTouch = event.touches.length === 1
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : null;
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!document.body?.hasAttribute("data-fixed-viewport")) return;
    if (event.touches.length !== 1 || !previousTouch) return;
    const touch = event.touches[0];
    const dx = touch.clientX - previousTouch.x;
    const dy = touch.clientY - previousTouch.y;
    previousTouch = { x: touch.clientX, y: touch.clientY };
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const delta = horizontal ? dx : dy;
    if (!delta) return;
    for (let element = event.target; element instanceof Element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.touchAction === "none") return;
      const overflow = horizontal ? style.overflowX : style.overflowY;
      if (!/^(auto|scroll)$/.test(overflow)) continue;
      const position = horizontal ? element.scrollLeft : element.scrollTop;
      const limit = horizontal
        ? element.scrollWidth - element.clientWidth
        : element.scrollHeight - element.clientHeight;
      if (limit > 1 && (delta > 0 ? position > 0 : position < limit - 1)) return;
    }
    preventZoom(event);
  }, { passive: false });
})();
