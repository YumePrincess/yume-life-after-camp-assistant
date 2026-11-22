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
  removeAttribute(key) { delete this[key]; }
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
  const nodes = new Map(), listeners = {};
  const root = {dataset:{}}, observers = [];
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
    } else if (path.endsWith("/general/avatar")) payload = { avatarUrl: "/api/admin/chat/general/avatar?v=test" };
    else if (path.endsWith("/messages"))
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
    MrzhAvatar: { open: vi.fn() },
  };
  runInNewContext(source, {
    window,
    document: {
      getElementById: byId,
      createElement: (tag) => new Element(tag),
      createTextNode: (text) =>
        Object.assign(new Element("text"), { textContent: text }),
      addEventListener: (type, listener) => { listeners[type] = listener; },
      documentElement: root,
      querySelectorAll: selector => [...new Set([...nodes.values()].flatMap(node=>node.all()))].filter(node =>
        selector.includes('data-chat-timestamp') ? node.dataset.chatTimestamp !== undefined : node.dataset.chatI18n !== undefined),
    },
    MutationObserver: class { constructor(callback){observers.push(callback);} observe(){} },
    fetch,
    FormData,
    console,
  });
  return { window, byId, fetch, requests, listeners, root, timezoneChanged(value){root.dataset.timezone=value;for(const callback of observers)callback();} };
}

describe('admin chat configured timezone',()=>{
  it('converts SQL UTC timestamps once and updates existing nodes without replacing cards or resetting scroll',async()=>{
    const ui=setup();
    runInNewContext(readFileSync(new URL('../public/js/timezone.js',import.meta.url),'utf8'),{window:ui.window});
    await ui.window.MrzhChatAdmin.load('csrf');
    ui.fetch.mockResolvedValueOnce({ok:true,json:async()=>({timezone:'UTC+08:00',room:{id:1,name:'general',kind:'public',messageCount:1},messages:[{id:1,sender:{displayName:'Alice'},content:'body',createdAt:'2026-10-21 23:38:06'}]})});
    await ui.byId('chat-admin-rooms').children[0].onclick();
    const detail=ui.byId('chat-admin-detail'),cards=[...detail.children];detail.scrollTop=143;
    const time=detail.all().find(node=>node.tag==='time');
    expect(time.textContent).toBe('2026/10/22 07:38:06 (UTC+8)');
    ui.fetch.mockResolvedValueOnce({ok:true,json:async()=>({timezone:'UTC-05:30',rooms:[{id:1,name:'general',kind:'public',message_count:1}],totals:{rooms:1,messages:1,files:0}})});
    await ui.window.MrzhChatAdmin.refreshBackground();
    expect(time.textContent).toBe('2026/10/21 18:08:06 (UTC-05:30)');
    expect(detail.children).toEqual(cards);expect(detail.scrollTop).toBe(143);
    ui.timezoneChanged('UTC+09:00');expect(time.textContent).toBe('2026/10/22 08:38:06 (UTC+9)');
  });
});

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


describe("admin general group avatar", () => {
  it("uses the shared crop dialog and sends a CSRF-protected multipart upload before updating the preview", async () => {
    const ui = setup(); ui.listeners.DOMContentLoaded();
    await ui.window.MrzhChatAdmin.load("csrf");
    ui.byId("chat-admin-general-avatar-edit").onclick();
    expect(ui.window.MrzhAvatar.open).toHaveBeenCalledOnce();
    await ui.window.MrzhAvatar.open.mock.lastCall[0](new Blob(["webp"],{type:"image/webp"}));
    const [, options] = ui.requests.find(([path])=>path.endsWith("/general/avatar"));
    expect(options.method).toBe("POST");
    expect(options.headers["X-CSRF-Token"]).toBe("csrf");
    expect(options.body.get("file").type).toBe("image/webp");
    expect(ui.byId("chat-admin-general-avatar-image").src).toBe("/api/admin/chat/general/avatar?v=test");
    expect(ui.byId("chat-admin-general-avatar-image").hidden).toBe(false);
    expect(ui.byId("chat-admin-general-avatar-fallback").hidden).toBe(true);
  });
});


describe("background member refresh", () => {
  it("patches members without replacing message cards, selection or scroll", async () => {
    const ui = setup();
    await ui.window.MrzhChatAdmin.load("csrf");
    const room = ui.byId("chat-admin-rooms").children[0];
    await room.onclick();
    const detail = ui.byId("chat-admin-detail");
    const children = [...detail.children]; detail.scrollTop = 143;
    ui.fetch.mockResolvedValueOnce({ok:true,json:async()=>({rooms:[{id:1,name:"general",kind:"public",message_count:2,members:"Alice, Renamed Bob"}],totals:{rooms:2,messages:3,files:0}})});
    await ui.window.MrzhChatAdmin.refreshBackground();
    expect(detail.querySelector(".chat-admin-members").textContent).toBe("Alice, Renamed Bob");
    expect(detail.children).toEqual(children);expect(detail.scrollTop).toBe(143);
    expect(room["aria-current"]).toBe("true");
    expect(ui.requests.filter(([path])=>path.endsWith("/messages"))).toHaveLength(1);
  });
});
