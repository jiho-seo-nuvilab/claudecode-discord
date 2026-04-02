export type SessionStatus = "online" | "offline" | "waiting" | "idle";

export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number; // 0 or 1
  model: string | null;
  skills: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  channel_id: string;
  session_id: string | null; // Claude Agent SDK session ID
  status: SessionStatus;
  model: string | null;
  last_activity: string | null;
  created_at: string;
}

export interface ThreadSession {
  thread_id: string;
  parent_channel_id: string;
  session_id: string | null;
  status: SessionStatus;
  topic: string | null;
  model: string | null;
  last_activity: string | null;
  created_at: string;
}
