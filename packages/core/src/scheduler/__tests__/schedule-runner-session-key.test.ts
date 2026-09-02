/**
 * Per-work-item sessions: a schedule run that processes a work item stores its
 * session under a key derived from that item, so two items never share (and
 * pollute) one conversation. Runs without a work item are scoped per schedule
 * name instead of the bare agent-level key (vulpes-pack#355) — otherwise a
 * plain interval/cron schedule (self-sync, brain-sync, ...) writes its fresh
 * session_id into the same shared <agent.qualifiedName>.json file every other
 * unscoped trigger() caller (gh-inbox, Discord's first channel message) also
 * reads from, so the schedule run becomes an accidental donor session for an
 * unrelated dispatch to adopt.
 */

import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAgent, Schedule } from "../../config/index.js";
import { RuntimeFactory } from "../../runner/index.js";
import type { WorkItem, WorkSourceManager } from "../../work-sources/index.js";
import { runSchedule, type ScheduleRunnerLogger } from "../schedule-runner.js";

const silentLogger: ScheduleRunnerLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const agent = {
  name: "worker",
  qualifiedName: "worker",
  fleetPath: [],
} as unknown as ResolvedAgent;

const schedule = {
  type: "interval",
  interval: "1h",
  prompt: "Process this:",
  work_source: { type: "jira", project: "AI" },
} as unknown as Schedule;

function workItem(id: string): WorkItem {
  return {
    id,
    source: "jira",
    externalId: id,
    title: `Work ${id}`,
    description: "",
    labels: [],
    metadata: {},
    priority: "medium",
    url: `https://jira.example/browse/${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function managerFor(item: WorkItem | null): WorkSourceManager {
  return {
    getNextWorkItem: vi.fn(async () =>
      item
        ? { item, claimed: true, claimResult: { success: true, workItem: item } }
        : { item: null, claimed: false },
    ),
    reportOutcome: vi.fn(async () => {}),
    releaseWorkItem: vi.fn(async () => ({ success: true })),
    getAdapter: vi.fn(async () => null),
    clearCache: vi.fn(),
  } as unknown as WorkSourceManager;
}

/** Session file names written under `<stateDir>/sessions`, sorted. */
async function sessionFiles(stateDir: string): Promise<string[]> {
  return (await readdir(join(stateDir, "sessions")).catch(() => [])).sort();
}

describe("runSchedule session key", () => {
  let stateDir: string;

  beforeEach(async () => {
    const base = join(
      tmpdir(),
      `herdctl-session-key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(base, "jobs"), { recursive: true });
    await mkdir(join(base, "sessions"), { recursive: true });
    stateDir = await realpath(base);

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
    await rm(stateDir, { recursive: true, force: true });
  });

  it("gives each work item its own session file", async () => {
    for (const id of ["AI-101", "AI-102"]) {
      const result = await runSchedule({
        agent,
        scheduleName: "hourly",
        schedule,
        stateDir,
        workSourceManager: managerFor(workItem(id)),
        logger: silentLogger,
        // biome-ignore lint/suspicious/noExplicitAny: RunScheduleOptions extras are irrelevant here
      } as any);
      expect(result.success).toBe(true);
    }

    expect(await sessionFiles(stateDir)).toEqual(["worker--AI-101.json", "worker--AI-102.json"]);
  });

  it("scopes the session per schedule name when there is no work item (#355)", async () => {
    const result = await runSchedule({
      agent,
      scheduleName: "hourly",
      schedule,
      stateDir,
      workSourceManager: managerFor(null),
      logger: silentLogger,
      // biome-ignore lint/suspicious/noExplicitAny: RunScheduleOptions extras are irrelevant here
    } as any);

    expect(result.success).toBe(true);
    expect(await sessionFiles(stateDir)).toEqual(["worker--schedule--hourly.json"]);
  });

  it("keeps two differently-named no-work-item schedules isolated from each other (#355)", async () => {
    for (const scheduleName of ["self-sync", "brain-sync"]) {
      const result = await runSchedule({
        agent,
        scheduleName,
        schedule,
        stateDir,
        workSourceManager: managerFor(null),
        logger: silentLogger,
        // biome-ignore lint/suspicious/noExplicitAny: RunScheduleOptions extras are irrelevant here
      } as any);
      expect(result.success).toBe(true);
    }

    expect(await sessionFiles(stateDir)).toEqual([
      "worker--schedule--brain-sync.json",
      "worker--schedule--self-sync.json",
    ]);
  });
});
