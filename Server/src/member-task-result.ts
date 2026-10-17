export const MEMBER_TASK_RESULT_FORMAT = "yla-member-task-result/v1";

const TASK_MEMBER_FIELDS: Record<string, string[]> = {
  contribution_sync: [
    "name",
    "weeklyContribution",
    "technologyPointsUsed",
    "materialContribution"
  ],
  inactivity_sync: ["name", "lastActiveText", "inactiveDays"],
  weekly_activity_sync: ["name", "weeklyActivityPoints"],
  member_profile_sync: [
    "name",
    "profession",
    "manorLevel",
    "roommateName",
    "campTitle",
    "weeklyContribution"
  ]
};

const TASK_TITLES: Record<string, string> = {
  contribution_sync: "更新贡献",
  inactivity_sync: "更新斩杀预警",
  member_profile_sync: "更新成员资料",
  weekly_activity_sync: "更新周活跃点"
};

export type ParsedMemberTaskResult = {
  taskKey: keyof typeof TASK_MEMBER_FIELDS;
  taskTitle: string;
  runId: string;
  capturedAt: string;
  payload: unknown;
  memberCount: number;
  staffCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: unknown,
  expected: string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label}字段与任务结果格式不符`);
  }
  return value;
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label}必须是 1 至 ${max} 个字符的文本`);
  }
  return value;
}

function requireNullableText(value: unknown, label: string, max: number): void {
  if (value !== null && (typeof value !== "string" || value.length > max)) {
    throw new Error(`${label}必须是文本或 null，且不超过 ${max} 个字符`);
  }
}

function requireInteger(value: unknown, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new Error(`${label}必须是 0 至 ${max} 的整数`);
  }
}

function requireNullableInteger(value: unknown, label: string, max: number): void {
  if (value !== null) requireInteger(value, label, max);
}

function requireNullablePage(value: unknown, label: string): void {
  if (value !== null && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 24)) {
    throw new Error(`${label}必须是 1 至 24 的整数或 null`);
  }
}

function validateMemberRows(taskKey: string, value: unknown): number {
  const maximum = taskKey === "member_profile_sync" ? 120 : 200;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`成员数据必须是最多 ${maximum} 行的数组`);
  }
  if (taskKey !== "inactivity_sync" && value.length === 0) {
    throw new Error("成员数据不能为空");
  }
  for (let index = 0; index < value.length; index += 1) {
    const label = `第 ${index + 1} 行`;
    const fields = TASK_MEMBER_FIELDS[taskKey];
    if (!fields) throw new Error("不支持的任务类型");
    const item = requireExactKeys(value[index], fields, label);
    requireText(item.name, `${label}成员名称`, 80);
    switch (taskKey) {
      case "contribution_sync":
        requireInteger(item.weeklyContribution, `${label}本周贡献`, 1_000_000_000);
        requireInteger(item.technologyPointsUsed, `${label}使用科技点`, 10_000_000_000);
        requireInteger(item.materialContribution, `${label}贡献物资`, 100_000_000_000);
        break;
      case "inactivity_sync":
        requireNullableText(item.lastActiveText, `${label}最后活跃时间`, 80);
        requireNullableInteger(item.inactiveDays, `${label}离线天数`, 100_000);
        break;
      case "weekly_activity_sync":
        requireInteger(item.weeklyActivityPoints, `${label}周活跃点`, 1_000_000_000);
        break;
      case "member_profile_sync":
        requireNullableText(item.profession, `${label}职业`, 80);
        requireNullableInteger(item.manorLevel, `${label}庄园等级`, 1000);
        requireNullableText(item.roommateName, `${label}同居`, 80);
        requireNullableText(item.campTitle, `${label}营地称号`, 80);
        requireInteger(item.weeklyContribution, `${label}本周贡献`, 1_000_000_000);
        break;
    }
  }
  return value.length;
}

function validateStaffRows(value: unknown): number {
  if (!Array.isArray(value) || value.length > 11) {
    throw new Error("公职数据必须是最多 11 行的数组");
  }
  for (let index = 0; index < value.length; index += 1) {
    const label = `第 ${index + 1} 项公职`;
    const item = requireExactKeys(value[index], ["roleKey", "roleName", "memberName"], label);
    requireText(item.roleKey, `${label}标识`, 80);
    requireText(item.roleName, `${label}名称`, 80);
    requireNullableText(item.memberName, `${label}成员`, 80);
  }
  return value.length;
}

function validateMemberSummary(value: unknown, memberCount: number): void {
  const summary = requireExactKeys(
    value,
    [
      "expectedCount",
      "recognizedCount",
      "missingCount",
      "missingAllowed",
      "finalPage",
      "pages",
      "positionLocked"
    ],
    "成员人数摘要"
  );
  requireInteger(summary.expectedCount, "预期成员数", 120);
  requireInteger(summary.recognizedCount, "识别成员数", 120);
  requireInteger(summary.missingCount, "缺失成员数", 120);
  requireNullablePage(summary.finalPage, "末页");
  requireNullablePage(summary.pages, "总页数");
  if (
    typeof summary.missingAllowed !== "boolean" ||
    typeof summary.positionLocked !== "boolean" ||
    Number(summary.recognizedCount) !== memberCount ||
    Number(summary.missingCount) !== Number(summary.expectedCount) - memberCount ||
    Number(summary.expectedCount) < 1 ||
    (summary.missingAllowed !== true && Number(summary.missingCount) !== 0) ||
    (summary.missingAllowed === true && Number(summary.missingCount) !== 1)
  ) {
    throw new Error("成员人数摘要与成员资料行数不一致");
  }
}

export function parseMemberTaskResultDocument(text: unknown): ParsedMemberTaskResult {
  if (typeof text !== "string" || text.length > 950_000) {
    throw new Error("请粘贴完整的 Agent 任务结果文档（不超过 950 KB）");
  }
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const match = /^# Agent 任务结果\n\n<!-- yla-member-task-result:v1 -->\n\n此文档记录本次任务读取并上传的成员数据。可以在 Agent 内或其他编辑器中修改；Workers 仅接受格式正确的版本。\n\n```json\n([\s\S]+)\n```$/u.exec(normalized);
  if (!match) {
    throw new Error("文档格式不符：请保留 Agent 任务结果标题、版本标记和唯一的 JSON 数据块");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(match[1]!);
  } catch {
    throw new Error("JSON 数据块无法解析，请修正文档后重新校验");
  }
  const document = requireExactKeys(
    decoded,
    ["format", "taskKey", "runId", "capturedAt", "payload"],
    "任务结果"
  );
  if (document.format !== MEMBER_TASK_RESULT_FORMAT) {
    throw new Error("任务结果版本不受支持");
  }
  const taskKey = document.taskKey;
  if (typeof taskKey !== "string" || !Object.hasOwn(TASK_TITLES, taskKey)) {
    throw new Error("任务类型不受支持");
  }
  const runId = requireText(document.runId, "任务编号", 80);
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) throw new Error("任务编号格式不正确");
  const capturedAt = requireText(document.capturedAt, "采集时间", 40);
  const parsedDate = new Date(capturedAt);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== capturedAt) {
    throw new Error("采集时间必须是 ISO 8601 UTC 时间");
  }

  let memberCount = 0;
  let staffCount = 0;
  if (taskKey === "member_profile_sync") {
    const payload = requireExactKeys(
      document.payload,
      ["members", "staff", "memberSummary"],
      "成员资料任务数据"
    );
    memberCount = validateMemberRows(taskKey, payload.members);
    staffCount = validateStaffRows(payload.staff);
    validateMemberSummary(payload.memberSummary, memberCount);
  } else {
    memberCount = validateMemberRows(taskKey, document.payload);
  }
  return {
    taskKey: taskKey as ParsedMemberTaskResult["taskKey"],
    taskTitle: TASK_TITLES[taskKey]!,
    runId,
    capturedAt,
    payload: document.payload,
    memberCount,
    staffCount
  };
}
