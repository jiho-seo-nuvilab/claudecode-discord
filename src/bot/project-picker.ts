import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfig } from "../utils/config.js";

const pickerState = new Map<string, string>();

function ensureWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedCandidate;
  }
  return resolvedRoot;
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
  pickerState.set(channelId, safeDir);
  return safeDir;
}

export function getPickerDir(channelId: string): string {
  const current = pickerState.get(channelId);
  if (current) return setPickerDir(channelId, current);
  return setPickerDir(channelId, getPickerRootDir());
}

export function movePickerUp(channelId: string): string {
  const root = getPickerRootDir();
  const current = getPickerDir(channelId);
  if (path.resolve(current) === path.resolve(root)) return current;
  const parent = path.dirname(current);
  return setPickerDir(channelId, parent);
}

export function listPickerOptions(channelId: string): {
  rootDir: string;
  currentDir: string;
  options: { label: string; value: string; description: string }[];
} {
  const rootDir = getPickerRootDir();
  const currentDir = getPickerDir(channelId);
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const options = [
    {
      label: `Use this folder: ${path.basename(currentDir) || currentDir}`,
      value: ".",
      description: currentDir.slice(0, 100),
    },
    ...entries.map((entry) => {
      const full = path.join(currentDir, entry.name);
      return {
        label: entry.name.slice(0, 100),
        value: entry.name,
        description: full.slice(0, 100),
      };
    }),
  ].slice(0, 25);

  return { rootDir, currentDir, options };
}
