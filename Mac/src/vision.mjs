import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAC_ROOT } from "./config.mjs";
import { runFile } from "./process.mjs";
import { LocalVisionAdvisor } from "./local-vision-advisor.mjs";
import { parseTable } from "./table-parser.mjs";

export class Vision {
  constructor(config, adb) {
    this.config = config;
    this.adb = adb;
    this.sequence = 0;
    this.snapshotDir = resolve(MAC_ROOT, "snapshots");
    this.taskPaths = new Set();
    this.advisor = new LocalVisionAdvisor(config.localVisionModel);
  }

  beginTask() {
    this.taskPaths.clear();
  }

  async capture(label = "screen", signal) {
    return this.#capture(label, signal, false);
  }

  async captureTransient(label = "screen", signal) {
    return this.#capture(label, signal, true);
  }

  async captureAccurateTransient(label = "screen", signal) {
    return this.#capture(label, signal, true, "accurate");
  }

  async captureAccurate(label = "screen", signal) {
    return this.#capture(label, signal, false, "accurate");
  }

  async startAdvisor(signal) {
    return this.advisor.start(signal);
  }

  async stopAdvisor() {
    return this.advisor.stop();
  }

  async adviseCurrent(label, context = {}, signal) {
    if (!this.advisor.enabled) return null;
    await mkdir(this.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const path = resolve(
      this.snapshotDir,
      `${stamp}-${String(++this.sequence).padStart(4, "0")}-${safe(label)}-advisor.png`
    );
    await this.adb.screenshot(path);
    this.taskPaths.add(path);
    try {
      return await this.advisor.analyze(path, context, signal);
    } finally {
      this.taskPaths.delete(path);
      await rm(path, { force: true });
    }
  }

  async extractTableRows(imagePath, definition, label, signal) {
    if (!this.advisor.enabled) return [];
    const columnKeys = definition.columns.map((column) => column.key);
    const isContribution =
      columnKeys.length === 4 &&
      [
        "name",
        "weeklyContribution",
        "technologyPointsUsed",
        "materialContribution"
      ].every((key) => columnKeys.includes(key));
    if (isContribution) {
      return this.#extractContributionRows(
        imagePath,
        definition,
        label,
        signal
      );
    }
    const isMemberDetails = [
      "identity",
      "profession",
      "manorLevel",
      "onlineState",
      "roommateName"
    ].every((key) => columnKeys.includes(key));
    if (isMemberDetails) {
      return this.#extractMemberRows(imagePath, definition, label, signal);
    }
    return [];
  }

  async extractStaffRows(imagePath, signal) {
    const advised = await this.advisor.extractStaff(imagePath, signal);
    const slotKeys = {
      mayor: "mayor",
      top1: "staff-1",
      top2: "staff-2",
      top3: "staff-3",
      top4: "staff-4",
      bottom1: "staff-5",
      bottom2: "staff-6"
    };
    return advised.map((item, index) => ({
      roleKey:
        slotKeys[item.slot] ||
        (item.slot.startsWith("staff")
          ? `staff-${item.slot.slice(5)}`
          : `staff-${index + 1}`),
      roleName:
        item.slot === "mayor"
          ? "市长"
          : item.campTitle || `公职席位 ${index + 1}`,
      memberName: item.name,
      campTitle: item.campTitle || null
    }));
  }

  async readMemberExpectedTotal(signal) {
    const frame = await this.capture("member-count-header", signal);
    let observations = [];
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        observations = await this.ocrRegion(
          frame.path,
          { left: 100, top: 220, right: 680, bottom: 320 },
          `member-count-header-${attempt}`,
          signal,
          "accurate",
          0.25
        );
        if (observations.length) break;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    if (!observations.length && lastError) throw lastError;
    const totals = observations
      .flatMap((item) =>
        [...String(item.text || "").matchAll(/\d+\s*\/\s*(\d+)/g)].map(
          (match) => ({
            x: item.x,
            digits: match[1],
            value: Number.parseInt(match[1], 10)
          })
        )
      )
      .sort((left, right) => left.x - right.x);
    const memberTotal = totals.find(
      (item) => item.x < 440 && item.value > 0 && item.value <= 110
    )?.value;
    const citizenCandidate = totals.find((item) => item.x >= 440);
    const citizenTotal = normalizeCitizenTotal(citizenCandidate);
    if (!memberTotal || !citizenTotal) {
      throw new Error(
        `MEMBER_COUNT_UNREADABLE: expected member and citizen totals, OCR=${JSON.stringify(observations.map((item) => item.text))}`
      );
    }
    return memberTotal + citizenTotal;
  }

  async #extractContributionRows(imagePath, definition, label, signal) {
    let observations = await this.ocrRegion(
      imagePath,
      definition.region,
      `${label}-values`,
      signal,
      "accurate",
      0.25
    );
    const rows = parseTable(observations, definition);
    const region = definition.region;
    const nameColumn = definition.columns.find(
      (column) => column.key === "name"
    );
    const tableWidth = region.right - region.left;
    const nameRight =
      region.left + tableWidth * (nameColumn?.right ?? 0.32);
    const width = Math.max(1, Math.round(nameRight - region.left));
    const height = Math.max(1, Math.round(region.bottom - region.top));
    const cropPath = resolve(
      this.snapshotDir,
      `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-name-crop.png`
    );
    this.taskPaths.add(cropPath);
    try {
      await runFile(
        "/usr/bin/sips",
        [
          "-c",
          String(height),
          String(width),
          "--cropOffset",
          String(Math.round(region.top)),
          String(Math.round(region.left)),
          imagePath,
          "--out",
          cropPath
        ],
        { timeoutMs: 30_000, signal }
      );
      const advisedNames = await this.advisor.extractNames(cropPath, signal);
      const namesByRow = new Map(
        advisedNames.map((item) => [item.row, item.name])
      );
      return rows
        .map((row, index) => ({
          ...row,
          name: row.name || namesByRow.get(index + 1) || ""
        }))
        .filter((row) => row.name);
    } finally {
      this.taskPaths.delete(cropPath);
      await rm(cropPath, { force: true });
    }
  }

  async #extractMemberRows(imagePath, definition, label, signal) {
    let observations = await this.ocrRegion(
      imagePath,
      definition.region,
      `${label}-values`,
      signal,
      "accurate",
      0.25
    );
    const region = definition.region;
    const width = region.right - region.left;
    const columnBounds = new Map(
      definition.columns.map((column) => [
        column.key,
        {
          left: region.left + width * column.left,
          right: region.left + width * column.right
        }
      ])
    );
    const onlineBounds = columnBounds.get("onlineState");
    let anchors = observations
      .filter(
        (item) =>
          centerX(item) >= onlineBounds.left &&
          centerX(item) < onlineBounds.right &&
          centerY(item) >= (definition.rowAnchorTop || region.top) &&
          /在线|离线/.test(item.text)
      )
      .map((item) => centerY(item))
      .sort((left, right) => left - right);
    if (!anchors.length) {
      const fallback = await runFile(
        this.config.vision.binary,
        [imagePath, "accurate"],
        {
          timeoutMs:
            Math.max(
              5,
              Number(this.config.vision.accurateTimeoutSeconds) || 15
            ) * 1000,
          signal
        }
      );
      observations = JSON.parse(fallback.stdout).filter((item) => {
        const x = centerX(item);
        const y = centerY(item);
        return (
          item.confidence >= 0.25 &&
          x >= region.left &&
          x < region.right &&
          y >= region.top &&
          y < region.bottom
        );
      });
      anchors = observations
        .filter(
          (item) =>
            centerX(item) >= onlineBounds.left &&
            centerX(item) < onlineBounds.right &&
            centerY(item) >= (definition.rowAnchorTop || region.top) &&
            /在线|离线/.test(item.text)
        )
        .map((item) => centerY(item))
        .sort((left, right) => left - right);
    }
    const rowsPerPage = Math.max(
      1,
      Number(definition.pagination?.rowsPerPage) || anchors.length
    );
    if (anchors.length > rowsPerPage) {
      anchors = anchors.slice(-rowsPerPage);
    }
    if (!anchors.length) return [];

    const rowSpacing =
      medianNumber(
        anchors.slice(1).map((anchor, index) => anchor - anchors[index])
      ) || 96;
    const rowData = anchors.map((anchor, index) => {
      const upper =
        index === 0
          ? Math.max(region.top, anchor - rowSpacing / 2)
          : (anchors[index - 1] + anchor) / 2;
      const lower =
        index === anchors.length - 1
          ? Math.min(region.bottom, anchor + rowSpacing / 2)
          : (anchor + anchors[index + 1]) / 2;
      const items = observations.filter((item) => {
        const y = centerY(item);
        return y >= upper && y < lower;
      });
      return {
        items,
        identity: inferMemberIdentity(
          itemsInColumn(items, columnBounds.get("identity"))
        )
      };
    });
    let advisedByRow = new Map();
    if (rowData.some((row) => !row.identity.name)) {
      const cropPath = resolve(
        this.snapshotDir,
        `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-member-crop.png`
      );
      this.taskPaths.add(cropPath);
      try {
      const cropTop = Math.max(
        region.top,
        Math.floor(anchors[0] - rowSpacing / 2)
      );
      const cropBottom = Math.min(
        region.bottom,
        Math.ceil(anchors.at(-1) + rowSpacing / 2)
      );
      await runFile(
        "/usr/bin/sips",
        [
          "-c",
          String(Math.round(cropBottom - cropTop)),
          String(Math.round(region.right - region.left)),
          "--cropOffset",
          String(Math.round(cropTop)),
          String(Math.round(region.left)),
          imagePath,
          "--out",
          cropPath
        ],
        { timeoutMs: 30_000, signal }
      );
      const advised = await this.advisor.extractMemberDetails(
        cropPath,
        anchors.length,
        signal
      );
        advisedByRow = new Map(advised.map((item) => [item.row, item]));
      } finally {
        this.taskPaths.delete(cropPath);
        await rm(cropPath, { force: true });
      }
    }
    return rowData
      .map(({ items, identity }, index) => {
        const ai = advisedByRow.get(index + 1) || {};
        return {
          name: identity.name || cleanModelText(ai.name),
          campTitle:
            identity.campTitle || cleanModelText(ai.campTitle),
          profession:
            firstColumnText(items, columnBounds.get("profession")),
          weeklyContribution:
            firstColumnText(items, columnBounds.get("weeklyContribution")) ||
            "0",
          manorLevel:
            firstColumnText(items, columnBounds.get("manorLevel")),
          onlineState:
            firstColumnText(items, columnBounds.get("onlineState")),
          scene: firstColumnText(items, columnBounds.get("scene")),
          roommateName:
            firstColumnText(items, columnBounds.get("roommateName"))
        };
      })
      .filter((row) => row.name);
  }

  async ocrRegion(
    imagePath,
    region,
    label,
    signal,
    mode = "accurate",
    minimumConfidence = this.config.vision.minimumConfidence
  ) {
    const width = Math.max(1, Math.round(region.right - region.left));
    const height = Math.max(1, Math.round(region.bottom - region.top));
    const cropPath = resolve(
      this.snapshotDir,
      `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-ocr-crop.png`
    );
    this.taskPaths.add(cropPath);
    try {
      await runFile(
        "/usr/bin/sips",
        [
          "-c",
          String(height),
          String(width),
          "--cropOffset",
          String(Math.round(region.top)),
          String(Math.round(region.left)),
          imagePath,
          "--out",
          cropPath
        ],
        { timeoutMs: 30_000, signal }
      );
      const result = await runFile(
        this.config.vision.binary,
        [cropPath, mode],
        {
          timeoutMs:
            Math.max(
              5,
              Number(this.config.vision.accurateTimeoutSeconds) || 15
            ) * 1000,
          signal
        }
      );
      return JSON.parse(result.stdout)
        .filter(
          (item) =>
            item.confidence >= minimumConfidence
        )
        .map((item) => ({
          ...item,
          x: item.x + Math.round(region.left),
          y: item.y + Math.round(region.top)
        }));
    } finally {
      this.taskPaths.delete(cropPath);
      await rm(cropPath, { force: true });
    }
  }

  async #capture(label, signal, transient, mode = this.config.vision.mode) {
    await mkdir(this.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const path = resolve(
      this.snapshotDir,
      `${stamp}-${String(++this.sequence).padStart(4, "0")}-${safe(label)}.png`
    );
    await this.adb.screenshot(path);
    this.taskPaths.add(path);
    try {
      let observations = [];
      try {
        const result = await runFile(
          this.config.vision.binary,
          [path, mode],
          {
            timeoutMs: mode === "accurate"
              ? Math.max(
                  5,
                  Number(this.config.vision.accurateTimeoutSeconds) || 15
                ) * 1000
              : 30_000,
            signal
          }
        );
        observations = JSON.parse(result.stdout).filter(
          (item) => item.confidence >= this.config.vision.minimumConfidence
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        // Vision framework failures must degrade to the guarded local model;
        // a single OCR subprocess crash must never terminate the game task.
      }
      return { path: transient ? null : path, observations };
    } finally {
      if (transient) {
        this.taskPaths.delete(path);
        await rm(path, { force: true });
      }
    }
  }

  async cleanupTask() {
    const paths = [...this.taskPaths];
    this.taskPaths.clear();
    await Promise.all(paths.map((path) => rm(path, { force: true })));
    return paths.length;
  }

  async cleanupStale(maxAgeMs = 24 * 60 * 60_000) {
    await mkdir(this.snapshotDir, { recursive: true });
    const now = Date.now();
    let removed = 0;
    for (const name of await readdir(this.snapshotDir)) {
      if (!/\.(?:png|jpe?g)$/i.test(name)) continue;
      const path = resolve(this.snapshotDir, name);
      const metadata = await stat(path).catch(() => null);
      if (metadata && now - metadata.mtimeMs >= maxAgeMs) {
        await rm(path, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  find(observations, query, mode = "includes") {
    const normalized = normalize(query);
    return observations
      .filter((item) => {
        const text = normalize(item.text);
        if (mode === "exact") return text === normalized;
        if (mode === "regex") return new RegExp(query).test(item.text);
        return text.includes(normalized);
      })
      .sort((a, b) => b.confidence - a.confidence || b.width * b.height - a.width * a.height)[0];
  }

  async probe(path, points, radius = 24, signal) {
    const encodedPoints = points.map((point) => `${point.x},${point.y}`).join(";");
    const result = await runFile(
      this.config.vision.pixelProbeBinary,
      [path, encodedPoints, String(radius)],
      { timeoutMs: 20_000, signal }
    );
    return JSON.parse(result.stdout);
  }
}

export function center(observation) {
  return {
    x: observation.x + observation.width / 2,
    y: observation.y + observation.height / 2
  };
}

function normalize(value) {
  return String(value).replace(/\s+/g, "").toLowerCase();
}

function itemsInColumn(items, bounds) {
  if (!bounds) return [];
  return items
    .filter(
      (item) =>
        centerX(item) >= bounds.left && centerX(item) < bounds.right
    )
    .sort((left, right) => centerY(left) - centerY(right) || left.x - right.x);
}

function firstColumnText(items, bounds) {
  return itemsInColumn(items, bounds)
    .map((item) => String(item.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function inferMemberIdentity(items) {
  const values = items
    .map((item) => String(item.text || "").trim())
    .filter(Boolean);
  if (!values.length) return { name: "", campTitle: "" };
  if (values.length === 1) {
    return /^(?:#|市长|营地助手)/.test(values[0])
      ? { name: "", campTitle: values[0] }
      : { name: values[0], campTitle: "" };
  }
  return { name: values[0], campTitle: values.slice(1).join(" ") };
}

function cleanModelText(value) {
  const text = String(value || "").trim();
  return /^(?:0|null|none|无)$/i.test(text) ? "" : text;
}

function medianNumber(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function normalizeCitizenTotal(candidate) {
  if (!candidate) return 0;
  if (candidate.value > 0 && candidate.value <= 10) return candidate.value;
  if (
    candidate.digits.length > 1 &&
    new Set(candidate.digits).size === 1
  ) {
    const repeated = Number.parseInt(candidate.digits[0], 10);
    return repeated > 0 && repeated <= 10 ? repeated : 0;
  }
  return 0;
}

function centerX(item) {
  return item.x + item.width / 2;
}

function centerY(item) {
  return item.y + item.height / 2;
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60);
}
