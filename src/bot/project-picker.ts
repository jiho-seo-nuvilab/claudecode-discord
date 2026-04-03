import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfig } from "../utils/config.js";

const PAGE_SIZE = 24;

type PickerState = {
  dir: string;
  query: string;
  page: number;
};

const pickerState = new Map<string, PickerState>();

function ensureWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedCandidate;
  }
  return resolvedRoot;
}

function getDefaultState(): PickerState {
  return { dir: getPickerRootDir(), query: "", page: 0 };
}

function getState(channelId: string): PickerState {
  const current = pickerState.get(channelId);
  if (current) return current;
  const next = getDefaultState();
  pickerState.set(channelId, next);
  return next;
}

function setState(channelId: string, next: PickerState): PickerState {
  pickerState.set(channelId, next);
  return next;
}

export function getPickerRootDir(): string {
  const config = getConfig();
  const homeGitDir = path.join(os.homedir(), "git");
  if (fs.existsSync(homeGitDir) && fs.statSync(homeGitDir).isDirectory()) return homeGitDir;
  const gitDir = path.join(config.BASE_PROJECT_DIR, "git");
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) return gitDir;
  return config.BASE_PROJECT_DIR;
}

export function setPickerDir(channelId: string, dir: string): string {
  const root = getPickerRootDir();
  const safeDir = ensureWithinRoot(root, dir);
  const state = getState(channelId);
  setState(channelId, { ...state, dir: safeDir, page: 0 });
  return safeDir;
}

export function getPickerDir(channelId: string): string {
  const current = getState(channelId).dir;
  return setPickerDir(channelId, current);
}

export function getPickerQuery(channelId: string): string {
  return getState(channelId).query;
}

export function setPickerQuery(channelId: string, query: string): string {
  const state = getState(channelId);
  setState(channelId, { ...state, query: query.trim(), page: 0 });
  return query.trim();
}

export function clearPickerQuery(channelId: string): void {
  const state = getState(channelId);
  setState(channelId, { ...state, query: "", page: 0 });
}

export function movePickerUp(channelId: string): string {
  const root = getPickerRootDir();
  const current = getPickerDir(channelId);
  if (path.resolve(current) === path.resolve(root)) return current;
  return setPickerDir(channelId, path.dirname(current));
}

export function movePickerPage(channelId: string, delta: number): number {
  const state = getState(channelId);
  const next = Math.max(0, state.page + delta);
  setState(channelId, { ...state, page: next });
  return next;
}

export function createPickerFolder(channelId: string, name: string): { ok: boolean; path?: string; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    return { ok: false, error: "invalid" };
  }

  const currentDir = getPickerDir(channelId);
  const fullPath = path.join(currentDir, trimmed);
  if (fs.existsSync(fullPath)) return { ok: false, error: "exists" };

  fs.mkdirSync(fullPath, { recursive: false });
  setPickerDir(channelId, currentDir);
  return { ok: true, path: fullPath };
}

export function listPickerOptions(channelId: string): {
  rootDir: string;
  currentDir: string;
  query: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  options: { label: string; value: string; description: string }[];
} {
  const rootDir = getPickerRootDir();
  const state = getState(channelId);
  const currentDir = getPickerDir(channelId);
  const query = state.query.toLowerCase();

  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .filter((entry) => !query || entry.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalMatches = entries.length;
  const totalPages = Math.max(1, Math.ceil(totalMatches / PAGE_SIZE));
  const safePage = Math.min(state.page, totalPages - 1);
  if (safePage !== state.page) setState(channelId, { ...state, page: safePage, dir: currentDir });
  const start = safePage * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);

  const options = [
    {
      label: `Use this folder: ${path.basename(currentDir) || currentDir}`,
      value: ".",
      description: currentDir.slice(0, 100),
    },
    ...pageEntries.map((entry) => {
      const full = path.join(currentDir, entry.name);
      return {
        label: entry.name.slice(0, 100),
        value: entry.name,
        description: full.slice(0, 100),
      };
    }),
  ];

  return {
    rootDir,
    currentDir,
    query: state.query,
    page: safePage,
    totalPages,
    totalMatches,
    options,
  };
}
