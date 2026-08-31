/**
 * Type definitions for the agent runner module
 *
 * Defines options, results, and SDK-related types for agent execution
 */

import type { ResolvedAgent } from "../config/index.js";
import type { JobMetadata, JobOutputInput, TriggerType } from "../state/index.js";

// =============================================================================
// Runner Options Types
// =============================================================================

/**
 * Default ceiling for a session-backed run (2 hours).
 *
 * Deliberately generous: it is a stuck-run backstop, not a work budget. Long
 * foreground builds run 30–60 min, so anything tighter would kill real work;
 * anything looser leaves a wedged session holding its concurrency slot for most
 * of a day. Override per run with {@link RunnerOptions.sessionTimeoutMs}.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Default wait for the follow-up turn an injected message may start (60s).
 *
 * Hosts differ on when a pushed streaming-input message is delivered: some fold
 * it into the running turn, others start a new turn once the current one ends.
 * After a terminal result with input still pending, the executor waits this long
 * for that second turn to produce output. Expiry closes the session — an
 * expected ending, not a failure, since the message may simply have been
 * answered by the turn that just finished.
 */
export const DEFAULT_INJECTION_GRACE_MS = 60_000;

/**
 * Options for running an agent
 */
export interface RunnerOptions {
  /** Fully resolved agent configuration */
  agent: ResolvedAgent;
  /** The prompt to send to the agent */
  prompt: string;
  /** Path to the .herdctl directory */
  stateDir: string;
  /** How this run was triggered */
  triggerType?: TriggerType;
  /** Schedule name (if triggered by schedule) */
  schedule?: string;
  /** Session ID to resume (mutually exclusive with fork) */
  resume?: string;
  /** Fork from this session ID */
  fork?: string;
  /** Parent job ID when forking (used with fork option) */
  forkedFrom?: string;
  /** When true, job output is also written to .herdctl/jobs/{jobId}/output.log (default: false) */
  outputToFile?: boolean;
  /** AbortController for canceling the execution */
  abortController?: AbortController;
  /** MCP servers to inject at runtime (all runtimes: SDK, CLI, Docker) */
  injectedMcpServers?: Record<string, InjectedMcpServerDef>;
  /** Text to append to the agent's system prompt for this run */
  systemPromptAppend?: string;
  /**
   * Key under which this run's session is stored and looked up.
   *
   * Defaults to `agent.qualifiedName` — one session per agent, the historical
   * behavior. Pass a different key to scope a session to something narrower than
   * the agent, e.g. one session per work item. Must be a safe file identifier
   * (`[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?`); session storage rejects anything
   * else.
   */
  sessionKey?: string;
  /**
   * Run this job on a long-lived streaming session instead of a one-shot
   * `execute()`, so messages can be injected mid-run.
   *
   * When `true` AND the runtime implements
   * {@link import("./runtime/index.js").RuntimeInterface.openSession}, the run
   * is driven through `openSession()` and drained until the terminal `result`
   * message. The session stays open for the whole run, so a caller holding the
   * handle (see {@link onSessionOpen}) can push extra user turns into it — the
   * SDK delivers them at the next tool boundary of the running turn.
   *
   * Ignored (silently, not an error) when the runtime has no `openSession` —
   * CLI and Docker runtimes fall back to the unchanged `execute()` path.
   */
  interactive?: boolean;
  /**
   * Ceiling for a session-backed run, in milliseconds (default
   * {@link DEFAULT_SESSION_TIMEOUT_MS}).
   *
   * A streaming session's message stream never ends on its own, so a run whose
   * terminal `result` never arrives would drain forever: the job stays
   * `running`, its concurrency slot is never released and its `claude` process
   * is never reaped. On expiry the session is closed and the run is recorded as
   * failed.
   *
   * NOT threaded to the one-shot `execute()` path as a caller-configurable
   * value — that path enforces its own absolute last-resort backstop, fixed
   * at {@link DEFAULT_SESSION_TIMEOUT_MS} regardless of this option, so a
   * background child that crashes without ever reporting a final
   * `background_tasks_changed` (or whose event is dropped) can't hold the
   * run open forever either (see `SDKRuntime.execute()`'s `maxHoldPromise`).
   */
  sessionTimeoutMs?: number;
  /**
   * How long a session-backed run waits, after a terminal result, for the
   * follow-up turn that injected input may start (default
   * {@link DEFAULT_INJECTION_GRACE_MS}). Only consulted when a message was
   * injected and no turn has answered it yet.
   */
  injectionGraceMs?: number;
  /**
   * Called once with a control handle when {@link interactive} actually took
   * effect. Never called on the `execute()` path.
   *
   * Deliberately NOT the raw `RuntimeSession`: the executor owns the session's
   * lifetime, so a caller must not be able to `close()` it or consume its
   * message stream.
   */
  onSessionOpen?: (handle: JobSessionHandle) => void;
}

/**
 * What a caller may do with a *running* session-backed job.
 *
 * Both methods are synchronous and report whether the run was still accepting
 * input at the moment of the call — `false` means the run has stopped consuming
 * its input queue (terminal message seen, timed out, or already torn down), so
 * the text would have been silently dropped.
 */
export interface JobSessionHandle {
  /** Queue a user turn. The runtime delivers it at the current turn's next tool boundary. */
  send(text: string): boolean;
  /**
   * Interrupt the running turn. The run ENDS (its terminal message breaks the
   * drain loop and the executor closes the session) and is recorded as
   * `cancelled` — this is not "pause and continue".
   */
  interrupt(): boolean;
}

/**
 * SDK message types (as received from Claude Agent SDK)
 *
 * The SDK sends various message types:
 * - system: System messages (init, status, compact_boundary, etc.)
 * - assistant: Complete assistant messages with nested API message
 * - stream_event: Partial streaming content with RawMessageStreamEvent
 * - result: Final query result with summary and usage stats
 * - user: User messages with nested API message, may contain tool_use_result
 * - tool_progress: Progress updates for long-running tools
 * - auth_status: Authentication status updates
 * - error: Error messages
 *
 * Legacy types (for backwards compatibility with tests):
 * - tool_use: Tool invocation (now part of assistant content blocks)
 * - tool_result: Tool result (now part of user messages)
 */
export interface SDKMessage {
  type:
    | "system"
    | "assistant"
    | "stream_event"
    | "result"
    | "user"
    | "tool_progress"
    | "auth_status"
    | "error"
    // Legacy types for backwards compatibility
    | "tool_use"
    | "tool_result";
  subtype?: string;
  content?: string;
  session_id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  tool_name?: string;
  tool_use_result?: unknown;
  message?: unknown; // Can be string (for errors) or nested API message
  event?: unknown; // For stream_event messages
  result?: unknown; // For result messages
  success?: boolean; // For tool_result messages
  code?: string;
  // Allow additional SDK-specific fields
  [key: string]: unknown;
}

/**
 * Callback for receiving messages during execution
 */
export type MessageCallback = (message: SDKMessage) => void | Promise<void>;

/**
 * Callback for when a job is created (before execution starts)
 *
 * Receives both the job id and the freshly-created {@link JobMetadata} record
 * (status `pending`), so callers can emit a `job:created` event up front —
 * before any output streams — without re-reading the record from disk.
 */
export type JobCreatedCallback = (jobId: string, job: JobMetadata) => void | Promise<void>;

/**
 * Extended options including callbacks
 */
export interface RunnerOptionsWithCallbacks extends RunnerOptions {
  /** Called for each message from the SDK */
  onMessage?: MessageCallback;
  /** Called when the job is created, before execution starts */
  onJobCreated?: JobCreatedCallback;
  /**
   * Observe the run's session-lifecycle signals (turn boundaries,
   * background-task changes). Threaded straight through to
   * `RuntimeExecuteOptions.onLifecycleSignal` — see that type's doc. Wired by
   * `JobControl.trigger`/`ScheduleExecutor` via
   * `SessionLifecycleManager.trackJob` so a job's `ScheduleWakeup`/session
   * cron is captured into the fleet's wake registry instead of being silently
   * dropped when the job completes (vulpes-pack#148).
   */
  onLifecycleSignal?: (
    signal: import("../session/types.js").SessionLifecycleSignal,
  ) => void | Promise<void>;
}

// =============================================================================
// Runner Result Types
// =============================================================================

/**
 * Detailed error information for failed runs
 */
export interface RunnerErrorDetails {
  /** The error message */
  message: string;
  /** Error code if available (e.g., ETIMEDOUT, ECONNREFUSED) */
  code?: string;
  /** The type of error (for categorization) */
  type?: "initialization" | "streaming" | "malformed_response" | "unknown";
  /** Whether this error is potentially recoverable (e.g., rate limit, network) */
  recoverable?: boolean;
  /** Number of messages received before error (for streaming errors) */
  messagesReceived?: number;
  /** Stack trace if available */
  stack?: string;
}

/**
 * Result of running an agent
 */
export interface RunnerResult {
  /** Whether the run completed successfully */
  success: boolean;
  /** The job ID for this run */
  jobId: string;
  /** The session ID (for resume/fork) */
  sessionId?: string;
  /** Brief summary of what was accomplished */
  summary?: string;
  /** Error if the run failed */
  error?: Error;
  /** Detailed error information for programmatic access */
  errorDetails?: RunnerErrorDetails;
  /** Duration in seconds */
  durationSeconds?: number;
}

// =============================================================================
// Injected MCP Server Types
// =============================================================================

/**
 * Tool call result from an MCP tool handler
 */
export interface McpToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * A single tool definition for an injected MCP server.
 *
 * Contains the tool metadata, JSON schema for HTTP transport, and
 * the handler function for executing the tool.
 */
export interface InjectedMcpToolDef {
  /** Tool name as it appears to the agent */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
  /** Handler function that executes the tool */
  handler: (args: Record<string, unknown>) => Promise<McpToolCallResult>;
}

/**
 * Definition for an MCP server to inject at runtime.
 *
 * Contains tool definitions with handlers that each runtime converts to
 * the appropriate transport:
 * - SDKRuntime: in-process MCP server via createSdkMcpServer()
 * - ContainerRunner: HTTP MCP bridge accessible over Docker network
 */
export interface InjectedMcpServerDef {
  /** Server name (e.g., "herdctl-file-sender") */
  name: string;
  /** Server version */
  version?: string;
  /** Tool definitions provided by this server */
  tools: InjectedMcpToolDef[];
}

// =============================================================================
// SDK Option Types
// =============================================================================

/**
 * MCP server configuration for SDK
 */
export interface SDKMcpServerConfig {
  /**
   * Transport. Mirrors the SDK's three serializable MCP config shapes —
   * `stdio` (default when `command` is set), `sse`, and `http`. `sse` is not
   * inferrable, so it must come from an explicit `type` in agent config
   * (edspencer/herdctl#445).
   */
  type?: "stdio" | "sse" | "http";
  url?: string;
  /** Request headers for `sse`/`http` servers — carries bearer / API-key auth. */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-server tool-call timeout in milliseconds. */
  timeout?: number;
  /** Always include this server's tools in the prompt rather than deferring them. */
  alwaysLoad?: boolean;
}

/**
 * Plugin configuration for SDK, mirroring the SDK's own `SdkPluginConfig`.
 */
export interface SDKPluginConfig {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
}

/**
 * System prompt configuration for SDK
 *
 * The SDK accepts either:
 * - A plain string for custom prompts
 * - An object with type: 'preset' for using Claude Code's default prompt
 */
export type SDKSystemPrompt = string | { type: "preset"; preset: "claude_code"; append?: string };

/**
 * SDK query options (matching Claude Agent SDK types)
 */
export interface SDKQueryOptions {
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "delegate"
    | "dontAsk";
  systemPrompt?: SDKSystemPrompt;
  settingSources?: string[];
  mcpServers?: Record<string, SDKMcpServerConfig>;
  /**
   * Claude Code plugins to load, from the agent's `plugins` config.
   *
   * Set by `toSDKOptions` only when the agent lists plugins. These are merged
   * by the SDK with any it auto-discovers under `$CLAUDE_CONFIG_DIR/plugins` —
   * but discovery is only *enabled* through the `enabledPlugins` key in the
   * user settings source, which herdctl loads only when the agent asks for it
   * via `setting_sources`. Listing plugins here needs no such opt-in
   * (edspencer/herdctl#444).
   */
  plugins?: SDKPluginConfig[];
  resume?: string;
  forkSession?: boolean;
  /** Maximum number of agentic turns before stopping */
  maxTurns?: number;
  /** Current working directory for the session */
  cwd?: string;
  /** Model to use for the session */
  model?: string;
  /**
   * Request partial (streaming) assistant messages. When `true`, the SDK
   * `query()` emits `stream_event` messages carrying incremental
   * `content_block_delta` / `text_delta` chunks in addition to the terminal
   * whole `assistant` message. Default off — set only by streaming-session
   * callers that opt in (see `ChatSessionOptions.includePartialMessages`); batch
   * / one-shot callers are unaffected.
   */
  includePartialMessages?: boolean;
  /**
   * SDK lifecycle hooks (`Stop`, `SubagentStop`, …). Not set by `toSDKOptions`;
   * injected by the SDK runtime for streaming sessions to observe turn
   * boundaries. Typed against the SDK's own `Options["hooks"]`.
   */
  hooks?: import("@anthropic-ai/claude-agent-sdk").Options["hooks"];
  /**
   * Environment for the Claude Code process the SDK spawns.
   *
   * Mirrors the SDK's own `Options["env"]`, including its sharp edge: when set,
   * this **replaces** the subprocess environment entirely rather than merging
   * with `process.env`, so whoever populates it must spread the inherited
   * environment itself. Not set by `toSDKOptions`; injected by the SDK runtime
   * to point Claude Code at the configured Claude home via `CLAUDE_CONFIG_DIR`
   * (herdctl#423).
   */
  env?: Record<string, string | undefined>;
}

// =============================================================================
// Message Processing Types
// =============================================================================

/**
 * Result of processing an SDK message
 */
export interface ProcessedMessage {
  /** The message transformed for job output */
  output: JobOutputInput;
  /** Session ID if this was an init message */
  sessionId?: string;
  /** Whether this is the final message */
  isFinal?: boolean;
}
