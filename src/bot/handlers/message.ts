import { Message, TextChannel, Attachment, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from "discord.js";
import { getProject, getLatestThreadSession, getSession, getThreadSession } from "../../db/database.js";
import { isAllowedUser, checkRateLimit } from "../../security/guard.js";
import { sessionManager } from "../../claude/session-manager.js";
import { setPendingRootPrompt } from "../thread-router.js";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { L } from "../../utils/i18n.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// Dangerous executable extensions that should not be downloaded
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif",
  ".dll", ".sys", ".drv",
  ".vbs", ".vbe", ".wsf", ".wsh",
]);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB (Discord free tier limit)

export function shouldPreferFreshSession(prompt: string, hasAttachments: boolean): boolean {
  if (hasAttachments) return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;

  const shortGreeting = /^(hi|hello|hey|yo|sup|test|ping|하이|안녕|헬로|ㅎㅇ)$/i;
  if (shortGreeting.test(trimmed)) return true;

  const words = trimmed.split(/\s+/).filter(Boolean);
  return trimmed.length <= 24 && words.length <= 4;
}

export function shouldUseUltraFastMode(prompt: string, hasAttachments: boolean): boolean {
  if (hasAttachments) return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  const ultraFastPrompts = new Set([
    "hi",
    "hello",
    "hey",
    "yo",
    "sup",
    "test",
    "ping",
    "하이",
    "안녕",
    "안녕?",
    "안녕!",
    "헬로",
    "ㅎㅇ",
    "?",
    "??",
    "ping?",
    "test?",
  ]);

  return ultraFastPrompts.has(normalized);
}

export function hasStoredSessionContext(
  isThread: boolean,
  scopeId: string,
  projectChannelId: string,
): boolean {
  const session = isThread ? getThreadSession(scopeId) : getSession(projectChannelId);
  return Boolean(session?.session_id);
}

async function downloadAttachment(
  attachment: Attachment,
  projectPath: string,
): Promise<{ filePath: string; isImage: boolean } | { skipped: string } | null> {
  const ext = path.extname(attachment.name ?? "").toLowerCase();

  // Block dangerous executables
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { skipped: L(`Blocked: \`${attachment.name}\` (dangerous file type)`, `차단됨: \`${attachment.name}\` (위험한 파일 형식)`) };
  }

  // Skip files that are too large
  if (attachment.size > MAX_FILE_SIZE) {
    const sizeMB = (attachment.size / 1024 / 1024).toFixed(1);
    return { skipped: L(`Skipped: \`${attachment.name}\` (${sizeMB}MB exceeds 25MB limit)`, `건너뜀: \`${attachment.name}\` (${sizeMB}MB, 25MB 제한 초과)`) };
  }

  const uploadDir = path.join(projectPath, ".claude-uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const fileName = `${Date.now()}-${attachment.name}`;
  const filePath = path.join(uploadDir, fileName);

  try {
    const response = await fetch(attachment.url);
    if (!response.ok || !response.body) {
      return { skipped: L(`Failed to download: \`${attachment.name}\``, `다운로드 실패: \`${attachment.name}\``) };
    }

    const fileStream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);
  } catch (e) {
    console.warn(`[download] Failed to download attachment ${attachment.name}:`, e instanceof Error ? e.message : e);
    return { skipped: L(`Failed to download: \`${attachment.name}\``, `다운로드 실패: \`${attachment.name}\``) };
  }

  return { filePath, isImage: IMAGE_EXTENSIONS.has(ext) };
}

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) return;

  const isThread = message.channel.isThread();
  const projectChannelId = isThread ? message.channel.parentId : message.channelId;
  if (!projectChannelId) return;

  // Check if channel or parent channel is registered
  const project = getProject(projectChannelId);
  if (!project) return;

  // Auth check
  if (!isAllowedUser(message.author.id)) {
    await message.reply(L("You are not authorized to use this bot.", "이 봇을 사용할 권한이 없습니다."));
    return;
  }

  // Rate limit
  if (!checkRateLimit(message.author.id)) {
    await message.reply(L("Rate limit exceeded. Please wait a moment.", "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."));
    return;
  }

  // Check for pending custom text input (AskUserQuestion "직접 입력")
  const scopeId = isThread ? message.channelId : projectChannelId;
  if (sessionManager.hasPendingCustomInput(scopeId)) {
    const text = message.content.trim();
    if (text) {
      sessionManager.resolveCustomInput(scopeId, text);
      await message.react("✅");
    }
    return;
  }

  let prompt = message.content.trim();

  // Download attachments (images, documents, code files, etc.)
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const skippedMessages: string[] = [];

  for (const [, attachment] of message.attachments) {
    const result = await downloadAttachment(attachment, project.project_path);
    if (!result) continue;
    if ("skipped" in result) {
      skippedMessages.push(result.skipped);
      continue;
    }
    if (result.isImage) {
      imagePaths.push(result.filePath);
    } else {
      filePaths.push(result.filePath);
    }
  }

  if (skippedMessages.length > 0) {
    await message.reply(skippedMessages.join("\n"));
  }

  if (imagePaths.length > 0) {
    prompt += `\n\n[Attached images - use Read tool to view these files]\n${imagePaths.join("\n")}`;
  }
  if (filePaths.length > 0) {
    prompt += `\n\n[Attached files - use Read tool to read these files]\n${filePaths.join("\n")}`;
  }

  if (!prompt) return;
  const hasAttachments = imagePaths.length > 0 || filePaths.length > 0;
  const hasExistingContext = hasStoredSessionContext(isThread, scopeId, projectChannelId);
  const preferFreshSession = hasExistingContext
    ? false
    : shouldPreferFreshSession(message.content.trim(), hasAttachments);
  const preferUltraFast = hasExistingContext
    ? false
    : shouldUseUltraFastMode(message.content.trim(), hasAttachments);

  const channel = message.channel as TextChannel;

  if (!isThread) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`project-new-thread:${projectChannelId}:${message.id}`)
        .setLabel(L("New Thread", "새 스레드"))
        .setStyle(ButtonStyle.Primary),
    );

    const latestThread = getLatestThreadSession(projectChannelId);
    if (latestThread) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`project-continue-thread:${projectChannelId}:${message.id}:${latestThread.thread_id}`)
          .setLabel(L("Continue Recent", "최근 세션 이어가기"))
          .setStyle(ButtonStyle.Secondary),
      );
    }

    setPendingRootPrompt({
      channelId: projectChannelId,
      prompt,
      authorId: message.author.id,
      sourceMessageId: message.id,
    });

    await message.reply({
      content: latestThread
        ? L("Choose how to handle this topic.", "이 주제를 어떻게 처리할지 선택하세요.")
        : L("Start a new thread session for this topic.", "이 주제로 새 스레드 세션을 시작하세요."),
      components: [row],
    });
    return;
  }

  // If session is active in a thread, offer to queue the message
  if (sessionManager.isActive(scopeId)) {
    if (sessionManager.hasQueue(scopeId)) {
      await message.reply(L("⏳ A message is already waiting to be queued. Please press the button first.", "⏳ 이미 큐 추가 대기 중인 메시지가 있습니다. 버튼을 먼저 눌러주세요."));
      return;
    }
    if (sessionManager.isQueueFull(scopeId)) {
      await message.reply(L("⏳ Queue is full (max 5). Please wait for the current task to finish.", "⏳ 큐가 가득 찼습니다 (최대 5개). 현재 작업 완료를 기다려주세요."));
      return;
    }

    sessionManager.setPendingQueue(scopeId, channel, prompt, message.id);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue-yes:${scopeId}`)
        .setLabel(L("Add to Queue", "큐에 추가"))
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`queue-no:${scopeId}`)
        .setLabel(L("Cancel", "취소"))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("❌"),
    );

    await message.reply({
      content: L("⏳ A previous task is in progress. Process this automatically when done?", "⏳ 이전 작업이 진행 중입니다. 완료 후 자동으로 처리할까요?"),
      components: [row],
    });
    return;
  }

  if (message.channel.type !== ChannelType.PublicThread && message.channel.type !== ChannelType.PrivateThread) {
    return;
  }

  await sessionManager.sendMessage(channel, prompt, {
    scopeId,
    projectChannelId,
    topic: message.channel.name,
    preferFreshSession,
    preferUltraFast,
    sourceMessageId: message.id,
  });
}
