import {
  DEFAULT_CONFIG,
  FILE_FIELD,
  MISSING_LOG_TEMPLATE,
  NO_PATH_LOG,
  PROBLEM_SEPARATOR,
  READ_LOG_TEMPLATE,
  REASON_NOT_BOOLEAN,
  REASON_NOT_ALLOWED,
  REASON_NOT_JSON,
  REASON_NOT_OBJECT,
  REASON_NOT_OBJECT_FIELD,
  REASON_NOT_TEXT,
  REASON_READ_FAILED,
  REASON_UNKNOWN_KEY,
  THEME_READ_FAILED_LOG,
  TOAST_PREFIX,
} from './display'
import type { ChatFramesConfig, ChatFramesPalette } from '../types'

// ─── Config file: where it is, how it is read and checked ────────────────────
// The file is `config.json` in the plugin's data folder. Every field is optional:
// a missing one, and one that is not valid, keep the default (see DEFAULT_CONFIG).
// A problem never stops the plugin: it is reported once per read, to a toast and
// to the debug log.
const INSTALLED_PLUGIN_MARKER = '/plugins/cache/'
const DATA_FOLDER = 'plugins/data'
const CONFIG_FILE = 'config.json'
const DEV_MOD_PLUGIN_FOLDER = 'chat-frames-inline'
const DEFAULT_CONFIG_DIR_NAME = '.claude'
const PATH_SEPARATOR = '/'
const FIELD_SEPARATOR = '.'
const ALLOWED_THEMES = ['auto', 'light', 'dark']
// The values a string field may take, by field; a string field not listed takes any non-empty text.
const ALLOWED_VALUES: Readonly<Record<string, readonly string[]>> = { theme: ALLOWED_THEMES }

export type ConfigProblem = { field: string; reason: string }
export type ParsedConfig = { config: ChatFramesConfig; problems: ConfigProblem[] }

/** What `loadConfig` needs from the engine, as plain functions. */
export type ConfigIo = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  log: (text: string) => void
  toast: (text: string) => void
}

export type ConfigPathInput = {
  pluginRoot: string
  /** The value of CLAUDE_CONFIG_DIR, undefined when unset. */
  configDir: string | undefined
  /** The value of HOME, undefined when unset. */
  home: string | undefined
}

const joinPath = (...parts: string[]): string => parts.join(PATH_SEPARATOR)

// An installed plugin lives in `<config dir>/plugins/cache/<marketplace>/<plugin>/<version>`
// and keeps its data in `<config dir>/plugins/data/<plugin>-<marketplace>`; a plugin
// loaded from a folder (a dev mod) has no marketplace, so its data folder is a fixed one
// in the config dir (CLAUDE_CONFIG_DIR, else `$HOME/.claude`). Undefined when that dir is unknown.
export const resolveConfigPath = ({ pluginRoot, configDir, home }: ConfigPathInput): string | undefined => {
  const markerAt = pluginRoot.indexOf(INSTALLED_PLUGIN_MARKER)
  if (markerAt !== -1) {
    const afterMarker = pluginRoot.slice(markerAt + INSTALLED_PLUGIN_MARKER.length)
    const [marketplace, plugin] = afterMarker.split(PATH_SEPARATOR)
    if (marketplace && plugin) {
      return joinPath(pluginRoot.slice(0, markerAt), DATA_FOLDER, `${plugin}-${marketplace}`, CONFIG_FILE)
    }
  }
  const baseDir = configDir || (home ? joinPath(home, DEFAULT_CONFIG_DIR_NAME) : undefined)
  return baseDir === undefined ? undefined : joinPath(baseDir, DATA_FOLDER, DEV_MOD_PLUGIN_FOLDER, CONFIG_FILE)
}

type JsonObject = Record<string, unknown>
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Walks the defaults as the schema: a boolean default takes a boolean, a string
// default a non-empty string (one of ALLOWED_VALUES when listed), an object default
// an object of the same shape. The result holds every field of the defaults.
const checkSection = (
  defaults: JsonObject,
  input: JsonObject,
  parent: string,
  problems: ConfigProblem[],
): JsonObject => {
  const result: JsonObject = {}
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) {
      problems.push({ field: parent + key, reason: REASON_UNKNOWN_KEY })
    }
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    const field = parent + key
    const value = Object.hasOwn(input, key) ? input[key] : undefined
    result[key] = checkField(fallback, value, field, problems)
  }
  return result
}

const checkField = (fallback: unknown, value: unknown, field: string, problems: ConfigProblem[]): unknown => {
  if (value === undefined) {
    return fallback
  }
  if (isObject(fallback)) {
    if (isObject(value)) {
      return checkSection(fallback, value, field + FIELD_SEPARATOR, problems)
    }
    problems.push({ field, reason: REASON_NOT_OBJECT_FIELD })
    return fallback
  }
  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') {
      return value
    }
    problems.push({ field, reason: REASON_NOT_BOOLEAN })
    return fallback
  }
  if (typeof value !== 'string' || value === '') {
    problems.push({ field, reason: REASON_NOT_TEXT })
    return fallback
  }
  const allowed = ALLOWED_VALUES[field]
  if (allowed !== undefined && !allowed.includes(value)) {
    problems.push({ field, reason: REASON_NOT_ALLOWED(allowed) })
    return fallback
  }
  return value
}

// Text that is not JSON, or JSON that is not an object, gives all defaults and one problem.
export const parseConfig = (text: string): ParsedConfig => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { config: DEFAULT_CONFIG, problems: [{ field: FILE_FIELD, reason: REASON_NOT_JSON(message) }] }
  }
  if (!isObject(json)) {
    return { config: DEFAULT_CONFIG, problems: [{ field: FILE_FIELD, reason: REASON_NOT_OBJECT }] }
  }
  const problems: ConfigProblem[] = []
  // checkSection builds the result from DEFAULT_CONFIG's own shape, so it is a ChatFramesConfig.
  const config = checkSection(DEFAULT_CONFIG, json, '', problems) as ChatFramesConfig
  return { config, problems }
}

export const describeProblems = (path: string, problems: ConfigProblem[]): string =>
  `${TOAST_PREFIX} ${path}: ${problems.map(({ field, reason }) => `${field} ${reason}`).join(PROBLEM_SEPARATOR)}`

// One read of the file: the path is logged, a missing file gives the defaults without
// a word, any problem is reported once (toast and debug log) and the valid part is kept.
export const loadConfig = async (path: string | undefined, io: ConfigIo): Promise<ChatFramesConfig> => {
  if (path === undefined) {
    io.log(NO_PATH_LOG)
    return DEFAULT_CONFIG
  }
  io.log(READ_LOG_TEMPLATE(path))
  let parsed: ParsedConfig
  try {
    if (!(await io.exists(path))) {
      io.log(MISSING_LOG_TEMPLATE(path))
      return DEFAULT_CONFIG
    }
    parsed = parseConfig(await io.read(path))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    parsed = { config: DEFAULT_CONFIG, problems: [{ field: FILE_FIELD, reason: REASON_READ_FAILED(message) }] }
  }
  if (parsed.problems.length > 0) {
    const report = describeProblems(path, parsed.problems)
    io.toast(report)
    io.log(report)
  }
  return parsed.config
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Palette: which colors the rows are drawn with ───────────────────────────
// The file's `theme` decides: `light` and `dark` force a palette; `auto` follows
// Claude Code's own theme row. Claude Code's themes that are light are listed here;
// every other value (dark ones, its own `auto`, unknown, none) draws the dark palette.
const THEME_ROW_KEY = 'theme'
const LIGHT_CLAUDE_THEMES: readonly unknown[] = ['light', 'light-daltonized', 'light-ansi']
const FORCED_LIGHT_THEME = 'light'
const FORCED_DARK_THEME = 'dark'

/** What `readClaudeTheme` needs from the engine, as plain functions. */
export type ThemeIo = {
  list: () => Promise<{ key: string; value: unknown }[]>
  log: (text: string) => void
}

export const pickPalette = (config: ChatFramesConfig, claudeTheme: unknown): ChatFramesPalette => {
  if (config.theme === FORCED_LIGHT_THEME) {
    return config.colors.light
  }
  if (config.theme === FORCED_DARK_THEME) {
    return config.colors.dark
  }
  return LIGHT_CLAUDE_THEMES.includes(claudeTheme) ? config.colors.light : config.colors.dark
}

// Claude Code's theme as its `/config` row holds it; undefined when the row is
// missing or the list cannot be read (logged), so the dark palette applies.
export const readClaudeTheme = async ({ list, log }: ThemeIo): Promise<unknown> => {
  try {
    return (await list()).find(row => row.key === THEME_ROW_KEY)?.value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(THEME_READ_FAILED_LOG(message))
    return undefined
  }
}
// ─────────────────────────────────────────────────────────────────────────────
