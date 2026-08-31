/**
 * SDK Runtime implementation
 *
 * Wraps the Claude Agent SDK behind the RuntimeInterface, providing
 * a unified execution interface for the SDK backend.
 *
 * This adapter delegates to the SDK's query() function and converts
 * agent configuration to SDK options using the existing toSDKOptions adapter.
 */

import {
  type BackgroundTaskSummary,
  createSdkMcpServer,
  query,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildLifecycleHooks, tapLifecycleStream } from "../../session/session-hooks.js";
import { DEFAULT_REINVOCATION_GRACE_MS } from "../../session/session-reaper.js";
import type { SessionLifecycleSignal } from "../../session/types.js";
import { isTerminalMessage } from "../message-processor.js";
import { toSDKOptions } from "../sdk-adapter.js";
import {
  DEFAULT_SESSION_TIMEOUT_MS,
  type InjectedMcpServerDef,
  type SDKMessage,
} from "../types.js";
import { withClaudeConfigDir } from "./claude-config-dir.js";
import { defaultClaudeHome } from "./cli-session-path.js";
import type { RuntimeExecuteOptions, RuntimeInterface, RuntimeSession } from "./interface.js";
import { MessageQueue } from "./message-queue.js";

/**
 * Sentinel distinguishing "a grace elapsed" from a real message in the
 * `Promise.race` below. Shared by both grace kinds `armGrace` can arm — the
 * action on elapse (release whatever terminal is held) is identical either
 * way:
 *
 * - The **reinvocation grace** (`DEFAULT_REINVOCATION_GRACE_MS`, ~15s): once
 *   `background_tasks_changed` reports the set drained to empty, a one-shot
 *   query() gets no re-invocation turn of its own the way a persistent
 *   openSession() session does — this gives a follow-up turn (the SDK
 *   handing back the child's result) the same window `SessionReaper` gives a
 *   re-invocation before reaping (session-reaper.ts) to show up before
 *   releasing the held terminal.
 * - The **ordering-race settle** (`RACE_SETTLE_MS`, far shorter): a
 *   background task dispatched IN the terminal turn itself can lose the wire
 *   race against that turn's own terminal message — the SDK's ordering
 *   between the two is unspecified (vulpes-pack#206 follow-up, prod). A
 *   fresh terminal reporting zero known live tasks gets this brief settle
 *   before being trusted as a genuine clean end, so the task's own
 *   just-behind announcement has a chance to land and flip
 *   `liveBackgroundTasks` non-empty first.
 *
 * Either grace is cancelled by ANY subsequent message (see the top of the
 * loop below) — SessionReaper's own "activity cancels the pending reap"
 * contract: ordinary pass-through content (assistant/tool_use/tool_result)
 * from an actual re-invocation must not let its own grace time out from
 * under it just because that content isn't itself a fresh terminal or a
 * background_tasks_changed report. Cancelling does not mean "done" — it
 * means "keep holding unconditionally" until a fresh terminal supersedes the
 * stale one, or a later drain re-arms a fresh grace.
 *
 * There used to be a single fixed ceiling here
 * (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, default 10 min) that raced the
 * WHOLE hold, live tasks or not — removed after job-2026-08-31-okhjlg: it
 * killed a legitimate >10min Figma build mid-work and the job still reported
 * "success" with the stale pre-kill result (see job-executor.ts's
 * `endedWithLiveBackgroundTasks` for the truthful-close half of that fix).
 * While tasks are live there is still no time limit tied to THIS mechanism —
 * only `maxHoldPromise` below (a much longer, absolute last-resort backstop)
 * bounds that case.
 */
const REINVOCATION_GRACE_ELAPSED = Symbol("reinvocation-grace-elapsed");

/**
 * Default settle window for the terminal-vs-background_tasks_changed
 * ordering race (see {@link REINVOCATION_GRACE_ELAPSED} above). Deliberately
 * far shorter than the reinvocation grace — this isn't waiting for a turn to
 * happen, just for an already-in-flight event to land.
 *
 * Probabilistic, not a guarantee (#206 review MINOR 1): 250ms comfortably
 * covers same-process/same-tick delivery jitter, but subprocess spawn or IPC
 * latency on a loaded host could exceed it, in which case the race is still
 * lost and the task is (truthfully, per MAJOR B below) orphaned rather than
 * silently mis-held. `HERDCTL_RACE_SETTLE_MS` overrides it for hosts that
 * need more headroom, without redesigning the mechanism.
 */
export const RACE_SETTLE_MS = 250;

function raceSettleMs(): number {
  const raw = process.env.HERDCTL_RACE_SETTLE_MS;
  if (raw === undefined || raw === "") return RACE_SETTLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RACE_SETTLE_MS;
}

/**
 * Sentinel for the absolute last-resort backstop on the whole hold — see
 * `maxHoldPromise` in {@link SDKRuntime.execute}.
 */
const MAX_HOLD_ELAPSED = Symbol("max-hold-elapsed");

/**
 * Build a streaming-input user message from plain text.
 *
 * The SDK fills in the real `session_id`, so an empty string is fine here. A
 * leading-slash text (e.g. `"/compact"`) is dispatched by the CLI as a slash
 * command — no special encoding required.
 */
function toUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

/**
 * Convert a JSON Schema property to a Zod schema.
 *
 * Handles the property types used by injected MCP tools (string, number, boolean).
 * Falls back to z.unknown() for unrecognized types.
 */
function jsonPropertyToZod(prop: Record<string, unknown>, isRequired: boolean) {
  let schema: z.ZodTypeAny;
  const description = prop.description as string | undefined;

  switch (prop.type) {
    case "string":
      schema = description ? z.string().describe(description) : z.string();
      break;
    case "number":
    case "integer":
      schema = description ? z.number().describe(description) : z.number();
      break;
    case "boolean":
      schema = description ? z.boolean().describe(description) : z.boolean();
      break;
    default:
      schema = description ? z.unknown().describe(description) : z.unknown();
  }

  return isRequired ? schema : schema.optional();
}

/**
 * Convert an InjectedMcpServerDef to an in-process SDK MCP server.
 *
 * Uses the Claude Agent SDK's tool() + createSdkMcpServer() to build
 * a real MCP server from the transport-agnostic definition.
 */
function defToSdkMcpServer(def: InjectedMcpServerDef) {
  const sdkTools = def.tools.map((toolDef) => {
    const properties = (toolDef.inputSchema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const requiredFields = (toolDef.inputSchema.required ?? []) as string[];

    // Build Zod shape from JSON Schema properties
    const zodShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, prop] of Object.entries(properties)) {
      zodShape[key] = jsonPropertyToZod(prop, requiredFields.includes(key));
    }

    // herdctl's McpToolCallResult is structurally an MCP CallToolResult (text
    // content), but the SDK types the content `type` as a literal union and infers
    // the handler's args shape from the zod schema. Cast at this adapter boundary
    // rather than leaking the SDK's MCP types into the transport-agnostic
    // InjectedMcpToolDef. The instantiation expression pins the same `Schema` the
    // call infers from `zodShape`, so the cast target matches the expected param.
    const handler = toolDef.handler as unknown as Parameters<
      typeof tool<Record<string, z.ZodTypeAny>>
    >[3];
    return tool(toolDef.name, toolDef.description, zodShape, handler);
  });

  return createSdkMcpServer({
    name: def.name,
    version: def.version,
    tools: sdkTools,
  });
}

/**
 * SDK runtime configuration options
 */
export interface SDKRuntimeOptions {
  /**
   * Claude home directory the SDK's Claude Code process should use.
   *
   * Defaults to {@link defaultClaudeHome} (`~/.claude`). Pass the home the
   * embedding app resolved (e.g. `FleetManager.getClaudeHomePath()`) so the
   * transcripts the SDK reads and appends live in the same tree session
   * discovery and adoption list from — otherwise an adopted session cannot be
   * resumed at all, because the SDK looks for its transcript under `~/.claude`
   * and finds nothing (herdctl#423).
   *
   * The SDK has no `claudeHome` option; it resolves its home from the
   * `CLAUDE_CONFIG_DIR` environment variable, so this is applied by injecting
   * that variable into the SDK's per-query `env` (never into `process.env` —
   * see {@link withClaudeConfigDir}).
   */
  claudeHomePath?: string;
}

/**
 * SDK runtime implementation
 *
 * This runtime uses the Claude Agent SDK to execute agents. It wraps the SDK's
 * query() function and provides the standard RuntimeInterface.
 *
 * The SDKRuntime is the default runtime when no runtime type is specified in
 * agent configuration.
 *
 * @example
 * ```typescript
 * const runtime = new SDKRuntime();
 * const messages = runtime.execute({
 *   prompt: "Fix the bug in auth.ts",
 *   agent: resolvedAgent,
 * });
 *
 * for await (const message of messages) {
 *   console.log(message.type, message.content);
 * }
 * ```
 */
export class SDKRuntime implements RuntimeInterface {
  /** Resolved Claude home; `~/.claude` unless the caller supplied one (#423). */
  private claudeHomePath: string;

  constructor(options?: SDKRuntimeOptions) {
    this.claudeHomePath = options?.claudeHomePath ?? defaultClaudeHome();
  }

  /**
   * The Claude home this runtime points the SDK's Claude Code process at.
   * Exposed for tests and for embedders asserting the home actually threaded
   * through.
   */
  getClaudeHomePath(): string {
    return this.claudeHomePath;
  }

  /**
   * Execute an agent using the Claude Agent SDK
   *
   * Converts agent configuration to SDK options and delegates to the SDK's
   * query() function. Yields each message from the SDK stream.
   *
   * @param options - Execution options including prompt, agent, and session info
   * @returns AsyncIterable of SDK messages
   */
  async *execute(options: RuntimeExecuteOptions): AsyncIterable<SDKMessage> {
    const sdkOptions = this.buildSdkOptions(options);

    // issue #458: a one-shot string-prompt `query()` ends its own generator the
    // moment the top-level turn's terminal message arrives — abandoning any
    // `run_in_background` Agent-tool subagent that hasn't finished yet, because
    // JobExecutor's `for await` loop breaks on that same terminal message
    // (nothing left to consult it wants to keep the query alive for). Fixed by
    // borrowing openSession()'s streaming-input + lifecycle-hook wiring: a
    // queue-backed prompt keeps the underlying query open, the Stop/
    // background_tasks_changed hooks report whether background work is still
    // live, and the terminal message is held back until it drains — instead of
    // tearing the session down out from under it. See REINVOCATION_GRACE_ELAPSED
    // above for how long, and why there's no longer a ceiling on the "still
    // live" case. Updated two ways: synchronously in this loop below (from the
    // same `background_tasks_changed` stream message `tapLifecycleStream`
    // reacts to — inspected directly here, not via its `sink`, which fires on a
    // deferred microtask and would race the very message that triggered it),
    // and from the Stop hook's authoritative end-of-turn snapshot via
    // `onLifecycleSignal` below (fine to be async there — nothing in this
    // loop is waiting on that same tick).
    let liveBackgroundTasks: BackgroundTaskSummary[] = [];
    // Set exactly once per genuine "was live, now drained to empty" transition
    // — NOT on every message seen while already at zero. Distinguishes "this
    // run never had background work" (release a held terminal immediately, the
    // common/fast path — see the pendingTerminal check below) from "tasks just
    // drained" (worth a short grace for a follow-up turn). Consumed (reset
    // false) the moment the grace it earns gets armed, so a later terminal
    // that's already draining-with-nothing-new doesn't re-arm a second grace.
    let justDrained = false;
    // Set once, the first time this run EVER reports a background_tasks_changed
    // (live or draining-to-empty) — distinct from `liveBackgroundTasks.length`,
    // which flips back to 0. Gates the ordering-race settle window (#206
    // review MAJOR C): the overwhelming majority of runs never touch a
    // background task at all, and RACE_SETTLE_MS shouldn't tax every one of
    // them with a tail on their clean terminal just to hedge against a race
    // that, by definition, can't happen for a run with no background activity.
    let sawBackgroundActivity = false;
    const noteBackgroundTasks = (tasks: BackgroundTaskSummary[]) => {
      sawBackgroundActivity = true;
      if (liveBackgroundTasks.length > 0 && tasks.length === 0) {
        justDrained = true;
      }
      liveBackgroundTasks = tasks;
    };
    const trackBackgroundTasks = (signal: SessionLifecycleSignal) => {
      // `activity` and `cron_deleted` carry no task snapshot (always `[]`,
      // see SessionLifecycleSignal's own doc) — only `turn_end` and
      // `background_tasks_changed` are authoritative. Taking every signal
      // here would let an `activity` signal (fired on the next assistant
      // message) wipe a real pending-task count to `[]` and release a held
      // terminal early.
      // `hasSnapshot === false` means a `turn_end` fired without the CLI's
      // background_tasks envelope (see SessionLifecycleSignal.hasSnapshot) —
      // `signal.backgroundTasks` is then just an empty stand-in, not "drained
      // to empty". Keep whatever we already tracked instead of clobbering it,
      // which previously released a held terminal (and its live background
      // subagent got killed) mid-wait. See edspencer/herdctl#459 follow-up.
      if (
        (signal.kind === "turn_end" || signal.kind === "background_tasks_changed") &&
        signal.hasSnapshot !== false
      ) {
        noteBackgroundTasks(signal.backgroundTasks);
      }
    };
    // Compose: this internal bg-wait tracker runs first and synchronously (the
    // anchor decision above depends on it), then the caller's own
    // `onLifecycleSignal` consumer (e.g. `SessionLifecycleManager.trackJob`,
    // vulpes-pack#148) rides along on the same signals. A throwing/rejecting
    // consumer must never break this message loop or release a held terminal
    // early, so both failure shapes are swallowed here.
    const onLifecycleSignal = (signal: SessionLifecycleSignal) => {
      trackBackgroundTasks(signal);
      try {
        const consumerResult = options.onLifecycleSignal?.(signal);
        if (consumerResult && typeof consumerResult.catch === "function") {
          void consumerResult.catch(() => {
            // Swallow — a consumer sink must not break the message loop.
          });
        }
      } catch {
        // Swallow — a consumer sink must not break the message loop.
      }
    };
    sdkOptions.hooks = {
      ...(sdkOptions.hooks ?? {}),
      ...buildLifecycleHooks(onLifecycleSignal),
    };

    const input = new MessageQueue<SDKUserMessage>();
    if (options.prompt) {
      input.push(toUserMessage(options.prompt));
    }

    // Thread the AbortController through so teardown has a lever beyond the
    // generator's own `return()` (mirrors the original one-shot call).
    const abortController = options.abortController ?? new AbortController();
    const q = query({
      prompt: input as AsyncIterable<SDKUserMessage>,
      options: {
        ...(sdkOptions as Record<string, unknown>),
        abortController,
      },
    });
    const messages = tapLifecycleStream(
      q as unknown as AsyncIterable<SDKMessage>,
      onLifecycleSignal,
    );
    const iterator = messages[Symbol.asyncIterator]();

    let pendingTerminal: SDKMessage | undefined;
    // Armed either on a drain-to-empty (the long reinvocation grace) or on a
    // fresh terminal with zero known live tasks (the short ordering-race
    // settle) — see REINVOCATION_GRACE_ELAPSED above. Re-armed fresh each
    // time; any message in between cancels it (see the top of the loop).
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let gracePromise: Promise<typeof REINVOCATION_GRACE_ELAPSED> | undefined;
    const armGrace = (ms: number): void => {
      gracePromise = new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(REINVOCATION_GRACE_ELAPSED), ms);
        graceTimer.unref?.();
      });
    };
    const clearGrace = (): void => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      gracePromise = undefined;
    };

    // Absolute last-resort INACTIVITY backstop while holding a terminal open
    // (mirrors JobExecutor's own `drainTimer` on the openSession path, same
    // default duration). #206 review MAJOR A: this must NOT be a bound on the
    // whole call — armed once before the loop and never reset, it killed a
    // healthy, actively-streaming run at exactly 2h regardless of activity,
    // the same "kill healthy work" class the original ceiling removal (#458)
    // fixed, just relocated. So instead it's armed/cleared on the exact same
    // schedule as `gracePromise` (cleared on any message below, re-armed at
    // the end of the decision block below whenever still holding) — it only
    // ever measures a stretch of ABSOLUTE SILENCE while a terminal is held,
    // for the case a background child crashes without ever reporting a final
    // `background_tasks_changed` (or the event is silently dropped): without
    // this, that specific silence would hold forever, since nothing else
    // would ever arm a release. On firing, the held terminal is DISCARDED in
    // favor of a synthetic error (`maxHoldError` below, MAJOR B: worded from
    // the actual `liveBackgroundTasks` state at the moment, not a hardcoded
    // claim) — this must never surface as a silent "success" on a stale
    // result, matching JobExecutor's truthful-close marker
    // (`endedWithLiveBackgroundTasks`), which reads this the same way it
    // already reads any other stream-level error.
    let maxHoldTimer: ReturnType<typeof setTimeout> | undefined;
    let maxHoldPromise: Promise<typeof MAX_HOLD_ELAPSED> | undefined;
    const armMaxHold = (): void => {
      maxHoldPromise = new Promise((resolve) => {
        maxHoldTimer = setTimeout(() => resolve(MAX_HOLD_ELAPSED), DEFAULT_SESSION_TIMEOUT_MS);
        maxHoldTimer.unref?.();
      });
    };
    const clearMaxHold = (): void => {
      if (maxHoldTimer) {
        clearTimeout(maxHoldTimer);
        maxHoldTimer = undefined;
      }
      maxHoldPromise = undefined;
    };
    const maxHoldError = (): SDKMessage => {
      const state =
        liveBackgroundTasks.length > 0
          ? `${liveBackgroundTasks.length} background task(s) still reported live`
          : "background work status unresolved at the time of the hold";
      return {
        type: "error",
        // "timed out" is deliberate wording, not just description — job-executor's
        // `classifyError` substring-matches it to exit_reason "timeout", the same
        // classification the openSession path's own sessionTimeoutMs backstop gets.
        message: `execute() timed out after ${DEFAULT_SESSION_TIMEOUT_MS}ms of inactivity while holding (${state}) — forcibly ending`,
        code: "MAX_HOLD_ELAPSED",
      } as unknown as SDKMessage;
    };

    try {
      while (true) {
        const nextResult =
          gracePromise && maxHoldPromise
            ? await Promise.race([iterator.next(), gracePromise, maxHoldPromise])
            : gracePromise
              ? await Promise.race([iterator.next(), gracePromise])
              : maxHoldPromise
                ? await Promise.race([iterator.next(), maxHoldPromise])
                : await iterator.next();

        if (nextResult === MAX_HOLD_ELAPSED) {
          // Discard whatever stale terminal was held — this is a forced,
          // truthful-close ending, not the run's real result.
          pendingTerminal = maxHoldError();
          break;
        }
        if (nextResult === REINVOCATION_GRACE_ELAPSED) break; // nothing new arrived; yield the held terminal below
        if (nextResult.done) break;

        // Any message is activity — cancel a pending grace (and the maxHold
        // inactivity clock) outright, whether it's the long reinvocation
        // grace or the short ordering-race settle (SessionReaper's own
        // "activity cancels the pending reap" contract, session-reaper.ts).
        // This does NOT mean the run is done: it means "keep holding
        // unconditionally" until a fresh terminal supersedes the stale one,
        // or the decision below re-arms a fresh grace for the new state.
        // Re-arming a plain pass-through message onto an ALREADY reinvoked
        // turn's own content — instead of letting it silently outlive a
        // grace it never touched — is exactly what closes the case where a
        // genuine re-invocation streams for longer than the grace window: it
        // now just keeps resetting the timer as long as content keeps
        // arriving, same as SessionReaper's `activity` signal.
        clearGrace();
        clearMaxHold();

        const message = nextResult.value;
        // Read synchronously off the raw message — NOT "ahead of"
        // tapLifecycleStream's own deferred `sink` call for the same message,
        // despite an earlier version of this comment claiming so (#206
        // review MINOR 2): both this check and the sink derive from the SAME
        // `for await` pull inside `tapLifecycleStream`, so there's no
        // meaningful ordering between them to be "ahead of" — this read is
        // just a second, independent path to the same information. What
        // actually matters is that the Stop hook's authoritative turn_end
        // snapshot updates this state fully OUT OF BAND from this loop's
        // `iterator.next()` (the hook fires from the SDK's own internal
        // processing, not gated on this loop pulling anything) — so the
        // decision below re-checks on every message, not just ones that
        // themselves report a task count, the same way the pre-#458 ceiling
        // logic did: the next message, whatever it is, is what surfaces a
        // signal the hook delivered in between.
        if (
          message &&
          (message as { type?: string }).type === "system" &&
          (message as { subtype?: string }).subtype === "background_tasks_changed"
        ) {
          noteBackgroundTasks(
            ((message as { tasks?: BackgroundTaskSummary[] }).tasks as BackgroundTaskSummary[]) ??
              [],
          );
        }

        const isFreshTerminal = isTerminalMessage(message);
        if (isFreshTerminal) {
          // Supersedes any terminal already held — e.g. a re-invocation turn
          // (the background task's own completion) produces a newer one.
          pendingTerminal = message;
        } else {
          // Always forwarded, including while a terminal is held: a
          // re-invocation's own content (assistant/tool messages) must reach
          // the consumer, not just its eventual terminal.
          yield message;
        }

        if (pendingTerminal) {
          if (liveBackgroundTasks.length > 0) {
            // Still (or newly) live — nothing to arm; already cleared above.
          } else if (isFreshTerminal && sawBackgroundActivity) {
            // Ordering race: a background task dispatched IN this terminal
            // turn can lose the wire race against the turn's own terminal
            // (SDK ordering unspecified, vulpes-pack#206 follow-up). Settle
            // briefly rather than trusting "zero known live tasks" outright
            // — if the task's announcement lands within the window,
            // `liveBackgroundTasks` flips non-empty and the next iteration
            // holds normally instead of releasing over a fresh orphan.
            // Gated on `sawBackgroundActivity` (MAJOR C): a run that has
            // never touched a background task at all has no race to settle
            // for, and shouldn't pay this tail on every clean terminal.
            armGrace(raceSettleMs());
          } else if (isFreshTerminal) {
            // Never had background work: nothing to wait for — the v2
            // immediate release, no tail at all.
            clearGrace();
            clearMaxHold();
            break;
          } else if (justDrained) {
            // A genuine drain-to-empty transition, not itself a terminal:
            // give a follow-up turn a real chance to show up before giving
            // up on it.
            justDrained = false;
            armGrace(DEFAULT_REINVOCATION_GRACE_MS);
          } else {
            // Nothing live, no fresh transition: a redundant or unrelated
            // message (a duplicate 0-task report, stray content) arrived
            // while we were ALREADY draining under a grace that `clearGrace()`
            // above just cancelled. Re-arm it (#206 review MAJOR D) — leaving
            // this unarmed would strand an otherwise-COMPLETE run on
            // `maxHoldPromise`'s multi-hour backstop and report a false
            // failure on what should have been a clean, on-time success.
            armGrace(sawBackgroundActivity ? DEFAULT_REINVOCATION_GRACE_MS : raceSettleMs());
          }
          // Reached only when none of the branches above broke out of the
          // loop — still holding past this message. Keep the inactivity
          // backstop engaged for whatever comes next, or doesn't.
          armMaxHold();
        }
      }

      // Inside the same try/finally as the loop above (not after it): a
      // `yield` suspends the generator, and if the consumer aborts iteration
      // right here (breaks its `for await`, calls `.return()`) without this
      // being in the try, the `finally` below — and therefore input.end()/
      // q.return() — would never run, leaking the query.
      if (pendingTerminal) yield pendingTerminal;
    } finally {
      clearGrace();
      if (maxHoldTimer) clearTimeout(maxHoldTimer);
      input.end();
      try {
        await q.return(undefined);
      } catch {
        // Already closed / never started — nothing to clean up.
      }
    }
  }

  /**
   * Open a long-lived streaming session backed by the SDK's streaming-input mode.
   *
   * The initial `options.prompt` (if any) is sent as the first turn; further
   * turns are sent via {@link RuntimeSession.send}. Because the input iterable
   * stays open, the returned SDK `Query` handle is retained so its control
   * requests (`interrupt`, `supportedCommands`, `setModel`, `stopTask`) stay
   * available for the life of the session.
   */
  openSession(options: RuntimeExecuteOptions): RuntimeSession {
    const sdkOptions = this.buildSdkOptions(options);

    // Install turn-boundary lifecycle hooks when the caller wants to observe the
    // session's background-work lifecycle (the session-reaper). The Stop hook
    // carries the authoritative session_crons/background_tasks snapshot.
    if (options.onLifecycleSignal) {
      sdkOptions.hooks = {
        ...(sdkOptions.hooks ?? {}),
        ...buildLifecycleHooks(options.onLifecycleSignal),
      };
    }

    // A pushable iterable keeps the query open across turns.
    const input = new MessageQueue<SDKUserMessage>();
    if (options.prompt) {
      input.push(toUserMessage(options.prompt));
    }

    // Thread the AbortController through so teardown has a lever beyond close()
    // (mirrors execute()); create one if the caller didn't supply it.
    const abortController = options.abortController ?? new AbortController();

    const q = query({
      prompt: input as AsyncIterable<SDKUserMessage>,
      options: {
        ...(sdkOptions as Record<string, unknown>),
        abortController,
      },
    });

    // Widen the Query (an AsyncGenerator<SDKMessage>) to herdctl's structural
    // SDKMessage, then tap the stream for mid-turn lifecycle events when needed.
    const rawMessages = q as unknown as AsyncIterable<SDKMessage>;
    const messages = options.onLifecycleSignal
      ? tapLifecycleStream(rawMessages, options.onLifecycleSignal)
      : rawMessages;

    return {
      messages,
      send: async (text: string) => {
        input.push(toUserMessage(text));
      },
      interrupt: async () => {
        // The SDK's interrupt() resolves to an optional interrupt-receipt object
        // (still-queued message uuids); the RuntimeSession contract is fire-and-
        // forget, so discard it to satisfy the Promise<void> return type.
        await q.interrupt();
      },
      listCommands: () => q.supportedCommands(),
      setModel: (model?: string) => q.setModel(model),
      stopTask: (taskId: string) => q.stopTask(taskId),
      close: async () => {
        input.end();
        // Best-effort: tell the SDK generator we're done so it tears down the CLI.
        try {
          await q.return(undefined);
        } catch {
          // Already closed / never started — nothing to clean up.
        }
        // Abort as a backstop in case the generator was already detached and
        // q.return() didn't reach the underlying process.
        if (!abortController.signal.aborted) abortController.abort();
      },
    };
  }

  /**
   * Build SDK query options from execution options.
   *
   * Shared by {@link execute} and {@link openSession}: applies agent config,
   * a system-prompt append, and any injected in-process MCP servers.
   */
  private buildSdkOptions(options: RuntimeExecuteOptions): ReturnType<typeof toSDKOptions> {
    // Convert agent configuration to SDK options
    const sdkOptions = toSDKOptions(options.agent, {
      resume: options.resume,
      fork: options.fork,
    });

    // Opt in to partial (streaming) assistant messages when the caller requested
    // it. This makes the SDK query() emit `stream_event` / `text_delta` chunks so
    // consumers can stream assistant text token-by-token. Left unset (SDK default:
    // off) for batch/one-shot and non-opting session callers, so their streams
    // still carry only whole `assistant` messages.
    if (options.includePartialMessages) {
      sdkOptions.includePartialMessages = true;
    }

    // Apply system prompt append if provided (e.g., concise mode for chat platforms)
    if (options.systemPromptAppend) {
      const current = sdkOptions.systemPrompt;
      if (typeof current === "string") {
        sdkOptions.systemPrompt = current + "\n\n" + options.systemPromptAppend;
      } else if (current && typeof current === "object" && current.type === "preset") {
        sdkOptions.systemPrompt = {
          ...current,
          append: (current.append ? current.append + "\n\n" : "") + options.systemPromptAppend,
        };
      } else {
        sdkOptions.systemPrompt = {
          type: "preset",
          preset: "claude_code",
          append: options.systemPromptAppend,
        };
      }
    }

    // Convert injected MCP server defs to in-process SDK MCP servers
    if (options.injectedMcpServers && Object.keys(options.injectedMcpServers).length > 0) {
      const configServers = sdkOptions.mcpServers ?? {};
      const injectedServers: Record<string, unknown> = {};

      for (const [name, def] of Object.entries(options.injectedMcpServers)) {
        injectedServers[name] = defToSdkMcpServer(def);
      }

      // SDK accepts both plain configs and McpSdkServerConfigWithInstance objects.
      // The latter contains a live McpServer instance which doesn't match SDKMcpServerConfig.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkOptions.mcpServers = { ...configServers, ...injectedServers } as any;

      // Auto-add injected MCP server tool patterns to allowedTools
      // Without this, agents with an allowedTools list can't call injected tools.
      // De-dupe before pushing: `sdkOptions.allowedTools` can be re-derived from
      // the same agent across turns, and blindly pushing would grow the list with
      // duplicate `mcp__…__*` patterns each turn (edspencer/herdctl#390).
      if (sdkOptions.allowedTools?.length) {
        const existing = new Set(sdkOptions.allowedTools);
        for (const name of Object.keys(options.injectedMcpServers)) {
          const pattern = `mcp__${name}__*`;
          if (!existing.has(pattern)) {
            sdkOptions.allowedTools.push(pattern);
            existing.add(pattern);
          }
        }
      }

      // File uploads via MCP tools can take longer than the default 60s timeout.
      // Set a safe default if not already configured by the user.
      if (
        options.injectedMcpServers["herdctl-file-sender"] &&
        !process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT
      ) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = "120000";
      }
    }

    // Point the SDK's Claude Code process at the configured Claude home.
    //
    // The SDK resolves its home from `CLAUDE_CONFIG_DIR` (never from anything
    // herdctl passes in options), so without this a non-default `claudeHomePath`
    // splits the world: herdctl adopts and lists transcripts under the
    // configured home while the SDK reads and writes under `~/.claude`.
    //
    // Scoped deliberately to THIS query's `env` rather than `process.env`: the
    // host process runs many concurrent agents, and a global mutation would leak
    // one agent's home into all of them. Applied last so the inherited snapshot
    // includes the `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` bump above, and so it wins
    // over anything earlier in this method. `env` REPLACES the subprocess
    // environment wholesale, hence the spread of the inherited one inside
    // `withClaudeConfigDir`. Returns undefined (leaving plain inheritance) for
    // the default home and when the operator already set the variable.
    const env = withClaudeConfigDir(this.claudeHomePath, sdkOptions.env ?? process.env);
    if (env) {
      sdkOptions.env = env;
    }

    return sdkOptions;
  }
}
