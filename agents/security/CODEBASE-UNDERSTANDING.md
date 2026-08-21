# Security-Relevant Codebase Understanding

This document captures the evolving security understanding of the herdctl codebase.
Updated after each security review as new insights are gained.

**Last Updated**: 2026-08-21
**Reviews Conducted**: 5

---

## System Overview (Security Perspective)

herdctl manages fleets of autonomous Claude Code agents. From a security standpoint:

- **Trust model**: Fleet operators are trusted, agents are partially trusted
- **Isolation**: Agents can run in Docker containers with hardening
- **Persistence**: State stored in `.herdctl/` directory
- **External communication**: Agents call Anthropic API, optionally GitHub

---

## Data Flow: User Input to Execution

### Configuration Loading

```
YAML files (user-controlled)
        │
        ▼
    js-yaml.load()  ─── Uses safe mode, no code execution
        │
        ▼
    Zod validation  ─── CRITICAL: Main input sanitization
        │                - AgentConfigSchema.strict()
        │                - AGENT_NAME_PATTERN validation
        │                - PermissionModeSchema enum
        │
        ▼
    interpolate()   ─── Only ${VAR} substitution
        │                - No command execution
        │                - No nested interpolation
        │
        ▼
    FleetConfig (trusted internally after this point)
```

**Trust boundary**: Zod validation. Data past this point is treated as validated.

### Agent Execution

```
FleetConfig.agents[n]
        │
        ▼
    FleetManager.startAgent()
        │
        ├─────────────────────────┐
        ▼                         ▼
    CLI Runtime              Docker Runtime
    (cli-runtime.ts)         (container-runner.ts)
        │                         │
        ▼                         ▼
    execa("claude", args)    docker.create() + exec()
        │                         │
        │   ┌─────────────────────┘
        ▼   ▼
    Claude Code process (in workspace)
        │
        ▼
    Anthropic API calls
```

**Trust boundary**: The agent process itself. Claude operates within permission modes
but has significant capability within its workspace.

### State Persistence

```
Job execution results
        │
        ▼
    StateManager
        │
        ├── buildSafeFilePath()  ─── Validates identifiers
        │
        ▼
    .herdctl/
    ├── sessions/{agent}.json
    └── jobs/{jobId}.yaml
```

**Trust boundary**: `buildSafeFilePath()` ensures identifiers can't escape the
state directory via path traversal.

---

## Component Security Profiles

### Config (`packages/core/src/config/`)

| File | Risk | Notes |
|------|------|-------|
| `schema.ts` | **Critical** | Zod validation is primary defense; `.strict()` on agent configs |
| `interpolate.ts` | Medium | Simple substitution only; reviewed and safe |
| `loader.ts` | Low | Uses js-yaml safe mode |
| `defaults.ts` | Low | Static default values |

**Key insight**: The schema is our main defense. If something gets past Zod
validation, it's trusted throughout the rest of the system.

### Runner (`packages/core/src/runner/`)

| File | Risk | Notes |
|------|------|-------|
| `cli-runtime.ts` | High | Spawns processes; uses array args (safe) |
| `container-manager.ts` | **Critical** | Docker API; has `hostConfigOverride` risk |
| `container-runner.ts` | High | Wraps runtime in Docker; `docker exec`; shell escaping incomplete |

**Key insights**:
- `hostConfigOverride` is the biggest known risk. It can bypass all Docker security hardening. Documented as accepted risk.
- `container-runner.ts` has incomplete shell escaping for prompts embedded in `docker exec` commands. Low practical risk due to container isolation, but technical debt.

### State (`packages/core/src/state/`)

| File | Risk | Notes |
|------|------|-------|
| `session.ts` | Medium | Uses `buildSafeFilePath` - fixed |
| `job-metadata.ts` | Medium | Uses `buildSafeFilePath` - fixed |
| `directory.ts` | Medium | Creates directory structure; needs review |
| `utils/path-safety.ts` | Low | Defense utility; well-tested |
| `utils/atomic.ts` | Low | Atomic file writes |
| `utils/reads.ts` | Low | Safe file reads |

**Key insight**: Path traversal was a real vulnerability here. Now mitigated
with `buildSafeFilePath`, but should audit for similar patterns elsewhere.

**Improvements (2026-08-21)**:
- Commit 31c675c fixed Windows compatibility (path.sep vs hardcoded "/")
- Added test coverage for root paths and cross-platform separators

### Scheduler (`packages/core/src/scheduler/`)

| File | Risk | Notes |
|------|------|-------|
| `scheduler.ts` | Low | Orchestration; no direct security risk |
| `interval.ts` | Low | Parses intervals; validated |
| `cron.ts` | Low | Uses cron-parser library |

**Key insight**: Scheduler is relatively safe. Main risk would be runaway
execution, but that's a resource issue, not a security vulnerability.

### Hooks (`packages/core/src/hooks/`)

| File | Risk | Notes |
|------|------|-------|
| `runners/shell.ts` | Medium | Uses `shell: true`; documented risk |
| `hook-runner.ts` | Medium | Executes user-defined hooks |

**Key insight**: Shell hooks inherently require shell execution. The risk is
accepted but documented. Users control their own hook configuration.

---

## Known Attack Vectors

### Mitigated

| Vector | Mitigation | Verified |
|--------|------------|----------|
| Path traversal in agent names | Schema validation + `buildSafeFilePath` | ✅ Tests + Windows fix |
| Path traversal in job IDs | Strict ID pattern + `buildSafeFilePath` | ✅ Tests |
| YAML bombs | js-yaml safe mode | ✅ Library |
| Command injection in spawns | Array arguments in execa | ✅ Code review |
| Schema bypass with extra fields | Zod `.strict()` on agent configs | ✅ Tests |
| encodedPath collisions | cwd validation on collision detection | ✅ Tests (commit 9e0b6fc) |

### Accepted Risks

| Vector | Why Accepted | Documentation |
|--------|--------------|---------------|
| `hostConfigOverride` | Required for advanced Docker config | THREAT-MODEL.md |
| Shell hooks with `shell: true` | Required for shell functionality | THREAT-MODEL.md |
| `bypassPermissions` mode | Some use cases need it | Schema enforces awareness |

### Unknown / Needs Investigation

| Vector | Status | Priority |
|--------|--------|----------|
| Webhook signature verification | Unknown implementation status | Medium |
| Secret detection in logs | Not implemented | High |
| Rate limiting on triggers | Unknown implementation status | Medium |
| MCP server config validation | Unknown implementation status | Medium |

---

## Open Security Questions

These questions should be systematically investigated during audits. Each audit should attempt to answer or make progress on at least one open question.

| ID | Question | Priority | Status | Assigned | Last Checked | Notes |
|----|----------|----------|--------|----------|--------------|-------|
| Q1 | How are GitHub webhooks authenticated? Is signature verification implemented? | Medium | Open | - | - | Check work-sources/ for webhook handling |
| Q2 | Are there other places where user-controlled strings become file paths? | High | Answered | - | 2026-02-06 | Audited all path.join() and file operations. FOUND: job-executor.ts:183 creates directories using job.id (validated), job-output.ts:62 uses validated job.id, cli-session-path.ts:53 encodes workspace paths safely. All other path.join() calls use static strings or validated config. NO additional risks. Status: VERIFIED SAFE. |
| Q3 | What happens if a Docker container name contains special characters? | Low | Open | - | - | Could cause issues in docker exec commands |
| Q4 | Could malicious agent output cause log injection in job-output.ts? | Medium | Open | - | - | Output streams to files - check for escape sequences |
| Q5 | When fleet config merges with agent config, are there unexpected overrides? | Medium | Open | - | - | Check config merging logic in loader.ts |
| Q6 | Are session IDs validated against a safe pattern like agent names? | Low | Answered | - | 2026-02-05 | Session IDs come from Claude SDK (UUIDs), not user input. Low risk. |
| Q7 | What user does the Docker container run as? Root or unprivileged? | Medium | Open | - | - | Check container-manager.ts User config |
| Q8 | Is the prompt in SDK wrapper (HERDCTL_SDK_OPTIONS) properly escaped? | Medium | Open | - | - | container-runner.ts:206-207 uses JSON.stringify + shell escaping |
| Q10 | Does MCP server config passthrough have proper validation? | Medium | Open | - | 2026-08-21 | Commits d45d7f9, 15c20be added MCP config - verify security controls |
| Q13 | Does encodedPath path traversal have proper validation? | Medium | IMPROVED | - | 2026-08-21 | Commit 9e0b6fc added cwd validation for collisions; defense-in-depth improved |

### Question Guidelines

**Adding Questions**: When you discover something that needs investigation but can't answer immediately, add it here with status "Open".

**Investigating**: Set status to "In Progress" and assign to current audit date.

**Answering**: When answered, set status to "Answered" and add notes. Keep in table for 30 days, then move to "Answered Questions" archive below.

**Priorities**:
- **High**: Could lead to RCE, data exfiltration, or privilege escalation
- **Medium**: Could lead to DoS, information disclosure, or security bypass
- **Low**: Minor issues, defense-in-depth concerns, code quality

### Answered Questions Archive

| ID | Question | Answer | Answered On |
|----|----------|--------|-------------|
| Q6 | Session ID validation | Session IDs are UUIDs from Claude SDK, not user input. Stored in user's own project. Low risk. | 2026-02-05 |
| Q2 | Other path traversal vectors | All user-controlled file paths properly secured. job.id uses strict regex, cli-session-path encodes safely. No risks found. | 2026-02-06 |
| Q12 | OAuth access_token/refresh_token in error messages | Related to Finding #011 - needs audit of logger.error() calls | 2026-03-06 |
| Q14 | OAuth token refresh network failure handling | Related to Finding #011 - error handling needs review | 2026-03-06 |
| Q11 | GitHub SSRF in repo cloning | CONFIRMED - User controls GitHub URLs; mitigations present but no allowlist | 2026-03-06 |
| Q9 | Does job-executor.ts need buildSafeFilePath? | job.id uses strict schema validation; adequate protection | 2026-03-06 |

---

## Security Improvement Opportunities

### Quick Wins
- [x] Fix `network: none` bug in example config - Already commented out
- [x] Review the "potential secret logging" findings - False positives
- [ ] Fix incomplete shell escaping in container-runner.ts (Finding #009)

### Medium Effort
- [ ] Implement secret detection/redaction in log output
- [ ] Add rate limiting on triggers
- [x] Audit all `path.join` usages for similar issues - Done for state/, need broader check
- [ ] Document web dashboard localhost-only design (Finding #012)

### Larger Projects
- [ ] Implement webhook signature verification (see Q1)
- [ ] Add audit logging for sensitive operations
- [ ] Consider config file integrity verification
- [ ] Review MCP server config validation (Q10)

---

## Code Patterns to Watch

When reviewing new code or PRs, pay attention to:

```typescript
// 🚨 User input in file paths - must use buildSafeFilePath
path.join(baseDir, userInput)  // DANGEROUS
buildSafeFilePath(baseDir, userInput, ext)  // SAFE

// 🚨 Shell execution - review for injection
execa(cmd, { shell: true })  // Risky - is it necessary?
execa(cmd, args)  // Safe - array arguments

// 🚨 Permission bypass - must be intentional
bypassPermissions: true  // Only in examples or with justification

// 🚨 Docker config override - document the need
hostConfigOverride: { ... }  // Accepted risk if justified

// 🚨 Logging sensitive data - check what's logged
console.log(config)  // Does config contain secrets?
logger.info({ token })  // Definitely bad

// 🚨 encodedPath collisions - now handled with cwd validation
encodePathForCli(path)  // Lossy encoding - collision detection added
```

---

## Change Log

| Date | Changes |
|------|---------|
| 2026-02-05 | Initial document created after first security review |
| 2026-02-05 | Added path traversal mitigation details |
| 2026-02-05 | Evening review: Added container-runner.ts shell escaping note |
| 2026-02-05 | Restructured: Added formal question tracking table with IDs and status |
| 2026-02-06 | Q2 answered: All user-controlled file paths verified safe |
| 2026-02-06 | Audit review: Added Q9-Q11 for deeper investigation of path safety edge cases |
| 2026-02-20 | Audit review: Added Q12-Q14 for OAuth credential security verification (Finding #011) |
| 2026-08-21 | Audit review: Q13 status updated to IMPROVED (commit 9e0b6fc); Q10 added for MCP security; Q12/Q14 moved to answered archive; path safety improvements documented |

