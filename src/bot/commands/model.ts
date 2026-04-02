import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { getGlobalModel, getProject, getSession, getThreadSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

const MODEL_CATALOG: Array<{ alias: string; value: string; description: string }> = [
  { alias: "sonnet", value: "sonnet", description: "Balanced default for coding" },
  { alias: "opus", value: "opus", description: "Highest reasoning quality" },
  { alias: "haiku", value: "haiku", description: "Fastest responses" },
  { alias: "claude-sonnet-4-5", value: "claude-sonnet-4-5-20250929", description: "Pinned Sonnet 4.5 model id" },
  { alias: "claude-sonnet-4", value: "claude-sonnet-4-20250514", description: "Pinned Sonnet 4 model id" },
];

export const data = new SlashCommandBuilder()
  .setName("cc-model")
  .setDescription("Choose the Claude model for this project");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const scopeId = interaction.channelId;
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const project = getProject(projectChannelId);
  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
    });
    return;
  }

  const options = [
    {
      label: L("Use CLI default", "CLI 기본 모델 사용"),
      value: "__default__",
      description: L("Reset custom model setting", "커스텀 모델 설정 초기화"),
      default: !project.model && !getThreadSession(scopeId)?.model && !getGlobalModel(),
    },
    ...MODEL_CATALOG.map((model) => ({
      label: `${model.alias} -> ${model.value}`.slice(0, 100),
      value: model.value,
      description: model.description.slice(0, 100),
      default: false,
    })),
  ].slice(0, 25);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`model-select:${projectChannelId}:${scopeId}`)
    .setPlaceholder(L("Choose a model", "모델을 선택하세요"))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const scopeModel = scopeId === projectChannelId
    ? (getSession(projectChannelId)?.model ?? null)
    : (getThreadSession(scopeId)?.model ?? null);
  const globalModel = getGlobalModel();

  const channelModelText = project.model ?? L("CLI default", "CLI 기본값");
  const sessionModelText = scopeModel ?? L("Not set", "설정 없음");
  const globalModelText = globalModel ?? L("Not set", "설정 없음");

  const info = [
    `${L("Channel model", "채널 모델")}: \`${channelModelText}\``,
    `${L("Current session model", "현재 세션 모델")}: \`${sessionModelText}\``,
    `${L("Global model", "전역 모델")}: \`${globalModelText}\``,
  ].join("\n");

  await interaction.editReply({
    content: info,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`model-reset-scope:${projectChannelId}:${scopeId}`)
          .setLabel(L("Reset session model", "세션 모델 초기화"))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("model-reset-global:_")
          .setLabel(L("Reset global model", "전역 모델 초기화"))
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}
