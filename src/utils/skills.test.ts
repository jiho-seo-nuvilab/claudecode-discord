import { beforeEach, describe, expect, it, vi } from "vitest";

const { LMock } = vi.hoisted(() => ({
  LMock: vi.fn((en: string, _kr: string) => en),
}));

vi.mock("./i18n.js", () => ({
  L: LMock,
}));

import { buildDefaultOpsHint, buildGlobalOpsPrompt, buildLocaleResponseHint, buildSkillIntro } from "./skills.js";

describe("skills helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LMock.mockImplementation((en: string, _kr: string) => en);
  });

  it("buildSkillIntro mentions bare skill names as workflow hints", () => {
    const text = buildSkillIntro(["ralph", "ultrawork"]);

    expect(text).toContain("Registered skills:");
    expect(text).toContain("`/ralph`");
    expect(text).toContain("without a slash");
  });

  it("buildDefaultOpsHint is localized through i18n", () => {
    LMock.mockImplementation((_en: string, kr: string) => kr);

    const text = buildDefaultOpsHint();

    expect(text).toContain("자주 쓰는 워크플로우:");
    expect(text).toContain("이 채널을 프로젝트에 등록");
  });

  it("buildGlobalOpsPrompt contains integrated workflow rules", () => {
    LMock.mockImplementation((_en: string, kr: string) => kr);

    const text = buildGlobalOpsPrompt();

    expect(text).toContain("글로벌 운영 규칙:");
    expect(text).toContain("사용자 의도");
    expect(text).toContain("Serena");
    expect(text).toContain("gsd");
    expect(text).toContain("bd");
    expect(text).toContain("[Reflection]");
  });

  it("buildLocaleResponseHint follows current language", () => {
    LMock.mockImplementation((_en: string, kr: string) => kr);

    expect(buildLocaleResponseHint()).toBe(
      "사용자가 다른 언어를 명시하지 않으면 기본적으로 한국어로 답변하세요.",
    );
  });
});
