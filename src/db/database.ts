import Database from "better-sqlite3";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, Session, SessionStatus, ThreadSession } from "./types.js";

const DB_PATH = path.join(process.cwd(), "data.db");

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      channel_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      auto_approve INTEGER DEFAULT 0,
      model TEXT,
      skills TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT,
      status TEXT DEFAULT 'offline',
      model TEXT,
      last_activity TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS thread_sessions (
      thread_id TEXT PRIMARY KEY,
      parent_channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT,
      status TEXT DEFAULT 'offline',
      topic TEXT,
      model TEXT,
      last_activity TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const threadColumns = db.prepare("PRAGMA table_info(thread_sessions)").all() as Array<{ name: string }>;
  const hasModel = projectColumns.some((col) => col.name === "model");
  const hasSkills = projectColumns.some((col) => col.name === "skills");
  const hasSessionModel = sessionColumns.some((col) => col.name === "model");
  const hasThreadModel = threadColumns.some((col) => col.name === "model");
  if (!hasModel) db.exec("ALTER TABLE projects ADD COLUMN model TEXT");
  if (!hasSkills) db.exec("ALTER TABLE projects ADD COLUMN skills TEXT");
  if (!hasSessionModel) db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  if (!hasThreadModel) db.exec("ALTER TABLE thread_sessions ADD COLUMN model TEXT");
}

export function getDb(): Database.Database {
  return db;
}

// Project queries
export function registerProject(
  channelId: string,
  projectPath: string,
  guildId: string,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO projects (channel_id, project_path, guild_id)
    VALUES (?, ?, ?)
  `);
  stmt.run(channelId, projectPath, guildId);
}

export function unregisterProject(channelId: string): void {
  db.prepare("DELETE FROM thread_sessions WHERE parent_channel_id = ?").run(channelId);
  db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM projects WHERE channel_id = ?").run(channelId);
}

export function getProject(channelId: string): Project | undefined {
  return db
    .prepare("SELECT * FROM projects WHERE channel_id = ?")
    .get(channelId) as Project | undefined;
}

export function getAllProjects(guildId: string): Project[] {
  return db
    .prepare("SELECT * FROM projects WHERE guild_id = ?")
    .all(guildId) as Project[];
}

export function setAutoApprove(
  channelId: string,
  autoApprove: boolean,
): void {
  db.prepare("UPDATE projects SET auto_approve = ? WHERE channel_id = ?").run(
    autoApprove ? 1 : 0,
    channelId,
  );
}

export function setProjectModel(channelId: string, model: string | null): void {
  db.prepare("UPDATE projects SET model = ? WHERE channel_id = ?").run(model, channelId);
}

export function setProjectSkills(channelId: string, skills: string[]): void {
  db.prepare("UPDATE projects SET skills = ? WHERE channel_id = ?").run(skills.join(","), channelId);
}

export function getProjectSkills(channelId: string): string[] {
  const row = db.prepare("SELECT skills FROM projects WHERE channel_id = ?").get(channelId) as { skills?: string | null } | undefined;
  if (!row?.skills) return [];
  return row.skills.split(",").map((skill) => skill.trim()).filter(Boolean);
}

// Session queries
export function upsertSession(
  id: string,
  channelId: string,
  sessionId: string | null,
  status: SessionStatus,
  model?: string | null,
): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, channel_id, session_id, status, model, last_activity)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      channel_id = excluded.channel_id,
      session_id = excluded.session_id,
      status = excluded.status,
      model = COALESCE(excluded.model, sessions.model),
      last_activity = datetime('now')
  `);
  stmt.run(id, channelId, sessionId, status, model ?? null);
}

export function getSession(channelId: string): Session | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(channelId) as Session | undefined;
}

export function updateSessionStatus(
  channelId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE sessions SET status = ?, last_activity = datetime('now') WHERE channel_id = ?",
  ).run(status, channelId);
}

export function getAllSessions(guildId: string): (Session & { project_path: string })[] {
  return db
    .prepare(`
      SELECT s.*, p.project_path FROM sessions s
      JOIN projects p ON s.channel_id = p.channel_id
      WHERE p.guild_id = ?
    `)
    .all(guildId) as (Session & { project_path: string })[];
}

export function upsertThreadSession(
  threadId: string,
  parentChannelId: string,
  sessionId: string | null,
  status: SessionStatus,
  topic?: string | null,
  model?: string | null,
): void {
  const stmt = db.prepare(`
    INSERT INTO thread_sessions (thread_id, parent_channel_id, session_id, status, topic, model, last_activity)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(thread_id) DO UPDATE SET
      parent_channel_id = excluded.parent_channel_id,
      session_id = excluded.session_id,
      status = excluded.status,
      topic = COALESCE(excluded.topic, thread_sessions.topic),
      model = COALESCE(excluded.model, thread_sessions.model),
      last_activity = datetime('now')
  `);
  stmt.run(threadId, parentChannelId, sessionId, status, topic ?? null, model ?? null);
}

export function getThreadSession(threadId: string): ThreadSession | undefined {
  return db
    .prepare("SELECT * FROM thread_sessions WHERE thread_id = ?")
    .get(threadId) as ThreadSession | undefined;
}

export function updateThreadSessionStatus(
  threadId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE thread_sessions SET status = ?, last_activity = datetime('now') WHERE thread_id = ?",
  ).run(status, threadId);
}

export function getLatestThreadSession(parentChannelId: string): ThreadSession | undefined {
  return db
    .prepare(`
      SELECT * FROM thread_sessions
      WHERE parent_channel_id = ?
      ORDER BY datetime(last_activity) DESC, datetime(created_at) DESC
      LIMIT 1
    `)
    .get(parentChannelId) as ThreadSession | undefined;
}

export function getThreadSessionCount(parentChannelId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM thread_sessions WHERE parent_channel_id = ?")
    .get(parentChannelId) as { count: number };
  return row.count;
}

export function clearProjectSessions(channelId: string): void {
  db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM thread_sessions WHERE parent_channel_id = ?").run(channelId);
}

export function setGlobalModel(model: string | null): void {
  if (model === null) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run("global_model");
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('global_model', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(model);
}

export function getGlobalModel(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'global_model'").get() as { value?: string } | undefined;
  return row?.value ?? null;
}

export function setScopeModel(
  scopeId: string,
  projectChannelId: string,
  model: string | null,
): void {
  if (scopeId === projectChannelId) {
    const latest = getSession(projectChannelId);
    if (latest) {
      db.prepare("UPDATE sessions SET model = ? WHERE id = ?").run(model, latest.id);
    } else {
      upsertSession(randomUUID(), projectChannelId, null, "idle", model);
    }
    return;
  }

  const latest = getThreadSession(scopeId);
  if (latest) {
    db.prepare("UPDATE thread_sessions SET model = ? WHERE thread_id = ?").run(model, scopeId);
  } else {
    upsertThreadSession(scopeId, projectChannelId, null, "idle", null, model);
  }
}
