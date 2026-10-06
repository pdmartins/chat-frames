import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { DEFAULT_CONFIG } from '../hooks/display'
import { describeProblems, loadConfig, parseConfig, resolveConfigPath } from '../hooks/config'
import type { ConfigIo } from '../hooks/config'

const INSTALLED_ROOT = '/home/u/.claude/plugins/cache/pdmartins/chat-frames/0.2.0'
const INSTALLED_PATH = '/home/u/.claude/plugins/data/chat-frames-pdmartins/config.json'
const DEV_ROOT = '/repos/_pm/chat-frames'
const DEV_PATH = '/home/u/.claude/plugins/data/chat-frames-inline/config.json'
const HOME = '/home/u'
const CUSTOM_CONFIG_DIR = '/srv/claude'
const CONFIG_PATH = '/cfg/config.json'

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
  expect(config.show).toEqual({ ...SPEC_DEFAULTS.show, time: false })
  expect(config.format.date).toBe(SPEC_DEFAULTS.format.date)
  expect(config.icons.time).toBe(SPEC_DEFAULTS.icons.time)
  expect(config.colors.dark).toEqual(SPEC_DEFAULTS.colors.dark)
})

test('a value that is not allowed keeps the default of its field', () => {
  const { config, problems } = parseConfig('{"theme":"sepia"}')
  expect(config.theme).toBe('auto')
  expect(fieldsOf(problems)).toEqual(['theme'])
  expect(problems[0]?.reason).toContain('auto, light, dark')
})

test('an unknown key is ignored and reported, at any depth, while the valid fields are kept', () => {
  const { config, problems } = parseConfig('{"themes":"dark","theme":"dark","show":{"clock":true},"colors":{"dark":{"link":"red"}}}')
  expect(fieldsOf(problems)).toEqual(['themes', 'show.clock', 'colors.dark.link'])
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
