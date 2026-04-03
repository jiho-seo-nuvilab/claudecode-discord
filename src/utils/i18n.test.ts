import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("i18n", () => {
  const langFile = path.join(process.cwd(), "src", ".tray-lang");

  beforeEach(() => {
    vi.resetModules();
    if (fs.existsSync(langFile)) fs.unlinkSync(langFile);
  });

  afterEach(() => {
    if (fs.existsSync(langFile)) fs.unlinkSync(langFile);
  });

  it("defaults to Korean when language file is missing", async () => {
    const { L } = await import("./i18n.js");

    expect(L("Hello", "안녕하세요")).toBe("안녕하세요");
  });

  it("uses English when language file contains en", async () => {
    fs.writeFileSync(langFile, "en", "utf-8");
    const { L } = await import("./i18n.js");

    expect(L("Hello", "안녕하세요")).toBe("Hello");
  });

  it("uses Korean when language file contains kr", async () => {
    fs.writeFileSync(langFile, "kr", "utf-8");
    const { L } = await import("./i18n.js");

    expect(L("Hello", "안녕하세요")).toBe("안녕하세요");
  });
});
