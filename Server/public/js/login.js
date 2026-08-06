(() => {
  "use strict";
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get("returnTo") || "/admin";
  const suppressionKey = "yumePublicOidcAutoLoginSuppressed";
  const login = document.querySelector("#oidc-login");
  if (login) {
    login.href = `/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`;
    login.addEventListener("click", () => {
      sessionStorage.removeItem(suppressionKey);
    });
  }
  const messages = {
    invalid_state: "登录状态已失效，请重新登录。",
    oidc_denied: "身份提供方取消了登录。",
    missing_code: "身份提供方没有返回授权码。",
    token_exchange_failed: "登录令牌交换失败，请稍后重试。",
    userinfo_failed: "无法读取账号信息，请稍后重试。",
    unauthorized: "当前账号未被授权进入营地管理后台。",
    oidc_session_expired: "Yume Account 登录状态已退出，请重新登录。"
  };
  const error = params.get("error");
  const target = document.querySelector("#login-error");
  if (target && error) {
    target.textContent = messages[error] || "登录失败，请稍后重试。";
  }

  document.querySelector("#key-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    target.textContent = "正在验证临时 Key…";
    const response = await fetch("/auth/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: document.querySelector("#temporary-key").value,
        returnTo
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      target.textContent = window.MrzhI18n?.t
        ? window.MrzhI18n.t(payload.error || "临时 Key 登录失败。")
        : payload.error || "临时 Key 登录失败。";
      return;
    }
    location.replace(payload.returnTo || "/admin");
  });

  initializeAuth();

  async function initializeAuth() {
    const response = await fetch("/api/auth/config", { cache: "no-store" });
    const config = await response.json();
    document.querySelector("#key-login-section").hidden =
      !config.temporaryKeyLoginEnabled;
    if (
      config.oidcEnabled &&
      config.oidcAutoLogin &&
      !error &&
      params.get("silent") !== "1" &&
      !sessionStorage.getItem(suppressionKey)
    ) {
      document.querySelector("#oidc-silent-frame").src =
        `/auth/oidc/silent?returnTo=${encodeURIComponent(returnTo)}`;
    }
  }
})();
