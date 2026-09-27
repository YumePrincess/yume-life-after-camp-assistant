export const config = {
  technology: {
    tabs: {
      technology: { x: 959, y: 208 },
      pending: { x: 1688, y: 320 },
      configure: { x: 1645, y: 672 },
      finish: { x: 1644, y: 672 }
    },
    slots: {
      core: [
        { x: 768, y: 425 }, { x: 899, y: 425 }, { x: 1030, y: 425 },
        { x: 1161, y: 425 }, { x: 1292, y: 425 }, { x: 1423, y: 425 }
      ],
      general: [
        { x: 704, y: 554 }, { x: 834, y: 554 }, { x: 965, y: 554 },
        { x: 1096, y: 554 }, { x: 1227, y: 554 }, { x: 1358, y: 554 }
      ]
    },
    selectorSwipe: {
      // The selector viewport is about 700px tall; a 645px drag advances one
      // calibrated page while keeping both endpoints inside its scroll area.
      from: { x: 430, y: 900 },
      to: { x: 430, y: 255 },
      durationMs: 450,
      maxPages: 60,
      resetToTop: {
        from: { x: 430, y: 380 },
        to: { x: 430, y: 850 },
        durationMs: 220,
        repeats: 20
      }
    },
    selectorRegion: { left: 60, top: 110, right: 560, bottom: 1050 },
    selectorItemTapX: 178,
    configurePageSettleMs: 5000,
    dismissDetailBetweenSlots: true,
    slotOpenSettleMs: 1200,
    slotOpenAttempts: 3,
    slotRetrySettleMs: 1000,
    detailOpenSettleMs: 1200,
    selectorSettleMs: 800,
    selectionConfirmAttempts: 3,
    selectionBorderOffsetY: -73,
    selectionBorderProbeRadius: 4,
    unloadSelected: { x: 744, y: 612 },
    unloadSettleMs: 3000,
    configureSelected: { x: 744, y: 612 },
    configureSettleMs: 3000,
    detailsRegion: { left: 520, top: 250, right: 1050, bottom: 850 },
    selectedTechnologyNameRegion: { left: 520, top: 250, right: 1050, bottom: 570 },
    filledSlotDetection: {
      sampleRadius: 24,
      maximumEmptyFeatureDistance: 0.08,
      minimumInstalledFeatureDistance: 0.08,
      fallbackMinimumOccupiedFeatureDistance: 0.1
    },
    emptyReference: {
      core: {
        meanRed: 0.3356,
        meanGreen: 0.4304,
        meanBlue: 0.3168,
        meanSaturation: 0.2614,
        luminanceDeviation: 0.0673
      },
      general: {
        meanRed: 0.3356,
        meanGreen: 0.3373,
        meanBlue: 0.3405,
        meanSaturation: 0.0171,
        luminanceDeviation: 0.1541
      }
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
