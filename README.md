# dsh-continuechat

English | [中文](README.zh.md)

Manually resume an interrupted DeepSeek Harness conversation.

When a turn ends early — stopped by hand, cut short by a failed model request, or truncated by the output-token limit — the harness leaves nothing behind but a "stopped" marker. This plugin adds the missing step: a `/continue` command and a **Continue** action at the end of the interrupted turn, so the run picks up exactly where it stopped instead of restarting.

## What it solves

| Situation | Without the plugin | With the plugin |
|---|---|---|
| You hit stop by accident | Retype "continue" yourself | Click **Continue** |
| A network or provider failure aborted the turn | Restate the context before the model resumes | The plugin hands the recorded failure to the model and resumes |
| The reply was cut off by the token limit | The harness says *send "continue"* — with no entry point | One click or one command continues the answer |

## Usage

### Command

```
/continue
/continue also fix the remaining three files
```

Text after the command name is appended to the continuation prompt as an "Additional instruction from the user" line.

The command's outcome (`已请求继续对话（中断原因：手动停止）。`) is rendered by the harness command plane; it never becomes a model message.

### Button

At the end of the turn that was cut short (after its `turn/end`), a **Continue** action appears:

- **It only appears on a real interruption.** Turns that completed, were blocked, or merely closed a fork show nothing, so the button never shows up under a conversation that ended normally.
- It appears only on the newest turn, and only when that turn ended with a resumable reason; every other turn footer renders nothing and takes no space.
- It appears even when the turn produced **no assistant output at all** — a request that failed outright, a process that died before streaming, or a crash recovery that only left the `turn/end` closer.
- It disappears again once the agent is running.
- Clicking it is exactly one `/continue` execution.
- A failed attempt keeps a short error line next to the action (hover for the full text).

The decision comes from the session's durable event window: the newest `turn/end` must have a resumable reason *and* the footer being rendered must belong to that same turn.

### Command menu

Type `/` and pick `continue` ("Continue the interrupted conversation from where it stopped"). Arrow keys plus Enter are enough — no draft typing required.

## How it works

### Interruption tracking (host half)

The plugin subscribes to the session log's `session/event` and tracks every turn end:

| `reason.kind` | Meaning | Resumable |
|---|---|---|
| `aborted` | Run cancelled. `reason.reason.kind` refines it: `user` stopped by hand, `parent` stopped by a parent operation, `hook` stopped by a harness hook, `disposed` session torn down | ✅ |
| `error` | Model request failed (network, auth, server) | ✅ |
| `max-tokens` | Reply truncated by the output-token limit (not a context-window overflow) | ✅ |
| `interrupted` | Turn closed by crash recovery after the host process was interrupted | ✅ |
| `completed` | Finished normally | ❌ |
| `blocked` | Step refused by `agent/pre-step` before entering | ❌ |
| `forked` | Fork seed closing an inherited prefix (the start of a new session) | ❌ |

Any later `user/message` clears the record — either the user took over, or the plugin already resumed the run.

### The continuation prompt

`/continue` does not send a bare "continue". It queues a structured user message:

```
<continue-conversation>
The previous turn ended early: the run was stopped by hand.
Continue the interrupted work in this same session, from exactly where it stopped:
- Do not restart the task, re-summarize, or repeat output and work that is already visible above.
- Treat the current workspace, tool results, and durable session state as authoritative; …
- If a tool call was interrupted, verify its outcome before retrying it, and never blindly retry an operation that may have side effects.
- Finish the remaining work, then verify the result before reporting it.
Failure recorded by the harness: <what the harness logged when the turn died>
Additional instruction from the user: <text typed after the command>
</continue-conversation>
```

The first line is rewritten per reason (stopped by hand / request failed / reply cut off / crash recovery), and the harness-recorded failure text is attached so the model knows *why* the turn ended — which is what decides between continuing to write and re-checking an interrupted tool call first.

### Why the answer is a separate message

After you press **Continue**, DSH opens a new turn for the model to write on, and the plugin then retires that turn's trigger prompt from the transcript — so you no longer see the prompt, and the interrupted reply is followed directly by the new text.

The retirement is a `system/message` replacement, and the log makes such an event *step-scoped*: its `turn`/`step` must name the step that is open as it lands, and both coordinates must be positive (`dsh-session-format-v3-to-v4/lib/index.js`, `assertV4SystemMessageFields` plus the relationship replay). A turn that has already ended names no open step, so the replacement cannot be written there. It rides the step that produced the model's answer to the prompt — or, for a turn that produced none, the next step that opens.

The new text **cannot be merged into the original message**. That is an architectural constraint of the DSH session log, not an implementation shortcut:

- The log is event-sourced: a committed assistant message cannot be edited, only shadowed by a surface `replace`.
- A `replace` must list every shadowed node in `sourceEventSeqs` (`dsh-session/lib/index.js:327`), while `assistant/message` is explicitly forbidden from carrying that field (`:313`, it embeds its provider stream). The two rules conflict, so no assistant event can perform a replacement.
- Shadowing the whole range with a `system/message` instead would also shadow the `tool/call` / `tool/result` pairs inside it, breaking the model history so the next request fails.

The provider side has no assistant prefill either (`dsh-llm-deepseek` carries only anthropic-beta flags), so the model cannot literally continue the previous assistant message — it must generate a new one.

The result: **no stray "continue" prompt, but still a separate new answer.**

### Message shape

The continuation message is built by hand as `{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'continue-chat' } }` and frozen:

- **The `id` is mandatory.** `Agent.inbox` deduplicates pending messages by `message.id` (a duplicate throws `already pending`) and never mints one, so the plugin generates it with `randomUUID()` from `node:crypto`.
- **`source.kind` is `continue-chat`.** Chat classifies a `user/message` by its source kind: `user` would render the prompt as a human bubble, while any other kind renders it as an injected-context node — and a context node whose content is plain text stays out of the visible node set. Never use `'plugin'` either: that is only the legacy format-v3 shape and format v4 rejects it when reading a log back.
- As a result the host half imports **nothing but `node:crypto`**: no `peerDependencies`, and therefore no exposure to the plugin version-compatibility gate.

### The browser half

The client half does exactly two things:

1. Registers the `continue-chat` dictionaries (zh/en).
2. Registers one action in the `conversation.chat.turnTail` slot. That is Chat's completed-turn footer chain, with owner props `{ turn, seq, openFile }`, and it renders for every closed turn.

Why not `conversation.chat.assistant-actions`: current Chat freezes an interrupted stream as an `assistant/live-chunk` partial that never becomes a durable `assistant/message` carrying a `messageId`, and its `interrupted: true` assistant branch has no `messageId` either; `assistant-actions` renders only when `closing.finalNode.messageId` exists, and a crash-recovered turn has no closing message at all. The turn footer renders for every `turn/end`, so it can host the action in every interruption shape.

Clicking it runs `ctx.remote.commands.execute(sessionId, '/continue', [])`, the same path a hand-typed `/continue` takes, so command lifecycle records, result rendering, and logging all stay identical.

Whether the footer being rendered belongs to an interrupted turn is answered by the session's own durable event window: `ctx.sessions.binding(sessionId).eventSource` is a plain `getSnapshot()`/`subscribe()` store, which the plugin reads through `React.useSyncExternalStore` — the newest `turn/end` reason and turn number, compared with the footer's `turn.turn`. Snapshots are memoized per `revision`, so dozens of turns share one scan and the untouched footers never re-render.

## Install

```powershell
dsh plugin --profile desktop add <absolute path to this directory>
```

The `dsh.bundle.patch` field points at `cordis.patch.yml`, which inserts the `continue-chat` row into the profile; `dsh.client.platform = "web"` makes the host serve `lib/client.js` as a browser bundle.

Remove it with:

```powershell
dsh plugin --profile desktop remove dsh-continuechat
```

## What it deliberately does not do

- **It never continues on its own.** Every trigger is human: a command, the button, or your own typing. For automatic continuation use the `goal` tool.
- **It never shows the button under a normally finished conversation.** The decision comes straight from the session log's `turn/end` reason; limiting it to the newest turn only keeps an old turn's button from pointing at a state that has moved on.
- **It never merges the new answer into the previous message.** That is impossible in this architecture (see above); the continuation is always a new assistant message, and the plugin only retires its own trigger prompt.
- **It never cuts in while the agent runs.** `/continue` against a running agent reports an error instead; stop the turn first.
- **It never rewrites history.** A continuation is one new user message appended to the log.
- **It never retires a prompt outside an open step.** The replacement is written from inside the step that answers the prompt, or from the next step that opens when a turn ends without an answer. That is the only position the log accepts, and it is why the retirement is not part of the `turn/end` handling.
- **It never replays the session log.** The plugin only observes events appended inside the current process, so the first `/continue` after a **DSH restart** reports "未记录中断原因" and falls back to the generic prompt — the resume still works, it just loses the reason detail.
- **It ships zero runtime dependencies.** The host half imports only `node:crypto`; the client half requires only `react` from the platform seed table. No build step, no `node_modules`.

## Development

```powershell
node --test test/host.test.mjs test/client.test.mjs
```

- `lib/index.js` — host half: interruption tracking plus the `/continue` command.
- `lib/client.js` — browser half: a hand-written `window.__ModuleLoader__` bundle (no build step).
- `test/host.test.mjs` — drives the host half through a tiny fake cordis context.
- `test/client.test.mjs` — drives the browser bundle through a tiny fake React.
- `tools/inspect-session.mjs` — decompresses a session log (many concatenated zstd frames) and lists the `/continue` triggers, retirement events, and turn boundaries, for checking the surface bookkeeping: `node tools/inspect-session.mjs <session dir>/session.v4.jsonl.zstd`.
- `tools/verify-retirement-coordinates.mjs` — runs the harness's own released-V4 validator over the three candidate coordinates, proving that only a replacement inside an open step is accepted: `node tools/verify-retirement-coordinates.mjs <app root>`.

## License

MIT
