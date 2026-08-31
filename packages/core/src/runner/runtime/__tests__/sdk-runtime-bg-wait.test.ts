/**
 * issue #458 / operator decision after job-2026-08-31-okhjlg: a one-shot
 * `execute()` run must not hand JobExecutor the terminal message (letting it
 * tear the query down) while a `run_in_background` Agent-tool subagent it
 * spawned is still live — it holds the terminal message until
 * `background_tasks_changed` reports an empty set.
 *
 * There used to be a fixed `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` ceiling
 * (default 10 min) that raced the WHOLE hold, live tasks or not. It was
 * removed: it silently killed a legitimate >10min Figma build mid-work and
 * the job still reported "success" with the stale pre-kill result. While
 * tasks are live there is now no time limit at all. The only timer left is a
 * short `DEFAULT_REINVOCATION_GRACE_MS` (15s) grace that arms once the task
 * set drains to empty, giving a follow-up turn (the SDK re-invoking with the
 * child's result) a chance to show up before the held terminal is released.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REINVOCATION_GRACE_MS } from "../../../session/session-reaper.js";

type FakeMessage = Record<string, unknown>;

// A controllable async generator standing in for the SDK's query() stream.
// The queue is fed by the test; `query()` returns the Query object itself
// (`iterable` below), which `execute()` calls `q.return()` on directly — NOT
// only the iterator `[Symbol.asyncIterator]()` returns. A mock exposing
// `return()` solely on the iterator lets `q.return()` throw (silently caught
// by execute()'s own try/catch), so `isClosed()` never flips even though the
// test looks green — hence `return()` is defined on `iterable` itself here,
// same as the real SDK's `Query` (an AsyncGenerator, callable directly).
function makeControllableStream() {
  const pending: FakeMessage[] = [];
  const waiters: Array<(msg: FakeMessage | typeof DONE) => void> = [];
  const DONE = Symbol("done");
  let closed = false;

  function push(message: FakeMessage) {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else pending.push(message);
  }

  async function doReturn(): Promise<{ done: true; value: undefined }> {
    closed = true;
    for (const w of waiters.splice(0)) w(DONE);
    return { done: true as const, value: undefined };
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (closed) return { done: true, value: undefined };
          if (pending.length > 0) return { done: false, value: pending.shift() };
          const message = await new Promise<FakeMessage | typeof DONE>((resolve) => {
            waiters.push(resolve);
          });
          if (message === DONE) return { done: true, value: undefined };
          return { done: false, value: message };
        },
        return: doReturn,
      };
    },
    return: doReturn,
  };

  return { push, iterable, isClosed: () => closed };
}

let activeStream: ReturnType<typeof makeControllableStream> | undefined;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const stream = makeControllableStream();
    activeStream = stream;
    return stream.iterable;
  }),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn(() => ({})),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedAgent } from "../../../config/index.js";
import type { SessionLifecycleSignal } from "../../../session/types.js";
import type { RuntimeExecuteOptions } from "../interface.js";
import { RACE_SETTLE_MS, SDKRuntime } from "../sdk-runtime.js";

/** Grab the Stop-hook callback `execute()` registered on its last `query()` call. */
function stopCallbackFromLastQueryCall(): (input: unknown) => Promise<unknown> {
  const lastCall = vi.mocked(query).mock.calls.at(-1)!;
  const options = (lastCall[0] as { options: Record<string, unknown> }).options;
  const hooks = options.hooks as {
    Stop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
  };
  return hooks.Stop[0].hooks[0];
}

/** Grab the PostToolUse-hook callback `execute()` registered on its last `query()` call. */
function postToolUseCallbackFromLastQueryCall(): (input: unknown) => Promise<unknown> {
  const lastCall = vi.mocked(query).mock.calls.at(-1)!;
  const options = (lastCall[0] as { options: Record<string, unknown> }).options;
  const hooks = options.hooks as {
    PostToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
  };
  return hooks.PostToolUse[0].hooks[0];
}

const agent = { name: "keeper", qualifiedName: "keeper" } as unknown as ResolvedAgent;

function baseOptions(overrides: Partial<RuntimeExecuteOptions> = {}): RuntimeExecuteOptions {
  return { prompt: "hi", agent, ...overrides };
}

/** Let the fake-timer event loop flush pending microtasks without advancing time. */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  activeStream = undefined;
  vi.useRealTimers();
});

describe("SDKRuntime.execute() background-task hold (issue #458, no ceiling — job-2026-08-31-okhjlg)", () => {
  it("releases immediately when no background task is ever reported", async () => {
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({ type: "result", subtype: "success" });

    // Still goes through the settle window (verify round 3): a run's FIRST
    // terminal always gets one, regardless of background activity — a virgin
    // first background dispatch racing that exact terminal has no prior
    // activity to gate on. Nothing shows up here, so this is
    // effectively-immediate. See the dedicated "second-and-later terminal,
    // no added tail" test below for the case that actually skips it.
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
    expect(stream.isClosed()).toBe(true);
  });

  it("holds the terminal result with NO time limit while a background task stays live", async () => {
    // Regression for job-2026-08-31-okhjlg: a legitimate long-running build
    // must never be force-closed just because it outlives some fixed window.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    // Simulate well over 10 minutes — the old ceiling's default — with the
    // task still reported live and nothing else arriving.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(seen.some((m) => m.type === "result")).toBe(false);
    expect(stream.isClosed()).toBe(false);

    // The task finally drains: releases via the reinvocation grace below,
    // not instantly — confirms the run was genuinely still open, not wedged.
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false); // grace still pending
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
    expect(stream.isClosed()).toBe(true);
  });

  it("releases the held terminal once the reinvocation grace elapses with no follow-up turn", async () => {
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    // Non-terminal messages (like the background_tasks_changed system message
    // itself) still pass straight through — only the terminal `result` is held.
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    // Drained, grace armed — not released yet.
    expect(seen.some((m) => m.type === "result")).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    // Both background_tasks_changed messages passed through as normal
    // content; the terminal result was released only once the grace elapsed.
    expect(seen.map((m) => m.type)).toEqual(["system", "system", "result"]);
    expect(stream.isClosed()).toBe(true);
  });

  it("cancels the grace and delivers the follow-up turn's own fresh terminal", async () => {
    // The case the grace exists for: a re-invocation DOES arrive within the
    // window, so the stale held terminal is superseded rather than released.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "first turn" });
    await flushMicrotasks();

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();

    // Well within the grace window, the child's re-invocation shows up.
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS / 2);
    stream.push({ type: "assistant", message: { content: [] } });
    stream.push({ type: "result", subtype: "success", result: "second turn" });
    // The fresh terminal itself goes through its own (short) ordering-race
    // settle before release — nothing else shows up, so it resolves fast.
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("second turn"); // the stale first-turn result never surfaced
    expect(stream.isClosed()).toBe(true);
  });

  it("does not release the held terminal on an unrelated activity signal", async () => {
    // Regression for a bug CodeRabbit caught on PR #459: onLifecycleSignal
    // used to overwrite liveBackgroundTasks on EVERY signal, including
    // `activity` (fired on the next assistant message, always backgroundTasks
    // []) — wiping a real pending count and releasing the terminal early.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();

    // An assistant message is what tapLifecycleStream treats as `activity` —
    // must NOT clear the held task count.
    stream.push({ type: "assistant", message: { content: [] } });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
  });

  it("does not release the held terminal on a turn_end Stop hook fired without a background_tasks snapshot", async () => {
    // Regression for the prod #459 follow-up (job-2026-08-26-6opnmq): the
    // CLI's Stop-hook payload builder is conditional and can omit
    // `background_tasks`/`session_crons` entirely for a turn, independent of
    // the SDK's own per-field `?`-optionality. `input.background_tasks ?? []`
    // used to read that omission as an authoritative "nothing pending",
    // clobbering the live count tracked from `background_tasks_changed` and
    // releasing the held terminal — killing the still-running background
    // subagent.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    // Simulate the CLI firing Stop without the background_tasks/session_crons
    // envelope at all (not even `background_tasks: undefined`).
    const stopCallback = stopCallbackFromLastQueryCall();
    await stopCallback({
      hook_event_name: "Stop",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      stop_hook_active: false,
    });
    // Force the execute() loop to re-check its release condition (it only
    // re-evaluates on the next stream message, not on the out-of-band hook
    // call itself) with a message that carries no task snapshot of its own.
    stream.push({ type: "assistant", message: { content: [] } });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
  });

  it("releases the held terminal on a turn_end Stop hook that authoritatively reports empty background_tasks", async () => {
    // Counter-check: a genuine empty snapshot (the field present, just empty)
    // must still count as a real drain (and earn the same grace) — only an
    // omitted field is a non-snapshot.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    const stopCallback = stopCallbackFromLastQueryCall();
    await stopCallback({
      hook_event_name: "Stop",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    });
    // Force the execute() loop to re-check its release condition — see the
    // no-snapshot test above for why this is needed.
    stream.push({ type: "assistant", message: { content: [] } });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
  });
});

// vulpes-pack#148 — RuntimeExecuteOptions.onLifecycleSignal was documented
// "ignored" by execute() and nothing consumed it: a job's ScheduleWakeup/
// session cron never reached anywhere and evaporated on job completion. These
// pin the composition contract a job-path consumer (SessionLifecycleManager.
// trackJob) relies on: it rides along on the same signals as the internal
// bg-wait tracker, in addition to it, never instead of it.
describe("SDKRuntime.execute() onLifecycleSignal consumer composition (vulpes-pack#148)", () => {
  it("delivers all four SessionLifecycleSignal kinds to a supplied consumer", async () => {
    const runtime = new SDKRuntime();
    const signals: SessionLifecycleSignal[] = [];
    const onLifecycleSignal = vi.fn((signal: SessionLifecycleSignal) => {
      signals.push(signal);
    });
    const drain = (async () => {
      for await (const _message of runtime.execute(baseOptions({ onLifecycleSignal }))) {
        // drain
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    await flushMicrotasks();

    stream.push({ type: "assistant", message: { content: [] } });
    await flushMicrotasks();

    const postToolUseCallback = postToolUseCallbackFromLastQueryCall();
    await postToolUseCallback({
      hook_event_name: "PostToolUse",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      tool_name: "CronDelete",
      tool_input: { id: "c1" },
      tool_response: {},
    });
    await flushMicrotasks();

    const stopCallback = stopCallbackFromLastQueryCall();
    await stopCallback({
      hook_event_name: "Stop",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [{ id: "c2", schedule: "+60s", recurring: false, prompt: "WAKE" }],
    });
    await flushMicrotasks();

    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("background_tasks_changed");
    expect(kinds).toContain("activity");
    expect(kinds).toContain("cron_deleted");
    expect(kinds).toContain("turn_end");

    const turnEnd = signals.find((s) => s.kind === "turn_end");
    expect(turnEnd?.sessionCrons).toEqual([
      { id: "c2", schedule: "+60s", recurring: false, prompt: "WAKE" },
    ]);
    const cronDeleted = signals.find((s) => s.kind === "cron_deleted");
    expect(cronDeleted?.deletedCronIds).toEqual(["c1"]);
  });

  it("holds the terminal exactly as without a consumer, and the consumer sees the same hasSnapshot: false", async () => {
    // Byte-for-byte composition check: attaching a consumer must not change
    // the #458/#459 anchor semantics at all.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const signals: SessionLifecycleSignal[] = [];
    const onLifecycleSignal = (signal: SessionLifecycleSignal) => {
      signals.push(signal);
    };
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions({ onLifecycleSignal }))) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    // A turn_end fired without the background_tasks/session_crons envelope —
    // must not clobber the live task count, even with a consumer attached.
    const stopCallback = stopCallbackFromLastQueryCall();
    await stopCallback({
      hook_event_name: "Stop",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      stop_hook_active: false,
    });
    stream.push({ type: "assistant", message: { content: [] } });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);

    // The consumer still saw the non-authoritative turn_end (hasSnapshot: false).
    const turnEnd = signals.find((s) => s.kind === "turn_end");
    expect(turnEnd?.hasSnapshot).toBe(false);
  });

  it("a throwing consumer does not break the message loop or drop messages", async () => {
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const onLifecycleSignal = vi.fn(() => {
      throw new Error("consumer boom");
    });
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions({ onLifecycleSignal }))) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "assistant", message: { content: [] } });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    // Terminal still held (the throwing consumer didn't corrupt bg-task tracking).
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    // Every non-terminal message still reached the consumer of the stream itself.
    expect(seen.map((m) => m.type)).toEqual(["system", "assistant", "system", "result"]);
    expect(onLifecycleSignal.mock.calls.length).toBeGreaterThan(0);
  });

  it("a rejecting (async) consumer does not break the message loop", async () => {
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const onLifecycleSignal = vi.fn(() => Promise.reject(new Error("consumer boom async")));
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions({ onLifecycleSignal }))) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
    expect(stream.isClosed()).toBe(true);
  });

  it("holds the terminal for a live background task AND delivers its concurrent session cron", async () => {
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const signals: SessionLifecycleSignal[] = [];
    const onLifecycleSignal = (signal: SessionLifecycleSignal) => {
      signals.push(signal);
    };
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions({ onLifecycleSignal }))) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    await flushMicrotasks();

    // Authoritative turn_end reports BOTH a live background task and a pending
    // session cron in the same snapshot.
    const stopCallback = stopCallbackFromLastQueryCall();
    await stopCallback({
      hook_event_name: "Stop",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      stop_hook_active: false,
      background_tasks: [{ id: "t1", type: "shell", status: "running", description: "server" }],
      session_crons: [{ id: "c1", schedule: "+60s", recurring: false, prompt: "WAKE" }],
    });
    stream.push({ type: "assistant", message: { content: [] } });
    await flushMicrotasks();

    // Still held — the task is live per the authoritative snapshot. No grace
    // was armed either (never drained), so a long wait changes nothing.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(seen.some((m) => m.type === "result")).toBe(false);
    const turnEnd = signals.find((s) => s.kind === "turn_end");
    expect(turnEnd?.sessionCrons).toEqual([
      { id: "c1", schedule: "+60s", recurring: false, prompt: "WAKE" },
    ]);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
  });
});

// Adversarial 13-agent review of the LZS-347/#458 rewrite (vulpes-pack#206,
// prod job-w11ho7 follow-up) found 2 blockers + 1 major before vulpes-v2
// could deploy — these pin the three fixes.
describe("SDKRuntime.execute() review follow-up (2 blockers + 1 major)", () => {
  it("BLOCKER 1: the maxHold backstop force-ends a run whose background task never reports drained", async () => {
    // A crashed (or silently-dropped-event) background child must not hold
    // the run open forever just because `liveBackgroundTasks` never sees an
    // empty `background_tasks_changed` — sessionTimeoutMs is documented as
    // not caller-threaded to this path, but there must still be SOME bound.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "held result" } as FakeMessage);
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false);

    // The task never drains, ever — advance well past DEFAULT_SESSION_TIMEOUT_MS
    // (2h) with nothing else arriving.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    await drain;

    // The stale "held result" must NEVER surface as the outcome — a forced
    // error instead, truthfully reporting the timeout.
    expect(seen.some((m) => m.type === "result" && m.result === "held result")).toBe(false);
    const errors = seen.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("MAX_HOLD_ELAPSED");
    expect(errors[0].message).toMatch(/timed out/);
    expect(stream.isClosed()).toBe(true);
  });

  it("BLOCKER 2: a reinvocation turn streaming past the reinvocation grace is not torn down", async () => {
    // The grace only bounds the GAP until a follow-up turn announces itself
    // — once it has, ordinary pass-through content (assistant/tool_use/
    // tool_result) must keep cancelling it for as long as that turn is
    // actively producing output, however long the turn itself takes.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "first turn" } as FakeMessage);
    await flushMicrotasks();

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks(); // reinvocation grace (15s) now armed

    // The re-invocation turn streams content well past the 15s grace window,
    // one chunk at a time, each arriving before the previous grace elapses —
    // each one must cancel and effectively reset the wait.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS - 1000);
      stream.push({ type: "assistant", message: { content: [`chunk ${i}`] } });
      await flushMicrotasks();
    }
    // Total elapsed by now: ~4 * 14s = 56s, well past a single 15s grace —
    // the stale first-turn result must not have been released.
    expect(seen.some((m) => m.type === "result")).toBe(false);
    expect(stream.isClosed()).toBe(false);

    // The turn finally concludes with its own terminal.
    stream.push({ type: "result", subtype: "success", result: "second turn" } as FakeMessage);
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("second turn");
    expect(stream.isClosed()).toBe(true);
  });

  it("MAJOR 3: a SECOND background task announced right after its own terminal is not orphaned (run has touched background work before)", async () => {
    // The SDK's ordering between a terminal turn's own result and a
    // background task IT dispatched is unspecified — the task's
    // `background_tasks_changed` announcement can arrive just AFTER the
    // terminal that spawned it, not before. `liveBackgroundTasks` reads
    // stale-empty at the exact moment the terminal is processed.
    //
    // Pins the `sawBackgroundActivity` disjunct of the settle-arming
    // condition specifically: a SECOND task dispatched by a re-invocation
    // turn, racing that turn's own terminal, in a run that already touched
    // background work earlier. See the test below for the `isFirstTerminal`
    // disjunct (a run's very first-ever terminal, restored in verify round 3
    // after MAJOR C briefly narrowed it away).
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    // First background task — establishes sawBackgroundActivity.
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "first turn" } as FakeMessage);
    await flushMicrotasks();
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks(); // t1 drains — reinvocation grace armed

    // The re-invocation turn arrives and, in the SAME turn, dispatches a
    // SECOND task whose announcement loses the wire race against this
    // turn's own terminal.
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS / 2);
    stream.push({ type: "result", subtype: "success", result: "second turn" } as FakeMessage);
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false); // settle window armed, not released yet

    // t2's announcement lands moments later, within the settle window.
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS / 2);
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "late-t2" }],
    });
    await flushMicrotasks();

    // Must NOT have released "second turn" over the fresh orphan — now
    // holding on the (newly known live) task exactly like any other
    // live-task case.
    expect(seen.some((m) => m.type === "result")).toBe(false);
    expect(stream.isClosed()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(seen.some((m) => m.type === "result")).toBe(false);

    // t2 eventually finishes.
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("second turn"); // not the stale "first turn"
    expect(stream.isClosed()).toBe(true);
  });

  it("MAJOR 3 (restored, verify round 3): a run's very FIRST background dispatch racing its own (first) terminal is not orphaned", async () => {
    // The exact shape of the original prod incident (job-w11ho7) this whole
    // effort started from: a fresh run's first-ever terminal, with a
    // background task it just dispatched still in flight to announce
    // itself. MAJOR C (verify round 2) briefly narrowed the settle window to
    // runs with PRIOR background activity, which silently reopened this
    // exact case — closed again in verify round 3 via `isFirstTerminal`: a
    // run's first terminal always gets the settle, regardless of history.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    // Terminal arrives FIRST — no task has ever been reported live yet.
    stream.push({ type: "result", subtype: "success", result: "spawned a child" } as FakeMessage);
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false); // settle window armed, not released yet

    // The task's announcement lands moments later, within the settle window.
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS / 2);
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "late-t1" }],
    });
    await flushMicrotasks();

    // Must NOT have released over the fresh orphan — now holding on the
    // (newly known live) task exactly like any other live-task case.
    expect(seen.some((m) => m.type === "result")).toBe(false);
    expect(stream.isClosed()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(seen.some((m) => m.type === "result")).toBe(false);

    // The child eventually finishes.
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("spawned a child");
    expect(stream.isClosed()).toBe(true);
  });
});

// Verify round on the fixes above (vulpes-pack#206) found 4 confirmed majors
// + 2 minors, 0 refuted — every finding survived adversarial check. Fix
// round 2, all in sdk-runtime.ts.
describe("SDKRuntime.execute() verify round 2 (4 majors + 2 minors)", () => {
  it("MAJOR A: an actively streaming run survives past the maxHold window — inactivity bound, not a call bound", async () => {
    // The old (round-1) maxHoldPromise was armed once before the loop and
    // never reset — a healthy, actively-streaming run got killed at exactly
    // 2h regardless of activity. It must now only measure a stretch of
    // SILENCE while holding, reset by every message.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "held" } as FakeMessage);
    await flushMicrotasks();

    // Periodic activity (the task is still reported live) every 50 minutes,
    // for a total well past the 2h DEFAULT_SESSION_TIMEOUT_MS bound. Each
    // ping arrives comfortably inside the PREVIOUS ping's own maxHold
    // window, so the inactivity clock never has a chance to elapse.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50 * 60_000);
      stream.push({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "t1" }],
      });
      await flushMicrotasks();
    }
    // Total elapsed: ~150 minutes (2.5h), past the 2h bound — still alive.
    expect(seen.some((m) => m.type === "result")).toBe(false);
    expect(stream.isClosed()).toBe(false);

    // The task finally finishes.
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("held");
    expect(stream.isClosed()).toBe(true);
  });

  it("MAJOR C (verify round 3 scope): a SECOND-and-later terminal in a run that never touches background work has no added tail", async () => {
    // A run's FIRST terminal always gets the settle window (verify round 3
    // restored that for the ordering-race case above) — MAJOR C's win is
    // narrower than "no tail ever": only a second-and-later terminal in a
    // run that has genuinely never touched background work skips it. If ANY
    // timer got armed for the SECOND terminal here, `drain` would never
    // resolve without a further `vi.advanceTimersByTimeAsync` call after it
    // — this test deliberately makes none.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    // First terminal — arms its own settle window (first-terminal exception).
    stream.push({ type: "result", subtype: "success", result: "first" } as FakeMessage);
    await flushMicrotasks();
    expect(seen.some((m) => m.type === "result")).toBe(false); // settle armed, not released yet

    // A second terminal supersedes it WITHIN that window. This run has never
    // touched background work, and this is no longer the first terminal —
    // no settle window of its own: immediate release, no added tail.
    stream.push({ type: "result", subtype: "success", result: "second" } as FakeMessage);
    await drain; // no additional timer advance — hangs here if a tail got added

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("second");
    expect(stream.isClosed()).toBe(true);
  });

  it("MAJOR D: a redundant message during a drain does not strand the hold — the grace re-arms and the job still completes", async () => {
    // A duplicate/irrelevant message (a repeated 0-task report, not a new
    // transition) arriving while a reinvocation grace is ticking must not
    // leave the hold unarmed until maxHoldPromise's multi-hour backstop —
    // it must re-arm so a genuinely complete run still finishes promptly.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "held result" } as FakeMessage);
    await flushMicrotasks();

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks(); // genuine drain — reinvocation grace (15s) armed

    // A redundant, already-0 report arrives mid-grace — not a new
    // transition, and not itself a terminal.
    await vi.advanceTimersByTimeAsync(5000);
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();

    // Must still resolve on the SHORT reinvocation grace, not maxHoldPromise's
    // 2h backstop — advancing only the REMAINDER of a (re-armed) 15s window
    // is enough.
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("held result");
    expect(stream.isClosed()).toBe(true);
  });
});

// Final verify round on the fixes above (vulpes-pack#206) found 1 blocker +
// 3 minors, 0 refuted. Round 4 — maxHold reset semantics.
describe("SDKRuntime.execute() verify round 4 (1 blocker + 3 minors)", () => {
  it("BLOCKER: a wedged child emitting only heartbeat noise does not reset the maxHold backstop — the backstop still fires with a truthful error", async () => {
    // clearMaxHold() used to run unconditionally on ANY message — a wedged
    // child that keeps emitting task_progress/task_notification heartbeats
    // (proof it's ALIVE, not that it's progressing toward drain) reset the
    // 2h backstop forever, resurrecting the exact hang BLOCKER-1
    // (job-2026-08-31-okhjlg) fixed. Heartbeats must not count as progress.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "held" } as FakeMessage);
    await flushMicrotasks();

    // The child is wedged but keeps emitting heartbeat noise every 10
    // minutes for 110 minutes — none of it real progress. If any of it reset
    // maxHold, the backstop (armed once at hold-start) would never fire.
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      stream.push({
        type: "tool_progress",
        tool_use_id: "t1",
        content: `still working... ${i}`,
      } as FakeMessage);
      await flushMicrotasks();
    }
    expect(seen.some((m) => m.type === "error")).toBe(false); // not yet — under 2h

    // Cross the 2h mark (110min so far + 15min = 125min total).
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await drain;

    const errors = seen.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("MAX_HOLD_ELAPSED");
    expect(errors[0].message).toMatch(/timed out/);
    expect(seen.some((m) => m.type === "result" && m.result === "held")).toBe(false);
    expect(stream.isClosed()).toBe(true);
  });

  it("an actively streaming turn (assistant messages) survives past the maxHold window", async () => {
    // Real progress via assistant content specifically (distinct from the
    // background_tasks_changed path already covered by the "actively
    // streaming run survives" test above) resets the backstop.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "held" } as FakeMessage);
    await flushMicrotasks();

    // Assistant content every 50 minutes, well past 2h total, with the
    // background task reported live throughout (so it never releases via
    // the grace path — only maxHold could end this, and it must not).
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50 * 60_000);
      stream.push({ type: "assistant", message: { content: [`chunk ${i}`] } } as FakeMessage);
      await flushMicrotasks();
    }
    expect(seen.some((m) => m.type === "result" || m.type === "error")).toBe(false);
    expect(stream.isClosed()).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("held");
    expect(stream.isClosed()).toBe(true);
  });

  it("MINOR 1: HERDCTL_RACE_SETTLE_MS parsing — valid, empty, non-finite, and negative overrides", async () => {
    // Verified indirectly: an invalid override falls back to RACE_SETTLE_MS
    // rather than crashing or producing a nonsensical (e.g. NaN-based) delay.
    const cases: Array<{ env: string | undefined; expectSettleMs: number }> = [
      { env: undefined, expectSettleMs: RACE_SETTLE_MS },
      { env: "", expectSettleMs: RACE_SETTLE_MS },
      { env: "not-a-number", expectSettleMs: RACE_SETTLE_MS },
      { env: "-50", expectSettleMs: RACE_SETTLE_MS },
      { env: "500", expectSettleMs: 500 },
    ];

    for (const { env, expectSettleMs } of cases) {
      if (env === undefined) {
        delete process.env.HERDCTL_RACE_SETTLE_MS;
      } else {
        process.env.HERDCTL_RACE_SETTLE_MS = env;
      }

      const runtime = new SDKRuntime();
      const seen: FakeMessage[] = [];
      const drain = (async () => {
        for await (const message of runtime.execute(baseOptions())) {
          seen.push(message);
        }
      })();

      await flushMicrotasks();
      const stream = activeStream!;
      stream.push({ type: "result", subtype: "success", result: "r" } as FakeMessage);
      await flushMicrotasks();
      expect(seen.some((m) => m.type === "result")).toBe(false); // settle armed (first terminal)

      // Just under the expected settle: still held.
      await vi.advanceTimersByTimeAsync(Math.max(expectSettleMs - 10, 0));
      expect(seen.some((m) => m.type === "result")).toBe(false);

      // At (or past) the expected settle: released.
      await vi.advanceTimersByTimeAsync(20);
      await drain;
      expect(seen.filter((m) => m.type === "result")).toHaveLength(1);

      delete process.env.HERDCTL_RACE_SETTLE_MS;
    }
  });

  it("MINOR 3: HERDCTL_MAX_HOLD_MS overrides the inactivity backstop duration", async () => {
    process.env.HERDCTL_MAX_HOLD_MS = "60000"; // 1 minute, instead of the 2h default

    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "held" } as FakeMessage);
    await flushMicrotasks();

    // Well under the overridden 1-minute bound: still held.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen.some((m) => m.type === "error")).toBe(false);

    // Past the overridden bound (nothing but silence since):
    await vi.advanceTimersByTimeAsync(31_000);
    await drain;

    const errors = seen.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("MAX_HOLD_ELAPSED");
    expect(errors[0].message).toMatch(/60000ms/);

    delete process.env.HERDCTL_MAX_HOLD_MS;
  });

  it("MINOR 1 clamp: an oversized HERDCTL_RACE_SETTLE_MS is capped at half the maxHold window", async () => {
    process.env.HERDCTL_MAX_HOLD_MS = "1000"; // 1s, so half is 500ms
    process.env.HERDCTL_RACE_SETTLE_MS = "10000"; // way more than half of maxHold

    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;
    stream.push({ type: "result", subtype: "success", result: "r" } as FakeMessage);
    await flushMicrotasks();

    // Settle should be clamped to 500ms (half of the 1s maxHold), not 10s —
    // released well before maxHold could ever fire.
    await vi.advanceTimersByTimeAsync(500);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    // Released as a normal result, not a forced MAX_HOLD_ELAPSED error —
    // proves the settle didn't invert past the backstop.
    expect(seen.some((m) => m.type === "error")).toBe(false);

    delete process.env.HERDCTL_MAX_HOLD_MS;
    delete process.env.HERDCTL_RACE_SETTLE_MS;
  });

  it("MINOR 2: a redundant message during a SHORT settle window re-arms the SAME short settle, not the long reinvocation grace", async () => {
    // A run that has touched background work before gets the settle window
    // (not the reinvocation grace) on ITS OWN second-and-later terminal too
    // (verify round 3). A redundant message mid-settle must restore that
    // same short window, not upgrade to the 15s reinvocation wait.
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await flushMicrotasks();
    const stream = activeStream!;

    // First background task, established sawBackgroundActivity, then drains.
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success", result: "first turn" } as FakeMessage);
    await flushMicrotasks();
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await flushMicrotasks(); // reinvocation grace (15s) armed

    await vi.advanceTimersByTimeAsync(DEFAULT_REINVOCATION_GRACE_MS / 2);
    stream.push({ type: "result", subtype: "success", result: "second turn" } as FakeMessage);
    await flushMicrotasks(); // this terminal's own settle window (250ms) armed — sawBackgroundActivity=true

    // A redundant message arrives mid-settle — must re-arm the SAME short
    // settle, not upgrade to the 15s reinvocation grace.
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS / 2);
    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] }); // redundant, already 0
    await flushMicrotasks();

    // If this incorrectly upgraded to the 15s grace, the run would still be
    // held here; if it correctly re-armed the short settle, advancing just
    // past another full settle window releases it.
    await vi.advanceTimersByTimeAsync(RACE_SETTLE_MS + 10);
    await drain;

    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("second turn");
    expect(stream.isClosed()).toBe(true);
  });
});
