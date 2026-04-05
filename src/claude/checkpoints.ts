import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Claude Code 세션 체크포인트 관리
 * .claude/ 디렉토리의 세션 정보를 활용해 진행 상황을 저장/복구
 */

export interface SessionCheckpoint {
  id: string;
  scopeId: string;
  projectChannelId: string;
  timestamp: number;
  description: string;
  resumeSessionId?: string;
  sessionPath?: string;
  transcriptPath?: string;
  improvements?: string[];
  status: "pending" | "applied" | "reviewed";
}

const CHECKPOINT_DIR = path.join(os.homedir(), ".claude", "discord-checkpoints");

function ensureCheckpointDir(): void {
  if (!fs.existsSync(CHECKPOINT_DIR)) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }
}

/**
 * 현재 세션의 체크포인트 생성
 */
export function createCheckpoint(
  scopeId: string,
  projectChannelId: string,
  description: string,
  sessionPath?: string,
  resumeSessionId?: string,
): SessionCheckpoint {
  ensureCheckpointDir();

  const checkpoint: SessionCheckpoint = {
    id: randomUUID(),
    scopeId,
    projectChannelId,
    timestamp: Date.now(),
    description,
    resumeSessionId,
    sessionPath,
    transcriptPath: sessionPath ? path.join(sessionPath, "transcript.md") : undefined,
    improvements: [],
    status: "pending",
  };

  const checkpointFile = path.join(CHECKPOINT_DIR, `${checkpoint.id}.json`);
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));

  return checkpoint;
}

/**
 * 마지막 체크포인트 조회
 */
export function getLastCheckpoint(scopeId: string): SessionCheckpoint | null {
  ensureCheckpointDir();

  const files = fs.readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;

  const checkpoints = files
    .map((file) => {
      try {
        const content = fs.readFileSync(path.join(CHECKPOINT_DIR, file), "utf-8");
        return JSON.parse(content) as SessionCheckpoint;
      } catch {
        return null;
      }
    })
    .filter((cp) => cp && cp.scopeId === scopeId)
    .sort((a, b) => b.timestamp - a.timestamp);

  return checkpoints.length > 0 ? checkpoints[0] : null;
}

/**
 * 체크포인트 조회
 */
export function getCheckpoint(checkpointId: string): SessionCheckpoint | null {
  ensureCheckpointDir();

  const checkpointFile = path.join(CHECKPOINT_DIR, `${checkpointId}.json`);
  if (!fs.existsSync(checkpointFile)) return null;

  try {
    const content = fs.readFileSync(checkpointFile, "utf-8");
    return JSON.parse(content) as SessionCheckpoint;
  } catch {
    return null;
  }
}

/**
 * 체크포인트 업데이트 (개선점 추가)
 */
export function addImprovements(checkpointId: string, improvements: string[]): SessionCheckpoint | null {
  const checkpoint = getCheckpoint(checkpointId);
  if (!checkpoint) return null;

  checkpoint.improvements = [...(checkpoint.improvements || []), ...improvements];
  const checkpointFile = path.join(CHECKPOINT_DIR, `${checkpointId}.json`);
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));

  return checkpoint;
}

/**
 * 체크포인트 상태 업데이트
 */
export function updateCheckpointStatus(
  checkpointId: string,
  status: "pending" | "applied" | "reviewed",
): SessionCheckpoint | null {
  const checkpoint = getCheckpoint(checkpointId);
  if (!checkpoint) return null;

  checkpoint.status = status;
  const checkpointFile = path.join(CHECKPOINT_DIR, `${checkpointId}.json`);
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));

  return checkpoint;
}

/**
 * Claude Code 세션 복구 명령 생성
 * /resume 명령으로 사용 가능
 */
export function generateResumeCommand(checkpoint: SessionCheckpoint): string {
  if (!checkpoint.sessionPath) return "";
  // Claude Code에서 세션을 복구하는 명령
  // 실제로는 클라이언트에서 /resume 명령 사용
  return `/resume ${checkpoint.sessionPath}`;
}

/**
 * 모든 체크포인트 조회
 */
export function getAllCheckpoints(scopeId?: string): SessionCheckpoint[] {
  ensureCheckpointDir();

  const files = fs.readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith(".json"));
  const checkpoints = files
    .map((file) => {
      try {
        const content = fs.readFileSync(path.join(CHECKPOINT_DIR, file), "utf-8");
        return JSON.parse(content) as SessionCheckpoint;
      } catch {
        return null;
      }
    })
    .filter((cp) => cp && (!scopeId || cp.scopeId === scopeId))
    .sort((a, b) => b.timestamp - a.timestamp);

  return checkpoints;
}

/**
 * 체크포인트 삭제
 */
export function deleteCheckpoint(checkpointId: string): boolean {
  ensureCheckpointDir();

  const checkpointFile = path.join(CHECKPOINT_DIR, `${checkpointId}.json`);
  if (!fs.existsSync(checkpointFile)) return false;

  fs.unlinkSync(checkpointFile);
  return true;
}

/**
 * 트랜스크립트 내용 조회
 */
export function getCheckpointTranscript(checkpoint: SessionCheckpoint): string {
  if (!checkpoint.transcriptPath || !fs.existsSync(checkpoint.transcriptPath)) {
    return "";
  }

  try {
    return fs.readFileSync(checkpoint.transcriptPath, "utf-8");
  } catch {
    return "";
  }
}
