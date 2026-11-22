(() => {
  "use strict";
  if (window.parent === window) return;
  const send = type => window.parent.postMessage({ type }, window.location.origin);
  // Register before the application bundle so recovery/home links also work if startup fails.
  document.addEventListener("click", event => {
    const link = event.target instanceof Element ? event.target.closest("a[data-camp-home], a[data-loading-home]") : null;
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    send("camp-chat:home");
  });
  if (document.body?.hasAttribute("data-chat-session-required")) send("camp-chat:identity-required");
})();
