import { delay } from "../process.mjs";

// This is the fixed title/control at the top of the 1920x1200 technology
// configuration screen. Clicking it collapses the slot detail drawer without
// changing the selected technology.
const TECHNOLOGY_CONFIG_HEADER_POINT = { x: 959, y: 208 };

export async function runTechnology(context, command, bundle, signal) {
  const plan = command.payload?.detail?.technologyPlan;
  if (!plan) throw new Error("Technology task has no generated plan");
  if (plan.clearExistingFirst !== true) {
    throw new Error("Refusing technology update without clearExistingFirst safety flag");
  }
  const { ui, config, vision, report } = context;
  await ui.executeFlow("openCampPanel", {}, signal);
  await ui.tap(config.technology.tabs.technology, signal);
  await ui.waitAnyText(["待生效科技", "科技配置"], {}, signal);
  await ui.tap(config.technology.tabs.pending, signal);
  await ui.tap(config.technology.tabs.configure, signal);
  const configurePageSettleMs = Math.max(
    5_000,
    Number(config.technology.configurePageSettleMs) || 5_000
  );
  await report(
    "info",
    "tech_config_page_settling",
    `已进入科技配置，固定等待 ${Math.round(configurePageSettleMs / 1000)} 秒，页面稳定后才开始点击第一格`
  );
  await (context.sleep || delay)(configurePageSettleMs, signal);
  await ui.waitAnyText(
    ["科技配置中", "科技选择", "集体科技"],
    { timeoutSeconds: 12 },
    signal
  );
  await report(
    "info",
    "tech_clear",
    "先移除右侧所有已配置科技，防止已选科技从左侧选择列表消失"
  );
  await clearAllConfiguredSlots(context, signal);

  let index = 0;
  const all = [...plan.core, ...plan.general];
  for (const [lane, technologies] of [
    ["core", plan.core],
    ["general", plan.general]
  ]) {
    if (technologies.length > config.technology.slots[lane].length) {
      throw new Error(
        `${lane === "core" ? "第一行" : "第二行"}科技数量 ${technologies.length} 超过可用槽位 ${config.technology.slots[lane].length}`
      );
    }
    for (let slotIndex = 0; slotIndex < technologies.length; slotIndex += 1) {
      const technology = technologies[slotIndex];
      await report(
        "info",
        "tech_add",
        `添加${lane === "core" ? "第一行" : "第二行"}科技：${technologyMainName(technology.uiLabel || technology.name)}`
      );
      // The game selector displays prerequisite technology in parentheses, but
      // the Agent must search and report only the main technology title.
      await selectTechnology(
        context,
        lane,
        slotIndex,
        technology.uiLabel || technology.name,
        signal
      );
      index += 1;
      await context.progress(0.2 + (index / Math.max(all.length, 1)) * 0.65, "tech_add");
      if (index < all.length) {
        await dismissTechnologyDetail(
          context,
          `technology-add-${lane}-${slotIndex + 1}`,
          signal
        );
      }
    }
  }

  await verifyFinalConfiguredSlots(context, plan, signal);
  const beforeSubmit = await vision.capture("technology-before-submit", signal);
  await report("info", "tech_cost", "已记录本次动态扣费信息，不对扣费数值作固定匹配", {
    screenshot: beforeSubmit.path
  });
  await ui.tap(config.technology.tabs.finish, signal);
  await ui.waitAnyText(["待生效科技", "当前生效科技"], {}, signal);
  await report("info", "tech_done", `已提交 ${all.length} 项次日科技`);
}

export async function verifyFinalConfiguredSlots(context, plan, signal) {
  const { config, report } = context;
  const slots = ["core", "general"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({
      ...point,
      lane,
      index,
      expectedTechnology: plan[lane]?.[index] ?? null
    }))
  );
  const mismatches = [];
  for (const slot of slots) {
    const laneLabel = slot.lane === "core" ? "第一行" : "第二行";
    await report(
      "info",
      "tech_final_slot_check",
      `安装后点击并读取${laneLabel}第 ${slot.index + 1} 格详情，确认其应为${slot.expectedTechnology ? `“${technologyMainName(slot.expectedTechnology.uiLabel || slot.expectedTechnology.name)}”` : "空"}`
    );
    // 槽位空图标会随页面状态、动画和光效发生像素变化。最终校验和安装前
    // 的清空检查相同：逐格点击后只由详情里的“卸下”动作确认是否已安装。
    const state = await readTechnologySlotState(
      context,
      slot,
      `technology-final-slot-${slot.lane}-${slot.index + 1}`,
      signal,
      { attempts: 1 }
    );
    const expectedFilled = Boolean(slot.expectedTechnology);
    const isLastSlot = slots.indexOf(slot) === slots.length - 1;
    if (state.occupied !== expectedFilled) {
      mismatches.push({
        lane: slot.lane,
        slot: slot.index + 1,
        expectedLabel: slot.expectedTechnology
          ? technologyMainName(
              slot.expectedTechnology.uiLabel || slot.expectedTechnology.name
            )
          : null,
        expectedFilled,
        detectedFilled: state.occupied
      });
      if (!isLastSlot) {
        await dismissTechnologyDetail(
          context,
          `technology-final-${slot.lane}-${slot.index + 1}`,
          signal
        );
      }
      continue;
    }
    if (!expectedFilled) {
      await report(
        "info",
        "tech_final_empty_slot_verified",
        `${laneLabel}第 ${slot.index + 1} 格已点击，详情未出现“卸下”，确认为空`
      );
    }
    if (!isLastSlot) {
      await dismissTechnologyDetail(
        context,
        `technology-final-${slot.lane}-${slot.index + 1}`,
        signal
      );
    }
  }
  if (mismatches.length) {
    throw new Error(
      `科技最终槽位校验失败：${mismatches
        .map(
          (item) =>
            `${item.lane === "core" ? "第一行" : "第二行"}第 ${item.slot} 格应为${item.expectedLabel ? `“${item.expectedLabel}”` : "空"}`
        )
        .join("、")}`
    );
  }
  await report(
    "info",
    "technology_final_verified",
    `正式 Agent 已逐格点击并通过详情“卸下”动作确认 ${slots.length} 个槽位：第一行 ${plan.core.length} 项、第二行 ${plan.general.length} 项，其余槽位为空`
  );
}

export async function clearAllConfiguredSlots(context, signal) {
  const { config, ui, vision, report } = context;
  const allSlots = ["core", "general"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({ ...point, lane, index }))
  );
  let processedSlots = 0;
  let configuredCount = 0;
  for (const lane of ["core", "general"]) {
    const laneSlots = config.technology.slots[lane]
      .map((point, index) => ({ ...point, lane, index }))
      .sort((a, b) => a.index - b.index);
    for (const slot of laneSlots) {
      await report(
        "info",
        "tech_slot_check",
        `按顺序检查${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格`
      );
      const before = await readTechnologySlotState(
        context,
        slot,
        `technology-clear-check-${lane}-${slot.index + 1}`,
        signal,
        {
          // Slot content is decided only by this actual click followed by
          // the detail OCR. A textured/animated empty slot can look filled
          // to a pixel probe, so pixels must never authorize an unload or
          // turn a missing detail action into a retry/fatal error.
          attempts: 1
        }
      );
      if (!before.occupied) {
        await report(
          "info",
          "tech_slot_empty",
          `${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格已实际点击，详情未出现“卸下”，确认为空，继续下一格`
        );
        processedSlots += 1;
        if (processedSlots < allSlots.length) {
          await dismissTechnologyDetail(
            context,
            `technology-clear-${lane}-${slot.index + 1}`,
            signal
          );
        }
        continue;
      }
      configuredCount += 1;
      await ui.tap(config.technology.unloadSelected, signal);
      const settleMs = Math.max(
        3_000,
        Number(config.technology.unloadSettleMs) || 3_000
      );
      await (context.sleep || delay)(settleMs, signal);
      const after = await readTechnologyCurrentDetailState(
        context,
        `technology-cleared-${lane}-${slot.index + 1}`,
        signal
      );
      if (after.occupied) {
        throw new Error(
          `科技卸下校验失败：${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格等待 ${Math.round(settleMs / 1000)} 秒后仍显示“卸下”`
        );
      }
      await report(
        "info",
        "tech_slot_unloaded",
        `${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格已在详情明确显示“卸下”后点击，并等待 ${Math.round(settleMs / 1000)} 秒确认按钮消失；继续下一个槽位`
      );
      processedSlots += 1;
      if (processedSlots < allSlots.length) {
        await dismissTechnologyDetail(
          context,
          `technology-clear-${lane}-${slot.index + 1}`,
          signal
        );
      }
    }
  }
  await report(
    "info",
    "tech_clear",
    `已按第一行 1–6、第二行 1–6 的顺序逐格检查并卸下 ${configuredCount} 项；卸下后未重复点击原槽位`
  );
}

async function dismissTechnologyDetail(context, label, signal) {
  const { config, ui, vision, report } = context;
  if (config.technology.dismissDetailBetweenSlots === false) return;
  const settleMs = 2_000;
  const maximumAttempts = 6;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    await ui.tap(TECHNOLOGY_CONFIG_HEADER_POINT, signal);
    await (context.sleep || delay)(settleMs, signal);
    const frame = await vision.capture(
      `${label}-dismiss-check-${attempt}`,
      signal
    );
    const detailAction = findTechnologyText(
      vision,
      frame.observations,
      "卸下",
      config.technology.detailsRegion
    );
    if (!detailAction) {
      await report(
        "info",
        "tech_detail_dismissed",
        `已点击顶部“科技配置中”并等待 ${Math.round(settleMs / 1000)} 秒，确认详情框已关闭；继续下一个槽位`,
        { label, point: TECHNOLOGY_CONFIG_HEADER_POINT, attempt, maximumAttempts }
      );
      return;
    }
    if (attempt < maximumAttempts) {
      await report(
        "warning",
        "tech_detail_dismiss_retry",
        `点击“科技配置中”并等待 ${Math.round(settleMs / 1000)} 秒后仍检测到详情遮挡，重试第 ${attempt + 1}/${maximumAttempts} 次`,
        { label, point: TECHNOLOGY_CONFIG_HEADER_POINT, attempt, maximumAttempts }
      );
    }
  }
  throw new Error(
    `科技详情框关闭校验失败：点击“科技配置中”重试 ${maximumAttempts} 次并每次等待 ${Math.round(settleMs / 1000)} 秒后仍检测到“卸下”，已停止以避免遮挡下一个槽位`
  );
}

export async function selectTechnology(
  context,
  lane,
  slotIndex,
  label,
  signal
) {
  const { config, ui, vision, adb, report } = context;
  label = technologyMainName(label) || String(label || "").trim();
  const slot = config.technology.slots[lane][slotIndex];
  if (!slot) throw new Error(`${lane} lane has no slot ${slotIndex + 1}`);
  await ui.tap(slot, signal);
  await (context.sleep || delay)(
    Math.max(1_000, Number(config.technology.slotOpenSettleMs) || 1_200),
    signal
  );
  let openCheck = await vision.capture(
    `technology-selector-open-check-${lane}-${slotIndex + 1}`,
    signal
  );
  await assertTechnologySlotSelected(
    context,
    slot,
    openCheck,
    lane,
    slotIndex,
    signal
  );
  let selectorClosed =
    vision.find(openCheck.observations, "点击槽位") ||
    vision.find(openCheck.observations, "可在此处选择科技");
  if (
    !selectorClosed &&
    typeof vision.captureAccurateTransient === "function"
  ) {
    const accurateOpenCheck = await vision.captureAccurateTransient(
      `technology-selector-open-check-${lane}-${slotIndex + 1}-accurate`,
      signal
    );
    selectorClosed =
      vision.find(accurateOpenCheck.observations, "点击槽位") ||
      vision.find(accurateOpenCheck.observations, "可在此处选择科技");
    openCheck = accurateOpenCheck;
  }
  if (selectorClosed) {
    throw new Error(
      `科技列表未打开：${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 格点击后仍显示“点击槽位”；禁止重复点击同一格以免折叠面板`
    );
  }
  const swipe = config.technology.selectorSwipe;
  for (
    let reset = 0;
    reset < (swipe.resetToTop?.repeats ?? 0);
    reset += 1
  ) {
    await adb.mouseSwipe(
      swipe.resetToTop.from,
      swipe.resetToTop.to,
      swipe.resetToTop.durationMs,
      signal
    );
  }
  const selectorSettleMs = Math.max(
    600,
    Number(config.technology.selectorSettleMs) || 800
  );
  await (context.sleep || delay)(selectorSettleMs, signal);
  let previousSelectorSignature = "";
  let unchangedPages = 0;
  for (let page = 0; page <= swipe.maxPages; page += 1) {
    const frame = await vision.capture(`technology-selector-${label}`, signal);
    let selectorObservations = frame.observations;
    let match = findTechnologyMatch(
      vision,
      selectorObservations,
      label,
      config.technology.selectorRegion
    );
    if (
      !match &&
      frame.path &&
      typeof vision.ocrRegion === "function"
    ) {
      try {
        const regional = await vision.ocrRegion(
          frame.path,
          config.technology.selectorRegion,
          `technology-selector-${label}-regional`,
          signal,
          "accurate",
          0.1,
          2
        );
        selectorObservations = regional;
        match = findTechnologyMatch(
          vision,
          regional,
          label,
          config.technology.selectorRegion
        );
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    if (
      !match &&
      typeof vision.captureAccurateTransient === "function"
    ) {
      const accurate = await vision.captureAccurateTransient(
        `technology-selector-${label}-accurate`,
        signal
      );
      match = findTechnologyMatch(
        vision,
        accurate.observations,
        label,
        config.technology.selectorRegion
      );
    }
    if (match) {
      const selectionAttempts = Math.max(
        2,
        Math.min(
          3,
          Number(config.technology.selectionConfirmAttempts) || 3
        )
      );
      for (
        let selectionAttempt = 1;
        selectionAttempt <= selectionAttempts;
        selectionAttempt += 1
      ) {
        const restedFrame = await vision.capture(
          `technology-selector-rested-${label}-${selectionAttempt}`,
          signal
        );
        let restedObservations = restedFrame.observations;
        let restedMatch = findTechnologyMatch(
          vision,
          restedObservations,
          label,
          config.technology.selectorRegion
        );
        if (
          !restedMatch &&
          restedFrame.path &&
          typeof vision.ocrRegion === "function"
        ) {
          const regional = await vision.ocrRegion(
            restedFrame.path,
            config.technology.selectorRegion,
            `technology-selector-rested-${label}-${selectionAttempt}-regional`,
            signal,
            "accurate",
            0.1,
            2
          ).catch(() => []);
          restedObservations = regional;
          restedMatch = findTechnologyMatch(
            vision,
            regional,
            label,
            config.technology.selectorRegion
          );
        }
        if (!restedMatch) {
          await report(
            "warning",
            "tech_target_moved_before_click",
            `左侧列表停止滚动后，第 ${selectionAttempt} 次复核未找到“${label}”；本次不点击配置`,
            { lane, slotIndex, page: page + 1 }
          );
          await (context.sleep || delay)(selectorSettleMs, signal);
          continue;
        }
        const matchedTextX =
          restedMatch.x + restedMatch.width / 2;
        const y = restedMatch.y + restedMatch.height / 2;
        const x =
          Number(config.technology.selectorItemTapX) || 178;
        await report(
          "info",
          "tech_target_found",
          `已在左侧列表第 ${page + 1} 页稳定匹配到科技“${label}”（选择尝试 ${selectionAttempt}/${selectionAttempts}）`,
          {
            lane,
            slotIndex,
            point: { x, y },
            matchedText: technologyMainName(restedMatch.text),
            matchedSourceText: restedMatch.text,
            matchedTextX
          }
        );
        await ui.tap({ x, y }, signal);
        await (context.sleep || delay)(
          Math.max(
            1_000,
            Number(config.technology.detailOpenSettleMs) ||
              1_200
          ),
          signal
        );
        const detail = await readSelectedTechnologyDetail(
          context,
          label,
          `technology-configure-check-${lane}-${slotIndex + 1}-${selectionAttempt}`,
          signal
        );
        if (!detail.action || !detail.nameMatches) {
          await report(
            "warning",
            "tech_selected_name_mismatch",
            `左侧准备选择“${label}”，但右侧详情顶部未确认同名科技；不会点击“配置”，正在从左侧重新选择`,
            {
              lane,
              slotIndex,
              expected: label,
              observedRightDetailTexts: detail.observedNameTexts,
              configureVisible: Boolean(detail.action),
              selectionAttempt,
              maximumAttempts: selectionAttempts
            }
          );
          await (context.sleep || delay)(selectorSettleMs, signal);
          continue;
        }
        await report(
          "info",
          "tech_selected_name_verified",
          `已确认左侧目标与右侧详情顶部均为“${label}”`
        );
        await report(
          "info",
          "tech_configure_selected",
          `左右名称一致，正在点击“配置”安装“${label}”`
        );
        await ui.tap(
          config.technology.configureSelected ||
            config.technology.unloadSelected,
          signal
        );
        const settleMs = Math.max(
          3_000,
          Number(config.technology.configureSettleMs) || 3_000
        );
        await (context.sleep || delay)(settleMs, signal);
        await report(
          "info",
          "tech_slot_configured",
          `“${label}”已在左右名称一致后点击配置并等待 ${Math.round(settleMs / 1000)} 秒；继续下一个槽位`
        );
        return;
      }
      throw new Error(
        `科技选择确认失败：左侧目标“${label}”与右侧详情顶部连续 ${selectionAttempts} 次未确认一致；未点击“配置”`
      );
    }
    const signature = technologySelectorSignature(
      selectorObservations,
      config.technology.selectorRegion
    );
    if (signature && signature === previousSelectorSignature) {
      unchangedPages += 1;
    } else {
      unchangedPages = 0;
      previousSelectorSignature = signature;
    }
    if (unchangedPages >= 2) {
      await report(
        "warning",
        "tech_selector_bottom_reached",
        `左侧科技列表连续 ${unchangedPages + 1} 次内容未变化，已到列表底部；停止继续滑动`
      );
      break;
    }
    if (page < swipe.maxPages) {
      await adb.mouseSwipe(swipe.from, swipe.to, swipe.durationMs, signal);
      await (context.sleep || delay)(selectorSettleMs, signal);
    }
  }
  throw new Error(`科技选择列表中找不到：${label}`);
}

async function readSelectedTechnologyDetail(
  context,
  expectedLabel,
  label,
  signal
) {
  const { config, vision } = context;
  const nameRegion =
    config.technology.selectedTechnologyNameRegion ||
    config.technology.detailsRegion;
  let frame = await vision.capture(label, signal);
  let observations = frame.observations;
  let action = findTechnologyText(
    vision,
    observations,
    "配置",
    config.technology.detailsRegion
  );
  let name = findTechnologyMatch(
    vision,
    observations,
    expectedLabel,
    nameRegion
  );
  if (
    (!action || !name) &&
    frame.path &&
    typeof vision.ocrRegion === "function"
  ) {
    const regional = await vision.ocrRegion(
      frame.path,
      config.technology.detailsRegion,
      `${label}-regional`,
      signal,
      "accurate",
      0.1,
      2
    ).catch(() => []);
    observations = regional;
    action =
      action ||
      findTechnologyText(
        vision,
        regional,
        "配置",
        config.technology.detailsRegion
      );
    name =
      name ||
      findTechnologyMatch(
        vision,
        regional,
        expectedLabel,
        nameRegion
      );
  }
  if (
    (!action || !name) &&
    typeof vision.captureAccurateTransient === "function"
  ) {
    const accurate = await vision
      .captureAccurateTransient(`${label}-accurate`, signal)
      .catch(() => null);
    if (accurate?.observations?.length) {
      observations = accurate.observations;
      frame = accurate;
      action =
        action ||
        findTechnologyText(
          vision,
          observations,
          "配置",
          config.technology.detailsRegion
        );
      name =
        name ||
        findTechnologyMatch(
          vision,
          observations,
          expectedLabel,
          nameRegion
        );
    }
  }
  return {
    action,
    nameMatches: Boolean(name),
    matchedName: name,
    observedNameTexts: observations
      .filter((item) => observationCenterInRegion(item, nameRegion))
      .map((item) => item.text)
      .filter((text) => text && text !== "配置")
      .slice(0, 12),
    observations,
    frame
  };
}

function observationCenterInRegion(item, region) {
  const x = item.x + item.width / 2;
  const y = item.y + item.height / 2;
  return (
    x >= region.left &&
    x <= region.right &&
    y >= region.top &&
    y <= region.bottom
  );
}

export function findTechnologyMatch(
  _vision,
  observations,
  label,
  region
) {
  const bounds = region || {
    left: 60,
    top: 180,
    right: 720,
    bottom: 1040
  };
  const inSelector = observations.filter((item) => {
    const x = item.x + item.width / 2;
    const y = item.y + item.height / 2;
    return (
      x > bounds.left &&
      x < bounds.right &&
      y > bounds.top &&
      y < bounds.bottom
    );
  });
  // Treat one visual list row as one candidate. This is important when OCR
  // returns the main name and its parenthetical prerequisite as two adjacent
  // observations: the row is evaluated as one technology item, then only the
  // text before the first parenthesis is compared. The prerequisite can never
  // be selected on its own.
  const rows = technologyObservationRows(inSelector);
  const exact = rows
    .map((row) => technologyRowMatch(row, label))
    .find(Boolean);
  return exact || uniqueFuzzyTechnologyMatch(rows, label);
}

function uniqueFuzzyTechnologyMatch(rows, label) {
  const wanted = technologyNameVariants(label);
  const candidates = [];
  for (const row of rows) {
    for (const text of technologyRowTexts(row)) {
      const normalized = technologyMainName(text);
      if (
        wanted.some(
          (candidate) =>
            candidate.length >= 4 &&
            Math.abs(normalized.length - candidate.length) <= 1 &&
            technologyTextDistance(normalized, candidate) <= 1
        )
      ) {
        candidates.push(technologyRowObservation(row, text));
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function technologyObservationRows(observations) {
  const items = observations
    .filter((item) => item && String(item.text || "").trim())
    .map((item) => ({
      ...item,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Math.max(0, Number(item.width) || 0),
      height: Math.max(1, Number(item.height) || 1)
    }))
    .sort(
      (left, right) =>
        left.y + left.height / 2 - (right.y + right.height / 2) ||
        left.x - right.x
    );
  const rows = [];
  for (const item of items) {
    const centerY = item.y + item.height / 2;
    const row = rows.find((candidate) => {
      const tolerance = Math.max(
        10,
        Math.min(36, Math.max(candidate.height, item.height) * 0.75)
      );
      return Math.abs(centerY - candidate.centerY) <= tolerance;
    });
    if (row) {
      row.items.push(item);
      row.centerY =
        row.items.reduce(
          (total, value) => total + value.y + value.height / 2,
          0
        ) / row.items.length;
      row.height = Math.max(row.height, item.height);
    } else {
      rows.push({ centerY, height: item.height, items: [item] });
    }
  }
  const mergedRows = [];
  for (const row of rows) {
    const previous = mergedRows.at(-1);
    if (previous && hasUnclosedTechnologyParenthesis(previous)) {
      previous.items.push(...row.items);
      previous.centerY =
        previous.items.reduce(
          (total, value) => total + value.y + value.height / 2,
          0
        ) / previous.items.length;
      previous.height = Math.max(previous.height, row.height);
    } else {
      mergedRows.push(row);
    }
  }
  return mergedRows.map((row) => {
    row.items.sort((left, right) => left.x - right.x);
    return row;
  });
}

function hasUnclosedTechnologyParenthesis(row) {
  const text = row.items.map((item) => String(item.text || "")).join("");
  let balance = 0;
  for (const character of normalizeTechnologyText(text)) {
    if (character === "(") balance += 1;
    if (character === ")") balance -= 1;
  }
  return balance > 0;
}

function technologyRowTexts(row) {
  const joined = row.items
    .map((item) => String(item.text || "").trim())
    .join("");
  const hasParentheticalName = /[（(]/.test(joined);
  // If a row contains a parenthetical name, only the complete row may match.
  // This prevents “前置科技” from being treated as a separate technology.
  if (row.items.length > 1 || hasParentheticalName) return [joined];
  return [
    joined,
    ...row.items.flatMap((item) =>
      String(item.text || "")
        .split(/\r?\n/)
        .map((text) => text.trim())
        .filter(Boolean)
    )
  ].filter((text, index, list) => list.indexOf(text) === index);
}

function technologyNameVariants(label) {
  const main = technologyMainName(label);
  return main ? [main] : [];
}

function technologyRowMatch(row, label) {
  const expected = technologyNameVariants(label);
  for (const text of technologyRowTexts(row)) {
    const normalized = technologyMainName(text);
    if (expected.includes(normalized)) {
      return technologyRowObservation(row, text);
    }
  }
  return null;
}

function technologyMainName(value) {
  return normalizeTechnologyText(value).split("(", 1)[0];
}

function technologyRowObservation(row, text) {
  const left = Math.min(...row.items.map((item) => item.x));
  const top = Math.min(...row.items.map((item) => item.y));
  const right = Math.max(...row.items.map((item) => item.x + item.width));
  const bottom = Math.max(...row.items.map((item) => item.y + item.height));
  return {
    ...row.items[0],
    text,
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(1, bottom - top)
  };
}

function technologySelectorSignature(observations, region) {
  return observations
    .filter((item) => {
      const x = item.x + item.width / 2;
      const y = item.y + item.height / 2;
      return (
        x > region.left &&
        x < region.right &&
        y > region.top &&
        y < region.bottom
      );
    })
    .map((item) => normalizeTechnologyText(item.text))
    .filter(Boolean)
    .sort()
    .join("|");
}

function normalizeTechnologyText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[（【〔［]/g, "(")
    .replace(/[）】〕］]/g, ")")
    .toLowerCase();
}

function technologyTextDistance(left, right) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return 2;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current.push(
        Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] +
            (left[row - 1] === right[column - 1] ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[right.length];
}

async function readTechnologySlotState(
  context,
  slot,
  label,
  signal,
  options = {}
) {
  const { config, ui } = context;
  const attempts = Math.max(
    1,
    Math.min(3, Number(options.attempts) || 1)
  );
  let state = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await ui.tap(slot, signal);
    await (context.sleep || delay)(
      Math.max(
        1_000,
        Number(config.technology.slotOpenSettleMs) || 1_200
      ),
      signal
    );
    state = await readTechnologyCurrentDetailState(
      context,
      `${label}-attempt-${attempt}`,
      signal
    );
    if (state.occupied) return state;
    if (attempt < attempts && options.retryOnMissingAction) {
      await options.report?.(
        "warning",
        "tech_slot_open_retry",
        `${options.lane === "core" ? "第一行" : "第二行"}第 ${options.slotIndex + 1} 格第 ${attempt} 次实际点击后详情未出现“卸下”；等待后重试该格，不点击卸下按钮`,
        { attempt, maximumAttempts: attempts }
      );
      await (context.sleep || delay)(
        Math.max(
          800,
          Number(config.technology.slotRetrySettleMs) || 1_000
        ),
        signal
      );
    }
  }
  return state;
}

async function readTechnologyCurrentDetailState(context, label, signal) {
  const result = await readTechnologyDetailAction(
    context,
    "卸下",
    label,
    signal
  );
  return {
    occupied: Boolean(result.action),
    unload: result.action,
    observations: result.observations,
    frame: result.frame
  };
}

async function readTechnologyDetailAction(
  context,
  actionText,
  label,
  signal
) {
  const { config, vision } = context;
  let frame = await vision.capture(label, signal);
  let observations = frame.observations;
  let action = findTechnologyText(
    vision,
    observations,
    actionText,
    config.technology.detailsRegion
  );
  if (
    !action &&
    frame.path &&
    typeof vision.ocrRegion === "function"
  ) {
    try {
      const regional = await vision.ocrRegion(
        frame.path,
        config.technology.detailsRegion,
        `${label}-regional`,
        signal,
        "accurate",
        0.1,
        2
      );
      observations = regional;
      action = findTechnologyText(
        vision,
        observations,
        actionText,
        config.technology.detailsRegion
      );
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  if (!action && typeof vision.captureAccurateTransient === "function") {
    const accurate = await vision.captureAccurateTransient(
      `${label}-accurate`,
      signal
    );
    observations = accurate.observations;
    frame = accurate;
    action = findTechnologyText(
      vision,
      observations,
      actionText,
      config.technology.detailsRegion
    );
  }
  return {
    action,
    observations,
    frame
  };
}

async function assertTechnologySlotSelected(
  context,
  slot,
  frame,
  lane,
  slotIndex,
  signal
) {
  const { config, vision } = context;
  if (!frame?.path || typeof vision.probe !== "function") return;
  const offsetY =
    Number(config.technology.selectionBorderOffsetY) || -73;
  const [probe] = await vision.probe(
    frame.path,
    [{ x: slot.x, y: slot.y + offsetY }],
    Math.max(
      2,
      Number(config.technology.selectionBorderProbeRadius) || 4
    ),
    signal
  );
  const orange =
    probe &&
    probe.meanRed > probe.meanGreen + 0.08 &&
    probe.meanGreen > probe.meanBlue + 0.08;
  if (!orange) {
    throw new Error(
      `科技槽位选中校验失败：${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 格未出现橙色边框；禁止继续选择或配置科技`
    );
  }
}

function findTechnologyText(vision, observations, text, region) {
  const bounds = region || {
    left: 520,
    top: 250,
    right: 1050,
    bottom: 850
  };
  const bounded = observations.filter((item) => {
    const x = item.x + item.width / 2;
    const y = item.y + item.height / 2;
    return (
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    );
  });
  return (
    vision.find(bounded, text, "exact") ||
    vision.find(bounded, text, "includes")
  );
}
