export const config = {
  tables: {
    contribution: {
      region: { left: 1220, top: 270, right: 1900, bottom: 1000 },
      ocrMinimumConfidence: 0.3,
      minimumCompleteRows: 100,
      columns: [
        { key: "name", left: 0, right: 0.32 },
        { key: "weeklyContribution", left: 0.32, right: 0.54 },
        { key: "technologyPointsUsed", left: 0.54, right: 0.76 },
        { key: "materialContribution", left: 0.76, right: 1 }
      ],
      headerPattern: ["全部成员", "一周贡献", "使用科技点", "贡献物资"],
      pagination: {
        from: { x: 1550, y: 980 },
        to: { x: 1550, y: 250 },
        durationMs: 1000,
        initialSettleMs: 3000,
        settleAfterSwipeMs: 2000,
        maxPages: 11,
        stopAfterStagnantPages: 2,
        rowsPerPage: 11,
        minimumRowsPerPage: 11,
        visibleRowsPerPage: 11,
        lastPageRows: 11,
        swipeStartY: 980,
        rowAnchorTop: 285,
        rowHeightPx: 66,
        measurePageHeightFromRows: true,
        pageHeightPx: 729,
        pageHeightExtraPx: 0,
        rowColorMetric: "luminance",
        rowColorAdaptive: true,
        rowColorSampleStepPx: 5,
        rowResidualMaxPx: 18,
        maxRowAlignments: 1,
        rowAlignmentDurationMs: 1000,
        rowAlignmentSettleMs: 1500
      }
    }
  }
};
