/**
 * Tests that trigger-fired jobs are counted against `instances.max_concurrent`.
 *
 * Before the job-slot reservation, `getRunningJobCount()` only saw schedule-fired
 * runs, so N parallel `trigger()` calls for a max_concurrent:1 agent all ran.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hold the first run open until the test releases it, so a second trigger
// genuinely overlaps with an in-flight job. Reset per test.
const gate: { release: () => void; wait: Promise<void> } = {
  release: () => {},
  wait: Promise.resolve(),
};

function resetGate(): void {
  gate.wait = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockImplementation(async function* () {
    yield { type: "system", subtype: "init", session_id: "test-session-concurrency" };
    await gate.wait;
    yield { type: "assistant", content: "done" };
  }),
}));

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrencyLimitError } from "../errors.js";
import { FleetManager } from "../fleet-manager.js";

describe("trigger() concurrency accounting", () => {
  let tempDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(async () => {
    resetGate();
    tempDir = await mkdtemp(join(tmpdir(), "fleet-trigger-concurrency-"));
    stateDir = join(tempDir, ".herdctl");
    const configDir = join(tempDir, "config");
    const agentDir = join(configDir, "agents");
    await mkdir(agentDir, { recursive: true });

    const yaml = await import("yaml");
    await writeFile(
      join(agentDir, "solo.yaml"),
      yaml.stringify({ name: "solo", instances: { max_concurrent: 1 } }),
    );
    configPath = join(configDir, "herdctl.yaml");
    await writeFile(
      configPath,
      yaml.stringify({ version: 1, agents: [{ path: "./agents/solo.yaml" }] }),
    );
  });

  afterEach(async () => {
    gate.release();
    await rm(tempDir, { recursive: true, force: true });
  });

  function createTestManager() {
    return new FleetManager({
      configPath,
      stateDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
  }

  it("rejects a second parallel trigger for a max_concurrent:1 agent", async () => {
    const manager = createTestManager();
    await manager.initialize();

    const first = manager.trigger("solo");
    // Let the first run reach the in-flight state before the second trigger.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(manager.trigger("solo")).rejects.toBeInstanceOf(ConcurrencyLimitError);

    gate.release();
    await expect(first).resolves.toMatchObject({ agentName: "solo" });
  });

  it("releases the slot after the job finishes", async () => {
    const manager = createTestManager();
    await manager.initialize();

    gate.release();
    await manager.trigger("solo");

    // Second trigger must succeed once the first one has completed.
    await expect(manager.trigger("solo")).resolves.toMatchObject({ agentName: "solo" });
  });

  it("rejects exactly one of two simultaneous triggers", async () => {
    const manager = createTestManager();
    await manager.initialize();

    // Both calls start before either awaits — the reservation, not the early
    // check, is what has to separate them.
    const both = Promise.allSettled([manager.trigger("solo"), manager.trigger("solo")]);
    setTimeout(() => gate.release(), 50);
    const outcomes = await both;

    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyLimitError);
  });

  it("sanitizes an unsafe sessionKey instead of stranding the job", async () => {
    const manager = createTestManager();
    await manager.initialize();

    gate.release();
    // Slash and hash are rejected by session storage's identifier guard; an
    // unsanitized key would throw after the job record was already created.
    const result = await manager.trigger("solo", undefined, {
      sessionKey: "jandaroscher/vulpes-pack#12",
    });

    expect(result.success).toBe(true);
    expect(await readdir(join(stateDir, "sessions"))).toEqual(["jandaroscher-vulpes-pack-12.json"]);
  });

  it("still bypasses the limit with bypassConcurrencyLimit", async () => {
    const manager = createTestManager();
    await manager.initialize();

    const first = manager.trigger("solo");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = manager.trigger("solo", undefined, { bypassConcurrencyLimit: true });
    gate.release();

    await expect(first).resolves.toMatchObject({ agentName: "solo" });
    await expect(second).resolves.toMatchObject({ agentName: "solo" });
  });
});
