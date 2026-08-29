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

  async extractMemberCounts(imagePath, signal, { ocrHint = null } = {}) {
    if (!this.enabled || this.config.transport !== "http") return null;
    const prompt = [
      "复核《明日之后》营地成员页顶部人数区域。图片只包含顶部人数栏，请以图像为准，不要猜测。",
      "读取正式市民formal和启航市民sailing两组分数，每组分别返回current（在线人数）和total（总人数）。current必须小于或等于total。",
      "启航市民的格式一定是N/A：N为在线人数、A为启航市民总数，N和A都在0到10之间；除了10以外都只有一位数字，不会显示01、02。",
      "紧挨分数的圆圈i是信息按钮，不是数字：0i、1i、2i分别仍是0、1、2，绝不能拼成01、11、21；10i仍是10，绝不能读成101。",
      "正式市民总数最多110。不要把两个分数相加到任何一组，不要读取表格行、按钮或其他数字。",
      ocrHint
        ? `Apple OCR初读仅供交叉检查，不能照抄：${JSON.stringify(ocrHint)}。`
        : "",
      '只返回一行JSON且不要Markdown：{"formalCurrent":0,"formalTotal":0,"sailingCurrent":0,"sailingTotal":0}'
    ].filter(Boolean).join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      { maxTokens: 128, resizeShape: [128, 640] },
      signal
    );
    const formal = parsed?.formal || parsed?.formalCitizens || {};
    const sailing = parsed?.sailing || parsed?.sailingCitizens || {};
    const result = {
      formalCurrent: strictVisionCount(
        parsed?.formalCurrent ?? formal.current,
        110,
        0
      ),
      formalTotal: strictVisionCount(
        parsed?.formalTotal ?? formal.total,
        110,
        1
      ),
      sailingCurrent: strictVisionCount(
        parsed?.sailingCurrent ?? sailing.current,
        10,
        0
      ),
      sailingTotal: strictVisionCount(
        parsed?.sailingTotal ?? sailing.total,
        10,
        0
      )
    };
    if (
      Object.values(result).some((value) => value === null) ||
      result.formalCurrent > result.formalTotal ||
      result.sailingCurrent > result.sailingTotal
    ) {
      throw new Error(
        `Local vision model returned invalid member counts: ${JSON.stringify(parsed).slice(0, 1200)}`
      );
    }
    return result;
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
      "四列从左到右是：玩家姓名、一周贡献、使用科技点、贡献物资。玩家姓名可能完全由emoji或符号组成，例如 -😊-、✨、★，必须保留，不得因缺少汉字、字母或数字而丢弃。",
      "姓名符号按原图逐字符保留并区分空心/实心：❀、✿、❁、❃、✾、✽、✻、🌸、✨、✦、★、☆、♥、♡、༺、༻、☂、-、—、_、｜、|、・、·、^、&、+、$、@、括号、引号和其他emoji。༺与༻是藏文装饰标记，不能改写成꧁/꧂、9、q、4、G或5。不要把这些符号互换、删除或错读为※、*、米、導、数字或字母；只有原图确实出现时才输出。",
      "姓名右侧与姓名隔开的小型R/®/回归/启航/先行者图标是身份徽章，不是姓名；不能把徽章或它的边缘像素并入姓名。姓名本身的花朵、星星、心形、藏文装饰和emoji必须保留。",
      "贡献表中最多只会出现一个市长身份徽章（白色盾牌/王冠样式）；它不是玩家名称。若它出现在姓名右侧，无论模型将其读成市长、mayor、皇冠、王冠、盾、忠、♔♕♚♛或相近棋子，都必须从name中删除；不要删除姓名本身的星星、花朵、心形或emoji。",
      "贡献物资可能是超出单元格宽度的8位或更长数字；必须保留最左侧首位并读取完整数字。",
      "所有数值只保留十进制整数；逗号、空格等分隔符去掉。",
      "忽略表头、按钮和说明文字。看不到任何真实成员行时返回空rows，严禁输出字段名、示例值或占位数据。",
      "当前画面通常有多行成员；必须按从上到下为每个可见行返回一项，row从1连续编号。看不清某一行时仍保留该row并把对应字段填空，不能跳过该行或把后面的姓名前移。",
      "只返回一次单行JSON对象，不要逐行输出多个对象，不要重复。",
      `字段固定为：row、${columns.join(",")}。`,
      "只返回一个单行JSON对象且不要Markdown。对象唯一顶层字段是rows；rows是数组，每项必须含row整数和上述字段。"
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
        row: Number.parseInt(row?.row, 10),
        name: String(row?.name || "").trim(),
        weeklyContribution: tableNumber(row?.weeklyContribution),
        technologyPointsUsed: tableNumber(row?.technologyPointsUsed),
        materialContribution: tableNumber(row?.materialContribution)
      }))
      .filter(
        (row) =>
          Number.isInteger(row.row) &&
          row.row > 0 &&
          !/^(?:玩家名|成员名|姓名|name|player)$/i.test(row.name) &&
          !/(?:全部成员|一周贡献|使用科技点|贡献物资)/.test(row.name)
      );
  }

  async extractActivity(imagePath, signal) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const prompt = [
      "读取《明日之后》营地成员在线情况/斩杀预警表当前可见的所有成员行。",
      "图片已经只裁剪到表格区域。按从上到下的视觉顺序逐行读取，不能臆造或跳过看不清的行。",
      "每项读取玩家姓名name和在线情况onlineState；在线情况可能是“在线”、“刚刚”、“12小时前”、“1天前”等原始文字，必须保留原文。",
      "玩家姓名可能完全由emoji或符号组成，例如 -😊-、✨、★；这些都是有效姓名，必须逐字符保留。",
      "按原图区分花朵、星星、心形、藏文装饰标记༺/༻、雨伞、短横线、竖线、间隔点、插入符、&、+、$、括号、引号和emoji；不要把 ❀/✿、✨/✦/★/☆、♡/♥、༺/༻ 或其他相近符号互换、删除或读成汉字。",
      "姓名右侧与姓名隔开的小型R/®/回归/启航/先行者图标是身份徽章，不是姓名；不能把徽章或它的边缘像素并入姓名。姓名本身的花朵、星星、心形、藏文装饰和emoji必须保留。",
      "斩杀预警表中最多只会出现一个市长身份徽章（白色盾牌/王冠样式）；它不是玩家名称。若它出现在姓名右侧，无论模型将其读成市长、mayor、皇冠、王冠、盾、忠、♔♕♚♛或相近棋子，都必须从name中删除；不要删除姓名本身的星星、花朵、心形或emoji。",
      "忽略表头、排序按钮、头像和说明文字。必须按从上到下为每个可见行返回一项，row从1连续编号；看不清某一行时仍保留row并把name或onlineState填空，不能跳过该行或把后面的姓名前移。看不到真实成员行时返回空rows，严禁输出字段名、示例值或占位数据。",
      "只返回一次单行JSON对象且不要Markdown。顶层唯一字段是rows；每项必须含row整数、name字符串、onlineState字符串。"
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
      throw new Error("Local vision model activity response has no rows");
    }
    return parsed.rows
      .map((row) => ({
        row: Number.parseInt(row?.row, 10),
        name: String(row?.name || "").trim(),
        onlineState: String(row?.onlineState || "").trim()
      }))
      .filter(
        (row) =>
          Number.isInteger(row.row) &&
          row.row > 0 &&
          row.row <= 32 &&
          !/(?:全部成员|在线情况|姓名)/.test(row.name)
      );
  }

  async extractNames(imagePath, signal) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const prompt = [
      "读取《明日之后》营地贡献表姓名列中当前可见的所有成员姓名。",
      "从上到下编号，第一条可见成员行为1。玩家姓名可能完全由emoji或符号组成，例如 -😊-、✨、★；这些都是有效姓名，必须逐字符保留，不能因为没有汉字、字母或数字而留空。",
      "必须为每一条可见行返回一个行号；看不清姓名时name为空字符串，不能跳过该行，不能把后续姓名提前。",
      "忽略表头、头像和其他列，不要读取任何贡献数值。",
      "姓名右侧与姓名隔开的小型R/®/回归/启航/先行者图标是身份徽章，不是姓名；不能把徽章或它的边缘像素并入姓名。姓名本身的花朵、星星、心形、藏文装饰和emoji必须保留。",
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

  async extractMemberDetails(imagePath, rowCount, signal, options = {}) {
    if (!this.enabled || this.config.transport !== "http") return [];
    const count = Math.max(1, Number.parseInt(rowCount, 10) || 1);
    const prompt = [
      options.singleRow
        ? "这是从成员资料表裁出的单独一行；只读取这一个可见行，绝不能把其他行的姓名前移到这一行。"
        : "读取《明日之后》营地“成员-基础信息”表当前完整可见的成员行。",
      `右侧“在线/离线”列明确标出了 ${count} 条完整成员行；profiles 必须恰好返回 ${count} 项，row 从1连续到${count}，绝不能漏行或把后一行前移。`,
      "成员清单只读取每行最上面的第一行玩家姓名name。下面较小的职位/Title行完全忽略，campTitle必须返回空字符串；绝不能把第二行职位当成玩家姓名。",
      "另外读取同一行的职业profession和最右侧同居人roommateName；没有文字或看不清时填空字符串，不能猜测。",
      options.symbolAware === false
        ? "保留姓名中的字母、数字和可辨认装饰符号。"
        : "玩家姓名可能完全由符号或emoji组成，例如 -😊-、✨、★、※；这些都是有效name，必须逐字符保留，不能因为没有汉字、字母或数字而留空。保留姓名中的字母、数字、emoji、标点和可辨认装饰符号。",
      "符号必须以原图字形为准逐字符抄录：若原图可见才保留 ❀、✿、❁、❃、✾、✽、✻、🌸、✨、✦、★、☆、♥、♡、☂、-、—、_、｜、|、・、·、^、&、+、$、@、括号、引号或其他emoji；不要互换相近符号，不要把符号读成汉字、数字、字母或职位，也不要擅自补写。花朵、星星和心形的空心/实心差异属于姓名本身，必须保留。",
      "姓名右侧的小型R/®/启航/回归/先行者徽标不是姓名；它通常与姓名之间有明确空格，或位于姓名右侧独立的小图标位置。只排除这个独立徽标，不得把它作为姓名字符，也不得因此删除姓名尾部真实的花朵、星星、心形、雨伞、短横线或emoji。",
      "头像卡片上印刷的2025、20251，以及OCR可能误读出的D025、O025、2O25等年份样式不是玩家姓名；遇到这些只忽略头像字样，继续读取同一行身份栏的真实姓名。只有身份栏确实没有任何姓名字形时才返回空name。",
      "如果name与同一行profession完全相同，且name本身只是普通无数字无符号的职业短语，说明把职业误当成了姓名；此时name必须为空字符串。若name含数字、字母、emoji或装饰符号，即使两个字段暂时相同，也必须保留为候选姓名，不能因字段相等而丢掉整行。",
      "忽略表头、头像、周贡献、庄园等级、在线状态与所在场景。",
      "只返回一次单行JSON对象且不要Markdown。顶层唯一字段profiles；每项只有row整数、name、campTitle、profession、roommateName字符串，campTitle固定为空字符串。"
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      {
        maxTokens: 768,
        resizeShape: options.singleRow ? [256, 960] : [480, 1280]
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
        campTitle: "",
        profession: String(item?.profession || "").trim(),
        roommateName: String(item?.roommateName || "").trim()
      }))
      .filter((item) => Number.isInteger(item.row) && item.row > 0);
  }

  async extractMemberName(imagePath, signal) {
    if (!this.enabled || this.config.transport !== "http") return "";
    const prompt = [
      "读取这张《明日之后》营地成员表单行姓名栏裁剪图中的唯一玩家姓名。",
      "图中只有姓名栏，不要读取头像、职业、等级或其他列；不要用职业或其他行的姓名替代当前姓名。",
      "姓名可能完全由emoji或符号组成，例如 -😊-、-😊·、✨、★、※；必须逐字符保留，包括两侧的短横线、中文间隔点、标点和装饰符号。看不清时返回空字符串，不要猜测。",
      "严格按原图区分空心花朵与实心花朵（如 ❀/✿/❁/❃/✾/✽/✻/🌸）、空心与实心星心（如 ✨/✦/★/☆/♡/♥）、藏文装饰标记༺/༻以及雨伞、短横线、竖线、间隔点、插入符、&、+、$和emoji；不要把相似符号替换成※、*、米、導、9、q、4、G或5。姓名后的R/®/启航等独立小徽标不属于姓名，但不能误删姓名自身的装饰符号；姓名和徽标之间若有空格，空格后的徽标必须丢弃。",
      '只返回一行JSON：{"name":""}，不要Markdown。'
    ].join("\n");
    const parsed = await requestHttp(
      this.config,
      imagePath,
      prompt,
      // Targeted rows are where hollow/solid decorations and separated
      // identity badges matter most. Keep more horizontal pixels than the
      // old 256x480 request so small glyphs are not blurred together.
      { maxTokens: 160, resizeShape: [384, 960] },
      signal
    );
    return String(parsed?.name || "").trim();
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

function strictVisionCount(value, maximum, minimum) {
  if (typeof value === "number") {
    if (maximum <= 10 && value === 101) return 10;
    return Number.isInteger(value) && value >= minimum && value <= maximum
      ? value
      : null;
  }
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  if (maximum <= 10 && parsed === 101) return 10;
  return parsed >= minimum && parsed <= maximum ? parsed : null;
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
