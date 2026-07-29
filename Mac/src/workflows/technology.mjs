import { delay } from "../process.mjs";

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
        `添加${lane === "core" ? "第一行" : "第二行"}科技：${technology.name}`
      );
      await selectTechnology(context, lane, slotIndex, technology.uiLabel, signal);
      index += 1;
      await context.progress(0.2 + (index / Math.max(all.length, 1)) * 0.65, "tech_add");
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
  const { config, vision, report } = context;
  const baseline = context.technologyEmptySlotBaseline;
  if (!baseline?.slots?.length || !baseline?.probes?.length) {
    throw new Error("科技最终校验缺少本轮清空后的空槽基线");
  }
  const slots = ["core", "general"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({
      ...point,
      lane,
      index,
      expectedTechnology: plan[lane]?.[index] ?? null
    }))
  );
  const frame = await vision.capture("technology-final-verification", signal);
  const probes = await vision.probe(
    frame.path,
    slots,
    config.technology.filledSlotDetection.sampleRadius,
    signal
  );
  const threshold = Math.max(
    0.02,
    Number(
      config.technology.filledSlotDetection.minimumInstalledFeatureDistance ??
        config.technology.filledSlotDetection.maximumEmptyFeatureDistance
    ) || 0.08
  );
  const mismatches = slots.flatMap((slot, index) => {
    const expectedFilled = Boolean(slot.expectedTechnology);
    const distance = featureDistance(probes[index], baseline.probes[index]);
    const detectedFilled = distance > threshold;
    return detectedFilled === expectedFilled
      ? []
      : [{
          lane: slot.lane,
          slot: slot.index + 1,
          expectedLabel: slot.expectedTechnology?.uiLabel || null,
          expectedFilled,
          detectedFilled,
          distance
        }];
  });
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
    `正式 Agent 已用本轮空槽基线无点击确认 12 个槽位：第一行 ${plan.core.length} 项、第二行 ${plan.general.length} 项，其余槽位为空`,
    { probes, threshold, screenshot: frame.path }
  );
}

export async function clearAllConfiguredSlots(context, signal) {
  const { config, ui, vision, report } = context;
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
      const pixelBefore = await probeTechnologySlotOccupancy(
        context,
        slot,
        lane,
        `technology-clear-pixel-${lane}-${slot.index + 1}`,
        signal
      );
      const before = await readTechnologySlotState(
        context,
        slot,
        `technology-clear-check-${lane}-${slot.index + 1}`,
        signal
      );
      const pixelFallbackOccupied =
        pixelBefore?.occupied === true &&
        pixelBefore.distance >= pixelBefore.fallbackThreshold;
      if (!before.occupied && !pixelFallbackOccupied) {
        await report(
          "info",
          "tech_slot_empty",
          `${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格经详情 OCR 与槽位像素双重检查为空，继续下一格`,
          { pixel: pixelBefore }
        );
        continue;
      }
      if (!before.occupied && pixelFallbackOccupied) {
        await assertTechnologySlotSelected(
          context,
          slot,
          before.frame,
          lane,
          slot.index,
          signal
        );
        await report(
          "warning",
          "tech_unload_pixel_fallback",
          `${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格像素明确显示已安装科技，但 OCR 漏读“卸下”；已确认橙色选中框，使用校准后的卸下按钮`,
          { pixel: pixelBefore }
        );
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
      try {
        await assertTechnologySlotEmpty(
          context,
          slot,
          lane,
          slot.index,
          signal
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        await report(
          "warning",
          "tech_slot_pixel_residual",
          `${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格已不再显示“卸下”，但选中高亮使静态空槽像素校验仍有差异；按已确认的卸下结果继续下一格`,
          { message: error.message }
        );
      }
      await report(
        "info",
        "tech_slot_unloaded",
        `${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 格已点击卸下并等待 ${Math.round(settleMs / 1000)} 秒；继续下一个槽位`
      );
    }
  }
  await report(
    "info",
    "tech_clear",
    `已按第一行 1–6、第二行 1–6 的顺序逐格检查并卸下 ${configuredCount} 项；卸下后未重复点击原槽位`
  );
  const slots = ["core", "general"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({
      ...point,
      lane,
      index
    }))
  );
  const frame = await vision.capture("technology-empty-baseline", signal);
  const probes = await vision.probe(
    frame.path,
    slots,
    config.technology.filledSlotDetection.sampleRadius,
    signal
  );
  context.technologyEmptySlotBaseline = { slots, probes };
}

async function probeTechnologySlotOccupancy(
  context,
  slot,
  lane,
  label,
  signal
) {
  const { config, vision } = context;
  const reference = config.technology.emptyReference?.[lane];
  if (!reference || typeof vision.probe !== "function") return null;
  const frame = await vision.capture(label, signal);
  if (!frame?.path) return null;
  const [probe] = await vision.probe(
    frame.path,
    [slot],
    config.technology.filledSlotDetection.sampleRadius,
    signal
  );
  const distance = featureDistance(probe, reference);
  const threshold = Math.max(
    0.02,
    Number(
      config.technology.filledSlotDetection.minimumInstalledFeatureDistance ??
        config.technology.filledSlotDetection.maximumEmptyFeatureDistance
    ) || 0.08
  );
  const fallbackThreshold = Math.max(
    threshold,
    Number(
      config.technology.filledSlotDetection
        .fallbackMinimumOccupiedFeatureDistance
    ) || threshold * 1.25
  );
  return {
    occupied: distance > threshold,
    distance,
    threshold,
    fallbackThreshold,
    probe
  };
}

export async function selectTechnology(
  context,
  lane,
  slotIndex,
  label,
  signal
) {
  const { config, ui, vision, adb, report } = context;
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
  await ui.afterAction(signal);
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
      const matchedTextX = match.x + match.width / 2;
      const y = match.y + match.height / 2;
      const x = Number(config.technology.selectorItemTapX) || 178;
      await report(
        "info",
        "tech_target_found",
        `已在左侧列表第 ${page + 1} 页匹配到科技“${label}”`,
        {
          lane,
          slotIndex,
          point: { x, y },
          matchedText: match.text,
          matchedTextX
        }
      );
      await ui.tap({ x, y }, signal);
      await (context.sleep || delay)(
        Math.max(
          1_000,
          Number(config.technology.detailOpenSettleMs) || 1_200
        ),
        signal
      );
      const detail = await readTechnologyDetailAction(
        context,
        "配置",
        `technology-configure-check-${lane}-${slotIndex + 1}`,
        signal
      );
      if (!detail.action) {
        throw new Error(
          `科技“${label}”的配置详情未打开；已停止，禁止盲点固定按钮`
        );
      }
      await report(
        "info",
        "tech_configure_selected",
        `已选择“${label}”，正在点击详情弹窗中的“配置”完成安装`
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
        `“${label}”已点击配置并等待 ${Math.round(settleMs / 1000)} 秒；继续下一个槽位`
      );
      return;
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
      await ui.afterAction(signal);
    }
  }
  throw new Error(`科技选择列表中找不到：${label}`);
}

function findTechnologyMatch(vision, observations, label, region) {
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
  return (
    vision.find(inSelector, label, "exact") ||
    vision.find(inSelector, label, "includes") ||
    uniqueFuzzyTechnologyMatch(inSelector, label)
  );
}

function uniqueFuzzyTechnologyMatch(observations, label) {
  const wanted = normalizeTechnologyText(label);
  if (wanted.length < 4) return null;
  const candidates = observations.filter((item) => {
    const text = normalizeTechnologyText(item.text);
    return (
      text.length >= 4 &&
      Math.abs(text.length - wanted.length) <= 1 &&
      technologyTextDistance(text, wanted) <= 1
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
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

async function readTechnologySlotState(context, slot, label, signal) {
  const { config, ui } = context;
  await ui.tap(slot, signal);
  await (context.sleep || delay)(
    Math.max(1_000, Number(config.technology.slotOpenSettleMs) || 1_200),
    signal
  );
  return readTechnologyCurrentDetailState(context, label, signal);
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

async function assertTechnologySlotEmpty(
  context,
  slot,
  lane,
  slotIndex,
  signal
) {
  const { config, vision } = context;
  const reference = config.technology.emptyReference?.[lane];
  if (!reference || typeof vision.probe !== "function") return;
  const frame = await vision.capture(
    `technology-empty-check-${lane}-${slotIndex + 1}`,
    signal
  );
  if (!frame?.path) {
    throw new Error(
      `科技卸下校验失败：无法截取${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 格`
    );
  }
  const [probe] = await vision.probe(
    frame.path,
    [slot],
    config.technology.filledSlotDetection.sampleRadius,
    signal
  );
  const distance = featureDistance(probe, reference);
  const threshold = Math.max(
    0.02,
    Number(
      config.technology.filledSlotDetection.maximumEmptyFeatureDistance
    ) || 0.08
  );
  if (distance > threshold) {
    throw new Error(
      `科技卸下校验失败：${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 格在无点击像素校验中仍为占用状态`
    );
  }
}

function featureDistance(observed, reference) {
  if (!observed || !reference) return Number.POSITIVE_INFINITY;
  return Math.hypot(
    observed.meanRed - reference.meanRed,
    observed.meanGreen - reference.meanGreen,
    observed.meanBlue - reference.meanBlue,
    observed.meanSaturation - reference.meanSaturation,
    observed.luminanceDeviation - reference.luminanceDeviation
  );
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
