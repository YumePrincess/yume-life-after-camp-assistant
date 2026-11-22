(() => {
  "use strict";
  const LANGUAGE_STORAGE = "lang";
  const THEME_STORAGE = "yume-theme";
  const LANGUAGES = ["en", "fr", "ja", "zh-cn", "zh-tw"];
  const THEMES = ["auto", "dark", "light"];

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
      // Preferences remain available for this page even when storage is blocked.
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

  function choice(storageName, normalize, fallback) {
    return normalize(storage(storageName)) || fallback;
  }

  function setChoice(storageName, normalize, value, fallback) {
    const next = normalize(value) || fallback;
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
    getLanguageChoice: () => choice(LANGUAGE_STORAGE, normalizeLanguage, "auto"),
    setLanguageChoice: (value) => setChoice(LANGUAGE_STORAGE, normalizeLanguage, value, "auto"),
    resolveLanguage,
    getThemeChoice: () => choice(THEME_STORAGE, normalizeTheme, "auto"),
    setThemeChoice: (value) => setChoice(THEME_STORAGE, normalizeTheme, value, "auto"),
    applyTheme
  };
  window.YumePreferences = Object.freeze(preferences);
  applyTheme(preferences.getThemeChoice());
})();
