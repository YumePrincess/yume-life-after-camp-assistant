import {
  ADMIN_PERMISSIONS,
  getAuthenticatedSession,
  handleOidcSilentStart,
  handleTemporaryKeyLogin,
  handleLogout,
  handleOidcCallback,
  handleOidcStart,
  hasPermission,
  issueTemporaryKey,
  listTemporaryKeys,
  maybeValidateOidcSession,
  requireAdmin,
  revokeTemporaryKey,
  sessionPermissions,
  timingSafeEqual
} from "./auth";
import {
  appendRunEvent,
  claimNextCommand,
  completeCommand,
  createCommand,
  getConfigBundle,
  getHeartbeat,
  getRun,
  listHeartbeats,
  listMembers,
  listRecentRuns,
  listRunEvents,
  listStaff,
  replaceMemberSnapshot,
  replaceStaffSnapshot,
  removeCurrentMembers,
  updateActivitySnapshot,
  updateContributionSnapshot,
  updateMemberProfiles,
  requestRunCancellation,
  saveBallot,
  saveConfigBundle,
  touchHeartbeat,
  updateRun,
  type SessionRow
} from "./db";
import { normalizeBallotSelections } from "./tech";
import {
  isTaskKey,
  type ConfigBundle,
  type RunState,
  type TaskKey
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
import { buildVoteSummary, enqueueTask } from "./tasks";
import {
  nextTechnologyTargetDate,
  weekdayForDateKey,
  zonedDateKey,
  zonedParts
} from "./time";
import { validateConfigBundle } from "./validate";

const TERMINAL_RUN_STATES = new Set<RunState>([
  "interrupted",
  "succeeded",
  "failed",
  "skipped"
]);

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
  if (path === "/api/public/bootstrap" && method === "GET") {
    const payload = await buildPublicBootstrap(env);
    return json(payload, 200, cors);
  }
  if (path === "/api/public/tech-vote" && method === "GET") {
    const bundle = await getConfigBundle(env);
    return json(await buildVoteSummary(env, bundle), 200, cors);
  }
  if (path === "/api/public/tech-vote" && method === "POST") {
    const body = await readJsonObject(request, 32_000);
    const voterId = boundedText(body.voterId, "voterId", 128);
    if (!/^[A-Za-z0-9._:-]+$/.test(voterId)) {
      return problem("Invalid voterId", 400, "invalid_voter_id");
    }
    const voterName =
      typeof body.voterName === "string" ? body.voterName.trim().slice(0, 30) : "";
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
    const requestedSelections = [
      ...new Set(
        body.selections
          .map((value) => String(value))
          .filter((value) => allowed.has(value))
      )
    ];
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
      maximum: 6
    });
    if (!normalized.selections.length || normalized.error) {
      return problem(
        normalized.error ?? "每人请选择 1 至 6 项开放投票的科技",
        400,
        "invalid_selections"
      );
    }
    const selections = normalized.selections;
    if (selections.length > 6) {
      return problem("每人请选择 1 至 6 项开放投票的科技", 400, "invalid_selections");
    }
    await saveBallot(env, {
      pollDate: summary.pollDate,
      voterId,
      voterName,
      selections
    });
    return json(await buildVoteSummary(env, bundle), 200, cors);
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
  if (path === "/api/admin/bootstrap" && method === "GET") {
    return json(await buildAdminBootstrap(env, session));
  }
  if (path === "/api/admin/temp-keys" && method === "POST") {
    const body = await readJsonObject(request, 32_000);
    const name = boundedText(body.name, "name", 80);
    const expiresAt = boundedText(body.expiresAt, "expiresAt", 40);
    const expiry = new Date(expiresAt);
    const now = Date.now();
    if (
      Number.isNaN(expiry.getTime()) ||
      expiry.getTime() < now + 5 * 60_000 ||
      expiry.getTime() > now + 366 * 24 * 60 * 60_000
    ) {
      return problem("有效期必须在 5 分钟至 366 天之间", 400, "invalid_expiry");
    }
    if (!Array.isArray(body.permissions)) {
      return problem("permissions must be an array", 400);
    }
    const allowed = new Set<string>(ADMIN_PERMISSIONS);
    const permissions = [
      ...new Set(body.permissions.map(String).filter((item) => allowed.has(item)))
    ];
    if (permissions.length !== body.permissions.length) {
      return problem("包含未知权限", 400, "invalid_permission");
    }
    const issued = await issueTemporaryKey(env, {
      name,
      expiresAt: expiry.toISOString(),
      permissions,
      createdBy: session.email
    });
    return json(
      {
        ...issued,
        name,
        expiresAt: expiry.toISOString(),
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
  if (path === "/api/admin/config" && method === "PUT") {
    const current = await getConfigBundle(env);
    const next = validateConfigBundle(await readJsonObject(request, 300_000));
    const kickPolicyChanged =
      current.campConfig.automaticKickEnabled !==
        next.campConfig.automaticKickEnabled ||
      current.campConfig.automaticKickGraceDays !==
        next.campConfig.automaticKickGraceDays;
    if (kickPolicyChanged && !hasPermission(session, "member:kick")) {
      return problem(
        "修改自动踢出策略需要 member:kick 权限",
        403,
        "member_kick_permission_required"
      );
    }
    await saveConfigBundle(env, next);
    return json(await buildAdminBootstrap(env, session));
  }
  if (path === "/api/admin/run" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const taskKeyValue = boundedText(body.taskKey, "taskKey", 80);
    if (!isTaskKey(taskKeyValue)) return problem("Unknown taskKey", 400, "unknown_task");
    if (
      ![
        "tech_switch",
        "contribution_sync",
        "inactivity_sync",
        "member_profile_sync",
        "patrol"
      ].includes(taskKeyValue)
    ) {
      return problem("该任务不在管理员通用流程列表中", 400, "task_not_available");
    }
    const bundle = await getConfigBundle(env);
    const result = await enqueueTask(env, {
      bundle,
      taskKey: taskKeyValue,
      triggerMode: "manual",
      requestedBy: session
    });
    return json(result, 201);
  }
  if (path === "/api/admin/kick-member" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const memberName = boundedText(body.memberName, "memberName", 80);
    if (body.confirmMemberName !== memberName) {
      return problem("必须完整输入成员姓名确认", 400, "member_confirmation_required");
    }
    const bundle = await getConfigBundle(env);
    const currentMember = (await listMembers(env)).find(
      (item) => item.name === memberName
    );
    if (!currentMember) return problem("成员不在最新名单中", 404, "member_not_current");
    const result = await enqueueTask(env, {
      bundle,
      taskKey: "kick_member",
      triggerMode: "manual",
      requestedBy: session,
      payloadDetail: { memberName, destructiveConfirmation: true }
    });
    return json(result, 201);
  }
  if (path === "/api/admin/auto-kick-evaluate" && method === "POST") {
    const bundle = await getConfigBundle(env);
    if (!bundle.campConfig.automaticKickEnabled) {
      return problem("自动斩杀当前未开启", 409, "automatic_kick_disabled");
    }
    const members = await listMembers(env);
    const candidates = automaticKickCandidates(bundle, members);
    if (!candidates.length) return json({ run: null, candidates: [] });
    const result = await enqueueTask(env, {
      bundle,
      taskKey: "kick_inactive_members",
      triggerMode: "manual",
      requestedBy: session,
      payloadDetail: {
        memberNames: candidates.map((member) => member.name),
        thresholdDays:
          bundle.campConfig.inactivityWarningDays +
          bundle.campConfig.automaticKickGraceDays,
        destructiveConfirmation: true
      }
    });
    return json({ ...result, candidates }, 201);
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
    return json({ events: await listRunEvents(env, runId) });
  }
  return problem("Not found", 404, "not_found");
}

async function handleAgentApi(
  request: Request,
  env: Env,
  path: string,
  method: string
): Promise<Response> {
  if (path === "/api/agent/heartbeat" && method === "POST") {
    const body = await readJsonObject(request, 64_000);
    const activeTaskValue =
      typeof body.activeTaskKey === "string" ? body.activeTaskKey : null;
    const activeTaskKey: TaskKey | null =
      activeTaskValue && isTaskKey(activeTaskValue) ? activeTaskValue : null;
    await touchHeartbeat(env, {
      agentId: boundedText(body.agentId, "agentId", 80),
      activeRunId:
        typeof body.activeRunId === "string" ? body.activeRunId.slice(0, 80) : null,
      activeTaskKey,
      status: boundedText(body.status, "status", 40),
      capabilities: body.capabilities ?? {},
      detail: body.detail ?? {}
    });
    return json({ ok: true });
  }
  if (path === "/api/agent/next-command" && method === "POST") {
    const body = await readJsonObject(request, 16_000);
    const command = await claimNextCommand(env, {
      agentId: boundedText(body.agentId, "agentId", 80),
      busy: body.busy === true
    });
    const bundle = await getConfigBundle(env);
    return json({
      command: command
        ? {
            id: command.id,
            runId: command.run_id,
            type: command.type,
            payload: safeParseJson(command.payload_json, {}),
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
    return json({
      configBundle: await getConfigBundle(env),
      heartbeat: await getHeartbeat(env, agentId),
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
    if (type === "members") {
      const members = sanitizeMembers(body.payload);
      const bundle = await getConfigBundle(env);
      await replaceMemberSnapshot(env, {
        runId,
        snapshotDate: zonedDateKey(new Date(capturedAt), bundle.automationConfig.timezone),
        capturedAt,
        members
      });
      await enqueueAutomaticKickIfNeeded(env, bundle, runId, capturedAt, members);
      return json({ ok: true, count: members.length });
    }
    if (type === "contribution") {
      const members = sanitizeContribution(body.payload);
      await updateContributionSnapshot(env, { runId, capturedAt, members });
      return json({ ok: true, count: members.length });
    }
    if (type === "activity") {
      const members = sanitizeActivity(body.payload);
      await updateActivitySnapshot(env, { runId, capturedAt, members });
      const bundle = await getConfigBundle(env);
      await enqueueAutomaticKickIfNeeded(env, bundle, runId, capturedAt, members);
      return json({ ok: true, count: members.length });
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
      await replaceStaffSnapshot(env, { runId, capturedAt, staff });
      return json({ ok: true, count: staff.length });
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

async function buildPublicBootstrap(env: Env): Promise<Record<string, unknown>> {
  const bundle = await getConfigBundle(env);
  const [voteSummary, staff, members, recentRuns] = await Promise.all([
    buildVoteSummary(env, bundle),
    listStaff(env),
    bundle.campConfig.publicMembersEnabled ? listMembers(env) : Promise.resolve([]),
    listRecentRuns(env, 12)
  ]);
  return {
    siteName: bundle.campConfig.publicSiteName,
    publicOverview: bundle.publicOverview,
    campConfig: {
      campName: bundle.campConfig.campName,
      serverName: bundle.campConfig.serverName,
      currentCampType: bundle.campConfig.currentCampType,
      timezone: bundle.campConfig.timezone,
      gameResetTime: bundle.campConfig.gameResetTime,
      voteWindowStart: bundle.campConfig.voteWindowStart,
      voteWindowEnd: bundle.campConfig.voteWindowEnd,
      inactivityWarningDays: bundle.campConfig.inactivityWarningDays
    },
    inactivityWarnings: members
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
    voteSummary,
    staffAssignments: staff,
    members,
    recentRuns: recentRuns.filter(isCurrentFeatureRun).map(publicRun)
  };
}

async function buildAdminBootstrap(
  env: Env,
  session: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSession>>>
): Promise<Record<string, unknown>> {
  const bundle = await getConfigBundle(env);
  const [voteSummary, heartbeats, recentRuns, staff, members] = await Promise.all([
    buildVoteSummary(env, bundle),
    listHeartbeats(env),
    listRecentRuns(env, 100),
    listStaff(env),
    listMembers(env)
  ]);
  return {
    session: {
      email: session.email,
      displayName: session.display_name,
      csrfToken: session.csrf_token,
      authMethod: session.auth_method,
      permissions: sessionPermissions(session),
      expiresAt: session.expires_at
    },
    configBundle: bundle,
    voteSummary,
    heartbeats,
    recentRuns: recentRuns.filter(isCurrentFeatureRun),
    staffAssignments: staff,
    members,
    autoKickCandidates: automaticKickCandidates(bundle, members),
    agentOnlineThresholdSeconds: Math.max(
      45,
      bundle.automationConfig.agentPolling.idleSeconds * 2 + 30
    ),
    temporaryKeys: hasPermission(session, "keys:manage")
      ? await listTemporaryKeys(env)
      : [],
    nextTechnologyTargetDate: nextTechnologyTargetDate(
      new Date(),
      bundle.automationConfig.timezone,
      bundle.automationConfig.tasks.tech_switch.time,
      bundle.campConfig.gameResetTime
    )
  };
}

function isCurrentFeatureRun(run: { task_key: string }): boolean {
  return (
    run.task_key !== "brick_transport" &&
    run.task_key !== "weekly_schedule_update"
  );
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

function automaticKickCandidates(
  bundle: ConfigBundle,
  members: Record<string, unknown>[]
): Record<string, unknown>[] {
  if (!bundle.campConfig.automaticKickEnabled) return [];
  const threshold =
    bundle.campConfig.inactivityWarningDays +
    bundle.campConfig.automaticKickGraceDays;
  return members
    .filter(
      (member) => {
        const days = member.inactive_days ?? member.inactiveDays;
        return typeof days === "number" && days >= threshold;
      }
    )
    .sort(
      (left, right) =>
        Number(right.inactive_days ?? right.inactiveDays) -
          Number(left.inactive_days ?? left.inactiveDays) ||
        String(left.name).localeCompare(String(right.name))
    );
}

async function enqueueAutomaticKickIfNeeded(
  env: Env,
  bundle: ConfigBundle,
  sourceRunId: string,
  capturedAt: string,
  observedMembers: Record<string, unknown>[]
): Promise<void> {
  const candidates = automaticKickCandidates(bundle, observedMembers);
  if (!candidates.length) return;
  const thresholdDays =
    bundle.campConfig.inactivityWarningDays +
    bundle.campConfig.automaticKickGraceDays;
  await enqueueTask(env, {
    bundle,
    taskKey: "kick_inactive_members",
    triggerMode: "scheduled",
    scheduleKey: `auto-kick:${sourceRunId}`,
    localDate: zonedDateKey(new Date(capturedAt), bundle.automationConfig.timezone),
    payloadDetail: {
      memberNames: candidates.map((member) => member.name),
      thresholdDays,
      sourceRunId,
      destructiveConfirmation: true
    }
  });
}

function permissionForAdminRequest(
  path: string,
  method: string
): (typeof ADMIN_PERMISSIONS)[number] | null {
  if (method === "PUT" && path === "/api/admin/config") return "config:write";
  if (method === "POST" && path === "/api/admin/run") return "task:run";
  if (method === "POST" && path === "/api/admin/interrupt") return "task:interrupt";
  if (method === "POST" && path === "/api/admin/kick-member") return "member:kick";
  if (method === "POST" && path === "/api/admin/auto-kick-evaluate") {
    return "member:kick";
  }
  if (
    path === "/api/admin/temp-keys" ||
    path === "/api/admin/temp-keys/revoke"
  ) {
    return "keys:manage";
  }
  return null;
}

function publicRun(run: Awaited<ReturnType<typeof listRecentRuns>>[number]) {
  return {
    id: run.id,
    taskKey: run.task_key,
    state: run.state,
    message: run.message,
    progress: run.progress,
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
      "failed",
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
      campTitle: nullableText(item.campTitle, 80)
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
