import { expect, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import type { ChatFramesMark } from '../types'
import {
  ASSISTANT_BACKGROUND,
  ASSISTANT_COLOR,
  PROMPT_MARK,
  USER_BACKGROUND,
  USER_COLOR,
  buildMarkedRule,
  formatMark,
  formatModelName,
  formatStamp,
} from '../hooks/display'
import {
  MAX_MARKS_PER_SESSION,
  SYNTHETIC_MODEL_ID,
  computeMark,
  isMarkedRow,
  newestContextTokens,
  persistMark,
  restoreSessionMarks,
  sessionKey,
  staleSessionKeys,
  withMark,
} from '../hooks/marks'
import type { AppendedRow, MarkStore } from '../hooks/marks'

const PLUGIN = 'qp-mod-chat-frames'
const SURFACE = 'terminal'
const COLUMNS = 30
const WIDE_COLUMNS = 60
const LABEL_COLUMNS = 100
const NO_RESPONSE_TEXT = 'No response requested.'
const VIEWPORT = { columns: COLUMNS, rows: 10 }
const RULE_ONLY = /^─+$/
const PROMPT_TEXT = 'hello'
const LOCAL_STAMP = new Date(2026, 9, 5, 19, 54, 7).getTime()
const MARKED_ID = 'row-marked'
const UNMARKED_ID = 'row-unmarked'
const MARK: ChatFramesMark = { at: LOCAL_STAMP, contextTokens: 252831, contextDelta: 22310 }
const MODEL_MARK: ChatFramesMark = { ...MARK, model: 'claude-opus-5-5', effort: 'xhigh' }
const MARK_LABEL = /🕐 05\/10 19:54:07 · 📥 252.8k \(\+22.3k\)/
const MODEL_LABEL = /🕐 05\/10 19:54:07 · 🤖 Opus 5.5 \(xhigh\) · 📥 252.8k \(\+22.3k\)/
// Stands for the engine beneath the plugin: its own drawing of the row.
const ENGINE_ROW = { type: 'engine', ref: 0 } as const
const ENGINE_NODE = { type: 'engine' } as const

// Stands for the engine's state: only the one mark exists, under exactly the
// key (plugin, key, id) the plugin reads; every other read is a value never written.
const holdMark = (on: On, mark: ChatFramesMark) =>
  on('state.get', (_$, ref) =>
    ref.plugin === PLUGIN && ref.key === 'marks' && 'id' in ref && ref.id === MARKED_ID
      ? { value: { value: mark, version: 1 } }
      : { value: { value: undefined, version: 0 } },
  )

const row = (overrides: Partial<AppendedRow> = {}): AppendedRow => ({
  door: 'response',
  origin: { kind: 'model', model: 'claude-opus-5-5' },
  message: { content: [{ type: 'text' }] },
  ...overrides,
})

// A store in memory; `rejectSet` makes every `set` fail as one over the 4 MiB cap does.
const memoryStore = (entries: Record<string, unknown> = {}, rejectSet = false) => {
  const data = new Map<string, unknown>(Object.entries(entries))
  const store: MarkStore = {
    get: async key => data.get(key),
    set: async (key, value) => {
      if (rejectSet) {
        throw new Error('store is over 4 MiB')
      }
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    delete: async key => {
      data.delete(key)
    },
    keys: async () => [...data.keys()],
  }
  return { store, data }
}

test('formats a stamp as clock icon, day/month and hour:minute:second in local time', () => {
  expect(formatStamp(LOCAL_STAMP)).toBe('🕐 05/10 19:54:07')
})

test('a mark shows the context tokens after the time, in thousands from 1000 up', () => {
  expect(formatMark({ at: LOCAL_STAMP, contextTokens: 45231 })).toBe('🕐 05/10 19:54:07 · 📥 45.2k')
  expect(formatMark({ at: LOCAL_STAMP, contextTokens: 812 })).toBe('🕐 05/10 19:54:07 · 📥 812')
})

test('a mark shows time, then model with effort as qp-statusline does, then context tokens', () => {
  const mark = { at: LOCAL_STAMP, contextTokens: 45231, model: 'claude-opus-5-5', effort: 'high' }
  expect(formatMark(mark)).toBe('🕐 05/10 19:54:07 · 🤖 Opus 5.5 (high) · 📥 45.2k')
})

test('a model without effort shows (--)', () => {
  const mark = { at: LOCAL_STAMP, contextTokens: 45231, model: 'claude-opus-5-5', effort: null }
  expect(formatMark(mark)).toBe('🕐 05/10 19:54:07 · 🤖 Opus 5.5 (--) · 📥 45.2k')
})

test('a model id becomes its display name; an id of another shape is shown as is', () => {
  expect(formatModelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(formatModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(formatModelName('claude-opus-4-6[1m]')).toBe('Opus 4.6')
  expect(formatModelName('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022')
  expect(formatModelName('gpt-5')).toBe('gpt-5')
})

test('the context tokens carry their change since the previous framed row, signed', () => {
  expect(formatMark({ at: LOCAL_STAMP, contextTokens: 252831, contextDelta: 22310 })).toBe(
    '🕐 05/10 19:54:07 · 📥 252.8k (+22.3k)',
  )
  expect(formatMark({ at: LOCAL_STAMP, contextTokens: 41200, contextDelta: -211631 })).toBe(
    '🕐 05/10 19:54:07 · 📥 41.2k (-211.6k)',
  )
})

test('an unchanged context shows no change', () => {
  expect(formatMark({ at: LOCAL_STAMP, contextTokens: 41200, contextDelta: 0 })).toBe('🕐 05/10 19:54:07 · 📥 41.2k')
})

test('a mark written before model and effort were recorded shows neither, and no "undefined"', () => {
  const label = formatMark({ at: LOCAL_STAMP, contextTokens: 45231 })
  expect(label).toBe('🕐 05/10 19:54:07 · 📥 45.2k')
  expect(label.includes('undefined')).toBe(false)
})

test('a mark taken before the first response shows only the time', () => {
  expect(formatMark({ at: LOCAL_STAMP, contextTokens: null })).toBe('🕐 05/10 19:54:07')
})

test('the marked rule leads with two dashes, then the mark, then fills the width', () => {
  const rule = buildMarkedRule(WIDE_COLUMNS, { at: LOCAL_STAMP, contextTokens: 45231 })
  expect(rule.startsWith('── 🕐 05/10 19:54:07 · 📥 45.2k ─')).toBe(true)
  expect(rule.length).toBe(WIDE_COLUMNS)
})

test('a rule with no mark is plain and fills the width', () => {
  expect(buildMarkedRule(COLUMNS, undefined)).toBe('─'.repeat(COLUMNS))
})

test("draws the person's own prompt between blue rules on a dark blue background", async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'UserMessage',
    requestId: MARKED_ID,
    props: { text: PROMPT_TEXT, origin: { kind: 'composer' }, isExpanded: false },
    viewport: VIEWPORT,
  })
  const rules = await ui.findAll({ type: 'Text', text: /^─/ })
  expect(rules.length).toBe(2)
  expect(rules.every(rule => rule.props.color === USER_COLOR)).toBe(true)
  const mark = await ui.find({ type: 'Text', text: PROMPT_MARK })
  expect(mark?.props.backgroundColor).toBe(USER_BACKGROUND)
  const prompt = await ui.find({ type: 'Text', text: PROMPT_TEXT })
  expect(prompt?.props.backgroundColor).toBe(USER_BACKGROUND)
  expect(await ui.find(ENGINE_NODE)).toBeUndefined()
  await ui.unmount()
})

test('frames an assistant text block around the engine row, terracotta rules on a dark terracotta background', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MODEL_MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: MARKED_ID,
    props: { text: 'hi', isFirstOfReply: true },
    viewport: VIEWPORT,
  })
  const rules = await ui.findAll({ type: 'Text', text: /^─/ })
  expect(rules.length).toBe(2)
  expect(rules.every(rule => rule.props.color === ASSISTANT_COLOR)).toBe(true)
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(box => box.props.backgroundColor === ASSISTANT_BACKGROUND)).toBe(true)
  expect(await ui.find(ENGINE_NODE)).toBeDefined()
  await ui.unmount()
})

test('a marked assistant row shows its mark in the top rule: time, model and effort, context and change', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MODEL_MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: MARKED_ID,
    props: { text: 'hi', isFirstOfReply: true },
    viewport: { columns: LABEL_COLUMNS, rows: 10 },
  })
  expect(await ui.find({ type: 'Text', text: MODEL_LABEL })).toBeDefined()
  await ui.unmount()
})

test('a marked prompt shows its mark in the top rule: time, context and change', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MARK)
  const prompt = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'UserMessage',
    requestId: MARKED_ID,
    props: { text: PROMPT_TEXT, origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: LABEL_COLUMNS, rows: 10 },
  })
  expect(await prompt.find({ type: 'Text', text: MARK_LABEL })).toBeDefined()
  await prompt.unmount()
})

test('an assistant row with no mark is framed: a plain top rule above the engine row, then a plain bottom rule', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MODEL_MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: UNMARKED_ID,
    props: { text: 'Credit balance is too low', isFirstOfReply: true },
    viewport: VIEWPORT,
  })
  const rules = await ui.findAll({ type: 'Text', text: RULE_ONLY })
  expect(rules.length).toBe(2)
  expect(rules.every(rule => rule.props.color === ASSISTANT_COLOR)).toBe(true)
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(box => box.props.backgroundColor === ASSISTANT_BACKGROUND)).toBe(true)
  expect(await ui.find(ENGINE_NODE)).toBeDefined()
  // The top rule is a sibling drawn before the engine node, not painted over it.
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.includes('"absolute"')).toBe(false)
  expect(drawn.indexOf('─')).toBeLessThan(drawn.indexOf('"engine"'))
  expect(drawn.indexOf('"engine"')).toBeLessThan(drawn.lastIndexOf('─'))
  await ui.unmount()
})

test('a marked assistant row paints its top rule over the engine row, absolutely positioned', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MODEL_MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: MARKED_ID,
    props: { text: 'hi', isFirstOfReply: true },
    viewport: VIEWPORT,
  })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.includes('"absolute"')).toBe(true)
  expect(drawn.indexOf('"engine"')).toBeLessThan(drawn.indexOf('─'))
  await ui.unmount()
})

test('a prompt with no mark is framed with a bare top rule', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'UserMessage',
    requestId: UNMARKED_ID,
    props: { text: PROMPT_TEXT, origin: { kind: 'composer' }, isExpanded: false },
    viewport: VIEWPORT,
  })
  const rules = await ui.findAll({ type: 'Text', text: RULE_ONLY })
  expect(rules.length).toBe(2)
  expect(rules.every(rule => rule.props.color === USER_COLOR)).toBe(true)
  expect(await ui.find({ type: 'Text', text: PROMPT_TEXT })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🕐/ })).toBeUndefined()
  expect(await ui.find(ENGINE_NODE)).toBeUndefined()
  await ui.unmount()
})

test('"No response requested." is the engine row, unframed', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MODEL_MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: UNMARKED_ID,
    props: { text: NO_RESPONSE_TEXT, isFirstOfReply: true },
    viewport: VIEWPORT,
  })
  expect(await ui.find(ENGINE_NODE)).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^─/ })).length).toBe(0)
  await ui.unmount()
})

test('a blank assistant text block is the engine row, unframed, even with a mark', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MODEL_MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: MARKED_ID,
    props: { text: '  \n ', isFirstOfReply: true },
    viewport: VIEWPORT,
  })
  expect(await ui.find(ENGINE_NODE)).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^─/ })).length).toBe(0)
  await ui.unmount()
})

test('leaves a prompt from another source unframed, even with a mark', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  holdMark(on, MARK)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'UserMessage',
    requestId: MARKED_ID,
    props: { text: 'task done', origin: { kind: 'task-notification' }, isExpanded: false },
    viewport: VIEWPORT,
  })
  expect(await ui.find(ENGINE_NODE)).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^─/ })).length).toBe(0)
  await ui.unmount()
})

test('a response block with text from the model is marked', () => {
  expect(isMarkedRow(row())).toBe(true)
})

test('the prompt is marked at the prompt door and at the delivery door (typed mid-turn)', () => {
  const composer = { origin: { kind: 'composer' }, message: { content: [{ type: 'text' }] } }
  expect(isMarkedRow(row({ ...composer, door: 'prompt' }))).toBe(true)
  expect(isMarkedRow(row({ ...composer, door: 'delivery' }))).toBe(true)
  expect(isMarkedRow(row({ ...composer, door: 'note' }))).toBe(false)
})

test('a slash command is not marked: its row is drawn by a component a mod cannot hook', () => {
  const text = [{ type: 'text' }]
  expect(isMarkedRow(row({ door: 'command', origin: { kind: 'composer' }, message: { content: text } }))).toBe(false)
})

test('a delivery that is not the person typing is not marked', () => {
  expect(isMarkedRow(row({ door: 'delivery', origin: { kind: 'peer' } }))).toBe(false)
  expect(isMarkedRow(row({ door: 'delivery', origin: { kind: 'task-notification' } }))).toBe(false)
  expect(isMarkedRow(row({ door: 'prompt', origin: { kind: 'peer' } }))).toBe(false)
})

test("the engine's stand-in response rows are not marked", () => {
  expect(isMarkedRow(row({ origin: { kind: 'model', model: SYNTHETIC_MODEL_ID } }))).toBe(false)
  expect(SYNTHETIC_MODEL_ID).toBe('<synthetic>')
})

test('a response with no text block, a tool result, and a subagent row are not marked', () => {
  expect(isMarkedRow(row({ message: { content: [{ type: 'tool_use' }, { type: 'thinking' }] } }))).toBe(false)
  expect(isMarkedRow(row({ door: 'tool-result' }))).toBe(false)
  expect(isMarkedRow(row({ agentId: 'agent-1' }))).toBe(false)
  expect(isMarkedRow(row({ agentId: 'agent-1', door: 'prompt', origin: { kind: 'composer' } }))).toBe(false)
})

test('a mark carries the growth in context tokens since the previous framed row', () => {
  const origin = { kind: 'composer' }
  expect(computeMark({ now: 5, contextTokens: 300, previousTokens: 100, origin, effort: null })).toEqual({
    at: 5,
    contextTokens: 300,
    contextDelta: 200,
  })
})

test('a mark carries a shrink as a negative change and no change as zero', () => {
  const origin = { kind: 'composer' }
  expect(computeMark({ now: 5, contextTokens: 100, previousTokens: 300, origin, effort: null }).contextDelta).toBe(-200)
  expect(computeMark({ now: 5, contextTokens: 100, previousTokens: 100, origin, effort: null }).contextDelta).toBe(0)
})

test('a mark has no change with no baseline or no tokens now', () => {
  const origin = { kind: 'composer' }
  expect('contextDelta' in computeMark({ now: 5, contextTokens: 100, previousTokens: undefined, origin, effort: null })).toBe(false)
  expect('contextDelta' in computeMark({ now: 5, contextTokens: 100, previousTokens: null, origin, effort: null })).toBe(false)
  expect(computeMark({ now: 5, contextTokens: null, previousTokens: 100, origin, effort: null })).toEqual({
    at: 5,
    contextTokens: null,
  })
})

test('model and effort are on the mark of a model origin only', () => {
  const byModel = computeMark({
    now: 5,
    contextTokens: 100,
    previousTokens: undefined,
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    effort: 'xhigh',
  })
  expect(byModel.model).toBe('claude-opus-5-5')
  expect(byModel.effort).toBe('xhigh')
  const noEffort = computeMark({
    now: 5,
    contextTokens: 100,
    previousTokens: undefined,
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    effort: undefined,
  })
  expect(noEffort.effort).toBe(null)
  const byPerson = computeMark({
    now: 5,
    contextTokens: 100,
    previousTokens: undefined,
    origin: { kind: 'composer' },
    effort: 'xhigh',
  })
  expect('model' in byPerson).toBe(false)
  expect('effort' in byPerson).toBe(false)
})

test('a session keeps its newest marks: past the limit the oldest go, a row marked again moves to the end', () => {
  const marks = withMark(withMark({}, 'a', MARK, 2), 'b', MARK, 2)
  expect(Object.keys(withMark(marks, 'c', MARK, 2))).toEqual(['b', 'c'])
  expect(Object.keys(withMark(marks, 'a', MODEL_MARK, 2))).toEqual(['b', 'a'])
  expect(withMark(marks, 'a', MODEL_MARK, 2)['a']).toEqual(MODEL_MARK)
})

test('the baseline after a resume is the context of the newest saved mark', () => {
  expect(newestContextTokens({ a: { at: 1, contextTokens: 10 }, b: { at: 2, contextTokens: 20 } })).toBe(20)
  expect(newestContextTokens({ a: { at: 1, contextTokens: 10 }, b: { at: 2, contextTokens: null } })).toBe(undefined)
  expect(newestContextTokens({})).toBe(undefined)
})

test('past the session limit the oldest session keys go, never the current one or another key', () => {
  const keys = ['other', 'marks:s1', 'marks:s2', 'marks:s3', 'marks:s4']
  expect(staleSessionKeys(keys, 2, 'marks:s4')).toEqual(['marks:s1', 'marks:s2'])
  expect(staleSessionKeys(keys, 4, 'marks:s4')).toEqual([])
  expect(staleSessionKeys(keys, 2, 'marks:s1')).toEqual(['marks:s2'])
})

test('a saved mark is read back under its session key and row uuid', async () => {
  const { store, data } = memoryStore()
  const logged: string[] = []
  await persistMark(store, text => logged.push(text), async () => 's1', 'row-1', MODEL_MARK)
  await persistMark(store, text => logged.push(text), async () => 's1', 'row-2', MARK)
  expect(data.get(sessionKey('s1'))).toEqual({ 'row-1': MODEL_MARK, 'row-2': MARK })
  const restored = await restoreSessionMarks(store, text => logged.push(text), 's1')
  expect(restored['row-1']).toEqual(MODEL_MARK)
  expect(restored['row-2']).toEqual(MARK)
  expect(logged).toEqual([])
})

test('a session of another id has no marks to restore', async () => {
  const { store } = memoryStore({ [sessionKey('s1')]: { 'row-1': MARK } })
  expect(await restoreSessionMarks(store, () => undefined, 's2')).toEqual({})
})

test('a saved session keeps at most the newest marks', async () => {
  const { store, data } = memoryStore()
  for (let index = 0; index < MAX_MARKS_PER_SESSION + 3; index += 1) {
    await persistMark(store, () => undefined, async () => 's1', `row-${index}`, MARK)
  }
  const saved = data.get(sessionKey('s1')) as Record<string, ChatFramesMark>
  expect(Object.keys(saved).length).toBe(MAX_MARKS_PER_SESSION)
  expect(saved['row-0']).toBeUndefined()
  expect(saved[`row-${MAX_MARKS_PER_SESSION + 2}`]).toBeDefined()
})

test('saving a mark prunes the oldest sessions past the limit', async () => {
  const entries: Record<string, unknown> = { unrelated: 1 }
  for (let index = 1; index <= 10; index += 1) {
    entries[sessionKey(`old-${index}`)] = { x: MARK }
  }
  const { store, data } = memoryStore(entries)
  await persistMark(store, () => undefined, async () => 'new', 'row-1', MARK)
  expect(data.has(sessionKey('old-1'))).toBe(false)
  expect(data.has(sessionKey('old-2'))).toBe(true)
  expect(data.has(sessionKey('new'))).toBe(true)
  expect(data.has('unrelated')).toBe(true)
})

test('a rejected store write is reported to the log with its context and does not throw', async () => {
  const { store } = memoryStore({}, true)
  const logged: string[] = []
  await persistMark(store, text => logged.push(text), async () => 's1', 'row-1', MARK)
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('row-1')
  expect(logged[0]).toContain('store is over 4 MiB')
})

test('a resumed session moves to the newest place among the keys, so pruning takes the unused ones first', async () => {
  const { store } = memoryStore({
    [sessionKey('s1')]: { 'row-1': MARK },
    [sessionKey('s2')]: { 'row-2': MARK },
  })
  await restoreSessionMarks(store, () => undefined, 's1')
  expect(await store.keys()).toEqual([sessionKey('s2'), sessionKey('s1')])
})

test('a store that cannot be read is reported and the session starts with no marks', async () => {
  const { store } = memoryStore()
  const logged: string[] = []
  const failing: MarkStore = {
    ...store,
    get: async () => {
      throw new Error('store unreadable')
    },
  }
  expect(await restoreSessionMarks(failing, text => logged.push(text), 's1')).toEqual({})
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('store unreadable')
})
