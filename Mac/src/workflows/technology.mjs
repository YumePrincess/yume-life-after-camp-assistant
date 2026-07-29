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
  const detection = config.technology.filledSlotDetection;
  const slots = ["core", "general"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({
      ...point,
      lane,
      index,
      expectedFilled: index < (plan[lane]?.length ?? 0)
    }))
  );
  const frame = await vision.capture("technology-final-verification", signal);
  const probes = await vision.probe(
    frame.path,
    slots,
    detection.sampleRadius,
    signal
  );
  const mismatches = slots.flatMap((slot, index) => {
    const distance = featureDistance(
      probes[index],
      detection.emptyReference[slot.lane]
    );
    const filled = distance > detection.maximumEmptyFeatureDistance;
    return filled === slot.expectedFilled
      ? []
      : [{
          lane: slot.lane,
          slot: slot.index + 1,
          expectedFilled: slot.expectedFilled,
          detectedFilled: filled,
          distance
        }];
  });
  if (mismatches.length) {
    throw new Error(
      `科技最终槽位校验失败：${mismatches
        .map(
          (item) =>
            `${item.lane === "core" ? "第一行" : "第二行"}第 ${item.slot} 格应为${item.expectedFilled ? "已安装" : "空"}`
        )
        .join("、")}`
    );
  }
  await report(
    "info",
    "technology_final_verified",
    `正式 Agent 已确认 12 个槽位：第一行 ${plan.core.length} 项、第二行 ${plan.general.length} 项，其余槽位为空`,
    { probes, screenshot: frame.path }
  );
}

export async function clearAllConfiguredSlots(context, signal) {
  const { config, ui, vision, report } = context;
  const allSlots = ["general", "core"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({ ...point, lane, index }))
  );
  const initial = await vision.capture("technology-before-clear", signal);
  const detection = config.technology.filledSlotDetection;
  const probes = await vision.probe(
    initial.path,
    allSlots,
    detection.sampleRadius,
    signal
  );
  const configured = allSlots.filter(
    (slot, index) =>
      featureDistance(probes[index], detection.emptyReference[slot.lane]) >
      detection.maximumEmptyFeatureDistance
  );
  await report(
    "info",
    "tech_clear",
    `识别到 ${configured.length} 个已配置槽位，将只点击这些槽位`,
    { probes, screenshot: initial.path }
  );
  for (const lane of ["general", "core"]) {
    const laneSlots = configured
      .filter((slot) => slot.lane === lane)
      .sort((a, b) => b.index - a.index);
    for (const slot of laneSlots) {
      await ui.tap(slot, signal);
      await ui.tap(config.technology.unloadSelected, signal);
      const clearedFrame = await vision.capture(
        `technology-cleared-${lane}-${slot.index + 1}`,
        signal
      );
      const [clearedProbe] = await vision.probe(
        clearedFrame.path,
        [slot],
        detection.sampleRadius,
        signal
      );
      if (
        featureDistance(
          clearedProbe,
          detection.emptyReference[slot.lane]
        ) > detection.maximumEmptyFeatureDistance
      ) {
        throw new Error(
          `科技卸下校验失败：${lane === "core" ? "第一行" : "第二行"}第 ${slot.index + 1} 个槽位点击“卸下”后仍为占用状态`
        );
      }
    }
  }
  const frame = await vision.capture("technology-after-clear", signal);
  const afterProbes = await vision.probe(
    frame.path,
    allSlots,
    detection.sampleRadius,
    signal
  );
  const remaining = allSlots.filter(
    (slot, index) =>
      featureDistance(afterProbes[index], detection.emptyReference[slot.lane]) >
      detection.maximumEmptyFeatureDistance
  );
  if (remaining.length) {
    throw new Error(
      `科技清空校验失败：仍检测到 ${remaining.length} 个可能已配置槽位`
    );
  }
  await report("info", "tech_clear", "右侧两行 12 个槽位均已验证为空", {
    probes: afterProbes,
    screenshot: frame.path
  });
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
      await verifySlotFilled(context, lane, slotIndex, label, signal);
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

async function verifySlotFilled(context, lane, slotIndex, label, signal) {
  const { config, vision, report } = context;
  const slot = config.technology.slots[lane][slotIndex];
  const detection = config.technology.filledSlotDetection;
  const frame = await vision.capture(
    `technology-installed-${lane}-${slotIndex + 1}`,
    signal
  );
  const [probe] = await vision.probe(
    frame.path,
    [slot],
    detection.sampleRadius,
    signal
  );
  const distance = featureDistance(
    probe,
    detection.emptyReference[lane]
  );
  if (distance <= detection.maximumEmptyFeatureDistance) {
    throw new Error(
      `科技安装校验失败：${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 个槽位在选择“${label}”后仍为空`
    );
  }
  await report(
    "info",
    "tech_slot_verified",
    `已确认“${label}”安装到${lane === "core" ? "第一行" : "第二行"}第 ${slotIndex + 1} 个槽位`,
    { distance, probe, screenshot: frame.path }
  );
}
