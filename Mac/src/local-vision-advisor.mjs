import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { MAC_ROOT } from "./config.mjs";
import { runFile } from "./process.mjs";

const STATES = new Set([
  "prelogin_announcement",
  "login",
  "resource_update",
  "promotion",
  "promotion_newspaper",
  "panel",
  "patrol_team_full",
  "patrol_team_waiting",
  "patrol_notice_board",
  "patrol_route_selection",
  "patrol_book_defense",
  "map",
  "hud",
  "teleport_error",
  "target_text_visible",
  "loading",
  "unknown"
]);
const ACTIONS = new Set(["wait"]);
const OVERLAY_CONTROLS = new Set(["close_x", "back", "collapse", "none"]);

export class LocalVisionAdvisor {
  constructor(config = {}) {
    this.config = {
      enabled: false,
      mode: "shadow",
      transport: "http",
      baseUrl: "http://127.0.0.1:8092",
      model: resolve(
        homedir(),
        "Library/Application Support/Yume Life After Mac Agent/Models/Qwen3-VL-2B-Instruct-4bit"
      ),
      pythonBinary: resolve(
        homedir(),
        "Library/Application Support/Yume Life After Mac Agent/ModelRuntime/venv/bin/python"
      ),
      timeoutSeconds: 180,
      minimumConfidence: 0.9,
      waitTextVerificationEnabled: false,
      consecutiveMatches: 2,
      intervalSeconds: 3,
      resizeShape: [384, 672],
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

  async analyze(
    imagePath,
    {
      loginClicked = false,
      ocrTexts = [],
      expectedState = "",
      taskHint = ""
    } = {},
    signal
  ) {
    if (!this.enabled) return null;
    const focusRule = focusedRule(expectedState, taskHint);
    const prompt = [
      "分类《明日之后》中国大陆服画面。你只读、无操作权限。",
      focusRule,
      'state 只能是 "prelogin_announcement","login","resource_update","promotion","promotion_newspaper","panel","patrol_team_full","patrol_team_waiting","patrol_notice_board","patrol_route_selection","patrol_book_defense","map","hud","teleport_error","target_text_visible","loading","unknown"。',
      "规则：底部有“点击登录游戏”=login；“希望谷地”只是服务器名。仅在 loginClicked=false 时，覆盖中央且右上有X的大公告=prelogin_announcement，右侧小气泡不是公告。loginClicked=true 后不得再判 prelogin_announcement：全屏活动海报、武器/时装/活动主视觉，尤其带“立即前往”“前往查看”“前往活动”、活动日期/活动时间或底部分页标记时=promotion；《明日希望报》=promotion_newspaper。更新/下载/状态检测=resource_update。登录角色后的进度条、百分比或场景载入层即使已经透出小地图、血条、聊天或动作键，也必须判为loading，进度达到100%但进度层仍在时仍是loading；只有进度层完全消失才允许判hud。4人巡逻队四个卡位均有成员=patrol_team_full，仍有“等待队员加入”空位=patrol_team_waiting；公告版/NPC的营地巡逻交互页=patrol_notice_board；简单/普通/困难巡逻路线选择页=patrol_route_selection；队伍目标明确显示“限时活动>保卫古籍”=patrol_book_defense。其他营地贡献表、成员页、队伍页、交谈页、确认框或覆盖3D场景的功能窗口=panel。右上小地图且有血条/聊天/动作键、没有进度条且没有大功能窗口遮挡=hud，左侧任务指引仍是hud。全屏地点列表或“标志查看/查看庄园”=map。明确显示目标点附近、无法传送或传送冷却=teleport_error。任务提示要求确认指定文字且画面中清晰可见任一指定文字=target_text_visible。不确定=unknown。",
      "对应特征清晰且无冲突时 confidence=0.97；基本明确但有轻微遮挡时 confidence=0.95；有明显疑问时 confidence 不得超过0.85。",
      "evidence 只写关键依据，不超过20个汉字。",
      `当前流程 loginClicked=${loginClicked}；期望状态=${expectedState || "未指定"}；任务提示=${String(taskHint).slice(0, 240) || "无"}；OCR=${JSON.stringify(ocrTexts.slice(0, 30))}。`,
      '仅返回一行JSON：{"state":"unknown","action":"wait","confidence":0.0,"evidence":"简短依据"}'
    ].join("\n");
    if (this.config.transport === "cli") {
      const result = await runFile(
        this.config.pythonBinary,
        [
          "-m",
          "mlx_vlm.generate",
          "--model",
          this.config.model,
          "--max-tokens",
          "160",
          "--temperature",
          "0",
          "--prompt",
          prompt,
          "--image",
          imagePath
        ],
        {
          timeoutMs: Math.max(
            30,
            Number(this.config.timeoutSeconds) || 90
          ) * 1000,
          signal
        }
      );
      return normalizeAdvice(parseCliGeneration(result.stdout));
    }
    return normalizeAdvice(
      await requestHttp(
        this.config,
        imagePath,
        prompt,
        {
          maxTokens: 64,
          resizeShape: this.config.resizeShape
        },
        signal
      )
    );
  }

  async extractTable(
    imagePath,
    {
      columns = [
        "name",
        "weeklyContribution",
        "technologyPointsUsed",
        "materialContribution"
      ]
    } = {},
    signal
  ) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const prompt = [
      "读取《明日之后》营地贡献表当前可见的所有成员行。",
      "图片已经只裁剪到表格区域。逐行读取，不能臆造看不清的行。",
      "四列从左到右是：玩家姓名、一周贡献、使用科技点、贡献物资。",
      "贡献物资可能是超出单元格宽度的8位或更长数字；必须保留最左侧首位并读取完整数字。",
      "所有数值只保留十进制整数；逗号、空格等分隔符去掉。",
      "忽略表头、按钮和说明文字。看不到任何真实成员行时返回空rows，严禁输出字段名、示例值或占位数据。",
      "当前画面通常有多行成员；必须把所有可见行放进同一个rows数组，只输出一次JSON对象，不要逐行输出多个对象，不要重复。",
      `字段固定为：${columns.join(",")}。`,
      "只返回一个单行JSON对象且不要Markdown。对象唯一顶层字段是rows；rows是数组，每项必须含上述四个字段。"
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      {
        maxTokens: 512,
        resizeShape: [730, 680]
      },
      signal
    );
    if (!Array.isArray(parsed.rows)) {
      throw new Error("Local vision model table response has no rows");
    }
    return parsed.rows
      .map((row) => ({
        name: String(row?.name || "").trim(),
        weeklyContribution: tableNumber(row?.weeklyContribution),
        technologyPointsUsed: tableNumber(row?.technologyPointsUsed),
        materialContribution: tableNumber(row?.materialContribution)
      }))
      .filter(
        (row) =>
          row.name &&
          !/^(?:玩家名|成员名|姓名|name|player)$/i.test(row.name) &&
          !/(?:全部成员|一周贡献|使用科技点|贡献物资)/.test(row.name)
      );
  }

  async extractNames(imagePath, signal) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const prompt = [
      "读取《明日之后》营地贡献表姓名列中当前可见的所有成员姓名。",
      "从上到下编号，第一条可见成员行为1。保留姓名中的字母、数字和可辨认装饰符号。",
      "必须为每一条可见行返回一个行号；看不清姓名时name为空字符串，不能跳过该行，不能把后续姓名提前。",
      "忽略表头、头像和其他列，不要读取任何贡献数值。",
      "只返回一次单行JSON对象且不要Markdown。顶层唯一字段names，数组每项只有row整数和name字符串。"
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      {
        maxTokens: 384,
        resizeShape: [730, 230]
      },
      signal
    );
    if (!Array.isArray(parsed.names)) {
      throw new Error(
        `Local vision model name response has no names array: ${JSON.stringify(parsed).slice(0, 1200)}`
      );
    }
    return parsed.names
      .map((item) => ({
        row: Number.parseInt(item?.row, 10),
        name: String(item?.name || "").trim()
      }))
      .filter(
        (item) =>
          Number.isInteger(item.row) &&
          item.row > 0 &&
          !/(?:全部成员|一周贡献|使用科技点|贡献物资)/.test(item.name)
      );
  }

  async extractMemberDetails(imagePath, rowCount, signal) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const count = Math.max(1, Number.parseInt(rowCount, 10) || 1);
    const prompt = [
      "读取《明日之后》营地“成员-基础信息”表当前完整可见的成员行。",
      `右侧“在线/离线”列明确标出了 ${count} 条完整成员行；profiles 必须恰好返回 ${count} 项，row 从1连续到${count}，绝不能漏行或把后一行前移。`,
      "每行最左侧头像右边有上下两行文字：上面较大的第一行才是玩家姓名name，下面较小的第二行是营地职位campTitle。绝不能把第二行职位当成玩家姓名。",
      "另外读取同一行的职业profession和最右侧同居人roommateName；没有文字或看不清时填空字符串，不能猜测。",
      "保留姓名中的字母、数字和可辨认装饰符号。忽略表头、头像、周贡献、庄园等级、在线状态与所在场景。",
      "只返回一次单行JSON对象且不要Markdown。顶层唯一字段profiles；每项只有row整数、name、campTitle、profession、roommateName字符串。"
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      {
        maxTokens: 768,
        resizeShape: [480, 1280]
      },
      signal
    );
    if (!Array.isArray(parsed.profiles)) {
      throw new Error(
        `Local vision model member response has no profiles array: ${JSON.stringify(parsed).slice(0, 1200)}`
      );
    }
    return parsed.profiles
      .map((item) => ({
        row: Number.parseInt(item?.row, 10),
        name: String(item?.name || "").trim(),
        campTitle: String(item?.campTitle || "").trim(),
        profession: String(item?.profession || "").trim(),
        roommateName: String(item?.roommateName || "").trim()
      }))
      .filter((item) => Number.isInteger(item.row) && item.row > 0);
  }

  async extractStaff(imagePath, signal) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const prompt = [
      "读取《明日之后》营地“公职人员”页面当前所有实际在任人员。",
      "公职容量最多为左侧市长1人加右侧公职10人，但当前可能有空缺。左侧大人物是市长；右侧人物按画面从上到下、从左到右连续编号。",
      "每个人物下方有两行：上面橙色/较大的第一行是玩家姓名name，下面白色/较小的第二行是营地职位campTitle。绝不能把第二行职位当玩家姓名。",
      "保留玩家名中的字母、数字和可辨认装饰符号。空席位不要输出；看不清字段填空字符串，不能猜测。",
      "slot中市长写mayor；右侧公职依次写staff1到staff10。只返回一次单行JSON对象且不要Markdown。顶层唯一字段staff；每项只有slot、name、campTitle字符串。"
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      {
        maxTokens: 512,
        resizeShape: [600, 1200]
      },
      signal
    );
    if (!Array.isArray(parsed.staff)) {
      throw new Error(
        `Local vision model staff response has no staff array: ${JSON.stringify(parsed).slice(0, 1200)}`
      );
    }
    const slotAliases = new Map([
      ["1", "mayor"],
      ...Array.from({ length: 10 }, (_, index) => [
        String(index + 2),
        `staff${index + 1}`
      ])
    ]);
    const allowedSlots = new Set([
      "mayor",
      "top1",
      "top2",
      "top3",
      "top4",
      "bottom1",
      "bottom2",
      ...Array.from({ length: 10 }, (_, index) => `staff${index + 1}`)
    ]);
    return parsed.staff
      .map((item) => ({
        slot:
          slotAliases.get(String(item?.slot || "").trim()) ||
          String(item?.slot || "").trim(),
        name: String(item?.name || "").trim(),
        campTitle: String(item?.campTitle || "").trim()
      }))
      .filter((item) => allowedSlots.has(item.slot) && item.name);
  }

  async identifyOverlayControl(imagePath, { ocrTexts = [] } = {}, signal) {
    if (!this.enabled || this.config.transport !== "http") return null;
    const prompt = [
      "识别《明日之后》当前遮挡页面唯一适合关闭的控件。你只读、不能执行操作。",
      "control只能是close_x、back、collapse、none。",
      "右上角明确可见X/关闭图标=close_x；左下角明确可见“返回”按钮或返回箭头=back；完整聊天面板右下角明确可见“收起”=collapse；不清晰、没有遮挡或无法确定=none。",
      "只判断这三种安全关闭控件，不得建议其他按钮、坐标、地图、攻击或任务操作。",
      "按钮清晰且位置符合时confidence可为0.97；有轻微遮挡但仍明确时最高0.95；存在疑问不得超过0.85。",
      `OCR=${JSON.stringify(ocrTexts.slice(0, 30))}。`,
      '只返回一行JSON：{"control":"none","confidence":0.0,"evidence":"20字内依据"}'
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      {
        maxTokens: 64,
        resizeShape: this.config.resizeShape
      },
      signal
    );
    if (
      !OVERLAY_CONTROLS.has(parsed.control) ||
      !Number.isFinite(Number(parsed.confidence))
    ) {
      throw new Error("Local vision model returned an invalid overlay control");
    }
    return {
      control: parsed.control,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
      evidence: String(parsed.evidence || "").slice(0, 120)
    };
  }
}

async function requestHttp(
  config,
  imagePath,
  prompt,
  { maxTokens, resizeShape },
  signal
) {
  const image = await readFile(imagePath);
  const mime = extname(imagePath).toLowerCase() === ".jpg"
    ? "image/jpeg"
    : "image/png";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Local vision model timed out")),
    Math.max(180, Number(config.timeoutSeconds) || 180) * 1000
  );
  const abort = () =>
    controller.abort(signal?.reason || new Error("Task interrupted"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(
      `${config.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: maxTokens,
          resize_shape: resizeShape,
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
    return parseJson(content);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function tableNumber(value) {
  const digits = String(value ?? "").replace(/[^\d-]/g, "");
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function focusedRule(expectedState, taskHint) {
  const expected = String(expectedState || "");
  if (
    expected.includes("promotion") &&
    expected.includes("hud")
  ) {
    return "本次重点区分登录后宣传页与HUD：全屏活动主视觉、武器/时装大图，带“立即前往”“前往查看”“前往活动”、活动日期/活动时间或底部分页标记时判promotion；报纸版式且标题为《明日希望报》时判promotion_newspaper；只有角色3D场景与小地图、血条、聊天、动作键明确可见且没有全屏海报时才判hud。";
  }
  if (
    expected.includes("hud") &&
    expected.includes("map") &&
    expected.includes("panel")
  ) {
    return "本次重点区分三种状态：无遮挡3D角色主界面=hud；全屏地点地图或地点列表=map；贡献表、成员页、队伍页、交谈页、确认框等覆盖式功能窗口=panel。功能窗口仍在时绝不能判hud。";
  }
  if (expected.includes("login")) {
    return "本次重点区分登录页与公告：只要底部中央有大号金色“点击登录游戏”，必须判为login，左上角游戏LOGO和底部说明不是公告；只有中央覆盖式面板且右上明确可见关闭X时才能判为prelogin_announcement，没有X绝不能判公告。";
  }
  if (expected.includes("hud")) {
    return "本次重点确认HUD：只要人物所在3D场景、右上圆形小地图、左上血条，以及屏幕边缘聊天/背包/动作图标同时可见，就判为hud；横幅、NPC文字和任务提示不影响HUD判断。";
  }
  if (expected === "map") {
    return "本次重点确认地图：全屏平面地图、左侧地点列表或“标志查看/查看庄园”任一特征清晰可见，就判为map。";
  }
  if (expected === "target_text_visible") {
    return `本次只确认指定界面文字是否可见：${String(taskHint).slice(0, 240)}。任一指定文字清晰可见就判为target_text_visible，否则unknown。`;
  }
  if (expected.includes("patrol_team_full")) {
    return "本次只判断巡逻队人数：四个玩家卡位都有人且没有任何“等待队员加入”空位时判patrol_team_full；只要有一个空位就判patrol_team_waiting。不要根据队伍目标猜人数。";
  }
  return "优先依据完整界面结构分类，不要把普通说明文字当作公告。";
}

function parseCliGeneration(stdout) {
  const matches = [
    ...String(stdout || "").matchAll(/Assistant:\s*\n([\s\S]*?)(?=\n=+|$)/g)
  ];
  if (!matches.length) {
    throw new Error("Local vision CLI did not return an assistant response");
  }
  return parseJson(matches.at(-1)[1]);
}

function normalizeAdvice(parsed) {
  if (
    !STATES.has(parsed.state) ||
    !ACTIONS.has(parsed.action) ||
    !Number.isFinite(Number(parsed.confidence))
  ) {
    throw new Error("Local vision model returned an invalid classification");
  }
  return {
    state: parsed.state,
    action: "wait",
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
    evidence: String(parsed.evidence || "").slice(0, 240)
  };
}

function parseJson(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item?.text || "").join("")
    : String(content || "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        try {
          objects.push(JSON.parse(candidate));
        } catch {
          // Keep scanning: the model can surround a later valid object with
          // prose or emit one malformed candidate before the valid response.
        }
        start = -1;
      }
    }
  }
  if (!objects.length) {
    throw new Error("Local vision model did not return a complete JSON object");
  }
  if (
    objects.length > 1 &&
    objects.every((object) => Array.isArray(object?.rows))
  ) {
    return { rows: objects.flatMap((object) => object.rows) };
  }
  if (
    objects.length >= 1 &&
    objects.every(
      (object) =>
        Number.isInteger(Number(object?.row)) &&
        typeof object?.name === "string" &&
        (
          typeof object?.campTitle === "string" ||
          typeof object?.profession === "string" ||
          typeof object?.roommateName === "string"
        )
    )
  ) {
    return { profiles: objects };
  }
  if (
    objects.length >= 1 &&
    objects.every(
      (object) =>
        Number.isInteger(Number(object?.row)) &&
        typeof object?.name === "string"
    )
  ) {
    return { names: objects };
  }
  if (
    objects.length >= 1 &&
    objects.every(
      (object) =>
        typeof object?.slot === "string" &&
        typeof object?.name === "string"
    )
  ) {
    return { staff: objects };
  }
  return objects[0];
}
