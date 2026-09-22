export const config = {
  tables: {
    members: {
      extractionMode: "hybrid",
      ocrMinimumConfidence: 0.3,
      region: { left: 115, top: 285, right: 1800, bottom: 780 },
      rowAnchorTop: 315,
      // Keep the member name, profession, contribution, manor level and
      // roommate columns visible to OCR/Qwen.  The other columns contain
      // artwork/status text that is not part of the member profile and can
      // leak into the roommate/name fields.
      avatarMaskRegion: { left: 115, top: 285, right: 250, bottom: 945 },
      onlineStateMaskRegion: { left: 1209, top: 285, right: 1370, bottom: 945 },
      sceneMaskRegion: { left: 1370, top: 285, right: 1563, bottom: 945 },
      fixedRowMaskRegion: { left: 115, top: 810, right: 1800, bottom: 945 },
      columns: [
        { key: "identity", stackedKeys: ["name"], left: 0.08, right: 0.318 },
        { key: "profession", left: 0.318, right: 0.46 },
        { key: "weeklyContribution", left: 0.46, right: 0.555 },
        { key: "manorLevel", left: 0.555, right: 0.65 },
        { key: "onlineState", left: 0.65, right: 0.745 },
        { key: "scene", left: 0.745, right: 0.858 },
        { key: "roommateName", left: 0.858, right: 1 }
      ],
      headerPattern: ["全部成员", "输入玩家昵称", "营地招募"],
      pagination: {
        from: { x: 1700, y: 700 },
        to: { x: 1700, y: 225 },
        firstPageFrom: { x: 1700, y: 700 },
        firstPageTo: { x: 1700, y: 225 },
        durationMs: 1000,
        settleAfterSwipeMs: 2000,
        rowsPerPage: 5,
        minimumRowsPerPage: 5,
        maxIncompletePageRetries: 6,
        fullPageRegion: { left: 115, top: 340, right: 1800, bottom: 810 },
        fullPageRows: 5,
        maxRowAlignments: 1,
        rowHeightPx: 95,
        rowColorThreshold: 0.3,
        rowColorSampleStepPx: 5,
        rowAlignmentDurationMs: 1000,
        rowAlignmentSettleMs: 2000,
        maxPages: 24,
        stopAfterStagnantPages: 3
      }
    },
    staffGrid: {
      slots: [
        { roleKey: "staff-1", roleName: "公职席位 1", region: { left: 560, top: 470, right: 850, bottom: 590 } },
        { roleKey: "staff-2", roleName: "公职席位 2", region: { left: 850, top: 470, right: 1150, bottom: 590 } },
        { roleKey: "staff-3", roleName: "公职席位 3", region: { left: 1150, top: 470, right: 1450, bottom: 590 } },
        { roleKey: "staff-4", roleName: "公职席位 4", region: { left: 1450, top: 470, right: 1750, bottom: 590 } },
        { roleKey: "mayor", roleName: "市长", region: { left: 230, top: 780, right: 500, bottom: 900 } },
        { roleKey: "staff-6", roleName: "公职席位 6", region: { left: 520, top: 780, right: 820, bottom: 900 } },
        { roleKey: "staff-7", roleName: "公职席位 7", region: { left: 830, top: 780, right: 1130, bottom: 900 } }
      ]
    }
  },
  flows: {
    openCampPanel: [{
      op: "openCampPanelViaProfile",
      profileButton: { x: 70, y: 64 },
      profileOpenSettleMs: 1500,
      profileReadyTexts: [
        "营地", "交易之城", "交易之称", "天赋能力", "潜能强化",
        "拟态能力", "核芯", "角色属性", "个人档案"
      ],
      profileReadyRegion: { left: 650, top: 160, right: 1850, bottom: 1080 },
      profileReadyMinimumTexts: 4,
      campCardButton: { x: 1005, y: 420 },
      campCardSettleMs: 2500,
      readyConstantAnchors: [
        { text: "营地", region: { left: 90, top: 90, right: 340, bottom: 200 } },
        { text: "量子时代", region: { left: 250, top: 240, right: 650, bottom: 400 } },
        { text: "市长", region: { left: 140, top: 360, right: 700, bottom: 560 } },
        { text: "营地周活跃", region: { left: 600, top: 250, right: 1150, bottom: 430 } }
      ],
      readyMinimumConstants: 2,
      readyTabTexts: ["首页", "玩法", "科技", "成员", "相册"],
      readyBodyTexts: ["营地周活跃", "参与活动", "收到通知", "市长"],
      readyTabRegion: { left: 350, top: 150, right: 1550, bottom: 270 },
      readyBodyRegion: { left: 120, top: 250, right: 1820, bottom: 1000 },
      readyMinimumTabs: 2,
      attempts: 6,
      verifySeconds: 6
    }]
  }
};
