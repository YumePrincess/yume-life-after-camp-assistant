import test from "node:test";
import assert from "node:assert/strict";
import {
  localizeTaskEvent,
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
});
