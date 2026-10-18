(() => {
  "use strict";
  let locked = false, scrollPosition = null;

  function viewport() {
    const visible = window.visualViewport;
    const height = visible?.height || window.innerHeight;
    const top = visible?.offsetTop || 0;
    document.documentElement.style.setProperty("--dialog-visible-height", `${height}px`);
    document.documentElement.style.setProperty("--dialog-visible-top", `${top}px`);
  }

  function lock() {
    if (locked || !document.body) return;
    scrollPosition = { left: window.scrollX, top: window.scrollY };
    document.documentElement.style.setProperty("--dialog-page-top", `${-scrollPosition.top}px`);
    document.documentElement.style.setProperty("--dialog-page-left", `${-scrollPosition.left}px`);
    document.documentElement.classList.add("dialog-viewport-open");
    document.body.classList.add("dialog-viewport-open");
    locked = true;
  }

  function sync() {
    viewport();
    if (document.querySelector("dialog[open]")) {
      lock();
    } else if (locked) {
      document.documentElement.classList.remove("dialog-viewport-open");
      document.body.classList.remove("dialog-viewport-open");
      locked = false;
      window.scrollTo({ ...scrollPosition, behavior: "instant" });
      scrollPosition = null;
    }
  }

  function initialize() {
    // beforetoggle locks before the browser focuses the dialog. The observer
    // also covers older WebViews, dynamically created notices and removal.
    document.addEventListener("beforetoggle", event => {
      if (event.target?.tagName !== "DIALOG") return;
      if (event.newState === "open") lock();
      queueMicrotask(sync);
    }, true);
    new MutationObserver(sync).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["open"]
    });
    window.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("scroll", viewport);
    sync();
  }
  window.MrzhDialogViewport = Object.freeze({ sync });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
