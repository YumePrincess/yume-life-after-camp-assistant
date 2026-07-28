import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { MAC_ROOT } from "./config.mjs";
import { runFile } from "./process.mjs";

const STATES = new Set([
  "prelogin_announcement",
  "login",
  "resource_update",
  "promotion",
  "promotion_newspaper",
  "map",
  "hud",
  "loading",
  "unknown"
]);
const ACTIONS = new Set(["wait"]);

export class LocalVisionAdvisor {
  constructor(config = {}) {
    this.config = {
      enabled: false,
      mode: "shadow",
      baseUrl: "http://127.0.0.1:8092",
      model: "mlx-community/deepseek-vl-7b-chat-4bit",
      timeoutSeconds: 45,
      minimumConfidence: 0.9,
      consecutiveMatches: 2,
      intervalSeconds: 8,
      autoStartForTasks: true,
      stopAfterTask: true,
      ...config
    };
    this.controlScript = resolve(MAC_ROOT, "scripts/local-model.sh");
  }

  get enabled() {
    return this.config.enabled === true;
  }

  async start(signal) {
    if (!this.enabled || this.config.autoStartForTasks === false) return false;
    await runFile(this.controlScript, ["start"], {
      timeoutMs: 180_000,
      signal
    });
    return true;
  }

  async stop() {
    if (!this.enabled || this.config.stopAfterTask === false) return;
    await runFile(this.controlScript, ["stop"], { timeoutMs: 30_000 });
  }

  async analyze(imagePath, { loginClicked = false, ocrTexts = [] } = {}, signal) {
    if (!this.enabled) return null;
    const image = await readFile(imagePath);
    const mime = extname(imagePath).toLowerCase() === ".jpg"
      ? "image/jpeg"
      : "image/png";
    const prompt = [
      "你是《明日之后》中国大陆服自动化的只读画面分类器。",
      "只返回单行 JSON，不要 Markdown。",
      'state 只能是 "prelogin_announcement","login","resource_update","promotion","promotion_newspaper","map","hud","loading","unknown"。',
      'action 只能是 "wait"；你没有操作权限。',
      "prelogin_announcement 仅指选择角色/点击登录之前、带右上角 X 的系统公告或更新公告。",
      "只有覆盖画面中央的大型公告面板才是 prelogin_announcement；登录页右侧“直升新服现已开服”等小气泡不是公告。",
      "login 指画面底部存在点击登录游戏按钮。",
      "“希望谷地”是服务器名，不是公告；只要看见“点击登录游戏”就必须判为 login。",
      "promotion 指登录角色之后覆盖 HUD 的活动宣传页面。",
      "hud 指已经进入角色且可操作：能看到右上角圆形小地图，并同时看到血条、聊天栏、武器/动作键中的多项。",
      "map 指全屏营地地图已打开，左上能看到“标志查看/查看庄园”标签或地点列表。",
      "左侧“新的家园/前往营地市政厅”等任务指引只是 HUD 的一部分，绝不是公告；只要小地图和操作键可见就必须判为 hud。",
      "登录后只可能有两种宣传页且共出现零至两张：时装宣传页永远在前，《明日希望报》永远在后；两者均可缺席。",
      "画面大标题为《明日希望报》时判为 promotion_newspaper；时装宣传页判为 promotion。",
      "无论识别到什么状态，action 都必须为 wait。",
      "无法确定时必须选 unknown/wait，不得输出坐标。",
      `当前流程 loginClicked=${loginClicked}；OCR=${JSON.stringify(ocrTexts.slice(0, 30))}。`,
      '返回格式：{"state":"unknown","action":"wait","confidence":0.0,"evidence":"简短画面依据"}'
    ].join("\n");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Local vision model timed out")),
      Math.max(5, Number(this.config.timeoutSeconds) || 45) * 1000
    );
    const abort = () =>
      controller.abort(signal?.reason || new Error("Task interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(
        `${this.config.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.config.model,
            temperature: 0,
            max_tokens: 160,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mime};base64,${image.toString("base64")}`
                    }
                  }
                ]
              }
            ]
          }),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        throw new Error(`Local vision model HTTP ${response.status}`);
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const parsed = parseJson(content);
      if (
        !STATES.has(parsed.state) ||
        !ACTIONS.has(parsed.action) ||
        !Number.isFinite(Number(parsed.confidence))
      ) {
        throw new Error("Local vision model returned an invalid classification");
      }
      const evidence = String(parsed.evidence || "").slice(0, 240);
      return {
        state: parsed.state,
        action: "wait",
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
        evidence
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function parseJson(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item?.text || "").join("")
    : String(content || "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Local vision model did not return JSON");
  return JSON.parse(match[0]);
}
