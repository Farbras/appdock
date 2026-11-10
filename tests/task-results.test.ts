import { describe, expect, it } from "vitest";
import { explainError, inResultGroup } from "../src/task-results";
import { defaultSelection, getApp } from "../src/catalog";
import { expandTasks } from "../src/queue";
const task = () => expandTasks([defaultSelection(getApp("python"))])[0];
describe("actionable errors and installation outcomes", () => {
  it.each([
    ["0x80070070", "Недостаточно свободного места"],
    ["0x800704C7", "Windows сообщила об отмене"],
    ["0x8A150011", "Проверка целостности не пройдена"],
    ["0x80072EE7", "Не удалось получить данные по сети"],
    ["0x80070652", "Другой установщик ещё работает"],
    ["WinGet не найден", "WinGet не найден"],
    ["HTTP Range не подтверждён", "Дозагрузка не подтверждена сервером"],
  ])("translates %s without losing the stage", (message, title) => {
    const t = {
      ...task(),
      status: "error" as const,
      message,
      failureStage: "installing",
    };
    expect(explainError(t).title).toBe(title);
    expect(explainError(t).stage).toBe("installing");
    expect(t.message).toBe(message);
  });
  it("does not guess an unknown diagnosis", () => {
    expect(
      explainError({ ...task(), message: "unrecognized exit 999" }).action,
    ).toContain("Причина не подтверждена");
  });
  it("separates installer success, updates and readiness", () => {
    const t = {
      ...task(),
      installationOutcome: "updated" as const,
      status: "installed" as const,
      readiness: {
        state: "action" as const,
        reason: "pip missing",
        nextStep: "repair",
        version: "3.12",
        checkedAt: 1,
        canLaunch: false,
      },
    };
    expect(inResultGroup(t, "updated")).toBe(true);
    expect(inResultGroup(t, "installed")).toBe(false);
    expect(inResultGroup(t, "attention")).toBe(true);
    expect(inResultGroup(t, "errors")).toBe(false);
  });
});
