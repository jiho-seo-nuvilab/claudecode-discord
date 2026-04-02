import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type VersionInfo = {
  appVersion: string;
  claudeCodeVersion: string;
};

let cache: VersionInfo | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function readAppVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readClaudeCodeVersion(): string {
  try {
    const out = execSync("claude --version", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = out.match(/^([0-9]+\.[0-9]+\.[0-9]+)/);
    return (m?.[1] ?? out) || "unknown";
  } catch {
    return "unknown";
  }
}

export function getVersionInfo(): VersionInfo {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  cache = {
    appVersion: readAppVersion(),
    claudeCodeVersion: readClaudeCodeVersion(),
  };
  cacheAt = now;
  return cache;
}
