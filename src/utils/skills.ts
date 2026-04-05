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

export function buildGlobalOpsPrompt(): string {
  return L(
    [
      "Global operating rules:",
      "- Identify user intent first before acting.",
      "- Reply in Korean by default unless the user explicitly asks for another language.",
      "- For code understanding and precise edits, prefer Serena first.",
      "- For substantial multi-step work, use gsd by default.",
      "- If GSD planning is missing, bootstrap it from the current repo state and the user's known goal.",
      "- Use gsd-new-project --auto when .planning/PROJECT.md does not exist yet.",
      "- Use gsd-new-milestone when project history exists but the current goal has no active milestone.",
      "- For task tracking, progress save, and sync, use bd by default.",
      "- bd ready shows only unblocked actionable work; open issue lists can include ledger or meta issues.",
      "- If no actionable bd issue exists for real implementation work, create or claim one first.",
      "- End every substantive response with [Reflection], [Improvement], and [Next Step Suggestion].",
    ].join("\n"),
    [
      "글로벌 운영 규칙:",
      "- 행동 전에 먼저 사용자 의도를 파악하세요.",
      "- 사용자가 다른 언어를 명시하지 않으면 기본적으로 한국어로 답변하세요.",
      "- 코드 이해와 정밀 수정은 Serena를 우선 사용하세요.",
      "- 의미 있는 다단계 작업은 gsd를 기본 사용하세요.",
      "- GSD 계획이 없으면 현재 저장소 상태와 이미 알려진 사용자 목표를 바탕으로 자동 초기화하세요.",
      "- .planning/PROJECT.md가 없으면 gsd-new-project --auto를 사용하세요.",
      "- 프로젝트 이력은 있지만 현재 목표에 대응하는 활성 마일스톤이 없으면 gsd-new-milestone을 사용하세요.",
      "- 작업 추적, 진행 저장, 동기화는 bd를 기본 사용하세요.",
      "- bd ready는 실제로 막히지 않은 작업만 보여주며, open 목록에는 ledger나 메타 이슈가 포함될 수 있습니다.",
      "- 실제 구현 작업에 대응하는 actionable bd 이슈가 없으면 먼저 생성하거나 claim하세요.",
      "- 의미 있는 응답은 마지막에 반드시 [Reflection], [Improvement], [Next Step Suggestion]을 포함하세요.",
    ].join("\n"),
  );
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
      "Default operating stack: use Serena first for code understanding, gsd for substantial multi-step execution, and bd for task state, progress save, and sync.",
      "기본 운영 스택: 코드 이해는 Serena 우선, 다단계 실행은 gsd 우선, 작업 상태/진행 저장/동기화는 bd를 기본 사용합니다.",
    ),
    L(
      "GSD/GSTACK skills work best when attached before a new thread session starts.",
      "GSD/GSTACK 스킬은 새 스레드 세션을 시작하기 전에 연결해두는 편이 가장 잘 동작합니다.",
    ),
  ].join("\n");
}

export function buildLocaleResponseHint(): string {
  return L(
    "Reply in Korean by default unless the user explicitly asks for another language.",
    "사용자가 다른 언어를 명시하지 않으면 기본적으로 한국어로 답변하세요.",
  );
}
