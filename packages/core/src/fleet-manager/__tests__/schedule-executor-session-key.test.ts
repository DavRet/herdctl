/**
 * ScheduleExecutor session key (vulpes-pack#355, live path).
 *
 * `runSchedule()` in scheduler/schedule-runner.ts already scopes a no-work-item
 * schedule run to `<agent>--schedule--<name>` (see
 * scheduler/__tests__/schedule-runner-session-key.test.ts) — but that function
 * has no production caller. Every real schedule trigger flows through
 * FleetManager.handleScheduleTrigger -> ScheduleExecutor.executeSchedule(),
 * which is what this test exercises: fire two schedules on the same agent
 * through a real FleetManager and confirm their session files land under
 * per-schedule keys, not the shared `<agent>.json` pointer every other
 * unscoped trigger() caller (gh-inbox, Discord's first channel message) also
 * reads from.
 */

import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeFactory } from "../../runner/index.js";
import { FleetManager } from "../fleet-manager.js";

const silentLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/** Session file names written under `<stateDir>/sessions`, sorted. */
async function sessionFiles(stateDir: string): Promise<string[]> {
  return (await readdir(join(stateDir, "sessions")).catch(() => [])).sort();
}

describe("ScheduleExecutor session key (live path)", () => {
  let tempDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(async () => {
    const base = join(
      tmpdir(),
      `herdctl-sched-exec-key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const configDir = join(base, "config");
    await mkdir(configDir, { recursive: true });
    tempDir = await realpath(base);
    stateDir = join(tempDir, ".herdctl");
    configPath = join(configDir, "herdctl.yaml");
    const yaml = await import("yaml");
    await writeFile(configPath, yaml.stringify({ version: 1, agents: [] }));

    // Mirrors scheduler/__tests__/schedule-runner-session-key.test.ts: a minimal
    // runtime stub that just yields a session_id, so JobExecutor treats the run
    // as a successful, resumable session without touching the real SDK.
    vi.spyOn(RuntimeFactory, "create").mockReturnValue({
      execute: async function* () {
        yield { type: "system" as const, subtype: "init", session_id: `sid-${Math.random()}` };
        yield { type: "assistant" as const, content: "ok" };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal runtime stub for the test
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("scopes each schedule's session to its own key instead of the shared agent-level pointer", async () => {
    const manager = new FleetManager({
      configPath,
      stateDir,
      checkInterval: 20,
      logger: silentLogger(),
    });
    await manager.initialize();

    await manager.addAgent({
      name: "worker",
      working_directory: tempDir,
      max_turns: 1,
      schedules: {
        "self-sync": { type: "interval", interval: "1h" },
        "brain-sync": { type: "interval", interval: "1h" },
      },
    });

    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await manager.stop();

    // Both schedules fired (first check always runs a never-run schedule
    // regardless of interval length — see schedule-management.test.ts) and each
    // landed in its own file. Critically, no `worker.json` — the bare
    // agent-level key every other unscoped trigger() caller shares — exists.
    expect(await sessionFiles(stateDir)).toEqual([
      "worker--schedule--brain-sync.json",
      "worker--schedule--self-sync.json",
    ]);
  });
});
