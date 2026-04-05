export const DEFAULT_CODEX_MODEL = "gpt-5.4";

function joinCommand(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(" ");
}

export function resolveCodexModel(model?: string | null): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CODEX_MODEL;
}

export function buildCodexReviewCommand(
  mode: "normal" | "adversarial",
  base?: string,
  focus?: string,
  model?: string | null,
): string {
  const trimmedBase = base?.trim();
  const trimmedFocus = focus?.trim();
  const effectiveModel = resolveCodexModel(model);
  return joinCommand([
    mode === "normal" ? "/codex:review" : "/codex:adversarial-review",
    "--background",
    "--model",
    effectiveModel,
    trimmedBase ? `--base ${trimmedBase}` : null,
    trimmedFocus || null,
  ]);
}

export function buildCodexRescueCommand(task: string, model?: string | null): string {
  const trimmedTask = task.trim();
  const effectiveModel = resolveCodexModel(model);
  return joinCommand([
    "/codex:rescue",
    "--model",
    effectiveModel,
    trimmedTask,
  ]);
}

export function buildCodexStatusCommand(): string {
  return "/codex:status";
}

export function buildCodexResultCommand(): string {
  return "/codex:result";
}

export function buildCodexCancelCommand(): string {
  return "/codex:cancel";
}

export interface CodexAutoDecision {
  path: string;
  reason?: string;
  model?: string;
  next?: string;
}

export function extractCodexAutoDecision(text: string): CodexAutoDecision | null {
  const marker = "[Codex Auto Decision]";
  const start = text.indexOf(marker);
  if (start === -1) return null;

  const lines = text
    .slice(start + marker.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const readField = (name: string): string | undefined => {
    const prefix = `${name}:`;
    const line = lines.find((entry) => entry.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : undefined;
  };

  const path = readField("Path");
  if (!path) return null;

  return {
    path,
    reason: readField("Reason"),
    model: readField("Model"),
    next: readField("Next"),
  };
}

export function buildCodexAutoContinuePrompt(input: {
  description?: string | null;
  improvements?: string[];
  model?: string | null;
}): string {
  const effectiveModel = resolveCodexModel(input.model);
  const description = input.description?.trim();
  const improvements = (input.improvements ?? []).map((item) => item.trim()).filter(Boolean);

  const contextLines = [
    description ? `Latest checkpoint: ${description}` : null,
    improvements.length > 0
      ? `Latest improvements:\n- ${improvements.join("\n- ")}`
      : "Latest improvements: none explicitly recorded.",
  ].filter(Boolean);

  return [
    "[Codex Auto Continue]",
    `Use Codex autonomously with default model \`${effectiveModel}\`. Do not ask the user to choose the next Codex action.`,
    "Choose automatically among status/result/resume/rescue based on the live Codex state.",
    "Before doing anything else, explicitly report the chosen path in this format:",
    "[Codex Auto Decision]",
    "Path: <status|result|resume|rescue-background>",
    "Reason: <one sentence>",
    `Model: <${effectiveModel} or n/a>`,
    "Next: <what you will do automatically after this>",
    "1. Inspect current Codex state first.",
    "2. If there is an active Codex task, use /codex:status first. If it is complete, immediately use /codex:result and continue from the best existing task.",
    "3. If the latest relevant Codex result contains a resumable session and resuming is the best path, resume it directly with `codex resume <id>`.",
    `4. Otherwise start a new Codex rescue task with \`/codex:rescue --background --model ${effectiveModel}\` using the checkpoint context below.`,
    "5. If you start a background Codex rescue, do not stop there. Automatically follow up with status checks, then fetch the result when it completes.",
    "6. After the automatic path completes, summarize what happened and move to the next meaningful checkpoint without asking the user to choose the tool path.",
    "",
    "Checkpoint context:",
    ...contextLines,
  ].join("\n");
}
