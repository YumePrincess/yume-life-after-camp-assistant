(() => {
  "use strict";
  const media = [
    "支持文本、图片和视频；媒体链接需单独占一行。",
    "图片：![说明](https://example.com/image.jpg)",
    "视频：@[说明](https://example.com/video.mp4)",
    "图片和视频语法必须完整；普通引用和网页链接会作为文本显示。",
    "也可单独填写 MP4、WebM、M4V、MOV、OGV 视频直链。只支持 HTTPS 直链，不支持视频平台页面链接。",
    "预览卡片使用 16:10 画框，图片和视频按原比例完整显示；点击后按原比例适配窗口。"
  ];
  const help = {
    chatUpload: [
      "单文件上限支持 100MB 及以上，最高 51200MB（50GB）；1MB 按 1048576 字节计算。",
      "大文件自动分块上传到已有 R2 存储桶，无需额外密钥。每块使用 AES-256-GCM 加密，读取时按块解密；这属于服务端加密。",
      "保存后立即生效；保留天数的清理任务每10分钟执行。"
    ],
    monthly: ["按抽签截止（结算）日所在月份统计，从当月1日计算至下月1日（后台时区）。"],
    eligibility: ["投票资格在提交投票时校验；投票成功后，后续资料变化不会取消已记录的投票。"],
    approval: ["破格投票次数与破格有效日期只能选择一种批准方式。"],
    bypass: ["开启后，无论四项贡献活跃值是否达标，用户卡片均显示已达标且无需申请破格资格；禁投状态仍优先生效。"],
    prohibition: ["禁止期间无法投票或申请破格资格；贡献达标、破格资格和关闭资格校验均不会解除，只有管理员可以解除。"],
    schedule: ["默认每天执行；可选择一个或多个星期。"],
    citySchedule: ["自动任务每周执行一次；执行时间只能设在后台时区的周三 03:00 至周五 02:00。"],
    highlights: ["公告之间空一行；同一公告内可以换行。", ...media],
    rich: media,
    options: ["每个选项之间空一行；同一选项内可以混排文本、图片和视频。", ...media],
    announcement: ["此处仅填写首页的文字简介；图片和视频请添加到营地公告列表。"],
    group: [
      "直接编辑营地群 Markdown 内容，保存后会在公共页立即显示。支持标题、文本、换行、链接和图片。",
      "图片示例：![微信群二维码](https://example.com/images/camp-groups/wx.png)。图片和链接可使用 HTTPS 地址，也可使用本站以 / 开头的静态资源路径。",
      "默认二维码是占位图，请替换为实际群二维码；可把图片放入本站静态资源目录并填写对应路径。"
    ],
    member: [
      "名称和手动修改的资料会在对应成员下次同步时以同步数据覆盖；资料采集时间由系统维护。",
      "留空时按有效识别码玩家名称自动匹配；绑定仅用于当前成员记录，成员下次同步不存在时会按新数据更新。"
    ],
    result: ["粘贴 Agent「任务结果」中的完整文档。校验通过并确认后，Workers 才会按文档任务类型校正对应数据。"],
    batch: ["1-8 位数字；填写 0 时不限制重复中签"],
    drawTypeCode: ["1-8 位数字；同编码事项与最近一次有中签结果的抽签不重复中签。填写 0 或没有上次结果时，不限制重复中签。"],
    interval: ["填 1 时按 6 月 1 日、3 日、5 日……生效"],
    technology: ["指定日期适合临时安排；按星期和按间隔适合长期计划。规则可叠加，命中同一天时指定日期优先。"]
  };
  function createButton(topic) {
    const button = document.createElement("button");
    button.className = "editor-help-button";
    button.type = "button";
    button.dataset.editingHelp = topic;
    button.setAttribute("aria-label", window.MrzhI18n.t("编辑说明"));
    button.setAttribute("title", window.MrzhI18n.t("编辑说明"));
    button.setAttribute("aria-haspopup", "dialog");
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>';
    return button;
  }
  function install(showAlert) {
    document.addEventListener("click", event => {
      const button = event.target.closest("[data-editing-help]");
      const paragraphs = button && help[button.dataset.editingHelp];
      if (!paragraphs) return;
      event.preventDefault();
      void showAlert(paragraphs.map(text => window.MrzhI18n.t(text)).join("\n\n"), { title: "编辑说明", editingHelp: true });
    });
  }
  window.MrzhEditingHelp = Object.freeze({ install, createButton });
})();
