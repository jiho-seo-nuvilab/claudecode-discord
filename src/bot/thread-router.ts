import type { TextChannel } from "discord.js";

interface PendingRootPrompt {
  channelId: string;
  prompt: string;
  authorId: string;
  sourceMessageId: string;
}

const pendingRootPrompts = new Map<string, PendingRootPrompt>();

export function setPendingRootPrompt(entry: PendingRootPrompt): void {
  pendingRootPrompts.set(entry.channelId, entry);
}

export function getPendingRootPrompt(channelId: string): PendingRootPrompt | undefined {
  return pendingRootPrompts.get(channelId);
}

export function consumePendingRootPrompt(channelId: string): PendingRootPrompt | undefined {
  const entry = pendingRootPrompts.get(channelId);
  if (entry) pendingRootPrompts.delete(channelId);
  return entry;
}

export function clearPendingRootPrompt(channelId: string): void {
  pendingRootPrompts.delete(channelId);
}

export type QueuedPromptChannel = TextChannel;
