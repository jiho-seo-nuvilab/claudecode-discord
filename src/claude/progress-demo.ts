/**
 * 진행 상황 체크포인트 & 버튼 사용 예시
 *
 * 이 파일은 세션 중에 체크포인트를 생성하고
 * 4가지 버튼 (롤백, Claude 계속, Codex 자동, 리뷰)을 사용하는 방법을 보여줍니다.
 */

import { TextChannel, MessageCreateOptions } from "discord.js";
import { createCheckpoint, getLastCheckpoint } from "./checkpoints.js";
import { createProgressButtons, splitLongMessage } from "./progress-buttons.js";

/**
 * 예시 1: 세션 시작 시 첫 번째 체크포인트 생성
 */
export async function exampleCreateInitialCheckpoint(
  channel: TextChannel,
  scopeId: string,
  projectChannelId: string,
  sessionPath: string,
) {
  // 체크포인트 생성
  const checkpoint = createCheckpoint(
    scopeId,
    projectChannelId,
    "Initial checkpoint - Session started",
    sessionPath,
  );

  // 메시지 전송
  const message: MessageCreateOptions = {
    content: "✅ 세션 시작 - 진행 상황이 저장되었습니다.\n\n아래 버튼을 사용하세요:",
    components: [
      createProgressButtons({
        scopeId,
        projectChannelId,
        sessionId: checkpoint.id,
        hasCheckpoint: true,
      }),
    ],
  };

  await channel.send(message);
}

/**
 * 예시 2: 메시지가 너무 길 때 분할 및 버튼 추가
 */
export async function exampleSendLongMessageWithButtons(
  channel: TextChannel,
  scopeId: string,
  projectChannelId: string,
  sessionId: string,
  longContent: string,
) {
  // 메시지 분할
  const { messages, truncated } = splitLongMessage(longContent, 1900);

  // 모든 메시지 전송
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i];
    const isLastMessage = i === messages.length - 1;

    const messageOptions: MessageCreateOptions = {
      content:
        `📝 Part ${i + 1}/${messages.length}\n\n` +
        content +
        (truncated && isLastMessage ? "\n\n⚠️ 메시지가 길어서 여러 부분으로 나뉘었습니다." : ""),
    };

    // 마지막 메시지에만 버튼 추가
    if (isLastMessage) {
      messageOptions.components = [
        createProgressButtons({
          scopeId,
          projectChannelId,
          sessionId,
          hasCheckpoint: !!getLastCheckpoint(scopeId),
        }),
      ];
    }

    await channel.send(messageOptions);
  }
}

/**
 * 예시 3: 진행 중간중간 체크포인트 업데이트
 */
export async function exampleUpdateCheckpointWithImprovements(
  channel: TextChannel,
  scopeId: string,
  projectChannelId: string,
) {
  const checkpoint = getLastCheckpoint(scopeId);
  if (!checkpoint) return;

  // 개선점 추가
  const improvements = [
    "✅ 타입 안전성 개선",
    "✅ 에러 처리 추가",
    "✅ 테스트 커버리지 증가",
  ];

  // import { addImprovements } from "./checkpoints.js";
  // addImprovements(checkpoint.id, improvements);

  const message: MessageCreateOptions = {
    embeds: [
      {
        title: "🔧 개선점 적용됨",
        description: improvements.map((imp) => `• ${imp}`).join("\n"),
        color: 0x57f287,
        footer: { text: "개선사항을 확인하고 다음 단계로 진행하세요" },
      },
    ],
    components: [
      createProgressButtons({
        scopeId,
        projectChannelId,
        sessionId: checkpoint.id,
        hasCheckpoint: true,
      }),
    ],
  };

  await channel.send(message);
}

/**
 * 예시 4: 세션 완료 시 최종 리뷰 버튼
 */
export async function exampleSessionComplete(
  channel: TextChannel,
  scopeId: string,
  projectChannelId: string,
) {
  const checkpoint = getLastCheckpoint(scopeId);

  const message: MessageCreateOptions = {
    embeds: [
      {
        title: "✨ 세션 완료",
        description:
          checkpoint?.improvements?.length || 0 > 0
            ? `${checkpoint!.improvements!.length}개의 개선점이 적용되었습니다.`
            : "작업이 완료되었습니다.",
        color: 0x57f287,
        fields: [
          {
            name: "📌 체크포인트",
            value: checkpoint?.id || "없음",
            inline: true,
          },
          {
            name: "상태",
            value: checkpoint?.status || "unknown",
            inline: true,
          },
        ],
      },
    ],
    components: [
      createProgressButtons({
        scopeId,
        projectChannelId,
        sessionId: checkpoint?.id || "unknown",
        hasCheckpoint: !!checkpoint,
        disabled: {
          nextClaude: false, // 다시 실행 가능
          nextCodex: false, // Codex 위임 가능
          review: false, // 리뷰 가능
        },
      }),
    ],
  };

  await channel.send(message);
}

/**
 * 버튼 사용 가이드
 *
 * ↩️ 뒤로가기
 *   - 마지막 체크포인트로 복구
 *   - Claude Code에서 `/resume` 명령으로 세션 복구
 *   - 이전 작업 상태로 돌아감
 *
 * ⏭️ Claude 계속
 *   - 지금까지의 개선점을 모두 적용
 *   - 다음 단계를 Claude Code가 자동으로 진행
 *   - 세션 상태 업데이트
 *
 * 🤖 Codex 자동
 *   - 현재 Codex 상태를 먼저 확인
 *   - status/result/resume/rescue 중 적절한 경로를 자동 선택
 *   - 기본 모델 gpt-5.4로 후속 작업을 이어감
 *
 * 🔍 리뷰
 *   - Codex에 코드 리뷰 의뢰
 *   - 제안사항 자동 수집
 *   - "계속" 버튼으로 제안사항 적용 가능
 */
