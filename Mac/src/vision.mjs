import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAC_ROOT } from "./config.mjs";
import { runFile } from "./process.mjs";
import { LocalVisionAdvisor } from "./local-vision-advisor.mjs";
import {
  isMemberAvatarArtifact,
  isMemberIdentityBadge,
  isMemberProfessionArtifact,
  isMemberSymbolOnlyName,
  isPlausibleMemberName,
  stripMemberTableIdentityBadge
} from "./member-name.mjs";
import { isStaffSeatPlaceholder, parseTable } from "./table-parser.mjs";

export { isPlausibleMemberName } from "./member-name.mjs";

function isMemberDetailsDefinition(definition) {
  const keys = new Set(
    (definition?.columns || []).map((column) => column?.key)
  );
  return [
    "identity",
    "profession",
    "manorLevel",
    "onlineState",
    "roommateName"
  ].every((key) => keys.has(key));
}

function memberDetailsOcrRegion(definition) {
  const region = definition?.region || {};
  const width = Math.max(1, Number(region.right) - Number(region.left));
  const identity = (definition?.columns || []).find(
    (column) => column?.key === "identity"
  );
  const identityLeft = Number.isFinite(Number(identity?.left))
    ? Number(identity.left)
    : 0;
  const left = Math.max(
    Number(region.left) || 0,
    Math.min(
      Number(region.right) || Number(region.left) || 0,
      (Number(region.left) || 0) + width * identityLeft
    )
  );
  return { ...region, left };
}

function memberDetailsReadDefinition(definition) {
  const source = definition || {};
  const pagination = source.pagination || {};
  if (pagination.skipLeadingPartialRows) return source;
  const rowHeight = Number(pagination.rowHeightPx);
  const rowAnchorTop = Number(
    source.rowAnchorTop ?? pagination.rowAnchorTop
  );
  const rowsPerPage = Number(pagination.rowsPerPage);
  if (
    !Number.isFinite(rowHeight) ||
    rowHeight <= 0 ||
    !Number.isFinite(rowAnchorTop) ||
    !Number.isFinite(rowsPerPage) ||
    rowsPerPage < 1 ||
    !source.region
  ) {
    return source;
  }
  const lastRowBoundary = rowAnchorTop + (rowsPerPage - 0.5) * rowHeight;
  const bottom = Math.min(Number(source.region.bottom), lastRowBoundary);
  if (!Number.isFinite(bottom) || bottom >= Number(source.region.bottom)) {
    return source;
  }
  return {
    ...source,
    region: { ...source.region, bottom }
  };
}

export class Vision {
  constructor(config, adb) {
    this.config = config;
    this.adb = adb;
    this.sequence = 0;
    this.snapshotDir = resolve(MAC_ROOT, "snapshots");
    this.taskPaths = new Set();
    this.taskDebugRecorder = null;
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

  beginTask({ taskDebug = null } = {}) {
    this.taskPaths.clear();
    this.taskDebugRecorder = taskDebug;
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
    const debugPath = await this.taskDebugRecorder?.recordImage(path, label);
    return { path, debugPath: debugPath || null, observations: [] };
  }

  async captureTable(label, definition, signal) {
    const configuredMinimum = Number(definition?.ocrMinimumConfidence);
    const minimumConfidence = Number.isFinite(configuredMinimum)
      ? Math.max(0.1, Math.min(0.6, configuredMinimum))
      : 0.25;
    if (isMemberDetailsDefinition(definition)) {
      // Do not run the table OCR over the avatar column.  Avatar artwork has
      // printed year marks such as 2025, and a full-screen OCR pass can turn
      // those marks into fake member names before the table parser gets a
      // chance to apply the identity-column bounds.
      const frame = await this.captureSource(label, signal);
      let observations = [];
      try {
        observations = await this.ocrRegion(
          frame.path,
          memberDetailsOcrRegion(definition),
          `${label}-table-values`,
          signal,
          this.config.vision.mode,
          minimumConfidence,
          1,
          Math.max(
            1,
            Number(this.config.vision?.memberTableTimeoutSeconds) || 2
          )
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        // Keep the source frame for the advisor recovery path; the caller's
        // existing empty-page/retry handling decides whether to reread it.
        observations = [];
      }
      return { path: frame.path, observations };
    }
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
    await this.taskDebugRecorder?.recordImage(path, `${label}-advisor`);
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
    await this.taskDebugRecorder?.recordImage(path, `${label}-overlay-advisor`);
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
        signal,
        options
      );
    }
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
        signal,
        options
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
    if (!this.advisor.enabled) return [];
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
    return advised
      .map((item, index) => ({
        roleKey:
          slotKeys[item.slot] ||
          (item.slot.startsWith("staff")
            ? `staff-${item.slot.slice(5)}`
            : `staff-${index + 1}`),
        roleName:
          item.slot === "mayor"
            ? item.campTitle || "市长"
            : item.campTitle || "",
        memberName: item.name,
        campTitle: item.campTitle || null
      }))
      .filter(
        (row) =>
          row.memberName &&
          row.roleName &&
          !isStaffSeatPlaceholder(row.roleName)
      );
  }

  async readMemberExpectedBreakdown(signal) {
    const countRegions = {
      members: { left: 345, top: 225, right: 430, bottom: 295 },
      citizens: { left: 470, top: 225, right: 535, bottom: 295 },
      membersExpanded: { left: 300, top: 220, right: 455, bottom: 305 },
      citizensExpanded: { left: 430, top: 220, right: 580, bottom: 305 },
      header: { left: 100, top: 215, right: 680, bottom: 320 }
    };
    let memberObservations = [];
    let citizenObservations = [];
    let fallbackObservations = [];
    let lastError;
    const memberSamples = [];
    const citizenSamples = [];
    let localHeaderVerificationAttempted = false;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      // A new frame is essential here. Re-running OCR over the same image only
      // repeats the same bad segmentation and was the reason five consecutive
      // runs failed on an otherwise healthy member page.
      const frame = await this.capture(
        `member-count-header-${attempt}`,
        signal
      );
      try {
        [memberObservations, citizenObservations] = await Promise.all([
          this.ocrRegion(
            frame.path,
            countRegions.members,
            `member-count-${attempt}`,
            signal,
            "accurate",
            0.2,
            8,
            5
          ),
          this.ocrRegion(
            frame.path,
            countRegions.citizens,
            `citizen-count-${attempt}`,
            signal,
            "accurate",
            0.2,
            8,
            5
          )
        ]);
        memberSamples.push(...memberObservations.map((item) => item.text));
        citizenSamples.push(...citizenObservations.map((item) => item.text));
        // The header contains two fractions: formal citizens X/N and sailing
        // citizens A/B. X and A are online/current counts and must not be
        // added to the roster total; only N + B is the expected roster size.
        // A zero-capacity sailing-citizen fraction (0/0) is valid and must be
        // accepted instead of triggering a broad fallback OCR pass.
        let memberFraction = parsePopulationFraction(
          memberObservations,
          110,
          { minimumCapacity: 1 }
        );
        let citizenFraction = parsePopulationFraction(
          citizenObservations,
          10,
          { minimumCapacity: 0 }
        );

        // The citizen fraction is small and can be merged with its icon by
        // OCR. Use a wider crop before treating the header as unreadable.
        if (memberFraction === null || citizenFraction === null) {
          const [memberExpanded, citizenExpanded] = await Promise.all([
            memberFraction === null
              ? this.ocrRegion(
                  frame.path,
                  countRegions.membersExpanded,
                  `member-count-expanded-${attempt}`,
                  signal,
                  "accurate",
                  0.1,
                  8,
                  5
                )
              : Promise.resolve([]),
            citizenFraction === null
              ? this.ocrRegion(
                  frame.path,
                  countRegions.citizensExpanded,
                  `citizen-count-expanded-${attempt}`,
                  signal,
                  "accurate",
                  0.1,
                  8,
                  5
                )
              : Promise.resolve([])
          ]);
          memberSamples.push(...memberExpanded.map((item) => item.text));
          citizenSamples.push(...citizenExpanded.map((item) => item.text));
          memberFraction ??= parsePopulationFraction(
            memberExpanded,
            110,
            { minimumCapacity: 1 }
          );
          citizenFraction ??= parsePopulationFraction(
            citizenExpanded,
            10,
            { minimumCapacity: 0 }
          );
        }

        // Final fallback: OCR the complete header at high scale, but parse
        // each fraction only inside its own horizontal area. This prevents a
        // valid member fraction from being mistaken for citizen capacity.
        if (memberFraction === null || citizenFraction === null) {
          fallbackObservations = await this.ocrRegion(
            frame.path,
            countRegions.header,
            `member-count-header-fallback-${attempt}`,
            signal,
            "accurate",
            0.1,
            5,
            5
          );
          memberSamples.push(...fallbackObservations.map((item) => item.text));
          citizenSamples.push(...fallbackObservations.map((item) => item.text));
          memberFraction ??= parsePopulationFraction(
            observationsInHorizontalRegion(fallbackObservations, {
              left: 280,
              top: 215,
              right: 455,
              bottom: 320
            }),
            110,
            { minimumCapacity: 1 }
          );
          citizenFraction ??= parsePopulationFraction(
            observationsInHorizontalRegion(fallbackObservations, {
              left: 430,
              top: 215,
              right: 580,
              bottom: 320
            }),
            10,
            { minimumCapacity: 0 }
          );
        }
        const ocrBreakdown = {
          formalCurrent: memberFraction?.current ?? null,
          formalTotal: memberFraction?.capacity ?? null,
          sailingCurrent: citizenFraction?.current ?? null,
          sailingTotal: citizenFraction?.capacity ?? null
        };
        // OCR is the first pass. When configured, verify the isolated header
        // once with Qwen before its result controls pagination. This is also
        // allowed when OCR could not parse one fraction, so a visible 0/0
        // sailing-citizen value can recover instead of blocking the task.
        let localBreakdown = null;
        if (
          !localHeaderVerificationAttempted &&
          this.advisor.enabled &&
          typeof this.advisor.extractMemberCounts === "function"
        ) {
          localHeaderVerificationAttempted = true;
          localBreakdown = await this.#verifyMemberHeaderCounts(
            frame.path,
            countRegions.header,
            attempt,
            signal,
            ocrBreakdown
          );
        }
        const breakdown = localBreakdown ||
          (memberFraction !== null && citizenFraction !== null
            ? {
                formalCurrent: memberFraction.current,
                formalTotal: memberFraction.capacity,
                sailingCurrent: citizenFraction.current,
                sailingTotal: citizenFraction.capacity
              }
            : null);
        if (breakdown) {
          // The two denominators are separate header fractions, but both are
          // member populations for pagination. Online/current numerators are
          // never included. Thus 9/100 plus 0/1 means 101 roster members and
          // ceil(101 / 5) = 21 pages.
          return {
            ...breakdown,
            total: breakdown.formalTotal + breakdown.sailingTotal,
            ...(localBreakdown ? { localVisionVerified: true } : {})
          };
        }
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    if (
      lastError &&
      !memberSamples.length &&
      !citizenSamples.length &&
      !fallbackObservations.length
    ) {
      throw lastError;
    }
    throw new Error(
      `MEMBER_COUNT_UNREADABLE: expected member and citizen current counts, OCR=${JSON.stringify({
        members: memberSamples.slice(-24),
        citizens: citizenSamples.slice(-24),
        fallback: fallbackObservations.map((item) => item.text)
      })}`
    );
  }

  async readMemberExpectedTotal(signal) {
    const breakdown = await this.readMemberExpectedBreakdown(signal);
    return breakdown.total ??
      breakdown.formalTotal + breakdown.sailingTotal;
  }

  async #verifyMemberHeaderCounts(
    imagePath,
    region,
    attempt,
    signal,
    ocrBreakdown
  ) {
    if (
      !this.advisor.enabled ||
      typeof this.advisor.extractMemberCounts !== "function"
    ) {
      return null;
    }
    const cropPath = resolve(
      this.snapshotDir,
      `${String(++this.sequence).padStart(4, "0")}-member-count-vision-${attempt}.png`
    );
    this.taskPaths.add(cropPath);
    try {
      await this.#cropImage(imagePath, region, cropPath, signal);
      return await this.advisor.extractMemberCounts(cropPath, signal, {
        ocrHint: ocrBreakdown
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    } finally {
      this.taskPaths.delete(cropPath);
      await rm(cropPath, { force: true });
    }
  }

  async #extractContributionRows(
    imagePath,
    definition,
    label,
    signal,
    options = {}
  ) {
    const configuredMinimum = Number(definition.ocrMinimumConfidence);
    const memberOcrMinimum = Number.isFinite(configuredMinimum)
      ? Math.max(0.25, Math.min(0.8, configuredMinimum))
      : 0.3;
    let observations = await this.ocrRegion(
      imagePath,
      definition.region,
      `${label}-values`,
      signal,
      "accurate",
      memberOcrMinimum,
      2,
      Math.max(1, Number(this.config.vision?.memberTableTimeoutSeconds) || 2)
    );
    let rows = parseTable(observations, definition);
    const numericFields = [
      "weeklyContribution",
      "technologyPointsUsed",
      "materialContribution"
    ];
    if (
      rows.length &&
      rows.some((row) =>
        numericFields.some((field) => !hasContributionNumber(row[field]))
      )
    ) {
      // Full-table OCR is good at names but can drop a small 0 or a value
      // beside a role icon. Re-read only the incomplete numeric columns at a
      // larger scale and assign each value back to its existing row center.
      // The column bounds come from the existing table definition, so no new
      // device-specific click coordinates are introduced.
      const rowCenters = contributionRowCenters(observations, definition.region);
      const tableWidth = definition.region.right - definition.region.left;
      const columnRegions = Object.fromEntries(
        definition.columns
          .filter((column) => numericFields.includes(column.key))
          .map((column) => [
            column.key,
            {
              left: definition.region.left + tableWidth * column.left,
              top: definition.region.top,
              right: definition.region.left + tableWidth * column.right,
              bottom: definition.region.bottom
            }
          ])
      );
      const missingFields = numericFields.filter((field) =>
        rows.some((row) => !hasContributionNumber(row[field]))
      );
      const recovered = await Promise.all(
        missingFields.map(async (field) => ({
          field,
          observations: await this.ocrRegion(
            imagePath,
            columnRegions[field],
            `${label}-${field}-column-recovery`,
            signal,
            "accurate",
            0.1,
            4,
            2
          )
        }))
      );
      const recoveryValues = new Map(
        recovered.map(({ field, observations: values }) => [
          field,
          assignContributionColumnValues(
            values,
            rowCenters,
            rows.length,
            definition.region
          )
        ])
      );
      rows = rows.map((row, index) => {
        const merged = { ...row };
        for (const field of missingFields) {
          if (hasContributionNumber(merged[field])) continue;
          const value = recoveryValues.get(field)?.[index];
          if (value) merged[field] = value;
        }
        return merged;
      });
    }
    const region = definition.region;
    const useFullTableAdvisor =
      this.advisor.enabled &&
      (options.forceLocalVision ||
        options.forceContributionVision ||
        options.forceContributionRecovery);
    if (useFullTableAdvisor) {
      let advisedRows = [];
      try {
        advisedRows = await this.#withTemporaryCrop(
          imagePath,
          region,
          `${label}-vision-table-crop`,
          signal,
          (cropPath) =>
            this.advisor.extractTable(
              cropPath,
              {
                columns: [
                  "name",
                  "weeklyContribution",
                  "technologyPointsUsed",
                  "materialContribution"
                ]
              },
              signal
            )
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        // Keep the native accurate pass when Qwen is unavailable for one
        // page; a failed enhancement must never erase a readable table.
        advisedRows = [];
      }
      rows = mergeVisionRowsByIndex(
        rows,
        advisedRows,
        [
          "name",
          "weeklyContribution",
          "technologyPointsUsed",
          "materialContribution"
        ]
      );
    }
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
      let advisedNames = [];
      try {
        advisedNames = await this.advisor.extractNames(cropPath, signal);
      } catch {
        // Accurate OCR already produced row-aligned values.  The local model
        // is an enhancement for ambiguous names, not a prerequisite for
        // recovering a row whose native name OCR was blank; preserve the
        // accurate pass when the model is stopped, busy, or unavailable.
        advisedNames = [];
      }
      const namesByRow = new Map(
        advisedNames.map((item) => [item.row, item.name])
      );
      return rows
        .map((row, index) => {
          const nativeName = cleanVisionTableName(row.name);
          const advisedName = cleanVisionTableName(namesByRow.get(index + 1));
          return {
            ...row,
            name:
              preferredMemberVisionName(nativeName, advisedName) ||
              nativeName ||
              advisedName ||
              ""
          };
        });
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
    // The normal five-row crop must not include the next row's lower edge.
    // When the list is one row short at the top, Apple/Qwen can otherwise
    // promote that partial bottom row into slot five and silently shift the
    // page. The calculated tail keeps its expanded region unchanged because
    // it intentionally starts with a partial previous row.
    definition = memberDetailsReadDefinition(definition);
    const configuredMinimum = Number(definition.ocrMinimumConfidence);
    const memberOcrMinimum = Number.isFinite(configuredMinimum)
      ? Math.max(0.25, Math.min(0.8, configuredMinimum))
      : 0.3;
    let observations = await this.ocrRegion(
      imagePath,
      memberDetailsOcrRegion(definition),
      `${label}-values`,
      signal,
      "accurate",
      memberOcrMinimum
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
    // Online/offline OCR is only an alignment aid. Even when it happens to
    // produce the configured number of anchors, one missed token can make a
    // later partially visible row take an earlier row's slot. The member list
    // has calibrated geometry, so fixed row slots must be authoritative.
    const fixedRowHeight = Number(definition.pagination?.rowHeightPx);
    const fixedRowTop = Number(
      definition.rowAnchorTop ?? definition.pagination?.rowAnchorTop
    );
    if (
      Number.isFinite(fixedRowHeight) &&
      fixedRowHeight > 0 &&
      Number.isFinite(fixedRowTop)
    ) {
      const leadingPartialRows = definition.pagination?.skipLeadingPartialRows
        ? 1
        : 0;
      anchors = Array.from(
        { length: rowsPerPage },
        (_, index) =>
          fixedRowTop + (index + leadingPartialRows) * fixedRowHeight
      );
    } else {
      // Older/plugin definitions may not carry calibrated row geometry. Avoid
      // a second full-screen OCR in that case; use the available anchors or
      // infer evenly spaced slots from the configured region.
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
        upper,
        lower,
        anchor,
        items,
        profession: firstColumnText(
          items,
          columnBounds.get("profession")
        ),
        identity: inferMemberIdentity(
          itemsInColumn(items, columnBounds.get("identity")),
          {
            includeCampTitle: false,
            nameBaselineY: anchor,
            maxNameOffset: rowSpacing * 0.4
          }
        )
      };
    });
    const missingIdentityRows = rowData.filter(
      (row) => !String(row.identity?.name || "").trim()
    );
    if (missingIdentityRows.length) {
      const identityBounds = columnBounds.get("identity");
      const recoveryRows = await Promise.all(
        missingIdentityRows.map(async (row, recoveryIndex) => {
          const identityRegion = {
            left: identityBounds.left,
            top: Math.max(region.top, row.upper - 12),
            right: identityBounds.right,
            bottom: Math.min(region.bottom, row.lower + 12)
          };
          if (identityRegion.bottom <= identityRegion.top) return null;
          const recovered = await this.ocrRegion(
            imagePath,
            identityRegion,
            `${label}-identity-row-recovery-${recoveryIndex + 1}`,
            signal,
            "accurate",
            0,
            8,
            Math.max(1, Number(this.config.vision?.memberTableTimeoutSeconds) || 2)
          ).catch(() => []);
          const inRow = recovered.filter((item) => {
            const y = centerY(item);
            return y >= row.upper && y < row.lower;
          });
          const identity = inferMemberIdentity(inRow, {
            includeCampTitle: false,
            nameBaselineY: row.anchor,
            maxNameOffset: rowSpacing * 0.4
          });
          return identity.name ? { row, identity, recovered: inRow } : null;
        })
      );
      for (const recovered of recoveryRows.filter(Boolean)) {
        recovered.row.identity = recovered.identity;
        recovered.row.items = [
          ...recovered.row.items.filter(
            (item) =>
              centerX(item) < identityBounds.left ||
              centerX(item) >= identityBounds.right
          ),
          ...recovered.recovered
        ];
      }
    }
    if (this.advisor.enabled) {
      const identityBounds = columnBounds.get("identity");
      const rowsNeedingNameRecovery = rowData.filter(
        (row) =>
          !isPlausibleMemberName(row.identity.name) ||
          isMemberAvatarArtifact(row.identity.name) ||
          isMemberProfessionArtifact(row.identity.name, row.profession) ||
          (isMemberSymbolOnlyName(row.identity.name) &&
            String(row.profession || "").trim())
      );
      if (rowsNeedingNameRecovery.length) {
        await Promise.all(
          rowsNeedingNameRecovery.map(async (row, recoveryIndex) => {
            const rowCropPath = resolve(
              this.snapshotDir,
              `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-identity-ai-${recoveryIndex + 1}.png`
            );
            this.taskPaths.add(rowCropPath);
            try {
              const rowRegion = {
                left: identityBounds.left,
                top: Math.max(region.top, row.upper - 14),
                right: identityBounds.right,
                bottom: Math.min(region.bottom, row.upper + 55)
              };
              await this.#cropImage(
                imagePath,
                rowRegion,
                rowCropPath,
                signal
              );
              const candidate = await this.advisor.extractMemberName(
                rowCropPath,
                signal
              );
              const name = cleanMemberName(candidate, row.profession);
              if (name) {
                row.identity = { name, campTitle: "" };
              }
            } catch {
              // The page-level advisor recovery below remains available when
              // a single-row crop cannot be read or the local model is busy.
            } finally {
              this.taskPaths.delete(rowCropPath);
              await rm(rowCropPath, { force: true });
            }
          })
        );
      }
    }
    const nativeNameCounts = new Map();
    for (const row of rowData) {
      const key = comparableVisionName(
        isPlausibleMemberName(row.identity.name) &&
          !isMemberAvatarArtifact(row.identity.name)
          ? row.identity.name
          : ""
      );
      if (key) nativeNameCounts.set(key, (nativeNameCounts.get(key) || 0) + 1);
    }
    const forceMemberAdvisor = Boolean(options.forceMemberAdvisor);
    let advisedByRow = new Map();
    if (
      this.advisor.enabled &&
      (forceMemberAdvisor ||
        rowData.some(
          (row) =>
            !isPlausibleMemberName(row.identity.name) ||
            isMemberAvatarArtifact(row.identity.name) ||
            isMemberProfessionArtifact(
              row.identity.name,
              row.profession
            ) ||
            nativeNameCounts.get(comparableVisionName(row.identity.name)) > 1
        ))
    ) {
      const cropPath = resolve(
        this.snapshotDir,
        `${String(++this.sequence).padStart(4, "0")}-${safe(label)}-member-crop.png`
      );
      this.taskPaths.add(cropPath);
      try {
      // A calculated member tail carries its own fixed screenshot rectangle.
      // Do not recalculate the top from rowAnchorTop: that anchor already has
      // the normal region's inset, so doing so clips the first complete tail
      // row by roughly half a row. Normal pages retain their calibrated
      // anchor-based crop.
      const cropTop = definition.pagination?.skipLeadingPartialRows
        ? region.top
        : Math.max(
            region.top,
            Math.floor(anchors[0] - rowSpacing / 2)
          );
      // Use the calibrated visible row slots, not the configured maximum for
      // an expanded tail crop. Asking for extra rows makes Qwen shift later
      // names when a light/emoji-only row is hard to see.
      const advisorRowCount = rowData.length;
      const cropBottom = forceMemberAdvisor
        ? region.bottom
        : Math.min(
            region.bottom,
            Math.ceil(anchors.at(-1) + rowSpacing / 2)
          );
      await this.#cropImage(
        imagePath,
        {
          left: memberDetailsOcrRegion(definition).left,
          top: cropTop,
          right: region.right,
          bottom: cropBottom
        },
        cropPath,
        signal
      );
      const advised = await this.advisor.extractMemberDetails(
        cropPath,
        advisorRowCount,
        signal,
        { symbolAware: true }
      );
        advisedByRow = new Map(advised.map((item) => [item.row, item]));
      } finally {
        this.taskPaths.delete(cropPath);
        await rm(cropPath, { force: true });
      }
    }
    const targetedNamesByRow = new Map();
    if (this.advisor.enabled && forceMemberAdvisor) {
      const identityBounds = columnBounds.get("identity");
      const rowsNeedingTargetedVision = rowData.filter((row, index) => {
        const nativeName = cleanMemberName(row.identity.name, row.profession);
        const advisedName = cleanMemberName(
          advisedByRow.get(index + 1)?.name,
          row.profession
        );
        // A missing Qwen row must not trigger an extra request when native
        // OCR already has a usable name; the native row is the safe fallback.
        // Rows without a native name still get a targeted symbol/emoji read.
        if (!nativeName) return true;
        if (!advisedName) return false;
        return (
          !compatibleMemberVisionName(nativeName, advisedName) ||
          memberVisionDecorationCount(nativeName) !==
            memberVisionDecorationCount(advisedName)
        );
      });
      await Promise.all(
        rowsNeedingTargetedVision.map(async (row, recoveryIndex) => {
          const rowIndex = rowData.indexOf(row) + 1;
          const identityRegion = {
            left: Math.max(region.left, identityBounds.left - 6),
            // Keep the crop around the current row's text baseline and out of
            // the neighboring row. A full 95px row band can still contain
            // two names on the tail crop when the target name is emoji-only.
            top: Math.max(region.top, row.upper - 14),
            right: Math.min(region.right, identityBounds.right + 6),
            bottom: Math.min(region.bottom, row.upper + 55)
          };
          try {
            const candidate = await this.#withTemporaryCrop(
              imagePath,
              identityRegion,
              `${label}-member-symbol-vision-${recoveryIndex + 1}`,
              signal,
              (cropPath) => this.advisor.extractMemberName(cropPath, signal)
            );
            const name = cleanMemberName(candidate, row.profession);
            const nativeName = cleanMemberName(row.identity.name, row.profession);
            const advisedName = cleanMemberName(
              advisedByRow.get(rowIndex)?.name,
              row.profession
            );
            if (
              name &&
              (!nativeName ||
                compatibleMemberVisionName(nativeName, name) ||
                !advisedName ||
                compatibleMemberVisionName(advisedName, name))
            ) {
              targetedNamesByRow.set(rowIndex, name);
            }
          } catch (error) {
            if (signal?.aborted) throw error;
            // The fixed full-table result and native row remain the fallback.
          }
        })
      );
      const unresolvedRows = rowData.filter((row, index) => {
        const advisedName = cleanMemberName(
          targetedNamesByRow.get(index + 1) || advisedByRow.get(index + 1)?.name,
          row.profession
        );
        const nativeName = cleanMemberName(row.identity.name, row.profession);
        return !advisedName && !nativeName;
      });
      await Promise.all(
        unresolvedRows.map(async (row, recoveryIndex) => {
          const identityRegion = {
            left: Math.max(region.left, identityBounds.left - 6),
            top: Math.max(region.top, row.upper - 14),
            right: Math.min(region.right, identityBounds.right + 6),
            bottom: Math.min(region.bottom, row.upper + 55)
          };
          try {
            let candidate = await this.#withTemporaryCrop(
              imagePath,
              identityRegion,
              `${label}-member-row-vision-${recoveryIndex + 1}`,
              signal,
              (cropPath) => this.advisor.extractMemberName(cropPath, signal)
            );
            let name = cleanMemberName(candidate, row.profession);
            if (!name) {
              const fullRowRegion = {
                left: memberDetailsOcrRegion(definition).left,
                top: Math.max(region.top, row.upper - 12),
                right: region.right,
                bottom: Math.min(region.bottom, row.upper + 55)
              };
              candidate = await this.#withTemporaryCrop(
                imagePath,
                fullRowRegion,
                `${label}-member-row-full-vision-${recoveryIndex + 1}`,
                signal,
                (cropPath) =>
                  this.advisor.extractMemberDetails(cropPath, 1, signal, {
                    singleRow: true,
                    symbolAware: true
                  })
              );
              name = cleanMemberName(candidate?.[0]?.name, row.profession);
            }
            if (name) row.identity = { name, campTitle: "" };
          } catch (error) {
            if (signal?.aborted) throw error;
            // Leave the fixed row unresolved so the outer page retry can try
            // again without shifting a later row into its position.
          }
        })
      );
    }
    const rowsWithNameCandidates = rowData.map(
      ({ items, identity, profession }, index) => {
        const ai = advisedByRow.get(index + 1) || {};
        const nativeName = cleanMemberName(identity.name, profession);
        const advisedName = cleanMemberName(
          targetedNamesByRow.get(index + 1) || ai.name,
          profession
        );
        const preferredName = preferredMemberVisionName(
          nativeName,
          advisedName
        );
        return {
          // Apple OCR can include adjacent badges/icons. Prefer a valid Qwen
          // name for each fixed row when it agrees with the native row's text.
          // If Qwen skipped a row and shifted the following names upward, the
          // fixed row must retain its native candidate instead of accepting a
          // different member. An empty native row remains recoverable by Qwen.
          name: preferredName,
          // Keep both row-aligned candidates until the complete page has
          // been assembled. A one-character OCR correction can otherwise
          // turn two distinct rows (such as numeric variants) into the same
          // name; the collision resolver below can then choose the unused
          // candidate without any player-specific dictionary.
          __nameCandidates: [preferredName, nativeName, advisedName]
            .filter(Boolean)
            .filter(
              (candidate, candidateIndex, candidates) =>
                candidates.indexOf(candidate) === candidateIndex &&
                (!preferredName ||
                  compatibleMemberVisionName(preferredName, candidate))
            ),
          // The member list is a name roster. Its second identity line is a
          // camp title, not another member name; only the staff-card parser
          // is allowed to promote that line to a role field.
          campTitle: null,
          profession:
            profession,
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
      }
    );
    return resolveMemberVisionRowNameCollisions(rowsWithNameCandidates)
      .map(({ __nameCandidates, ...row }) => row)
      .filter((row) => row.name);
  }

  async #extractActivityRows(
    imagePath,
    definition,
    label,
    signal,
    options = {}
  ) {
    const configuredMinimum = Number(definition.ocrMinimumConfidence);
    const memberOcrMinimum = Number.isFinite(configuredMinimum)
      ? Math.max(0.25, Math.min(0.8, configuredMinimum))
      : 0.3;
    const observations = await this.ocrRegion(
      imagePath,
      definition.region,
      `${label}-activity-values`,
      signal,
      "accurate",
      memberOcrMinimum,
      options.forceActivityRecovery ? 2 : 1
    );
    let rows = parseTable(observations, definition)
      .map((row) => ({
        ...row,
        // Apply the same symbol/badge normalization used by contribution and
        // member-profile tables even when the local model is unavailable for
        // this page. This prevents a mayor crest or a known OCR boundary
        // artifact from becoming part of the activity identity key.
        name: cleanVisionTableName(row.name)
      }))
      .filter(
        (row) =>
          row.name &&
          !definition.headerPattern.some(
            (value) =>
              row.name.includes(value) ||
              row.onlineState.includes(value)
          )
      );
    const useActivityAdvisor =
      this.advisor.enabled &&
      (options.forceLocalVision ||
        options.forceActivityVision ||
        options.forceActivityRecovery);
    if (useActivityAdvisor) {
      try {
        const advisedRows = await this.#withTemporaryCrop(
          imagePath,
          definition.region,
          `${label}-vision-table-crop`,
          signal,
          (cropPath) => this.advisor.extractActivity(cropPath, signal)
        );
        rows = mergeVisionActivityRows(rows, advisedRows);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Preserve native rows when the local model is stopped or times out.
      }
    }
    return rows.filter((row) => row.name && row.onlineState);
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
        await this.taskDebugRecorder?.recordImage(scaledPath, `${label}-ocr-scaled`);
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
    await this.taskDebugRecorder?.recordImage(outputPath, "crop");
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

  async #withTemporaryCrop(imagePath, region, label, signal, operation) {
    const cropPath = resolve(
      this.snapshotDir,
      `${String(++this.sequence).padStart(4, "0")}-${safe(label)}.png`
    );
    this.taskPaths.add(cropPath);
    try {
      await this.#cropImage(imagePath, region, cropPath, signal);
      return await operation(cropPath);
    } finally {
      this.taskPaths.delete(cropPath);
      await rm(cropPath, { force: true });
    }
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
    const debugPath = await this.taskDebugRecorder?.recordImage(path, label);
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
      return {
        path: transient ? null : path,
        debugPath: debugPath || null,
        observations
      };
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

  async gameMouseIconVisible(signal) {
    const icon = this.config.adb?.gameMouseIcon || {};
    const points = Array.isArray(icon.probePoints) && icon.probePoints.length >= 2
      ? icon.probePoints
      : [
          { x: 1728, y: 1000 },
          { x: 1728, y: 1055 }
        ];
    const radius = Math.max(6, Number(icon.probeRadius) || 18);
    const threshold = Math.max(
      0.01,
      Number(icon.luminanceDeviationThreshold) || 0.12
    );
    const frame = await this.captureSource("game-mouse-icon", signal);
    try {
      let probes = null;
      try {
        probes = await this.probe(frame.path, points, radius, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // The OCR fallback below is deliberately conservative. A graphics
        // probe can fail on an unusual screenshot codec or scene, but a text
        // anchor alone is not proof that the cursor icon is visible.
      }
      if (
        probes?.length >= 2 &&
        probes.every(
          (probe) => Number(probe.luminanceDeviation) >= threshold
        )
      ) {
        return true;
      }

      const ocrFallback = icon.ocrFallback || {};
      const fallbackTexts = Array.isArray(ocrFallback.texts)
        ? ocrFallback.texts.filter((text) => String(text).trim())
        : [];
      if (!fallbackTexts.length || !probes?.length) return false;
      const fallbackRegion = ocrFallback.region || {
        left: 1450,
        top: 850,
        right: 1910,
        bottom: 1150
      };
      let observations;
      try {
        observations = await this.ocrRegion(
          frame.path,
          fallbackRegion,
          "game-mouse-icon-ocr-fallback",
          signal,
          "fast",
          Math.max(0.1, Number(ocrFallback.minimumConfidence) || 0.35)
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        return false;
      }
      const hasHudAnchor = fallbackTexts.some((text) =>
        this.find(observations, text)
      );
      if (!hasHudAnchor) return false;

      // "Space" is a HUD anchor in the tested MuMu layout, not the icon
      // itself. It only allows a lower pixel threshold to absorb a textured
      // background or a transient anti-aliased frame; OCR never authorizes a
      // click by itself.
      const fallbackThreshold = Math.max(
        0.01,
        Number(ocrFallback.luminanceDeviationThreshold) || 0.08
      );
      return (
        probes.length >= 2 &&
        probes.every(
          (probe) => Number(probe.luminanceDeviation) >= fallbackThreshold
        )
      );
    } finally {
      this.taskPaths.delete(frame.path);
      await rm(frame.path, { force: true });
    }
  }

  async gameMouseCIconLit(signal) {
    const icon = this.config.adb?.gameMouseCIcon || {};
    const points = Array.isArray(icon.probePoints) && icon.probePoints.length >= 3
      ? icon.probePoints
      : [
          { x: 1865, y: 1130 },
          { x: 1848, y: 1130 },
          { x: 1882, y: 1130 },
          { x: 1865, y: 1114 },
          { x: 1865, y: 1146 }
        ];
    const radius = Math.max(6, Number(icon.probeRadius) || 12);
    const minimumPoints = Math.max(
      1,
      Math.min(points.length, Number(icon.minimumLitPoints) || 3)
    );
    const redBlueDelta = Math.max(
      0,
      Number(icon.redBlueDelta) || 0.08
    );
    const greenBlueDelta = Math.max(
      0,
      Number(icon.greenBlueDelta) || 0.07
    );
    const saturation = Math.max(
      0,
      Number(icon.minimumSaturation) || 0.20
    );
    const frame = await this.captureSource("game-mouse-c-icon", signal);
    try {
      let probes;
      try {
        probes = await this.probe(frame.path, points, radius, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return false;
      }
      const litPoints = (probes || []).filter((probe) => {
        const red = Number(probe.meanRed);
        const green = Number(probe.meanGreen);
        const blue = Number(probe.meanBlue);
        const meanSaturation = Number(probe.meanSaturation);
        if (![red, green, blue, meanSaturation].every(Number.isFinite)) {
          return false;
        }
        return (
          red - blue >= redBlueDelta &&
          green - blue >= greenBlueDelta &&
          meanSaturation >= saturation
        );
      });
      return litPoints.length >= minimumPoints;
    } finally {
      this.taskPaths.delete(frame.path);
      await rm(frame.path, { force: true });
    }
  }
}

function hasContributionNumber(value) {
  return /\d/.test(String(value || ""));
}

function contributionRowCenters(observations, region) {
  const visible = (observations || [])
    .filter((item) => {
      const x = centerX(item);
      const y = centerY(item);
      return x >= region.left && x <= region.right && y >= region.top && y <= region.bottom;
    })
    .sort((left, right) => centerY(left) - centerY(right));
  const medianHeight = medianNumber(visible.map((item) => item.height)) || 24;
  const threshold = Math.max(14, medianHeight * 0.75);
  const groups = [];
  for (const item of visible) {
    const y = centerY(item);
    const current = groups.at(-1);
    if (!current || Math.abs(y - current.center) > threshold) {
      groups.push({ center: y, count: 1 });
    } else {
      current.center = (current.center * current.count + y) / ++current.count;
    }
  }
  return groups.map((group) => group.center);
}

function assignContributionColumnValues(
  observations,
  rowCenters,
  rowCount,
  region
) {
  const centers = rowCenters.length >= rowCount
    ? rowCenters.slice(0, rowCount)
    : Array.from(
        { length: rowCount },
        (_, index) =>
          region.top +
          ((region.bottom - region.top) * (index + 0.25)) / rowCount
      );
  const spacing = centers.length > 1
    ? medianNumber(centers.slice(1).map((value, index) => value - centers[index]))
    : region.bottom - region.top;
  const values = Array.from({ length: rowCount }, () => null);
  for (const item of observations || []) {
    const text = String(item.text || "")
      .normalize("NFKC")
      .replace(/[OoＯｏ]/g, "0")
      .replace(/[,\s]/g, "");
    const match = text.match(/\d+/);
    if (!match) continue;
    let nearest = 0;
    let distance = Infinity;
    centers.forEach((center, index) => {
      const candidateDistance = Math.abs(centerY(item) - center);
      if (candidateDistance < distance) {
        nearest = index;
        distance = candidateDistance;
      }
    });
    if (distance <= Math.max(24, spacing * 0.45)) {
      const existing = values[nearest];
      if (
        !existing ||
        Number(item.confidence) > Number(existing.confidence)
      ) {
        values[nearest] = {
          value: match[0],
          confidence: Number(item.confidence) || 0
        };
      }
    }
  }
  return values.map((item) => item?.value || "");
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

export function inferMemberIdentity(items, options = {}) {
  const includeCampTitle = options.includeCampTitle !== false;
  const nameBaselineY = Number(options.nameBaselineY);
  const maxNameOffset = Number(options.maxNameOffset);
  const values = items
    .flatMap((item) => {
      const parts = String(item.text || "")
        .split(/\r?\n/)
        .map((text) => text.trim())
        .filter(Boolean);
      const height = Number(item.height);
      const lineHeight = Number.isFinite(height) && height > 0
        ? height / parts.length
        : 0;
      return parts.map((text, index) => ({
        text,
        y: Number.isFinite(Number(item.y)) && lineHeight
          ? Number(item.y) + lineHeight * (index + 0.5)
          : Number.NaN
      }));
    })
    .sort((left, right) => {
      if (Number.isFinite(left.y) && Number.isFinite(right.y)) {
        return left.y - right.y;
      }
      return 0;
    })
    .filter(({ text }) => !isMemberIdentityBadge(text));
  if (!values.length) return { name: "", campTitle: "" };
  const first = values[0].text;
  const firstLineBelowName =
    Number.isFinite(nameBaselineY) &&
    Number.isFinite(maxNameOffset) &&
    Number.isFinite(values[0].y) &&
    values[0].y > nameBaselineY + maxNameOffset;
  const firstLineIsTitle =
    firstLineBelowName ||
    (!Number.isFinite(nameBaselineY) &&
      values.length === 1 &&
      isLikelyMemberTitle(first));
  if (firstLineIsTitle) {
    return {
      name: "",
      campTitle: includeCampTitle ? values.map(({ text }) => text).join(" ") : ""
    };
  }
  return {
    name: first,
    campTitle: includeCampTitle
      ? values.slice(1).map(({ text }) => text).join(" ")
      : ""
  };
}

function isLikelyMemberTitle(value) {
  // Camp staff titles use a colour/role prefix such as #U followed directly
  // by the title. They are the second line of a staff row, never a member
  // name; keep the rule shape-based so no player name is embedded here.
  return /^(?:#\s*[BDGKOPRUWY](?:[\p{L}\p{N}\u3400-\u9fff]|\s|#){1,}|市长|营地助手|公职人员|职位|title\b)/iu.test(
    String(value || "").trim()
  );
}

function cleanMemberName(value, profession = "") {
  const text = cleanModelText(value)
    // Qwen sometimes emits U+2212/U+207B for the ordinary hyphen visible in
    // the game. Keep the player's `-😊-` display name stable across rereads.
    .replace(/[−⁻]/gu, "-")
    .replace(/(?:启航|回归|先行者|R|®|ℝ)$/iu, "")
    .trim();
  return isPlausibleMemberName(text) &&
    !isMemberAvatarArtifact(text) &&
    !isMemberIdentityBadge(text) &&
    !isMemberProfessionArtifact(text, profession) &&
    !isLikelyMemberTitle(text)
    ? text
    : "";
}

function compatibleMemberVisionName(nativeName, advisedName) {
  const nativeCore = memberVisionNameCore(nativeName);
  const advisedCore = memberVisionNameCore(advisedName);
  if (!nativeCore || !advisedCore) return true;
  if (nativeCore === advisedCore) return true;
  if (
    nativeCore.startsWith(advisedCore) ||
    advisedCore.startsWith(nativeCore)
  ) {
    return Math.abs(nativeCore.length - advisedCore.length) <= 2;
  }
  if (nativeCore.length !== advisedCore.length) return false;
  return memberVisionNameDistance(nativeCore, advisedCore) <= 1;
}

function preferredMemberVisionName(nativeName, advisedName) {
  const repairedNativeName = repairMemberOcrName(nativeName, advisedName);
  const nativeWasRepaired = Boolean(
    repairedNativeName && repairedNativeName !== nativeName
  );
  nativeName = repairedNativeName || nativeName;
  // Normalize the independent Qwen candidate as well. Otherwise a repaired
  // native row can still be replaced by a second-pass artifact such as
  // a sparkle pair with an extra hash or a digit-shaped decorative boundary.
  const repairedAdvisedName = repairMemberOcrName(advisedName, advisedName);
  advisedName = repairedAdvisedName || advisedName;
  if (!advisedName) return nativeName;
  if (!nativeName || !compatibleMemberVisionName(nativeName, advisedName)) {
    return nativeName || advisedName;
  }
  const nativeCore = memberVisionNameCore(nativeName);
  const advisedCore = memberVisionNameCore(advisedName);
  // A symbol-only native row is valid. Conversely, a Qwen symbol-only result
  // is not allowed to erase the native Chinese/Latin core. This is especially
  // important for caret-delimited sparkle names, where one pass may see only the
  // surrounding symbols and another may see only the text.
  if (!nativeCore || !advisedCore) {
    return nativeName;
  }
  // The repair rules below are based on a visible native artifact plus an
  // independent Qwen text-core confirmation. Once such a repair restores a
  // glyph pair (for example a trailing `卒` -> `✨core✨`), do not let the
  // model's plain-name response immediately erase the restored symbols.
  if (nativeWasRepaired) {
    // A native decoration repair can still be based on a truncated core
    // (`好甜呀$` -> `好甜呀✨`) while Qwen sees the extra Latin suffix
    // (`好甜呀em$` -> `好甜呀em✨`). Prefer the longer, model-confirmed
    // prefix in that narrow case; otherwise keep the native symbol repair.
    if (
      advisedCore.length > nativeCore.length &&
      advisedCore.startsWith(nativeCore) &&
      advisedCore.length - nativeCore.length <= 2
    ) {
      return advisedName;
    }
    return nativeName;
  }
  // If both reads agree on the underlying name, never erase decorations that
  // Apple OCR did preserve. This keeps hollow/solid flowers, stars and emoji
  // visible when Qwen's text decode returns only the Han-character core.
  if (
    nativeCore === advisedCore &&
    memberVisionDecorationCount(nativeName) >
      memberVisionDecorationCount(advisedName)
  ) {
    return nativeName;
  }
  // When both passes see the same-length Han-character core but Qwen has
  // confused one character, keep a decorated native read. A decorated row is
  // materially more informative than a plain one-character edit-distance
  // correction: replacing a decorated name with a one-character variant would erase the identity
  // that distinguishes this member from another `林昭容`-like OCR result.
  if (
    memberVisionDecorationCount(nativeName) > 0 &&
    nativeCore.length === advisedCore.length &&
    memberVisionNameDistance(nativeCore, advisedCore) <= 1
  ) {
    return nativeName;
  }
  // For undecorated equal-length names, a one-character Qwen substitution is
  // more often a small-model glyph confusion than a safe correction (`晔` /
  // `咩`, `樗` / `檀`). Keep the native text in that narrow case. Qwen is still
  // allowed to supply a clearly decorated name, which is the information the
  // native OCR most commonly loses.
  if (
    memberVisionDecorationCount(nativeName) === 0 &&
    memberVisionDecorationCount(advisedName) === 0 &&
    nativeCore.length === advisedCore.length &&
    memberVisionNameDistance(nativeCore, advisedCore) <= 1 &&
    memberVisionHasHanOnlySubstitution(nativeCore, advisedCore)
  ) {
    return nativeName;
  }
  // Apple OCR can append one glyph of a flower as 米/导/導/卒 or replace the
  // visible decoration with `*`/`※`. When Qwen returns the shorter core and
  // the native read still carries a decoration, retain the native candidate
  // so two visually distinct decorated/plain players cannot be
  // collapsed into the same key. This is deliberately limited to a short
  // prefix/suffix difference and never fuzzy-merges two completed names.
  const shortCore = nativeCore.length <= advisedCore.length
    ? nativeCore
    : advisedCore;
  const longCore = nativeCore.length <= advisedCore.length
    ? advisedCore
    : nativeCore;
  if (
    memberVisionDecorationCount(nativeName) >
      memberVisionDecorationCount(advisedName) &&
    longCore.startsWith(shortCore) &&
    longCore.length - shortCore.length <= 2
  ) {
    return nativeName;
  }
  return advisedName;
}

function repairMemberOcrName(nativeName, advisedName) {
  const originalNative = String(nativeName || "").trim();
  const native =
    repairKnownMemberOcrArtifact(originalNative) || originalNative;
  const advised = String(advisedName || "").trim();
  if (!native) return native;
  const knownArtifactRepair = repairKnownMemberOcrArtifact(native);
  if (!advised) return knownArtifactRepair || native;
  const advisedCore = memberVisionNameCore(advised);
  if (!advisedCore) return native;

  // Apple Vision often turns the two identical six-petal decorations into a
  // leading `*`/`※` and a trailing `米`.  When Qwen independently confirms
  // the same text core, restore the decoration class instead of keeping the
  // OCR artifact.  This is intentionally shape-oriented and does not merge
  // names by removing their real decorations.
  const flowerArtifact = native.match(/^([*※])(.+?)米$/u);
  if (flowerArtifact) {
    const coreCandidate = flowerArtifact[2];
    if (memberVisionNameCore(coreCandidate) === advisedCore) {
      const flower = flowerArtifact[1] === "*" ? "✿" : "❀";
      return `${flower}${coreCandidate}${flower}`;
    }
  }
  const balancedFlowerArtifact = native.match(/^※(.+?)※$/u);
  if (balancedFlowerArtifact) {
    const coreCandidate = balancedFlowerArtifact[1];
    if (memberVisionNameCore(coreCandidate) === advisedCore) {
      return `❀${coreCandidate}❀`;
    }
  }

  // The solid sparkle pair is frequently emitted by Apple Vision as the
  // Chinese-looking boundary glyphs `十` and `卒`.  Require visible carets in
  // the inner text so an ordinary Chinese name containing 十/卒 is untouched.
  const sparkleArtifact = native.match(/^十(.+\^.*)卒$/u);
  if (sparkleArtifact) {
    const coreCandidate = sparkleArtifact[1];
    if (memberVisionNameCore(coreCandidate) === advisedCore) {
      return `✨${coreCandidate}✨`;
    }
  }
  // The leading OCR glyph is not stable: the same sparkle pair has appeared
  // as `十...卒`, `牛...卒` and other one-character boundary noise. Restrict
  // this repair to a caret-delimited inner name confirmed by Qwen, so a real
  // Chinese name ending in 卒 is not changed.
  const genericSparkleArtifact = native.match(/^(.)(.+\^.*)卒$/u);
  if (genericSparkleArtifact) {
    const coreCandidate = genericSparkleArtifact[2];
    if (memberVisionNameCore(coreCandidate) === advisedCore) {
      return `✨${coreCandidate}✨`;
    }
  }
  const hashCaretSparkleArtifact = native.match(/^#(\^.+\^)卒$/u);
  if (hashCaretSparkleArtifact) {
    const coreCandidate = hashCaretSparkleArtifact[1];
    if (memberVisionNameCore(coreCandidate) === advisedCore) {
      return `✨${coreCandidate}✨`;
    }
  }

  // The game renders solid hearts around some names. Vision has also returned
  // the right-hand heart as a full-width opening parenthesis; only restore it
  // when the independent text core agrees exactly.
  const heartPairArtifact = native.match(/^(.+?)（$/u);
  if (
    heartPairArtifact &&
    memberVisionNameCore(heartPairArtifact[1]) === advisedCore
  ) {
    return `♥${heartPairArtifact[1]}♥`;
  }

  // Adjacent R/person identity badges and their antialiased edge pixels are
  // occasionally OCR'd as a leading digit or a trailing digit. If the two
  // reads have the complementary one-digit artifacts, retain the confirmed
  // text core without either badge digit.
  const leadingDigitArtifact = native.match(/^\d(.+)$/u);
  const trailingDigitArtifact = advised.match(/^(.+)\d$/u);
  if (
    leadingDigitArtifact &&
    trailingDigitArtifact &&
    memberVisionNameCore(leadingDigitArtifact[1]) ===
      memberVisionNameCore(trailingDigitArtifact[1])
  ) {
    return leadingDigitArtifact[1];
  }

  // An outline heart is commonly read as `'？`; the confirmed prefix lets us
  // restore the visible symbol without guessing a symbol for unrelated names.
  const outlineHeartArtifact = native.match(/^(.+)(?:'？|”{1,2}|"{1,2})$/u);
  if (
    outlineHeartArtifact &&
    memberVisionNameCore(outlineHeartArtifact[1]) === advisedCore
  ) {
    return `${outlineHeartArtifact[1]}♡`;
  }

  // A flower's antialiased edge is sometimes read as a leading dot/9 and a
  // full-width ampersand at the other edge. When Qwen confirms the text core,
  // restore the balanced hollow-flower decoration without using a name list.
  const hollowFlowerBoundaryArtifact = native.match(/^(?:[•·9])?(.+?)[＆&]$/u);
  if (
    hollowFlowerBoundaryArtifact &&
    memberVisionNameCore(hollowFlowerBoundaryArtifact[1]) === advisedCore &&
    /^(?:[•·9])/u.test(advised)
  ) {
    return `❀${hollowFlowerBoundaryArtifact[1]}❀`;
  }

  // `&`/`壓` are edge-pixel hallucinations at the end of rows whose separate
  // identity badge is immediately to the right. They are only removed when
  // Qwen confirms the complete shorter name.
  const trailingBadgeArtifact = native.match(/^(.+)&(?:[\u3400-\u9fff])?$/u);
  if (
    trailingBadgeArtifact &&
    memberVisionNameCore(trailingBadgeArtifact[1]) === advisedCore
  ) {
    return trailingBadgeArtifact[1];
  }
  const trailingRoleArtifact = native.match(/^(.+)&屋$/u);
  if (
    trailingRoleArtifact &&
    memberVisionNameCore(trailingRoleArtifact[1]) === advisedCore
  ) {
    return trailingRoleArtifact[1];
  }

  // A small trailing `$` is another common read of a sparkle. Only use the
  // conversion when the confirmed Qwen core is exactly the prefix, so a
  // genuine dollar sign in another name survives.
  const trailingDollarArtifact = native.match(/^(.+)\$$/u);
  if (
    trailingDollarArtifact &&
    memberVisionNameCore(trailingDollarArtifact[1]) === advisedCore
  ) {
    return `${trailingDollarArtifact[1]}✨`;
  }

  // A trailing sparkle can be returned as a hash, full-width hash, or a pair
  // of plus signs. Require the independently confirmed core before restoring
  // only the decoration at the row boundary.
  const trailingSparkleBoundaryArtifact = native.match(/^(.+?)[#＃]$/u);
  if (
    trailingSparkleBoundaryArtifact &&
    memberVisionNameCore(trailingSparkleBoundaryArtifact[1]) === advisedCore
  ) {
    return `✨${trailingSparkleBoundaryArtifact[1]}✨`;
  }
  const trailingDoublePlusArtifact = native.match(/^(.+?)\s*[+＋]{2}$/u);
  if (
    trailingDoublePlusArtifact &&
    memberVisionNameCore(trailingDoublePlusArtifact[1]) === advisedCore
  ) {
    return `${trailingDoublePlusArtifact[1]}✨`;
  }

  // The final sparkle in 好甜呀e✨ has been returned as the Han-looking 午.
  // This is deliberately limited to an exact prefix confirmation.
  const trailingSparkleHanArtifact = native.match(/^(.+)午$/u);
  if (
    trailingSparkleHanArtifact &&
    memberVisionNameCore(trailingSparkleHanArtifact[1]) === advisedCore
  ) {
    return `${trailingSparkleHanArtifact[1]}✨`;
  }

  // A leading single digit in front of a Chinese name is the left edge of a
  // role badge, not a player character. Only remove it
  // after the remaining text is the model-confirmed core.
  const leadingBadgeDigit = native.match(/^\d(.+)$/u);
  if (
    leadingBadgeDigit &&
    memberVisionNameCore(leadingBadgeDigit[1]) === advisedCore
  ) {
    return leadingBadgeDigit[1];
  }

  // A solid sparkle has also been OCR'd as 卒. Require an exact shorter-core
  // confirmation before converting it.
  const trailingSparkleArtifact = native.match(/^(.+)卒$/u);
  if (
    trailingSparkleArtifact &&
    memberVisionNameCore(trailingSparkleArtifact[1]) === advisedCore
  ) {
    return `${trailingSparkleArtifact[1]}✨`;
  }

  // A trailing `&心` is an OCR rendering of an adjacent identity decoration,
  // not a second Han character, when the independent model confirms the
  // shorter prefix.  Keep this narrow to the explicit ampersand-plus-heart
  // artifact so legitimate names ending in 心 remain valid.
  const heartArtifact = native.match(/^(.+)&心$/u);
  if (heartArtifact && memberVisionNameCore(heartArtifact[1]) === advisedCore) {
    return advised;
  }
  return native;
}

function repairKnownMemberOcrArtifact(native) {
  // OCR frequently inserts a space between the text core and a decorative
  // boundary. Remove whitespace only for strings that already contain one of
  // the known boundary glyphs; ordinary player names may legitimately contain
  // spaces and must remain unchanged.
  if (/[卒米導导樂乐楽參$#＃*＊※★☆”"。)]/u.test(native)) {
    native = native.replace(/\s+/gu, "");
  }
  // These are shape-confusion patterns from the member-list font, not a
  // general fuzzy name dictionary. They only fire for a very specific glyph
  // boundary and leave ordinary Han/Latin names untouched.
  // Qwen can preserve the outer sparkle pair but insert one glyph from the
  // antialiased boundary (for example `#` or `★`) before the caret-delimited
  // text. Remove only that non-letter/non-number boundary glyph; the inner
  // player text and both carets remain untouched.
  const qwenSparkleBoundaryArtifact = native.match(
    /^✨([^\p{L}\p{N}])(\^[\u3400-\u9fff]{1,}\^)✨$/u
  );
  if (qwenSparkleBoundaryArtifact) {
    return `✨${qwenSparkleBoundaryArtifact[2]}✨`;
  }

  // Tibetan marks `༺` and `༻` are often returned as digit/Latin boundary
  // noise, for example a digit/Latin pair or a quote/parenthesis pair. Require a CJK
  // core plus both sides of the observed boundary artifact before restoring
  // the symbol pair; this is independent of the player's actual name.
  const tibetanPairArtifact = native.match(
    /^[9qg4][89]?([\u3400-\u9fff]{1,})[Gg5s][”"）)]*$/iu
  );
  if (tibetanPairArtifact) return `༺${tibetanPairArtifact[1]}༻`;

  const tibetanPairQuoteArtifact = native.match(
    /^[94q][89]?([\u3400-\u9fff]{1,})[”"。]）?$/iu
  );
  if (tibetanPairQuoteArtifact) {
    return `༺${tibetanPairQuoteArtifact[1]}༻`;
  }

  const tibetanPairQwenArtifact = native.match(
    /^《([\u3400-\u9fff]{1,})[”"]）?$/u
  );
  if (tibetanPairQwenArtifact) {
    return `༺${tibetanPairQwenArtifact[1]}༻`;
  }

  const tibetanLeadingNoiseArtifact = native.match(
    /^(?:[9qg4日山])([\u3400-\u9fff]{1,})[”"。]）?\)?$/iu
  );
  if (tibetanLeadingNoiseArtifact) {
    return `༺${tibetanLeadingNoiseArtifact[1]}༻`;
  }

  // When the left mark is lost at the name-column edge, Apple OCR can still
  // leave the right mark as a quote/parenthesis pair (for example
  // `纸鸢”)`). A CJK-only core plus that boundary is enough to restore the
  // same decorative class; ordinary names are not changed unless the glyph
  // boundary is present.
  const tibetanTrailingArtifact = native.match(
    /^([\u3400-\u9fff]{1,})[”"]\)?$/u
  );
  if (tibetanTrailingArtifact) {
    return `༺${tibetanTrailingArtifact[1]}༻`;
  }

  const leadingBadgeDigit = native.match(/^(9)([\u3400-\u9fff]{2,})$/u);
  if (leadingBadgeDigit) return leadingBadgeDigit[2];

  const leadingAndTrailingBadgeNoise = native.match(
    /^9([\u3400-\u9fff]{2,})[Gg6]$/u
  );
  if (leadingAndTrailingBadgeNoise) return leadingAndTrailingBadgeNoise[1];

  const trailingRole = native.match(/^([\u3400-\u9fff]{2,})&屋$/u);
  if (trailingRole) return trailingRole[1];

  const trailingAmpersand = native.match(/^([\u3400-\u9fff]{2,})&$/u);
  if (trailingAmpersand) return trailingAmpersand[1];

  const solidFlowerPair = native.match(/^[*＊](.+?)[*＊]$/u);
  if (solidFlowerPair) return `✿${solidFlowerPair[1]}✿`;

  const hollowFlowerBoundaryPair = native.match(/^米(.+?)米$/u);
  if (hollowFlowerBoundaryPair) return `❀${hollowFlowerBoundaryPair[1]}❀`;

  const hollowFlowerArtifact = native.match(
    /^(?:※|栄|荣)(.+?)(?:米|樂|乐|楽|導|导|參|[*＊])$/u
  );
  if (hollowFlowerArtifact) return `❀${hollowFlowerArtifact[1]}❀`;

  const hollowFlowerPair = native.match(/^※(.+?)※$/u);
  if (hollowFlowerPair) return `❀${hollowFlowerPair[1]}❀`;

  const fullWidthHeart = native.match(/^([\u3400-\u9fff]{2,})（$/u);
  if (fullWidthHeart) return `♥${fullWidthHeart[1]}♥`;

  // A caret-delimited sparkle pair has appeared with a leading symbol plus
  // `へ`/`十`/`牛` and a Han-looking trailing glyph. Keep only the inner CJK
  // core and its two carets; no player name is special-cased here.
  const malformedCaretSparkle = native.match(
    /^(?:[#★十牛])(?:へ)?\^?([\u3400-\u9fff]{1,})\^[平卒+]$/u
  );
  if (malformedCaretSparkle) {
    return `✨^${malformedCaretSparkle[1]}^✨`;
  }

  // The same row can expose both carets but OCR the surrounding sparkles as
  // `#`/`★` and `+`/`卒`. Keep the inner caret-delimited player text and drop
  // only these known boundary glyphs.
  const malformedCaretSparklePair = native.match(
    /^[#★](\^[\u3400-\u9fff]{1,}\^)[+卒平]$/u
  );
  if (malformedCaretSparklePair) {
    return `✨${malformedCaretSparklePair[1]}✨`;
  }

  const caretSparkle = native.match(/^#(\^.+\^)卒$/u);
  if (caretSparkle) return `✨${caretSparkle[1]}✨`;

  const trailingDollar = native.match(
    /^([\p{L}\p{N}\u3400-\u9fff]{2,})\$$/u
  );
  if (trailingDollar) return `${trailingDollar[1]}✨`;

  const trailingSparkleGlyph = native.match(
    /^([\p{L}\p{N}\u3400-\u9fff]{2,})[★☆]$/u
  );
  if (trailingSparkleGlyph) return `${trailingSparkleGlyph[1]}✨`;

  const trailingSparkleHan = native.match(/^([\u3400-\u9fff]{2,}e)午$/u);
  if (trailingSparkleHan) return `${trailingSparkleHan[1]}✨`;

  const trailingSparkleHanGlyph = native.match(
    /^([\p{L}\p{N}\u3400-\u9fff]{2,})卒$/u
  );
  if (trailingSparkleHanGlyph) {
    return `${trailingSparkleHanGlyph[1]}✨`;
  }

  const trailingFlowerHanArtifact = native.match(
    /^([\p{L}\p{N}\u3400-\u9fff]{2,})(?:米|導|导|樂|乐|楽|參)$/u
  );
  if (trailingFlowerHanArtifact) {
    return `❀${trailingFlowerHanArtifact[1]}❀`;
  }

  const umbrellaArtifact = native.match(/^(.{2,}说)[手乎小]$/u);
  if (umbrellaArtifact) {
    return `${umbrellaArtifact[1]}☂`;
  }
  return "";
}

function memberVisionNameCore(value) {
  return Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase())
    .filter((character) => /[\p{L}\p{N}\u3400-\u9fff]/u.test(character))
    .join("");
}

function memberVisionDecorationCount(value) {
  return Array.from(String(value || "").normalize("NFKC"))
    .filter((character) => !/[\p{L}\p{N}\u3400-\u9fff]/u.test(character))
    .length;
}

function memberVisionNameDistance(left, right) {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  let previous = Array.from(
    { length: rightCharacters.length + 1 },
    (_, index) => index
  );
  for (let row = 1; row <= leftCharacters.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= rightCharacters.length; column += 1) {
      current.push(
        Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] +
            (leftCharacters[row - 1] === rightCharacters[column - 1] ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[rightCharacters.length];
}

function memberVisionHasHanOnlySubstitution(left, right) {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  if (leftCharacters.length !== rightCharacters.length) return false;
  const differences = leftCharacters.filter(
    (character, index) => character !== rightCharacters[index]
  );
  if (differences.length !== 1) return false;
  const index = leftCharacters.findIndex(
    (character, characterIndex) => character !== rightCharacters[characterIndex]
  );
  return (
    /[\u3400-\u9fff]/u.test(leftCharacters[index]) &&
    /[\u3400-\u9fff]/u.test(rightCharacters[index])
  );
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
    .replace(/\s+/g, "");
}

function resolveMemberVisionRowNameCollisions(rows) {
  const candidates = (rows || []).map((row, index) => ({
    row: { ...row },
    index,
    names: Array.isArray(row?.__nameCandidates)
      ? row.__nameCandidates
          .map((name) => String(name || "").trim())
          .filter(Boolean)
      : [String(row?.name || "").trim()].filter(Boolean)
  }));
  const groups = new Map();
  for (const item of candidates) {
    const key = comparableVisionName(item.row.name);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const occupied = new Set(
    candidates
      .filter((item) => {
        const key = comparableVisionName(item.row.name);
        return key && groups.get(key)?.length === 1;
      })
      .map((item) => comparableVisionName(item.row.name))
  );
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const assigned = new Set();
    // Rows with fewer alternatives are constrained first. This lets a row
    // that only has the repeated candidate keep it while another row uses
    // its unused native/model alternative.
    const ordered = [...group].sort((left, right) => {
      const leftAvailable = left.names.filter(
        (name) =>
          !occupied.has(comparableVisionName(name)) &&
          !assigned.has(comparableVisionName(name))
      ).length;
      const rightAvailable = right.names.filter(
        (name) =>
          !occupied.has(comparableVisionName(name)) &&
          !assigned.has(comparableVisionName(name))
      ).length;
      return leftAvailable - rightAvailable || left.index - right.index;
    });
    for (const item of ordered) {
      const available = item.names.find((name) => {
        const key = comparableVisionName(name);
        return key && !occupied.has(key) && !assigned.has(key);
      });
      if (!available) continue;
      item.row.name = available;
      assigned.add(comparableVisionName(available));
    }
  }
  return candidates
    .sort((left, right) => left.index - right.index)
    .map(({ row }) => row);
}

function medianNumber(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function mergeVisionRowsByIndex(primaryRows, recoveredRows, fields) {
  const primary = Array.isArray(primaryRows) ? primaryRows : [];
  const recovered = Array.isArray(recoveredRows) ? recoveredRows : [];
  const hasRowNumbers = recovered.some((row) => Number.isInteger(row?.row));
  const recoveredByRow = new Map(
    recovered
      .filter((row) => Number.isInteger(row?.row) && row.row > 0)
      .map((row) => [row.row, row])
  );
  const maximumRow = Math.max(
    primary.length,
    ...recovered.map((row) => Number(row?.row) || 0)
  );
  return Array.from({ length: maximumRow }, (_, index) => {
    const nativeRow = primary[index] || {};
    const modelRow = hasRowNumbers
      ? recoveredByRow.get(index + 1) || {}
      : recovered[index] || {};
    const merged = { ...nativeRow };
    for (const field of fields) {
      if (field === "name") {
        const modelName = cleanVisionTableName(modelRow[field]);
        const nativeName = cleanVisionTableName(nativeRow[field]);
        merged[field] =
          preferredMemberVisionName(nativeName, modelName) ||
          nativeName ||
          modelName ||
          "";
      } else if (hasContributionNumber(modelRow[field])) {
        // Qwen is the second read for noisy OCR values. Use it when it
        // returned a real integer, otherwise retain the native value.
        merged[field] = modelRow[field];
      } else if (hasContributionNumber(nativeRow[field])) {
        merged[field] = nativeRow[field];
      } else {
        merged[field] = String(modelRow[field] || nativeRow[field] || "");
      }
    }
    return merged;
  });
}

function mergeVisionActivityRows(primaryRows, recoveredRows) {
  const primary = Array.isArray(primaryRows) ? primaryRows : [];
  const recovered = Array.isArray(recoveredRows) ? recoveredRows : [];
  if (!recovered.length) return primary;
  const hasRowNumbers = recovered.some((row) => Number.isInteger(row?.row));
  const recoveredByRow = new Map(
    recovered
      .filter((row) => Number.isInteger(row?.row) && row.row > 0)
      .map((row) => [row.row, row])
  );
  const length = Math.max(
    primary.length,
    hasRowNumbers
      ? Math.max(...recovered.map((row) => Number(row?.row) || 0))
      : recovered.length
  );
  return Array.from({ length }, (_, index) => {
    const nativeRow = primary[index] || {};
    const modelRow = hasRowNumbers
      ? recoveredByRow.get(index + 1) || {}
      : recovered[index] || {};
    const nativeName = cleanVisionTableName(nativeRow.name);
    const modelName = cleanVisionTableName(modelRow.name);
    return {
      ...nativeRow,
      ...modelRow,
      name:
        preferredMemberVisionName(nativeName, modelName) ||
        nativeName ||
        modelName ||
        "",
      onlineState:
        String(modelRow.onlineState || "").trim() ||
        String(nativeRow.onlineState || "").trim()
    };
  });
}

function cleanVisionTableName(value) {
  const source = stripMemberTableIdentityBadge(value);
  const text = repairKnownMemberOcrArtifact(source) || source;
  if (!text || isMemberAvatarArtifact(text) || isMemberIdentityBadge(text)) {
    return "";
  }
  if (
    /^(?:玩家名|成员名|姓名|name|player|全部成员|一周贡献|使用科技点|贡献物资|在线情况)$/iu.test(
      text
    )
  ) {
    return "";
  }
  return isPlausibleMemberName(text) ? text : "";
}

export function parsePopulationCapacity(observations, maximumCapacity) {
  return parsePopulationFraction(observations, maximumCapacity, {
    minimumCapacity: 1
  })?.capacity ?? null;
}

export function parsePopulationFraction(
  observations,
  maximumCapacity,
  options = {}
) {
  const minimumCapacity = Number.isFinite(Number(options.minimumCapacity))
    ? Number(options.minimumCapacity)
    : 1;
  const candidates = parsePopulationCounts(observations, maximumCapacity).filter(
    (item) =>
      item.capacity >= minimumCapacity &&
      item.capacity <= maximumCapacity
  );
  return candidates[0] ?? null;
}

function parsePopulationCounts(observations, maximumCapacity = 110) {
  const sorted = [...(observations || [])]
    .filter((item) => String(item?.text || "").trim())
    .sort((left, right) => Number(left?.x || 0) - Number(right?.x || 0));
  const candidates = [];
  const addCandidate = (currentDigits, capacityDigits) => {
    const current = normalizePopulationDigits(currentDigits, maximumCapacity);
    const capacity = normalizePopulationDigits(capacityDigits, maximumCapacity);
    if (current === null || capacity === null) return;
    if (current >= 0 && capacity >= 0 && current <= capacity) {
      candidates.push({ current, capacity });
    }
  };

  for (let index = 0; index < sorted.length; index += 1) {
    const text = normalizePopulationText(sorted[index]?.text);
    // Prefer a fraction contained in one OCR token. The adjacent info icon
    // is deliberately not part of this token and must never become a digit.
    const complete = text.match(/(\d{1,3})\/(\d{1,3})/);
    if (complete) {
      addCandidate(complete[1], complete[2]);
      continue;
    }

    const slash = text.indexOf("/");
    if (slash >= 0) {
      const leftDigits = text.slice(0, slash).match(/(\d{1,3})$/)?.[1] || "";
      const rightDigits = text.slice(slash + 1).match(/^(\d{1,3})/)?.[1] || "";
      if (leftDigits && rightDigits) {
        addCandidate(leftDigits, rightDigits);
        continue;
      }
      // OCR may split `0/5` into `0/` and `5（`. Only consume the first
      // digit run from the immediately adjacent token needed to complete the
      // fraction; standalone `0i`, `1i`, `2i` remain unrelated tokens.
      if (leftDigits && !rightDigits) {
        const nextDigits = normalizePopulationText(sorted[index + 1]?.text)
          .match(/^(\d{1,3})/)?.[1] || "";
        addCandidate(leftDigits, nextDigits);
      }
      continue;
    }

    // The slash itself may be a separate OCR token: `0` followed by `/0`.
    // This is the only other cross-token combination permitted.
    if (/^\d{1,3}$/.test(text)) {
      const next = normalizePopulationText(sorted[index + 1]?.text);
      const splitRight = next.match(/^\/(\d{1,3})/)?.[1] || "";
      if (splitRight) addCandidate(text, splitRight);
    }
  }
  return candidates;
}

function normalizePopulationText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[／]/g, "/");
}

function normalizePopulationDigits(value, maximumCapacity) {
  const digits = String(value || "").match(/^\d{1,3}$/)?.[0];
  if (!digits) return null;
  const numeric = Number.parseInt(digits, 10);
  if (!Number.isFinite(numeric)) return null;
  // A trailing info-button stroke is commonly attached to `10` as `101`.
  // Only the sailing-citizen range may use this repair; 101 is a valid formal
  // citizen count and must remain 101 there.
  if (maximumCapacity <= 10 && numeric === 101) return 10;
  if (maximumCapacity <= 10 && numeric > 10) return null;
  return numeric;
}

function observationsInHorizontalRegion(observations, region) {
  return (observations || []).filter((item) => {
    const x = Number(item.x) || 0;
    const width = Number(item.width) || 0;
    const center = x + width / 2;
    const y = Number(item.y) || 0;
    const height = Number(item.height) || 0;
    const centerY = y + height / 2;
    return (
      center >= region.left &&
      center < region.right &&
      centerY >= region.top &&
      centerY < region.bottom
    );
  });
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
