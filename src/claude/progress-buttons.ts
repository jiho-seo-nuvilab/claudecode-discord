import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type InteractionUpdateOptions } from "discord.js";
import { L } from "../utils/i18n.js";
import { DEFAULT_CODEX_MODEL } from "../utils/codex.js";
import type { SessionCheckpoint } from "./checkpoints.js";

/**
 * 4가지 진행 버튼을 생성하는 헬퍼 함수
 * ↩️  뒤로가기 - 마지막 체크포인트로 복구
 * ⏭️  Claude 계속 - 개선점 반영 후 Claude Code로 자동 진행
 * 🤖  Codex 자동 - 같은 체크포인트를 기준으로 Codex가 상태를 보고 자동 판단
 * 🔍 리뷰 - Codex 리뷰 의뢰
 */

export interface ProgressButtonsOptions {
  checkpointId: string;
  hasCheckpoint?: boolean;
  disabled?: {
    back?: boolean;
    nextClaude?: boolean;
    nextCodex?: boolean;
    review?: boolean;
  };
}

/**
 * 4가지 진행 버튼 생성
 */
export function createProgressButtons(options: ProgressButtonsOptions): ActionRowBuilder<ButtonBuilder> {
  const hasCheckpoint = options.hasCheckpoint ?? true;
  const checkpointId = options.checkpointId;

  const backButton = new ButtonBuilder()
    .setCustomId(`progress-back:${checkpointId}`)
    .setEmoji("↩️")
    .setStyle(ButtonStyle.Secondary)
    .setLabel(L("Rollback", "롤백"))
    .setDisabled(options.disabled?.back ?? !hasCheckpoint);

  const nextClaudeButton = new ButtonBuilder()
    .setCustomId(`progress-next-claude:${checkpointId}`)
    .setEmoji("⏭️")
    .setStyle(ButtonStyle.Success)
    .setLabel(L("Claude Continue", "Claude 계속"))
    .setDisabled(options.disabled?.nextClaude ?? false);

  const nextCodexButton = new ButtonBuilder()
    .setCustomId(`progress-next-codex:${checkpointId}`)
    .setEmoji("🤖")
    .setStyle(ButtonStyle.Primary)
    .setLabel(L(`Codex Auto (${DEFAULT_CODEX_MODEL})`, `Codex 자동 (${DEFAULT_CODEX_MODEL})`))
    .setDisabled(options.disabled?.nextCodex ?? false);

  const reviewButton = new ButtonBuilder()
    .setCustomId(`progress-review:${checkpointId}`)
    .setEmoji("🔍")
    .setStyle(ButtonStyle.Primary)
    .setLabel(L("Review", "리뷰"))
    .setDisabled(options.disabled?.review ?? false);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(backButton, nextClaudeButton, nextCodexButton, reviewButton);
}

export function createReviewModeControls(
  checkpointId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`progress-review-normal:${checkpointId}`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔍")
      .setLabel(L("Normal Review", "일반 리뷰")),
    new ButtonBuilder()
      .setCustomId(`progress-review-adversarial:${checkpointId}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🧪")
      .setLabel(L("Adversarial Review", "Adversarial 리뷰")),
  );
}

export function createCodexContinueControls(
  checkpointId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`progress-codex-rescue:${checkpointId}`)
      .setStyle(ButtonStyle.Success)
      .setEmoji("🤖")
      .setLabel(L("Rescue", "Rescue")),
    new ButtonBuilder()
      .setCustomId(`progress-codex-status:${checkpointId}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📊")
      .setLabel(L("Status", "Status")),
    new ButtonBuilder()
      .setCustomId(`progress-codex-result:${checkpointId}`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji("📄")
      .setLabel(L("Result", "Result")),
    new ButtonBuilder()
      .setCustomId(`progress-codex-cancel:${checkpointId}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🛑")
      .setLabel(L("Cancel", "Cancel")),
  );
}

/**
 * 메시지가 너무 길 때 나누기 (Discord 5000 문자 제한)
 */
export function splitLongMessage(
  content: string,
  maxLength: number = 5000,
): { messages: string[]; truncated: boolean } {
  if (content.length <= maxLength) {
    return { messages: [content], truncated: false };
  }

  const messages: string[] = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    // 마지막 줄바꿈을 기준으로 자르기
    let splitPoint = maxLength;
    const lastNewline = remaining.lastIndexOf("\n", maxLength);
    if (lastNewline > maxLength * 0.8) {
      // 80% 이상 떨어진 곳에 줄바꿈이 있으면 사용
      splitPoint = lastNewline;
    }

    messages.push(remaining.substring(0, splitPoint));
    remaining = remaining.substring(splitPoint).trimStart();
  }

  if (remaining.length > 0) {
    messages.push(remaining);
  }

  return { messages, truncated: true };
}

/**
 * 진행 상황 임베드 생성 (체크포인트 정보 포함)
 */
export function createProgressEmbed(checkpoint: SessionCheckpoint | null): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(checkpoint ? 0x57f287 : 0x5865f2) // 초록색 (체크포인트 있음) 또는 파랑색
    .setTitle(
      checkpoint ? L("Progress Checkpoint", "진행 상황 체크포인트") : L("Session Started", "세션 시작"),
    );

  if (checkpoint) {
    embed
      .addFields({
        name: L("Description", "설명"),
        value: checkpoint.description,
        inline: false,
      })
      .addFields({
        name: L("Status", "상태"),
        value: checkpoint.status === "pending"
          ? "⏳ " + L("Pending", "대기 중")
          : checkpoint.status === "applied"
            ? "✅ " + L("Applied", "적용됨")
            : "🔍 " + L("Reviewed", "리뷰됨"),
        inline: true,
      })
      .addFields({
        name: L("Improvements", "개선점"),
        value: checkpoint.improvements && checkpoint.improvements.length > 0
          ? checkpoint.improvements.map((imp) => `• ${imp}`).join("\n")
          : L("None", "없음"),
        inline: false,
      })
      .setFooter({
        text: new Date(checkpoint.timestamp).toLocaleString(),
      });
  }

  return embed;
}

/**
 * 돌아가기/계속/리뷰 상태 메시지 생성
 */
export function createProgressStatusMessage(
  scopeId: string,
  action: "back" | "next" | "review",
  checkpoint: SessionCheckpoint | null,
): InteractionUpdateOptions {
  let content = "";
  let embeds = [createProgressEmbed(checkpoint)];

  switch (action) {
    case "back":
      if (!checkpoint) {
        content = L("No checkpoint to restore.", "복구할 체크포인트가 없습니다.");
        break;
      }
      content = L(
        `Restoring to checkpoint: ${checkpoint.description}`,
        `체크포인트로 복구 중: ${checkpoint.description}`,
      );
      content += `\n\n📌 \`/resume\` ` + L("command to continue in Claude Code.", "명령으로 Claude Code에서 계속하세요.");
      break;

    case "next":
      if (!checkpoint) {
        content = L("Starting new session with improvements...", "개선점을 반영하여 새 세션 시작 중...");
        break;
      }
      content = L(
        `Applying ${checkpoint.improvements?.length || 0} improvements and continuing...`,
        `${checkpoint.improvements?.length || 0}개의 개선점을 적용하고 계속 진행 중...`,
      );
      content += `\n\n⏳ ` + L("This may take a moment.", "조금 기다려주세요.");
      break;

    case "review":
      content = L(
        "Requesting Codex review and preparing improvements...",
        "Codex 리뷰 의뢰 및 개선점 준비 중...",
      );
      content += `\n\n🔍 ` + L("Code review suggestions will be applied in the next step.", "코드 리뷰 제안사항이 다음 단계에서 적용됩니다.");
      break;
  }

  return {
    content,
    embeds,
    components: [],
  };
}

/**
 * 메시지 길이 경고 표시
 */
export function createLongMessageWarning(
  originalLength: number,
  maxLength: number = 5000,
): string {
  const warning = L(
    `⚠️ Message was too long (${originalLength} chars) and split into multiple parts.`,
    `⚠️ 메시지가 너무 길어서 (${originalLength}자) 여러 부분으로 나뉘었습니다.`,
  );
  return warning;
}
