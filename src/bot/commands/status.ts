import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { getAllProjects, getGlobalModel, getLatestThreadSession, getSession, getThreadSessionCount } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { getUsageSummaryLine } from "./usage.js";
import { findSessionDir } from "./sessions.js";
import { getVersionInfo } from "../../utils/version.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const STATUS_EMOJI: Record<string, string> = {
  online: "🟢",
  waiting: "🟡",
  idle: "⚪",
  offline: "🔴",
};

export const data = new SlashCommandBuilder()
  .setName("cc-status")
  .setDescription("Show status of all registered project sessions");

async function getContextEstimate(projectPath: string, sessionId: string | null | undefined): Promise<string> {
  if (!sessionId) return L("n/a", "없음");
  const dir = findSessionDir(projectPath);
  if (!dir) return L("n/a", "없음");
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return L("n/a", "없음");

  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let maxInputTokens = 0;

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line) as { message?: { usage?: { input_tokens?: number } } };
      const tokens = entry?.message?.usage?.input_tokens ?? 0;
      if (tokens > maxInputTokens) maxInputTokens = tokens;
    } catch {
      // ignore malformed lines
    }
  }

  rl.close();
  stream.destroy();
  if (maxInputTokens <= 0) return L("n/a", "없음");

  // Claude models commonly support large contexts; we present this as an estimate.
  const estimatedMaxContext = 200_000;
  const pct = Math.max(1, Math.min(100, Math.round((maxInputTokens / estimatedMaxContext) * 100)));
  return `~${pct}% (${maxInputTokens.toLocaleString()} tok)`;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const projects = getAllProjects(guildId);

  if (projects.length === 0) {
    await interaction.editReply({
      content: L("No projects registered. Use `/cc-register` in a channel first.", "등록된 프로젝트가 없습니다. 먼저 채널에서 `/cc-register`를 사용하세요."),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(L("Claude Code Sessions", "Claude Code 세션"))
    .setColor(0x7c3aed)
    .setTimestamp();
  const usageSummary = await getUsageSummaryLine();
  const versions = getVersionInfo();
  embed.setDescription(
    [
      usageSummary
        ? `${L("Usage", "사용량")}: ${usageSummary}`
        : `${L("Usage", "사용량")}: ${L("unavailable", "조회 불가")}`,
      `OMC v${versions.appVersion} • Claude Code v${versions.claudeCodeVersion}`,
    ].join("\n"),
  );

  for (const project of projects) {
    const session = getSession(project.channel_id);
    const latestThread = getLatestThreadSession(project.channel_id);
    const status = session?.status ?? latestThread?.status ?? "offline";
    const emoji = STATUS_EMOJI[status] ?? "🔴";
    const lastActivity = session?.last_activity ?? latestThread?.last_activity ?? "never";
    const threadCount = getThreadSessionCount(project.channel_id);
    const globalModel = getGlobalModel();
    const effectiveModel = latestThread?.model ?? session?.model ?? project.model ?? globalModel ?? "CLI default";
    const modelSource = latestThread?.model
      ? L("session", "세션")
      : session?.model
      ? L("channel-session", "채널 세션")
      : project.model
      ? L("channel", "채널")
      : globalModel
      ? L("global", "전역")
      : L("default", "기본");
    const skills = project.skills ? project.skills.split(",").filter(Boolean).length : 0;
    const activeSessionId = latestThread?.session_id ?? session?.session_id;
    const contextEstimate = await getContextEstimate(project.project_path, activeSessionId);

    embed.addFields({
      name: `${emoji} <#${project.channel_id}>`,
      value: [
        `\`${project.project_path}\``,
        `${L("Status", "상태")}: **${status}**`,
        `${L("Auto-approve", "자동 승인")}: ${project.auto_approve ? L("On", "켜짐") : L("Off", "꺼짐")}`,
        `${L("Model", "모델")}: \`${effectiveModel}\` (${modelSource})`,
        `${L("Context", "컨텍스트")}: ${contextEstimate}`,
        `${L("Skills", "스킬")}: ${skills}`,
        `${L("Thread sessions", "스레드 세션")}: ${threadCount}`,
        `${L("Last topic", "마지막 주제")}: ${latestThread?.topic ?? L("none", "없음")}`,
        `${L("Last activity", "마지막 활동")}: ${lastActivity}`,
      ].join("\n"),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
