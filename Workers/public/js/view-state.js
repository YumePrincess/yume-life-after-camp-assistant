(() => {
  "use strict";
  const signatures = new WeakMap();
  let updating = false;

  function changed(root, data) {
    if (!root) return false;
    const signature = JSON.stringify([
      window.MrzhI18n?.language(), document.documentElement.dataset.timezone, data
    ]);
    if (signatures.get(root) === signature) return false;
    signatures.set(root, signature);
    return true;
  }

  // Capture immediately before a synchronous DOM update, never before its
  // network request: the user may keep scrolling while that request is in flight.
  function preserve(update) {
    if (updating) return update();
    updating = true;
    const elements = [...document.querySelectorAll("*")];
    const keyed = element => element.id || element.dataset.refreshKey;
    const locate = element => element.isConnected ? element :
      element.id ? document.getElementById(element.id) :
      element.dataset.refreshKey ? [...document.querySelectorAll("[data-refresh-key]")]
        .find(candidate => candidate.dataset.refreshKey === element.dataset.refreshKey) : null;
    const scroll = elements.filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    const disclosures = elements.filter(element => element.tagName === "DETAILS" && keyed(element))
      .map(element => ({ element, open: element.open }));
    const active = document.activeElement;
    const selection = active && typeof active.selectionStart === "number"
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const x = window.scrollX, y = window.scrollY;
    try {
      return update();
    } finally {
      for (const { element, open } of disclosures) {
        const replacement = locate(element);
        if (replacement && replacement !== element) replacement.open = open;
      }
      if (active && (!active.isConnected || (document.activeElement === document.body && active !== document.body))) {
        const replacement = locate(active);
        // A background refresh must not steal focus into another dialog or
        // focus a disabled/hidden control whose permission was revoked.
        if (replacement && !replacement.disabled && replacement.getClientRects().length) {
          replacement.focus({ preventScroll: true });
          if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
        }
      }
      for (const { element, top, left } of scroll) {
        const replacement = locate(element);
        if (replacement) {
          replacement.scrollTop = top;
          replacement.scrollLeft = left;
        }
      }
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo({ left: x, top: y, behavior: "instant" });
      updating = false;
    }
  }
  window.MrzhViewState = Object.freeze({ changed, preserve });
})();
