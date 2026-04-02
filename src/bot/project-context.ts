import type { ChatInputCommandInteraction, StringSelectMenuInteraction, ButtonInteraction, Message } from "discord.js";

export function getProjectChannelIdFromChannelLike(channel: { isThread?: () => boolean; parentId?: string | null; id?: string } | null | undefined): string | null {
  if (!channel) return null;
  if (typeof channel.isThread === "function" && channel.isThread()) {
    return channel.parentId ?? null;
  }
  return channel.id ?? null;
}

export function getProjectChannelIdFromInteraction(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction): string {
  return getProjectChannelIdFromChannelLike(interaction.channel) ?? interaction.channelId;
}

export function getScopeIdFromInteraction(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction): string {
  return interaction.channelId;
}

export function getProjectChannelIdFromMessage(message: Message): string | null {
  return getProjectChannelIdFromChannelLike(message.channel);
}
