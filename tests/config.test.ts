import { expect, test } from 'claude-code/testing'

import { resolveConfigPath } from '../hooks/config'

const INSTALLED_ROOT = '/home/u/.claude/plugins/cache/pdmartins/chat-frames/0.2.0'
const INSTALLED_PATH = '/home/u/.claude/plugins/data/chat-frames-pdmartins/config.json'
const DEV_ROOT = '/repos/_pm/chat-frames'
const HOME = '/home/u'
const CUSTOM_CONFIG_DIR = '/srv/claude'

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
