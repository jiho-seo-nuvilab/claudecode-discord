import fs from "node:fs";
import path from "node:path";

export interface SkillInfo {
  name: string;
  source: "codex" | "agents";
  category: "gsd" | "gstack" | "general";
}

const SKILL_SOURCES = [
  { dir: path.join(process.env.HOME ?? "", ".codex", "skills"), source: "codex" as const },
  { dir: path.join(process.env.HOME ?? "", ".agents", "skills"), source: "agents" as const },
];

export function listInstalledSkills(): SkillInfo[] {
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  for (const source of SKILL_SOURCES) {
    if (!fs.existsSync(source.dir)) continue;
    for (const entry of fs.readdirSync(source.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const lowered = name.toLowerCase();
      skills.push({
        name,
        source: source.source,
        category: lowered.startsWith("gsd-")
          ? "gsd"
          : lowered.startsWith("gstack") || lowered.startsWith("gstack-")
          ? "gstack"
          : "general",
      });
    }
  }

  return skills.sort((a, b) => {
    const priority = { gsd: 0, gstack: 1, general: 2 };
    const diff = priority[a.category] - priority[b.category];
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}

export function getSkillShortcuts(skills: string[]): string[] {
  return skills.slice(0, 8).map((skill) => {
    if (skill.startsWith("gsd-")) return `/${skill.replace(/^gsd-/, "")}`;
    if (skill.startsWith("gstack-")) return `/${skill.replace(/^gstack-/, "")}`;
    return `/${skill}`;
  });
}

export function buildSkillIntro(selectedSkills: string[]): string | null {
  if (selectedSkills.length === 0) return null;
  const shortcuts = getSkillShortcuts(selectedSkills);
  const lines = [
    `Registered skills: ${selectedSkills.map((skill) => `\`${skill}\``).join(", ")}`,
  ];
  if (shortcuts.length > 0) {
    lines.push(`Shortcuts: ${shortcuts.map((shortcut) => `\`${shortcut}\``).join(", ")}`);
  }
  return lines.join("\n");
}

export function buildDefaultOpsHint(): string {
  return [
    "Common workflows:",
    "`/cc-project add` register this channel",
    "`/cc-skills add` attach skills to this project",
    "`/cc-model` open model picker",
    "`/cc-status` see project + thread status",
    "`/cc-usage` check Claude usage",
    "`/cc-clear` clear accumulated Claude sessions",
    "GSD/GSTACK skills work best when attached before a new thread session starts.",
  ].join("\n");
}
