import { delay } from "../process.mjs";
import { writeMemberTaskResult } from "../task-results.mjs";
import { normalizeProfiles, parseTable } from "../table-parser.mjs";
import { memberAlignmentSwipe } from "./member-sync.mjs";
import { updateWorkflowProgress } from "./progress.mjs";

const WEEKLY_ACTIVITY_PAGE_STEP_PX = 357;
const ZERO = 0;

export async function runWeeklyActivitySync(context, command, _bundle, signal) {
  const roster = Array.isArray(context.memberRoster)
    ? context.memberRoster.filter((member) => member?.name)
    : [];
  if (!roster.length) {
    throw new Error(
      "WEEKLY_ACTIVITY_MASTER_LIST_MISSING: 未读取到更新成员资料任务保存的成员主名单，请先执行“更新成员资料”"
    );
  }

  const config = context.pluginConfig?.weeklyPlan || {};
  const definition = context.pluginConfig?.tables?.weeklyActivity;
  if (!definition?.region || !definition?.columns) {
    throw new Error("WEEKLY_ACTIVITY_TABLE_CONFIG_MISSING: 周活跃点表格未完成校准");
  }

  await updateWorkflowProgress(context, 0.04, "weekly_activity_prepare");
  await context.ui.executeFlow("openCampPanel", {}, signal);
  await updateWorkflowProgress(context, 0.22, "weekly_activity_camp_panel");

  await context.ui.clickText(
    "参与活动",
    {
      region: config.participateButtonRegion,
      timeoutSeconds: 15,
      regionOcrMinimumConfidence: 0.18,
      regionOcrScale: 2
    },
    signal
  );
  await delay(2_000, signal);
  const weeklyPlanFrame = await waitForWeeklyPlan(context, config, signal);
  if (weeklyPlanFrame.noRecords) {
    await context.report(
      "info",
      "weekly_activity_empty",
      "营地周计划显示暂无周活跃记录，已为全部成员写入周活跃点 0"
    );
    return await submitWeeklyActivity(
      context,
      command,
      roster.map((member) => ({ name: member.name, weeklyActivityPoints: ZERO })),
      signal,
      { emptyState: "暂无周活跃记录" }
    );
  }

  await context.ui.clickText(
    "活跃排行",
    {
      region: config.rankingButtonRegion,
      timeoutSeconds: 15,
      regionOcrMinimumConfidence: 0.18,
      regionOcrScale: 2
    },
    signal
  );
  await delay(1_800, signal);
  const rankingFrame = await waitForRankingPage(context, config, signal);
  if (rankingFrame.noRanking) {
    await context.report(
      "info",
      "weekly_activity_no_ranking",
      "活跃排行显示暂无排名，已为全部成员写入周活跃点 0"
    );
    return await submitWeeklyActivity(
      context,
      command,
      roster.map((member) => ({ name: member.name, weeklyActivityPoints: ZERO })),
      signal,
      { emptyState: "暂无排名" }
    );
  }

  await updateWorkflowProgress(context, 0.36, "weekly_activity_ranking_ready");
  const rows = await captureWeeklyActivityPages(
    context,
    definition,
    signal,
    { progressRange: { start: 0.38, end: 0.82 } }
  );
  if (!rows.length) {
    throw new Error(
      "WEEKLY_ACTIVITY_SCAN_UNREADABLE: 活跃排行页面已确认，但未能读取到任何排名行，已保留原有周活跃点"
    );
  }
  return submitWeeklyActivity(context, command, rows, signal, {
    pages: rows.__pages,
    recognized: rows.length
  });
}

async function waitForWeeklyPlan(context, config, signal) {
  return waitForKeywords(
    context,
    config.verifyTexts || [],
    config.panelRegion,
    {
      emptyText: "暂无周活跃记录",
      label: "weekly_activity_plan",
      minimum: 3
    },
    signal
  );
}

async function waitForRankingPage(context, config, signal) {
  return waitForKeywords(
    context,
    config.rankingTexts || ["排名", "成员", "活跃点"],
    config.panelRegion,
    {
      emptyText: "暂无排名",
      label: "weekly_activity_ranking",
      minimum: 3
    },
    signal
  );
}

async function waitForKeywords(context, keywords, region, options, signal) {
  const texts = keywords.filter((text) => String(text || "").trim());
  const deadline = Date.now() + 20_000;
  let lastMatches = [];
  while (Date.now() < deadline) {
    const frame = await context.vision.captureTransient(options.label, signal);
    const observations = frame.observations || [];
    const matches = texts.filter((text) =>
      context.ui.findInRegion(observations, text, region)
    );
    lastMatches = matches;
    if (context.ui.findInRegion(observations, options.emptyText, region)) {
      return { frame, empty: true, [options.emptyText === "暂无排名" ? "noRanking" : "noRecords"]: true };
    }
    if (matches.length >= options.minimum) return { frame, matches };
    if (typeof context.vision.captureAccurateTransient === "function") {
      const accurate = await context.vision
        .captureAccurateTransient(`${options.label}-accurate`, signal)
        .catch(() => null);
      const accurateObservations = accurate?.observations || [];
      const accurateMatches = texts.filter((text) =>
        context.ui.findInRegion(accurateObservations, text, region)
      );
      lastMatches = accurateMatches;
      if (context.ui.findInRegion(accurateObservations, options.emptyText, region)) {
        return { frame: accurate, empty: true, [options.emptyText === "暂无排名" ? "noRanking" : "noRecords"]: true };
      }
      if (accurateMatches.length >= options.minimum) {
        return { frame: accurate, matches: accurateMatches };
      }
    }
    await delay(800, signal);
  }
  throw new Error(
    `WEEKLY_ACTIVITY_PAGE_UNVERIFIED: 未能确认${options.label === "weekly_activity_plan" ? "营地周计划" : "活跃排行"}页面，已识别：${lastMatches.join("、") || "无"}`
  );
}

async function captureWeeklyActivityPages(context, definition, signal, options) {
  const rowsByRank = new Map();
  const pagination = definition.pagination || {};
  const maxPages = Math.max(1, Number(pagination.maxPages) || 40);
  let previousLastRank = null;
  let scannedPages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    scannedPages = page + 1;
    const frame = await captureWeeklyTableFrame(
      context,
      `weekly-activity-${scannedPages}`,
      definition,
      signal
    );
    const expectedFirstRank =
      previousLastRank === null ? 1 : previousLastRank + 1;
    let rows = await extractWeeklyRows(
      context,
      frame,
      definition,
      scannedPages,
      signal,
      false,
      expectedFirstRank
    );
    const rowsPerPage = Math.max(1, Number(pagination.rowsPerPage) || 4);
    if (rows.length > rowsPerPage) rows = rows.slice(0, rowsPerPage);
    if (
      rows.length < rowsPerPage ||
      rows.some((row) => !String(row?.name || "").trim())
    ) {
      const retry = await captureWeeklyTableFrame(
        context,
        `weekly-activity-${scannedPages}-accurate`,
        definition,
        signal,
        true
      );
      const retryRows = await extractWeeklyRows(
        context,
        retry,
        definition,
        scannedPages,
        signal,
        true,
        expectedFirstRank
      );
      rows = mergeWeeklyRows(rows, retryRows, context.memberRoster, {
        allowUnmatchedBlankFill: true
      });
      if (rows.length > rowsPerPage) rows = rows.slice(0, rowsPerPage);
    }
    const emptyRanks = rows
      .filter((row) => !String(row?.name || "").trim())
      .map((row) => row.rank);
    // The last visible rank comes from the left rank column, including an
    // empty virtual row. Do not derive it from the last non-empty name: a
    // blank row can appear anywhere and must not shift the following ranks.
    const observedLastRank = rows
      .map((row) => parseInteger(row?.rank))
      .filter((rank) => rank > 0)
      .reduce((maximum, rank) => Math.max(maximum, rank), 0);
    const lastRank = observedLastRank || rows.at(-1)?.rank || null;
    rows = finalizeWeeklyPageRows(rows, expectedFirstRank, rowsPerPage);
    for (const row of rows) {
      if (!rowsByRank.has(row.rank)) rowsByRank.set(row.rank, row);
    }
    await context.report(
      "info",
      "weekly_activity_page",
      `周活跃点第 ${scannedPages} 页识别 ${rows.length} 名玩家，当前最后排名 ${lastRank ?? "未知"}，累计 ${rowsByRank.size} 名${emptyRanks.length ? `；忽略空白虚空行 ${emptyRanks.join("、")}` : ""}`,
      {
        page: scannedPages,
        recognizedRows: rows.length,
        lastRank,
        accumulatedRows: rowsByRank.size,
        emptyPlaceholderRanks: emptyRanks,
        screenshot: frame.path
      }
    );
    await updateWorkflowProgress(
      context,
      options.progressRange.start +
        (options.progressRange.end - options.progressRange.start) *
          (scannedPages / maxPages),
      "weekly_activity_scan"
    );

    if (previousLastRank !== null && lastRank !== null && lastRank === previousLastRank) {
      await context.report(
        "info",
        "weekly_activity_bottom_reached",
        `翻页后左侧最后排名仍为 ${lastRank}，确认活跃排行已到底部`
      );
      break;
    }
    if (lastRank === null) {
      throw new Error(
        `WEEKLY_ACTIVITY_PAGE_UNREADABLE: 第 ${scannedPages} 页未识别到排名，停止继续翻页`
      );
    }
    previousLastRank = lastRank;
    if (page + 1 >= maxPages) {
      throw new Error(`WEEKLY_ACTIVITY_PAGE_LIMIT: 超过 ${maxPages} 页仍未确认列表底部`);
    }
    const from = pagination.from || { x: 405, y: 780 };
    const rowStep = measureWeeklyActivityRowStep(frame, definition);
    const swipeOffsetPx = WEEKLY_ACTIVITY_PAGE_STEP_PX;
    const to = {
      ...(pagination.to || { x: 405, y: 400 }),
      y: Math.round(Number(from.y) - swipeOffsetPx)
    };
    const usedTouchFallback = await memberAlignmentSwipe(
      context.adb,
      from,
      to,
      Number(pagination.durationMs) || 900,
      signal
    );
    await context.report(
      usedTouchFallback ? "warning" : "info",
      "weekly_activity_page_swipe",
      `按固定距离上移 ${swipeOffsetPx}px，连续读取 ${Number(pagination.rowsPerPage) || 4} 行`,
      {
        page: scannedPages,
        rowStepPx: rowStep,
        swipeOffsetTargetPx: WEEKLY_ACTIVITY_PAGE_STEP_PX,
        swipeOffsetPx,
        from,
        to,
        usedTouchFallback
      }
    );
    await delay(Number(pagination.settleAfterSwipeMs) || 1_800, signal);
  }
  const result = [...rowsByRank.values()]
    .sort((left, right) => left.rank - right.rank)
    .map(({ name, weeklyActivityPoints }) => ({ name, weeklyActivityPoints }));
  Object.defineProperty(result, "__pages", { value: scannedPages, enumerable: false });
  return result;
}

function measureWeeklyActivityRowStep(frame, definition) {
  const region = definition?.readRegion || definition?.region;
  const rankColumn = definition?.columns?.find((column) => column.key === "rank");
  if (!region || !rankColumn || !Array.isArray(frame?.observations)) return null;
  const width = region.right - region.left;
  const left = region.left + width * rankColumn.left;
  const right = region.left + width * rankColumn.right;
  const centers = frame.observations
    .filter((item) => {
      const x = Number(item?.x);
      const y = Number(item?.y);
      const itemRight = x + Number(item?.width || 0);
      const itemBottom = y + Number(item?.height || 0);
      return (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        itemRight >= left &&
        x <= right &&
        itemBottom >= region.top &&
        y <= region.bottom &&
        /^\s*\d{1,4}\s*$/.test(String(item?.text || ""))
      );
    })
    .map((item) => Number(item.y) + Number(item.height || 0) / 2)
    .sort((a, b) => a - b);
  const unique = [];
  for (const center of centers) {
    if (!unique.length || center - unique.at(-1) > 18) unique.push(center);
  }
  if (unique.length < 2) return null;
  const gaps = unique
    .slice(1)
    .map((center, index) => center - unique[index])
    .filter((gap) => gap >= 35 && gap <= 180);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

async function captureWeeklyTableFrame(
  context,
  label,
  definition,
  signal,
  accurate = false
) {
  if (typeof context.vision.captureTable === "function") {
    return context.vision.captureTable(label, definition, signal, { accurate });
  }
  if (accurate && typeof context.vision.captureAccurate === "function") {
    return context.vision.captureAccurate(label, signal);
  }
  return context.vision.capture(label, signal);
}

async function extractWeeklyRows(
  context,
  frame,
  definition,
  page,
  signal,
  accurate = false,
  expectedFirstRank = 1
) {
  // The source frame keeps its original dimensions and has an opaque mask over
  // the avatar column. Read the name and point columns by fixed row slots so a
  // missing OCR token can never shift the following player into its rank.
  const ocrRows = await extractFixedWeeklyRows(
    context,
    frame,
    definition,
    page,
    signal,
    accurate,
    expectedFirstRank
  );
  let rows = ocrRows;
  let qwenRows = [];
  let confirmedBlankSlots = new Set();
  await context.report(
    "info",
    "weekly_activity_ocr_rows",
    `周活跃点第 ${page} 页原生 OCR（已遮罩头像列，保留原图尺寸）识别成员 ${ocrRows.filter((row) => row.name).length} 名：${formatWeeklyNames(ocrRows)}`,
    {
      page,
      accurate,
      source: "native_ocr",
      avatarMaskRegion: weeklyActivityAvatarMaskRegion(definition),
      fixedRowMaskRegion: definition.fixedRowMaskRegion || null,
      rows: ocrRows
    }
  );
  const shouldUseVision =
    frame.path &&
    typeof context.vision.extractTableRows === "function" &&
    (accurate ||
      rows.length < (Number(definition.pagination?.rowsPerPage) || 4) ||
      rows.some((row) => !String(row?.name || "").trim()) ||
      context.vision.advisor?.enabled === true);
  if (shouldUseVision) {
    const qwenRowsPerPage = Number(definition.pagination?.rowsPerPage) || 4;
    const missingRows = rows.some((row) => !String(row?.name || "").trim());
    // A blank row is not immediately a void player. Re-read the page four
    // times with Qwen; a real name that survives at least two reads (or has
    // brown name-ink evidence) is retained, while a numeric-only/blank row
    // remains a virtual placeholder.
    const maxQwenAttempts = missingRows ? 4 : 1;
    let qwenAttemptCount = 0;
    const visionAttempts = [];
    for (let attempt = 0; attempt < maxQwenAttempts; attempt += 1) {
      qwenAttemptCount = attempt + 1;
      const recovered = await context.vision
        .extractTableRows(
          frame.path,
          definition,
          `weekly-activity-${page}-vision-reread-${attempt + 1}`,
          signal,
          { forceWeeklyActivityVision: true }
        )
        .catch(async (error) => {
          await context.report(
            "warning",
            "weekly_activity_ai_recovery_failed",
            `周活跃点第 ${page} 页第 ${attempt + 1}/${maxQwenAttempts} 次视觉辅助读取失败，保留其他读取结果`,
            { reason: error.message, attempt: attempt + 1, qwenAttemptCount: maxQwenAttempts }
          );
          return [];
        });
      const normalized = normalizeWeeklyVisionRows(
        recovered,
        expectedFirstRank,
        qwenRowsPerPage
      );
      visionAttempts.push({ recovered, rows: normalized });
      if (qwenAttemptCount > 1) {
        await context.report(
          "info",
          "weekly_activity_qwen_reread",
            `周活跃点第 ${page} 页第 ${attempt + 1}/${maxQwenAttempts} 次 Qwen 重读：${formatWeeklyNames(normalized)}`,
            {
              page,
              attempt: attempt + 1,
              qwenAttemptCount: maxQwenAttempts,
            rawRows: recovered,
            rows: normalized,
            avatarMaskRegion: weeklyActivityAvatarMaskRegion(definition),
            fixedRowMaskRegion: definition.fixedRowMaskRegion || null
          }
        );
      }
      const validRows = new Set(
        normalized
          .filter((row) => row.name)
          .map((row) => Number(row.__rowSlot))
          .filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= qwenRowsPerPage)
      );
      if (missingRows && validRows.size >= qwenRowsPerPage) break;
    }
    const consensus = selectWeeklyVisionConsensus(
      visionAttempts,
      rows,
      context.memberRoster,
      visionAttempts.some(
        (attempt) =>
          new Set(
            attempt.rows
              .filter((row) => row.name)
              .map((row) => Number(row.__rowSlot))
              .filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= qwenRowsPerPage)
          ).size >= qwenRowsPerPage
      )
    );
    qwenRows = consensus.rows;
    confirmedBlankSlots = consensus.confirmedBlankSlots;
    const recovered = visionAttempts.at(-1)?.recovered || [];
    await context.report(
      "info",
      "weekly_activity_qwen_rows",
      `周活跃点第 ${page} 页 Qwen 辅助识别成员 ${qwenRows.length} 名（${qwenAttemptCount} 次读取后确认，已遮罩头像列，保留原图尺寸）：${formatWeeklyNames(qwenRows)}`,
      {
        page,
        accurate,
        source: "qwen_vision",
        rawRows: recovered,
        rereadAttempts: qwenAttemptCount,
        avatarMaskRegion: weeklyActivityAvatarMaskRegion(definition),
        fixedRowMaskRegion: definition.fixedRowMaskRegion || null,
        rows: qwenRows
      }
    );
    rows = mergeWeeklyRows(rows, qwenRows, context.memberRoster, {
      confirmedBlankSlots
    });
  }
  await context.report(
    "info",
    "weekly_activity_final_rows",
    `周活跃点第 ${page} 页最终采用成员 ${rows.filter((row) => row.name).length} 名：${formatWeeklyNames(rows)}`,
    {
      page,
      accurate,
      source: qwenRows.length ? "ocr_plus_qwen" : "native_ocr",
      ocrRows,
      qwenRows,
      finalRows: rows.filter((row) => row.name),
      emptyRows: rows
        .filter((row) => !row.name)
        .map((row) => ({ rank: row.rank, weeklyActivityPoints: row.weeklyActivityPoints }))
    }
  );
  return rows;
}

function normalizeWeeklyVisionRows(recovered, expectedFirstRank, rowsPerPage) {
  const recoveredWithRank = recovered.map((row, index) => {
    const visibleRow = Number(row?.row);
    const rowOffset =
      Number.isInteger(visibleRow) && visibleRow >= 1 && visibleRow <= rowsPerPage
        ? visibleRow - 1
        : index;
    const reportedRank = parseInteger(row?.rank);
    return {
      ...row,
      rank: reportedRank || expectedFirstRank + rowOffset,
      __rowSlot: rowOffset + 1
    };
  });
  return normalizeWeeklyRows(recoveredWithRank, [], {
    useRankFallbackOnly: false,
    allowCurrentPlayerName: true
  });
}

function selectWeeklyVisionConsensus(
  attempts,
  primaryRows,
  roster = [],
  fullPageConfirmed = false
) {
  const confirmedBlankSlots = new Set();
  const rows = [];
  const slots = new Set(
    attempts.flatMap((attempt) => attempt.rows.map((row) => Number(row.__rowSlot)))
  );
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 1) continue;
    const candidates = attempts
      .flatMap((attempt) => attempt.rows)
      .filter((row) => Number(row.__rowSlot) === slot && row.name);
    if (!candidates.length) continue;
    const primary = primaryRows.find((row) => Number(row.__rowSlot) === slot);
    const groups = [];
    for (const candidate of candidates) {
      const canonical = matchWeeklyRosterName(candidate.name, roster) || candidate.name;
      const key = weeklyNameKey(canonical);
      let group = groups.find((item) => item.key === key);
      if (!group) {
        group = { key, count: 0, candidate: { ...candidate, name: canonical } };
        groups.push(group);
      }
      group.count += 1;
      // Prefer a later read on a tie; accurate retries often resolve a
      // symbol-heavy name more reliably than the first fast read.
      group.candidate = { ...candidate, name: canonical };
    }
    groups.sort((left, right) => right.count - left.count);
    const selected = groups[0];
    const hasColorEvidence = primary?.__nameColorEvidence?.detected === true;
    // Existing non-empty native rows may use Qwen's more accurate symbols on
    // a single read. Only a blank native row needs the stricter four-read
    // confirmation (or the brown-ink signal).
    const confirmed =
      primary?.name ||
      selected.count >= 2 ||
      hasColorEvidence ||
      fullPageConfirmed;
    if (confirmed) {
      rows.push(selected.candidate);
      if (!primary?.name) confirmedBlankSlots.add(slot);
    }
  }
  return {
    rows: rows.sort((left, right) => left.rank - right.rank),
    confirmedBlankSlots
  };
}

async function extractFixedWeeklyRows(
  context,
  frame,
  definition,
  page,
  signal,
  accurate,
  expectedFirstRank
) {
  if (!frame.path || typeof context.vision.ocrRegion !== "function") {
    return normalizeWeeklyRows(
      parseWeeklyContentRows(frame.observations || [], definition),
      [],
      { useRankFallbackOnly: false }
    );
  }
  const readDefinition = weeklyActivityReadDefinition(definition);
  const contentDefinition = weeklyActivityContentDefinition(readDefinition);
  const contentRegion = contentDefinition.region;
  const rowsPerPage = Math.max(
    1,
    Number(definition.pagination?.rowsPerPage) || 4
  );
  const totalHeight = Math.max(1, contentRegion.bottom - contentRegion.top);
  const rowHeight =
    Number(definition.pagination?.rowHeightPx) > 0
      ? Number(definition.pagination.rowHeightPx)
      : totalHeight / rowsPerPage;
  const mode = accurate
    ? "accurate"
    : context.config?.vision?.mode || "fast";
  const minimumConfidence = Number.isFinite(
    Number(definition.ocrMinimumConfidence)
  )
    ? Number(definition.ocrMinimumConfidence)
    : 0.25;
  const rows = [];
  const firstRowTopPadding = Math.max(
    0,
    Number(definition.pagination?.firstRowTopPaddingPx) || 0
  );
  for (let index = 0; index < rowsPerPage; index += 1) {
    const top =
      contentRegion.top +
      index * rowHeight -
      (index === 0 ? firstRowTopPadding : 0);
    const bottom = Math.min(contentRegion.bottom, top + rowHeight);
    if (bottom <= top) continue;
    const observations = await context.vision.ocrRegion(
      frame.path,
      { ...contentRegion, top, bottom },
      `weekly-activity-${page}-row-${index + 1}`,
      signal,
      mode,
      minimumConfidence,
      2
    ).catch((error) => {
      if (signal?.aborted) throw error;
      return [];
    });
    const rowDefinition = {
      // Keep the rank column in the per-row OCR. At the bottom of the list
      // the game clamps the scroll position, so the next page may overlap
      // the previous page instead of starting at expectedFirstRank.
      ...readDefinition,
      region: { ...contentRegion, top, bottom },
      rowAnchorTop: null
    };
    let parsedRows = parseTable(observations, rowDefinition);
    let row = selectWeeklyParsedRow(parsedRows, expectedFirstRank + index, {
      keepEmptyRows: true
    });
    let nameColorEvidence = null;
    if (!row && typeof context.vision.detectWeeklyActivityNameInk === "function") {
      const nameRegion = weeklyActivityNameRegion(
        definition,
        top,
        bottom
      );
      nameColorEvidence = await context.vision
        .detectWeeklyActivityNameInk(frame.path, nameRegion, signal)
        .catch(() => ({ detected: false, sampleCount: 0, brownPointCount: 0 }));
      if (nameColorEvidence.detected) {
        await context.report(
          "info",
          "weekly_activity_name_color_reread",
          `周活跃点第 ${page} 页第 ${index + 1} 行名称区域检测到棕色文字色块，正在重读确认`,
          {
            page,
            row: index + 1,
            rank: expectedFirstRank + index,
            nameRegion,
            colorEvidence: nameColorEvidence
          }
        );
        const rereadObservations = await context.vision
          .ocrRegion(
            frame.path,
            { ...contentRegion, top, bottom },
            `weekly-activity-${page}-row-${index + 1}-name-reread`,
            signal,
            "accurate",
            Math.max(0.12, minimumConfidence * 0.6),
            3
          )
          .catch((error) => {
            if (signal?.aborted) throw error;
            return [];
          });
        parsedRows = parseTable(rereadObservations, rowDefinition);
        row = selectWeeklyParsedRow(parsedRows, expectedFirstRank + index, {
          keepEmptyRows: true
        });
      }
    }
    if (!row) {
      [row] = normalizeWeeklyRows(
        [
          {
            rank: expectedFirstRank + index,
            name: "",
            weeklyActivityPoints: 0
          }
        ],
        [],
        { useRankFallbackOnly: false, keepEmptyRows: true }
      );
    }
    if (row && nameColorEvidence) {
      row.__nameColorEvidence = nameColorEvidence;
    }
    if (row) {
      row.__rowSlot = index + 1;
      rows.push(row);
    }
  }
  return rows;
}

function selectWeeklyParsedRow(parsedRows, fallbackRank, options = {}) {
  for (const candidate of parsedRows) {
    const candidateRank = parseInteger(candidate.rank) || fallbackRank;
    const [normalized] = normalizeWeeklyRows(
      [{ ...candidate, rank: candidateRank }],
      [],
      {
        useRankFallbackOnly: false,
        keepEmptyRows: options.keepEmptyRows === true,
        allowCurrentPlayerName: options.allowCurrentPlayerName === true
      }
    );
    if (normalized && (normalized.name || options.keepEmptyRows)) return normalized;
  }
  return null;
}

export function normalizeWeeklyRows(rows, rankFallback = [], options = {}) {
  return rows
    .map((row, index) => {
      // Keep weekly ranking names on the exact same profile-name path as the
      // authoritative member scan. This preserves symbol-only names while
      // removing avatar years, identity badges, and profession-only OCR
      // artifacts before OCR/Qwen rows are merged or sent to Workers.
      const [profile] = normalizeProfiles([
        {
          name: collapseRepeatedWeeklyName(row.name),
          profession: row.profession || null
        }
      ]);
      const normalized = {
        rank:
          parseInteger(rankFallback[index]) ||
          (options.useRankFallbackOnly ? 0 : parseInteger(row.rank)),
        name: profile?.name || "",
        weeklyActivityPoints: parseInteger(row.weeklyActivityPoints)
      };
      if (Number.isInteger(Number(row.__rowSlot))) {
        normalized.__rowSlot = Number(row.__rowSlot);
      }
      if (row.__nameColorEvidence) {
        normalized.__nameColorEvidence = row.__nameColorEvidence;
      }
      return normalized;
    })
    .filter(
      (row) =>
        row.rank > 0 &&
        (options.keepEmptyRows || row.name) &&
        (!row.name ||
          (!/^\d{1,4}$/u.test(row.name) &&
            !/排名|成员|活跃点|暂无排名/.test(row.name) &&
            (options.allowCurrentPlayerName === true ||
              !/愿营地助手|营地助手/.test(row.name))))
    );
}

function finalizeWeeklyPageRows(rows, expectedFirstRank, rowsPerPage) {
  const ordered = [...rows]
    .sort((left, right) => left.rank - right.rank)
    .slice(0, rowsPerPage);
  const namedRows = ordered.filter((row) => String(row?.name || "").trim());
  if (!namedRows.length) return [];
  const namedRanks = namedRows.map((row) => row.rank);
  const hasDuplicateRank = new Set(namedRanks).size !== namedRanks.length;
  if (hasDuplicateRank) {
    throw new Error(
      `WEEKLY_ACTIVITY_RANK_GAP: 第 ${expectedFirstRank} 至 ${
        expectedFirstRank + rowsPerPage - 1
      } 名未保持一行一名，或读取到了重复排名，拒绝提交不完整排行`
    );
  }
  // The game can render a blank virtual player at any visible rank, sometimes
  // with a bogus activity-point value. It is not a player and must not shift
  // the following rank into its slot. The fixed row rank remains attached to
  // each named row, so a gap here is intentional rather than a re-indexing.
  return namedRows;
}

function collapseRepeatedWeeklyName(value) {
  const name = String(value || "").trim();
  const parts = name.split(/[\s\u200b\u200c\u200d]+/u).filter(Boolean);
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  const compact = name.replace(/[\s\u200b\u200c\u200d]/gu, "");
  const codePoints = [...compact];
  if (
    codePoints.length > 1 &&
    codePoints.length % 2 === 0 &&
    codePoints.slice(0, codePoints.length / 2).join("") ===
      codePoints.slice(codePoints.length / 2).join("")
  ) {
    return codePoints.slice(0, codePoints.length / 2).join("");
  }
  return name;
}

function parseWeeklyContentRows(observations, definition) {
  const readDefinition = weeklyActivityReadDefinition(definition);
  const fullRows = parseTable(observations, readDefinition);
  const contentDefinition = weeklyActivityContentDefinition(readDefinition);
  const contentRows = parseTable(observations, contentDefinition);
  return contentRows.map((row, index) => ({
    ...row,
    rank: fullRows[index]?.rank || ""
  }));
}

function weeklyActivityAvatarMaskRegion(definition) {
  const configured =
    definition?.avatarMaskRegion || definition?.pagination?.avatarMaskRegion;
  if (configured) return configured;
  const card = definition?.cardRegion || definition?.readRegion || definition?.region;
  const width = Math.max(1, Number(card.right) - Number(card.left));
  return {
    left: Number(card.left) + width * 0.18,
    top: Number(card.top),
    right: Number(card.left) + width * 0.39,
    bottom: Number(card.bottom)
  };
}

function weeklyActivityReadDefinition(definition) {
  const region = definition?.readRegion || definition?.region;
  return region
    ? { ...definition, region, rowAnchorTop: null }
    : definition;
}

function weeklyActivityContentDefinition(definition) {
  const region = definition.region;
  return {
    ...definition,
    region,
    columns: definition.columns.filter((column) => column.key !== "rank"),
    rowAnchorTop: null
  };
}

function weeklyActivityNameRegion(definition, top, bottom) {
  const region = definition?.readRegion || definition?.region || {};
  const width = Number(region.right) - Number(region.left);
  const nameColumn = (definition?.columns || []).find(
    (column) => column?.key === "name"
  );
  const mask = weeklyActivityAvatarMaskRegion(definition);
  return {
    left: Math.max(
      Number(region.left) + width * Number(nameColumn?.left ?? 0.18),
      Number(mask.right)
    ),
    top,
    right: Number(region.left) + width * Number(nameColumn?.right ?? 0.78),
    bottom
  };
}

function formatWeeklyNames(rows) {
  const names = (rows || [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
  return names.length ? names.join("、") : "无";
}

function mergeWeeklyRows(primary, recovered, roster = [], options = {}) {
  const result = [...primary];
  const seen = new Set(result.map((row) => row.rank));
  for (const row of recovered) {
    const slot = Number(row.__rowSlot);
    const indexBySlot = Number.isInteger(slot)
      ? result.findIndex((item) => Number(item.__rowSlot) === slot)
      : -1;
    const indexByRank = result.findIndex((item) => item.rank === row.rank);
    const index = indexBySlot >= 0 ? indexBySlot : indexByRank;
    if (index < 0) {
      result.push(row);
      seen.add(row.rank);
      continue;
    }
    const current = result[index];
    if (current) {
      const recoveredName = row.name || "";
      const currentSlot = Number(current.__rowSlot);
      const canFillBlankName =
        current.name ||
        options.allowUnmatchedBlankFill === true ||
        (options.confirmedBlankSlots instanceof Set &&
          options.confirmedBlankSlots.has(currentSlot)) ||
        !roster.length ||
        current.__nameColorEvidence?.detected === true ||
        Boolean(matchWeeklyRosterName(recoveredName, roster));
      result[index] = {
        ...current,
        // Use the rank read from the left column for this fixed row slot. At
        // the end of the list the game clamps the scroll position and the
        // next page can overlap the previous ranks.
        rank: row.rank || current.rank,
        __rowSlot: current.__rowSlot || row.__rowSlot,
        // The Qwen row is aligned by its explicit visible row number. Prefer
        // that row-level reading when it is usable, because native OCR often
        // leaves a trailing badge/symbol artifact (for example 丼 instead of
        // ✨). Numeric-only model hallucinations have already been rejected by
        // normalizeWeeklyRows and therefore cannot replace a real name.
        name: canFillBlankName ? recoveredName || current.name : current.name,
        weeklyActivityPoints:
          current.weeklyActivityPoints || row.weeklyActivityPoints
      };
    }
  }
  return result
    .sort((left, right) => left.rank - right.rank);
}

function matchWeeklyRosterName(source, roster) {
  const wanted = weeklyNameKey(source);
  if (!wanted) return "";
  const members = (roster || [])
    .map((member) => String(member?.name || "").trim())
    .filter(Boolean);
  const exact = members.filter((name) => weeklyNameKey(name) === wanted);
  if (exact.length === 1) return exact[0];
  const core = weeklyNameCore(source);
  const coreMatches = members.filter((name) => weeklyNameCore(name) === core);
  if (coreMatches.length === 1) return coreMatches[0];
  const fuzzy = members
    .map((name) => ({ name, key: weeklyNameKey(name) }))
    .filter(({ key }) => {
      const minimum = Math.min(wanted.length, key.length);
      const maximumDistance = minimum >= 10 ? 2 : minimum >= 5 ? 1 : 0;
      return maximumDistance > 0 && weeklyNameDistance(wanted, key) <= maximumDistance;
    })
    .sort(
      (left, right) =>
        weeklyNameDistance(wanted, left.key) - weeklyNameDistance(wanted, right.key)
    );
  if (!fuzzy.length) return "";
  const bestDistance = weeklyNameDistance(wanted, fuzzy[0].key);
  const best = fuzzy.filter(
    (candidate) => weeklyNameDistance(wanted, candidate.key) === bestDistance
  );
  return best.length === 1 ? best[0].name : "";
}

function weeklyNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u200b\u200c\u200d]/gu, "");
}

function weeklyNameCore(value) {
  return Array.from(weeklyNameKey(value))
    .filter((character) => /[\p{L}\p{N}\u3400-\u9fff]/u.test(character))
    .join("");
}

function weeklyNameDistance(left, right) {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  let previous = Array.from({ length: rightChars.length + 1 }, (_, index) => index);
  for (let row = 1; row <= leftChars.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= rightChars.length; column += 1) {
      current.push(
        Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] +
            (leftChars[row - 1] === rightChars[column - 1] ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[rightChars.length];
}

function parseInteger(value) {
  const match = String(value ?? "").normalize("NFKC").match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : 0;
}

async function submitWeeklyActivity(context, command, rows, signal, detail = {}) {
  await updateWorkflowProgress(context, 0.88, "weekly_activity_snapshot");
  const capturedAt = new Date().toISOString();
  const result = await context.api.snapshot(
    command.runId,
    "weekly_activity",
    rows,
    capturedAt,
    signal
  );
  const matched = Number(result?.count) || 0;
  await writeMemberTaskResult({
    taskKey: "weekly_activity_sync",
    runId: command.runId,
    capturedAt,
    payload: rows,
    locale: context.locale
  });
  await updateWorkflowProgress(context, 0.97, "weekly_activity_complete");
  await context.report(
    result?.ignored || result?.ambiguous ? "warning" : "info",
    "weekly_activity_done",
    `周活跃点读取完成：识别 ${rows.length} 名玩家，更新 ${matched} 名；未出现在排行的成员按 0 处理`,
    {
      ...detail,
      recognized: rows.length,
      matched,
      ignored: Number(result?.ignored) || 0,
      ambiguous: Number(result?.ambiguous) || 0,
      finalRows: rows
    }
  );
  return result;
}
