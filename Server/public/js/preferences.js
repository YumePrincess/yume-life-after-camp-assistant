(() => {
  "use strict";
  const LANGUAGE_COOKIE = "yume-preference-language";
  const LANGUAGE_STORAGE = "lang";
  const THEME_COOKIE = "yume-preference-theme";
  const THEME_STORAGE = "yume-theme";
  const LANGUAGES = ["en", "fr", "ja", "zh-cn", "zh-tw"];
  const THEMES = ["auto", "dark", "light"];
  let observedLanguageCookie = "";
  let observedThemeCookie = "";

  function cookie(name) {
    const prefix = `${name}=`;
    for (const source of document.cookie.split(";")) {
      const value = source.trim();
      if (!value.startsWith(prefix)) continue;
      try {
        return decodeURIComponent(value.slice(prefix.length));
      } catch {
        return value.slice(prefix.length);
      }
    }
    return "";
  }

  function writeCookie(name, value) {
    const host = location.hostname.toLowerCase().replace(/\.$/, "");
    const attributes = [
      `${name}=${encodeURIComponent(value)}`,
      "Path=/",
      "Max-Age=31536000",
      "SameSite=Lax"
    ];
    if (host === "yume.zone" || host.endsWith(".yume.zone")) {
      attributes.push("Domain=yume.zone");
    }
    if (location.protocol === "https:") attributes.push("Secure");
    document.cookie = attributes.join("; ");
  }

  function storage(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The shared yume.zone cookie remains the cross-site source of truth.
    }
  }

  function normalizeLanguage(value) {
    const next = String(value || "").trim().toLowerCase().replaceAll("_", "-");
    if (next === "auto") return "auto";
    if (/^zh-(tw|hk|mo|hant)/.test(next)) return "zh-tw";
    if (next === "zh" || /^zh-(cn|sg|hans)/.test(next)) return "zh-cn";
    const short = next.slice(0, 2);
    return LANGUAGES.includes(short) ? short : "";
  }

  function normalizeTheme(value) {
    const next = String(value || "").trim().toLowerCase();
    return THEMES.includes(next) ? next : "";
  }

  function choice(cookieName, storageName, normalize, fallback) {
    const fromCookie = normalize(cookie(cookieName));
    if (fromCookie) {
      writeStorage(storageName, fromCookie);
      return fromCookie;
    }
    const fromStorage = normalize(storage(storageName));
    if (fromStorage) {
      writeCookie(cookieName, fromStorage);
      return fromStorage;
    }
    return fallback;
  }

  function setChoice(cookieName, storageName, normalize, value, fallback) {
    const next = normalize(value) || fallback;
    writeCookie(cookieName, next);
    writeStorage(storageName, next);
    return next;
  }

  function resolveLanguage(value) {
    const selected = normalizeLanguage(value);
    if (selected && selected !== "auto") return selected;
    for (const language of navigator.languages || [navigator.language]) {
      const normalized = normalizeLanguage(language);
      if (normalized && normalized !== "auto") return normalized;
    }
    return "en";
  }

  function applyTheme(value) {
    const theme = normalizeTheme(value) || "auto";
    if (theme === "auto") {
      if (document.documentElement.hasAttribute("data-theme")) {
        document.documentElement.removeAttribute("data-theme");
      }
    } else if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    return theme;
  }

  const preferences = {
    getLanguageChoice: () =>
      choice(LANGUAGE_COOKIE, LANGUAGE_STORAGE, normalizeLanguage, "auto"),
    setLanguageChoice: (value) =>
      setChoice(LANGUAGE_COOKIE, LANGUAGE_STORAGE, normalizeLanguage, value, "auto"),
    resolveLanguage,
    getThemeChoice: () =>
      choice(THEME_COOKIE, THEME_STORAGE, normalizeTheme, "auto"),
    setThemeChoice: (value) =>
      setChoice(THEME_COOKIE, THEME_STORAGE, normalizeTheme, value, "auto"),
    applyTheme
  };
  window.YumePreferences = Object.freeze(preferences);
  applyTheme(preferences.getThemeChoice());

  function syncFromSharedCookies() {
    const language = normalizeLanguage(cookie(LANGUAGE_COOKIE));
    const theme = normalizeTheme(cookie(THEME_COOKIE));
    if (language && language !== observedLanguageCookie) {
      observedLanguageCookie = language;
      writeStorage(LANGUAGE_STORAGE, language);
      window.dispatchEvent(
        new CustomEvent("yume:preferenceschange", {
          detail: { language, theme: theme || preferences.getThemeChoice() }
        })
      );
    }
    if (theme && theme !== observedThemeCookie) {
      observedThemeCookie = theme;
      writeStorage(THEME_STORAGE, theme);
      applyTheme(theme);
      window.dispatchEvent(
        new CustomEvent("yume:preferenceschange", {
          detail: { language: language || preferences.getLanguageChoice(), theme }
        })
      );
    }
  }

  observedLanguageCookie =
    normalizeLanguage(cookie(LANGUAGE_COOKIE)) || preferences.getLanguageChoice();
  observedThemeCookie =
    normalizeTheme(cookie(THEME_COOKIE)) || preferences.getThemeChoice();
  window.addEventListener("focus", syncFromSharedCookies);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncFromSharedCookies();
  });
  setInterval(syncFromSharedCookies, 2_000);
})();
