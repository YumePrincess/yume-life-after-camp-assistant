import { isPlausibleMemberName } from "./member-name.mjs";

export function parseTable(observations, definition) {
  const region = definition.region;
  const visible = observations
    .filter((item) => inside(item, region))
    .sort((a, b) => centerY(a) - centerY(b) || a.x - b.x);
  const medianHeight = median(visible.map((item) => item.height)) || 24;
  const fixedRowHeight = Number(definition.pagination?.rowHeightPx);
  const fixedRowAnchor = Number(
    definition.rowAnchorTop ?? definition.pagination?.rowAnchorTop
  );
  const useFixedRowSlots =
    Number.isFinite(fixedRowHeight) &&
    fixedRowHeight > 0 &&
    Number.isFinite(fixedRowAnchor);
  const rows = [];
  for (const item of visible) {
    const y = centerY(item);
    const slot = useFixedRowSlots
      ? Math.floor((y - fixedRowAnchor) / fixedRowHeight)
      : null;
    let row = rows.find((candidate) =>
      useFixedRowSlots
        ? candidate.slot === slot
        : Math.abs(candidate.y - y) <= medianHeight * 0.7
    );
    if (!row) {
      row = { y, items: [], slot };
      rows.push(row);
    }
    row.items.push(item);
    row.y = row.items.reduce((sum, value) => sum + centerY(value), 0) / row.items.length;
  }

  const width = region.right - region.left;
  const bounds = definition.columns.map((column) => ({
    ...column,
    leftPx: region.left + width * column.left,
    rightPx: region.left + width * column.right
  }));
  return rows
    .sort((a, b) => a.y - b.y)
    .map((row) => {
      const output = Object.fromEntries(bounds.map((column) => [column.key, []]));
      for (const item of row.items.sort((a, b) => a.x - b.x)) {
        const fragments = splitNumericAcrossColumns(item, bounds);
        if (fragments) {
          for (const [key, value] of Object.entries(fragments)) {
            if (value) output[key].push(value);
          }
          continue;
        }
        const column = bounds.find(
          (candidate) =>
            centerX(item) >= candidate.leftPx && centerX(item) < candidate.rightPx
        );
        if (column) output[column.key].push(item.text.trim());
      }
      const normalized = {};
      for (const column of bounds) {
        const values = output[column.key];
        if (column.stackedKeys) {
          const stackedValues = row.items
            .filter(
              (item) =>
                centerX(item) >= column.leftPx && centerX(item) < column.rightPx
            )
            .sort((a, b) => centerY(a) - centerY(b))
            .map((item) => item.text.trim());
          for (const [index, key] of column.stackedKeys.entries()) {
            normalized[key] = stackedValues[index] || "";
          }
        } else {
          normalized[column.key] = values.join(" ").trim();
        }
      }
      return normalized;
    })
    .filter((row) => Object.values(row).some(Boolean));
}

export function normalizeMembers(contributionRows, detailRows, activityRows = []) {
  const combined = [];
  for (const row of contributionRows) {
    const name = clean(row.name);
    if (
      !isPlausibleMemberName(name) ||
      /玩家名|成员|姓名|贡献|职业/.test(name)
    ) continue;
    combined.push({ ...row, name });
  }
  for (const row of detailRows) {
    const name = clean(row.name);
    if (
      !isPlausibleMemberName(name) ||
      /成员|姓名|贡献|职业/.test(name)
    ) continue;
    const match = exactMember(combined, name);
    if (match) Object.assign(match, row, { name: match.name });
    else combined.push({ ...row, name });
  }
  for (const row of activityRows) {
    const name = clean(row.name);
    if (!name || /成员|姓名|在线情况|职业/.test(name)) continue;
    const match = exactMember(combined, name);
    const normalized = {
      ...row,
      name,
      lastActiveText: clean(row.onlineState) || null,
      inactiveDays: parseInactiveDays(row.onlineState)
    };
    if (match) Object.assign(match, normalized, { name: match.name });
    else combined.push(normalized);
  }
  return combined.map((row) => ({
    name: row.name,
    profession: clean(row.profession) || null,
    manorLevel: integer(row.manorLevel),
    roommateName: clean(row.roommateName) || null,
    campTitle: clean(row.campTitle) || null,
    weeklyContribution: integer(row.weeklyContribution) || 0,
    technologyPointsUsed: integer(row.technologyPointsUsed) || 0,
    materialContribution: integer(row.materialContribution) || 0,
    lastActiveText: clean(row.lastActiveText || row.onlineState) || null,
    inactiveDays:
      row.inactiveDays == null
        ? parseInactiveDays(row.lastActiveText || row.onlineState)
        : row.inactiveDays
  }));
}

export function normalizeActivity(rows) {
  return rows
    .map((row) => ({
      name: clean(row.name),
      lastActiveText: clean(row.onlineState) || null,
      inactiveDays: parseInactiveDays(row.onlineState)
    }))
    .filter(
      (row) =>
        isPlausibleMemberName(row.name) &&
        !/全部成员|在线情况|姓名/.test(row.name)
    );
}

export function normalizeContribution(rows) {
  return normalizeMembers(rows, []).map(
    ({
      name,
      weeklyContribution,
      technologyPointsUsed,
      materialContribution
    }) => ({
      name,
      weeklyContribution,
      technologyPointsUsed,
      materialContribution
    })
  );
}

export function normalizeProfiles(rows) {
  // The profile task is authoritative for the roster. The table workflow has
  // already scanned to the bottom, reconciled OCR variants, and capped the
  // result to the page header total before this field-only conversion. Do not
  // apply the contribution/activity name filters here: a legitimate display
  // name may contain words such as “成员”, or consist only of symbols.
  return rows
    .map((row) => {
      const name = clean(row.name);
      if (!name) return null;
      return {
        name,
        profession: clean(row.profession) || null,
        manorLevel: integer(row.manorLevel),
        roommateName: clean(row.roommateName) || null,
        campTitle: clean(row.campTitle) || null,
        weeklyContribution: integer(row.weeklyContribution) || 0
      };
    })
    .filter(Boolean);
}

export function parseInactiveDays(value) {
  const text = clean(value).normalize("NFKC");
  if (!text) return null;
  if (/在线|刚刚|分钟|小时|今日|今天/.test(text)) return 0;
  if (/昨日|昨天/.test(text)) return 1;
  const amount = Number(text.match(/\d+/)?.[0] || 0);
  if (!amount) return null;
  if (/天/.test(text)) return amount;
  if (/周|星期/.test(text)) return amount * 7;
  if (/月/.test(text)) return amount * 30;
  if (/年/.test(text)) return amount * 365;
  return null;
}

function exactMember(rows, name) {
  const wanted = exactNameKey(name);
  return rows.find((row) => exactNameKey(row.name) === wanted) || null;
}

function exactNameKey(value) {
  return clean(value)
    .normalize("NFKC")
    .toLowerCase();
}

export function normalizeStaff(rows) {
  return rows
    .map((row) => ({
      roleKey: slug(clean(row.roleName)),
      roleName: clean(row.roleName),
      memberName: clean(row.memberName) || null
    }))
    .filter((row) => row.roleKey && row.roleName && !/公职|职位|成员/.test(row.roleName));
}

export function normalizeStaffGrid(observations, definition) {
  return definition.slots
    .map((slot, index) => {
      const items = observations
        .filter((item) => inside(item, slot.region))
        .sort((a, b) => centerY(a) - centerY(b) || a.x - b.x);
      const member = items.find(
        (item) => !/市长|返回|公职人员|基础信息/.test(clean(item.text))
      );
      if (!member) return null;
      return {
        roleKey: slot.roleKey || `staff-${index + 1}`,
        roleName: slot.roleName || `公职席位 ${index + 1}`,
        memberName: clean(member.text)
      };
    })
    .filter(Boolean);
}

function splitNumericAcrossColumns(item, columns) {
  const digits = String(item.text || "").replace(/[,\s]/g, "");
  if (!/^\d{2,}$/.test(digits) || item.width <= 0) return null;
  const startColumn = columns.findIndex(
    (column) => item.x >= column.leftPx && item.x < column.rightPx
  );
  const endX = item.x + item.width;
  const endColumn = columns.findIndex(
    (column) => endX > column.leftPx && endX <= column.rightPx
  );
  if (startColumn < 0 || endColumn < 0 || startColumn === endColumn) return null;

  const fragments = {};
  const characterWidth = item.width / digits.length;
  for (let index = 0; index < digits.length; index += 1) {
    const x = item.x + (index + 0.5) * characterWidth;
    const column = columns.find(
      (candidate) => x >= candidate.leftPx && x < candidate.rightPx
    );
    if (column) fragments[column.key] = `${fragments[column.key] || ""}${digits[index]}`;
  }
  return fragments;
}

function inside(item, region) {
  const x = centerX(item);
  const y = centerY(item);
  return x >= region.left && x <= region.right && y >= region.top && y <= region.bottom;
}

function centerX(item) {
  return item.x + item.width / 2;
}

function centerY(item) {
  return item.y + item.height / 2;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function integer(value) {
  const match = clean(value).replaceAll(",", "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function slug(value) {
  return Buffer.from(value || "", "utf8").toString("base64url").slice(0, 70);
}
