import test from "node:test";
import assert from "node:assert/strict";
import {
  localizeTaskEvent,
  localizedTaskEventMessages,
  normalizeTaskLocale
} from "../src/task-localization.mjs";

test("task locale normalizes browser language tags", () => {
  assert.equal(normalizeTaskLocale("en-US"), "en");
  assert.equal(normalizeTaskLocale("zh-Hant-TW"), "zh-tw");
  assert.equal(normalizeTaskLocale("ja-JP"), "ja");
  assert.equal(normalizeTaskLocale("unknown"), "zh-cn");
});

test("fixed task messages follow the selected locale", () => {
  assert.equal(
    localizeTaskEvent("game_start", "正在启动明日之后", "en-US"),
    "Starting LifeAfter"
  );
  assert.equal(
    localizeTaskEvent("game_start", "正在启动明日之后", "zh-tw"),
    "正在啟動明日之後"
  );
  assert.equal(
    localizeTaskEvent("game_start", "正在启动明日之后", "zh-cn"),
    "正在启动明日之后"
  );
  assert.equal(
    localizeTaskEvent(
      "local_model_disabled",
      "本次任务未启用 Qwen 本地视觉辅助模型，使用 OCR 与确定性流程",
      "en"
    ),
    "Qwen local vision is disabled for this task; using OCR and deterministic steps"
  );
  assert.equal(
    localizeTaskEvent(
      "local_model_started",
      "Qwen 本地视觉辅助模型已启动",
      "ja"
    ),
    "Qwen ローカル視覚アシスタントを起動しました"
  );
});

test("every Agent task event carries all five supported locales", () => {
  assert.deepEqual(
    Object.keys(localizedTaskEventMessages("game_start", "正在启动明日之后")).sort(),
    ["en", "fr", "ja", "zh-cn", "zh-tw"]
  );
  assert.equal(
    localizedTaskEventMessages("game_start", "正在启动明日之后").en,
    "Starting LifeAfter"
  );
  assert.equal(
    localizedTaskEventMessages("ocr", "OCR 原文：玩家名称").fr,
    "OCR 原文：玩家名称"
  );
});

test("OCR and device text without a safe fixed template is preserved", () => {
  const source = "HUD 探测：频道锚点=综合、世界；设备原文=фЖХ₺Ш";
  assert.equal(localizeTaskEvent("game_ready_probe", source, "en"), source);
});

test("safe count templates translate without translating OCR fields", () => {
  assert.equal(
    localizeTaskEvent(
      "member_header_count",
      "顶部人数识别：正式市民 4/93，启航市民 0/0，合计 93 名（当前在线人数不计入总数）",
      "en"
    ),
    "Header counts: formal citizens 4/93, sailing citizens 0/0; total 93 (current online counts are excluded)"
  );
  assert.equal(
    localizeTaskEvent(
      "member-details_page",
      "第 3 页识别 6 行，累计 17 名成员（耗时 1200ms）",
      "en"
    ),
    "Page 3 recognized 6 rows; 17 members accumulated (1200ms)"
  );
  assert.equal(
    localizeTaskEvent(
      "member_details_bottom_reached",
      "成员资料列表已完整翻到底部，扫描 24 页；全表去重合并后整理为 97/97 名成员",
      "ja"
    ),
    "メンバープロフィール一覧の最下部まで 24 ページ走査；重複除去後 97/97 人"
  );
  assert.equal(
    localizeTaskEvent(
      "member_details_incomplete_stop",
      "第 18 页连续重读仍未达到 5 行，已立即停止翻页；当前整页重读结果为 6 行",
      "en"
    ),
    "Page 18 stayed below 5 rows after repeated reads; scrolling stopped immediately with 6 rows"
  );
  assert.equal(
    localizeTaskEvent(
      "member_details_scan_stopped_incomplete",
      "成员资料第 18 页连续重读达到最多 6 次仍不完整，停止当前扫描；整理为 91/92 名成员",
      "en"
    ),
    "Member profiles stopped on page 18 after 6 incomplete reads; roster total: 91/92 members"
  );
  assert.equal(
    localizeTaskEvent(
      "member_details_incomplete_stop",
      "第 18 页连续重读仍未达到 5 行，已立即停止翻页；当前结果为 4 行；当前已读到：成员1、成员2、成员3、成员4",
      "en"
    ),
    "Page 18 stayed below 5 rows after repeated reads; scrolling stopped immediately with 4 rows; names currently recognized: 成员1、成员2、成员3、成员4"
  );
  assert.equal(
    localizeTaskEvent(
      "member_details_ai_recovery_attempt",
      "第 18 页识别不足，正在调用 Qwen 本地视觉辅助模型重读当前页；当前已读到：成员1、成员2",
      "en"
    ),
    "Page 18 is incomplete; asking the Qwen local vision assistant to reread it; names currently recognized: 成员1、成员2"
  );
  assert.equal(
    localizeTaskEvent(
      "member_details_ai_recovery_attempt",
      "第 2 页疑似将带颜色码的“启航”职位识别为名字，正在调用 Qwen 本地视觉辅助模型重读当前页；当前已读到：#B XXX、#YXXX",
      "en"
    ),
    "Page 2 may have read a color-coded sailing title as a name; asking the Qwen local vision assistant to reread it; names currently recognized: #B XXX、#YXXX"
  );
  assert.equal(
    localizeTaskEvent(
      "table_row_alignment",
      "member-contribution-2 第 2 页检测到顶部残留色带，按 10px 上移自动修正后再读取 11 行",
      "en"
    ),
    "member-contribution-2 page 2 detected a small residual top color band; moved up 10px before rereading 11 rows"
  );
  assert.equal(
    localizeTaskEvent(
      "table_row_alignment",
      "member-activity-2 第 2 页检测到顶部色带偏移，按 56px 下移自动修正后再读取 11 行",
      "en"
    ),
    "member-activity-2 page 2 detected a top color-band offset; moved down 56px before rereading 11 rows"
  );
  assert.equal(
    localizeTaskEvent(
      "table_page_height_calibrated",
      "第 1 页读取 11 行整体高度 748px，增加 5px 后按 753px 翻页",
      "en"
    ),
    "Page 1 measured an overall height of 748px for 11 rows; added 5px and will use 753px for subsequent pages"
  );
  assert.equal(
    localizeTaskEvent(
      "activity_boundary_recovered",
      "第 2 页检测到阈值边界，重读恢复 1 名离线达到 1 天的成员",
      "en"
    ),
    "Page 2 reached the threshold boundary; rereading recovered 1 members offline for at least 1 days"
  );
  assert.equal(
    localizeTaskEvent(
      "weekly_activity_final_rows",
      "周活跃点第 3 页最终采用成员 4 名：海盗猫猫✨、蛮蛮空心菜、寻不到旧梦、月丨倾玲",
      "en"
    ),
    "Weekly activity page 3 final result retained 4 members: 海盗猫猫✨、蛮蛮空心菜、寻不到旧梦、月丨倾玲"
  );
  assert.equal(
    localizeTaskEvent(
      "weekly_activity_done",
      "周活跃点读取完成：识别 12 名玩家，更新 9 名；未出现在排行的成员按 0 处理",
      "ja"
    ),
    "週間活躍ポイントの読み取り完了：12人を認識し9人を更新；ランキングにないメンバーは0として処理"
  );
});

test("Trading City task events and weekday names follow the Agent locale", () => {
  assert.equal(
    localizeTaskEvent(
      "trading_city_route_restart",
      "第 2/3 次寻路重启：已连续六次未找到德克斯特，先传送回市中心出入口，再重新前往市政厅",
      "en"
    ),
    "Route restart 2/3: Dexter was not found after six attempts. Returning to the central exit, then retrying City Hall."
  );
  assert.equal(
    localizeTaskEvent(
      "trading_city_weekday_selected",
      "已点击报名目标日期周五，申请表坐标 (1196, 416)",
      "fr"
    ),
    "vendredi sélectionné pour la candidature (coordonnées du formulaire : 1196, 416)"
  );
  assert.equal(
    localizeTaskEvent(
      "trading_city_application_submitted",
      "已确认竞标申请表消失并重新识别世界 HUD；报名目标日期：周日",
      "ja"
    ),
    "申請フォームが閉じ、ワールド HUD を再認識しました。応募曜日：日曜"
  );
});
