/**
 * issue #458: a one-shot `execute()` run must not hand JobExecutor the
 * terminal message (letting it tear the query down) while a
 * `run_in_background` Agent-tool subagent it spawned is still live — it
 * should hold the terminal message until `background_tasks_changed` reports
 * an empty set, capped by `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type FakeMessage = Record<string, unknown>;

// A controllable async generator standing in for the SDK's query() stream.
// The queue is fed by the test; `query()` returns an object whose
// `[Symbol.asyncIterator]` walks it, and whose `return()` marks it closed
// (mirrors the real SDK Query handle `execute()` calls on the way out).
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
        async return() {
          closed = true;
          for (const w of waiters.splice(0)) w(DONE);
          return { done: true, value: undefined };
        },
      };
    },
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

import type { ResolvedAgent } from "../../../config/index.js";
import type { RuntimeExecuteOptions } from "../interface.js";
import { SDKRuntime } from "../sdk-runtime.js";

const agent = { name: "keeper", qualifiedName: "keeper" } as unknown as ResolvedAgent;

function baseOptions(overrides: Partial<RuntimeExecuteOptions> = {}): RuntimeExecuteOptions {
  return { prompt: "hi", agent, ...overrides };
}

afterEach(() => {
  activeStream = undefined;
  delete process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
});

describe("SDKRuntime.execute() background-task hold (issue #458)", () => {
  it("holds the terminal result until background_tasks_changed reports empty", async () => {
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    // Let execute() start and register its iterator.
    await new Promise((r) => setTimeout(r, 0));
    const stream = activeStream!;

    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });

    // Give the loop a couple of ticks to process both messages.
    await new Promise((r) => setTimeout(r, 10));
    // Non-terminal messages (like the background_tasks_changed system message
    // itself) still pass straight through — only the terminal `result` is held.
    expect(seen.some((m) => m.type === "result")).toBe(false);

    stream.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await drain;

    // Both background_tasks_changed messages passed through as normal
    // content; the terminal result was released only once tasks drained.
    expect(seen.map((m) => m.type)).toEqual(["system", "system", "result"]);
  });

  it("does not hold the terminal result when ceiling is 0", async () => {
    process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "0";
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await new Promise((r) => setTimeout(r, 0));
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });

    await drain;
    expect(seen.filter((m) => m.type === "result")).toHaveLength(1);
  });

  it("gives up and yields the terminal once the ceiling elapses", async () => {
    process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "20";
    const runtime = new SDKRuntime();
    const seen: FakeMessage[] = [];
    const drain = (async () => {
      for await (const message of runtime.execute(baseOptions())) {
        seen.push(message);
      }
    })();

    await new Promise((r) => setTimeout(r, 0));
    const stream = activeStream!;
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t1" }],
    });
    stream.push({ type: "result", subtype: "success" });
    // Background task never drains — no further push.

    await drain; // resolves once the 20ms ceiling fires
    const results = seen.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
  });
});
