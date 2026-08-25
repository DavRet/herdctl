/**
 * Tests for the in-process extension seam: onFleetManagerStarted.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager, onFleetManagerStarted } from "../fleet-manager.js";

describe("onFleetManagerStarted", () => {
  let tempDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fleet-started-hook-"));
    const configDir = join(tempDir, "config");
    stateDir = join(tempDir, ".herdctl");
    await mkdir(join(configDir, "agents"), { recursive: true });

    const yaml = await import("yaml");
    await writeFile(
      join(configDir, "agents", "hooked.yaml"),
      yaml.stringify({ name: "hooked", description: "Hook test agent" }),
    );
    configPath = join(configDir, "herdctl.yaml");
    await writeFile(
      configPath,
      yaml.stringify({
        version: 1,
        fleet: { name: "test-fleet" },
        agents: [{ path: "./agents/hooked.yaml" }],
      }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startManager() {
    const manager = new FleetManager({
      configPath,
      stateDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await manager.initialize();
    await manager.start();
    return manager;
  }

  it("calls every callback with the started instance", async () => {
    const seen: unknown[] = [];
    onFleetManagerStarted((fm) => seen.push(fm));
    onFleetManagerStarted((fm) => seen.push(fm));

    const manager = await startManager();

    expect(seen).toEqual([manager, manager]);
    expect(manager.getStatus()).toBe("running");
    await manager.stop();
  });

  it("does not fire on initialize() alone — only the daemon's start()", async () => {
    const callback = vi.fn();
    onFleetManagerStarted(callback);

    const manager = new FleetManager({
      configPath,
      stateDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await manager.initialize();

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires at most once per instance across stop/start", async () => {
    const callback = vi.fn();
    onFleetManagerStarted(callback);

    const manager = await startManager();
    await manager.stop();
    // A stopped fleet has to be re-initialized before it can start again.
    await manager.initialize();
    await manager.start();

    expect(callback).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("keeps starting when a callback throws", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const afterThrower = vi.fn();
    onFleetManagerStarted(() => {
      throw new Error("extension exploded");
    });
    onFleetManagerStarted(afterThrower);

    const manager = await startManager();

    expect(manager.getStatus()).toBe("running");
    // The throwing callback must not swallow the ones registered after it.
    expect(afterThrower).toHaveBeenCalledWith(manager);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("onFleetManagerStarted callback failed"),
    );

    stderr.mockRestore();
    await manager.stop();
  });
});
