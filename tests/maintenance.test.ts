import { beforeEach, afterEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { feature } from "../src/feature-api";
import { parsePreset, serializePreset } from "../src/storage";
import { migrateQueue } from "../src/queue";
import type {
  CustomApp,
  InstalledInstance,
  Plan,
  QueueState,
} from "../src/types";
beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
  });
  ipc.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
it("imports only inert custom references and preserves old preset data", () => {
  const p = parsePreset(
    JSON.stringify({
      schemaVersion: 2,
      name: "Local",
      items: [],
      customPrograms: [{ name: "Own", sha256: "a".repeat(64) }],
    }),
  );
  expect(p.customPrograms?.length).toBe(1);
  expect(JSON.parse(serializePreset(p)).customPrograms).toEqual(
    p.customPrograms,
  );
  for (const key of ["source", "path", "arguments", "command", "id"])
    expect(() =>
      parsePreset(
        JSON.stringify({
          schemaVersion: 2,
          name: "Bad",
          items: [],
          customPrograms: [
            { name: "Own", sha256: "a".repeat(64), [key]: "cmd.exe" },
          ],
        }),
      ),
    ).toThrow();
  expect(() =>
    parsePreset(JSON.stringify({ schemaVersion: 2, name: "Empty", items: [] })),
  ).toThrow();
  expect(
    parsePreset(
      JSON.stringify({
        schemaVersion: 1,
        name: "Old",
        items: [
          { appId: "git", action: "install", options: {}, extensions: [] },
        ],
      }),
    ).items[0].appId,
  ).toBe("git");
});
it("previews exact uninstall identities and all three features without IPC", async () => {
  const r = await feature<{ instances: InstalledInstance[] }>(
    "installed-instances",
    {},
    "demo",
  );
  const p = await feature<Plan>(
    "uninstall-prepare",
    { keys: r.instances.slice(0, 2).map((i) => i.key) },
    "demo",
  );
  expect(p.items).toHaveLength(2);
  expect(p.items[0].tasks[0].operation?.instance?.productCode).toBe(
    r.instances[0].productCode,
  );
  const a = await feature<CustomApp>("custom-add", {}, "demo");
  const install = await feature<Plan>(
    "custom-prepare",
    { ids: [a.id] },
    "demo",
  );
  expect(install.items[0].tasks[0].operation?.sha256).toBe(a.sha256);
  const fix = await feature<Plan>(
    "fix-prepare",
    { appId: "python", fix: "path" },
    "demo",
  );
  expect(fix.items[0].tasks[0].action).toBe("fix");
  expect(ipc).not.toHaveBeenCalled();
});
it("restores custom queue records without treating their IDs as trusted catalog entries", async () => {
  const a = await feature<CustomApp>("custom-add", {}, "demo");
  const p = await feature<Plan>("custom-prepare", { ids: [a.id] }, "demo");
  const tasks = p.items
    .flatMap((i) => i.tasks)
    .map((t) => ({ ...t, runId: "saved" }));
  const q: QueueState = {
    schemaVersion: 2,
    tasks,
    runs: [
      {
        id: "saved",
        createdAt: 1,
        mode: "demo",
        skipCurrent: true,
        parallelDownloads: 1,
        selections: tasks.map((t) => t.selection),
        outcome: "running",
      },
    ],
    currentRunId: "saved",
    mode: "demo",
    running: true,
    paused: false,
    updatedAt: 1,
  };
  const migrated = migrateQueue(q);
  expect(migrated.paused).toBe(true);
  expect(migrated.running).toBe(false);
  expect(migrated.tasks[0].operation?.sha256).toBe(a.sha256);
});
