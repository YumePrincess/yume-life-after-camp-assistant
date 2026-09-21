export const config = {
  tables: {
    activity: {
      region: { left: 1220, top: 245, right: 1645, bottom: 975 },
      ocrMinimumConfidence: 0.3,
      sortPoint: { x: 1630, y: 230 },
      columns: [
        { key: "name", left: 0, right: 0.58 },
        { key: "onlineState", left: 0.58, right: 1 }
      ],
      headerPattern: ["全部成员", "在线情况", "营地资料"],
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
