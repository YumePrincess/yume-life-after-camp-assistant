export const config = {
  tables: {
    weeklyActivity: {
      extractionMode: "hybrid",
      ocrMinimumConfidence: 0.25,
      // Full left-side ranking card in the 1920x1200 MuMu frame.
      cardRegion: { left: 75, top: 420, right: 765, bottom: 945 },
      // Header and the fixed current-player row are excluded from OCR. The
      // four ordinary rows occupy this data rectangle on every page.
      readRegion: { left: 75, top: 470, right: 765, bottom: 840 },
      // Kept as a compatibility fallback for older agents/config readers.
      region: { left: 75, top: 470, right: 765, bottom: 840 },
      // Cover the portrait artwork only. The name text starts immediately
      // after the portrait, so the right edge must stop before the first name
      // glyph instead of using the full name-column width.
      avatarMaskRegion: { left: 200, top: 420, right: 330, bottom: 945 },
      // The highlighted row at the bottom is the fixed current-player row,
      // not another scrollable ranking row. Cover the complete row so its
      // rank/name/points cannot leak into the four-row OCR/Qwen result.
      fixedRowMaskRegion: { left: 75, top: 840, right: 765, bottom: 945 },
      rowAnchorTop: null,
      columns: [
        { key: "rank", left: 0, right: 0.18 },
        { key: "name", left: 0.18, right: 0.78 },
        { key: "weeklyActivityPoints", left: 0.78, right: 1 }
      ],
      headerPattern: ["排名", "成员", "活跃点", "暂无排名"],
      pagination: {
        from: { x: 405, y: 780 },
        to: { x: 405, y: 400 },
        durationMs: 900,
        // Wait for the ranking list to settle before applying the avatar mask
        // and starting OCR/Qwen. The game can leave the old row texture in
        // place briefly after the gesture.
        settleAfterSwipeMs: 2000,
        rowsPerPage: 4,
        minimumRowsPerPage: 1,
        maxPages: 40,
        stopAfterStagnantPages: 2,
        rowHeightPx: 89,
        // After a 357px page turn the first visible row can sit a few pixels
        // under the table header. Extend only that row's OCR window upward;
        // never extend the last row into the fixed current-player row.
        firstRowTopPaddingPx: 20,
        // Keep the original card dimensions and coordinates. Only the avatar
        // column is covered before OCR so rank/name/points stay row-aligned.
        fixedBottomTop: 840,
        // Keep every page turn at the same calibrated 357px distance.
        swipeOffsetPx: 357,
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
  },
  weeklyPlan: {
    participateButtonRegion: { left: 1450, top: 235, right: 1840, bottom: 500 },
    rankingButtonRegion: { left: 40, top: 240, right: 430, bottom: 470 },
    panelRegion: { left: 0, top: 0, right: 1920, bottom: 1200 },
    verifyTexts: ["营地周计划", "每周一凌晨3:00重置", "活跃排行", "贡献列表", "本周营地周活跃点", "参与活动"],
    rankingTexts: ["排名", "成员", "活跃点"]
  }
};
