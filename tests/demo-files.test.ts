import { beforeEach, afterEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it("isolates demo files and folder selection even inside native Tauri", async () => {
  const { api } = await import("../src/api");
  const initial = await api.downloads("demo");
  expect(initial.files.length).toBeGreaterThan(0);
  initial.files.length = 0;
  expect((await api.downloads("demo")).files.length).toBeGreaterThan(0);
  await api.chooseDownloads("demo");
  await expect(api.openDownloads("demo")).rejects.toThrow("виртуальная");
  const file = (await api.downloads("demo")).files[0];
  await expect(api.removeDownload(file.id, "demo", false)).rejects.toThrow(
    "Подтвердите",
  );
  await api.removeDownload(file.id, "demo", true);
  expect((await api.downloads("demo")).files).toEqual([]);
  expect(invoke).not.toHaveBeenCalled();
});
it("passes explicit live mode and confirmation to native file commands", async () => {
  const { api } = await import("../src/api");
  await expect(api.removeDownload("fixture", "live", false)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  await api.removeDownload("fixture", "live", true);
  expect(invoke).toHaveBeenCalledWith("remove_download", {
    id: "fixture",
    mode: "live",
    confirmed: true,
  });
  await api.downloads("live");
  expect(invoke).toHaveBeenCalledWith("downloads_inventory", { mode: "live" });
});
