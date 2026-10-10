/**
 * Inspect the surface bookkeeping of one DSH session log.
 *
 * Reports every continuation prompt the plugin queued, every retirement
 * (`system/message` replacement) it wrote, and the turn ends around them. The
 * log is a directory holding `session.v4.jsonl.zstd`, which is a concatenation
 * of many zstd frames — one per append batch — so it cannot be read with a
 * single `zstdDecompressSync` call.
 *
 * Usage: node tools/inspect-session.mjs <path/to/session.v4.jsonl.zstd>
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PROMPT_MARKER = '自动续写'

/**
 * Decompress every concatenated zstd frame, tolerating magic bytes that occur
 * inside compressed payloads by retrying the next candidate boundary.
 * @param file - path to the multi-frame log.
 * @returns the concatenated plain text.
 */
function readFrames(file) {
  const raw = readFileSync(file)
  const parts = []
  let offset = 0
  while (offset < raw.length) {
    let end = raw.indexOf(MAGIC, offset + 4)
    for (;;) {
      const candidate = end === -1 ? raw.length : end
      try {
        parts.push(zstdDecompressSync(raw.subarray(offset, candidate)))
        end = candidate
        break
      } catch (error) {
        if (end === -1) throw error
        end = raw.indexOf(MAGIC, end + 4)
      }
    }
    offset = end
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Flatten the log's per-batch records into a single event list.
 * @param text - decoded log text.
 * @returns every event in append order.
 */
function readEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    for (const event of Array.isArray(record?.events) ? record.events : [record]) events.push(event)
  }
  return events
}

const events = readEvents(readFrames(process.argv[2]))
console.log(`events: ${events.length}`)

const rows = []
for (const event of events) {
  const isPrompt =
    event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes(PROMPT_MARKER)
  const isRetirement =
    event.type === 'system/message' &&
    typeof event.surfaceOp === 'object' &&
    event.surfaceOp !== null
  const isBoundary =
    event.type === 'turn/end' || event.type === 'command/run' || event.type === 'command/done'
  if (!isPrompt && !isRetirement && !isBoundary) continue
  rows.push({
    seq: event.seq,
    type: event.type,
    op:
      typeof event.surfaceOp === 'object'
        ? `${event.surfaceOp.op}:${event.surfaceOp.startSeq}-${event.surfaceOp.endSeq}`
        : event.surfaceOp,
    source: event.data?.source?.kind ?? event.data?.message?.source?.kind,
    id: String(event.data?.id ?? event.data?.message?.id ?? '').slice(0, 8) || undefined,
    sourceEventSeqs: event.sourceEventSeqs,
    reason: event.data?.reason?.kind,
    name: event.data?.name,
  })
}

console.log(JSON.stringify(rows.slice(-20), null, 1))
