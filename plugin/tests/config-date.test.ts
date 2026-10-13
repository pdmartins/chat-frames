import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { formatMark } from '../hooks/display'
import { parseConfig } from '../hooks/config'

const HOME = '/home/u'
// A plugin loaded from a folder keeps its config here (the kit loads the plugin from its folder).
const DEV_PATH = '/home/u/.claude/plugins/data/chat-frames-inline/config.json'
const PLUGIN = 'chat-frames'
const SURFACE = 'terminal'
const COLUMNS = 100
const VIEWPORT = { columns: COLUMNS, rows: 10 }
const STAMP = new Date(2026, 9, 5, 19, 54, 7).getTime()
const USER_ROW = 'user'
const ASSISTANT_ROW = 'assistant'
const RULE_START = /^─/

// The file as a user wrote it: the date hidden, the seconds dropped, a model icon, and a key that does not exist.
const NO_DATE_FILE = '{ "show": { "date": false }, "format": { "time": "HH:mm" }, "icons": { "model": "M" }, "typo": true }'
const TIME_PART = '🕐 19:54'
const ASSISTANT_LABEL = `${TIME_PART} · M Opus 5.5 (xhigh) · 📥 252.8k (+22.3k)`
const DATE_SHAPE = /\d{2}\/\d{2}/

const USER_MARK = { at: STAMP, contextTokens: 252831, contextDelta: 22310 }
const ASSISTANT_MARK = { ...USER_MARK, model: 'claude-opus-5-5', effort: 'xhigh' }

test('the no-date file parsed gives a label with the time as HH:mm, the model icon and no date', () => {
  const { config, problems } = parseConfig(NO_DATE_FILE)
  expect(problems.map(problem => problem.field)).toEqual(['typo'])
  expect(config.show.date).toBe(false)
  expect(formatMark(ASSISTANT_MARK, config)).toBe(ASSISTANT_LABEL)
  expect(formatMark(ASSISTANT_MARK, config)).not.toMatch(DATE_SHAPE)
})

// The engine's own events answer for the file system, so the plugin's `session.start` runs end to end.
const answerFile = (on: On, text: string) => {
  on('fs.exists', (_$, { path }) => ({ value: path === DEV_PATH }))
  on('fs.read', (_$, { path }) => ({ value: path === DEV_PATH ? text : '' }))
}

test('a config file that hides the date draws no date on a framed prompt or reply, end to end', async ($, on) => {
  const toasts: string[] = []
  mock.env(on, { HOME })
  mock.store(on)
  answerFile(on, NO_DATE_FILE)
  on('ui.toast', (_$, { text }) => {
    toasts.push(text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, { cwd }) => ({ cwd }))
  // The marks are the one state value this test stands in for (a plugin's own `session.append` carries
  // a plugin origin, which is never framed); the config is the one session.start wrote.
  on('state.get', (_$, ref, next) => {
    if (ref.key === 'marks' && 'id' in ref && ref.id === USER_ROW) {
      return { value: { value: USER_MARK, version: 1 } }
    }
    if (ref.key === 'marks' && 'id' in ref && ref.id === ASSISTANT_ROW) {
      return { value: { value: ASSISTANT_MARK, version: 1 } }
    }
    return next(ref)
  })
  await $.session.start({ cwd: HOME, surface: null, isInteractive: false })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toBe(`typo: unknown key. File: ${DEV_PATH}`)

  const userUi = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'UserMessage',
    requestId: USER_ROW,
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
    viewport: VIEWPORT,
  })
  const userRule = await userUi.find({ type: 'Text', text: RULE_START })
  expect(userRule?.text).toContain(`${TIME_PART} · 📥`)
  expect(userRule?.text).not.toMatch(DATE_SHAPE)
  await userUi.unmount()

  const assistantUi = await $.ui.mount({
    plugin: PLUGIN,
    surface: SURFACE,
    component: 'AssistantMessage',
    requestId: ASSISTANT_ROW,
    props: { text: 'hi', isFirstOfReply: true },
    viewport: VIEWPORT,
  })
  const assistantRule = await assistantUi.find({ type: 'Text', text: RULE_START })
  expect(assistantRule?.text).toContain(ASSISTANT_LABEL)
  expect(assistantRule?.text).not.toMatch(DATE_SHAPE)
  await assistantUi.unmount()
})
