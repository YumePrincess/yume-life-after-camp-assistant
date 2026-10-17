import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual page handler without bootstrapping unrelated page features.
const source = readFileSync(new URL("../public/js/public.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  async function openVoteParticipants("),
  source.indexOf("  function categoryName("));

function setup(request = vi.fn().mockResolvedValue({ names: [] })) {
  const events = [];
  const dialog = {
    open: false,
    showModal() { this.open = true; events.push("participants:open"); },
    close() { this.open = false; }
  };
  const list = {
    hidden: false,
    children: [],
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); }
  };
  const subtitle = { textContent: "", hidden: true };
  const text = {};
  const notice = vi.fn(() => events.push("notice:open"));
  const nodes = {
    "vote-participants-dialog": dialog,
    "vote-participants-list": list,
    "vote-participants-subtitle": subtitle
  };
  const open = runInNewContext(`${handler}\nopenVoteParticipants`, {
    identitySession: () => null,
    byId: id => nodes[id],
    setText: (id, value) => { text[id] = value; },
    create: (_tag, _class, value) => value,
    request,
    showOperationProgress: () => { events.push("progress:open"); return 1; },
    hideOperationProgress: () => events.push("progress:close"),
    showOperationNotice: notice,
    window: { MrzhI18n: {
      language: () => "zh-cn",
      t: value => value,
      format: (value, data) => value.replace("{count}", String(data.count))
    } }
  });
  return { open, dialog, list, subtitle, text, notice, events };
}

describe("public vote participant dialogs", () => {
  it("shows an empty result in one card that needs only one close", async () => {
    const ui = setup();
    await ui.open({ kind: "daily-poll", subtitle: "零票选项" });
    expect(ui.dialog.open).toBe(true);
    expect(ui.text["vote-participants-status"]).toBe("暂无参与人。");
    expect(ui.subtitle.textContent).toBe("零票选项");
    expect(ui.list.hidden).toBe(true);
    expect(ui.notice).not.toHaveBeenCalled();
    ui.dialog.close();
    expect(ui.dialog.open).toBe(false);
    expect(ui.events).toEqual(["progress:open", "progress:close", "participants:open"]);
  });

  it("waits for the response and closes progress before opening the populated card", async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const ui = setup(vi.fn().mockReturnValue(pending));
    const loading = ui.open({ kind: "daily-poll" });
    expect(ui.dialog.open).toBe(false);
    resolve({ names: ["成员甲", "成员乙"] });
    await loading;
    expect(ui.list.children).toEqual(["成员甲", "成员乙"]);
    expect(ui.list.hidden).toBe(false);
    expect(ui.text["vote-participants-status"]).toBe("共 2 人");
    expect(ui.events).toEqual(["progress:open", "progress:close", "participants:open"]);
  });

  it("shows only an error notice when fetching participants fails", async () => {
    const ui = setup(vi.fn().mockRejectedValue({ code: "vote_participation_required" }));
    await ui.open({ kind: "technology" });
    expect(ui.dialog.open).toBe(false);
    expect(ui.notice).toHaveBeenCalledExactlyOnceWith("请先完成本期投票后再查看名单。", { kicker: "DAILY VOTING" });
    expect(ui.events).toEqual(["progress:open", "progress:close", "notice:open"]);
  });

  it("clears prior names and empty state when opening another option", async () => {
    const request = vi.fn().mockResolvedValueOnce({ names: ["成员甲"] }).mockResolvedValueOnce({ names: [] });
    const ui = setup(request);
    await ui.open({ kind: "daily-poll", subtitle: "选项甲" });
    ui.dialog.close();
    await ui.open({ kind: "daily-poll", subtitle: "选项乙" });
    expect(ui.list.children).toEqual([]);
    expect(ui.list.hidden).toBe(true);
    expect(ui.subtitle.textContent).toBe("选项乙");
    expect(ui.text["vote-participants-status"]).toBe("暂无参与人。");
    expect(ui.notice).not.toHaveBeenCalled();
  });
});
