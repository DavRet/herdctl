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

    // Still goes through the ordering-race settle window (RACE_SETTLE_MS) —
    // nothing shows up, so this is effectively-immediate, same as before.
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

  it("MAJOR 3: a background task announced right after its own terminal is not orphaned", async () => {
    // The SDK's ordering between a terminal turn's own result and a
    // background task IT dispatched is unspecified — the task's
    // `background_tasks_changed` announcement can arrive just AFTER the
    // terminal that spawned it, not before. `liveBackgroundTasks` reads
    // stale-empty at the exact moment the terminal is processed.
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
