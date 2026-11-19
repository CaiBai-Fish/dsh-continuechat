/**
 * Manually resume a conversation whose turn stopped early.
 *
 * The harness records every turn end in the session log. This plugin keeps the
 * ones that left the conversation resumable — a run stopped by hand, a model
 * request that failed, a reply cut off by the output token limit, a turn closed
 * by crash recovery — and turns them into one human-facing action: `/continue`
 * queues a continuation prompt, then hides that prompt again from inside the
 * step that answers it, so the transcript reads as the interrupted reply
 * carrying straight on.
 *
 * Why the answers cannot be merged into one message: the provider has no
 * assistant-prefill support, so the model must generate a new message, and a
 * surface `replace` cannot fold it back — `assistant/message` is forbidden from
 * carrying `sourceEventSeqs` (it embeds its provider stream), while every
 * replacement must list each shadowed surface node. Folding the range with a
 * non-assistant event instead would also shadow the `tool/call` / `tool/result`
 * pairs inside it, which breaks the model history. What is left — and what this
 * plugin does — is to remove only the trigger prompt, which is safe because the
 * next request does not need it.
 *
 * When that removal can land is fixed by the log, not by taste: a
 * `system/message` is step-scoped, so its `turn`/`step` must name the step that
 * is open as it lands, and both coordinates must be positive. A turn that has
 * already ended is therefore no place for it. The replacement rides the step
 * that carried the model's answer to the prompt — or, for a turn that never
 * produced one, the next step that opens.
 *
 * @module dsh-continuechat
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name. */
const name = 'continue-chat'

/** Services required before {@link apply} runs. */
const inject = ['agents', 'sessions', 'commands']

/** Short human-facing copy for an `aborted` turn end, keyed by `AgentCancelCause.kind`. */
const ABORT_LABEL = {
  user: '手动停止',
  parent: '被上级操作取消',
  disposed: '会话销毁中止',
  hook: '被钩子取消',
  legacy: '运行中止',
}

/** Short human-facing copy for every other resumable turn end, keyed by `TurnEndReason.kind`. */
const REASON_LABEL = {
  error: '模型请求失败',
  'max-tokens': '输出 token 上限截断',
  interrupted: '进程中断（崩溃恢复）',
}

/** Label shown when the command runs without a recorded interruption. */
const NO_RECORD = { label: '未记录中断原因' }

/**
 * Source kind of the continuation prompt. It doubles as the Chat rendering
 * branch: anything other than `user` renders as injected context instead of a
 * human bubble, and a plain-text context node stays out of the visible set.
 */
const PROMPT_SOURCE_KIND = 'continue-chat'

/**
 * Extract the failure text the harness recorded on an errored turn end.
 * @param reason - the `turn/end` reason payload.
 * @returns a short failure description, or the empty string when absent.
 */
function failureDetail(reason) {
  const message = reason?.error?.message
  if (typeof message !== 'string') return ''
  const collapsed = message.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed
}

/**
 * Describe one resumable turn end.
 * @param reason - the `turn/end` reason payload, or undefined when unknown.
 * @returns the short label and any recorded failure text.
 */
function describeInterruption(reason) {
  const kind = reason?.kind
  if (kind === 'aborted') {
    const cause = reason.reason?.kind
    return {
      label: ABORT_LABEL[cause] ?? ABORT_LABEL.legacy,
      detail: '',
    }
  }
  if (kind in REASON_LABEL) {
    return { label: REASON_LABEL[kind], detail: failureDetail(reason) }
  }
  return { label: NO_RECORD.label, detail: '' }
}

/**
 * Judge whether one turn end leaves the conversation resumable.
 *
 * `completed` finished the work and `blocked` was refused before entering a
 * step; `forked` closes an inherited prefix. The rest stopped a run that still
 * has work in it.
 * @param kind - the `turn/end` reason kind.
 * @returns whether `/continue` should treat the turn as interrupted.
 */
function isResumable(kind) {
  return kind === 'aborted' || kind === 'error' || kind === 'max-tokens' || kind === 'interrupted'
}

/**
 * Render the continuation prompt. It is normally hidden again as soon as the
 * turn ends, but it stays readable in case the hiding append fails or the
 * session is read before that happens.
 * @param described - the description produced by {@link describeInterruption}.
 * @param extra - additional instruction typed after the command name.
 * @returns the complete prompt text for `Agent.followup()`.
 */
function renderContinuationPrompt(described, extra) {
  const lines = [
    `（自动续写）上一条回答被中断了（${described.label}），请直接从断点往下写：`,
    '不要重复已输出的内容，也不要加前言、标题或「继续」之类的过渡语，第一个字就接着上一句。',
    '工作区、工具结果和会话状态是权威事实；被打断的工具调用先确认结果再决定是否重试，有副作用的操作不要盲目重试。',
  ]
  if (described.detail !== '') lines.push(`（宿主记录的中断原因：${described.detail}）`)
  if (extra !== '') lines.push(`（用户的补充要求：${extra}）`)
  return lines.join('\n')
}

/**
 * Build one identified, immutable user-role message without importing the LLM
 * package, so this plugin keeps a zero-dependency host surface. `Agent.inbox`
 * deduplicates pending messages by id and never mints one, so the id is
 * mandatory.
 *
 * The source deliberately is **not** `kind: 'user'`: Chat classifies a
 * `user/message` by its source kind, and anything other than `user` renders as
 * an injected-context node instead of a human bubble. A context node whose
 * content is plain text stays out of the visible node set entirely.
 * @param text - the complete prompt text.
 * @returns a frozen user message ready for `Agent.followup()`.
 */
function createUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: PROMPT_SOURCE_KIND,
      form: 'notice',
      summary: '从断点继续被中断的对话',
    }),
  })
}

/**
 * Build the empty system message that retires one trigger prompt from the
 * surface. An empty system node derives no message, so the replacement leaves
 * nothing visible behind.
 * @returns the frozen replacement payload for `surfaceOp: { op: 'replace' }`.
 */
function createRetirement() {
  return Object.freeze({
    id: randomUUID(),
    role: 'system',
    content: Object.freeze([]),
    source: Object.freeze({ kind: 'system-prompt' }),
  })
}

/**
 * Register the `/continue` command and track which conversations can be resumed.
 * @param ctx - context carrying the agent registry, sessions, and command plane.
 */
function apply(ctx) {
  /** Session id → the `turn/end` reason that left it resumable. */
  const interruptions = new Map()
  /** Session id → the continuation prompt awaiting the step that retires it. */
  const triggers = new Map()

  /**
   * Retire the trigger prompt from the surface from inside an open step.
   *
   * The replacement shadows exactly that one node, so nothing else — least of
   * all a tool call and its result — leaves the model history. Its coordinates
   * are the open step's, because the log rejects any other pair.
   * @param session - the session whose log grew.
   * @param trigger - the recorded prompt identity and the seq it landed on.
   * @param step - the step that is open, which the replacement must name.
   */
  function retireTrigger(session, trigger, step) {
    // This is called from inside a `session/event` callback, and the session
    // store refuses to reenter `append` while another append is publishing
    // ("session append cannot reenter while another append is being
    // published"). The publishing append clears that flag in its own finally,
    // before returning, so deferring by one microtask is enough to land after
    // it — and the step it names stays open across that microtask, because the
    // loop only reaches `step/end` through its awaited request.
    queueMicrotask(() => {
      try {
        session.append(
          'system/message',
          {
            turn: step.turn,
            step: step.step,
            message: createRetirement(),
          },
          {
            surfaceOp: { op: 'replace', startSeq: trigger.seq, endSeq: trigger.seq },
            sourceEventSeqs: [trigger.seq],
          },
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(
          `continue-chat: could not retire the continuation prompt at seq ${trigger.seq}: ${detail}`,
        )
      }
    })
  }

  /**
   * Observe step boundaries, turn boundaries, and user input to maintain both
   * the resumable set and the pending prompt retirements.
   * @param session - the session whose log grew.
   * @param event - the appended event, exactly as recorded.
   */
  function observeSessionEvent(session, event) {
    if (event.type === 'step/start') {
      const trigger = triggers.get(session.id)
      if (trigger?.retirable === true && trigger.seq !== undefined) {
        triggers.delete(session.id)
        retireTrigger(session, trigger, { turn: event.data?.turn, step: event.data?.step })
      }
      return
    }
    if (event.type === 'assistant/message') {
      // The prompt has been read once the model answers it, so the reply's own
      // step is the first place the replacement can land. A turn that never
      // produces one leaves the prompt to the next step that opens.
      const trigger = triggers.get(session.id)
      if (trigger !== undefined && trigger.seq !== undefined) {
        triggers.delete(session.id)
        retireTrigger(session, trigger, { turn: event.data?.turn, step: event.data?.step })
      }
      return
    }
    if (event.type === 'user/message') {
      // Any admitted user input means someone already picked the work back up.
      interruptions.delete(session.id)
      const trigger = triggers.get(session.id)
      if (trigger !== undefined && trigger.seq === undefined) {
        // The queued prompt is the first admission to reach the surface after
        // `/continue`, so arrival order is the reliable signal — the loop may
        // re-create the message it appends. A real human message can never be
        // claimed here: the agent is busy by then, so it queues instead.
        const source = event.data?.source?.kind
        if (event.data?.id === trigger.messageId || source === PROMPT_SOURCE_KIND) {
          trigger.seq = event.seq
        }
      }
      return
    }
    if (event.type === 'turn/end') {
      const trigger = triggers.get(session.id)
      if (trigger !== undefined) {
        // The prompt has served its turn; only the surface still holds it. A
        // prompt the surface never admitted has nothing to retire, and one that
        // did waits here for the next step to open.
        if (trigger.seq === undefined) triggers.delete(session.id)
        else trigger.retirable = true
      }
      const reason = event.data?.reason
      if (isResumable(reason?.kind)) interruptions.set(session.id, reason)
      else interruptions.delete(session.id)
    }
  }

  /**
   * Execute one `/continue [extra instruction]` request against its agent.
   * @param invocation - the command invocation supplied by the adapter.
   * @returns a settled human-facing result.
   */
  function executeContinue({ agent, rawInput }) {
    if (agent.status !== 'idle') {
      return {
        kind: 'error',
        text: '对话仍在运行中：请先停止当前轮次，再执行 /continue。',
      }
    }
    const session = agent.session
    const described = describeInterruption(interruptions.get(session.id))
    const extra = typeof rawInput === 'string' ? rawInput.trim() : ''
    const message = createUserMessage(renderContinuationPrompt(described, extra))
    // Registered before queueing: waking the driver can reach the surface
    // before this call returns, and the prompt must already be on the ledger
    // for that first admission to claim its slot.
    triggers.set(session.id, { messageId: message.id, seq: undefined, retirable: false })
    try {
      agent.followup(message)
    } catch (error) {
      triggers.delete(session.id)
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `无法排入继续请求：${detail}` }
    }
    interruptions.delete(session.id)
    return { kind: 'success', text: `已请求继续对话（中断原因：${described.label}）。` }
  }

  ctx.effect(function* () {
    ctx.on('session/event', observeSessionEvent)

    yield async function dispose() {
      interruptions.clear()
      triggers.clear()
    }

    yield ctx.commands.register({
      name: 'continue',
      description: 'Continue the interrupted conversation from where it stopped | 从断点继续被中断的对话',
      input: { hint: '[补充指令]' },
      handler: executeContinue,
    })
  }, 'continue-chat lifecycle')
}

export { apply, inject, name }
