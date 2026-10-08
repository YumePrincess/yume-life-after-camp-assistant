import { delay } from "../process.mjs";
import { updateWorkflowProgress } from "./progress.mjs";

// The supplied application form is a 1920×1200 capture. The seven checkboxes
// are laid out in reading order across columns, then down the rows.
export const TRADING_CITY_WEEKDAY_POSITIONS = Object.freeze({
  1: Object.freeze({ x: 1642, y: 310 }), // Monday
  2: Object.freeze({ x: 1196, y: 362 }), // Tuesday
  3: Object.freeze({ x: 1419, y: 362 }), // Wednesday
  4: Object.freeze({ x: 1642, y: 362 }), // Thursday
  5: Object.freeze({ x: 1196, y: 416 }), // Friday
  6: Object.freeze({ x: 1196, y: 310 }), // Saturday
  7: Object.freeze({ x: 1419, y: 310 })  // Sunday
});

export const TRADING_CITY_APPLICATION_CONFIRM_POSITION = Object.freeze({
  x: 1728,
  y: 947
});

const FORM_REGION = { left: 1080, top: 55, right: 1910, bottom: 1140 };
const DATA_CENTER_REGION = { left: 1150, top: 450, right: 1650, bottom: 900 };
const DEXTER_TEXTS = ["德克斯特", "交谈"];
const CONVERSATION_KEYWORDS = [
  ["在我这有交易之城的竞标书", "交易之城的竞标书"],
  ["交易之城是什么"],
  ["交易之城有什么好处"],
  ["怎么成为交易之城"],
  ["我要交易之城竞标申请表"],
  ["原来如此"]
];
const FORM_KEYWORDS = [
  ["交易之城竞标申请表"],
  ["成为交易之城日期"],
  ["需求物资确认"],
  ["预估幸福值"],
  ["上周最低值"],
  ["周一"],
  ["周二"],
  ["周三"],
  ["周四"],
  ["周五"],
  ["周六"],
  ["周日"]
];
const WORLD_HUD_KEYWORDS = ["综合", "世界", "场景", "营地", "队伍", "背包"];
const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MAX_DEXTER_ROUTE_RESTARTS = 6;
const DEXTER_PATHFINDING_ATTEMPTS = 2;
const DATA_CENTER_APPROACH_W_HOLD_MS = 700;
const PATHFINDING_W_HOLD_MS = 580;

export async function runTradingCityApply(context, command, _bundle, signal) {
  const sleep = context.sleep || delay;
  const targetWeekday = Number(command?.payload?.detail?.tradingCity?.targetWeekday);
  if (!Number.isInteger(targetWeekday) || targetWeekday < 1 || targetWeekday > 7) {
    throw new Error("TRADING_CITY_TARGET_WEEKDAY_MISSING: 未收到有效的报名目标星期");
  }
  const width = Number(context.config?.adb?.screenWidth) || 1920;
  const height = Number(context.config?.adb?.screenHeight) || 1200;
  if (width !== 1920 || height !== 1200) {
    throw new Error(
      `TRADING_CITY_SCREEN_SIZE_UNSUPPORTED: 表单点击位置按 1920×1200 校准，当前为 ${width}×${height}`
    );
  }

  await prepareTradingCityApplication(context, signal, sleep);
  const weekdayPosition = await selectTradingCityWeekday(
    context,
    targetWeekday,
    signal,
    sleep
  );
  await context.ui.tap(TRADING_CITY_APPLICATION_CONFIRM_POSITION, signal);

  await updateWorkflowProgress(context, 0.78, "trading_city_verify_submission");
  await waitForApplicationSubmitted(context, signal, sleep);
  await context.report(
    "info",
    "trading_city_application_submitted",
    `已确认竞标申请表消失并重新识别世界 HUD；报名目标日期：${WEEKDAY_NAMES[targetWeekday]}`,
    { targetWeekday, weekdayPosition, confirmPosition: TRADING_CITY_APPLICATION_CONFIRM_POSITION }
  );
  await updateWorkflowProgress(context, 0.97, "trading_city_complete");
}

export async function prepareTradingCityApplication(
  context,
  signal,
  sleep = context.sleep || delay
) {
  await updateWorkflowProgress(context, 0.04, "trading_city_teleport");
  const dexterFound = await navigateToDexter(context, signal, sleep);
  if (!dexterFound) {
    throw new Error("TRADING_CITY_DEXTER_NOT_FOUND: 最多重启六轮后仍未识别到德克斯特交谈选项");
  }
  await context.adb.key("KEYCODE_F", signal);
  await sleep(8_000, signal);

  await updateWorkflowProgress(context, 0.42, "trading_city_verify_conversation");
  const conversation = await captureUntilKeywordCount(
    context,
    "trading-city-conversation",
    CONVERSATION_KEYWORDS,
    2,
    signal,
    12_000,
    sleep
  );
  if (conversation.count < 2) {
    throw new Error(
      `TRADING_CITY_CONVERSATION_UNRECOGNIZED: 交易之城对话关键词仅识别到 ${conversation.count}/6 个`
    );
  }
  await context.ui.clickText(
    "我要交易之城竞标申请表",
    { region: FORM_REGION, timeoutSeconds: 15, regionOcrMinimumConfidence: 0.18, regionOcrScale: 2 },
    signal
  );
  await sleep(3_000, signal);

  await updateWorkflowProgress(context, 0.58, "trading_city_verify_application");
  const application = await captureUntilKeywordCount(
    context,
    "trading-city-application",
    FORM_KEYWORDS,
    4,
    signal,
    12_000,
    sleep
  );
  if (application.count < 4) {
    throw new Error(
      `TRADING_CITY_APPLICATION_UNRECOGNIZED: 竞标申请表关键词仅识别到 ${application.count}/12 个`
    );
  }
  return { conversationKeywords: conversation.count, applicationKeywords: application.count };
}

export async function selectTradingCityWeekday(
  context,
  weekday,
  signal,
  sleep = context.sleep || delay
) {
  const weekdayPosition = TRADING_CITY_WEEKDAY_POSITIONS[weekday];
  if (!weekdayPosition) throw new Error("TRADING_CITY_WEEKDAY_POSITION_MISSING");
  await clickTradingCityWeekday(context.ui, weekday, signal);
  await sleep(2_000, signal);
  await context.report(
    "info",
    "trading_city_weekday_selected",
    `已点击报名目标日期${WEEKDAY_NAMES[weekday]}，申请表坐标 (${weekdayPosition.x}, ${weekdayPosition.y})`
  );
  return weekdayPosition;
}

export async function clickTradingCityWeekday(ui, weekday, signal) {
  const point = TRADING_CITY_WEEKDAY_POSITIONS[weekday];
  if (!point) throw new Error("TRADING_CITY_WEEKDAY_POSITION_MISSING");
  await ui.tap(point, signal);
  return point;
}

async function navigateToDexter(context, signal, sleep) {
  for (let restart = 0; restart <= MAX_DEXTER_ROUTE_RESTARTS; restart += 1) {
    if (restart > 0) {
      await context.report(
        "warning",
        "trading_city_route_restart",
        `第 ${restart}/${MAX_DEXTER_ROUTE_RESTARTS} 次寻路重启：本轮两次寻路均未找到德克斯特，先传送回市中心出入口，再重新前往市政厅`,
        { restart, maximumRestarts: MAX_DEXTER_ROUTE_RESTARTS }
      );
      await context.ui.executeFlow("teleportCentralExit", {}, signal);
    }

    context.ui.lastConfirmedDestination = null;
    await context.ui.executeFlow("teleportCityHall", {}, signal);
    if (context.ui.lastConfirmedDestination !== "市政厅") {
      throw new Error(
        "TRADING_CITY_CITY_HALL_UNCONFIRMED: 未通过地图与交互选项确认到达市政厅"
      );
    }
    await context.report(
      "info",
      "trading_city_city_hall_confirmed",
      "地图传送并识别到市政厅交互选项，确认到达后继续寻路"
    );
    await updateWorkflowProgress(context, 0.15, "trading_city_sand_table");
    // This task must not open the sand-table panel. The City Hall teleport
    // confirms the first Data Center interaction label; walk once, wait, then
    // require a second OCR confirmation before turning the camera.
    await context.ui.waitAnyText(
      ["营地数据中心"],
      { region: DATA_CENTER_REGION, timeoutSeconds: 12 },
      signal
    );
    await context.report(
      "info",
      "trading_city_data_center_first_seen",
      "首次识别到营地数据中心，按住 W 700 毫秒寻路，不按 F 打开数据中心面板"
    );
    await holdTradingCityPathKey(context.adb, signal, DATA_CENTER_APPROACH_W_HOLD_MS);
    await sleep(3_000, signal);
    await context.ui.waitAnyText(
      ["营地数据中心"],
      { region: DATA_CENTER_REGION, timeoutSeconds: 12 },
      signal
    );
    await context.report(
      "info",
      "trading_city_data_center_second_seen",
      "再次识别到营地数据中心，切换视角后继续寻路"
    );
    await context.adb.shell(
      ["input", "swipe", "500", "500", "1000", "500", "800"],
      { signal, timeoutMs: 8_000 }
    );
    await sleep(3_000, signal);

    await updateWorkflowProgress(context, 0.28, "trading_city_find_dexter");
    for (let attempt = 1; attempt <= DEXTER_PATHFINDING_ATTEMPTS; attempt += 1) {
      await context.report(
        "info",
        "trading_city_w_pathfinding",
        `第 ${restart + 1} 轮第 ${attempt}/${DEXTER_PATHFINDING_ATTEMPTS} 次寻路：按住 W ${PATHFINDING_W_HOLD_MS} 毫秒后识别德克斯特`
      );
      await holdTradingCityPathKey(context.adb, signal, PATHFINDING_W_HOLD_MS);
      await sleep(3_000, signal);
      const frame = await context.vision.capture(`trading-city-dexter-${restart}-${attempt}`, signal);
      if (hasAll(context.vision, frame.observations, DEXTER_TEXTS)) {
        await context.report(
          "info",
          "trading_city_dexter_found",
          `第 ${restart + 1} 轮第 ${attempt}/${DEXTER_PATHFINDING_ATTEMPTS} 次寻路后识别到“德克斯特”和“交谈”，正在交谈`
        );
        return true;
      }
      const accurate = await context.vision
        .captureAccurateTransient?.(`trading-city-dexter-${restart}-${attempt}-accurate`, signal)
        .catch(() => null);
      if (accurate && hasAll(context.vision, accurate.observations, DEXTER_TEXTS)) {
        await context.report(
          "info",
          "trading_city_dexter_found",
          `第 ${restart + 1} 轮第 ${attempt}/${DEXTER_PATHFINDING_ATTEMPTS} 次寻路后通过高精度识别到“德克斯特”和“交谈”，正在交谈`
        );
        return true;
      }
    }
  }
  return false;
}

async function holdTradingCityPathKey(adb, signal, durationMs) {
  // Match the verified patrol/kill-alert approach: send W once, then hold it
  // through Android's keyboard input device for several hundred milliseconds.
  // `input keyevent --longpress` does not produce movement in this game.
  await adb.key("KEYCODE_W", signal);
  if (typeof adb.holdKey !== "function") {
    throw new Error("TRADING_CITY_W_HOLD_UNAVAILABLE: 当前 ADB 不支持按住 W 寻路");
  }
  await adb.holdKey("KEYCODE_W", durationMs, signal);
}

export function countTradingCityKeywordGroups(vision, observations, groups, region) {
  return groups.reduce((count, variants) => {
    const matched = variants.some((text) => {
      const result = region
        ? vision.find(
            observations.filter((item) => {
              const x = Number(item.x || 0) + Number(item.width || 0) / 2;
              const y = Number(item.y || 0) + Number(item.height || 0) / 2;
              return x >= region.left && x <= region.right && y >= region.top && y <= region.bottom;
            }),
            text
          )
        : vision.find(observations, text);
      return Boolean(result);
    });
    return count + Number(matched);
  }, 0);
}

async function captureUntilKeywordCount(context, label, groups, minimum, signal, timeoutMs, sleep) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  do {
    const frame = await context.vision.capture(label, signal);
    lastCount = countTradingCityKeywordGroups(context.vision, frame.observations, groups, FORM_REGION);
    if (lastCount >= minimum) return { frame, count: lastCount };
    const accurate = await context.vision
      .captureAccurateTransient?.(`${label}-accurate`, signal)
      .catch(() => null);
    if (accurate) {
      lastCount = countTradingCityKeywordGroups(
        context.vision,
        accurate.observations,
        groups,
        FORM_REGION
      );
      if (lastCount >= minimum) return { frame: accurate, count: lastCount };
    }
    await sleep(700, signal);
  } while (Date.now() < deadline);
  return { frame: null, count: lastCount };
}

async function waitForApplicationSubmitted(context, signal, sleep) {
  const deadline = Date.now() + 30_000;
  do {
    const frame = await context.vision.capture("trading-city-submission", signal);
    const formVisible = context.vision.find(frame.observations, "交易之城竞标申请表") ||
      context.vision.find(frame.observations, "成为交易之城日期");
    const hudCount = WORLD_HUD_KEYWORDS.filter((text) =>
      context.vision.find(frame.observations, text)
    ).length;
    if (!formVisible && hudCount >= 2) return frame;
    await sleep(700, signal);
  } while (Date.now() < deadline);
  throw new Error("TRADING_CITY_SUBMISSION_UNCONFIRMED: 申请表未消失或未重新识别到世界 HUD");
}

function hasAll(vision, observations, texts) {
  return texts.every((text) => vision.find(observations, text));
}
