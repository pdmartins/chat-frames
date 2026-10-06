import type { ChatFramesMark, ChatFramesSessionMarks } from '../types'

// ─── Marks: which rows are framed, what a mark holds, how marks are kept ─────
// Pure functions (no engine call) so tests can run them alone; the hooks in
// register.tsx do the engine calls and hand the results in.

export const COMPOSER_ORIGIN = 'composer'
export const SYNTHETIC_MODEL_ID = '<synthetic>' // the engine's stand-in rows (API errors, "No response requested.")
const MODEL_ORIGIN = 'model'
const PROMPT_DOOR = 'prompt'
const DELIVERY_DOOR = 'delivery' // a prompt typed while a turn runs arrives through this door
const RESPONSE_DOOR = 'response'
const FRAMED_RESPONSE_BLOCK = 'text'
const PROMPT_DOORS: readonly string[] = [PROMPT_DOOR, DELIVERY_DOOR]

// Persistence bound. `$.store` holds 4 MiB of JSON for the whole plugin. One key
// per session (`marks:<session id>`) holds that session's marks, one entry per
// row (uuid 36 chars + about 110 bytes of mark, about 150 bytes in all).
// 10 sessions x 1500 marks x 150 bytes is about 2.2 MB, under the cap. Past
// either limit the oldest go: the oldest marks of a session, the oldest session keys.
export const MAX_MARKS_PER_SESSION = 1500
export const MAX_SESSIONS = 10
const SESSION_KEY_PREFIX = 'marks:'

/** The part of a `session.append` event that decides whether a row is framed. */
export type AppendedRow = {
  agentId?: string
  door: string
  origin: { kind: string; model?: string }
  message: { content: readonly { type: string }[] }
}

/** The `$.store` calls the persistence needs. */
export type MarkStore = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: () => Promise<string[]>
}

export type MarkLog = (text: string) => void

export type MarkInput = {
  now: number
  contextTokens: number | null
  previousTokens: number | null | undefined
  origin: { kind: string; model?: string }
  effort: string | null | undefined
}

// A row is marked when it is on the main thread and is either the person's own
// prompt (typed at once or mid-turn) or a response block holding text that is not
// one of the engine's stand-in rows.
export const isMarkedRow = (row: AppendedRow): boolean => {
  if (row.agentId !== undefined) {
    return false
  }
  if (row.origin.kind === COMPOSER_ORIGIN) {
    return PROMPT_DOORS.includes(row.door)
  }
  const isSynthetic = row.origin.kind === MODEL_ORIGIN && row.origin.model === SYNTHETIC_MODEL_ID
  const hasText = row.message.content.some(block => block.type === FRAMED_RESPONSE_BLOCK)
  return row.door === RESPONSE_DOOR && hasText && !isSynthetic
}

// The change is left out with nothing to compare (no baseline, or no tokens now);
// model and effort are kept only when a model wrote the row.
export const computeMark = ({ now, contextTokens, previousTokens, origin, effort }: MarkInput): ChatFramesMark => {
  const mark: ChatFramesMark = { at: now, contextTokens }
  if (contextTokens !== null && typeof previousTokens === 'number') {
    mark.contextDelta = contextTokens - previousTokens
  }
  if (origin.kind === MODEL_ORIGIN && origin.model !== undefined) {
    mark.model = origin.model
    mark.effort = effort ?? null
  }
  return mark
}

export const sessionKey = (sessionId: string): string => `${SESSION_KEY_PREFIX}${sessionId}`

// Adds a mark as the newest entry (a row marked again moves to the end) and keeps
// the newest `max`. Object order is insertion order for uuid keys.
export const withMark = (
  marks: ChatFramesSessionMarks,
  uuid: string,
  mark: ChatFramesMark,
  max: number,
): ChatFramesSessionMarks => {
  const entries = Object.entries(marks).filter(([id]) => id !== uuid)
  entries.push([uuid, mark])
  return Object.fromEntries(entries.slice(-max))
}

// The newest entry holding a context figure: the baseline for the next change.
export const newestContextTokens = (marks: ChatFramesSessionMarks): number | undefined => {
  const newest = Object.values(marks).at(-1)
  return newest?.contextTokens ?? undefined
}

// The mark keys to delete so that at most `keep` remain, oldest first (the store
// lists keys in insertion order); the current session's key is never among them.
export const staleSessionKeys = (keys: readonly string[], keep: number, currentKey: string): string[] => {
  const sessionKeys = keys.filter(key => key.startsWith(SESSION_KEY_PREFIX))
  const excess = Math.max(0, sessionKeys.length - keep)
  return sessionKeys.slice(0, excess).filter(key => key !== currentKey)
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isMarkRecord = (value: unknown): value is ChatFramesSessionMarks =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readSessionMarks = async (store: MarkStore, key: string): Promise<ChatFramesSessionMarks> => {
  const stored = await store.get(key)
  return isMarkRecord(stored) ? stored : {}
}

// Store writes of one process run one after another: each is read, change, write
// of the session's record, and two overlapping would lose a mark.
let pendingWrite: Promise<void> = Promise.resolve()

// Saves one mark and prunes. A failure (a rejected `set` over the 4 MiB cap, an
// unreadable store) is reported to the debug log and never reaches the append.
export const persistMark = (
  store: MarkStore,
  log: MarkLog,
  getSessionId: () => Promise<string>,
  uuid: string,
  mark: ChatFramesMark,
): Promise<void> => {
  const write = async (): Promise<void> => {
    try {
      const key = sessionKey(await getSessionId())
      const marks = await readSessionMarks(store, key)
      await store.set(key, withMark(marks, uuid, mark, MAX_MARKS_PER_SESSION))
      for (const stale of staleSessionKeys(await store.keys(), MAX_SESSIONS, key)) {
        await store.delete(stale)
      }
    } catch (error) {
      log(`qp-mod-chat-frames: could not save the mark of row ${uuid}: ${describeError(error)}`)
    }
  }
  pendingWrite = pendingWrite.then(write)
  return pendingWrite
}

// Reads a session's saved marks. A session being resumed is also moved to the
// newest place among the keys, so pruning takes the sessions not used lately.
export const restoreSessionMarks = async (
  store: MarkStore,
  log: MarkLog,
  sessionId: string,
): Promise<ChatFramesSessionMarks> => {
  const key = sessionKey(sessionId)
  try {
    const marks = await readSessionMarks(store, key)
    if (Object.keys(marks).length > 0) {
      await store.delete(key)
      await store.set(key, marks)
    }
    return marks
  } catch (error) {
    log(`qp-mod-chat-frames: could not load the saved marks of session ${sessionId}: ${describeError(error)}`)
    return {}
  }
}
// ─────────────────────────────────────────────────────────────────────────────
