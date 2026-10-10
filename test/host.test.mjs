/**
 * Behaviour tests for the dsh-continuechat host plugin.
 *
 * The plugin touches no external service beyond the injected cordis context, so
 * a tiny in-memory harness is enough to exercise the interruption tracking, the
 * `/continue` command, and the retirement of its trigger prompt.
 *
 * The harness reproduces two constraints the real session store enforces and
 * that a naive fake would hide:
 *
 * - the session object handed to `session/event` is the one the agent writes
 *   through, and it is the only thing that can append;
 * - an `append` reentered from inside its own publication is rejected, so a
 *   listener that writes back must defer.
 *
 * A third constraint lives in the log format rather than the store: a
 * `system/message` is step-scoped, so the retirement tests assert the
 * coordinates of the step that was open when it landed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** Let every queued microtask and timer callback run. */
const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

/**
 * Build a minimal cordis context that records registrations and lets the test
 * fire `session/event` the way the session store does.
 * @returns the context, its captured state, and an event emitter.
 */
function createHarness() {
  const listeners = new Map()
  const commands = new Map()
  const disposers = []
  const warnings = []

  const ctx = {
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
    /** Collect one lifecycle listener; the plugin relies on cordis effect scoping. */
    on(event, handler) {
      const bucket = listeners.get(event) ?? []
      bucket.push(handler)
      listeners.set(event, bucket)
      return () => {}
    },
    /** Run the plugin's lifecycle generator, keeping every yielded disposer. */
    effect(generator) {
      const iterator = generator()
      let step = iterator.next()
      while (step.done !== true) {
        disposers.push(step.value)
        step = iterator.next()
      }
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
  }

  return {
    ctx,
    commands,
    disposers,
    warnings,
    /**
     * Deliver one session event to every registered listener, marked as a
     * publishing append so a reentrant `append` is rejected exactly as the real
     * store rejects it.
     */
    emit(session, event) {
      const previous = session.publishing
      session.publishing = true
      try {
        for (const handler of listeners.get('session/event') ?? []) handler(session, event)
      } finally {
        session.publishing = previous
      }
    },
  }
}

/**
 * Build an idle agent bound to one session whose log records every write.
 * @param sessionId - session identity the agent serves.
 * @returns the fake agent, its session, the queued messages, and the log writes.
 */
function createAgent(sessionId) {
  const sent = []
  const appended = []
  const session = {
    id: sessionId,
    publishing: false,
    append(type, data, opts) {
      if (this.publishing) {
        throw new Error('session append cannot reenter while another append is being published')
      }
      appended.push({ type, data, opts })
    },
  }
  const agent = {
    id: `agent-${sessionId}`,
    status: 'idle',
    session,
    followup(message) {
      sent.push(message)
    },
  }
  return { agent, session, sent, appended }
}

/** Fire one turn start. */
function startTurn(harness, session, turn, seq = turn) {
  harness.emit(session, { type: 'turn/start', seq, time: 1_700_000_000_000, data: { turn } })
}

/** Fire one step start inside a turn. */
function startStep(harness, session, turn, step, seq) {
  harness.emit(session, { type: 'step/start', seq, time: 1_700_000_000_000, data: { turn, step } })
}

/** Fire the model's answer for one step. */
function answerStep(harness, session, turn, step, seq) {
  harness.emit(session, {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000,
    data: {
      turn,
      step,
      message: { id: `m-${turn}-${step}`, role: 'assistant', content: [], source: { kind: 'model' } },
      stream: [],
    },
  })
}

/** Fire one turn end with the given reason. */
function endTurn(harness, session, reason, seq = 7, turn = 1) {
  harness.emit(session, { type: 'turn/end', seq, time: 1_700_000_000_000, data: { turn, reason } })
}

/** Fire the durable record of one admitted user message. */
function admitUserMessage(harness, session, message, seq) {
  harness.emit(session, { type: 'user/message', seq, time: 1_700_000_000_000, data: message })
}

/** Run `/continue` and return its settled result. */
function runContinue(harness, agent, rawInput = '') {
  return harness.commands.get('continue').handler({ agent, rawInput })
}

test('declares the plugin contract', () => {
  assert.equal(name, 'continue-chat')
  assert.deepEqual(inject, ['agents', 'sessions', 'commands'])
})

test('registers the /continue command on apply', () => {
  const harness = createHarness()
  apply(harness.ctx)
  assert.ok(harness.commands.has('continue'))
  assert.equal(typeof harness.commands.get('continue').handler, 'function')
})

test('a hand-stopped turn is resumed with the aborted reason', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('s1')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  const result = runContinue(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /手动停止/u)
  assert.equal(sent.length, 1)
  const message = sent[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'continue-chat', 'a non-user source keeps the prompt out of the human bubbles')
  assert.equal(message.source.form, 'notice')
  assert.equal(typeof message.source.summary, 'string')
  assert.match(message.content[0].text, /（自动续写）上一条回答被中断了（手动停止）/u)
  assert.match(message.content[0].text, /不要重复已输出的内容/u)
  assert.ok(Object.isFrozen(message))
})

test('an errored turn carries the recorded failure detail', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('s2')

  endTurn(harness, session, {
    kind: 'error',
    error: { code: 'NETWORK', message: 'connection reset\n  while reading response' },
  })
  const result = runContinue(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /模型请求失败/u)
  assert.match(sent[0].content[0].text, /宿主记录的中断原因：connection reset while reading response/u)
})

test('a token-limited reply is reported as a cut-off answer', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('s3')

  endTurn(harness, session, { kind: 'max-tokens' })
  const result = runContinue(harness, agent, '  focus on the tests  ')

  assert.equal(result.kind, 'success')
  assert.match(result.text, /输出 token 上限截断/u)
  assert.match(sent[0].content[0].text, /上一条回答被中断了（输出 token 上限截断）/u)
  assert.match(sent[0].content[0].text, /用户的补充要求：focus on the tests/u)
})

test('a crash-recovery turn end is resumable', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('s3b')

  endTurn(harness, session, { kind: 'interrupted' })
  const result = runContinue(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /进程中断/u)
  assert.match(sent[0].content[0].text, /上一条回答被中断了（进程中断/u)
})

test('every abort cause gets its own wording', () => {
  const cases = [
    ['parent', /被上级操作取消/u],
    ['disposed', /会话销毁中止/u],
    ['hook', /被钩子取消/u],
  ]
  for (const [cause, label] of cases) {
    const harness = createHarness()
    apply(harness.ctx)
    const { agent, session, sent } = createAgent(`s-${cause}`)

    endTurn(harness, session, { kind: 'aborted', reason: { kind: cause } })
    const result = runContinue(harness, agent)

    assert.match(result.text, label)
    assert.match(sent[0].content[0].text, label)
  }
})

test('a completed, blocked, or forked turn is not resumable on its own', () => {
  for (const reason of [{ kind: 'completed' }, { kind: 'blocked' }, { kind: 'forked' }]) {
    const harness = createHarness()
    apply(harness.ctx)
    const { agent, session, sent } = createAgent(`s-${reason.kind}`)

    endTurn(harness, session, { kind: 'max-tokens' })
    endTurn(harness, session, reason)
    const result = runContinue(harness, agent)

    assert.match(result.text, /未记录中断原因/u)
    assert.doesNotMatch(sent[0].content[0].text, /输出 token 上限截断/u)
  }
})

test('a normally completed turn clears the resumable state', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('s4')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  endTurn(harness, session, { kind: 'completed' })
  const result = runContinue(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /未记录中断原因/u)
  assert.doesNotMatch(sent[0].content[0].text, /手动停止/u)
})

test('a new user message clears the resumable state', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session } = createAgent('s5')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  admitUserMessage(harness, session, { id: 'm1', role: 'user' }, 8)
  const result = runContinue(harness, agent)

  assert.match(result.text, /未记录中断原因/u)
})

test('a running agent is refused instead of queued twice', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('s6')
  agent.status = 'running'

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  const result = runContinue(harness, agent)

  assert.equal(result.kind, 'error')
  assert.match(result.text, /仍在运行中/u)
  assert.equal(sent.length, 0)
})

test('interruption state is per session', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const one = createAgent('a')
  const two = createAgent('b')

  endTurn(harness, one.session, { kind: 'max-tokens' })
  const resultA = runContinue(harness, one.agent)
  const resultB = runContinue(harness, two.agent)

  assert.match(resultA.text, /输出 token 上限截断/u)
  assert.match(resultB.text, /未记录中断原因/u)
})

test('the trigger prompt is retired inside the step that answers it', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent, appended } = createAgent('r1')

  startTurn(harness, session, 1)
  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } }, 2)
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: sent[0].id, role: 'user' }, 10)
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  answerStep(harness, session, 2, 1, 13)
  await flush()

  assert.equal(appended.length, 1)
  const retirement = appended[0]
  assert.equal(retirement.type, 'system/message')
  assert.equal(retirement.data.turn, 2, 'the replacement names the step that was open, not the closed trigger turn')
  assert.equal(retirement.data.step, 1)
  assert.ok(Number.isSafeInteger(retirement.data.step) && retirement.data.step >= 1, 'format v4 requires a positive step')
  assert.equal(retirement.data.message.role, 'system')
  assert.deepEqual(retirement.data.message.content, [], 'an empty system node derives no message')
  assert.deepEqual(retirement.data.message.source, { kind: 'system-prompt' })
  assert.deepEqual(retirement.opts, {
    surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 },
    sourceEventSeqs: [10],
  })
})

test('a turn that never answers leaves the retirement to the next open step', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent, appended } = createAgent('r1a')

  startTurn(harness, session, 1)
  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } }, 2)
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: sent[0].id, role: 'user' }, 10)
  // The continuation request failed before producing any message, so the
  // trigger turn closes with nothing to ride.
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  endTurn(harness, session, { kind: 'error' }, 13, 2)
  await flush()
  assert.equal(appended.length, 0, 'a closed turn cannot carry a step-scoped replacement')

  startTurn(harness, session, 3, 14)
  startStep(harness, session, 3, 1, 15)
  await flush()

  assert.equal(appended.length, 1)
  assert.equal(appended[0].data.turn, 3)
  assert.equal(appended[0].data.step, 1)
  assert.deepEqual(appended[0].opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 10 })
})

test('a prompt the surface never admitted is dropped when its turn ends', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, appended } = createAgent('r1c')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  endTurn(harness, session, { kind: 'completed' }, 11)
  startTurn(harness, session, 2, 12)
  startStep(harness, session, 2, 1, 13)
  await flush()

  assert.equal(appended.length, 0)
})

test('the retirement is deferred, never appended from inside the publication', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent, appended } = createAgent('r1b')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: sent[0].id, role: 'user' }, 10)
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  answerStep(harness, session, 2, 1, 13)

  // The assistant/message publication has returned, but the deferred write has not run.
  assert.equal(appended.length, 0, 'no append may reenter the publishing append')
  await flush()
  assert.equal(appended.length, 1)
  assert.deepEqual(harness.warnings, [], 'a deferred append never trips the reentry guard')
})

test('the retirement shadows exactly one node, never more', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent, appended } = createAgent('r2')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: sent[0].id, role: 'user' }, 10)
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  answerStep(harness, session, 2, 1, 13)
  await flush()

  const { startSeq, endSeq } = appended[0].opts.surfaceOp
  assert.equal(startSeq, endSeq)
  assert.deepEqual(appended[0].opts.sourceEventSeqs, [startSeq])
})

test('a foreign user message never claims the retirement slot', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, appended } = createAgent('r3')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: 'someone-else', role: 'user' }, 10)
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  answerStep(harness, session, 2, 1, 13)
  endTurn(harness, session, { kind: 'completed' }, 14, 2)
  await flush()

  assert.equal(appended.length, 0)
})

test('a prompt whose id was rewritten is still claimed by its producer kind', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent, appended } = createAgent('r3b')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  // The loop appended a message the plugin did not mint: same producer, new id.
  admitUserMessage(
    harness,
    session,
    { id: 'rewritten-by-the-loop', role: 'user', source: sent[0].source },
    10,
  )
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  answerStep(harness, session, 2, 1, 13)
  await flush()

  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 10 })
})

test('a failed retirement is logged without breaking the turn', async () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session, sent } = createAgent('r4')
  session.append = () => {
    throw new Error('surface replace: start seq 10 not found in surface')
  }

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: sent[0].id, role: 'user' }, 10)
  startTurn(harness, session, 2, 11)
  startStep(harness, session, 2, 1, 12)
  assert.doesNotThrow(() => answerStep(harness, session, 2, 1, 13))
  await flush()

  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /could not retire the continuation prompt at seq 10/u)
})

test('an interrupted continuation is resumable again', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const { agent, session } = createAgent('r5')

  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } })
  runContinue(harness, agent)
  admitUserMessage(harness, session, { id: 'unrelated', role: 'user' }, 10)
  endTurn(harness, session, { kind: 'aborted', reason: { kind: 'user' } }, 11)

  const result = runContinue(harness, agent)
  assert.match(result.text, /手动停止/u)
})
