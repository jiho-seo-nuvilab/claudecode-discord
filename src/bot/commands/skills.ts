import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getProject, getProjectSkills, setProjectSkills } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { listInstalledSkills, type SkillInfo } from "../../utils/skills.js";
import { getProjectChannelIdFromInteraction } from "../project-context.js";

function getSkillChoices() {
  return listInstalledSkills().map((skill) => ({
    name: `${skill.name} [${skill.category}]`,
    value: skill.name,
  }));
}

function filterByCategory(skills: SkillInfo[], category: string): SkillInfo[] {
  if (category === "all") return skills;
  return skills.filter((skill) => skill.category === category);
}

export const data = new SlashCommandBuilder()
  .setName("cc-skills")
  .setDescription("Manage skills attached to this project")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Attach a skill to this project")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Installed skill name")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove an attached skill")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Attached skill name")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("List attached skills"))
  .addSubcommand((sub) => sub.setName("clear").setDescription("Remove all attached skills"))
  .addSubcommand((sub) =>
    sub
      .setName("browse")
      .setDescription("Browse installed skills by category and pick via menu")
      .addStringOption((opt) =>
        opt
          .setName("category")
          .setDescription("Skill category")
          .setRequired(true)
          .addChoices(
            { name: "all", value: "all" },
            { name: "gsd", value: "gsd" },
            { name: "gstack", value: "gstack" },
            { name: "general", value: "general" },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Add or remove selected skills")
          .setRequired(true)
          .addChoices(
            { name: "add", value: "add" },
            { name: "remove", value: "remove" },
          ),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const project = getProject(projectChannelId);
  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const current = getProjectSkills(projectChannelId);

  if (subcommand === "list") {
    await interaction.editReply({
      content: current.length > 0
        ? L(`Attached skills: ${current.map((skill) => `\`${skill}\``).join(", ")}`, `연결된 스킬: ${current.map((skill) => `\`${skill}\``).join(", ")}`)
        : L("No skills attached to this project yet.", "아직 이 프로젝트에 연결된 스킬이 없습니다."),
    });
    return;
  }

  if (subcommand === "clear") {
    setProjectSkills(projectChannelId, []);
    await interaction.editReply({
      content: L("Cleared all attached skills for this project.", "이 프로젝트에 연결된 모든 스킬을 제거했습니다."),
    });
    return;
  }

  if (subcommand === "browse") {
    const category = interaction.options.getString("category", true);
    const mode = interaction.options.getString("mode", true);
    const all = listInstalledSkills();
    const filtered = filterByCategory(all, category)
      .slice(0, 25)
      .map((skill) => ({
        label: skill.name.slice(0, 100),
        value: skill.name,
        description: `${skill.category} / ${skill.source}`.slice(0, 100),
      }));

    if (filtered.length === 0) {
      await interaction.editReply({
        content: L("No installed skills found for that category.", "해당 카테고리에 설치된 스킬이 없습니다."),
      });
      return;
    }

    await interaction.editReply({
      content: L(
        `Select skills to ${mode} (${category}).`,
        `${category} 카테고리에서 ${mode === "add" ? "추가" : "제거"}할 스킬을 선택하세요.`,
      ),
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `skills-select:${mode}:${projectChannelId}`,
              placeholder: L("Choose one or more skills", "스킬을 하나 이상 선택하세요"),
              min_values: 1,
              max_values: Math.min(filtered.length, 10),
              options: filtered,
            },
          ],
        },
      ],
    });
    return;
  }

  const skillName = interaction.options.getString("name", true);
  if (subcommand === "add") {
    const next = Array.from(new Set([...current, skillName]));
    setProjectSkills(projectChannelId, next);
    await interaction.editReply({
      content: L(`Added skill \`${skillName}\`.`, `스킬 \`${skillName}\`을(를) 추가했습니다.`),
    });
    return;
  }

  const next = current.filter((skill) => skill !== skillName);
  setProjectSkills(projectChannelId, next);
  await interaction.editReply({
    content: L(`Removed skill \`${skillName}\`.`, `스킬 \`${skillName}\`을(를) 제거했습니다.`),
  });
}

export async function autocomplete(interaction: any): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const focused = String(interaction.options.getFocused() ?? "").toLowerCase();
  const projectChannelId = getProjectChannelIdFromInteraction(interaction);
  const current = getProjectSkills(projectChannelId);
  const choices = subcommand === "remove"
    ? current.map((skill) => ({ name: skill, value: skill }))
    : getSkillChoices();

  const filtered = choices
    .filter((choice) => choice.name.toLowerCase().includes(focused) || choice.value.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(filtered);
}
