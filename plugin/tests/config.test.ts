import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { On } from 'claude-code'

import {
  DEFAULT_CONFIG,
  REASON_NOT_ALLOWED,
  REASON_NOT_BOOLEAN,
  REASON_NOT_OBJECT_FIELD,
  REASON_NOT_TEXT,
  REASON_UNKNOWN_KEY,
} from '../hooks/display'
import { describeProblems, loadConfig, parseConfig, pickPalette, readClaudeTheme, resolveConfigPath } from '../hooks/config'
import type { ConfigIo } from '../hooks/config'

const INSTALLED_ROOT = '/home/u/.claude/plugins/cache/pdmartins/chat-frames/0.2.0'
const INSTALLED_PATH = '/home/u/.claude/plugins/data/chat-frames-pdmartins/config.json'
const DEV_ROOT = '/repos/_pm/chat-frames'
const DEV_PATH = '/home/u/.claude/plugins/data/chat-frames-inline/config.json'
const HOME = '/home/u'
const CUSTOM_CONFIG_DIR = '/srv/claude'
const CONFIG_PATH = '/cfg/config.json'
const ENGINE_PROVIDER = { plugin: 'engine', tier: 'core' } as const

// The block of the spec, as the file would hold it: the default constant must equal it.
const SPEC_DEFAULTS = {
  theme: 'auto',
  show: { date: true, time: true, model: true, effort: true, tokens: true, tokensDelta: true },
  format: { date: 'DD/MM', time: 'HH:mm:ss' },
  icons: { time: '🕐', model: '🤖', tokens: '📥' },
  colors: {
    dark: { userRule: 'blue', userBackground: '#0f1b33', assistantRule: 'claude', assistantBackground: '#2b1811' },
    light: { userRule: 'blue', userBackground: '#e3ebf8', assistantRule: 'claude', assistantBackground: '#f8e6de' },
  },
}

const fieldsOf = (problems: { field: string }[]) => problems.map(problem => problem.field)
const reasonsOf = (problems: { reason: string }[]) => problems.map(problem => problem.reason)

// A file system in memory: `files` holds the text by path; a path in `unreadable` exists but fails to read.
const memoryIo = (files: Record<string, string>, unreadable: string[] = []) => {
  const logged: string[] = []
  const toasts: string[] = []
  const io: ConfigIo = {
    exists: async path => path in files || unreadable.includes(path),
    read: async path => {
      if (unreadable.includes(path)) {
        throw new Error('EACCES: permission denied')
      }
      return files[path] ?? ''
    },
    log: text => logged.push(text),
    toast: text => toasts.push(text),
  }
  return { io, logged, toasts }
}

test('an installed plugin keeps its config in the data folder named plugin-marketplace', () => {
  expect(resolveConfigPath({ pluginRoot: INSTALLED_ROOT, configDir: undefined, home: HOME })).toBe(INSTALLED_PATH)
  expect(resolveConfigPath({ pluginRoot: INSTALLED_ROOT, configDir: CUSTOM_CONFIG_DIR, home: HOME })).toBe(INSTALLED_PATH)
})

test('a plugin loaded from a folder keeps its config under CLAUDE_CONFIG_DIR, else under HOME/.claude', () => {
  const inline = 'plugins/data/chat-frames-inline/config.json'
  expect(resolveConfigPath({ pluginRoot: DEV_ROOT, configDir: CUSTOM_CONFIG_DIR, home: HOME })).toBe(`${CUSTOM_CONFIG_DIR}/${inline}`)
  expect(resolveConfigPath({ pluginRoot: DEV_ROOT, configDir: undefined, home: HOME })).toBe(`${HOME}/.claude/${inline}`)
})

test('a root with /plugins/cache/ but fewer than two segments after it is read as a folder plugin', () => {
  const inline = 'plugins/data/chat-frames-inline/config.json'
  for (const pluginRoot of ['/home/u/.claude/plugins/cache/', '/home/u/.claude/plugins/cache/pdmartins']) {
    expect(resolveConfigPath({ pluginRoot, configDir: undefined, home: HOME })).toBe(`${HOME}/.claude/${inline}`)
  }
})

test('with no CLAUDE_CONFIG_DIR and no HOME there is no config path', () => {
  expect(resolveConfigPath({ pluginRoot: DEV_ROOT, configDir: undefined, home: undefined })).toBeUndefined()
})

test('the default config equals the block of the spec', () => {
  expect(DEFAULT_CONFIG).toEqual(SPEC_DEFAULTS)
})

test('a file with every field as the default parses with no problem', () => {
  expect(parseConfig(JSON.stringify(SPEC_DEFAULTS))).toEqual({ config: SPEC_DEFAULTS, problems: [] })
})

test('a partial file keeps what it sets and the default of every field it leaves out', () => {
  const { config, problems } = parseConfig('{"theme":"light","show":{"model":false},"colors":{"dark":{"userRule":"red"}}}')
  expect(problems).toEqual([])
  expect(config.theme).toBe('light')
  expect(config.show).toEqual({ ...SPEC_DEFAULTS.show, model: false })
  expect(config.colors.dark).toEqual({ ...SPEC_DEFAULTS.colors.dark, userRule: 'red' })
  expect(config.colors.light).toEqual(SPEC_DEFAULTS.colors.light)
  expect(config.format).toEqual(SPEC_DEFAULTS.format)
})

test('JSON that does not parse gives every default and one problem for the file', () => {
  const { config, problems } = parseConfig('{"theme": ')
  expect(config).toEqual(SPEC_DEFAULTS)
  expect(fieldsOf(problems)).toEqual(['file'])
  expect(problems[0]?.reason).toContain('not valid JSON')
})

test('JSON that is not an object gives every default and one problem for the file', () => {
  for (const text of ['[]', '5', 'null', '"x"']) {
    const { config, problems } = parseConfig(text)
    expect(config).toEqual(SPEC_DEFAULTS)
    expect(fieldsOf(problems)).toEqual(['file'])
  }
})

test('a field of the wrong type keeps its default and is named in the problems', () => {
  const { config, problems } = parseConfig(
    '{"show":{"date":"yes","time":false},"format":{"date":5},"icons":{"time":""},"colors":{"dark":"blue"}}',
  )
  expect(fieldsOf(problems)).toEqual(['show.date', 'format.date', 'icons.time', 'colors.dark'])
  expect(reasonsOf(problems)).toEqual([REASON_NOT_BOOLEAN, REASON_NOT_TEXT, REASON_NOT_TEXT, REASON_NOT_OBJECT_FIELD])
  expect(config.show).toEqual({ ...SPEC_DEFAULTS.show, time: false })
  expect(config.format.date).toBe(SPEC_DEFAULTS.format.date)
  expect(config.icons.time).toBe(SPEC_DEFAULTS.icons.time)
  expect(config.colors.dark).toEqual(SPEC_DEFAULTS.colors.dark)
})

test('a value that is not allowed keeps the default of its field', () => {
  const { config, problems } = parseConfig('{"theme":"sepia"}')
  expect(config.theme).toBe('auto')
  expect(fieldsOf(problems)).toEqual(['theme'])
  expect(reasonsOf(problems)).toEqual([REASON_NOT_ALLOWED(['auto', 'light', 'dark'])])
})

test('an unknown key is ignored and reported, at any depth, while the valid fields are kept', () => {
  const { config, problems } = parseConfig('{"themes":"dark","theme":"dark","show":{"clock":true},"colors":{"dark":{"link":"red"}}}')
  expect(fieldsOf(problems)).toEqual(['themes', 'show.clock', 'colors.dark.link'])
  expect(reasonsOf(problems)).toEqual([REASON_UNKNOWN_KEY, REASON_UNKNOWN_KEY, REASON_UNKNOWN_KEY])
  expect(config).toEqual({ ...SPEC_DEFAULTS, theme: 'dark' })
})

test('the problems are listed with the file path, each field and its reason', () => {
  const text = describeProblems(CONFIG_PATH, [
    { field: 'theme', reason: 'bad' },
    { field: 'show.date', reason: 'worse' },
  ])
  expect(text).toContain(CONFIG_PATH)
  expect(text).toContain('theme bad')
  expect(text).toContain('show.date worse')
})

test('a missing file gives the defaults with no toast, and the path is logged', async () => {
  const { io, logged, toasts } = memoryIo({})
  expect(await loadConfig(CONFIG_PATH, io)).toEqual(SPEC_DEFAULTS)
  expect(toasts).toEqual([])
  expect(logged.some(line => line.includes(CONFIG_PATH))).toBe(true)
})

test('a valid file is read with no toast', async () => {
  const { io, toasts } = memoryIo({ [CONFIG_PATH]: '{"theme":"dark"}' })
  expect((await loadConfig(CONFIG_PATH, io)).theme).toBe('dark')
  expect(toasts).toEqual([])
})

test('problems in a file give one toast and the same text in the debug log', async () => {
  const { io, logged, toasts } = memoryIo({ [CONFIG_PATH]: '{"theme":"sepia","show":{"clock":true},"icons":{"time":3}}' })
  const config = await loadConfig(CONFIG_PATH, io)
  expect(config).toEqual(SPEC_DEFAULTS)
  expect(toasts.length).toBe(1)
  for (const field of ['theme', 'show.clock', 'icons.time', CONFIG_PATH]) {
    expect(toasts[0]).toContain(field)
  }
  expect(logged).toContain(toasts[0])
})

test('a file that cannot be read gives every default and one toast with the reason', async () => {
  const { io, toasts } = memoryIo({}, [CONFIG_PATH])
  expect(await loadConfig(CONFIG_PATH, io)).toEqual(SPEC_DEFAULTS)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('EACCES')
})

test('with no config path the defaults apply and the reason is logged', async () => {
  const { io, logged, toasts } = memoryIo({})
  expect(await loadConfig(undefined, io)).toEqual(SPEC_DEFAULTS)
  expect(logged.length).toBe(1)
  expect(toasts).toEqual([])
})

// The engine's own events answer for the file system, so the plugin's `session.start`
// runs end to end: the path from the env (the test loads the plugin from its folder),
// the read, the toast and the log.
const answerFile = (on: On, text: string | undefined) => {
  on('fs.exists', (_$, { path }) => ({ value: path === DEV_PATH && text !== undefined }))
  on('fs.read', (_$, { path }) => ({ value: path === DEV_PATH ? (text ?? '') : '' }))
}

test('session.start reads the config file of the plugin and reports its problems once', async ($, on) => {
  const toasts: string[] = []
  const logs: string[] = []
  mock.env(on, { HOME })
  mock.store(on)
  answerFile(on, '{"theme":"sepia"}')
  on('ui.toast', (_$, { text }) => {
    toasts.push(text)
    return { value: undefined }
  })
  on('ui.log', (_$, { text }) => {
    logs.push(text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, { cwd }) => ({ cwd }))
  await $.session.start({ cwd: HOME, surface: null, isInteractive: false })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('theme')
  expect(logs.some(line => line.includes(DEV_PATH))).toBe(true)
})

test('the colors read at session.start are the ones the rows are drawn with', async ($, on) => {
  mock.env(on, { HOME })
  mock.store(on)
  answerFile(on, '{"colors":{"dark":{"userRule":"red"}}}')
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, { cwd }) => ({ cwd }))
  await $.session.start({ cwd: HOME, surface: null, isInteractive: false })
  const ui = await $.ui.mount({
    plugin: 'chat-frames',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'row',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 30, rows: 10 },
  })
  const rules = await ui.findAll({ type: 'Text', text: /^─/ })
  expect(rules.length).toBe(2)
  expect(rules.every(rule => rule.props.color === 'red')).toBe(true)
  await ui.unmount()
})

test('the label parts and icons read at session.start change the label of a row with a mark', async ($, on) => {
  const stamp = new Date(2026, 9, 5, 19, 54, 7).getTime()
  const mark = { at: stamp, contextTokens: 252831, contextDelta: 22310, model: 'claude-opus-5-5', effort: 'xhigh' }
  mock.env(on, { HOME })
  mock.store(on)
  answerFile(on, '{"show":{"effort":false,"tokensDelta":false},"icons":{"model":"M"},"format":{"date":"YYYY-MM-DD"}}')
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, { cwd }) => ({ cwd }))
  // The mark is the one state value this test stands in for; the config is the one session.start wrote.
  on('state.get', (_$, ref, next) =>
    ref.key === 'marks' && 'id' in ref && ref.id === 'row' ? { value: { value: mark, version: 1 } } : next(ref),
  )
  await $.session.start({ cwd: HOME, surface: null, isInteractive: false })
  const ui = await $.ui.mount({
    plugin: 'chat-frames',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'row',
    props: { text: 'hi', isFirstOfReply: true },
    viewport: { columns: 100, rows: 10 },
  })
  expect(await ui.find({ type: 'Text', text: /🕐 2026-10-05 19:54:07 · M Opus 5.5 · 📥 252.8k ─/ })).toBeDefined()
  await ui.unmount()
})

// ─── Palette: the file's theme and Claude Code's theme choose the colors ─────
const CLAUDE_THEMES_LIGHT = ['light', 'light-daltonized', 'light-ansi']
const CLAUDE_THEMES_DARK = ['auto', 'dark', 'dark-daltonized', 'dark-ansi']
const { dark: DARK, light: LIGHT } = DEFAULT_CONFIG.colors
const withTheme = (theme: 'auto' | 'light' | 'dark') => ({ ...DEFAULT_CONFIG, theme })

test('with the file theme auto, the light Claude Code themes draw the light palette', () => {
  for (const claudeTheme of CLAUDE_THEMES_LIGHT) {
    expect(pickPalette(withTheme('auto'), claudeTheme)).toBe(LIGHT)
  }
})

test('with the file theme auto, the other Claude Code themes, an unknown one and a missing one draw the dark palette', () => {
  for (const claudeTheme of [...CLAUDE_THEMES_DARK, 'sepia', undefined, true]) {
    expect(pickPalette(withTheme('auto'), claudeTheme)).toBe(DARK)
  }
})

test('the file theme light or dark forces its palette whatever Claude Code says', () => {
  for (const claudeTheme of [...CLAUDE_THEMES_LIGHT, ...CLAUDE_THEMES_DARK, undefined]) {
    expect(pickPalette(withTheme('light'), claudeTheme)).toBe(LIGHT)
    expect(pickPalette(withTheme('dark'), claudeTheme)).toBe(DARK)
  }
})

test('the palette is the one of the file: changed colors are kept', () => {
  const config = { ...DEFAULT_CONFIG, colors: { ...DEFAULT_CONFIG.colors, light: { ...LIGHT, userRule: 'red' } } }
  expect(pickPalette({ ...config, theme: 'light' }, undefined).userRule).toBe('red')
})

test('readClaudeTheme returns the value of the theme row', async () => {
  const rows = [{ key: 'verbose', value: true }, { key: 'theme', value: 'light-ansi' }]
  expect(await readClaudeTheme({ list: async () => rows, log: () => undefined })).toBe('light-ansi')
})

test('readClaudeTheme gives undefined for a missing row and, logged, for a list that fails', async () => {
  const logged: string[] = []
  expect(await readClaudeTheme({ list: async () => [], log: text => logged.push(text) })).toBeUndefined()
  expect(logged).toEqual([])
  const failing = async () => {
    throw new Error('no config')
  }
  expect(await readClaudeTheme({ list: failing, log: text => logged.push(text) })).toBeUndefined()
  expect(logged.length).toBe(1)
  expect(logged[0]).toContain('no config')
})

// Session start with the file text and Claude Code's theme row.
const startSession = async ($: Engine, on: On, fileText: string | undefined, claudeTheme: string, refuseWith?: string) => {
  mock.env(on, { HOME })
  mock.store(on)
  answerFile(on, fileText)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, { cwd }) => ({ cwd }))
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: claudeTheme, provider: ENGINE_PROVIDER, isLocked: false }],
  }))
  // The writer beneath the plugins: the row is written as asked unless the test says it is refused.
  on('config.set', (_$, { value }) => (refuseWith === undefined ? { value } : { deny: refuseWith }))
  await $.session.start({ cwd: HOME, surface: null, isInteractive: false })
}

// The input of a config.set of the theme row, as the menu raises it.
const themeChange = <T extends string | boolean>(value: T) => ({
  key: 'theme',
  value,
  previous: 'dark',
  provider: ENGINE_PROVIDER,
  origin: { kind: 'composer' },
} as const)

// The background the prompt of a framed user row is drawn with.
const userBackgroundDrawn = async ($: Engine, requestId: string) => {
  const ui = await $.ui.mount({
    plugin: 'chat-frames',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 30, rows: 10 },
  })
  const prompt = await ui.find({ type: 'Text', text: 'hello' })
  await ui.unmount()
  return prompt?.props.backgroundColor
}

test('session.start reads Claude Code theme: a light one draws the light backgrounds', async ($, on) => {
  await startSession($, on, undefined, 'light-daltonized')
  expect(await userBackgroundDrawn($, 'row')).toBe(LIGHT.userBackground)
})

test('session.start with a dark Claude Code theme draws the dark backgrounds', async ($, on) => {
  await startSession($, on, undefined, 'dark-ansi')
  expect(await userBackgroundDrawn($, 'row')).toBe(DARK.userBackground)
})

test('the file theme dark wins over a light Claude Code theme', async ($, on) => {
  await startSession($, on, '{"theme":"dark"}', 'light')
  expect(await userBackgroundDrawn($, 'row')).toBe(DARK.userBackground)
})

test('before session.start reads anything, the dark palette is drawn', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  expect(await userBackgroundDrawn($, 'row')).toBe(DARK.userBackground)
})

test('a config.set of the theme row changes the palette of the rows drawn afterwards', async ($, on) => {
  await startSession($, on, undefined, 'dark')
  expect(await userBackgroundDrawn($, 'before')).toBe(DARK.userBackground)
  const result = await $.config.set(themeChange('light'))
  expect(result).toEqual({ value: 'light' })
  expect(await userBackgroundDrawn($, 'after')).toBe(LIGHT.userBackground)
})

test('a refused config.set of the theme row leaves the palette as it was', async ($, on) => {
  await startSession($, on, undefined, 'light', 'locked')
  expect(await userBackgroundDrawn($, 'before')).toBe(LIGHT.userBackground)
  expect(await $.config.set({ ...themeChange('dark'), previous: 'light' })).toEqual({ deny: 'locked' })
  expect(await userBackgroundDrawn($, 'after')).toBe(LIGHT.userBackground)
})

test('a config.set of another row does not touch the palette', async ($, on) => {
  await startSession($, on, undefined, 'light')
  expect(await userBackgroundDrawn($, 'before')).toBe(LIGHT.userBackground)
  await $.config.set({ ...themeChange(true), key: 'verbose', previous: false })
  expect(await userBackgroundDrawn($, 'after')).toBe(LIGHT.userBackground)
})
