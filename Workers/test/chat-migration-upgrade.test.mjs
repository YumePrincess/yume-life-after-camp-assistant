import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../migrations/", import.meta.url);
const migrations = readdirSync(root)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const read = (name) => readFileSync(new URL(name, root), "utf8");
const patch = read("0043_retire_chat_access_log.sql");

function oldDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of migrations.filter((name) => name < "0043"))
    db.exec(read(name));
  return db;
}

describe("forward-only chat database upgrade", () => {
  it("installs all migrations on a fresh database without the retired log table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const name of migrations) db.exec(read(name));
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='chat_admin_audit'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("PRAGMA table_info(identity_codes)")
          .all()
          .some((column) => column.name === "avatar_key"),
      ).toBe(true);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='identity_web_sessions'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });
  it.each([
    true,
    false,
  ])("upgrades an existing 0042 database (log table present: %s) without changing business data", (logPresent) => {
    const db = oldDatabase();
    try {
      db.exec(`INSERT INTO identity_codes(id,code_hash,code_encrypted,player_name,password_hash,created_by,created_at,updated_at)
        VALUES('existing-identity','original-number-hash','original-encrypted-number','Original member','original-password-hash','test','2026-01-01','2026-01-01');
        INSERT INTO users(id,identity_code_id,username,display_name,password_hash,password_salt)
        VALUES(1,'existing-identity','Original member','Original member','','');
        INSERT INTO uploaded_files(object_key,owner_user_id,filename,size) VALUES('lifeafter/chat/existing-file',1,'existing.txt',123);
        INSERT INTO messages(channel_id,sender_id,content,attachment_key)
        SELECT id,1,'existing encrypted message','lifeafter/chat/existing-file' FROM channels WHERE name='general';
        INSERT INTO identity_web_sessions VALUES('existing-token-hash','existing-identity','original-number-hash','original-password-hash','2099-01-01','2026-01-01');
        UPDATE settings SET value='{"MESSAGE_RETENTION_DAYS":14}' WHERE key='chat_policy';`);
      if (logPresent)
        db.exec(
          "INSERT INTO chat_admin_audit(actor,action) VALUES('old-admin','read_messages')",
        );
      else db.exec("DROP TABLE chat_admin_audit");
      const tables = [
        "identity_codes",
        "users",
        "channels",
        "channel_members",
        "messages",
        "uploaded_files",
        "identity_web_sessions",
        "settings",
      ];
      const snapshot = () =>
        Object.fromEntries(
          tables.map((table) => [
            table,
            db.prepare(`SELECT * FROM ${table}`).all(),
          ]),
        );
      const before = snapshot();
      const schema = () =>
        db
          .prepare(
            "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name!='chat_admin_audit' ORDER BY name",
          )
          .all();
      const beforeSchema = schema();
      db.exec(patch);
      db.exec(patch); // Also safe if the table was absent or cleanup is retried.
      expect(snapshot()).toEqual(before);
      expect(schema()).toEqual(beforeSchema);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='chat_admin_audit'",
          )
          .get(),
      ).toBeUndefined();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
