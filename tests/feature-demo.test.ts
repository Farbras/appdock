import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc, isTauri: () => true }));
import {
  feature,
  backgroundDefaults,
  type BundleReport,
  type OfflineSupport,
} from "../src/feature-api";
import { apps, defaultSelection, getApp } from "../src/catalog";
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
  });
  ipc.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
it("keeps demo portability and background changes away from native IPC", async () => {
  await feature(
    "save-background",
    { ...backgroundDefaults, autostart: true },
    "demo",
  );
  expect(
    (
      await feature<{ preferences: { autostart: boolean } }>(
        "background-state",
        {},
        "demo",
      )
    ).preferences.autostart,
  ).toBe(true);
  const exported = await feature("settings-export", {}, "demo");
  const p = await feature<{ token: string }>(
    "settings-preview",
    { text: JSON.stringify(exported) },
    "demo",
  );
  await feature(
    "settings-apply",
    { token: p.token, components: ["git"] },
    "demo",
  );
  await feature("settings-restore", { backupId: "demo-backup" }, "demo");
  expect(ipc).not.toHaveBeenCalled();
});
it("does not treat demo bundles or readiness as verified system results", async () => {
  expect(
    (
      await feature<{ verified: boolean }>(
        "offline-create",
        { folder: "demo" },
        "demo",
      )
    ).verified,
  ).toBe(false);
  expect(
    await feature<{ state: string; canLaunch: boolean }>(
      "readiness",
      {},
      "demo",
    ),
  ).toMatchObject({ state: "unknown", canLaunch: false });
});
it("lists standalone offline candidates and reports exactly the chosen demo packages", async () => {
  const support = await feature<OfflineSupport[]>(
    "offline-support",
    { items: apps.map(defaultSelection) },
    "demo",
  );
  expect(support).toHaveLength(apps.length);
  expect(
    support
      .filter((row) => row.supported)
      .map((row) => row.appId)
      .sort(),
  ).toEqual(["git", "python", "vscode"]);
  expect(support.find((row) => row.appId === "word")).toMatchObject({
    supported: false,
    reason: expect.stringContaining("нет подтверждённого"),
  });
  const result = await feature<BundleReport>(
    "offline-create",
    {
      folder: "demo",
      items: [
        defaultSelection(getApp("git")),
        defaultSelection(getApp("vscode")),
      ],
    },
    "demo",
  );
  expect(result.packages.map((p) => [p.appId, p.version])).toEqual([
    ["git", "2.49.0"],
    ["vscode", "1.99.3"],
  ]);
  expect(result.verified).toBe(false);
  expect(ipc).not.toHaveBeenCalled();
});
