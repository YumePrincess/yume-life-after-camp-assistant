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
    this.ocrModeHealth = new Map();
    this.ocrPrewarmPromise = null;
    this.advisor = new LocalVisionAdvisor(config.localVisionModel);
  }

  ocrHealth() {
    const modes = Object.fromEntries(
      ["fast", "accurate"].map((mode) => {
        const state = this.#ocrState(mode);
        return [mode, {
          available: Date.now() >= state.disabledUntil,
          disabledUntil: state.disabledUntil || null,
          failureStreak: state.failureStreak,
          reason: state.lastFailure
        }];
      })
    );
    return {
      available: modes.fast.available || modes.accurate.available,
      disabledUntil:
        modes.fast.available || modes.accurate.available
          ? null
          : Math.min(modes.fast.disabledUntil, modes.accurate.disabledUntil),
      failureStreak: Math.max(
        modes.fast.failureStreak,
        modes.accurate.failureStreak
      ),
      reason: modes.accurate.reason || modes.fast.reason,
      modes
    };
  }

  beginTask() {
    this.taskPaths.clear();
  }

  async prewarm(signal) {
    if (this.config.vision?.prewarmEnabled === false) {
      return { skipped: true, elapsedMs: 0 };
    }
    if (!this.ocrPrewarmPromise) {
      this.ocrPrewarmPromise = this.#prewarm(signal).catch((error) => {
        this.ocrPrewarmPromise = null;
        throw error;
      });
    }
    return this.ocrPrewarmPromise;
  }

  async #prewarm(signal) {
    const startedAt = Date.now();
    const frame = await this.captureSource("ocr-prewarm", signal);
    try {
      await runFile(
        this.config.vision.binary,
        [frame.path, "fast"],
        {
          timeoutMs:
            Math.max(
              1,
              Number(this.config.vision.prewarmTimeoutSeconds) || 45
            ) * 1000,
          signal
        }
      );
      this.#recordOcrSuccess("fast");
      return { skipped: false, elapsedMs: Date.now() - startedAt };
    } finally {
      this.taskPaths.delete(frame.path);
      await rm(frame.path, { force: true });
    }
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

  async captureSource(label = "screen", signal) {
    await mkdir(this.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const path = resolve(
      this.snapshotDir,
      `${stamp}-${String(++this.sequence).padStart(4, "0")}-${safe(label)}.png`
    );
    await this.adb.screenshot(path);
    this.taskPaths.add(path);
    return { path, observations: [] };
  }

  async captureTable(label, definition, signal) {
    const configuredMinimum = Number(definition?.ocrMinimumConfidence);
    const minimumConfidence = Number.isFinite(configuredMinimum)
      ? Math.max(0.1, Math.min(0.6, configuredMinimum))
      : 0.25;
    return this.#capture(label, signal, false, this.config.vision.mode, {
      minimumConfidence
    });
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

  async adviseOverlayControlCurrent(label, context = {}, signal) {
    if (!this.advisor.enabled) return null;
    await mkdir(this.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const path = resolve(
      this.snapshotDir,
      `${stamp}-${String(++this.sequence).padStart(4, "0")}-${safe(label)}-overlay-advisor.png`
    );
    await this.adb.screenshot(path);
    this.taskPaths.add(path);
    try {
      return await this.advisor.identifyOverlayControl(path, context, signal);
    } finally {
      this.taskPaths.delete(path);
      await rm(path, { force: true });
    }
  }

  async extractTableRows(imagePath, definition, label, signal, options = {}) {
    const columnKeys = definition.columns.map((column) => column.key);
    const isActivity =
      columnKeys.length === 2 &&
      ["name", "onlineState"].every((key) => columnKeys.includes(key));
    if (isActivity) {
      return this.#extractActivityRows(
        imagePath,
        definition,
        label,
        signal
      );
    }
    if (!this.advisor.enabled) return [];
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
      return this.#extractMemberRows(
        imagePath,
        definition,
        label,
        signal,
        options
      );
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
    const countRegions = {
      members: { left: 345, top: 225, right: 430, bottom: 295 },
      citizens: { left: 470, top: 225, right: 535, bottom: 295 }
    };
    let memberObservations = [];
    let citizenObservations = [];
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        [memberObservations, citizenObservations] = await Promise.all([
          this.ocrRegion(
            frame.path,
            countRegions.members,
            `member-count-${attempt}`,
            signal,
            "accurate",
            0.2,
            5
          ),
          this.ocrRegion(
            frame.path,
            countRegions.citizens,
            `citizen-count-${attempt}`,
            signal,
            "accurate",
            0.2,
            5
          )
        ]);
        if (
          parsePopulationCapacity(memberObservations, 110) !== null &&
          parsePopulationCapacity(citizenObservations, 10) !== null
        ) {
          break;
        }
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    const memberCount = parsePopulationCapacity(memberObservations, 110);
    const citizenCount = parsePopulationCapacity(citizenObservations, 10);
    let fallbackObservations = [];
    if (memberCount === null || citizenCount === null) {
      try {
        fallbackObservations = await this.ocrRegion(
          frame.path,
          { left: 100, top: 220, right: 680, bottom: 320 },
          "member-count-header-fallback",
          signal,
          "accurate",
          0.2
        );
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    if (memberCount === null || citizenCount === null) {
      if (
        lastError &&
        !memberObservations.length &&
        !citizenObservations.length &&
        !fallbackObservations.length
      ) {
        throw lastError;
      }
      throw new Error(
        `MEMBER_COUNT_UNREADABLE: expected member and citizen current counts, OCR=${JSON.stringify({
          members: memberObservations.map((item) => item.text),
          citizens: citizenObservations.map((item) => item.text),
          fallback: fallbackObservations.map((item) => item.text)
        })}`
      );
    }
    return memberCount + citizenCount;
  }

  async #extractContributionRows(imagePath, definition, label, signal) {
    let observations = await this.ocrRegion(
      imagePath,
      definition.region,
      `${label}-values`,
      signal,
      "accurate",
      0.25,
      1,
      Math.max(1, Number(this.config.vision?.memberTableTimeoutSeconds) || 2)
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
      await this.#cropImage(
        imagePath,
        {
          left: region.left,
          top: region.top,
          right: region.left + width,
          bottom: region.top + height
        },
        cropPath,
        signal
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

  async #extractMemberRows(
    imagePath,
    definition,
    label,
    signal,
    options = {}
  ) {
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
    const rowsPerPage = Math.max(
      1,
      Number(definition.pagination?.rowsPerPage) || anchors.length
    );
    // Avoid a second full-screen OCR when the regional pass omitted the
    // online-state anchor. That fallback caused intermittent 30s stalls.
    // The table has a stable configured row count, so infer row centers from
    // the existing regional observations instead.
    if (!anchors.length && observations.length && rowsPerPage > 0) {
      const first = Math.max(
        region.top,
        Number(definition.rowAnchorTop) || region.top
      );
      const available = Math.max(1, region.bottom - first);
      const spacing = rowsPerPage > 1 ? available / rowsPerPage : available / 2;
      anchors = Array.from(
        { length: rowsPerPage },
        (_, index) => first + spacing * index
      );
    }
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
    const nativeNameCounts = new Map();
    for (const row of rowData) {
      const key = comparableVisionName(row.identity.name);
      if (key) nativeNameCounts.set(key, (nativeNameCounts.get(key) || 0) + 1);
    }
    const forceMemberAdvisor = Boolean(options.forceMemberAdvisor);
    let advisedByRow = new Map();
    if (
      forceMemberAdvisor ||
      rowData.some(
        (row) =>
          !row.identity.name ||
          nativeNameCounts.get(comparableVisionName(row.identity.name)) > 1
      )
    ) {
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
      await this.#cropImage(
        imagePath,
        {
          left: region.left,
          top: cropTop,
          right: region.right,
          bottom: cropBottom
        },
        cropPath,
        signal
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
        const nativeName = identity.name;
        const nativeNameDuplicated =
          nativeNameCounts.get(comparableVisionName(nativeName)) > 1;
        const advisedName = cleanModelText(ai.name);
        return {
          name:
            (
              forceMemberAdvisor ||
              !nativeName ||
              nativeNameDuplicated
            ) &&
            advisedName
              ? advisedName
              : nativeName,
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

  async #extractActivityRows(imagePath, definition, label, signal) {
    const observations = await this.ocrRegion(
      imagePath,
      definition.region,
      `${label}-activity-values`,
      signal,
      "accurate",
      0.25
    );
    return parseTable(observations, definition).filter(
      (row) =>
        row.name &&
        row.onlineState &&
        !definition.headerPattern.some(
          (value) =>
            row.name.includes(value) ||
            row.onlineState.includes(value)
        )
    );
  }

  async ocrRegion(
    imagePath,
    region,
    label,
    signal,
    mode = "accurate",
    minimumConfidence = this.config.vision.minimumConfidence,
    scale = 1,
    timeoutSeconds = null
  ) {
    this.#assertOcrAvailable(mode);
    await mkdir(this.snapshotDir, { recursive: true });
    const width = Math.max(1, Math.round(region.right - region.left));
    const height = Math.max(1, Math.round(region.bottom - region.top));
    const cropPath = resolve(
      this.snapshotDir,
      `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-ocr-crop.png`
    );
    this.taskPaths.add(cropPath);
    let inputPath = cropPath;
    let scaledPath = null;
    try {
      const crop = await this.#cropImage(
        imagePath,
        region,
        cropPath,
        signal
      );
      const safeScale = Math.max(1, Math.min(8, Number(scale) || 1));
      if (safeScale > 1) {
        scaledPath = resolve(
          this.snapshotDir,
          `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-ocr-scaled.png`
        );
        this.taskPaths.add(scaledPath);
        await runFile(
          "/usr/bin/sips",
          [
            "--resampleWidth",
            String(Math.round(width * safeScale)),
            cropPath,
            "--out",
            scaledPath
          ],
          { timeoutMs: 30_000, signal }
        );
        if (crop.adjusted) {
          await this.#assertImageDimensions(
            scaledPath,
            Math.round(width * safeScale),
            Math.round(height * safeScale),
            signal,
            label
          );
        }
        inputPath = scaledPath;
      }
      let result;
      try {
        result = await runFile(
          this.config.vision.binary,
          [inputPath, mode],
          {
            timeoutMs:
              Math.max(
                1,
                Number(timeoutSeconds) ||
                  (mode === "fast"
                    ? Number(this.config.vision.fastTimeoutSeconds) || 2
                    : Number(this.config.vision.accurateTimeoutSeconds) || 2)
              ) * 1000,
            signal
          }
        );
        this.#recordOcrSuccess(mode);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#recordOcrFailure(error, mode);
        throw error;
      }
      return JSON.parse(result.stdout)
        .filter(
          (item) =>
            item.confidence >= minimumConfidence
        )
        .map((item) => ({
          ...item,
          x: item.x / safeScale + crop.left,
          y: item.y / safeScale + crop.top,
          width: item.width / safeScale,
          height: item.height / safeScale
        }));
    } finally {
      this.taskPaths.delete(cropPath);
      await rm(cropPath, { force: true });
      if (scaledPath) {
        this.taskPaths.delete(scaledPath);
        await rm(scaledPath, { force: true });
      }
    }
  }

  async #cropImage(imagePath, region, outputPath, signal) {
    const sourceWidth = Math.max(
      1,
      Number(this.config.adb?.screenWidth) || Math.round(region.right)
    );
    const sourceHeight = Math.max(
      1,
      Number(this.config.adb?.screenHeight) || Math.round(region.bottom)
    );
    const crop = safeSipsCropRegion(region, sourceWidth, sourceHeight);
    await runFile(
      "/usr/bin/sips",
      [
        "-c",
        String(crop.height),
        String(crop.width),
        "--cropOffset",
        String(crop.top),
        String(crop.left),
        imagePath,
        "--out",
        outputPath
      ],
      { timeoutMs: 30_000, signal }
    );
    if (crop.adjusted) {
      await this.#assertImageDimensions(
        outputPath,
        crop.width,
        crop.height,
        signal,
        "crop"
      );
    }
    return crop;
  }

  async #assertImageDimensions(path, expectedWidth, expectedHeight, signal, label) {
    const result = await runFile(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", path],
      { timeoutMs: 30_000, signal }
    );
    const width = Number(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1]);
    if (width !== expectedWidth || height !== expectedHeight) {
      throw new Error(
        `VISION_CROP_DIMENSION_MISMATCH: ${label} expected ${expectedWidth}x${expectedHeight}, got ${width || "?"}x${height || "?"}; sips=${JSON.stringify({ stdout: result.stdout, stderr: result.stderr }).slice(0, 500)}`
      );
    }
  }

  async #capture(
    label,
    signal,
    transient,
    mode = this.config.vision.mode,
    options = {}
  ) {
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
        this.#assertOcrAvailable(mode);
        const result = await runFile(
          this.config.vision.binary,
          [path, mode],
          {
            timeoutMs:
              Math.max(
                1,
                mode === "fast"
                  ? Number(this.config.vision.fastTimeoutSeconds) || 2
                  : Number(this.config.vision.accurateTimeoutSeconds) || 2
              ) * 1000,
            signal
          }
        );
        const minimumConfidence =
          Number.isFinite(Number(options.minimumConfidence))
            ? Number(options.minimumConfidence)
            : mode === "accurate"
              ? Math.max(
                  0.1,
                  Number(
                    this.config.vision.accurateMinimumConfidence
                  ) || Math.min(
                    0.25,
                    Number(this.config.vision.minimumConfidence) || 0.35
                  )
                )
              : Number(this.config.vision.minimumConfidence) || 0.35;
        observations = JSON.parse(result.stdout).filter(
          (item) => item.confidence >= minimumConfidence
        );
        this.#recordOcrSuccess(mode);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#recordOcrFailure(error, mode);
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

  #ocrState(mode) {
    const key = mode === "accurate" ? "accurate" : "fast";
    if (!this.ocrModeHealth.has(key)) {
      this.ocrModeHealth.set(key, {
        failureStreak: 0,
        disabledUntil: 0,
        lastFailure: null
      });
    }
    return this.ocrModeHealth.get(key);
  }

  #assertOcrAvailable(mode) {
    const state = this.#ocrState(mode);
    if (Date.now() < state.disabledUntil) {
      throw new Error(
        `VISION_OCR_CIRCUIT_OPEN_${String(mode || "fast").toUpperCase()}: ${state.lastFailure || "native OCR unavailable"}`
      );
    }
  }

  #recordOcrSuccess(mode) {
    const state = this.#ocrState(mode);
    state.failureStreak = 0;
    state.disabledUntil = 0;
    state.lastFailure = null;
  }

  #recordOcrFailure(error, mode) {
    if (String(error?.message || "").startsWith("VISION_OCR_CIRCUIT_OPEN")) {
      return;
    }
    const state = this.#ocrState(mode);
    state.failureStreak += 1;
    state.lastFailure = String(error?.message || error).slice(0, 500);
    if (state.failureStreak >= 2) {
      const cooldownSeconds = Math.max(
        5,
        Number(this.config.vision?.ocrCircuitCooldownSeconds) || 15
      );
      state.disabledUntil = Date.now() + cooldownSeconds * 1000;
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

export function safeSipsCropRegion(region, sourceWidth, sourceHeight) {
  const width = Math.max(1, Math.round(region.right - region.left));
  const height = Math.max(1, Math.round(region.bottom - region.top));
  let left = Math.max(0, Math.round(region.left));
  let top = Math.max(0, Math.round(region.top));
  // macOS 27 sips silently returns the original image when a crop ends exactly
  // at its bottom or right edge. Shift the same-size crop inward by one pixel.
  if (width < sourceWidth && left + width >= sourceWidth) {
    left = Math.max(0, sourceWidth - width - 1);
  }
  if (height < sourceHeight && top + height >= sourceHeight) {
    top = Math.max(0, sourceHeight - height - 1);
  }
  return {
    left,
    top,
    width,
    height,
    adjusted:
      left !== Math.round(region.left) || top !== Math.round(region.top)
  };
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

function comparableVisionName(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function medianNumber(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function parsePopulationCapacity(observations, maximumCapacity) {
  const candidates = parsePopulationCounts(observations).filter(
    (item) => item.capacity > 0 && item.capacity <= maximumCapacity
  );
  return candidates[0]?.capacity ?? null;
}

function parsePopulationCounts(observations) {
  const joined = [...(observations || [])]
    .sort((left, right) => left.x - right.x)
    .map((item) => String(item.text || ""))
    .join("")
    .replace(/\s+/g, "")
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[／]/g, "/");
  return [...joined.matchAll(/(\d{1,3})\/(\d{1,3})/g)]
    .map((match) => ({
      current: Number.parseInt(match[1], 10),
      capacity: Number.parseInt(match[2], 10)
    }))
    .filter(
      (item) =>
        Number.isFinite(item.current) &&
        Number.isFinite(item.capacity) &&
        item.current >= 0 &&
        item.current <= item.capacity
    );
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
