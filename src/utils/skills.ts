import fs from "node:fs";
import path from "node:path";
import { L } from "./i18n.js";

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
    L(
      `Registered skills: ${selectedSkills.map((skill) => `\`${skill}\``).join(", ")}`,
      `등록된 스킬: ${selectedSkills.map((skill) => `\`${skill}\``).join(", ")}`,
    ),
  ];
  if (shortcuts.length > 0) {
    lines.push(L(
      `Shortcuts: ${shortcuts.map((shortcut) => `\`${shortcut}\``).join(", ")}`,
      `바로가기: ${shortcuts.map((shortcut) => `\`${shortcut}\``).join(", ")}`,
    ));
  }
  lines.push(L(
    "If the user mentions one of these skills by name without a slash, treat it as a request to use that workflow when it fits.",
    "사용자가 이 스킬 이름을 슬래시 없이 말해도, 맥락에 맞으면 해당 워크플로우 요청으로 해석하세요.",
  ));
  return lines.join("\n");
}

export function buildDefaultOpsHint(): string {
  return [
    L("Common workflows:", "자주 쓰는 워크플로우:"),
    L("`/cc-project add` register this channel", "`/cc-project add` 이 채널을 프로젝트에 등록"),
    L("`/cc-skills add` attach skills to this project", "`/cc-skills add` 이 프로젝트에 스킬 연결"),
    L("`/cc-model` open model picker", "`/cc-model` 모델 선택기 열기"),
    L("`/cc-status` see project + thread status", "`/cc-status` 프로젝트 및 스레드 상태 확인"),
    L("`/cc-usage` check Claude usage", "`/cc-usage` Claude 사용량 확인"),
    L("`/cc-clear` clear accumulated Claude sessions", "`/cc-clear` 누적 Claude 세션 정리"),
    L(
      "GSD/GSTACK skills work best when attached before a new thread session starts.",
      "GSD/GSTACK 스킬은 새 스레드 세션을 시작하기 전에 연결해두는 편이 가장 잘 동작합니다.",
    ),
  ].join("\n");
}

export function buildLocaleResponseHint(): string {
  return L(
    "Reply in English unless the user explicitly asks for another language.",
    "사용자가 다른 언어를 명시하지 않으면 한국어로 답변하세요.",
  );
}
