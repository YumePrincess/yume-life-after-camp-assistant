(() => {
  "use strict";

  function create({ validateSession, onIdentityRequired, onError, beforeOpen, translate }) {
    const workspace = document.getElementById("chat-workspace");
    const home = [document.getElementById("main-content"), document.querySelector(".site-footer")].filter(Boolean);
    const card = document.getElementById("open-chat");
    let frame = null, frameIdentity = "", active = false, revision = 0;
    let scrollPosition = 0, previousTitle = "", previousInert = [];

    function send(visible) {
      frame?.contentWindow?.postMessage({ type: "camp-chat:visibility", visible }, window.location.origin);
    }
    function syncViewport() {
      const viewport = window.visualViewport;
      workspace.style.setProperty("--chat-host-height", `${Math.round(viewport?.height || window.innerHeight)}px`);
      workspace.style.setProperty("--chat-host-top", `${Math.round(viewport?.offsetTop || 0)}px`);
    }
    function labels() {
      const title = translate("互动中心");
      workspace.setAttribute("aria-label", title);
      if (frame) frame.title = title;
      if (active) document.title = title;
    }
    function hide() {
      if (!active) return;
      send(false);
      active = false;
      workspace.hidden = true;
      document.body.classList.remove("chat-workspace-open");
      document.body.removeAttribute("data-fixed-viewport");
      home.forEach((element, index) => { element.inert = previousInert[index]; });
      card.setAttribute("aria-expanded", "false");
      document.title = previousTitle;
      window.scrollTo(0, scrollPosition);
      card.focus({ preventScroll: true });
    }
    function discard() {
      frame?.remove();
      frame = null;
      frameIdentity = "";
    }
    function identityRequired() {
      revision += 1;
      hide();
      discard();
      if (window.location.hash === "#chat") {
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        onIdentityRequired();
      }
    }
    async function sync() {
      const current = ++revision;
      if (window.location.hash !== "#chat") { hide(); return; }
      try {
        // Revalidate on every entry, including browser Forward and direct #chat visits.
        const account = await validateSession();
        if (current !== revision || window.location.hash !== "#chat") return;
        if (!account) { identityRequired(); return; }
        if (frame && frameIdentity !== account.identityCode) discard();
        beforeOpen();
        if (!active) {
          const savedScroll = history.state?.campChatScroll;
          scrollPosition = Number.isFinite(savedScroll) && savedScroll >= 0 ? savedScroll : window.scrollY;
          history.replaceState({ ...history.state, campChatScroll: scrollPosition }, "", window.location.href);
          previousTitle = document.title;
          previousInert = home.map(element => document.documentElement.classList.contains("is-page-loading") ? false : element.inert);
          home.forEach(element => { element.inert = true; });
        }
        if (!frame) {
          frame = document.createElement("iframe");
          frame.id = "chat-frame";
          frame.src = "/chat/?embedded=1";
          frame.allow = "microphone 'self'";
          frame.referrerPolicy = "same-origin";
          frameIdentity = account.identityCode;
          frame.addEventListener("load", () => { send(active); });
          workspace.append(frame);
        }
        active = true;
        workspace.hidden = false;
        document.body.classList.add("chat-workspace-open");
        document.body.setAttribute("data-fixed-viewport", "");
        card.setAttribute("aria-expanded", "true");
        syncViewport();
        labels();
        send(true);
        frame.focus({ preventScroll: true });
      } catch (error) {
        if (current !== revision) return;
        hide();
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        onError(error);
      }
    }
    function open() {
      if (window.location.hash === "#chat") void sync();
      else window.location.hash = "chat";
    }
    function receive(event) {
      if (!frame || event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      if (event.data?.type === "camp-chat:home" && active) {
        history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
        void sync();
      } else if (event.data?.type === "camp-chat:identity-required") {
        identityRequired();
      } else if (event.data?.type === "camp-chat:ready") send(active);
    }
    function identityChanged(event) {
      if (frame && frameIdentity !== (event.detail?.identityCode || "")) {
        discard();
        if (active) void sync();
      }
    }
    window.addEventListener("hashchange", sync);
    window.addEventListener("message", receive);
    window.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    document.addEventListener("mrzh:identitychange", identityChanged);
    document.addEventListener("mrzh:languagechange", () => {
      if (active) previousTitle = document.title;
      labels();
    });
    window.addEventListener("storage", event => {
      if (event.key === "mrzh.identity-session") {
        let identityCode = "";
        try { identityCode = JSON.parse(event.newValue || "null")?.identityCode || ""; } catch { /* Removed or unreadable account cache. */ }
        if (frame && identityCode === frameIdentity) return;
        discard();
        if (active) void sync();
      }
    });
    void sync();
    return Object.freeze({ open, sync });
  }
  window.MrzhChatNavigation = Object.freeze({ create });
})();
