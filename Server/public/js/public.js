(() => {
  "use strict";

  const state = {
    data: null,
    selections: new Set(),
    identityMode: "new",
    renewalCode: "",
    renewalApplicationNumber: "",
    identitySession: null,
    identityResetChallengeId: "",
    identityResetToken: "",
    identityCancellationChallengeId: "",
    identityEmailChangeId: "",
    identityProfileMode: "",
    identityProfileStep: "",
    identitySessionRefreshedAt: 0,
    identitySessionRefreshInFlight: false,
    identitySessionRefreshQueued: false,
    voteErrorRenewalCode: "",
    campGroup: null,
    campGroupStatus: "idle",
    campGroupRequestedUrl: "",
    activeFeature: "",
    dailyPanel: "",
    dailyIdentityCodes: {},
    dailySelections: {},
    voteParticipation: {
      revision: 0,
      identityCode: "",
      scopeKey: "",
      technologyPollDate: "",
      technologyParticipated: false,
      dailyOpenItemIds: [],
      dailyParticipatedItemIds: []
    },
    identityCodeEdited: false,
    liveSocket: null,
    liveReconnectTimer: null,
    liveReconnectAttempt: 0,
    liveRefreshInFlight: false,
    liveRefreshQueued: false,
    liveDirty: false
  };
  const FEATURE_IDS = ["overview", "group", "identity", "vote", "staff", "members", "warnings", "runs"];
  const FEATURE_DETAIL_KICKERS = {
    overview: "Notice", group: "Group", identity: "Identity Code", vote: "Vote", staff: "Staff",
    members: "Members", warnings: "Alert", runs: "Tasks"
  };
  const IDENTITY_SESSION_STORAGE_KEY = "mrzh.identity-session";
  const IDENTITY_SESSION_REFRESH_INTERVAL_MS = 30_000;
  const IDENTITY_SESSION_INVALID_CODES = new Set([
    "identity_code_invalid",
    "identity_code_disabled",
    "identity_code_expired",
    "identity_password_invalid",
    "identity_password_required",
    "identity_login_failed"
  ]);
  let operationProgressSequence = 0;
  let renderedTechnologyVote = "";
  let renderedDailyVote = "";
  const activeOperationProgress = new Map();

  function isIdentitySessionInvalidError(error) {
    return IDENTITY_SESSION_INVALID_CODES.has(error?.code) ||
      [401, 403, 409].includes(Number(error?.status));
  }
  const ACTIVE_IDENTITY_CONFLICT =
    "您提供的信息可能已经成功申请身份识别码。如果您忘记了身份识别码，请通过“忘记识别码”功能找回。如果这不是您提交的申请，请联系市长处理。";
  const EXPIRED_IDENTITY_CONFLICT =
    "您提供的信息关联的身份识别码已过期，请通过“申请延长识别码有效期”功能申请延期。延期申请被拒绝后，该识别码将标记为失效，届时可以重新申请身份识别码。";

  function byId(id) {
    return document.getElementById(id);
  }

  function syncFeatureDetailKicker() {
    setText("feature-detail-kicker", FEATURE_DETAIL_KICKERS[state.activeFeature] || "");
    const source = state.activeFeature === "vote" && state.dailyPanel
      ? document.querySelector(`[data-daily-panel="${state.dailyPanel}"] .daily-vote-panel-copy strong`)
      : document.querySelector(`.feature-card[data-feature-target="${state.activeFeature}"] .feature-card-copy strong`);
    setText("feature-detail-title", source?.textContent || "");
  }

  function dailyVoteFeatureCount(payload) {
    return (Array.isArray(payload?.items) ? payload.items.length : 0) + 1;
  }

  function loadIdentitySession() {
    try {
      const value = JSON.parse(window.localStorage.getItem(IDENTITY_SESSION_STORAGE_KEY) || "null");
      return value && /^\d{8}$/.test(value.identityCode) && (value.password || value.cookieSession)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  function persistIdentitySession(session) {
    if (session?.cookieSession) { session = {...session}; delete session.password; }
    state.identitySession = session;
    if (!session) state.identitySessionRefreshedAt = 0;
    try {
      if (session) {
        window.localStorage.setItem(IDENTITY_SESSION_STORAGE_KEY, JSON.stringify(session));
      } else {
        window.localStorage.removeItem(IDENTITY_SESSION_STORAGE_KEY);
      }
    } catch {
      // Private browsing or an embedded webview may deny localStorage access.
    }
    renderIdentityAccount();
    document.dispatchEvent(new CustomEvent("mrzh:identitychange", { detail: { identityCode: session?.identityCode || "" } }));
  }

  function identitySession() {
    return state.identitySession;
  }

  function clearIdentitySession({ openPanel = false } = {}) {
    persistIdentitySession(null);
    state.voteParticipation = {
      revision: (state.voteParticipation.revision || 0) + 1,
      identityCode: "",
      scopeKey: "",
      technologyPollDate: "",
      technologyParticipated: false,
      dailyOpenItemIds: [],
      dailyParticipatedItemIds: []
    };
    if (state.data) {
      renderVote(state.data.voteSummary || {});
      renderDailyVote(state.data.dailyVote || {});
    }
    if (openPanel) openIdentityPanel();
  }

  function requireIdentitySession() {
    if (identitySession()) return true;
    showFeature("identity");
    showOperationNotice(
      window.MrzhI18n.t("请先在身份识别码卡片登录，登录后即可投票。"),
      { kicker: "IDENTITY CODE" }
    );
    return false;
  }

  function renderIdentityAccount() {
    const session = identitySession();
    const loggedOut = byId("identity-account-logged-out");
    const loggedIn = byId("identity-account-logged-in");
    if (loggedOut) loggedOut.hidden = Boolean(session);
    if (loggedIn) loggedIn.hidden = !session;
    setText("identity-account-state", session ? window.MrzhI18n.t("已登录") : window.MrzhI18n.t("未登录"));
    byId("identity-account-status").dataset.signedIn = String(Boolean(session));
    setText("identity-status-mark", session ? "✓" : "×");
    setText("identity-card-status-text", window.MrzhI18n.t(session ? "已登录" : "未登录"));
    byId("daily-identity-panel-state").dataset.signedIn = String(Boolean(session));
    renderIdentityEligibility(session);
    const avatar = byId("identity-avatar");
    if (avatar) {
      avatar.hidden = !session?.avatarUrl;
      if (session?.avatarUrl && avatar.getAttribute("src") !== session.avatarUrl) {
        avatar.src = session.avatarUrl;
      }
      const fallback = byId("identity-avatar-fallback");
      fallback.textContent = [...(session?.playerName || "?")][0];
      fallback.hidden = Boolean(session?.avatarUrl);
      avatar.onerror = () => { avatar.hidden=true; fallback.hidden=false; };
    }
    if (session) {
      setText("identity-account-name", session.playerName || window.MrzhI18n.t("未填写玩家名称"));
      setText("identity-account-code", session.identityCode || "—");
      setText("identity-account-email", session.email || window.MrzhI18n.t("未绑定邮箱"));
      setText(
        "identity-account-expiry",
        session.expiresAt ? formatIdentityExpiry(
          session.expiresAt,
          configuredTimezone(),
          session.expiresAtDisplay
        ) : window.MrzhI18n.t("永久有效")
      );
      const codeInput = byId("identity-reset-code");
      if (codeInput && !codeInput.value) codeInput.value = session.identityCode;
      const loginCode = byId("identity-login-code");
      if (loginCode) loginCode.value = session.identityCode;
    }
  }

  function formatEligibilityNumber(value) {
    return new Intl.NumberFormat(window.MrzhI18n.language() || undefined).format(
      Number.isFinite(Number(value)) ? Number(value) : 0
    );
  }

  function renderIdentityEligibility(session = identitySession()) {
    const status = byId("identity-account-eligibility");
    const line = byId("identity-eligibility-line");
    const overrideLine = byId("identity-eligibility-override");
    const applyButton = byId("identity-eligibility-apply");
    const result = session?.voteEligibility;
    if (!status) return;
    if (!session || !result) {
      status.textContent = "—";
      status.removeAttribute("data-eligible");
      if (line) line.hidden = true;
      if (overrideLine) overrideLine.hidden = true;
      if (applyButton) applyButton.hidden = true;
      return;
    }
    // Keep the explicit administrator ban visible even when eligibility
    // checks have otherwise been switched off.
    if (line) {
      line.hidden = result.enabled === false &&
        result.prohibited !== true &&
        result.bypassed !== true;
    }
    if (overrideLine) overrideLine.hidden = true;
    if (applyButton) applyButton.hidden = true;
    if (
      result.enabled === false &&
      result.prohibited !== true &&
      result.bypassed !== true
    ) {
      status.textContent = "—";
      status.removeAttribute("data-eligible");
      return;
    }
    const eligible = result.prohibited !== true && (result.enabled === false || result.eligible === true);
    status.textContent = window.MrzhI18n.t(
      result.prohibited
        ? "该身份识别码已被管理员禁止投票。"
        : eligible
          ? "已达标，准许投票"
          : "尚未达标，无法投票"
    );
    status.dataset.eligible = String(eligible);
    const override = result.override;
    if (!result.bypassed && !result.prohibited && override && overrideLine) {
      const value = override.votesRemaining !== null && override.votesRemaining !== undefined
        ? window.MrzhI18n.format("剩余 {count} 次", { count: formatEligibilityNumber(override.votesRemaining) })
        : override.expiresAt
          ? window.MrzhI18n.format("有效至 {date}", {
              date: formatIdentityExpiry(
                override.expiresAt,
                configuredTimezone(),
                override.expiresAtDisplay
              )
            })
          : "";
      if (value) {
        setText("identity-account-eligibility-override", value);
        overrideLine.hidden = false;
      }
    }
    if (!result.prohibited && !eligible && !override && applyButton) applyButton.hidden = false;
    const thresholds = result.thresholds || {};
    const current = result.current || {};
    for (const [thresholdId, currentId, key] of [
      ["identity-eligibility-threshold-contribution", "identity-eligibility-current-contribution", "weeklyContribution"],
      ["identity-eligibility-threshold-technology", "identity-eligibility-current-technology", "technologyPoints"],
      ["identity-eligibility-threshold-materials", "identity-eligibility-current-materials", "materialContribution"],
      ["identity-eligibility-threshold-activity", "identity-eligibility-current-activity", "weeklyActivityPoints"]
    ]) {
      setText(thresholdId, formatEligibilityNumber(thresholds[key]));
      setText(currentId, formatEligibilityNumber(current[key]));
    }
    const dialogStatus = byId("identity-eligibility-dialog-status");
    if (dialogStatus) {
      dialogStatus.textContent = result.prohibited
        ? window.MrzhI18n.t("该身份识别码已被管理员禁止投票。")
        : result.enabled === false && result.bypassed !== true
          ? window.MrzhI18n.t("管理员已关闭投票资格校验，当前身份识别码可投票。")
          : window.MrzhI18n.t(
            eligible ? "已达标，准许投票" : "尚未达标，无法投票"
          );
      dialogStatus.dataset.eligible = String(eligible);
    }
  }

  function openIdentityEligibilityDialog() {
    renderIdentityEligibility();
    const dialog = byId("identity-eligibility-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function openIdentityPanel() {
    showFeature("identity");
    renderIdentityAccount();
    void refreshIdentitySession();
  }

  async function refreshIdentitySession({ force = false } = {}) {
    const session = identitySession();
    if (!session?.identityCode) {
      try { const account=await request("/api/public/identity-session");persistIdentitySession(account);state.identitySessionRefreshedAt=Date.now();await refreshVoteParticipation({force:true}); } catch { /* A signed-out visitor needs no error prompt. */ }
      return;
    }
    if (!force && Date.now() - state.identitySessionRefreshedAt < IDENTITY_SESSION_REFRESH_INTERVAL_MS) return;
    if (state.identitySessionRefreshInFlight) {
      if (force) state.identitySessionRefreshQueued = true;
      return;
    }
    state.identitySessionRefreshInFlight = true;
    try {
      const account = await request("/api/public/identity-login", {
        method: "POST",
        body: JSON.stringify({
          identityCode: session.identityCode,
          identityPassword: session.password
        })
      });
      if (
        identitySession()?.identityCode !== session.identityCode ||
        identitySession()?.password !== session.password
      ) return;
      persistIdentitySession({ ...session, ...account, password: session.password });
      state.identitySessionRefreshedAt = Date.now();
      await refreshVoteParticipation();
    } catch (error) {
      if (isIdentitySessionInvalidError(error)) {
        clearIdentitySession({ openPanel: state.dailyPanel === "identity" });
      }
      // Keep the cached session on transient failures and retry on the next live update or resume.
    } finally {
      state.identitySessionRefreshInFlight = false;
      if (state.identitySessionRefreshQueued) {
        state.identitySessionRefreshQueued = false;
        void refreshIdentitySession({ force: true });
      }
    }
  }

  async function loginIdentity(event) {
    event.preventDefault();
    const identityCode = byId("identity-login-code").value.trim();
    const password = byId("identity-login-password").value;
    if (!/^\d{8}$/.test(identityCode) || !password) {
      showOperationNotice(
        window.MrzhI18n.t("请输入有效的身份识别码和密码。"),
        { kicker: "IDENTITY CODE" }
      );
      return;
    }
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      const account = await request("/api/public/identity-login", {
        method: "POST",
        body: JSON.stringify({ identityCode, identityPassword: password })
      });
      state.voteParticipation.revision = (state.voteParticipation.revision || 0) + 1;
      persistIdentitySession({ ...account, password });
      state.identitySessionRefreshedAt = Date.now();
      void refreshVoteParticipation({ force: true });
      byId("identity-login-password").value = "";
      showOperationNotice(window.MrzhI18n.t("登录成功。"), { kicker: "IDENTITY CODE" });
    } catch (error) {
      if (error.code === "identity_password_required") {
        beginIdentityPasswordReset();
      }
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "IDENTITY CODE" });
    } finally {
      if (submit) submit.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  function beginIdentityPasswordReset() {
    const dialog = byId("identity-password-reset-dialog");
    if (dialog && !dialog.open) dialog.showModal();
    state.identityResetChallengeId = "";
    state.identityResetToken = "";
    setPasswordResetStep("request");
    const session = identitySession();
    if (session) {
      byId("identity-reset-code").value = session.identityCode;
      byId("identity-reset-email").value = session.email || "";
    }
  }

  function setPasswordResetStep(step) {
    for (const element of document.querySelectorAll("[data-reset-step]")) {
      element.hidden = element.dataset.resetStep !== step;
    }
  }

  async function requestPasswordReset(event) {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      const result = await request("/api/public/identity-password-reset", {
        method: "POST",
        body: JSON.stringify({
          action: "request",
          applicationNumber: byId("identity-reset-application").value.trim(),
          email: byId("identity-reset-email").value.trim(),
          identityCode: byId("identity-reset-code").value.trim()
        })
      });
      state.identityResetChallengeId = result.challengeId;
      setPasswordResetStep("verify");
      showOperationNotice(window.MrzhI18n.t("验证码已发送到预留邮箱。"), { kicker: "IDENTITY CODE" });
    } catch (error) {
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "IDENTITY CODE" });
    } finally {
      if (submit) submit.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  async function verifyPasswordReset(event) {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      const result = await request("/api/public/identity-password-reset", {
        method: "POST",
        body: JSON.stringify({
          action: "verify",
          challengeId: state.identityResetChallengeId,
          otp: byId("identity-reset-otp").value.trim()
        })
      });
      state.identityResetToken = result.resetToken;
      setPasswordResetStep("set");
      showOperationNotice(window.MrzhI18n.t("验证通过，请设置新密码。"), { kicker: "IDENTITY CODE" });
    } catch (error) {
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "IDENTITY CODE" });
    } finally {
      if (submit) submit.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  async function setPasswordReset(event) {
    event.preventDefault();
    const password = byId("identity-new-password").value;
    if (password.length < 6 || password.length > 32) {
      showOperationNotice(window.MrzhI18n.t("密码必须为6至32位"), { kicker: "IDENTITY CODE" });
      return;
    }
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      await request("/api/public/identity-password-reset", {
        method: "POST",
        body: JSON.stringify({
          action: "set",
          challengeId: state.identityResetChallengeId,
          resetToken: state.identityResetToken,
          password
        })
      });
      state.identityResetChallengeId = "";
      state.identityResetToken = "";
      byId("identity-new-password").value = "";
      setPasswordResetStep("request");
      showOperationNotice(window.MrzhI18n.t("密码设置成功，请返回登录。"), { kicker: "IDENTITY CODE" });
    } catch (error) {
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "IDENTITY CODE" });
    } finally {
      if (submit) submit.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  function setIdentityCancellationStep(step) {
    for (const element of document.querySelectorAll("[data-cancellation-step]")) {
      element.hidden = element.dataset.cancellationStep !== step;
    }
  }

  function openIdentityCancellationDialog() {
    const session = identitySession();
    state.identityCancellationChallengeId = "";
    byId("identity-cancel-application").value = "";
    byId("identity-cancel-email").value = session?.email || "";
    byId("identity-cancel-code").value = session?.identityCode || "";
    byId("identity-cancel-otp").value = "";
    setIdentityCancellationStep("request");
    const dialog = byId("identity-cancellation-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function submitIdentityCancellation(event) {
    event.preventDefault();
    const step = document.querySelector("[data-cancellation-step]:not([hidden])")?.dataset.cancellationStep;
    const submit = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      if (step === "request") {
        const result = await request("/api/public/identity-cancellation", {
          method: "POST",
          body: JSON.stringify({
            action: "request",
            applicationNumber: byId("identity-cancel-application").value.trim(),
            email: byId("identity-cancel-email").value.trim(),
            identityCode: byId("identity-cancel-code").value.trim()
          })
        });
        state.identityCancellationChallengeId = result.challengeId;
        setIdentityCancellationStep("verify");
        showOperationNotice(window.MrzhI18n.t("验证码已发送到预留邮箱。"), { kicker: "IDENTITY CODE" });
        return;
      }
      await request("/api/public/identity-cancellation", {
        method: "POST",
        body: JSON.stringify({
          action: "confirm",
          challengeId: state.identityCancellationChallengeId,
          otp: byId("identity-cancel-otp").value.trim()
        })
      });
      byId("identity-cancellation-dialog").close();
      clearIdentitySession();
      showOperationNotice(window.MrzhI18n.t("身份识别码已注销，已立即失效。"), { kicker: "IDENTITY CODE" });
    } catch (error) {
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "IDENTITY CODE" });
    } finally {
      if (submit) submit.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  function setIdentityProfileStep(step) {
    state.identityProfileStep = step;
    for (const element of document.querySelectorAll("[data-identity-profile-step]")) {
      element.hidden = element.dataset.identityProfileStep !== step;
    }
    const submit = byId("identity-profile-submit");
    if (!submit) return;
    const label =
      step === "email"
        ? "发送验证码"
        : step === "old-email" || step === "new-email"
          ? "验证验证码"
          : "确认变更";
    submit.textContent = window.MrzhI18n.t(label);
  }

  function openIdentityProfileDialog(mode) {
    const session = identitySession();
    if (!session) return openIdentityPanel();
    state.identityProfileMode = mode;
    state.identityEmailChangeId = "";
    setText(
      "identity-profile-dialog-title",
      window.MrzhI18n.t(mode === "name" ? "修改玩家名称" : "绑定/修改邮箱")
    );
    byId("identity-profile-name").value = session.playerName || "";
    byId("identity-profile-email").value = session.email || "";
    byId("identity-profile-old-otp").value = "";
    byId("identity-profile-new-otp").value = "";
    setIdentityProfileStep(mode === "name" ? "name" : "email");
    const dialog = byId("identity-profile-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function submitIdentityProfile(event) {
    event.preventDefault();
    const session = identitySession();
    if (!session) return openIdentityPanel();
    const submit = byId("identity-profile-submit");
    const mode = state.identityProfileMode;
    const step = state.identityProfileStep;
    let body;
    let endpoint = "/api/public/identity-profile";
    if (mode === "name") {
      const playerName = byId("identity-profile-name").value.trim();
      if (!playerName) {
        showOperationNotice(window.MrzhI18n.t("请输入新的玩家名称"), { kicker: "IDENTITY CODE" });
        return;
      }
      body = {
        action: "update-name",
        identityCode: session.identityCode,
        identityPassword: session.password,
        playerName
      };
    } else if (step === "email") {
      const newEmail = byId("identity-profile-email").value.trim();
      if (!newEmail) {
        showOperationNotice(window.MrzhI18n.t("请输入新的邮箱地址"), { kicker: "IDENTITY CODE" });
        return;
      }
      body = {
        action: "request-email-change",
        identityCode: session.identityCode,
        identityPassword: session.password,
        newEmail
      };
    } else if (step === "old-email") {
      const oldOtp = byId("identity-profile-old-otp").value.trim();
      if (!oldOtp) {
        showOperationNotice(window.MrzhI18n.t("请输入旧邮箱收到的验证码"), { kicker: "IDENTITY CODE" });
        return;
      }
      body = {
        action: "verify-old-email-change",
        changeId: state.identityEmailChangeId,
        oldOtp
      };
    } else if (step === "new-email") {
      const newOtp = byId("identity-profile-new-otp").value.trim();
      if (!newOtp) {
        showOperationNotice(window.MrzhI18n.t("请输入新邮箱收到的验证码"), { kicker: "IDENTITY CODE" });
        return;
      }
      body = {
        action: "confirm-email-change",
        changeId: state.identityEmailChangeId,
        newOtp
      };
    } else {
      return;
    }
    submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      const result = await request(endpoint, {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (mode === "name") {
        byId("identity-profile-dialog").close();
        showVoteSuccessDialog({
          kind: "identity",
          data: { publicTestVote: true },
          title: "申请已提交",
          kicker: "身份识别码",
          message: window.MrzhI18n.t("玩家名称变更已提交，审核通过后生效。")
        });
        void refreshIdentitySession({ force: true });
      } else if (step === "email") {
        state.identityEmailChangeId = result.changeId;
        setIdentityProfileStep("old-email");
        showOperationNotice(window.MrzhI18n.t("验证码已发送到邮箱，请填写后再次提交。"), { kicker: "IDENTITY CODE" });
      } else if (step === "old-email") {
        setIdentityProfileStep("new-email");
        showOperationNotice(window.MrzhI18n.t("验证码已发送到邮箱，请填写后再次提交。"), { kicker: "IDENTITY CODE" });
      } else {
        byId("identity-profile-dialog").close();
        showVoteSuccessDialog({
          kind: "identity",
          data: { publicTestVote: true },
          title: "申请已提交",
          kicker: "身份识别码",
          message: window.MrzhI18n.t("邮箱变更已提交，审核通过后生效。")
        });
        void refreshIdentitySession({ force: true });
      }
    } catch (error) {
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "IDENTITY CODE" });
    } finally {
      submit.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  function resetFeatureSelection({ clearHash = true, restoreFocus = false } = {}) {
    const activeId = state.activeFeature;
    const activeCard = activeId
      ? document.querySelector(`.feature-card[data-feature-target="${activeId}"]`)
      : null;
    const returnFocus = state.featureReturnFocus || activeCard;
    state.featureReturnFocus = null;
    for (const panelId of FEATURE_IDS) {
      const item = byId(panelId);
      if (item) item.hidden = true;
    }
    for (const card of document.querySelectorAll(".feature-card[data-feature-target]")) {
      card.classList.remove("is-active");
      card.setAttribute("aria-expanded", "false");
    }
    state.activeFeature = "";
    state.dailyPanel = "";
    syncFeatureDetailKicker();
    if (clearHash) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (restoreFocus && returnFocus && !returnFocus.hidden) returnFocus.focus({ preventScroll: true });
  }

  function resetFeatureScroll() {
    const body = document.querySelector(".feature-detail-body");
    if (body) body.scrollTop = 0;
  }

  function showFeature(id, { updateHash = true, returnFocus = document.activeElement } = {}) {
    if (!FEATURE_IDS.includes(id)) return false;
    const panel = byId(id);
    const selectedCard = document.querySelector(
      `.feature-card[data-feature-target="${id}"]`
    );
    const dialog = byId("feature-detail-dialog");
    if (!panel || !selectedCard || selectedCard.hidden || !dialog) return false;
    window.clearTimeout(featureCloseTimer);
    dialog.classList.remove("is-closing");
    if (id !== "vote") state.dailyPanel = "";
    for (const panelId of FEATURE_IDS) {
      const item = byId(panelId);
      if (item) item.hidden = panelId !== id;
    }
    for (const card of document.querySelectorAll(".feature-card[data-feature-target]")) {
      const active = card.dataset.featureTarget === id;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-expanded", String(active));
    }
    state.activeFeature = id;
    syncFeatureDetailKicker();
    if (updateHash) {
      history.replaceState(null, "", `#${id}`);
    }
    resetFeatureScroll();
    if (!dialog.open) {
      state.featureReturnFocus = returnFocus;
      dialog.showModal();
    }
    if (id === "identity") void refreshIdentitySession();
    if (id === "group" && state.campGroupStatus === "idle") void loadCampGroup();
    return true;
  }

  function renderCampGroup() {
    const root = byId("camp-group-content");
    if (!root) return;
    root.replaceChildren();
    byId("retry-camp-group").hidden = state.campGroupStatus !== "error";
    if (state.campGroupStatus !== "ready" || !state.campGroup) {
      const message = state.campGroupStatus === "error"
        ? "营地群资料加载失败，请稍后重试。"
        : state.campGroupStatus === "ready"
          ? "暂无营地群资料。"
          : "正在加载营地群资料…";
      root.append(create("p", "empty-state", window.MrzhI18n.t(message)));
      return;
    }
    for (const block of state.campGroup.blocks || []) {
      if (block.type === "text") {
        root.append(create("span", "group-text", block.text));
      } else if (block.type === "br") {
        const separator = create("span", "group-break");
        separator.setAttribute("aria-hidden", "true");
        root.append(separator);
      } else if (block.type === "link" && safeGroupUrl(block.url)) {
        const link = create("a", "group-link", block.text);
        link.href = block.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        root.append(link);
      } else if (block.type === "image" && safeGroupUrl(block.src)) {
        const button = create("button", "group-image-button");
        button.type = "button";
        const image = document.createElement("img");
        image.className = "group-image";
        image.src = block.src;
        image.alt = block.alt || window.MrzhI18n.t("营地群二维码");
        image.loading = "lazy";
        button.setAttribute("aria-label", window.MrzhI18n.t("查看营地群图片"));
        button.append(image);
        button.addEventListener("click", () => openImagePreview(image.src, image.alt));
        root.append(button);
      }
    }
  }

  function safeGroupUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  async function loadCampGroup() {
    const sourceUrl = window.MrzhCampGroup.sourceUrl(state.data?.campConfig?.campGroupDataUrl);
    if (state.campGroupStatus === "loading" && state.campGroupRequestedUrl === sourceUrl) return;
    state.campGroupRequestedUrl = sourceUrl;
    state.campGroupStatus = "loading";
    renderCampGroup();
    try {
      const entry = await window.MrzhCampGroup.load(sourceUrl);
      if (state.campGroupRequestedUrl !== sourceUrl) return;
      state.campGroup = entry;
      state.campGroupStatus = "ready";
    } catch {
      if (state.campGroupRequestedUrl !== sourceUrl) return;
      state.campGroupStatus = "error";
    }
    renderCampGroup();
  }

  function handleFeatureNavigation(event) {
    const control = event.currentTarget;
    const id = control.dataset.featureTarget;
    if (!id) return;
    event.preventDefault();
    showFeature(id, { returnFocus: control });
  }

  let featureCloseTimer = null;

  function closeFeatureDialog() {
    const dialog = byId("feature-detail-dialog");
    if (!dialog.open || dialog.classList.contains("is-closing")) return;
    if (!window.matchMedia("(max-width: 700px)").matches ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dialog.close();
      return;
    }
    dialog.classList.add("is-closing");
    featureCloseTimer = window.setTimeout(() => {
      dialog.close();
      dialog.classList.remove("is-closing");
      featureCloseTimer = null;
    }, 220);
  }

  function initFeatureNavigation() {
    for (const control of document.querySelectorAll("[data-feature-target]")) {
      control.addEventListener("click", handleFeatureNavigation);
    }
    window.addEventListener("hashchange", () => {
      const id = window.location.hash.slice(1);
      if (FEATURE_IDS.includes(id)) showFeature(id, { updateHash: false });
    });
    byId("close-feature-detail").addEventListener("click", closeFeatureDialog);
    byId("back-daily-vote").addEventListener("click", backDailyPanels);
    byId("feature-detail-dialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeFeatureDialog();
    });
    byId("feature-detail-dialog").addEventListener("cancel", event => {
      event.preventDefault();
      closeFeatureDialog();
    });
    byId("feature-detail-dialog").addEventListener("close", () => {
      resetFeatureSelection({ clearHash: window.location.hash !== "#chat", restoreFocus: window.location.hash !== "#chat" });
    });
    resetFeatureSelection({ clearHash: false });
    const initialFeature = window.location.hash.slice(1);
    if (FEATURE_IDS.includes(initialFeature)) showFeature(initialFeature, { updateHash: false });
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value ?? "";
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) {
      element.textContent = window.MrzhI18n?.t
        ? window.MrzhI18n.t(text)
        : text;
    }
    return element;
  }

  function identityExpiryLabel(value) {
    const expiry = value
      ? formatDate(value)
      : window.MrzhI18n.t("永久有效");
    return window.MrzhI18n.format("识别码有效期：{date}", { date: expiry });
  }

  function identityRenewalNoticeKey(value) {
    if (!value) return "";
    const expiryTime = new Date(value).getTime();
    if (!Number.isFinite(expiryTime)) return "";
    const remaining = expiryTime - Date.now();
    if (remaining > 7 * 24 * 60 * 60 * 1000) return "";
    return remaining <= 0
      ? "识别码已过期，请申请延期；延期审批期间，过期识别码可额外投票一次。"
      : "识别码将在 7 天内到期，请及时申请延期；延期审批期间，过期识别码可额外投票一次。";
  }

  function showVoteSuccessDialog({ kind, data, message, title = "投票成功", kicker = "" }) {
    const isTest = Boolean(data?.publicTestVote);
    const renewalNoticeKey = isTest
      ? ""
      : identityRenewalNoticeKey(data?.identityCodeExpiresAt);
    setText(
      "vote-success-kicker",
      window.MrzhI18n.t(
        kicker || (kind === "daily" ? "DAILY VOTING" : "TECHNOLOGY VOTE")
      )
    );
    setText("vote-success-title", window.MrzhI18n.t(title));
    setText("vote-success-message", message);
    setText(
      "vote-success-expiry",
      isTest ? "" : identityExpiryLabel(data?.identityCodeExpiresAt)
    );
    setText(
      "vote-success-renewal",
      renewalNoticeKey ? window.MrzhI18n.t(renewalNoticeKey) : ""
    );
    const renewal = byId("vote-success-renewal");
    if (renewal) renewal.hidden = isTest;
    const dialog = byId("vote-success-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function showOperationNotice(message, { title = "操作提示", kicker = "CAMP ASSISTANT" } = {}) {
    if (!message) return;
    showVoteSuccessDialog({
      kind: "technology",
      data: { publicTestVote: true },
      message,
      title,
      kicker
    });
  }

  function renderOperationProgress() {
    const dialog = byId("operation-progress-dialog");
    const progressEntries = [...activeOperationProgress.values()];
    const latestKicker = progressEntries[progressEntries.length - 1];
    if (!latestKicker) {
      if (dialog?.open) dialog.close();
      return;
    }
    const message = window.MrzhI18n.t("正在处理…");
    setText("operation-progress-kicker", window.MrzhI18n.t(latestKicker));
    setText("operation-progress-title", message);
    dialog?.querySelector('[role="progressbar"]')?.setAttribute("aria-label", message);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function showOperationProgress(kicker = "CAMP ASSISTANT") {
    const token = ++operationProgressSequence;
    activeOperationProgress.set(token, kicker);
    renderOperationProgress();
    return token;
  }

  function hideOperationProgress(token) {
    activeOperationProgress.delete(token);
    renderOperationProgress();
  }

  // Shared feature modules use the same processing/result dialogs as the page.
  window.MrzhFeedback = Object.freeze({
    notice: message => showOperationNotice(window.MrzhI18n.t(message)),
    begin: () => showOperationProgress(),
    end: hideOperationProgress
  });

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || payload.title || `HTTP ${response.status}`);
      Object.assign(error, payload, { status: response.status });
      throw error;
    }
    return payload;
  }

  function participationScopeKey(pollDate, dailyItemIds) {
    return JSON.stringify({
      pollDate: String(pollDate || ""),
      dailyItemIds: [...new Set(dailyItemIds || [])].map(String).sort()
    });
  }

  function currentParticipationScopeKey() {
    const pollDate = state.data?.voteSummary?.pollDate || "";
    const dailyItemIds = (state.data?.dailyVote?.items || [])
      .filter((item) => item.isOpen)
      .map((item) => item.id);
    return participationScopeKey(pollDate, dailyItemIds);
  }

  function hasTechnologyParticipation(summary = state.data?.voteSummary) {
    return Boolean(
      summary?.pollDate &&
      state.voteParticipation.technologyParticipated &&
      state.voteParticipation.technologyPollDate === summary.pollDate
    );
  }

  function hasDailyParticipation(itemId) {
    return state.voteParticipation.dailyParticipatedItemIds.includes(itemId);
  }

  const participationSync = window.MrzhVoteParticipation.create({
    getContext() {
      const session = identitySession();
      if (!state.data || !session?.identityCode || (!session.password && !session.cookieSession)) return null;
      return {
        identityCode: session.identityCode,
        password: session.password,
        scopeKey: currentParticipationScopeKey(),
        revision: state.voteParticipation.revision || 0
      };
    },
    request(context) {
      return request("/api/public/vote-participation", {
        method: "POST",
        body: JSON.stringify({
          identityCode: context.identityCode,
          identityPassword: context.password
        })
      });
    },
    apply(result, context) {
      const dailyOpenItemIds = Array.isArray(result.dailyOpenItemIds)
        ? [...new Set(result.dailyOpenItemIds.map(String))]
        : [];
      const dailyParticipatedItemIds = Array.isArray(result.dailyParticipatedItemIds)
        ? [...new Set(result.dailyParticipatedItemIds.map(String))]
        : [];
      state.voteParticipation = {
        revision: context.revision,
        identityCode: context.identityCode,
        scopeKey: context.scopeKey,
        technologyPollDate: String(result.technologyPollDate || ""),
        technologyParticipated: result.technologyParticipated === true,
        dailyOpenItemIds,
        dailyParticipatedItemIds
      };
      renderVote(state.data.voteSummary || {});
      renderDailyVote(state.data.dailyVote || {});
    },
    onError(error) {
      if (isIdentitySessionInvalidError(error)) clearIdentitySession({ openPanel: true });
      // A failed read is not cached. Reopening the panel or resuming retries it.
    }
  });

  function refreshVoteParticipation(options) {
    return participationSync.refresh(options);
  }

  async function openVoteParticipants({
    kind,
    title = "投票人名单",
    subtitle = "",
    pollDate = "",
    optionKey = "",
    itemId = "",
    optionId = "",
    requiresIdentity = false
  }) {
    const session = identitySession();
    if (requiresIdentity && !session) {
      showFeature("identity");
      showOperationNotice(
        window.MrzhI18n.t("请先登录并完成本期投票后查看名单。"),
        { kicker: "DAILY VOTING" }
      );
      return;
    }
    const dialog = byId("vote-participants-dialog");
    const list = byId("vote-participants-list");
    list.replaceChildren();
    list.hidden = true;
    setText("vote-participants-title", title);
    const subtitleElement = byId("vote-participants-subtitle");
    subtitleElement.textContent = subtitle;
    subtitleElement.hidden = !subtitle;
    setText("vote-participants-status", "");
    const progressToken = showOperationProgress("DAILY VOTING");
    let errorMessage = "";
    try {
      const result = await request("/api/public/vote-participants", {
        method: "POST",
        body: JSON.stringify({
          kind,
          pollDate,
          optionKey,
          itemId,
          optionId,
          locale: window.MrzhI18n.language(),
          ...(requiresIdentity && session ? {
            identityCode: session.identityCode,
            identityPassword: session.password
          } : {})
        })
      });
      list.replaceChildren();
      const names = Array.isArray(result.names) ? result.names : [];
      list.hidden = names.length === 0;
      if (names.length) {
        for (const name of names) list.append(create("li", "vote-participant-name", String(name || "—")));
        setText("vote-participants-status", window.MrzhI18n.format("共 {count} 人", { count: names.length }));
      } else {
        setText("vote-participants-status", window.MrzhI18n.t("暂无参与人。"));
      }
    } catch (error) {
      list.replaceChildren();
      errorMessage = window.MrzhI18n.t(error.code === "vote_participation_required"
          ? "请先完成本期投票后再查看名单。"
          : "参与人名单暂时无法加载，请稍后重试。");
    } finally {
      hideOperationProgress(progressToken);
    }
    if (errorMessage) {
      showOperationNotice(errorMessage, { kicker: "DAILY VOTING" });
    } else {
      if (!dialog.open) dialog.showModal();
      // Reset after showing: reused dialogs can restore their previous scroll
      // position when layout becomes visible, even after replacing the names.
      list.scrollTop = 0;
      list.scrollLeft = 0;
      dialog.scrollTop = 0;
      dialog.scrollLeft = 0;
    }
  }

  function categoryName(value) {
    const source = { military: "军事", agriculture: "农业", industry: "工业" }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function laneName(value) {
    return window.MrzhI18n.t(
      value === "core" ? "类型科技（第一行）" : "通用科技（第二行）"
    );
  }

  function taskName(value) {
    const source = {
      tech_switch: "更新科技",
      contribution_sync: "更新贡献",
      inactivity_sync: "更新斩杀预警",
      member_profile_sync: "更新成员资料",
      weekly_activity_sync: "更新周活跃点",
      member_sync: "成员同步",
      patrol: "营地巡逻"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function pluginEnabled(id) {
    return (state.data?.plugins || []).some(
      (plugin) => plugin.id === id && plugin.enabled
    );
  }

  function applyPluginVisibility() {
    const sections = {
      inactivity: ["warnings"],
      "member-profile": ["members", "staff"]
    };
    for (const [pluginId, ids] of Object.entries(sections)) {
      const enabled = pluginEnabled(pluginId);
      for (const id of ids) {
        const section = byId(id);
        if (section && !enabled) section.hidden = true;
        for (const link of document.querySelectorAll(
          `[href="#${id}"], [data-feature-target="${id}"]`
        )) {
          link.hidden = !enabled;
        }
      }
    }
  }

  function stateName(value) {
    const source = {
      queued: "排队",
      claimed: "已领取",
      running: "执行中",
      cancelling: "中断中",
      interrupted: "已中断",
      succeeded: "成功",
      partially_succeeded: "部分完成",
      failed: "失败",
      timed_out: "已超时",
      skipped: "已跳过"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function optionMap(summary) {
    return new Map((summary.options || []).map((option) => [option.key, option]));
  }

  function requiredVoteKeys(summary, key, result = new Set(), visiting = new Set()) {
    if (result.has(key) || visiting.has(key)) return result;
    const option = optionMap(summary).get(key);
    if (!option) return result;
    visiting.add(key);
    if (option.prerequisiteKey) {
      requiredVoteKeys(summary, option.prerequisiteKey, result, visiting);
    }
    visiting.delete(key);
    result.add(key);
    return result;
  }

  function configuredVoteLimit(summary) {
    const value = Number(summary?.voteLimit);
    return Number.isInteger(value) && value >= 0 && value <= 12 ? value : 6;
  }

  function removeVoteAndDependents(summary, key) {
    const before = state.selections.size;
    state.selections.delete(key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const option of summary.options || []) {
        if (
          state.selections.has(option.key) &&
          option.prerequisiteKey &&
          !state.selections.has(option.prerequisiteKey) &&
          optionMap(summary).has(option.prerequisiteKey)
        ) {
          state.selections.delete(option.key);
          changed = true;
        }
      }
    }
    return before - state.selections.size;
  }

  function toggleVote(summary, option) {
    if (hasTechnologyParticipation(summary)) return;
    if (state.selections.has(option.key)) {
      const removed = removeVoteAndDependents(summary, option.key);
      if (removed > 1) {
        showOperationNotice(
          window.MrzhI18n.t("取消前置科技时，依赖它的科技也会一并取消。"),
          { kicker: "TECHNOLOGY VOTE" }
        );
      }
      syncTechnologySelection();
      return;
    }
    const required = requiredVoteKeys(summary, option.key);
    const additions = [...required].filter((key) => !state.selections.has(key));
    const voteLimit = configuredVoteLimit(summary);
    if (state.selections.size + additions.length > voteLimit) {
      showOperationNotice(
        window.MrzhI18n.format(
          "选择该科技及其前置科技后将超过 {limit} 票。",
          { limit: voteLimit }
        ),
        { kicker: "TECHNOLOGY VOTE" }
      );
      return;
    }
    for (const key of additions) state.selections.add(key);
    if (option.prerequisiteName) {
      showOperationNotice(
        window.MrzhI18n.format(
          "已同时选择前置科技：{name}",
          { name: option.prerequisiteName }
        ),
        { kicker: "TECHNOLOGY VOTE" }
      );
    }
    syncTechnologySelection();
  }

  function syncTechnologySelection() {
    for (const button of byId("vote-options").querySelectorAll(".vote-option")) {
      const selected = String(state.selections.has(button.dataset.key));
      button.dataset.selected = selected;
      button.setAttribute("aria-pressed", selected);
    }
  }

  function renderVote(summary) {
    return window.MrzhViewState.preserve(() => renderVoteContent(summary));
  }

  function renderVoteContent(summary) {
    setText("daily-tech-panel-count", String(summary.options?.length || 0));
    const alreadyParticipated = hasTechnologyParticipation(summary);
    const signature = JSON.stringify([summary, window.MrzhI18n.language(), alreadyParticipated]);
    if (signature === renderedTechnologyVote) {
      syncTechnologySelection();
      return;
    }
    renderedTechnologyVote = signature;
    const opensAt = splitTimezoneSuffix(
      formatVoteDateTime(summary.opensAt, summary.opensAtDisplay)
    );
    const closesAt = splitTimezoneSuffix(
      formatVoteDateTime(summary.closesAt, summary.closesAtDisplay)
    );
    setText(
      "vote-deadline",
      window.MrzhI18n.format("开放时间 {start} - {end} ({timezone})", {
        start: opensAt.value,
        end: closesAt.value,
        timezone: formatTimezoneLabel(opensAt.timezone || closesAt.timezone || summary.timezone || configuredTimezone())
      })
    );
    const voteLimit = configuredVoteLimit(summary);
    setText(
      "vote-participant-count",
      window.MrzhI18n.format(
        "{count} 人投票，每人最多可选 {limit} 项科技。",
        { count: summary.ballotCount || 0, limit: voteLimit }
      )
    );
    const voteWindowState = byId("vote-window-state");
    if (voteWindowState) {
      voteWindowState.classList.toggle("is-open", summary.isOpen !== false);
      voteWindowState.textContent = window.MrzhI18n.t(
        summary.isOpen === false ? "当前未开放" : "当前可投票"
      );
    }
    const root = byId("vote-options");
    root.replaceChildren();
    renderVoteSelection(
      summary,
      byId("vote-selection-preview"),
      Boolean(alreadyParticipated),
      Boolean(alreadyParticipated && summary.isOpen !== false)
    );
    const submit = byId("submit-vote");
    submit.textContent = window.MrzhI18n.t(
      alreadyParticipated ? "已参与" : "提交投票"
    );
    submit.disabled =
      alreadyParticipated || summary.isOpen === false || !summary.options?.length;
    if (!summary.options?.length) {
      root.append(create("p", "empty-state", "管理员尚未开放科技投票。"));
      return;
    }
    for (const lane of ["core", "general"]) {
      const options = summary.options.filter((option) => option.lane === lane);
      if (!options.length) continue;
      const section = create("section", "vote-lane");
      section.append(
        create(
          "h3",
          "vote-lane-title",
          lane === "core"
            ? window.MrzhI18n.t("类型科技（第一行）")
            : window.MrzhI18n.t("其他科技（第二行）")
        )
      );
      const grid = create("div", "vote-lane-grid");
      for (const option of options) {
        const button = create("button", "vote-option");
        button.type = "button";
        button.disabled = summary.isOpen === false || alreadyParticipated;
        button.dataset.key = option.key;
        button.dataset.refreshKey = `technology-option:${option.key}`;
        button.dataset.selected = String(state.selections.has(option.key));
        button.setAttribute("aria-pressed", String(state.selections.has(option.key)));
        if (option.iconUrl) {
          const image = document.createElement("img");
          image.className = "tech-icon";
          image.src = option.iconUrl;
          image.alt = "";
          image.loading = "lazy";
          button.append(image);
        } else {
          button.append(
            create(
              "span",
              "tech-icon tech-icon-placeholder",
              option.name.slice(0, 1)
            )
          );
        }
        const copy = create("span", "tech-copy");
        copy.append(create("strong", "", option.name));
        copy.append(
          create(
            "small",
            "",
            `${categoryName(option.category)} · ${laneName(option.lane)}`
          )
        );
        if (option.prerequisiteName) {
          copy.append(
            create(
              "small",
              "tech-prerequisite",
              window.MrzhI18n.format("前置科技：{name}", {
                name: option.prerequisiteName
              })
            )
          );
        }
        if (option.description) {
          copy.append(create("span", "tech-description", option.description));
        }
        const side = create("span", "vote-option-side");
        side.append(
          create(
            "span",
            "vote-count",
            `${option.votes} ${window.MrzhI18n.t("票")}`
          )
        );
        button.append(copy, side);
        button.addEventListener("click", () => toggleVote(summary, option));
        grid.append(button);
      }
      section.append(grid);
      root.append(section);
    }
  }

  function renderVoteSelection(
    summary,
    target = byId("vote-selection-preview"),
    allowParticipants = false,
    requiresIdentity = allowParticipants
  ) {
    const root = target;
    if (!root) return;
    root.replaceChildren();
    const fixedKeys = new Set(
      (summary.fixedTechnologies || []).map((item) => item.key)
    );
    for (const lane of ["core", "general"]) {
      const row = create("section", "vote-selection-row");
      row.append(
        create(
          "span",
          "vote-selection-label",
          lane === "core"
            ? window.MrzhI18n.t("类型科技")
            : window.MrzhI18n.t("其他科技")
        )
      );
      const slots = create("div", "vote-selection-slots");
      const technologies = summary.projectedPlan?.[lane] || [];
      for (let index = 0; index < 6; index += 1) {
        const option = technologies[index];
        const sourceClass = option
          ? fixedKeys.has(option.key)
            ? " is-fixed"
            : " is-voted"
          : "";
        const canViewParticipants = Boolean(
          allowParticipants && option && !fixedKeys.has(option.key)
        );
        const slot = create(
          "span",
          `vote-selection-slot${option ? " is-filled" : ""}${sourceClass}${canViewParticipants ? " is-clickable" : ""}`
        );
        if (option?.iconUrl) {
          const image = document.createElement("img");
          image.src = option.iconUrl;
          image.alt = option.name;
          slot.append(image);
        } else if (option) {
          slot.textContent = option.name.slice(0, 1);
        } else {
          slot.textContent = "+";
        }
        if (option) slot.title = option.name;
        if (canViewParticipants) {
          slot.tabIndex = 0;
          slot.setAttribute("role", "button");
          slot.setAttribute("aria-label", window.MrzhI18n.format("查看 {name} 的投票人名单", { name: option.name }));
          const open = () => void openVoteParticipants({
            kind: "technology",
            title: window.MrzhI18n.t("投票人名单"),
            subtitle: option.name,
            pollDate: summary.pollDate,
            optionKey: option.key,
            requiresIdentity
          });
          slot.addEventListener("click", open);
          slot.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          });
        }
        slots.append(slot);
      }
      row.append(slots);
      root.append(row);
    }
  }

  function renderHighlights(items) {
    const root = byId("highlights");
    if (!window.MrzhViewState.changed(root, items)) return;
    root.replaceChildren();
    const entries = (items || []).map((item) =>
      typeof item === "string"
        ? { blocks: [{ type: "text", text: item }] }
        : item
    );
    if (!entries.length) {
      root.append(create("p", "empty-state", "当前没有需要公示的营地公告。"));
      return;
    }
    for (const item of entries) {
      const blocks = Array.isArray(item?.blocks) ? item.blocks : [];
      const card = create("article", "highlight-item");
      const bullet = create("span", "highlight-item-bullet", "⌁");
      bullet.setAttribute("aria-hidden", "true");
      card.append(bullet);
      for (const block of blocks) {
        if (block?.type === "video") {
          const video = window.MrzhContentMedia.card(block);
          if (video) card.append(video);
        } else if (block?.type === "image" && /^https:\/\//i.test(String(block.url || ""))) {
          const figure = document.createElement("figure");
          figure.className = "highlight-image";
          const image = document.createElement("img");
          image.src = block.url;
          image.alt = block.alt || window.MrzhI18n.t("营地公告图片");
          image.loading = "lazy";
          image.decoding = "async";
          image.tabIndex = 0;
          image.setAttribute("role", "button");
          image.setAttribute("aria-label", window.MrzhI18n.t("点击查看大图"));
          image.title = window.MrzhI18n.t("点击查看大图");
          image.addEventListener("click", () => openImagePreview(block.url, image.alt));
          image.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openImagePreview(block.url, image.alt);
            }
          });
          image.addEventListener("error", () => {
            figure.classList.add("is-broken");
          }, { once: true });
          figure.append(image);
          card.append(figure);
        } else if (block?.type === "text" && String(block.text || "").trim()) {
          const copy = document.createElement("p");
          copy.className = "highlight-copy";
          copy.textContent = block.text;
          card.append(copy);
        }
      }
      if (card.childElementCount > 1) root.append(card);
    }
  }

  function renderRichBlocks(root, blocks, emptyText = "") {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "video") {
        const video = window.MrzhContentMedia.card(block);
        if (video) root.append(video);
      } else if (block?.type === "image" && /^https:\/\//i.test(String(block.url || ""))) {
        const figure = document.createElement("figure");
        figure.className = "highlight-image daily-rich-image";
        const image = document.createElement("img");
        image.src = block.url;
        image.alt = block.alt || window.MrzhI18n.t("公告图片");
        image.loading = "lazy";
        image.decoding = "async";
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", window.MrzhI18n.t("点击查看大图"));
        image.addEventListener("click", () => openImagePreview(block.url, image.alt));
        image.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openImagePreview(block.url, image.alt);
          }
        });
        figure.append(image);
        root.append(figure);
      } else if (block?.type === "text" && String(block.text || "").trim()) {
        root.append(create("p", "daily-rich-text", block.text));
      }
    }
    if (!root.childElementCount && emptyText) root.append(create("p", "empty-state", emptyText));
  }

  function dailyDate(value, displayValue) {
    return value ? formatDate(value, displayValue) : "—";
  }

  function dailyKindName(kind) {
    return window.MrzhI18n.t(kind === "draw" ? "抽签事项" : "投票事项");
  }

  function dailyOptionLabel(option) {
    const text = (option?.blocks || [])
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text || "").trim())
      .filter(Boolean)
      .join(" ");
    return text || window.MrzhI18n.t((option?.blocks || []).some(block => block.type === "video") ? "视频选项" : "图片选项");
  }

  function dailySelections(itemId) {
    const values = state.dailySelections[itemId];
    return Array.isArray(values) ? values : [];
  }

  function syncDailySelection(options, itemId) {
    const selected = new Set(dailySelections(itemId));
    for (const button of options.querySelectorAll(".daily-vote-option")) {
      const isSelected = selected.has(button.dataset.optionId);
      button.classList.toggle("is-selected", isSelected);
      (button.querySelector(".daily-vote-option-select") || button).setAttribute("aria-pressed", String(isSelected));
    }
  }

  function renderDailyItem(item) {
    const alreadyParticipated = hasDailyParticipation(item.id);
    const card = create("article", `daily-vote-item daily-vote-item-${item.kind}`);
    const heading = create("div", "daily-vote-item-heading");
    const title = create("div", "daily-vote-item-title");
    renderRichBlocks(title, item.titleBlocks, window.MrzhI18n.t("未命名事项"));
    heading.append(title, create("span", "daily-vote-kind", dailyKindName(item.kind)));
    card.append(heading);
    const description = create("div", "daily-vote-description");
    renderRichBlocks(description, item.descriptionBlocks);
    if (description.childElementCount) card.append(description);
    const meta = create("div", "daily-vote-meta");
    const startAt = splitTimezoneSuffix(
      formatVoteDateTime(item.startAt, item.startAtDisplay)
    );
    const endAt = splitTimezoneSuffix(
      formatVoteDateTime(item.endAt, item.endAtDisplay)
    );
    meta.append(
      create("span", "daily-vote-meta-item", window.MrzhI18n.format(
        "开放时间 {start} - {end} ({timezone})",
        {
          start: startAt.value,
          end: endAt.value,
          timezone: formatTimezoneLabel(startAt.timezone || endAt.timezone || configuredTimezone())
        }
      ))
    );
    if (item.kind === "poll") {
      meta.append(create("span", "daily-vote-meta-item", window.MrzhI18n.format("每人可选 {count} 项", {
        count: item.maxSelections
      })));
    } else {
      meta.append(create("span", "daily-vote-meta-item", window.MrzhI18n.format("抽取 {count} 人 · 已报名 {participants} 人", {
        count: item.drawCount,
        participants: item.participantCount || 0
      })));
    }
    card.append(meta);
    if (item.kind === "poll") {
      const selected = new Set(dailySelections(item.id));
      const options = create("div", "daily-vote-options");
      for (const option of item.options || []) {
        const hasVideo = (option.blocks || []).some(block => block.type === "video");
        const button = create(hasVideo ? "div" : "button", `daily-vote-option${hasVideo ? " daily-vote-option--media" : ""}${selected.has(option.id) ? " is-selected" : ""}${alreadyParticipated ? " is-participated" : ""}`);
        const actionButton = hasVideo ? create("button", "daily-vote-option-select") : button;
        if (hasVideo) {
          button.setAttribute("role", "group");
          button.setAttribute("aria-label", dailyOptionLabel(option));
          actionButton.setAttribute("aria-label", dailyOptionLabel(option));
          button.append(actionButton);
        }
        actionButton.type = "button";
        button.dataset.optionId = option.id;
        button.dataset.refreshKey = `daily-option:${item.id}:${option.id}`;
        actionButton.dataset.refreshKey = `daily-option-action:${item.id}:${option.id}`;
        actionButton.disabled = item.isOpen === false;
        actionButton.setAttribute("aria-pressed", String(selected.has(option.id)));
        const content = create("div", "daily-vote-option-content");
        renderRichBlocks(content, option.blocks, window.MrzhI18n.t("未命名选项"));
        const side = create("span", "daily-option-side");
        side.append(create("strong", "daily-vote-option-count", window.MrzhI18n.format("{count} 票", {
          count: option.votes || 0
        })));
        button.append(content, side);
        actionButton.addEventListener("click", () => {
          if (alreadyParticipated && item.isOpen) {
            void openVoteParticipants({
              kind: "daily-poll",
              title: window.MrzhI18n.t("投票人名单"),
              subtitle: dailyOptionLabel(option),
              itemId: item.id,
              optionId: option.id,
              requiresIdentity: true
            });
            return;
          }
          const next = new Set(dailySelections(item.id));
          if (next.has(option.id)) next.delete(option.id);
          else if (next.size < Number(item.maxSelections || 0)) next.add(option.id);
          else {
            showOperationNotice(
              window.MrzhI18n.format("最多选择 {count} 项", { count: item.maxSelections }),
              { kicker: "DAILY VOTING" }
            );
            return;
          }
          state.dailySelections[item.id] = [...next];
          syncDailySelection(options, item.id);
        });
        options.append(button);
      }
      card.append(options);
    }
    const action = create("div", "daily-vote-item-action");
    const submit = create(
      "button",
      "button button-primary",
      window.MrzhI18n.t(
        alreadyParticipated
          ? "已参与"
          : item.kind === "draw"
            ? "提交抽签"
            : "提交投票"
      )
    );
    submit.type = "button";
    submit.disabled = item.isOpen === false || alreadyParticipated;
    submit.addEventListener("click", () => submitDailyVote(item));
    action.append(submit);
    if (item.kind === "draw" && item.isOpen && alreadyParticipated) {
      const participants = create("button", "button button-quiet", window.MrzhI18n.t("查看参与人名单"));
      participants.type = "button";
      participants.addEventListener("click", () => void openVoteParticipants({
        kind: "draw",
        title: window.MrzhI18n.t("抽签参与人名单"),
        itemId: item.id,
        requiresIdentity: true
      }));
      action.append(participants);
    }
    card.append(action);
    return card;
  }

  function renderDailyHistory(payload) {
    const root = byId("daily-vote-history");
    if (!root) return;
    root.replaceChildren();
    const technology = payload?.technologyHistory || [];
    const technologySection = create("section", "daily-history-group");
    technologySection.append(
      create(
        "h4",
        "daily-history-group-title",
        window.MrzhI18n.t("科技投票 · 最近 10 条")
      )
    );
    if (!technology.length) {
      technologySection.append(create("p", "empty-state", "当天无投票记录"));
    }
    for (const item of technology) {
      const card = create("article", "daily-history-card");
      card.append(create("strong", "daily-history-card-title", item.pollDate));
      const fixedTechnologies = Array.isArray(item.fixedTechnologies) ? item.fixedTechnologies : [];
      const hasRecords = Number(item.ballotCount || 0) > 0 || fixedTechnologies.length > 0;
      const preview = create("div", "vote-selection-preview daily-history-selection-preview");
      renderVoteSelection(item, preview, true, false);
      card.append(preview);
      if (hasRecords) {
        const fixedKeys = new Set(fixedTechnologies.map((fixed) => fixed.key));
        const result = create("div", "daily-history-result-list");
        for (const tech of (item.options || []).filter((option) => Number(option.votes) > 0)) {
          if (fixedKeys.has(tech.key)) continue;
          const resultButton = create("button", "daily-history-result is-voted", window.MrzhI18n.format("{name} · {count} 票", {
            name: tech.name,
            count: (item.options || []).find((option) => option.key === tech.key)?.votes || 0
          }));
          resultButton.type = "button";
          resultButton.addEventListener("click", () => void openVoteParticipants({
            kind: "technology",
            title: window.MrzhI18n.t("投票人名单"),
            subtitle: tech.name,
            pollDate: item.pollDate,
            optionKey: tech.key
          }));
          result.append(resultButton);
        }
        for (const fixed of fixedTechnologies) {
          result.append(create("span", "daily-history-result is-fixed", window.MrzhI18n.format("{name} · 固定", { name: fixed.name })));
        }
        if (result.childElementCount) card.append(result);
      } else {
        card.append(create("p", "empty-state", "当天无投票记录"));
      }
      technologySection.append(card);
    }
    root.append(technologySection);
    for (const [kind, items] of [["poll", payload?.history?.polls || []], ["draw", payload?.history?.draws || []]]) {
      const section = create("section", "daily-history-group");
      section.append(
        create(
          "h4",
          "daily-history-group-title",
          window.MrzhI18n.t(
            kind === "poll" ? "投票事项 · 最近 10 条" : "抽签事项 · 最近 10 条"
          )
        )
      );
      if (!items.length) {
        section.append(create("p", "empty-state", kind === "poll" ? "暂无历史投票事项。" : "暂无历史抽签事项。"));
      }
      for (const item of items) {
        const card = create("article", "daily-history-card");
        const title = create("div", "daily-history-card-title");
        const endAt = splitTimezoneSuffix(
          formatVoteDateTime(item.endAt, item.endAtDisplay)
        );
        renderRichBlocks(title, item.titleBlocks, window.MrzhI18n.t("未命名事项"));
        card.append(title, create("small", "muted", window.MrzhI18n.format(
          "投票截止时间 {end} ({timezone})",
          {
            end: endAt.value,
            timezone: formatTimezoneLabel(endAt.timezone || configuredTimezone())
          }
        )));
        const participantRow = create("div", `daily-history-participant-row${kind === "draw" ? " daily-history-draw-meta-row" : ""}`);
        participantRow.append(create("small", "muted", window.MrzhI18n.format(
          "参与 {count} 人",
          { count: item.participantCount || 0 }
        )));
        if (kind === "draw") {
          const participants = create(
            "button",
            "daily-history-result is-winner daily-history-participant-button",
            window.MrzhI18n.t("查看参与人名单")
          );
          participants.type = "button";
          participants.addEventListener("click", () => void openVoteParticipants({
            kind: "draw",
            title: window.MrzhI18n.t("抽签参与人名单"),
            itemId: item.id
          }));
          participantRow.append(participants);
        }
        card.append(participantRow);
        if (kind === "poll") {
          const result = create("div", "daily-history-result-list");
          for (const option of item.options || []) {
            const optionText = create("button", "daily-history-result daily-history-result-button");
            optionText.type = "button";
            const optionContent = create("div", "daily-history-option-content");
            optionContent.append(create("p", "daily-rich-text", dailyOptionLabel(option)));
            optionText.append(
              optionContent,
              create("strong", "daily-history-result-count", window.MrzhI18n.format("{count} 票", { count: option.votes || 0 }))
            );
            optionText.addEventListener("click", () => void openVoteParticipants({
              kind: "daily-poll",
              title: window.MrzhI18n.t("投票人名单"),
              subtitle: dailyOptionLabel(option),
              itemId: item.id,
              optionId: option.id
            }));
            result.append(optionText);
            for (const block of option.blocks || []) {
              if (block.type !== "video") continue;
              const video = window.MrzhContentMedia.card(block);
              if (video) result.append(video);
            }
          }
          card.append(result);
        } else {
          const winners = create("div", "daily-history-result-list");
          const winnerList = Array.isArray(item.winners)
            ? item.winners.filter(winner => winner && String(winner.playerName || "").trim())
            : [];
          if (winnerList.length) {
            card.append(create("p", "daily-history-winner-label", "中签人名单："));
          }
          for (const winner of winnerList) {
            winners.append(create("span", "daily-history-result is-winner", winner.playerName));
          }
          card.append(winners.childElementCount ? winners : create("p", "empty-state", "本次抽签无人报名"));
        }
        section.append(card);
      }
      root.append(section);
    }
    if (!root.childElementCount) root.append(create("p", "empty-state", "暂无历史投票结果。"));
  }

  function renderDailyVote(payload) {
    return window.MrzhViewState.preserve(() => renderDailyVoteContent(payload));
  }

  function renderDailyVoteContent(payload) {
    const root = byId("daily-vote-items");
    if (!root) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const historyCount = (payload?.technologyHistory || []).length +
      (payload?.history?.polls || []).length +
      (payload?.history?.draws || []).length;
    renderIdentityAccount();
    setText("feature-vote-count", String(dailyVoteFeatureCount(payload)));
    setText("daily-items-panel-count", String(items.length));
    setText("daily-history-panel-count", String(historyCount));
    const signature = JSON.stringify([
      payload, window.MrzhI18n.language(),
      items.map(item => hasDailyParticipation(item.id))
    ]);
    // Selection and navigation keep the existing image nodes. Rebuild only
    // when server data, participation permissions or the language changes.
    if (signature !== renderedDailyVote) {
      renderedDailyVote = signature;
      root.replaceChildren();
      if (!items.length) {
        root.append(create("p", "empty-state", window.MrzhI18n.t("当前没有开放事项。")));
      }
      for (const item of items) root.append(renderDailyItem(item));
      renderDailyHistory(payload || {});
    }
    syncDailyPanelVisibility();
    setText("hero-vote-count", String(dailyVoteFeatureCount(payload)));
    setText("feature-vote-count", String(dailyVoteFeatureCount(payload)));
  }

  function syncDailyPanelVisibility() {
    const panelList = byId("daily-vote-panels");
    const panelDetail = byId("daily-vote-panel-detail");
    if (panelList) panelList.hidden = Boolean(state.dailyPanel);
    if (panelDetail) panelDetail.hidden = !state.dailyPanel;
    for (const panel of document.querySelectorAll("[data-daily-panel-content]")) {
      panel.hidden = panel.dataset.dailyPanelContent !== state.dailyPanel;
    }
    if (state.activeFeature === "vote") syncFeatureDetailKicker();
  }

  function openDailyPanel(panel) {
    if (panel === "identity") { showFeature("identity"); return; }
    if (!["technology", "items", "history"].includes(panel)) return;
    if (state.activeFeature !== "vote") return;
    state.dailyPanel = panel;
    syncDailyPanelVisibility();
    resetFeatureScroll();
    if (panel === "identity") void refreshIdentitySession();
    if (panel === "technology" || panel === "items") void refreshVoteParticipation({ force: true });
  }

  function backDailyPanels() {
    state.dailyPanel = "";
    syncDailyPanelVisibility();
    resetFeatureScroll();
  }

  async function submitDailyVote(item) {
    if (!requireIdentitySession()) return;
    if (hasDailyParticipation(item.id)) return;
    const { identityCode, password } = identitySession();
    const selections = item.kind === "poll" ? dailySelections(item.id) : [];
    if (item.kind === "poll" && !selections.length) {
      showOperationNotice(window.MrzhI18n.t("请至少选择一项。"), { kicker: "DAILY VOTING" });
      return;
    }
    const progressToken = showOperationProgress("DAILY VOTING");
    try {
      const payload = await request("/api/public/daily-vote", {
        method: "POST",
        body: JSON.stringify({
          itemId: item.id,
          identityCode,
          identityPassword: password,
          locale: window.MrzhI18n.language(),
          selections
        })
      });
      state.voteParticipation.revision = (state.voteParticipation.revision || 0) + 1;
      state.voteParticipation.dailyParticipatedItemIds = [
        ...new Set([...state.voteParticipation.dailyParticipatedItemIds, item.id])
      ];
      state.dailySelections[item.id] = [];
      if (state.data) state.data.dailyVote = payload;
      renderDailyVote(payload);
      showVoteSuccessDialog({
        kind: "daily",
        data: payload,
        message: payload.renewalGraceUsed
            ? window.MrzhI18n.t("投票已提交；本次已使用延期审批期间唯一一次过期投票机会。")
            : window.MrzhI18n.t("提交成功，票数已更新。")
      });
    } catch (error) {
      if (error.code === "daily_vote_already_participated") {
        state.voteParticipation.revision = (state.voteParticipation.revision || 0) + 1;
        state.voteParticipation.dailyParticipatedItemIds = [
          ...new Set([...state.voteParticipation.dailyParticipatedItemIds, item.id])
        ];
        renderDailyVote(state.data?.dailyVote || {});
        showOperationNotice(window.MrzhI18n.t("本事项已参与，不能重复提交。"), { kicker: "DAILY VOTING" });
        return;
      }
      if (IDENTITY_SESSION_INVALID_CODES.has(error.code)) {
        clearIdentitySession({ openPanel: true });
      }
      const message = error.code === "vote_eligibility_failed"
        ? window.MrzhI18n.t("您尚未满足投票资格贡献与活跃度标准。")
        : error.code === "vote_permission_disabled"
          ? window.MrzhI18n.t("该身份识别码已被管理员禁止投票。")
          : window.MrzhI18n.t(error.message);
      showVoteError(message, window.MrzhI18n.t("日常投票未提交"), error.code === "identity_code_expired" && error.canRenew, identityCode);
    } finally {
      hideOperationProgress(progressToken);
    }
  }

  function openImagePreview(
    url,
    alt = window.MrzhI18n.t("营地公告图片")
  ) {
    const dialog = byId("image-preview-dialog");
    const image = byId("image-preview");
    if (!dialog || !image) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    image.src = url;
    image.alt = alt;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function renderStaff(items) {
    const root = byId("staff-list");
    if (!window.MrzhViewState.changed(root, items)) return;
    root.replaceChildren();
    if (!items?.length) {
      root.append(create("p", "empty-state", "公职数据等待同步。"));
      return;
    }
    for (const item of items) {
      const card = create("article", "staff-card");
      card.append(
        create(
          "strong",
          "",
          item.role_name || item.roleName || window.MrzhI18n.t("公职")
        ),
        create(
          "span",
          "",
          item.member_name || item.memberName || window.MrzhI18n.t("待同步")
        )
      );
      root.append(card);
    }

  }

  function renderMembers(items) {
    const filtered = items || [];
    const root = byId("member-table");
    if (!window.MrzhViewState.changed(root, items)) return;
    const cardsRoot = byId("member-cards");
    root.replaceChildren();
    cardsRoot?.replaceChildren();
    byId("member-empty").hidden = filtered.length > 0;
    for (const item of filtered) {
      const row = document.createElement("tr");
      for (const [value, className] of [
        [item.name, ""],
        [item.profession || "—", ""],
        [item.manor_level ?? "—", "numeric"],
        [item.roommate_name || "—", ""],
        [item.weekly_contribution ?? 0, "numeric"],
        [item.technology_points_used ?? 0, "numeric"],
        [item.material_contribution ?? 0, "numeric"],
        [item.weekly_activity_points ?? 0, "numeric"]
      ]) {
        row.append(create("td", className, String(value)));
      }
      root.append(row);

      if (cardsRoot) {
        const card = create("article", "member-responsive-card");
        const heading = create("div", "member-responsive-heading");
        heading.append(
          create("strong", "member-responsive-name", String(item.name || "—")),
          create(
            "span",
            "member-responsive-detail",
            `${item.profession || "—"} · ${window.MrzhI18n.t("庄园")} ${item.manor_level ?? "—"}`
          ),
          create(
            "span",
            "member-responsive-detail",
            `${window.MrzhI18n.t("同居")}：${item.roommate_name || "—"}`
          )
        );
        const metrics = create("div", "member-responsive-metrics");
        if (item.last_active_text) {
          heading.append(create("span", "member-last-active", item.last_active_text));
        }
        for (const [value, label] of [
          [item.weekly_contribution ?? 0, "本周贡献"],
          [item.technology_points_used ?? 0, "使用科技点"],
          [item.material_contribution ?? 0, "贡献物资"],
          [item.weekly_activity_points ?? 0, "周活跃点"]
        ]) {
          const metric = create("div", "member-responsive-metric");
          metric.append(
            create("strong", "", String(value)),
            create("span", "", window.MrzhI18n.t(label))
          );
          metrics.append(metric);
        }
        card.append(heading, metrics);
        cardsRoot.append(card);
      }
    }
  }

  function renderWarnings(items, thresholdDays) {
    const description = byId("warning-description");
    const [before, after] = window.MrzhI18n.t(
      "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。"
    ).split("{days}");
    description.replaceChildren(
      document.createTextNode(before || ""),
      create("strong", "warning-description-days", String(thresholdDays)),
      document.createTextNode(after || "")
    );
    byId("warning-empty").hidden = items.length > 0;
    const root = byId("warning-list");
    if (!window.MrzhViewState.changed(root, [items, thresholdDays])) return;
    root.replaceChildren();
    for (const item of items) {
      const card = create("article", "warning-card");
      const content = create("div", "warning-card-main");
      content.append(create("strong", "", item.name));
      if (item.profession || item.manor_level) {
        content.append(create("small", "muted", `${item.profession || "—"} · ${window.MrzhI18n.t("庄园")} ${item.manor_level || "—"}`));
      }
      card.append(content, create("span", "warning-age", item.last_active_text ||
        window.MrzhI18n.format("{days} 天前", { days: item.inactive_days })));
      root.append(card);
    }
  }

  function renderRuns(items) {
    const root = byId("run-list");
    if (!window.MrzhViewState.changed(root, items)) return;
    root.replaceChildren();
    if (!items?.length) {
      root.append(create("p", "empty-state", "暂无自动任务记录。"));
      return;
    }
    for (const item of items) {
      const row = create("div", "run-item");
      const content = create("div", "run-item-main");
      content.append(
        create("strong", "run-item-title", taskName(item.taskKey)),
        create("time", "run-item-time muted", window.MrzhTimezone.timestamp(
          item.finishedAt || item.createdAt,
          configuredTimezone(),
          item.finishedAt ? item.finishedAtDisplay : item.createdAtDisplay,
          { seconds: true, showTimezone: false }
        ))
      );
      row.append(content, create("span", `status-badge status-${item.state}`, stateName(item.state)));
      root.append(row);
    }
  }

  function formatDate(value, displayValue) {
    return window.MrzhTimezone.timestamp(value, configuredTimezone(), displayValue);
  }

  function formatVoteDateTime(value, displayValue) {
    return formatDate(value, displayValue);
  }

  function splitTimezoneSuffix(value) {
    const text = String(value || "");
    const match = text.match(
      /(?:[\s\u00a0]*[（(]\s*(UTC(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?)\s*[）)]|[\s\u00a0]+(UTC(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?))\s*$/i
    );
    return match
      ? {
          value: text.slice(0, match.index).trimEnd(),
          timezone: (match[1] || match[2]).replace(/\s+/g, "")
        }
      : { value: text, timezone: "" };
  }

  function formatTimezoneLabel(value) {
    try {
      return window.MrzhTimezone.label(value || configuredTimezone());
    } catch (_) {
      return value || configuredTimezone();
    }
  }

  function formatIdentityExpiry(value, timezone, displayValue) {
    return value
      ? window.MrzhTimezone.timestamp(value, timezone || configuredTimezone(), displayValue)
      : window.MrzhI18n.t("永久有效");
  }

  function configuredTimezone() {
    return state.data?.campConfig?.timezone || "UTC+08:00";
  }

  function render(data) {
    return window.MrzhViewState.preserve(() => renderContent(data));
  }

  function renderContent(data) {
    const sourceUrl = window.MrzhCampGroup.sourceUrl(data.campConfig?.campGroupDataUrl);
    if (state.data && window.MrzhCampGroup.sourceUrl(state.data.campConfig?.campGroupDataUrl) !== sourceUrl) {
      // A changed source needs the CSP issued with the latest page response.
      window.location.reload();
      return;
    }
    state.data = data;
    if (state.campGroupRequestedUrl && state.campGroupRequestedUrl !== sourceUrl) {
      state.campGroupRequestedUrl = "";
      state.campGroupStatus = "idle";
      state.campGroup = null;
    }
    if (identitySession()) void refreshVoteParticipation();
    applyPluginVisibility();
    document.documentElement.dataset.timezone =
      data.campConfig?.timezone || "UTC+08:00";
    const siteName = data.siteName || window.MrzhI18n.t("明日之后“愿”营地助手");
    document.title = window.MrzhI18n.t(siteName);
    setText("site-name", window.MrzhI18n.t(siteName));
    setText(
      "server-name",
      data.campConfig?.serverName || window.MrzhI18n.t("中国大陆服务器")
    );
    setText("announcement", data.publicOverview?.announcement || "");
    const listedMemberCount = data.members?.length || 0;
    const reportedMemberCount = Number(data.memberSummary?.expectedCount);
    const totalMemberCount = Number.isInteger(reportedMemberCount) && reportedMemberCount >= 0
      ? reportedMemberCount
      : listedMemberCount;
    setText("hero-member-count", String(totalMemberCount));
    setText(
      "hero-warning-count",
      String(data.inactivityWarnings?.length || 0)
    );
    setText(
      "hero-vote-count",
      String(data.voteSummary?.ballotCount || 0)
    );
    const highlightCount = Array.isArray(data.publicOverview?.highlights)
      ? data.publicOverview.highlights.length
      : 0;
    setText("feature-overview-count", String(highlightCount));
    setText("feature-staff-count", String(data.staffAssignments?.length || 0));
    setText(
      "feature-warning-count",
      String(data.inactivityWarnings?.length || 0)
    );
    setText("feature-vote-count", String(dailyVoteFeatureCount(data.dailyVote)));
    setText("feature-members-count", String(totalMemberCount));
    setText("feature-runs-count", String(data.recentRuns?.length || 0));
    renderHighlights(data.publicOverview?.highlights || []);
    renderVote(data.voteSummary || { options: [] });
    renderDailyVote(data.dailyVote || {});
    renderStaff(data.staffAssignments || []);
    renderWarnings(
      data.inactivityWarnings || [],
      data.campConfig?.inactivityWarningDays || 1
    );
    renderMembers(data.members || []);
    renderRuns(data.recentRuns || []);
    if (state.activeFeature) {
      const activeCard = document.querySelector(
        `.feature-card[data-feature-target="${state.activeFeature}"]`
      );
      if (!activeCard || activeCard.hidden) {
        byId("feature-detail-dialog")?.close();
      } else {
        syncFeatureDetailKicker();
      }
    }
  }

  async function load() {
    try {
      render(
        await request(
          `/api/public/bootstrap?t=${Date.now()}&locale=${encodeURIComponent(window.MrzhI18n.language())}`
        )
      );
    } catch (error) {
      setText(
        "announcement",
        window.MrzhI18n.format("公共数据加载失败：{message}", {
          message: error.message
        })
      );
    } finally {
      window.MrzhLoading?.settle("data");
    }
  }

  async function refreshFromLiveUpdate() {
    if (document.hidden || !state.data) {
      state.liveDirty = true;
      return;
    }
    if (state.liveRefreshInFlight) {
      state.liveRefreshQueued = true;
      return;
    }
    state.liveRefreshInFlight = true;
    state.liveDirty = false;
    try {
      await Promise.all([
        load(),
        refreshIdentitySession({ force: true })
      ]);
      await refreshVoteParticipation({ force: true });
    } finally {
      state.liveRefreshInFlight = false;
      if (state.liveRefreshQueued) {
        state.liveRefreshQueued = false;
        void refreshFromLiveUpdate();
      }
    }
  }

  function scheduleLiveReconnect() {
    if (state.liveReconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** state.liveReconnectAttempt);
    state.liveReconnectAttempt = Math.min(state.liveReconnectAttempt + 1, 5);
    state.liveReconnectTimer = window.setTimeout(() => {
      state.liveReconnectTimer = null;
      connectLiveUpdates();
    }, delay);
  }

  function connectLiveUpdates() {
    if (state.liveSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.liveSocket.readyState)) {
      return;
    }
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${scheme}//${window.location.host}/api/live?scope=public`
    );
    state.liveSocket = socket;
    socket.addEventListener("open", () => {
      if (state.liveSocket !== socket) return;
      state.liveReconnectAttempt = 0;
      socket.send(JSON.stringify({ type: "subscribe", scope: "public" }));
      void refreshFromLiveUpdate();
    });
    socket.addEventListener("message", (event) => {
      if (state.liveSocket !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        message?.type === "data-changed" &&
        Array.isArray(message.scopes) &&
        message.scopes.includes("public")
      ) {
        void refreshFromLiveUpdate();
      }
    });
    socket.addEventListener("close", () => {
      if (state.liveSocket !== socket) return;
      state.liveSocket = null;
      scheduleLiveReconnect();
    });
    socket.addEventListener("error", () => {
      if (state.liveSocket === socket) socket.close();
    });
  }

  async function submitVote() {
    const button = byId("submit-vote");
    if (state.data?.voteSummary?.isOpen === false) {
      showOperationNotice(window.MrzhI18n.t("当前不在科技投票开放时间内。"), { kicker: "TECHNOLOGY VOTE" });
      return;
    }
    if (hasTechnologyParticipation(state.data?.voteSummary)) {
      showOperationNotice(window.MrzhI18n.t("本次开放投票已参与，不能重复提交。"), { kicker: "TECHNOLOGY VOTE" });
      renderVote(state.data?.voteSummary || {});
      return;
    }
    if (!state.selections.size) {
      showOperationNotice(window.MrzhI18n.t("请至少选择一项科技。"), { kicker: "TECHNOLOGY VOTE" });
      return;
    }
    if (state.selections.size > configuredVoteLimit(state.data?.voteSummary)) {
      showOperationNotice(
        window.MrzhI18n.format("每人最多选择 {limit} 项科技。", {
          limit: configuredVoteLimit(state.data?.voteSummary)
        }),
        { kicker: "TECHNOLOGY VOTE" }
      );
      return;
    }
    if (!requireIdentitySession()) return;
    const { identityCode, password } = identitySession();
    button.disabled = true;
    const progressToken = showOperationProgress("TECHNOLOGY VOTE");
    try {
      const summary = await request("/api/public/tech-vote", {
        method: "POST",
        body: JSON.stringify({
          identityCode,
          identityPassword: password,
          locale: window.MrzhI18n.language(),
          selections: [...state.selections]
        })
      });
      state.selections.clear();
      const revision = (state.voteParticipation.revision || 0) + 1;
      state.voteParticipation = {
        ...state.voteParticipation,
        revision,
        identityCode,
        scopeKey: currentParticipationScopeKey(),
        technologyPollDate: summary.pollDate || "",
        technologyParticipated: true
      };
      if (state.data) state.data.voteSummary = summary;
      renderVote(summary);
      showVoteSuccessDialog({
        kind: "technology",
        data: summary,
        message: summary.renewalGraceUsed
              ? window.MrzhI18n.t("投票已提交；本次已使用延期审批期间唯一一次过期投票机会。")
              : window.MrzhI18n.t("投票已提交，截止前不可修改或撤回。")
      });
    } catch (error) {
      if (error.code === "vote_already_participated") {
        const revision = (state.voteParticipation.revision || 0) + 1;
        state.voteParticipation = {
          ...state.voteParticipation,
          revision,
          identityCode,
          technologyPollDate: state.data?.voteSummary?.pollDate || "",
          technologyParticipated: true
        };
        renderVote(state.data?.voteSummary || {});
        showOperationNotice(window.MrzhI18n.t("本次开放投票已参与，不能重复提交。"), { kicker: "TECHNOLOGY VOTE" });
        return;
      }
      const message =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : error.code === "vote_eligibility_failed"
            ? window.MrzhI18n.t("您尚未满足投票资格贡献与活跃度标准。")
          : error.code === "vote_permission_disabled"
            ? window.MrzhI18n.t("该身份识别码已被管理员禁止投票。")
          : window.MrzhI18n.t(error.message);
      showVoteError(
        message,
        window.MrzhI18n.t("投票未提交"),
        error.code === "identity_code_expired" && error.canRenew,
        identityCode
      );
      if (IDENTITY_SESSION_INVALID_CODES.has(error.code)) {
        clearIdentitySession({ openPanel: true });
      }
    } finally {
      renderVote(state.data?.voteSummary || {});
      hideOperationProgress(progressToken);
    }
  }

  function showVoteError(
    message,
    title = window.MrzhI18n.t("投票未提交"),
    canRenew = false,
    identityCode = ""
  ) {
    setText("vote-error-title", title);
    setText("vote-error-message", message);
    state.voteErrorRenewalCode = canRenew ? identityCode : "";
    byId("vote-error-renew").hidden = !canRenew;
    const dialog = byId("vote-error-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function showIdentityApplicationError(message) {
    setText("identity-application-error-message", window.MrzhI18n.t(message));
    const dialog = byId("identity-application-error-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function showIdentityApplicationSuccess(message, notice) {
    setText("identity-application-success-title", window.MrzhI18n.t("申请已提交"));
    setText("identity-application-success-message", message);
    setText(
      "identity-application-success-notice",
      notice || window.MrzhI18n.t(
        "申请已成功提交，预计于48小时内完成审核，请留意邮箱的审核结果邮件。"
      )
    );
    const applicationDialog = byId("identity-application-dialog");
    if (applicationDialog?.open) applicationDialog.close();
    const dialog = byId("identity-application-success-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function openIdentityEligibilityApplication() {
    const session = identitySession();
    const eligibility = session?.voteEligibility;
    if (
      !session ||
      eligibility?.prohibited ||
      eligibility?.bypassed ||
      eligibility?.eligible ||
      eligibility?.enabled === false
    ) return;
    byId("identity-eligibility-application-reason").value = "";
    byId("identity-eligibility-application-dialog").showModal();
  }

  async function submitIdentityEligibilityApplication(event) {
    event.preventDefault();
    const session = identitySession();
    if (!session) return;
    if (
      session.voteEligibility?.prohibited ||
      session.voteEligibility?.bypassed ||
      session.voteEligibility?.eligible
    ) return;
    const reason = byId("identity-eligibility-application-reason").value.trim();
    if (!reason) {
      showOperationNotice(window.MrzhI18n.t("请填写申请理由"), { kicker: "VOTE ELIGIBILITY" });
      return;
    }
    const button = byId("identity-eligibility-application-submit");
    button.disabled = true;
    const progressToken = showOperationProgress("VOTE ELIGIBILITY");
    try {
      await request("/api/public/vote-eligibility-applications", {
        method: "POST",
        body: JSON.stringify({
          identityCode: session.identityCode,
          identityPassword: session.password,
          locale: window.MrzhI18n.language(),
          reason
        })
      });
      byId("identity-eligibility-application-dialog").close();
      showIdentityApplicationSuccess(
        window.MrzhI18n.t("申请已提交，管理员将在48小时内完成审核。"),
        window.MrzhI18n.t("请留意邮箱的审核结果邮件。")
      );
    } catch (error) {
      showOperationNotice(window.MrzhI18n.t(error.message), { kicker: "VOTE ELIGIBILITY" });
    } finally {
      button.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  function openNewApplication() {
    state.identityMode = "new";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    state.identityApplicationVerificationId = "";
    state.identityApplicationVerificationToken = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = false;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("接收识别码邮箱"));
    setText("submit-identity-application", window.MrzhI18n.t("提交申请"));
    byId("identity-application-verification-field").hidden = true;
    byId("identity-application-verification-code").value = "";
    byId("identity-application-dialog").showModal();
  }

  function showRenewalConfirmation(
    preview,
    { identityCode = "", applicationNumber = "" } = {}
  ) {
    state.identityMode = "renewal";
    state.renewalCode = identityCode;
    state.renewalApplicationNumber =
      preview.applicationNumber || applicationNumber;
    setText("identity-dialog-title", window.MrzhI18n.t("申请延长识别码有效期"));
    setText(
      "identity-renewal-number",
      window.MrzhI18n.format("申请编号：{number}", {
        number: preview.applicationNumber
      })
    );
    byId("identity-renewal-number").hidden = false;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = false;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("接收识别码邮箱"));
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    setText("submit-identity-application", window.MrzhI18n.t("提交延期申请"));
    byId("identity-email").value = preview.email;
    byId("identity-player-name").value = preview.playerName;
    const dialog = byId("identity-application-dialog");
    if (!dialog.open) dialog.showModal();
  }

  async function openRenewal(identityCode, applicationNumber = "") {
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      const preview = await request("/api/public/identity-code-renewal-preview", {
        method: "POST",
        body: JSON.stringify({ identityCode, applicationNumber })
      });
      showRenewalConfirmation(preview, { identityCode, applicationNumber });
    } catch (error) {
      showOperationNotice(
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message),
        { kicker: "IDENTITY CODE" }
      );
    } finally {
      hideOperationProgress(progressToken);
    }
  }

  function openRenewalLookup(identityCode = "") {
    state.identityMode = "renewal-lookup";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请延长识别码有效期"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = false;
    byId("identity-renewal-code-field").hidden = false;
    byId("identity-email-field").hidden = true;
    byId("identity-player-name-field").hidden = true;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = false;
    byId("identity-renewal-application-number").value = "";
    byId("identity-renewal-code").value = identityCode;
    setText("submit-identity-application", window.MrzhI18n.t("下一步：核对信息"));
    byId("identity-application-dialog").showModal();
  }

  function openIdentityRecovery() {
    state.identityMode = "recovery";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("找回身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = false;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = false;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText(
      "identity-email-label",
      window.MrzhI18n.t("申请时预留的邮箱")
    );
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    byId("identity-recovery-number").value = "";
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    setText("submit-identity-application", window.MrzhI18n.t("发送识别码到预留邮箱"));
    byId("identity-application-dialog").showModal();
  }

  async function submitIdentityApplication(event) {
    event.preventDefault();
    const button = byId("submit-identity-application");
    const renewalLookup = state.identityMode === "renewal-lookup";
    const renewalLookupApplicationNumber =
      byId("identity-renewal-application-number").value.trim();
    const renewalLookupCode = byId("identity-renewal-code").value.trim();
    if (
      renewalLookup &&
      !renewalLookupApplicationNumber &&
      !renewalLookupCode
    ) {
      showOperationNotice(window.MrzhI18n.t("请填写申请编号或身份识别码"), { kicker: "IDENTITY CODE" });
      return;
    }
    const email = byId("identity-email").value.trim();
    const playerName = byId("identity-player-name").value.trim();
    if (state.identityMode === "new" && !state.identityApplicationVerificationId) {
      if (!email || !playerName) {
        showOperationNotice(window.MrzhI18n.t("请填写邮箱和玩家名称。"), { kicker: "IDENTITY CODE" });
        return;
      }
      button.disabled = true;
      const progressToken = showOperationProgress("IDENTITY CODE");
      try {
        const challenge = await request("/api/public/identity-application-verification", {
          method: "POST",
          body: JSON.stringify({ action: "request", purpose: "new", email, playerName, locale: window.MrzhI18n.language() })
        });
        state.identityApplicationVerificationId = challenge.challengeId;
        byId("identity-application-verification-field").hidden = false;
        setText("submit-identity-application", window.MrzhI18n.t("验证邮箱并提交申请"));
        showOperationNotice(window.MrzhI18n.t("验证码已发送到邮箱，请填写后再次提交。"), { kicker: "IDENTITY CODE" });
      } catch (error) {
        showIdentityApplicationError(window.MrzhI18n.t(error.message));
      } finally {
        button.disabled = false;
        hideOperationProgress(progressToken);
      }
      return;
    }
    button.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    try {
      if (state.identityMode === "new" &&
          state.identityApplicationVerificationId && !state.identityApplicationVerificationToken) {
        const verified = await request("/api/public/identity-application-verification", {
          method: "POST",
          body: JSON.stringify({
            action: "verify",
            purpose: state.identityMode,
            challengeId: state.identityApplicationVerificationId,
            otp: byId("identity-application-verification-code").value.trim()
          })
        });
        state.identityApplicationVerificationToken = verified.verificationToken;
      }
      if (renewalLookup) {
        const preview = await request(
          "/api/public/identity-code-renewal-preview",
          {
            method: "POST",
            body: JSON.stringify({
              identityCode: renewalLookupCode,
              applicationNumber: renewalLookupApplicationNumber
            })
          }
        );
        showRenewalConfirmation(preview, {
          identityCode: renewalLookupCode,
          applicationNumber: renewalLookupApplicationNumber
        });
        return;
      }
      const common = {
        email: byId("identity-email").value.trim(),
        playerName: byId("identity-player-name").value.trim(),
        locale: window.MrzhI18n.language()
      };
      const result =
        state.identityMode === "renewal"
          ? await request("/api/public/identity-code-renewal", {
              method: "POST",
              body: JSON.stringify({
                ...common,
                identityCode: state.renewalCode,
                applicationNumber: state.renewalApplicationNumber
              })
            })
          : state.identityMode === "recovery"
            ? await request("/api/public/identity-code-recovery", {
                method: "POST",
                body: JSON.stringify({
                  ...common,
                  applicationNumber: byId("identity-recovery-number").value.trim()
                })
              })
            : await request("/api/public/identity-code-applications", {
                method: "POST",
                body: JSON.stringify({
                  ...common,
                  verificationId: state.identityApplicationVerificationId,
                  verificationToken: state.identityApplicationVerificationToken
                })
              });
      if (state.identityMode === "recovery") {
        showOperationNotice(window.MrzhI18n.t(
          result.expired
            ? "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。"
            : "识别码已发送至预留邮箱。"
        ), { kicker: "IDENTITY CODE" });
      } else {
        const applicationMessage = window.MrzhI18n.format(
          state.identityMode === "renewal"
            ? "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。"
            : "申请已提交，申请编号：{number}。",
          { number: result.applicationNumber }
        );
        showIdentityApplicationSuccess(applicationMessage);
      }
    } catch (error) {
      const message =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message);
      if (
        error.message === ACTIVE_IDENTITY_CONFLICT ||
        error.message === EXPIRED_IDENTITY_CONFLICT
      ) {
        showIdentityApplicationError(error.message);
      } else {
        showOperationNotice(message, { kicker: "IDENTITY CODE" });
      }
    } finally {
      button.disabled = false;
      hideOperationProgress(progressToken);
    }
  }

  byId("submit-vote").addEventListener("click", submitVote);
  byId("operation-progress-dialog").addEventListener("cancel", event => {
    event.preventDefault();
  });
  state.identitySession = loadIdentitySession();
  renderIdentityAccount();
  for (const panel of document.querySelectorAll("[data-daily-panel]")) {
    panel.addEventListener("click", () => openDailyPanel(panel.dataset.dailyPanel));
  }
  byId("identity-login-form").addEventListener("submit", loginIdentity);
  byId("identity-forgot-password").addEventListener("click", beginIdentityPasswordReset);
  byId("identity-password-reset-form").addEventListener("submit", requestPasswordReset);
  byId("identity-password-verify-form").addEventListener("submit", verifyPasswordReset);
  byId("identity-password-set-form").addEventListener("submit", setPasswordReset);
  byId("close-identity-password-reset").addEventListener("click", () => {
    byId("identity-password-reset-dialog").close();
  });
  byId("identity-apply").addEventListener("click", openNewApplication);
  byId("identity-recover").addEventListener("click", openIdentityRecovery);
  byId("identity-cancel").addEventListener("click", openIdentityCancellationDialog);
  byId("identity-cancel-logged-in").addEventListener("click", openIdentityCancellationDialog);
  byId("identity-cancellation-form").addEventListener("submit", submitIdentityCancellation);
  byId("close-identity-cancellation-dialog").addEventListener("click", () => {
    byId("identity-cancellation-dialog").close();
  });
  byId("identity-renew").addEventListener("click", () => openRenewalLookup(identitySession()?.identityCode || ""));
  byId("identity-update-name").addEventListener("click", () => openIdentityProfileDialog("name"));
  byId("identity-change-email").addEventListener("click", () => openIdentityProfileDialog("email"));
  byId("identity-renew-logged-in").addEventListener("click", () => openRenewalLookup(identitySession()?.identityCode || ""));
  byId("identity-profile-form").addEventListener("submit", submitIdentityProfile);
  byId("close-identity-profile-dialog").addEventListener("click", () => byId("identity-profile-dialog").close());
  byId("identity-eligibility-info")?.addEventListener("click", openIdentityEligibilityDialog);
  byId("identity-eligibility-apply")?.addEventListener("click", openIdentityEligibilityApplication);
  byId("identity-eligibility-application-form")?.addEventListener("submit", submitIdentityEligibilityApplication);
  byId("identity-eligibility-application-close")?.addEventListener("click", () => {
    byId("identity-eligibility-application-dialog").close();
  });
  byId("open-chat").addEventListener("click", () => chatNavigation.open());
  byId("identity-avatar-edit").addEventListener("click", () => window.MrzhAvatar.open(async (file) => {
    const form = new FormData(); form.append("file",file,"avatar.webp");
    const response = await fetch("/api/public/identity-avatar",{method:"POST",body:form});
    const payload = await response.json(); if(!response.ok) throw new Error(payload.error);
    if(identitySession()) persistIdentitySession({...identitySession(),avatarUrl:payload.avatarUrl});
  }));
  if (new URLSearchParams(window.location.search).has("identityLoginRequired")) {
    history.replaceState(null,"","/#identity");
    setTimeout(()=>showOperationNotice(window.MrzhI18n.t("请先登录身份识别码后进入互动中心。"),{kicker:"IDENTITY CODE"}),100);
  }
  let passwordChangeProof = "", passwordChangeRevision = 0;
  const passwordChangeDialog = byId("identity-password-change-dialog");
  function focusPasswordChangeStep(fieldId) {
    // Focusing the close button keeps the mobile keyboard closed until a tap.
    // The dialog's autofocus target also prevents native showModal input focus.
    const mobile = window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
    byId(mobile ? "identity-password-change-close" : fieldId).focus({ preventScroll: true });
  }
  function resetPasswordChange() {
    passwordChangeRevision += 1;
    passwordChangeProof = "";
    byId("identity-password-change-verify").reset();
    byId("identity-password-change-set").reset();
    byId("identity-password-change-verify").hidden = false;
    byId("identity-password-change-set").hidden = true;
  }
  byId("identity-change-password").addEventListener("click", () => {
    if (!requireIdentitySession()) return;
    resetPasswordChange(); passwordChangeDialog.showModal();
    focusPasswordChangeStep("identity-password-change-old");
  });
  byId("identity-password-change-close").addEventListener("click",()=>passwordChangeDialog.close());
  passwordChangeDialog.addEventListener("close",resetPasswordChange);
  byId("identity-password-change-verify").addEventListener("submit", async (event) => {
    event.preventDefault();
    const currentPassword = byId("identity-password-change-old").value;
    if (!currentPassword) {
      showOperationNotice(window.MrzhI18n.t("请输入当前密码。"), { kicker: "IDENTITY CODE" });
      return;
    }
    const submit = event.currentTarget.querySelector('[type="submit"]');
    const revision = ++passwordChangeRevision;
    submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    let message = "";
    let verified = false;
    try {
      const result = await request("/api/public/identity-password-change", {
        method: "POST", body: JSON.stringify({ action: "verify", oldPassword: currentPassword })
      });
      if (revision !== passwordChangeRevision || !passwordChangeDialog.open) return;
      passwordChangeProof = result.verificationToken;
      byId("identity-password-change-old").value = "";
      byId("identity-password-change-verify").hidden = true;
      byId("identity-password-change-set").hidden = false;
      verified = true;
      message = "验证通过，请设置新密码。";
    } catch (error) {
      if (revision === passwordChangeRevision) message = error.message;
    } finally {
      submit.disabled = false;
      hideOperationProgress(progressToken);
    }
    if (verified) {
      focusPasswordChangeStep("identity-password-change-new");
    }
    if (message) showOperationNotice(window.MrzhI18n.t(message), { kicker: "IDENTITY CODE" });
  });
  byId("identity-password-change-set").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = byId("identity-password-change-new").value;
    if (password.length < 6 || password.length > 32) {
      showOperationNotice(window.MrzhI18n.t("密码必须为6至32位"), { kicker: "IDENTITY CODE" });
      return;
    }
    if (password !== byId("identity-password-change-confirm").value) {
      showOperationNotice(window.MrzhI18n.t("两次输入的新密码不一致。"), { kicker: "IDENTITY CODE" });
      return;
    }
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    const progressToken = showOperationProgress("IDENTITY CODE");
    let message = "";
    try {
      await request("/api/public/identity-password-change", {
        method: "POST", body: JSON.stringify({ action: "set", verificationToken: passwordChangeProof, newPassword: password })
      });
      passwordChangeDialog.close();
      clearIdentitySession();
      message = "密码修改成功，请重新登录。";
    } catch (error) {
      message = error.message;
    } finally {
      submit.disabled = false;
      hideOperationProgress(progressToken);
    }
    if (message) showOperationNotice(window.MrzhI18n.t(message), { kicker: "IDENTITY CODE" });
  });
  byId("identity-logout").addEventListener("click", async () => {
    await request("/api/public/identity-session",{method:"DELETE"}).catch(()=>{});
    clearIdentitySession();
    showOperationNotice(window.MrzhI18n.t("已退出身份识别码账号。"), { kicker: "IDENTITY CODE" });
  });
  byId("vote-error-renew").addEventListener("click", () => {
    const identityCode = state.voteErrorRenewalCode;
    byId("vote-error-dialog").close();
    if (identityCode) openRenewal(identityCode);
  });
  byId("vote-participants-close").addEventListener("click", () => {
    byId("vote-participants-dialog").close();
  });
  byId("vote-participants-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  byId("image-preview-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  byId("image-preview-dialog").addEventListener("close", () => {
    byId("image-preview").removeAttribute("src");
  });
  byId("identity-application-form").addEventListener(
    "submit",
    submitIdentityApplication
  );
  byId("close-identity-dialog").addEventListener("click", () => {
    byId("identity-application-dialog").close();
  });
  initFeatureNavigation();
  const chatNavigation = window.MrzhChatNavigation.create({
    async validateSession() {
      try {
        const account = await request("/api/public/identity-session");
        persistIdentitySession(account);
        return account;
      } catch (error) {
        if (isIdentitySessionInvalidError(error)) return null;
        throw error;
      }
    },
    beforeOpen() {
      byId("feature-detail-dialog").close();
      window.MrzhDialogViewport?.sync();
    },
    onIdentityRequired() {
      clearIdentitySession();
      showFeature("identity");
      showOperationNotice(window.MrzhI18n.t("请先登录身份识别码后进入互动中心。"), { kicker: "IDENTITY CODE" });
    },
    onError(error) { showOperationNotice(window.MrzhI18n.t(error.message)); },
    translate: value => window.MrzhI18n.t(value)
  });
  byId("retry-camp-group")?.addEventListener("click", () => void loadCampGroup());
  document.addEventListener("mrzh:languagechange", () => {
    renderCampGroup();
    if (state.data) render(state.data);
    syncFeatureDetailKicker();
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      connectLiveUpdates();
      void refreshFromLiveUpdate();
    }
  });
  const initialData = load();
  void initialData.then(() => loadCampGroup()).finally(() => window.MrzhLoading?.settle("group"));
  connectLiveUpdates();
  void Promise.all([initialData, refreshIdentitySession({ force: true })])
    .then(() => refreshVoteParticipation())
    .finally(() => window.MrzhLoading?.settle("identity"));
})();
