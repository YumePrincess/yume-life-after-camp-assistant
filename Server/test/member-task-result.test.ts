import { describe, expect, it } from "vitest";
import { localizeMemberTaskResultError } from "../src/member-task-result-localization";
import { parseMemberTaskResultDocument } from "../src/member-task-result";

const COPY = [
  {
    title: "Agent 任务结果",
    description: "此文档记录本次任务读取并上传的成员数据。可以在 Agent 内或其他编辑器中修改；Workers 仅接受格式正确的版本。"
  },
  {
    title: "Agent 任務結果",
    description: "此文件記錄本次任務讀取並上傳的成員資料。可在 Agent 或其他編輯器中修改；Workers 僅接受格式正確的版本。"
  },
  {
    title: "Agent Task Results",
    description: "This document records member data read and uploaded by this task. Edit it in Agent or another editor; Workers accepts only documents that pass format validation."
  },
  {
    title: "Résultats de tâche de l’Agent",
    description: "Ce document répertorie les données des membres lues et envoyées par cette tâche. Modifiez-le dans l’Agent ou un autre éditeur ; Workers n’accepte que les documents au format valide."
  },
  {
    title: "Agent タスク結果",
    description: "このドキュメントには、タスクが読み取り送信したメンバーデータを記録します。Agent または他のエディタで編集できます。Workers は形式が正しいドキュメントのみ受け付けます。"
  }
];
const FENCE = "```";

function documentFor(copy: (typeof COPY)[number]): string {
  const data = {
    format: "yla-member-task-result/v1",
    taskKey: "contribution_sync",
    runId: "localized-run-1",
    capturedAt: "2026-10-16T12:00:00.000Z",
    payload: [{
      name: "Player One",
      weeklyContribution: 10,
      technologyPointsUsed: 20,
      materialContribution: 30
    }]
  };
  return `# ${copy.title}\n\n<!-- yla-member-task-result:v1 -->\n\n${copy.description}\n\n${FENCE}json\n${JSON.stringify(data, null, 2)}\n${FENCE}`;
}

describe("member task result documents", () => {
  it.each(COPY.map((copy) => [copy.title, copy] as const))(
    "accepts the generated %s document while preserving strict data validation",
    (_title, copy) => {
      const parsed = parseMemberTaskResultDocument(documentFor(copy));
      expect(parsed.taskKey).toBe("contribution_sync");
      expect(parsed.memberCount).toBe(1);
      expect(parsed.payload).toEqual([{
        name: "Player One",
        weeklyContribution: 10,
        technologyPointsUsed: 20,
        materialContribution: 30
      }]);
    }
  );

  it("rejects altered document framing and invalid member values", () => {
    expect(() => parseMemberTaskResultDocument(documentFor(COPY[2]!).replace("Agent Task Results", "Results")))
      .toThrow("文档格式不符");
    const invalid = documentFor(COPY[0]!).replace('"weeklyContribution": 10', '"weeklyContribution": -1');
    expect(() => parseMemberTaskResultDocument(invalid)).toThrow();
  });
});

describe("member correction error localization", () => {
  it("localizes known no-match and document errors", () => {
    expect(localizeMemberTaskResultError(
      "没有贡献数据与当前成员名单匹配，未应用任何校正",
      "en"
    )).toContain("No contribution rows matched");
    expect(localizeMemberTaskResultError(
      "文档格式不符：请保留 Agent 任务结果标题、版本标记和唯一的 JSON 数据块",
      "ja"
    )).toContain("ドキュメント形式が正しくありません");
  });

  it("replaces detailed Chinese validation output with a localized safe explanation", () => {
    expect(localizeMemberTaskResultError("第 1 行本周贡献必须是 0 至 100 的整数", "fr"))
      .toContain("Vérifiez les champs");
  });
});
