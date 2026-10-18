import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../public/js/chat-admin.js", import.meta.url),
  "utf8",
);
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = new Proxy(
      {},
      {
        set(target, key, value) {
          target[key] = String(value);
          return true;
        },
      },
    );
    this.className = "";
    this.textContent = "";
    this.classList = { toggle: () => {} };
  }
  get textContent() {
    return (
      this._text || this.children.map((child) => child.textContent).join("")
    );
  }
  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
  }
  setAttribute(key, value) {
    this[key] = value;
  }
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  querySelectorAll(selector) {
    return this.all().filter((el) =>
      selector === "[data-room-id]"
        ? el.dataset.roomId !== undefined
        : el.className.split(" ").includes(selector.slice(1)),
    );
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
function setup(failDelete = false) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  let messages = [
    {
      id: 10,
      content: "keep",
      sender: { displayName: "Member" },
      createdAt: "2026-10-17",
    },
    {
      id: 11,
      content: "delete",
      sender: { displayName: "Member" },
      createdAt: "2026-10-17",
    },
  ];
  const requests = [];
  const fetch = vi.fn(async (path, options) => {
    requests.push([path, options]);
    let payload;
    if (options.method === "DELETE") {
      if (failDelete)
        return { ok: false, json: async () => ({ error: "Delete failed" }) };
      messages = messages.filter((message) => message.id !== 11);
      payload = { ok: true };
    } else if (path.endsWith("/messages"))
      payload = {
        room: {
          id: 1,
          messageCount: messages.length,
          totalMessageCount: messages.length + 1,
        },
        messages,
      };
    else
      payload = {
        rooms: [
          { id: 1, name: "general", kind: "public", message_count: 2 },
          { id: 2, name: "Other room", kind: "public", message_count: 1 },
        ],
        totals: { rooms: 2, messages: 3, files: 0 },
      };
    return { ok: true, json: async () => payload };
  });
  const window = {
    MrzhI18n: { t: (value) => value },
    MrzhFeedback: { notice: vi.fn(), begin: vi.fn(() => 1), end: vi.fn() },
    MrzhTimezone: { timestamp: (value) => value },
  };
  runInNewContext(source, {
    window,
    document: {
      getElementById: byId,
      createElement: (tag) => new Element(tag),
      createTextNode: (text) =>
        Object.assign(new Element("text"), { textContent: text }),
      addEventListener: () => {},
      documentElement: { dataset: {} },
    },
    fetch,
    console,
  });
  return { window, byId, fetch, requests };
}

describe("admin message deletion counters", () => {
  it("updates the selected room and overall total after deleting, preserving the other room and selection", async () => {
    const state = setup();
    await state.window.MrzhChatAdmin.load("csrf", async () => true);
    const [room, other] = state.byId("chat-admin-rooms").children;
    await room.onclick();
    expect(room.querySelector(".chat-admin-room-count").textContent).toBe("2");
    const remove = state
      .byId("chat-admin-detail")
      .all()
      .find(
        (el) =>
          el.tag === "button" &&
          el.textContent === "删除消息" &&
          el !== undefined,
      );
    // Select the delete button belonging to message 11 (the second rendered message).
    const buttons = state
      .byId("chat-admin-detail")
      .all()
      .filter((el) => el.tag === "button" && el.textContent === "删除消息");
    expect(remove).toBeTruthy();
    await buttons[1].onclick();
    expect(room.querySelector(".chat-admin-room-count").textContent).toBe("1");
    expect(other.querySelector(".chat-admin-room-count").textContent).toBe("1");
    expect(state.byId("chat-admin-total-messages").textContent).toBe("2");
    expect(room["aria-current"]).toBe("true");
    expect(
      state.requests.filter(([path]) => path === "/api/admin/chat"),
    ).toHaveLength(1);
  });
  it("does not decrement counters or reload the room when deletion fails", async () => {
    const state = setup(true);
    await state.window.MrzhChatAdmin.load("csrf", async () => true);
    const room = state.byId("chat-admin-rooms").children[0];
    await room.onclick();
    const remove = state
      .byId("chat-admin-detail")
      .all()
      .filter((el) => el.tag === "button" && el.textContent === "删除消息")[1];
    await remove.onclick();
    expect(room.querySelector(".chat-admin-room-count").textContent).toBe("2");
    expect(state.byId("chat-admin-total-messages").textContent).toBe("3");
    expect(
      state.requests.filter(([path]) => path.endsWith("/messages")),
    ).toHaveLength(1);
    expect(state.window.MrzhFeedback.notice).toHaveBeenCalledWith("Delete failed");
    expect(state.window.MrzhFeedback.end).toHaveBeenCalledWith(1);
  });
});
