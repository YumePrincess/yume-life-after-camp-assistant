import {
  canViewAdminModule,
  deleteRevokedTemporaryKey,
  getAuthenticatedSession,
  handleOidcSilentStart,
  handleTemporaryKeyLogin,
  handleLogout,
  handleOidcCallback,
  handleOidcStart,
  hasPermission,
  issueTemporaryKey,
  isDemoSession,
  listTemporaryKeys,
  maybeValidateOidcSession,
  requireAdmin,
  revokeTemporaryKey,
  sessionPermissions,
  timingSafeEqual,
  updateTemporaryKeyPermissions
} from "./auth";
import {
  activateAgentIdentity,
  appendRunEvent,
  claimNextCommand,
  clearFinishedRunHistory,
  clearPublicRateLimits,
  completeCommand,
  createCommand,
  deleteAgentHeartbeat,
  expireUnclaimedRuns,
  findActiveRunForAgent,
  getConfigBundle,
  getHeartbeat,
  getRun,
  getTechnologyVoteHistory,
  listActivityWarnings,
  listHeartbeats,
  listMembers,
  listRecordedTechnologyVoteHistoryDates,
  listRecentRuns,
  listRunEvents,
  listStaff,
  listTechnologyVoteHistory,
  listVotePollDates,
  replaceMemberSnapshot,
  replaceStaffSnapshot,
  removeCurrentMembers,
  registerAgentDevice,
  reconcileTerminalRunCommands,
  updateActivitySnapshot,
  updateContributionSnapshot,
  updateMemberProfiles,
  requestRunCancellation,
  saveBallot,
  saveConfigBundle,
  deleteTechnologyVoteHistory,
  touchHeartbeat,
  updateRun,
  type SessionRow
} from "./db";
import { normalizeBallotSelections } from "./tech";
import {
  isTaskKey,
  type ConfigBundle,
  type RunState,
  type TaskKey,
  type TechnologyVoteHistory
} from "./domain";
import {
  fetchAsset,
  json,
  methodNotAllowed,
  problem,
  publicCors,
  withSecurityHeaders
} from "./response";
import { runScheduler } from "./scheduler";
import {
  archiveTechnologyVoteHistoryAtDailyReset,
  buildVoteSummary,
  enqueueTask,
  snapshotTechnologyVoteHistory
} from "./tasks";
import {
  nextTechnologyTargetDate,
  weekdayForDateKey,
  zonedDateTimeToIso,
  zonedDateKey,
  zonedParts
} from "./time";
import {
  preserveAutomationScheduleTimes,
  validateConfigBundle
} from "./validate";
import { localizeTechnology } from "./technology-localizations";
import {
  approveIdentityApplication,
  createIdentityApplication,
  createManualIdentityCode,
  listIdentityApplications,
  listIdentityCodes,
  listVoteBallotDetails,
  reissueIdentityCode,
  reissuePreview,
  recoverIdentityCode,
  rejectIdentityApplication,
  renewalPreview,
  resendIdentityCode,
  submitReissue,
  submitRenewal,
  updateIdentityCode,
  updateIdentityCodeInformation,
  verifyIdentityCode
} from "./identity";
import {
  demoSmtpConfig,
  getSmtpConfig,
  publicSmtpConfig,
  sendMail,
  updateSmtpConfig
} from "./mailer";
import { normalizeLocale } from "./locale";
import { localizeWorkerEvent, localizeWorkerRun } from "./task-localization";
import {
  clearRateLimitAttempts,
  clearValueRateLimitAttempts,
  checkRateLimit,
  checkValueRateLimit,
  recordRateLimitAttempt,
  recordValueRateLimitAttempt,
  type RateLimitPolicy
} from "./rate-limit";
import {
  builtPluginForTask,
  dispatchWorkerPluginRequest,
  enabledPermissionCatalog,
  enabledPluginForTask,
  effectiveWorkerPlugins,
  isWorkerPluginEnabled,
  setWorkerPluginEnabled
} from "./plugin-system";

const TERMINAL_RUN_STATES = new Set<RunState>([
  "interrupted",
  "succeeded",
  "partially_succeeded",
  "failed",
  "timed_out",
  "skipped"
]);

const IDENTITY_CHECK_LIMIT: RateLimitPolicy = {
  scope: "identity-check",
  maximum: 20,
  windowSeconds: 15 * 60,
  blockSeconds: 15 * 60
};

const IDENTITY_APPLICATION_LIMIT: RateLimitPolicy = {
  scope: "identity-application",
  maximum: 10,
  windowSeconds: 30 * 60,
  blockSeconds: 30 * 60
};

const IDENTITY_VALUE_CHECK_LIMIT: RateLimitPolicy = {
  scope: "identity-code-value",
  maximum: 12,
  windowSeconds: 30 * 60,
  blockSeconds: 30 * 60
};

const PUBLIC_TEST_VOTE_LIMIT: RateLimitPolicy = {
  scope: "public-test-vote",
  maximum: 5,
  windowSeconds: 10 * 60,
  blockSeconds: 30 * 60
};

const IDENTITY_RECOVERY_LIMIT: RateLimitPolicy = {
  scope: "identity-recovery",
  maximum: 10,
  windowSeconds: 30 * 60,
  blockSeconds: 30 * 60
};

const IDENTITY_RECOVERY_TARGET_LIMIT: RateLimitPolicy = {
  scope: "identity-recovery-target",
  maximum: 6,
  windowSeconds: 30 * 60,
  blockSeconds: 60 * 60
};

function identityLookupFingerprint(
  input: Record<string, unknown>
): string {
  return (Object.entries(input)
    .map(
      ([key, value]): [string, string] => [
        key,
        String(value ?? "").normalize("NFKC").trim().toLowerCase()
      ]
    )
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort((left, right) => left[0].localeCompare(right[0])))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await routeRequest(request, env);
      return withSecurityHeaders(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: "unhandled_request_error",
          requestId: request.headers.get("cf-ray"),
          path: new URL(request.url).pathname,
          message
        })
      );
      return withSecurityHeaders(problem("Internal server error", 500, "internal_error"));
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const now = new Date(controller.scheduledTime);
    const result = await runScheduler(env, now);
    console.log(JSON.stringify({ event: "scheduler_tick", ...result }));
  }
} satisfies ExportedHandler<Env>;

export default handler;

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS" && path.startsWith("/api/public/")) {
    return new Response(null, { status: 204, headers: publicCors(request) });
  }

  if (path === "/auth/oidc/start") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return handleOidcStart(request, env);
  }
  if (path === "/auth/oidc/silent") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return handleOidcSilentStart(request, env);
  }
  if (path === "/auth/oidc/callback") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return handleOidcCallback(request, env);
  }
  if (path === "/auth/logout") {
    if (method !== "POST" && method !== "GET") return methodNotAllowed(["POST", "GET"]);
    return handleLogout(request, env);
  }
  if (path === "/auth/key") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleTemporaryKeyLogin(request, env);
  }
  if (path === "/api/auth/config" && method === "GET") {
    const bundle = await getConfigBundle(env);
    return json({
      oidcEnabled: true,
      oidcProviderName: "Yume Account",
      oidcAutoLogin: !/^(0|false|no|off)$/i.test(env.OIDC_AUTO_LOGIN || ""),
      temporaryKeyLoginEnabled: bundle.authConfig.temporaryKeyLoginEnabled
    });
  }
  if (path === "/api/auth/session" && method === "GET") {
    const session = await getAuthenticatedSession(request, env);
    return json({
      authenticated: Boolean(session),
      session: session
        ? {
            displayName: session.display_name,
            authMethod: session.auth_method,
            permissions: sessionPermissions(session),
            expiresAt: session.expires_at
          }
        : null
    });
  }
  if (path === "/login") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const session = await getAuthenticatedSession(request, env);
    if (session) return Response.redirect(new URL("/admin", request.url), 302);
    return fetchAsset(env, request, "/login.html");
  }
  if (path === "/admin") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const validation = await maybeValidateOidcSession(request, env);
    if (validation) return validation;
    const auth = await requireAdmin(request, env);
    if ("response" in auth) return auth.response;
    return fetchAsset(env, request, "/admin.html");
  }
  if (path.startsWith("/api/public/")) {
    return handlePublicApi(request, env, path, method);
  }
  if (path.startsWith("/api/agent/")) {
    const agentAuth = await requireAgentAuth(request, env);
    if (agentAuth) return agentAuth;
    return handleAgentApi(request, env, path, method);
  }
  if (path.startsWith("/api/admin/")) {
    const permission = permissionForAdminRequest(path, method);
    const auth = await requireAdmin(request, env, {
      api: true,
      mutation: !["GET", "HEAD"].includes(method),
      ...(permission ? { permission } : {})
    });
    if ("response" in auth) return auth.response;
    return handleAdminApi(request, env, path, method, auth.session);
  }
  if (path === "/") {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
    return fetchAsset(env, request, "/index.html");
  }

  const asset = await env.ASSETS.fetch(request);
  return asset.status === 404 ? problem("Not found", 404, "not_found") : asset;
}

async function handlePublicApi(
  request: Request,
  env: Env,
  path: string,
  method: string
): Promise<Response> {
  const cors = publicCors(request);
  const pluginResponse = await dispatchWorkerPluginRequest({
    request, env, path, method, scope: "public"
  });
  if (pluginResponse) return pluginResponse;
  if (
    path === "/api/public/tech-vote" &&
    !(await isWorkerPluginEnabled(env, "technology"))
  ) {
    return problem("科技插件当前未启用", 404, "plugin_disabled");
  }
  if (path === "/api/public/bootstrap" && method === "GET") {
    const payload = await buildPublicBootstrap(
      env,
      new URL(request.url).searchParams.get("locale")
    );
    return json(payload, 200, cors);
  }
  if (path === "/api/public/tech-vote" && method === "GET") {
    const bundle = await getConfigBundle(env);
    return json(
      localizeVoteSummary(
        await buildVoteSummary(env, bundle),
        new URL(request.url).searchParams.get("locale")
      ),
      200,
      cors
    );
  }
  if (path === "/api/public/tech-vote" && method === "POST") {
    const limited = await rejectIfRateLimited(request, env, IDENTITY_CHECK_LIMIT, cors);
    if (limited) return limited;
    const body = await readJsonObject(request, 32_000);
    const publicTestVote = String(body.identityCode ?? "").trim() === "00000000";
    let identityRecord: Awaited<ReturnType<typeof verifyIdentityCode>> | null = null;
    if (publicTestVote) {
      const testLimited = await rejectIfRateLimited(
        request,
        env,
        PUBLIC_TEST_VOTE_LIMIT,
        cors
      );
      if (testLimited) return testLimited;
      await recordRateLimitAttempt(request, env, PUBLIC_TEST_VOTE_LIMIT);
    } else {
      const valueLimited = await rejectIfValueRateLimited(
        body.identityCode,
        env,
        IDENTITY_VALUE_CHECK_LIMIT,
        cors
      );
      if (valueLimited) return valueLimited;
      const verification = await verifyIdentityCode(env, body.identityCode);
      identityRecord = verification;
      if (!verification.ok) {
        if (verification.reason === "invalid") {
          await Promise.all([
            recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT),
            recordValueRateLimitAttempt(
              body.identityCode,
              env,
              IDENTITY_VALUE_CHECK_LIMIT
            )
          ]);
        }
        const detail =
          verification.reason === "expired"
            ? "身份识别码已过期"
            : verification.reason === "disabled"
              ? "身份识别码已被禁用"
              : "身份识别码无效";
        return json(
          {
            title: detail,
            code: `identity_code_${verification.reason}`,
            canRenew: verification.canRenew,
            applicationNumber: verification.applicationNumber ?? null
          },
          verification.reason === "expired" ? 409 : 403,
          cors
        );
      }
    }
    if (!Array.isArray(body.selections)) {
      return problem("selections must be an array", 400);
    }
    const bundle = await getConfigBundle(env);
    const summary = await buildVoteSummary(env, bundle);
    if (!summary.isOpen) {
      return problem(
        `科技投票开放时间为 ${summary.opensAt}–${summary.closesAt} ${summary.timezone}`,
        409,
        "vote_closed"
      );
    }
    const allowed = new Set(summary.options.map((option) => option.key));
    const rawSelections = [...new Set(body.selections.map((value) => String(value)))];
    const requestedSelections = rawSelections.filter((value) => allowed.has(value));
    const fixed = new Set(
      bundle.technologyConfig.fixedByDate[summary.pollDate] ??
        bundle.technologyConfig.fixedByWeekday[
          String(weekdayForDateKey(summary.pollDate))
        ] ??
        []
    );
    const normalized = normalizeBallotSelections({
      selections: requestedSelections,
      catalog: bundle.technologyConfig.catalog,
      allowedKeys: allowed,
      satisfiedKeys: fixed,
      maximum: bundle.technologyConfig.voteLimit
    });
    const isWithdrawal = rawSelections.length === 0;
    if (
      (!isWithdrawal && !normalized.selections.length) ||
      (!isWithdrawal && normalized.error)
    ) {
      return problem(
        normalized.error ??
          `每人请选择 1 至 ${bundle.technologyConfig.voteLimit} 项开放投票的科技`,
        400,
        "invalid_selections"
      );
    }
    const selections = isWithdrawal ? [] : normalized.selections;
    if (selections.length > bundle.technologyConfig.voteLimit) {
      return problem(
        `每人请选择 1 至 ${bundle.technologyConfig.voteLimit} 项开放投票的科技`,
        400,
        "invalid_selections"
      );
    }
    let renewalGraceUsed = false;
    if (!publicTestVote && identityRecord?.ok) {
      const consumed = identityRecord.grace
        ? await verifyIdentityCode(env, body.identityCode, {
            consumeRenewalGrace: true
          })
        : identityRecord;
      if (!consumed.ok) {
        return json(
          {
            title: "延期审批期间的一次过期投票机会已使用",
            code: "identity_code_expired_grace_used",
            canRenew: false
          },
          409,
          cors
        );
      }
      renewalGraceUsed = identityRecord.grace;
      await saveBallot(env, {
        pollDate: summary.pollDate,
        voterId: identityRecord.code.id,
        voterName: identityRecord.code.player_name ?? "",
        selections
      });
    }
    return json(
      {
        ...localizeVoteSummary(await buildVoteSummary(env, bundle), body.locale),
        renewalGraceUsed,
        identityCodeExpiresAt:
          !publicTestVote && identityRecord?.ok
            ? identityRecord.code.expires_at
            : null,
        voteWithdrawn: isWithdrawal,
        publicTestVote
      },
      200,
      cors
    );
  }
  if (path === "/api/public/identity-code-applications" && method === "POST") {
    const limited = await rejectIfRateLimited(
      request,
      env,
      IDENTITY_APPLICATION_LIMIT,
      cors
    );
    if (limited) return limited;
    try {
      const body = await readJsonObject(request, 16_000);
      const result = await createIdentityApplication(env, {
          email: body.email,
          playerName: body.playerName,
          locale: body.locale
        });
      await clearRateLimitAttempts(request, env, IDENTITY_APPLICATION_LIMIT);
      return json(result, 201, cors);
    } catch (error) {
      await recordRateLimitAttempt(request, env, IDENTITY_APPLICATION_LIMIT);
      return problem(errorMessage(error), 400, "identity_application_invalid");
    }
  }
  if (path === "/api/public/identity-code-recovery" && method === "POST") {
    const limited = await rejectIfRateLimited(
      request,
      env,
      IDENTITY_RECOVERY_LIMIT,
      cors
    );
    if (limited) return limited;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, 16_000);
    } catch (error) {
      await recordRateLimitAttempt(request, env, IDENTITY_RECOVERY_LIMIT);
      return json(
        { error: errorMessage(error), code: "identity_recovery_invalid" },
        400,
        cors
      );
    }
    const targetKey = identityLookupFingerprint({
      applicationNumber: body.applicationNumber,
      email: body.email,
      playerName: body.playerName
    });
    const targetLimited = await rejectIfValueRateLimited(
      targetKey,
      env,
      IDENTITY_RECOVERY_TARGET_LIMIT,
      cors
    );
    if (targetLimited) return targetLimited;
    try {
      const result = await recoverIdentityCode(env, {
          email: body.email,
          playerName: body.playerName,
          applicationNumber: body.applicationNumber
        });
      await Promise.all([
        clearRateLimitAttempts(request, env, IDENTITY_RECOVERY_LIMIT),
        clearValueRateLimitAttempts(
          targetKey,
          env,
          IDENTITY_RECOVERY_TARGET_LIMIT
        )
      ]);
      return json(result, 200, cors);
    } catch (error) {
      await Promise.all([
        recordRateLimitAttempt(request, env, IDENTITY_RECOVERY_LIMIT),
        recordValueRateLimitAttempt(
          targetKey,
          env,
          IDENTITY_RECOVERY_TARGET_LIMIT
        )
      ]);
      return json(
        { error: errorMessage(error), code: "identity_recovery_failed" },
        400,
        cors
      );
    }
  }
  if (path === "/api/public/identity-code-renewal-preview" && method === "POST") {
    const limited = await rejectIfRateLimited(request, env, IDENTITY_CHECK_LIMIT, cors);
    if (limited) return limited;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, 8_000);
    } catch (error) {
      await recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT);
      return problem(errorMessage(error), 400, "identity_renewal_unavailable");
    }
    const renewalLookupValue = [
      body.identityCode,
      body.applicationNumber
    ].map((value) => String(value ?? "").trim()).join("|");
    const valueLimited = await rejectIfValueRateLimited(
      renewalLookupValue,
      env,
      IDENTITY_VALUE_CHECK_LIMIT,
      cors
    );
    if (valueLimited) return valueLimited;
    try {
      const result = await renewalPreview(env, {
          identityCode: body.identityCode,
          applicationNumber: body.applicationNumber
        });
      await Promise.all([
        clearRateLimitAttempts(request, env, IDENTITY_CHECK_LIMIT),
        clearValueRateLimitAttempts(
          renewalLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return json(result, 200, cors);
    } catch (error) {
      await Promise.all([
        recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT),
        recordValueRateLimitAttempt(
          renewalLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return problem(errorMessage(error), 400, "identity_renewal_unavailable");
    }
  }
  if (path === "/api/public/identity-code-renewal" && method === "POST") {
    const limited = await rejectIfRateLimited(request, env, IDENTITY_CHECK_LIMIT, cors);
    if (limited) return limited;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, 16_000);
    } catch (error) {
      await recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT);
      return problem(errorMessage(error), 400, "identity_renewal_invalid");
    }
    const renewalLookupValue = [
      body.identityCode,
      body.applicationNumber
    ].map((value) => String(value ?? "").trim()).join("|");
    const valueLimited = await rejectIfValueRateLimited(
      renewalLookupValue,
      env,
      IDENTITY_VALUE_CHECK_LIMIT,
      cors
    );
    if (valueLimited) return valueLimited;
    try {
      const result = await submitRenewal(env, {
          identityCode: body.identityCode,
          applicationNumber: body.applicationNumber,
          email: body.email,
          playerName: body.playerName,
          locale: body.locale
        });
      await Promise.all([
        clearRateLimitAttempts(request, env, IDENTITY_CHECK_LIMIT),
        clearValueRateLimitAttempts(
          renewalLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return json(result, 200, cors);
    } catch (error) {
      await Promise.all([
        recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT),
        recordValueRateLimitAttempt(
          renewalLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return problem(errorMessage(error), 400, "identity_renewal_invalid");
    }
  }
  if (path === "/api/public/identity-code-reissue-preview" && method === "POST") {
    const limited = await rejectIfRateLimited(request, env, IDENTITY_CHECK_LIMIT, cors);
    if (limited) return limited;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, 8_000);
    } catch (error) {
      await recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT);
      return problem(errorMessage(error), 400, "identity_reissue_unavailable");
    }
    const reissueLookupValue = identityLookupFingerprint({
      email: body.email,
      identityCode: body.identityCode,
      applicationNumber: body.applicationNumber,
      playerName: body.playerName
    });
    const valueLimited = await rejectIfValueRateLimited(
      reissueLookupValue,
      env,
      IDENTITY_VALUE_CHECK_LIMIT,
      cors
    );
    if (valueLimited) return valueLimited;
    try {
      const result = await reissuePreview(env, {
          identityCode: body.identityCode,
          applicationNumber: body.applicationNumber,
          email: body.email,
          playerName: body.playerName
        });
      await Promise.all([
        clearRateLimitAttempts(request, env, IDENTITY_CHECK_LIMIT),
        clearValueRateLimitAttempts(
          reissueLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return json(result, 200, cors);
    } catch (error) {
      await Promise.all([
        recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT),
        recordValueRateLimitAttempt(
          reissueLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return problem(errorMessage(error), 400, "identity_reissue_unavailable");
    }
  }
  if (path === "/api/public/identity-code-reissue" && method === "POST") {
    const limited = await rejectIfRateLimited(request, env, IDENTITY_CHECK_LIMIT, cors);
    if (limited) return limited;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, 16_000);
    } catch (error) {
      await recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT);
      return problem(errorMessage(error), 400, "identity_reissue_invalid");
    }
    const reissueLookupValue = identityLookupFingerprint({
      email: body.email,
      identityCode: body.identityCode,
      applicationNumber: body.applicationNumber,
      playerName: body.playerName
    });
    const valueLimited = await rejectIfValueRateLimited(
      reissueLookupValue,
      env,
      IDENTITY_VALUE_CHECK_LIMIT,
      cors
    );
    if (valueLimited) return valueLimited;
    try {
      const result = await submitReissue(env, {
          identityCode: body.identityCode,
          applicationNumber: body.applicationNumber,
          email: body.email,
          playerName: body.playerName,
          locale: body.locale
        });
      await Promise.all([
        clearRateLimitAttempts(request, env, IDENTITY_CHECK_LIMIT),
        clearValueRateLimitAttempts(
          reissueLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return json(result, 200, cors);
    } catch (error) {
      await Promise.all([
        recordRateLimitAttempt(request, env, IDENTITY_CHECK_LIMIT),
        recordValueRateLimitAttempt(
          reissueLookupValue,
          env,
          IDENTITY_VALUE_CHECK_LIMIT
        )
      ]);
      return problem(errorMessage(error), 400, "identity_reissue_invalid");
    }
  }
  return problem("Not found", 404, "not_found");
}

async function handleAdminApi(
  request: Request,
  env: Env,
  path: string,
  method: string,
  session: SessionRow
): Promise<Response> {
  const pluginResponse = await dispatchWorkerPluginRequest({
    request, env, path, method, scope: "admin"
  });
  if (pluginResponse) return pluginResponse;
  if (path === "/api/admin/bootstrap" && method === "GET") {
    return json(
      await buildAdminBootstrap(
        env,
        session,
        new URL(request.url).searchParams.get("locale")
      )
    );
  }
  const pluginStateMatch = /^\/api\/admin\/plugins\/([^/]+)$/.exec(path);
  if (pluginStateMatch && method === "PATCH") {
    const pluginId = decodeURIComponent(pluginStateMatch[1] ?? "");
    const body = await readJsonObject(request, 8_000);
    if (typeof body.enabled !== "boolean") {
      return problem("enabled must be a boolean", 400, "invalid_plugin_state");
    }
    if (!(await setWorkerPluginEnabled(env, pluginId, body.enabled))) {
      return problem("Workers 插件不存在", 404, "plugin_not_found");
    }
    return json({
      ok: true,
      plugins: await effectiveWorkerPlugins(env),
      permissionCatalog: await enabledPermissionCatalog(env)
    });
  }
  if (
    (path.startsWith("/api/admin/technology-history") ||
      (path === "/api/admin/config" && request.headers.get("X-Admin-Section") === "technology")) &&
    !(await isWorkerPluginEnabled(env, "technology"))
  ) {
    return problem("科技插件当前未启用", 409, "plugin_disabled");
  }
  const agentMatch = /^\/api\/admin\/agents\/([^/]+)(?:\/(activate))?$/.exec(path);
  if (agentMatch) {
    let agentId: string;
    try {
      agentId = boundedText(
        decodeURIComponent(agentMatch[1] ?? ""),
        "agentId",
        80
      );
    } catch (error) {
      return problem(errorMessage(error), 400, "invalid_agent_id");
    }
    const bundle = await getConfigBundle(env);
    if (agentMatch[2] === "activate" && method === "POST") {
      const heartbeat = await getHeartbeat(env, agentId);
      if (!heartbeat) return problem("Agent not found", 404, "agent_not_found");
      if (agentId !== bundle.campConfig.agentId) {
        const current = bundle.campConfig.agentId
          ? await getHeartbeat(env, bundle.campConfig.agentId)
          : null;
        if (current?.active_run_id) {
          return problem(
            "当前启用 Agent 仍在执行任务，请先结束任务再切换",
            409,
            "active_agent_busy"
          );
        }
      }
      const next = await activateAgentIdentity(env, bundle, agentId);
      return json({ ok: true, activeAgentId: next.campConfig.agentId });
    }
    if (!agentMatch[2] && method === "DELETE") {
      if (agentId === bundle.campConfig.agentId) {
        return problem(
          "不能删除当前启用的 Agent；请先启用另一台设备",
          409,
          "active_agent_delete_forbidden"
        );
      }
      const deleted = await deleteAgentHeartbeat(
        env,
        agentId,
        bundle.campConfig.agentId
      );
      return deleted
        ? json({ ok: true, deleted: true })
        : problem("Agent not found", 404, "agent_not_found");
    }
  }
  if (path === "/api/admin/technology-history" && method === "GET") {
    const bundle = await getConfigBundle(env);
    const dates = isDemoSession(session)
      ? await listTechnologyVoteHistory(env)
      : await ensureTechnologyVoteHistory(env, bundle);
    const requestedDate = new URL(request.url).searchParams.get("date")?.trim();
    if (requestedDate && !isDateKey(requestedDate)) {
      return problem("日期格式必须为 YYYY-MM-DD", 400, "invalid_history_date");
    }
    const pollDate = requestedDate || dates[0]?.pollDate;
    const history = pollDate ? await getTechnologyVoteHistory(env, pollDate) : null;
    const voteBallots = history
      ? await listVoteBallotDetails(env, history.pollDate)
      : [];
    const safeVoteBallots = isDemoSession(session)
      ? demoVoteBallots(voteBallots)
      : voteBallots;
    return json({
      dates,
      history: history
        ? localizeTechnologyVoteHistory(
            history,
            new URL(request.url).searchParams.get("locale")
          )
        : null,
      voteBallots: safeVoteBallots
    });
  }
  if (path === "/api/admin/technology-history" && method === "DELETE") {
    const pollDate = new URL(request.url).searchParams.get("date")?.trim();
    if (pollDate && !isDateKey(pollDate)) {
      return problem("日期格式必须为 YYYY-MM-DD", 400, "invalid_history_date");
    }
    return json({ ok: true, deleted: await deleteTechnologyVoteHistory(env, pollDate) });
  }
  if (path === "/api/admin/maintenance/rate-limits" && method === "DELETE") {
    return json({ ok: true, deleted: await clearPublicRateLimits(env) });
  }
  if (path === "/api/admin/maintenance/run-history" && method === "DELETE") {
    const deleted = await clearFinishedRunHistory(env);
    return json({
      ok: true,
      deleted,
      totalDeleted: deleted.runs + deleted.events + deleted.commands
    });
  }
  if (path === "/api/admin/smtp-config" && method === "GET") {
    return json(
      isDemoSession(session)
        ? demoSmtpConfig()
        : publicSmtpConfig(await getSmtpConfig(env))
    );
  }
  if (path === "/api/admin/smtp-config" && method === "PUT") {
    try {
      return json(await updateSmtpConfig(env, await readJsonObject(request, 32_000)));
    } catch (error) {
      return problem(errorMessage(error), 400, "smtp_config_invalid");
    }
  }
  if (path === "/api/admin/smtp-config/test" && method === "POST") {
    try {
      const body = await readJsonObject(request, 8_000);
      const to = boundedText(body.to, "to", 254);
      await sendMail(env, {
        to,
        subject: "明日之后营地助手 SMTP 测试",
        text: "SMTP 配置测试成功。",
        html: "<p>SMTP 配置测试成功。</p>"
      });
      return json({ sent: true });
    } catch (error) {
      return problem(errorMessage(error), 400, "smtp_test_failed");
    }
  }
  if (path === "/api/admin/identity-applications" && method === "GET") {
    const url = new URL(request.url);
    const result = await listIdentityApplications(env, {
        page: Number(url.searchParams.get("page") ?? 1),
        search: url.searchParams.get("search")?.trim() ?? "",
        status: url.searchParams.get("status")?.trim() ?? ""
      });
    return json(isDemoSession(session) ? demoIdentityApplications(result) : result);
  }
  const approvalMatch =
    /^\/api\/admin\/identity-applications\/([^/]+)\/(approve|reject)$/.exec(path);
  if (approvalMatch && method === "POST") {
    const applicationId = approvalMatch[1];
    const action = approvalMatch[2];
    if (!applicationId || !action) return problem("申请不存在", 404);
    const body = await readJsonObject(request, 16_000);
    try {
      const expiry =
        action === "approve"
          ? await resolveIdentityExpiry(env, body.permanent, body.expiresOn)
          : null;
      const result = action === "approve"
        ? await approveIdentityApplication(env, {
          id: applicationId,
          permanent: expiry?.permanent,
          expiresAt: expiry?.expiresAt,
          reviewedBy: session.email
        })
        : await rejectIdentityApplication(env, {
          id: applicationId,
          reason: typeof body.reason === "string" ? body.reason.trim() : "",
          reviewedBy: session.email
        });
      return json({ ok: true, ...result });
    } catch (error) {
      return problem(errorMessage(error), 400, `identity_${action}_failed`);
    }
  }
  if (path === "/api/admin/identity-codes" && method === "GET") {
    const url = new URL(request.url);
    const demo = isDemoSession(session);
    const canManageIdentity = hasPermission(session, "identity:manage");
    const result = await listIdentityCodes(env, {
        page: Number(url.searchParams.get("page") ?? 1),
        search: url.searchParams.get("search")?.trim() ?? "",
        status: url.searchParams.get("status")?.trim() ?? "",
        includeCode: canManageIdentity
      });
    return json(
      demo
        ? demoIdentityCodes(result)
        : canManageIdentity
        ? result
        : {
            ...result,
            items: result.items.map((item) => ({
              ...item,
              code: "••••••••"
            }))
          }
    );
  }
  if (path === "/api/admin/identity-codes" && method === "POST") {
    try {
      const body = await readJsonObject(request, 16_000);
      const expiry = await resolveIdentityExpiry(
        env,
        body.permanent,
        body.expiresOn
      );
      return json(
        await createManualIdentityCode(env, {
          playerName: body.playerName,
          email: body.email,
          locale: body.locale,
          permanent: expiry.permanent,
          expiresAt: expiry.expiresAt,
          createdBy: session.email
        }),
        201
      );
    } catch (error) {
      return problem(errorMessage(error), 400, "identity_code_create_failed");
    }
  }
  const identityCodeMatch =
    /^\/api\/admin\/identity-codes\/([^/]+)(?:\/(resend|information|reissue))?$/.exec(path);
  if (identityCodeMatch && !identityCodeMatch[2] && method === "PATCH") {
    const codeId = identityCodeMatch[1];
    if (!codeId) return problem("识别码不存在", 404);
    try {
      const body = await readJsonObject(request, 16_000);
      const expiry = await resolveIdentityExpiry(
        env,
        body.permanent,
        body.expiresOn
      );
      await updateIdentityCode(env, {
        id: codeId,
        status: body.status,
        permanent: expiry.permanent,
        expiresAt: expiry.expiresAt
      });
      return json({ ok: true });
    } catch (error) {
      return problem(errorMessage(error), 400, "identity_code_update_failed");
    }
  }
  if (identityCodeMatch?.[2] === "information" && method === "PATCH") {
    const codeId = identityCodeMatch[1];
    if (!codeId) return problem("识别码不存在", 404);
    try {
      const body = await readJsonObject(request, 16_000);
      const expiry = await resolveIdentityExpiry(
        env,
        body.permanent,
        body.expiresOn
      );
      await updateIdentityCodeInformation(env, {
        id: codeId,
        playerName: body.playerName,
        email: body.email,
        locale: body.locale,
        permanent: expiry.permanent,
        expiresAt: expiry.expiresAt
      });
      return json({ ok: true });
    } catch (error) {
      return problem(errorMessage(error), 400, "identity_code_information_failed");
    }
  }
  if (identityCodeMatch?.[2] === "resend" && method === "POST") {
    const codeId = identityCodeMatch[1];
    if (!codeId) return problem("识别码不存在", 404);
    try {
      await resendIdentityCode(env, codeId);
      return json({ sent: true });
    } catch (error) {
      return problem(errorMessage(error), 400, "identity_code_resend_failed");
    }
  }
  if (identityCodeMatch?.[2] === "reissue" && method === "POST") {
    const codeId = identityCodeMatch[1];
    if (!codeId) return problem("识别码不存在", 404);
    try {
      const body = await readJsonObject(request, 16_000);
      const expiry = await resolveIdentityExpiry(
        env,
        body.permanent,
        body.expiresOn
      );
      return json(
        await reissueIdentityCode(env, {
          id: codeId,
          permanent: expiry.permanent,
          expiresAt: expiry.expiresAt,
          reissuedBy: session.email
        })
      );
    } catch (error) {
      return problem(errorMessage(error), 400, "identity_code_reissue_failed");
    }
  }
  if (path === "/api/admin/temp-keys" && method === "GET") {
    const url = new URL(request.url);
    const result = await listTemporaryKeys(env, {
        page: Number(url.searchParams.get("page") ?? 1),
        search: url.searchParams.get("search")?.trim() ?? "",
        status: url.searchParams.get("status")?.trim() ?? ""
      });
    return json(isDemoSession(session) ? demoTemporaryKeys(result) : result);
  }
  if (path === "/api/admin/temp-keys" && method === "POST") {
    const body = await readJsonObject(request, 32_000);
    const name = boundedText(body.name, "name", 80);
    const permanent = body.permanent === true;
    const bundle = await getConfigBundle(env);
    let expiry = new Date("9999-12-31T23:59:59.999Z");
    if (!permanent) {
      const expiresLocal = boundedText(body.expiresLocal, "expiresLocal", 40);
      const [expiresOn = "", expiresClock = ""] = expiresLocal.split("T");
      expiry = new Date(
        zonedDateTimeToIso(
          expiresOn,
          expiresClock,
          bundle.campConfig.timezone
        )
      );
      const now = Date.now();
      if (
        Number.isNaN(expiry.getTime()) ||
        expiry.getTime() < now + 5 * 60_000 ||
        expiry.getTime() > now + 366 * 24 * 60 * 60_000
      ) {
        return problem("有效期必须在 5 分钟至 366 天之间", 400, "invalid_expiry");
      }
    }
    if (!Array.isArray(body.permissions)) {
      return problem("permissions must be an array", 400);
    }
    const allowed = new Set((await enabledPermissionCatalog(env)).map((item) => item.key));
    const permissions = [
      ...new Set(body.permissions.map(String).filter((item) => allowed.has(item)))
    ];
    if (permissions.length !== body.permissions.length) {
      return problem("包含未知权限", 400, "invalid_permission");
    }
    if (!permissions.length) {
      return problem("请选择至少一项权限；仅预览请勾选 Demo 权限", 400, "permission_required");
    }
    if (permissions.includes("demo:preview") && permissions.length > 1) {
      return problem("Demo 权限必须单独使用", 400, "demo_permission_exclusive");
    }
    if (permissions.includes("system:admin") && permissions.length > 1) {
      return problem("系统最高权限必须单独使用", 400, "system_permission_exclusive");
    }
    const issued = await issueTemporaryKey(env, {
      name,
      expiresAt: expiry.toISOString(),
      permanent,
      permissions,
      createdBy: session.email
    });
    return json(
      {
        ...issued,
        name,
        expiresAt: expiry.toISOString(),
        permanent,
        permissions,
        warning: "Key 明文仅显示本次，请立即安全保存"
      },
      201
    );
  }
  if (path === "/api/admin/temp-keys/revoke" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const id = boundedText(body.id, "id", 80);
    return json({ revoked: await revokeTemporaryKey(env, id) });
  }
  const temporaryKeyDeleteMatch = /^\/api\/admin\/temp-keys\/([^/]+)$/.exec(path);
  if (temporaryKeyDeleteMatch && method === "DELETE") {
    let id: string;
    try {
      id = boundedText(
        decodeURIComponent(temporaryKeyDeleteMatch[1] ?? ""),
        "id",
        80
      );
    } catch (error) {
      return problem(errorMessage(error), 400, "invalid_temporary_key_id");
    }
    const deleted = await deleteRevokedTemporaryKey(env, id);
    if (!deleted) {
      return problem("只能删除已撤销的临时 Key", 404, "temporary_key_not_found");
    }
    return json({ ok: true, deleted: true });
  }
  const temporaryKeyPermissionsMatch =
    /^\/api\/admin\/temp-keys\/([^/]+)\/permissions$/.exec(path);
  if (temporaryKeyPermissionsMatch && method === "PATCH") {
    const id = temporaryKeyPermissionsMatch[1];
    if (!id) return problem("临时 Key 不存在", 404, "temporary_key_not_found");
    const body = await readJsonObject(request, 16_000);
    if (!Array.isArray(body.permissions)) {
      return problem("permissions must be an array", 400);
    }
    const allowed = new Set((await enabledPermissionCatalog(env)).map((item) => item.key));
    const permissions = [
      ...new Set(body.permissions.map(String).filter((item) => allowed.has(item)))
    ];
    if (permissions.length !== body.permissions.length) {
      return problem("包含未知权限", 400, "invalid_permission");
    }
    if (!permissions.length) {
      return problem("请选择至少一项权限", 400, "permission_required");
    }
    if (permissions.includes("demo:preview") && permissions.length > 1) {
      return problem("Demo 权限必须单独使用", 400, "demo_permission_exclusive");
    }
    if (permissions.includes("system:admin") && permissions.length > 1) {
      return problem("系统最高权限必须单独使用", 400, "system_permission_exclusive");
    }
    const updated = await updateTemporaryKeyPermissions(env, { id, permissions });
    if (!updated) {
      return problem("临时 Key 不存在或已撤销", 404, "temporary_key_not_found");
    }
    return json({ ok: true, permissions });
  }
  if (path === "/api/admin/config" && method === "PUT") {
    const section = request.headers.get("X-Admin-Section") ?? "";
    const sectionPermission = {
      general: "admin:general",
      tasks: "admin:tasks",
      agent: "admin:agent",
      technology: "admin:technology"
    }[section] as string | undefined;
    if (!sectionPermission || !hasPermission(session, sectionPermission)) {
      return problem("当前登录凭据没有修改此模块的权限", 403, "permission_denied");
    }
    if (
      section === "technology" &&
      !(await isWorkerPluginEnabled(env, "technology"))
    ) {
      return problem("科技插件当前未启用", 409, "plugin_disabled");
    }
    const current = await getConfigBundle(env);
    const submittedBody = await readJsonObject(request, 300_000);
    const submitted = validateConfigBundle(submittedBody);
    if (section === "technology") {
      const voteSummary = await buildVoteSummary(env, current);
      if (!voteSummary.isOpen) {
        const normalizeKeys = (value: unknown) =>
          [...new Set(Array.isArray(value) ? value.map(String) : [])].sort();
        const effectiveFixed = (config: ConfigBundle) =>
          normalizeKeys(
            config.technologyConfig.fixedByDate[voteSummary.pollDate] ??
              config.technologyConfig.fixedByWeekday[
                String(weekdayForDateKey(voteSummary.pollDate))
              ]
          );
        const votingCatalog = (config: ConfigBundle) =>
          config.technologyConfig.catalog
            .map((item) => ({ key: item.key, enabledForVoting: item.enabledForVoting }))
            .sort((left, right) => left.key.localeCompare(right.key));
        if (
          JSON.stringify(effectiveFixed(current)) !==
            JSON.stringify(effectiveFixed(submitted)) ||
          JSON.stringify(votingCatalog(current)) !==
            JSON.stringify(votingCatalog(submitted))
        ) {
          return problem(
            "投票截止至每日刷新前不能修改当前投票结果或固定科技",
            409,
            "technology_result_locked"
          );
        }
      }
    }
    const next = validateConfigBundle({
      ...current,
      ...(section === "general"
        ? {
            campConfig: {
              ...submitted.campConfig,
              specialDailyRefreshTime:
                Object.prototype.hasOwnProperty.call(
                  submittedBody.campConfig ?? {},
                  "specialDailyRefreshTime"
                )
                  ? submitted.campConfig.specialDailyRefreshTime
                  : current.campConfig.specialDailyRefreshTime
            },
            authConfig: submitted.authConfig,
            publicOverview: submitted.publicOverview,
            automationConfig: {
              ...current.automationConfig,
              timezone: submitted.automationConfig.timezone
            }
          }
        : {}),
      ...(section === "tasks"
        ? {
            automationConfig: {
              ...current.automationConfig,
              tasks: preserveAutomationScheduleTimes(
                current.automationConfig.tasks,
                submitted.automationConfig.tasks,
                submittedBody
              )
            }
          }
        : {}),
      ...(section === "agent"
        ? {
            automationConfig: {
              ...current.automationConfig,
              agentPolling: submitted.automationConfig.agentPolling,
              gameWatchdog: submitted.automationConfig.gameWatchdog,
              routines: submitted.automationConfig.routines
            }
          }
        : {}),
      ...(section === "technology"
        ? {
            campConfig: {
              ...current.campConfig,
              voteWindowStart: submitted.campConfig.voteWindowStart,
              voteWindowEnd: submitted.campConfig.voteWindowEnd,
              currentCampType: submitted.campConfig.currentCampType
            },
            technologyConfig: submitted.technologyConfig
          }
        : {})
    });
    await saveConfigBundle(env, next);
    return json(await buildAdminBootstrap(env, session));
  }
  if (path === "/api/admin/run" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const taskKeyValue = boundedText(body.taskKey, "taskKey", 80);
    if (!isTaskKey(taskKeyValue)) return problem("Unknown taskKey", 400, "unknown_task");
    const plugin = await enabledPluginForTask(env, taskKeyValue);
    const pluginTask = plugin?.tasks.find((task) => task.key === taskKeyValue);
    if (!plugin || !pluginTask) {
      return problem("该任务对应的 Workers 插件未安装或未启用", 409, "plugin_disabled");
    }
    if (!hasPermission(session, pluginTask.runPermission)) {
      return problem("当前 Key 没有执行此插件任务的权限", 403, "permission_denied");
    }
    const bundle = await getConfigBundle(env);
    const activeRun = await findActiveRunForAgent(env, bundle.campConfig.agentId);
    if (activeRun) {
      return problem(
        "当前 Agent 已有任务正在运行或排队；手工任务不会重复入队",
        409,
        "agent_busy"
      );
    }
    const result = await enqueueTask(env, {
      bundle,
      taskKey: taskKeyValue,
      triggerMode: "manual",
      requestedBy: session,
      payloadDetail: {
        locale: normalizeLocale(body.locale)
      }
    });
    return json(result, 201);
  }
  if (path === "/api/admin/interrupt" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const runId = boundedText(body.runId, "runId", 80);
    const run = await getRun(env, runId);
    if (!run) return problem("Run not found", 404, "run_not_found");
    if (TERMINAL_RUN_STATES.has(run.state)) {
      return problem("Run is already finished", 409, "run_finished");
    }
    const changed = await requestRunCancellation(env, runId);
    if (run.state === "queued") {
      await updateRun(env, {
        runId,
        state: "interrupted",
        message: `管理员 ${session.email} 在任务领取前取消`,
        currentStep: null
      });
      await appendRunEvent(env, {
        runId,
        level: "warning",
        step: null,
        message: `管理员 ${session.email} 在任务领取前取消任务`
      });
      return json({ changed, commandId: null, state: "interrupted" });
    }
    const bundle = await getConfigBundle(env);
    const command = await createCommand(env, {
      runId,
      agentId: bundle.campConfig.agentId,
      type: "interrupt_task",
      payload: {
        runId,
        taskKey: run.task_key,
        requestedBy: session.email,
        requestedAt: new Date().toISOString()
      },
      priority: 100
    });
    await appendRunEvent(env, {
      runId,
      level: "warning",
      step: run.current_step,
      message: `管理员 ${session.email} 请求中断任务`
    });
    return json({ changed, commandId: command.id, state: "cancelling" });
  }
  const eventMatch = /^\/api\/admin\/runs\/([^/]+)\/events$/.exec(path);
  if (eventMatch && method === "GET") {
    const runId = eventMatch[1];
    if (!runId) return problem("Run not found", 404);
    const url = new URL(request.url);
    const afterId = Number(url.searchParams.get("afterId"));
    const limit = Number(url.searchParams.get("limit"));
    const result = await listRunEvents(env, runId, {
        ...(Number.isInteger(afterId) && afterId > 0 ? { afterId } : {}),
        ...(Number.isInteger(limit) && limit > 0 ? { limit } : {})
      });
    const localized = {
      ...result,
      events: result.events.map((event) =>
        localizeWorkerEvent(event, normalizeLocale(url.searchParams.get("locale")))
      )
    };
    return json(isDemoSession(session) ? demoRunEvents(localized) : localized);
  }
  return problem("Not found", 404, "not_found");
}

async function handleAgentApi(
  request: Request,
  env: Env,
  path: string,
  method: string
): Promise<Response> {
  const pluginResponse = await dispatchWorkerPluginRequest({
    request, env, path, method, scope: "agent"
  });
  if (pluginResponse) return pluginResponse;
  if (path === "/api/agent/register" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const agentId = boundedText(body.agentId, "agentId", 80);
    const displayName =
      typeof body.displayName === "string"
        ? boundedText(body.displayName, "displayName", 80)
        : agentId;
    const registered = await registerAgentDevice(env, { agentId, displayName });
    return json({ ok: true, agentId, ...registered });
  }
  if (path === "/api/agent/heartbeat" && method === "POST") {
    const body = await readJsonObject(request, 64_000);
    const activeRunId =
      typeof body.activeRunId === "string" ? body.activeRunId.slice(0, 80) : null;
    const activeTaskValue =
      typeof body.activeTaskKey === "string" ? body.activeTaskKey : null;
    const activeTaskKey: TaskKey | null =
      activeTaskValue && isTaskKey(activeTaskValue) ? activeTaskValue : null;
    const agentId = boundedText(body.agentId, "agentId", 80);
    await touchHeartbeat(env, {
      agentId,
      displayName:
        typeof body.displayName === "string"
          ? boundedText(body.displayName, "displayName", 80)
          : agentId,
      activeRunId,
      activeTaskKey,
      status: boundedText(body.status, "status", 40),
      capabilities: body.capabilities ?? {},
      detail: {
        ...(body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
          ? body.detail
          : {}),
        locale: normalizeLocale(body.locale)
      }
    });
    const activeRun = activeRunId ? await getRun(env, activeRunId) : null;
    const bundle = await getConfigBundle(env);
    return json({
      ok: true,
      enabled: bundle.campConfig.agentId === agentId,
      activeAgentId: bundle.campConfig.agentId || null,
      cancelRequested: activeRun?.cancel_requested === 1
    });
  }
  if (path === "/api/agent/next-command" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const bundle = await getConfigBundle(env);
    const agentId = boundedText(body.agentId, "agentId", 80);
    const enabled = Boolean(bundle.campConfig.agentId) &&
      bundle.campConfig.agentId === agentId;
    await expireUnclaimedRuns(
      env,
      bundle.automationConfig.agentPolling.claimTimeoutMinutes
    );
    let command = enabled
      ? await claimNextCommand(env, {
          agentId,
          busy: body.busy === true
        })
      : null;
    let commandPayload: Record<string, unknown> | null = null;
    if (command?.type === "run_task") {
      const payload = safeParseJson(command.payload_json, {}) as Record<string, unknown>;
      const payloadDetail = payload.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
        ? payload.detail as Record<string, unknown>
        : {};
      commandPayload = {
        ...payload,
        locale: normalizeLocale(body.locale ?? payload.locale ?? payloadDetail.locale)
      };
      const pluginTasks = taskKeysFromCommandPayload(payload).filter((taskKey) =>
        builtPluginForTask(taskKey)
      );
      const activeTasks = new Set(
        (await effectiveWorkerPlugins(env))
          .filter((plugin) => plugin.enabled)
          .flatMap((plugin) => plugin.tasks.map((task) => task.key))
      );
      const disabledTasks = pluginTasks.filter((taskKey) => !activeTasks.has(taskKey));
      if (disabledTasks.length && command.lease_token) {
        await completeCommand(env, {
          commandId: command.id,
          leaseToken: command.lease_token,
          state: "cancelled",
          message: `Workers 插件已停用：${disabledTasks.join(", ")}`
        });
        if (command.run_id) {
          await updateRun(env, {
            runId: command.run_id,
            state: "interrupted",
            message: `对应 Workers 插件已停用：${disabledTasks.join(", ")}`,
            currentStep: null
          });
        }
        command = null;
      }
    }
    return json({
      enabled,
      activeAgentId: bundle.campConfig.agentId || null,
      command: command
        ? {
            id: command.id,
            runId: command.run_id,
            type: command.type,
            payload: commandPayload ?? safeParseJson(command.payload_json, {}),
            leaseToken: command.lease_token,
            attemptCount: command.attempt_count
          }
        : null,
      pollAfterSeconds: pollingIntervalSeconds(
        bundle.automationConfig,
        body.busy === true,
        new Date()
      )
    });
  }
  if (path === "/api/agent/bootstrap" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const agentId = boundedText(body.agentId, "agentId", 80);
    const runId = typeof body.runId === "string" ? body.runId : null;
    const bundle = await getConfigBundle(env);
    const plugins = await effectiveWorkerPlugins(env);
    const enabledTaskKeys = new Set(
      plugins.filter((plugin) => plugin.enabled).flatMap((plugin) =>
        plugin.tasks.map((task) => task.key)
      )
    );
    const configBundle = {
      ...bundle,
      automationConfig: {
        ...bundle.automationConfig,
        tasks: Object.fromEntries(
          Object.entries(bundle.automationConfig.tasks).map(([key, schedule]) => [
            key,
            enabledTaskKeys.has(key) ? schedule : { ...schedule, enabled: false }
          ])
        ),
        routines: bundle.automationConfig.routines.map((routine) => ({
          ...routine,
          groups: routine.groups
            .map((group) => group.filter((taskKey) => enabledTaskKeys.has(taskKey)))
            .filter((group) => group.length)
        })).filter((routine) => routine.groups.length)
      }
    };
    const memberRoster = (await listMembers(env))
      .map((member) => ({
        name: typeof member.name === "string" ? member.name : "",
        weeklyContribution: Number(member.weekly_contribution) || 0
      }))
      .filter((member) => member.name);
    return json({
      configBundle,
      plugins,
      memberRoster,
      heartbeat: await getHeartbeat(env, agentId),
      enabled: bundle.campConfig.agentId === agentId,
      run: runId ? await getRun(env, runId) : null
    });
  }
  if (path === "/api/agent/run-update" && method === "POST") {
    const body = await readJsonObject(request, 128_000);
    const runId = boundedText(body.runId, "runId", 80);
    const stateValue = typeof body.state === "string" ? body.state : undefined;
    const state = isRunState(stateValue) ? stateValue : undefined;
    const run = await updateRun(env, {
      runId,
      state,
      message: typeof body.message === "string" ? body.message.slice(0, 1000) : undefined,
      currentStep:
        body.currentStep === null
          ? null
          : typeof body.currentStep === "string"
            ? body.currentStep.slice(0, 120)
            : undefined,
      progress: typeof body.progress === "number" ? body.progress : undefined,
      detail: body.detail
    });
    if (!run) return problem("Run not found", 404, "run_not_found");
    if (body.event && typeof body.event === "object") {
      const event = body.event as Record<string, unknown>;
      await appendRunEvent(env, {
        runId,
        level: isEventLevel(event.level) ? event.level : "info",
        step: typeof event.step === "string" ? event.step.slice(0, 120) : null,
        message: boundedText(event.message, "event.message", 2000),
        detail: event.detail ?? {}
      });
    }
    return json({ run });
  }
  if (path === "/api/agent/snapshot" && method === "POST") {
    const body = await readJsonObject(request, 1_000_000);
    const type = boundedText(body.type, "type", 40);
    const runId = boundedText(body.runId, "runId", 80);
    const capturedAt =
      typeof body.capturedAt === "string" ? body.capturedAt : new Date().toISOString();
    const snapshotPlugin = {
      members: "member-profile",
      profiles: "member-profile",
      departed: "member-profile",
      staff: "member-profile",
      contribution: "contribution",
      activity: "inactivity"
    }[type];
    if (
      snapshotPlugin &&
      !(await isWorkerPluginEnabled(env, snapshotPlugin))
    ) {
      return problem("该快照对应的 Workers 插件未启用", 409, "plugin_disabled");
    }
    if (type === "members") {
      const members = sanitizeMembers(body.payload);
      const bundle = await getConfigBundle(env);
      await replaceMemberSnapshot(env, {
        runId,
        snapshotDate: zonedDateKey(new Date(capturedAt), bundle.automationConfig.timezone),
        capturedAt,
        members
      });
      return json({ ok: true, count: members.length });
    }
    if (type === "contribution") {
      const members = sanitizeContribution(body.payload);
      const reconciliation = await updateContributionSnapshot(env, {
        runId,
        capturedAt,
        members
      });
      return json({
        ok: true,
        count: reconciliation.updates.length,
        received: members.length,
        ignored: reconciliation.ignored,
        ambiguous: reconciliation.ambiguous
      });
    }
    if (type === "activity") {
      const members = sanitizeActivity(body.payload);
      const reconciliation = await updateActivitySnapshot(env, {
        runId,
        capturedAt,
        members
      });
      return json({
        ok: true,
        count: reconciliation.updates.length,
        received: members.length,
        ignored: reconciliation.ignored,
        ambiguous: reconciliation.ambiguous
      });
    }
    if (type === "profiles") {
      const members = sanitizeProfiles(body.payload);
      await updateMemberProfiles(env, { runId, capturedAt, members });
      return json({ ok: true, count: members.length });
    }
    if (type === "departed") {
      const names = sanitizeMemberNames(body.payload);
      await removeCurrentMembers(env, names);
      return json({ ok: true, count: names.length });
    }
    if (type === "staff") {
      const staff = sanitizeStaff(body.payload);
      const reconciliation = await replaceStaffSnapshot(env, {
        runId,
        capturedAt,
        staff
      });
      return json({
        ok: true,
        count: reconciliation.staff.length,
        received: staff.length,
        ignored: reconciliation.ignored,
        ambiguous: reconciliation.ambiguous
      });
    }
    return problem("Unknown snapshot type", 400, "unknown_snapshot");
  }
  if (path === "/api/agent/complete-command" && method === "POST") {
    const body = await readJsonObject(request, 32_000);
    const state =
      body.state === "completed" || body.state === "failed" || body.state === "cancelled"
        ? body.state
        : null;
    if (!state) return problem("Invalid command state", 400);
    const completed = await completeCommand(env, {
      commandId: boundedText(body.commandId, "commandId", 80),
      leaseToken: boundedText(body.leaseToken, "leaseToken", 80),
      state,
      message: boundedText(body.message, "message", 1000)
    });
    if (!completed) return problem("Command lease is stale", 409, "stale_lease");
    return json({ ok: true });
  }
  return problem("Not found", 404, "not_found");
}

async function resolveIdentityExpiry(
  env: Env,
  permanent: unknown,
  expiresOn: unknown
): Promise<{ permanent: boolean; expiresAt: string | null }> {
  if (permanent === true) return { permanent: true, expiresAt: null };
  const date = boundedText(expiresOn, "expiresOn", 10);
  const bundle = await getConfigBundle(env);
  return {
    permanent: false,
    expiresAt: zonedDateTimeToIso(
      date,
      bundle.campConfig.gameResetTime,
      bundle.campConfig.timezone
    )
  };
}

async function buildPublicBootstrap(
  env: Env,
  locale: unknown
): Promise<Record<string, unknown>> {
  const bundle = await getConfigBundle(env);
  // Repair historical runs whose Agent command reached a terminal state while
  // the separate run-update request was interrupted. This preserves all rows
  // and events; it only fills the missing run terminal state.
  await reconcileTerminalRunCommands(env);
  const plugins = await effectiveWorkerPlugins(env);
  const pluginEnabled = new Map(plugins.map((plugin) => [plugin.id, plugin.enabled]));
  const [voteSummary, staff, members, warnings, recentRuns] = await Promise.all([
    buildVoteSummary(env, bundle),
    listStaff(env),
    bundle.campConfig.publicMembersEnabled && pluginEnabled.get("member-profile")
      ? listMembers(env)
      : Promise.resolve([]),
    pluginEnabled.get("inactivity") ? listActivityWarnings(env) : Promise.resolve([]),
    listRecentRuns(env, 10)
  ]);
  return {
    plugins,
    siteName: bundle.campConfig.publicSiteName,
    publicOverview:
      bundle.publicOverview.localized[normalizeLocale(locale)] ?? bundle.publicOverview,
    campConfig: {
      campName: bundle.campConfig.campName,
      serverName: bundle.campConfig.serverName,
      currentCampType: bundle.campConfig.currentCampType,
      timezone: bundle.campConfig.timezone,
      gameResetTime: bundle.campConfig.gameResetTime,
      specialDailyRefreshTime: bundle.campConfig.specialDailyRefreshTime,
      voteWindowStart: bundle.campConfig.voteWindowStart,
      voteWindowEnd: bundle.campConfig.voteWindowEnd,
      inactivityWarningDays: bundle.campConfig.inactivityWarningDays
    },
    inactivityWarnings: warnings
      .filter(
        (member) =>
          typeof member.inactive_days === "number" &&
          member.inactive_days >= bundle.campConfig.inactivityWarningDays
      )
      .sort(
        (left, right) =>
          Number(right.inactive_days) - Number(left.inactive_days) ||
          String(left.name).localeCompare(String(right.name))
      ),
    voteSummary: localizeVoteSummary(voteSummary, locale),
    staffAssignments: staff,
    members,
    recentRuns: recentRuns.filter(isCurrentFeatureRun).map(publicRun)
  };
}

async function buildAdminBootstrap(
  env: Env,
  session: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSession>>>,
  locale: unknown = "zh-cn"
): Promise<Record<string, unknown>> {
  const bundle = await getConfigBundle(env);
  const plugins = await effectiveWorkerPlugins(env);
  const pluginEnabled = new Map(plugins.map((plugin) => [plugin.id, plugin.enabled]));
  const demo = isDemoSession(session);
  // Deployment/backfill special case: the first admin bootstrap organizes every
  // history entry whose technology effective day has already crossed daily reset.
  if (pluginEnabled.get("technology") && !demo) {
    await ensureTechnologyVoteHistory(env, bundle);
  }
  const canOverview = canViewAdminModule(session, "admin:overview");
  const canTechnology = Boolean(pluginEnabled.get("technology")) &&
    canViewAdminModule(session, "admin:technology");
  const canMembers = Boolean(pluginEnabled.get("member-profile")) &&
    canViewAdminModule(session, "admin:members");
  const canHistory = canViewAdminModule(session, "admin:history");
  const [voteSummary, heartbeats, recentRuns, staff, members] = await Promise.all([
    buildVoteSummary(env, bundle),
    canOverview
      ? listHeartbeats(env)
      : Promise.resolve([]),
    canHistory ? listRecentRuns(env, 100) : Promise.resolve([]),
    canMembers ? listStaff(env) : Promise.resolve([]),
    canMembers ? listMembers(env) : Promise.resolve([])
  ]);
  const voteBallots = canTechnology
    ? demo
      ? demoVoteBallots(await listVoteBallotDetails(env, voteSummary.pollDate))
      : (await listVoteBallotDetails(env, voteSummary.pollDate)).map((ballot) =>
          hasPermission(session, "admin:technology")
            ? ballot
            : { ...ballot, identityCode: "••••••••" }
        )
    : [];
  const safeHeartbeats = demo
    ? heartbeats.map((heartbeat, index) => ({
        ...heartbeat,
        agent_id: `demo-agent-${index + 1}`,
        display_name: "Demo Agent",
        active_run_id: null,
        capabilities_json: null,
        detail_json: null
      }))
    : heartbeats;
  return {
    plugins,
    permissionCatalog: await enabledPermissionCatalog(env),
    session: {
      email: demo ? "test@demo.com" : session.email,
      displayName: demo ? "Demo · 全后台只读" : session.display_name,
      csrfToken: demo ? "demo-readonly" : session.csrf_token,
      authMethod: session.auth_method,
      permissions: sessionPermissions(session),
      expiresAt: session.expires_at
    },
    configBundle: {
      ...bundle,
      campConfig: demo
        ? { ...bundle.campConfig, agentId: "demo-agent" }
        : bundle.campConfig,
      technologyConfig: {
        ...bundle.technologyConfig,
        catalog: bundle.technologyConfig.catalog.map((item) =>
          localizeTechnology(item, locale)
        )
      }
    },
    voteSummary: canTechnology
      ? localizeVoteSummary(voteSummary, locale)
      : { pollDate: voteSummary.pollDate, ballotCount: 0, options: [], projectedPlan: { core: [], general: [] } },
    voteBallots,
    heartbeats: safeHeartbeats,
    recentRuns: recentRuns
      .filter(isCurrentFeatureRun)
      .map((run) => localizeWorkerRun(run, locale)),
    staffAssignments: canMembers ? staff : [],
    members: canMembers ? members : [],
    // Agent heartbeats are independent from the (potentially five-minute)
    // idle command poll. A stopped device should therefore expire quickly.
    agentOnlineThresholdSeconds: 45,
    temporaryKeys: [],
    nextTechnologyTargetDate: nextTechnologyTargetDate(
      new Date(),
      bundle.automationConfig.timezone,
      bundle.automationConfig.tasks.tech_switch.time,
      bundle.campConfig.gameResetTime
    )
  };
}

function localizeVoteSummary<T extends {
  options: Array<ReturnType<typeof localizeTechnology>>;
  projectedPlan: {
    core: Array<ReturnType<typeof localizeTechnology>>;
    general: Array<ReturnType<typeof localizeTechnology>>;
  };
}>(summary: T, locale: unknown): T {
  return {
    ...summary,
    options: summary.options.map((item) => localizeTechnology(item, locale)),
    projectedPlan: {
      core: summary.projectedPlan.core.map((item) =>
        localizeTechnology(item, locale)
      ),
      general: summary.projectedPlan.general.map((item) =>
        localizeTechnology(item, locale)
      )
    }
  };
}

function localizeTechnologyVoteHistory(
  history: TechnologyVoteHistory,
  locale: unknown
): TechnologyVoteHistory {
  return {
    ...localizeVoteSummary(history, locale),
    fixedTechnologies: history.fixedTechnologies.map((item) =>
      localizeTechnology(item, locale)
    )
  };
}

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function ensureTechnologyVoteHistory(
  env: Env,
  bundle: ConfigBundle
): Promise<
  Array<Pick<TechnologyVoteHistory, "pollDate" | "finalizedAt" | "ballotCount">>
> {
  const now = new Date();
  const archivedAtDailyReset = await archiveTechnologyVoteHistoryAtDailyReset(
    env,
    bundle,
    now
  );
  const [ballotDates, recordedDates] = await Promise.all([
    listVotePollDates(env),
    listRecordedTechnologyVoteHistoryDates(env)
  ]);
  const knownDates = new Set(recordedDates);
  const nextEffectiveDate = nextTechnologyTargetDate(
    now,
    bundle.automationConfig.timezone,
    bundle.automationConfig.tasks.tech_switch.time,
    bundle.campConfig.gameResetTime
  );
  for (const pollDate of ballotDates) {
    const isEligibleForArchive = archivedAtDailyReset
      ? pollDate <= archivedAtDailyReset
      : pollDate < nextEffectiveDate;
    if (!isDateKey(pollDate) || !isEligibleForArchive || knownDates.has(pollDate)) {
      continue;
    }
    await snapshotTechnologyVoteHistory(env, bundle, pollDate, now);
  }
  return listTechnologyVoteHistory(env);
}

function isCurrentFeatureRun(run: { task_key: string }): boolean {
  return (
    run.task_key !== "brick_transport" &&
    run.task_key !== "weekly_schedule_update"
  );
}

type IdentityApplicationsResult = Awaited<
  ReturnType<typeof listIdentityApplications>
>;
type IdentityCodesResult = Awaited<ReturnType<typeof listIdentityCodes>>;
type TemporaryKeysResult = Awaited<ReturnType<typeof listTemporaryKeys>>;
type VoteBallotsResult = Awaited<ReturnType<typeof listVoteBallotDetails>>;
type RunEventsResult = Awaited<ReturnType<typeof listRunEvents>>;

function demoVoteBallots(items: VoteBallotsResult): VoteBallotsResult {
  return items.map((item) => ({
    ...item,
    voterId: "demo-voter",
    identityCode: "00000000",
    playerName: "Demo 用户"
  }));
}

function demoRunEvents(result: RunEventsResult): RunEventsResult {
  return {
    ...result,
    events: result.events.map((event) => ({
      ...event,
      message: "Demo operation event",
      detail_json: null
    }))
  };
}

function demoIdentityApplications(
  result: IdentityApplicationsResult
): IdentityApplicationsResult {
  return {
    ...result,
    items: result.items.map((item, index) => ({
      ...item,
      id: `demo-application-${index + 1}`,
      application_number: "00000000",
      email: "test@demo.com",
      player_name: "Demo 用户",
      identity_code_id: null,
      reviewed_by: null,
      rejection_reason: null,
      last_email_error: null
    }))
  };
}

function demoIdentityCodes(result: IdentityCodesResult): IdentityCodesResult {
  return {
    ...result,
    items: result.items.map((item, index) => ({
      ...item,
      id: `demo-code-${index + 1}`,
      code: "00000000",
      code_hash: "demo",
      code_encrypted: "",
      application_id: null,
      application_number: "00000000",
      player_name: "Demo 用户",
      email: "test@demo.com",
      created_by: "demo",
      last_email_error: null
    }))
  };
}

function demoTemporaryKeys(result: TemporaryKeysResult): TemporaryKeysResult {
  return {
    ...result,
    items: result.items.map((item, index) => ({
      ...item,
      id: `demo-key-${index + 1}`,
      name: "Demo Access Key",
      permissions_json: JSON.stringify(["demo:preview"]),
      created_by: "test@demo.com"
    }))
  };
}

function pollingIntervalSeconds(
  automation: ConfigBundle["automationConfig"],
  busy: boolean,
  now: Date
): number {
  if (busy) return automation.agentPolling.activeSeconds;
  const parts = zonedParts(now, automation.timezone);
  const minute = parts.hour * 60 + parts.minute;
  const matching = automation.agentPolling.windows
    .filter((window) => {
      if (!window.weekdays.includes(parts.weekday)) return false;
      const [startHour, startMinute] = window.start.split(":").map(Number);
      const [endHour, endMinute] = window.end.split(":").map(Number);
      const start = (startHour ?? 0) * 60 + (startMinute ?? 0);
      const end = (endHour ?? 0) * 60 + (endMinute ?? 0);
      return start <= end
        ? minute >= start && minute < end
        : minute >= start || minute < end;
    })
    .map((window) => window.seconds);
  return matching.length
    ? Math.min(...matching)
    : automation.agentPolling.idleSeconds;
}

function permissionForAdminRequest(
  path: string,
  method: string
): string | null {
  if (path.startsWith("/api/admin/plugins/")) return "plugins:manage";
  if (path === "/api/admin/technology-history") {
    return method === "DELETE"
      ? "technology-history:manage"
      : "admin:technology-history";
  }
  if (method === "PUT" && path === "/api/admin/config") return null;
  if (path.startsWith("/api/admin/agents/")) return "admin:agent";
  if (method === "POST" && path === "/api/admin/interrupt") return "task:interrupt";
  if (method === "DELETE" && path.startsWith("/api/admin/maintenance/")) {
    return "admin:history";
  }
  if (path === "/api/admin/temp-keys") {
    return method === "GET" ? "admin:access" : "keys:manage";
  }
  if (path === "/api/admin/temp-keys/revoke") {
    return "keys:manage";
  }
  if (/^\/api\/admin\/temp-keys\/[^/]+$/.test(path)) {
    return "keys:manage";
  }
  if (/^\/api\/admin\/temp-keys\/[^/]+\/permissions$/.test(path)) {
    return "keys:manage";
  }
  if (path.startsWith("/api/admin/identity-applications")) {
    return method === "GET" ? "admin:identity-review" : "identity:review";
  }
  if (path.startsWith("/api/admin/identity-codes")) {
    return method === "GET" ? "admin:identity-codes" : "identity:manage";
  }
  if (path.startsWith("/api/admin/smtp-config")) {
    return method === "GET" ? "admin:smtp" : "smtp:manage";
  }
  if (/^\/api\/admin\/runs\/[^/]+\/events$/.test(path) && method === "GET") {
    return "admin:history";
  }
  return null;
}

function publicRun(run: Awaited<ReturnType<typeof listRecentRuns>>[number]) {
  return {
    id: run.id,
    taskKey: run.task_key,
    state: run.state,
    createdAt: run.created_at,
    finishedAt: run.finished_at
  };
}

async function requireAgentAuth(request: Request, env: Env): Promise<Response | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return problem("Agent authentication required", 401, "agent_auth_required");
  }
  if (
    typeof env.AGENT_SHARED_TOKEN !== "string" ||
    env.AGENT_SHARED_TOKEN.length < 20
  ) {
    console.error(
      JSON.stringify({
        event: "agent_auth_configuration_error",
        reason: "AGENT_SHARED_TOKEN is missing or shorter than 20 characters"
      })
    );
    return problem(
      "Agent token is not configured on this Worker deployment",
      503,
      "agent_token_not_configured"
    );
  }
  const token = authorization.slice(7);
  if (!(await timingSafeEqual(token, env.AGENT_SHARED_TOKEN))) {
    return problem("Invalid agent token", 403, "invalid_agent_token");
  }
  return null;
}

async function readJsonObject(
  request: Request,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > maxBytes) throw new Error("Request body is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new Error("Request body is too large");
  }
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${field} is invalid`);
  return result;
}

function safeParseJson(value: string | null, fallback: unknown): unknown {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function taskKeysFromCommandPayload(payload: Record<string, unknown>): string[] {
  const direct = typeof payload.taskKey === "string" ? [payload.taskKey] : [];
  const detail = payload.detail && typeof payload.detail === "object"
    ? payload.detail as Record<string, unknown>
    : null;
  const routine = detail?.routine && typeof detail.routine === "object"
    ? detail.routine as Record<string, unknown>
    : null;
  const groups = Array.isArray(routine?.groups) ? routine.groups : [];
  return [...new Set([
    ...direct,
    ...groups.flatMap((group) =>
      Array.isArray(group) ? group.filter((item): item is string => typeof item === "string") : []
    )
  ])];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rejectIfRateLimited(
  request: Request,
  env: Env,
  policy: RateLimitPolicy,
  headers: Headers
): Promise<Response | null> {
  const state = await checkRateLimit(request, env, policy);
  if (state.allowed) return null;
  const response = json(
    {
      error: `请求过于频繁，请在 ${state.retryAfterSeconds} 秒后重试`,
      code: "rate_limited",
      retryAfterSeconds: state.retryAfterSeconds
    },
    429,
    headers
  );
  response.headers.set("Retry-After", String(state.retryAfterSeconds));
  return response;
}

async function rejectIfValueRateLimited(
  value: unknown,
  env: Env,
  policy: RateLimitPolicy,
  headers: Headers
): Promise<Response | null> {
  const state = await checkValueRateLimit(value, env, policy);
  if (state.allowed) return null;
  const response = json(
    {
      error: `该识别码的尝试次数过多，请在 ${state.retryAfterSeconds} 秒后重试`,
      code: "identity_code_rate_limited",
      retryAfterSeconds: state.retryAfterSeconds
    },
    429,
    headers
  );
  response.headers.set("Retry-After", String(state.retryAfterSeconds));
  return response;
}

function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "string" &&
    [
      "queued",
      "claimed",
      "running",
      "cancelling",
      "interrupted",
      "succeeded",
      "partially_succeeded",
      "failed",
      "timed_out",
      "skipped"
    ].includes(value)
  );
}

function isEventLevel(
  value: unknown
): value is "debug" | "info" | "warning" | "error" {
  return (
    value === "debug" || value === "info" || value === "warning" || value === "error"
  );
}

function sanitizeMembers(value: unknown) {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid members payload");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid member ${index}`);
    const item = raw as Record<string, unknown>;
    return {
      name: boundedText(item.name, `members[${index}].name`, 80),
      profession: nullableText(item.profession, 80),
      manorLevel: nullableInteger(item.manorLevel, 0, 1000),
      roommateName: nullableText(item.roommateName, 80),
      campTitle: nullableText(item.campTitle, 80),
      weeklyContribution: requiredInteger(item.weeklyContribution, 0, 1_000_000_000),
      technologyPointsUsed: requiredInteger(
        item.technologyPointsUsed,
        0,
        10_000_000_000
      ),
      materialContribution: requiredInteger(
        item.materialContribution,
        0,
        100_000_000_000
      ),
      lastActiveText: nullableText(item.lastActiveText, 80),
      inactiveDays: nullableInteger(item.inactiveDays, 0, 100_000)
    };
  });
}

function sanitizeContribution(value: unknown) {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error("Invalid contribution payload");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid contribution ${index}`);
    const item = raw as Record<string, unknown>;
    return {
      name: boundedText(item.name, `contribution[${index}].name`, 80),
      weeklyContribution: requiredInteger(item.weeklyContribution, 0, 1_000_000_000),
      technologyPointsUsed: requiredInteger(item.technologyPointsUsed, 0, 10_000_000_000),
      materialContribution: requiredInteger(item.materialContribution, 0, 100_000_000_000)
    };
  });
}

function sanitizeActivity(value: unknown) {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid activity payload");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid activity ${index}`);
    const item = raw as Record<string, unknown>;
    return {
      name: boundedText(item.name, `activity[${index}].name`, 80),
      lastActiveText: nullableText(item.lastActiveText, 80),
      inactiveDays: nullableInteger(item.inactiveDays, 0, 100_000)
    };
  });
}

function sanitizeProfiles(value: unknown) {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid profiles payload");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid profile ${index}`);
    const item = raw as Record<string, unknown>;
    return {
      name: boundedText(item.name, `profiles[${index}].name`, 80),
      profession: nullableText(item.profession, 80),
      manorLevel: nullableInteger(item.manorLevel, 0, 1000),
      roommateName: nullableText(item.roommateName, 80),
      campTitle: nullableText(item.campTitle, 80),
      weeklyContribution: requiredInteger(
        item.weeklyContribution,
        0,
        1_000_000_000
      )
    };
  });
}

function sanitizeMemberNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error("Invalid member name payload");
  }
  return [...new Set(value.map((name, index) =>
    boundedText(name, `memberNames[${index}]`, 80)
  ))];
}

function sanitizeStaff(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid staff payload");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid staff ${index}`);
    const item = raw as Record<string, unknown>;
    return {
      roleKey: boundedText(item.roleKey, `staff[${index}].roleKey`, 80),
      roleName: boundedText(item.roleName, `staff[${index}].roleName`, 80),
      memberName: nullableText(item.memberName, 80)
    };
  });
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid text value");
  return value.trim().slice(0, max) || null;
}

function nullableInteger(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredInteger(value, min, max);
}

function requiredInteger(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(numeric) || Number(numeric) < min || Number(numeric) > max) {
    throw new Error("Invalid integer value");
  }
  return Number(numeric);
}
