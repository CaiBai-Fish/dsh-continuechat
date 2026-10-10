/**
 * Prove the retirement coordinate rule against the harness's own validator.
 *
 * The plugin writes one `system/message` replacement to retire its trigger
 * prompt. Such an event is step-scoped, so its coordinates are not a free
 * choice: this script builds the smallest session artifacts that differ only in
 * where that replacement lands, and runs the released-V4 restore — the exact
 * check the log reader and writer share.
 *
 * Usage:
 *   node tools/verify-retirement-coordinates.mjs <app root>
 *
 * `<app root>` is the installed harness directory holding `node_modules`, e.g.
 * `D:\DSH-Desktop\DSH Desktop\resources\app`. `DSH_APP_ROOT` is accepted too.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const appRoot = process.argv[2] ?? process.env.DSH_APP_ROOT
if (appRoot === undefined || appRoot === '') {
  console.error('usage: node tools/verify-retirement-coordinates.mjs <app root | $DSH_APP_ROOT>')
  process.exit(2)
}

const modules = join(appRoot, 'node_modules', '@deepseek-ai')
const { restoreReleasedV4Artifact } = await import(
  pathToFileURL(join(modules, 'dsh-session-format-v3-to-v4', 'lib', 'index.js')).href
)
const { KNOWN_SESSION_EVENT_TYPES } = await import(
  pathToFileURL(join(modules, 'dsh-session', 'lib', 'types', 'known-event-types.js')).href
)

const SYSTEM = {
  id: 'sys-1',
  role: 'system',
  content: [{ type: 'text', text: 'system prompt' }],
  source: { kind: 'system-prompt' },
}
const PROMPT = {
  id: 'prompt-1',
  role: 'user',
  content: [{ type: 'text', text: '（自动续写）…' }],
  source: { kind: 'continue-chat', form: 'notice', summary: 'resume' },
}
const RETIREMENT = { id: 'retire-1', role: 'system', content: [], source: { kind: 'system-prompt' } }

/**
 * Build a closed one-step turn whose surface holds the trigger prompt, plus one
 * replacement event at `where`.
 * @param where - insertion index and the coordinates to claim.
 * @returns a complete artifact for {@link restoreReleasedV4Artifact}.
 */
function artifact(where) {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      seq: 2,
      time: 3,
      data: { turn: 1, step: 1, message: SYSTEM },
      surfaceOp: 'append',
    },
    { type: 'user/message', seq: 3, time: 4, data: PROMPT, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  events.splice(where.index, 0, {
    type: 'system/message',
    time: 7,
    data: { ...where.data, message: RETIREMENT },
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
    sourceEventSeqs: [3],
  })
  events.forEach((event, index) => {
    event.seq = index
  })
  return {
    header: {
      version: 4,
      id: 'session-retirement-check',
      createdAt: 1,
      isSeeded: false,
      cwd: process.cwd(),
      delegationDepth: 0,
    },
    inheritedEventCount: 0,
    events,
  }
}

const CASES = [
  {
    name: 'replacement inside the step that answers the prompt',
    where: { index: 4, data: { turn: 1, step: 1 } },
    expect: undefined,
  },
  {
    name: 'replacement claiming step 0 (the retired bug)',
    where: { index: 6, data: { turn: 1, step: 0 } },
    expect: 'format v4 system/message step must be positive',
  },
  {
    name: 'replacement with a positive step after the turn closed',
    where: { index: 6, data: { turn: 1, step: 1 } },
    expect: 'system/message does not match an open turn and step',
  },
]

let failed = 0
for (const item of CASES) {
  let error
  try {
    restoreReleasedV4Artifact(artifact(item.where), KNOWN_SESSION_EVENT_TYPES)
  } catch (caught) {
    error = caught
  }
  const actual = error?.message
  if (actual === item.expect) {
    console.log(`ok   ${item.name}${actual === undefined ? '' : ` → refused: ${actual}`}`)
  } else {
    failed += 1
    console.log(`FAIL ${item.name}\n     expected ${JSON.stringify(item.expect)}, got ${JSON.stringify(actual)}`)
  }
}

console.log(failed === 0 ? '\nretirement coordinates verified' : `\n${failed} case(s) failed`)
process.exit(failed === 0 ? 0 : 1)
