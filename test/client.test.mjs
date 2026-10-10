/**
 * Behaviour tests for the dsh-continuechat browser bundle.
 *
 * The bundle is hand-written CommonJS-in-a-global-loader, so the test provides
 * the two things it reaches for: `window.__ModuleLoader__` and a minimal React.
 * Nothing here needs a browser, a build step, or the harness itself.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

//#region minimal React
/** Per-render hook slots, reset by {@link render}. */
let hookSlots = []
/** Current hook cursor inside one render pass. */
let hookCursor = 0

const ReactMock = {
  Fragment: 'Fragment',
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = initial
    return [
      hookSlots[index],
      (next) => {
        hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next
      },
    ]
  },
  useRef(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: initial }
    return hookSlots[index]
  },
  useEffect(effect) {
    const index = hookCursor++
    if (!(index in hookSlots)) {
      hookSlots[index] = true
      effect()
    }
  },
  /** The store read is enough here; subscription behaviour is the store's own. */
  useSyncExternalStore(subscribe, getSnapshot) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { subscribe, getSnapshot }
    return getSnapshot()
  },
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
}

/**
 * Render one component with a fresh hook cursor.
 * @param component - the function component.
 * @param props - its props.
 * @returns the produced element tree.
 */
function render(component, props) {
  hookCursor = 0
  return component(props)
}
//#endregion

//#region console capture
/** Diagnostics the plugin emits, captured so assertions can read them. */
const infoLogs = []
const warnLogs = []
console.info = (...args) => infoLogs.push(args.join(' '))
console.warn = (...args) => warnLogs.push(args.join(' '))
//#endregion

//#region bundle capture
/** The definition the bundle handed to the module loader. */
let bundle
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      bundle = definition
    },
  },
}

await import('../lib/client.js')

/**
 * Materialize the bundle factory with only `react` resolvable.
 * @returns the bundle's module exports.
 */
function loadBundle() {
  const require = (id) => {
    if (id === 'react') return ReactMock
    throw new Error(`unexpected require("${id}")`)
  }
  return bundle.factory(require)
}
//#endregion

//#region fixtures
/** Build one session event window entry. */
function entry(event) {
  return { type: 'persistent', event }
}

/** A turn that ended early, closing one assistant message. */
const interruptedEntries = [
  entry({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
  entry({ type: 'user/message', seq: 1, time: 2, data: { id: 'u1', role: 'user' } }),
  entry({
    type: 'assistant/message',
    seq: 2,
    time: 3,
    data: { turn: 1, step: 0, message: { id: 'm-interrupted', role: 'assistant' }, interrupted: true },
  }),
  entry({ type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
]

/** A turn that finished on its own. */
const completedEntries = [
  entry({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
  entry({ type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 0, message: { id: 'm-done', role: 'assistant' } } }),
  entry({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
]

/**
 * Build a session event feed shaped like the session controller's.
 * @param entries - the window entries.
 * @returns a `getSnapshot`/`subscribe` store.
 */
function createEventSource(entries) {
  const snapshot = { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  }
}

/**
 * Build a minimal client context capturing everything the plugin registers.
 * @param execute - the fake `remote.commands.execute` implementation.
 * @param eventSource - the feed the session binding exposes.
 * @returns the context plus its recorded state.
 */
function createClientHarness(execute, eventSource = createEventSource([])) {
  const locales = new Map()
  const injections = []
  const registrations = []
  const calls = []

  const ctx = {
    effect(effect) {
      return effect()
    },
    locale: {
      register(namespace, dictionaries) {
        locales.set(namespace, dictionaries)
        return () => locales.delete(namespace)
      },
      bind(namespace) {
        return (key) => locales.get(namespace)?.zh?.[key] ?? key
      },
    },
    sessions: {
      binding: () => ({ eventSource }),
    },
    slots: {
      inject(name, register) {
        injections.push({ name, register })
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    remote: {
      commands: {
        async execute(...args) {
          calls.push(args)
          return execute(...args)
        },
      },
    },
  }

  return { ctx, locales, injections, registrations, calls }
}

/** Materialize the single action registration the plugin makes (idempotent). */
function mountAction(harness) {
  if (harness.registrations.length === 0) {
    for (const injection of harness.injections) injection.register()
  }
  assert.equal(harness.registrations.length, 1)
  return harness.registrations[0]
}

/** Props one rendered action receives, with a chosen owning message. */
function actionProps(harness, messageId, overrides = {}) {
  const injected = mountAction(harness).options.inject('session-1')
  return {
    messageId,
    useSession: (select) => select({ running: false }),
    resumeSource: injected.resumeSource,
    resume: injected.resume,
    t: (key) => key,
    ...overrides,
  }
}
//#endregion

test('the bundle registers one loader definition', () => {
  assert.equal(bundle.id, 'dsh-continuechat')
  assert.equal(typeof bundle.factory, 'function')
})

test('the factory exports the cordis plugin surface', () => {
  const exports = loadBundle()
  assert.equal(exports.name, 'continue-chat/client')
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'remote', 'remote.commands', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the dictionaries and the assistant action row', () => {
  const exports = loadBundle()
  const harness = createClientHarness(async () => ({ ok: true, value: undefined }))
  exports.apply(harness.ctx)

  const dictionaries = harness.locales.get('continue-chat')
  assert.equal(dictionaries.zh['action.label'], '继续对话')
  assert.equal(dictionaries.en['action.label'], 'Continue')

  assert.equal(harness.injections.length, 1)
  assert.equal(harness.injections[0].name, 'conversation.chat.assistant-actions')

  const action = mountAction(harness)
  assert.equal(action.options.name, 'conversation.chat.assistant-actions')
  assert.equal(action.options.id, 'dsh-continuechat')
  assert.equal(action.options.locale, 'continue-chat')
  assert.equal(typeof action.options.inject, 'function')
  assert.ok(
    infoLogs.some((line) => line.includes('browser half ready') && line.includes('assistant-actions')),
    'the plugin announces the action row it registered into',
  )
})

test('the action only renders on the message that closed an interrupted turn', () => {
  const exports = loadBundle()
  const harness = createClientHarness(
    async () => ({ ok: true, value: undefined }),
    createEventSource(interruptedEntries),
  )
  exports.apply(harness.ctx)
  const component = mountAction(harness).component

  hookSlots = []
  const shown = component(actionProps(harness, 'm-interrupted'))
  assert.notEqual(shown, null)
  assert.equal(shown.props.children[0].type, 'button')
  assert.ok(infoLogs.some((line) => line.includes('resumable turn (aborted)')))

  hookSlots = []
  assert.equal(component(actionProps(harness, 'some-earlier-message')), null)
})

test('a turn that finished normally offers no action', () => {
  const exports = loadBundle()
  const harness = createClientHarness(
    async () => ({ ok: true, value: undefined }),
    createEventSource(completedEntries),
  )
  exports.apply(harness.ctx)
  const component = mountAction(harness).component

  hookSlots = []
  assert.equal(component(actionProps(harness, 'm-done')), null)
})

test('blocked and forked turn ends offer no action', () => {
  for (const kind of ['blocked', 'forked']) {
    const exports = loadBundle()
    const harness = createClientHarness(
      async () => ({ ok: true, value: undefined }),
      createEventSource([
        entry({ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 0, message: { id: 'm' } } }),
        entry({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind } } }),
      ]),
    )
    exports.apply(harness.ctx)
    hookSlots = []
    assert.equal(mountAction(harness).component(actionProps(harness, 'm')), null)
  }
})

test('a truncated reply offers the action', () => {
  for (const kind of ['max-tokens', 'error', 'interrupted']) {
    const exports = loadBundle()
    const harness = createClientHarness(
      async () => ({ ok: true, value: undefined }),
      createEventSource([
        entry({ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 0, message: { id: 'm' } } }),
        entry({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind } } }),
      ]),
    )
    exports.apply(harness.ctx)
    hookSlots = []
    assert.notEqual(mountAction(harness).component(actionProps(harness, 'm')), null, kind)
  }
})

test('the action hides while the agent is running again', () => {
  const exports = loadBundle()
  const harness = createClientHarness(
    async () => ({ ok: true, value: undefined }),
    createEventSource(interruptedEntries),
  )
  exports.apply(harness.ctx)
  const component = mountAction(harness).component

  hookSlots = []
  const props = actionProps(harness, 'm-interrupted', { useSession: (select) => select({ running: true }) })
  assert.equal(component(props), null)
})

test('resume runs the host /continue command for its own session', async () => {
  const exports = loadBundle()
  const harness = createClientHarness(async () => ({
    ok: true,
    value: { result: { kind: 'success', text: '已请求继续对话。' }, commandId: 'c1' },
  }))
  exports.apply(harness.ctx)

  const failure = await mountAction(harness).options.inject('session-42').resume()

  assert.equal(failure, null)
  assert.deepEqual(harness.calls, [['session-42', '/continue', []]])
})

test('a refused RPC is reported as a failure message', async () => {
  const exports = loadBundle()
  const harness = createClientHarness(async () => ({
    ok: false,
    error: { code: 'UNAVAILABLE', message: 'connection closed' },
  }))
  exports.apply(harness.ctx)

  const failure = await mountAction(harness).options.inject('s').resume()
  assert.equal(failure, 'connection closed (UNAVAILABLE)')
})

test('an unknown command name is reported instead of silently succeeding', async () => {
  const exports = loadBundle()
  const harness = createClientHarness(async () => ({ ok: true, value: undefined }))
  exports.apply(harness.ctx)

  const failure = await mountAction(harness).options.inject('s').resume()
  assert.match(failure, /未找到 \/continue 命令/u)
})

test('a handler error result is surfaced as the failure message', async () => {
  const exports = loadBundle()
  const harness = createClientHarness(async () => ({
    ok: true,
    value: { result: { kind: 'error', text: '对话仍在运行中：请先停止当前轮次，再执行 /continue。' }, commandId: 'c2' },
  }))
  exports.apply(harness.ctx)

  const failure = await mountAction(harness).options.inject('s').resume()
  assert.equal(failure, '对话仍在运行中：请先停止当前轮次，再执行 /continue。')
})

test('clicking flips the label to busy and calls resume once', () => {
  const exports = loadBundle()
  const harness = createClientHarness(
    async () => ({ ok: true, value: undefined }),
    createEventSource(interruptedEntries),
  )
  exports.apply(harness.ctx)
  const component = mountAction(harness).component

  let resumed = 0
  const props = actionProps(harness, 'm-interrupted', {
    resume: async () => {
      resumed += 1
      return null
    },
  })

  hookSlots = []
  const tree = render(component, props)
  const [button, error] = tree.props.children
  assert.equal(button.type, 'button')
  assert.equal(error, null)
  assert.equal(button.props.title, 'action.title')
  const [glyph, label] = button.props.children
  assert.equal(glyph.type, 'svg')
  assert.equal(label, 'action.label')

  button.props.onClick()
  assert.equal(resumed, 1)
  hookCursor = 0
  const busyTree = component(props)
  assert.equal(busyTree.props.children[0].props.children[1], 'action.busy')
  assert.equal(busyTree.props.children[0].props.disabled, true)
})

test('a failed attempt keeps the failure on the action', async () => {
  const exports = loadBundle()
  const harness = createClientHarness(
    async () => ({ ok: true, value: undefined }),
    createEventSource(interruptedEntries),
  )
  exports.apply(harness.ctx)
  const component = mountAction(harness).component

  const props = actionProps(harness, 'm-interrupted', { resume: async () => '对话仍在运行中' })

  hookSlots = []
  render(component, props) // mount: seeds the hook slots
  hookCursor = 0
  component(props).props.children[0].props.onClick()

  await Promise.resolve()
  await Promise.resolve()
  hookCursor = 0
  const settled = component(props)

  assert.equal(settled.props.children[0].props.children[1], 'action.label')
  assert.equal(settled.props.children[1].props.className, 'dshContinueChat_failure')
  assert.equal(settled.props.children[1].props.title, '对话仍在运行中')
})

test('an unbound session degrades to no action instead of throwing', () => {
  const exports = loadBundle()
  const harness = createClientHarness(async () => ({ ok: true, value: undefined }))
  harness.ctx.sessions.binding = () => undefined
  exports.apply(harness.ctx)
  const component = mountAction(harness).component

  hookSlots = []
  assert.equal(component(actionProps(harness, 'm')), null)
  assert.ok(warnLogs.some((line) => line.includes('no client session binding')))
})
