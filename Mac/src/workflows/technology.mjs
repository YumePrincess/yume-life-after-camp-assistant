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
  for (const lane of ["general", "core"]) {
    const laneSlots = config.technology.slots[lane]
      .map((point, index) => ({ ...point, lane, index }))
      .sort((a, b) => a.index - b.index);
    for (const slot of laneSlots) {
      const before = await readTechnologySlotState(
        context,
        slot,
        `technology-clear-check-${lane}-${slot.index + 1}`,
        signal
      );
      if (!before.occupied) continue;
      configuredCount += 1;
      await ui.tap(config.technology.unloadSelected, signal);
      const after = await readTechnologySlotState(
        context,
        slot,
        `technology-cleared-${lane}-${slot.index + 1}`,
        signal
      );
      if (after.occupied) {
        throw new Error(
          `科技卸下校验失败：${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 个槽位点击“卸下”后仍为占用状态`
        );
      }
    }
  }
  await report(
    "info",
    "tech_clear",
    `逐格识别“卸下”按钮并移除 ${configuredCount} 项；右侧两行 12 个槽位均已验证为空`
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
  let openCheck = await vision.capture(
    `technology-selector-open-check-${lane}-${slotIndex + 1}`,
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
    await report(
      "info",
      "tech_selector_reopen",
      `目标槽位的科技列表处于折叠状态，正在再次点击${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 格`
    );
    await ui.tap(slot, signal);
    const reopened = await vision.capture(
      `technology-selector-reopened-${lane}-${slotIndex + 1}`,
      signal
    );
    if (
      vision.find(reopened.observations, "点击槽位") ||
      vision.find(reopened.observations, "可在此处选择科技")
    ) {
      throw new Error(
        `科技列表未打开：${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 格再次点击后仍显示“点击槽位”`
      );
    }
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
  for (let page = 0; page <= swipe.maxPages; page += 1) {
    const frame = await vision.capture(`technology-selector-${label}`, signal);
    let match = findTechnologyMatch(
      vision,
      frame.observations,
      label,
      config.technology.selectorRegion
    );
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
      const x = match.x + match.width / 2;
      const y = match.y + match.height / 2;
      await report(
        "info",
        "tech_target_found",
        `已在左侧列表第 ${page + 1} 页精确找到科技“${label}”`,
        { lane, slotIndex, point: { x, y }, matchedText: match.text }
      );
      await ui.tap({ x, y }, signal);
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
    vision.find(inSelector, label, "includes")
  );
}

async function readTechnologySlotState(context, slot, label, signal) {
  const { config, ui, vision } = context;
  await ui.tap(slot, signal);
  let frame = await vision.capture(label, signal);
  let observations = frame.observations;
  let unload = findTechnologyText(
    vision,
    observations,
    "卸下",
    config.technology.detailsRegion
  );
  if (!unload && typeof vision.captureAccurateTransient === "function") {
    const accurate = await vision.captureAccurateTransient(
      `${label}-accurate`,
      signal
    );
    observations = accurate.observations;
    frame = accurate;
    unload = findTechnologyText(
      vision,
      observations,
      "卸下",
      config.technology.detailsRegion
    );
  }
  return {
    occupied: Boolean(unload),
    unload,
    observations,
    frame
  };
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
