import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAC_ROOT } from "./config.mjs";
import { runFile } from "./process.mjs";
import { LocalVisionAdvisor } from "./local-vision-advisor.mjs";
import {
  isMemberAvatarArtifact,
  isMemberIdentityBadge,
  isMemberProfessionArtifact,
  isPlausibleMemberName
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
        if (memberFraction !== null && citizenFraction !== null) {
          return {
            formalCurrent: memberFraction.current,
            formalTotal: memberFraction.capacity,
            sailingCurrent: citizenFraction.current,
            sailingTotal: citizenFraction.capacity,
            total: memberFraction.capacity + citizenFraction.capacity
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
    return breakdown.total;
  }

  async #extractContributionRows(
    imagePath,
    definition,
    label,
    signal,
    _options = {}
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
        .map((row, index) => ({
          ...row,
          name:
            (isPlausibleMemberName(row.name) && row.name) ||
            (isPlausibleMemberName(namesByRow.get(index + 1))
              ? namesByRow.get(index + 1)
              : "")
        }));
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
    // Online/offline OCR is only an alignment aid. A single missed status
    // token must not make the whole page look like a four-row page: the table
    // has calibrated geometry, so rebuild all row slots from that geometry
    // whenever the regional OCR returns fewer anchors than the visible page.
    // The caller still stops when repeated reads remain below the page minimum.
    const fixedRowHeight = Number(definition.pagination?.rowHeightPx);
    const fixedRowTop = Number(
      definition.rowAnchorTop ?? definition.pagination?.rowAnchorTop
    );
    if (
      anchors.length < rowsPerPage &&
      Number.isFinite(fixedRowHeight) &&
      fixedRowHeight > 0 &&
      Number.isFinite(fixedRowTop)
    ) {
      anchors = Array.from(
        { length: rowsPerPage },
        (_, index) => fixedRowTop + index * fixedRowHeight
      );
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
          isMemberProfessionArtifact(row.identity.name, row.profession)
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
                bottom: Math.min(region.bottom, row.lower + 14)
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
      const cropTop = Math.max(
        region.top,
        Math.floor(anchors[0] - rowSpacing / 2)
      );
      const advisorRowCount = forceMemberAdvisor
        ? Math.max(
            anchors.length,
            Number(definition.pagination?.fullPageRows) || rowsPerPage
          )
        : anchors.length;
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
    return rowData
      .map(({ items, identity, profession }, index) => {
        const ai = advisedByRow.get(index + 1) || {};
        const nativeName =
          isPlausibleMemberName(identity.name) &&
          !isMemberAvatarArtifact(identity.name) &&
          !isMemberProfessionArtifact(identity.name, profession)
            ? identity.name
            : "";
        const nativeNameDuplicated =
          nativeNameCounts.get(comparableVisionName(nativeName)) > 1;
        const advisedName = cleanMemberName(ai.name, profession);
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
      })
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
    return parseTable(observations, definition).filter(
      (row) =>
        isPlausibleMemberName(row.name) &&
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
  return /^(?:#\s*[BDGKOPRUWY](?:\s|#|$)|市长|营地助手|公职人员|职位|title\b)/i.test(
    String(value || "").trim()
  );
}

function cleanMemberName(value, profession = "") {
  const text = cleanModelText(value);
  return isPlausibleMemberName(text) &&
    !isMemberAvatarArtifact(text) &&
    !isMemberIdentityBadge(text) &&
    !isMemberProfessionArtifact(text, profession) &&
    !isLikelyMemberTitle(text)
    ? text
    : "";
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

function medianNumber(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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
  const candidates = parsePopulationCounts(observations).filter(
    (item) =>
      item.capacity >= minimumCapacity &&
      item.capacity <= maximumCapacity
  );
  return candidates[0] ?? null;
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
