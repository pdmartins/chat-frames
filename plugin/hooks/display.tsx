import type { ElementTable, RenderElement } from 'claude-code'

import type { ChatFramesConfig, ChatFramesMark, ChatFramesPalette } from '../types'

// ─── Display: colors, backgrounds, text, label and row layout ────────────────
// Each framed row draws, top to bottom: a rule that carries the time the row
// was appended, the model and effort (assistant rows) and the context tokens in
// use then, the message on a tinted background, then a plain rule.
// The user's prompt is drawn by this mod (prompt mark + text); an assistant
// block is the engine's own drawing; with a mark its top rule is painted over the
// engine's blank row 0, without one the top rule is a row of its own above it.
// A row with no mark has a bare top rule (no label), and so has a row whose
// label has no part left to show.
// DEFAULT_CONFIG is every setting a config file may change, with its default: what
// is drawn without a file. Parts of the label, icons, date and time patterns, colors.
// The wording of the toast and of the debug log about a config file is in this region too.
// The row trees (buildUserRow, buildAssistantRow, buildUnmarkedAssistantRow) are at the end of this region:
// what is drawn where, its colors and its text change here and nowhere else.
// 'claude' is Claude Code's terracotta theme key; raw fallback '#D77757'.
export const DEFAULT_CONFIG: ChatFramesConfig = {
  theme: 'auto',
  show: { date: true, time: true, model: true, effort: true, tokens: true, tokensDelta: true },
  format: { date: 'DD/MM', time: 'HH:mm:ss' },
  icons: { time: '🕐', model: '🤖', tokens: '📥' },
  colors: {
    dark: { userRule: 'blue', userBackground: '#0f1b33', assistantRule: 'claude', assistantBackground: '#2b1811' },
    light: { userRule: 'blue', userBackground: '#e3ebf8', assistantRule: 'claude', assistantBackground: '#f8e6de' },
  },
}
export const PROMPT_MARK = '❯ '
export const FALLBACK_COLUMNS = 80

// What the toast and the debug log say about the config file.
export const FILE_FIELD = 'file'
export const TOAST_PREFIX = 'chat-frames: config problems in'
export const PROBLEM_SEPARATOR = '; '
export const READ_LOG_TEMPLATE = (path: string) => `config: reading ${path}`
export const MISSING_LOG_TEMPLATE = (path: string) => `config: ${path} does not exist, defaults in use`
export const NO_PATH_LOG = 'config: the config directory is unknown (HOME and CLAUDE_CONFIG_DIR are unset), defaults in use'
export const REASON_NOT_JSON = (message: string) => `not valid JSON (${message}), all defaults in use`
export const REASON_NOT_OBJECT = 'must be a JSON object, all defaults in use'
export const REASON_READ_FAILED = (message: string) => `could not be read (${message}), all defaults in use`
export const REASON_UNKNOWN_KEY = 'unknown key, ignored'
export const REASON_NOT_OBJECT_FIELD = 'must be an object, default in use'
export const REASON_NOT_BOOLEAN = 'must be true or false, default in use'
export const REASON_NOT_TEXT = 'must be a non-empty string, default in use'
export const THEME_READ_FAILED_LOG = (message: string) => `theme: Claude Code's theme could not be read (${message}), the dark palette is in use`
export const REASON_NOT_ALLOWED = (allowed: readonly string[]) => `must be one of ${allowed.join(', ')}, default in use`

const NO_EFFORT_TEXT = '--' // shown when no effort is known
const DATE_TIME_SEPARATOR = ' '
const LABEL_SEPARATOR = ' · '
const THOUSANDS_SUFFIX = 'k'
const GROWTH_SIGN = '+'
const SHRINK_SIGN = '-'
const RULE_GLYPH = '─'
const LEADING_RULE_LENGTH = 2
const ONE_THOUSAND = 1000

// A model id as the API names it (`claude-opus-5-5`, `claude-sonnet-4-5-20250929`,
// `claude-opus-4-6[1m]`) becomes `Opus 5.5`; an id of any other shape is shown as is.
const MODEL_ID_PREFIX = 'claude-'
const MODEL_ID_DATE_SUFFIX = /-\d{8}$/
const MODEL_ID_CONTEXT_SUFFIX = /\[[^\]]*\]$/
const DIGITS_ONLY = /^\d+$/
const VERSION_JOIN = '.'

// The pieces of a date or time pattern; each becomes a number. The longer YYYY is
// tried before YY, and the match is case-sensitive (MM month, mm minute).
const PATTERN_TOKENS = /YYYY|YY|MM|DD|HH|mm|ss/g
// How many digits each token is padded to: four for the year, two for the rest.
const TOKEN_DIGITS: Readonly<Record<string, number>> = { YYYY: 4, YY: 2, MM: 2, DD: 2, HH: 2, mm: 2, ss: 2 }
const YEAR_MODULO = 100
const PAD_CHAR = '0'
const dateFields = (date: Date): Record<string, number> => ({
  YYYY: date.getFullYear(),
  YY: date.getFullYear() % YEAR_MODULO,
  MM: date.getMonth() + 1,
  DD: date.getDate(),
  HH: date.getHours(),
  mm: date.getMinutes(),
  ss: date.getSeconds(),
})

export const formatPattern = (pattern: string, date: Date): string => {
  const fields = dateFields(date)
  return pattern.replace(PATTERN_TOKENS, token => String(fields[token]).padStart(TOKEN_DIGITS[token] ?? 0, PAD_CHAR))
}

// Shape: `<icon> <date> <time>`; either one alone has no separator, and with
// neither shown there is no stamp (and no icon).
export const formatStamp = (ms: number, config: ChatFramesConfig = DEFAULT_CONFIG): string => {
  const date = new Date(ms)
  const parts: string[] = []
  if (config.show.date) {
    parts.push(formatPattern(config.format.date, date))
  }
  if (config.show.time) {
    parts.push(formatPattern(config.format.time, date))
  }
  return parts.length === 0 ? '' : `${config.icons.time} ${parts.join(DATE_TIME_SEPARATOR)}`
}

const formatTokenCount = (tokens: number): string =>
  tokens < ONE_THOUSAND ? `${tokens}` : `${(tokens / ONE_THOUSAND).toFixed(1)}${THOUSANDS_SUFFIX}`

export const formatTokens = (tokens: number, delta: number | undefined, config: ChatFramesConfig): string => {
  const total = `${config.icons.tokens} ${formatTokenCount(tokens)}`
  if (!config.show.tokensDelta || delta === undefined || delta === 0) {
    return total
  }
  const sign = delta < 0 ? SHRINK_SIGN : GROWTH_SIGN
  return `${total} (${sign}${formatTokenCount(Math.abs(delta))})`
}

export const formatModelName = (modelId: string): string => {
  const core = modelId.replace(MODEL_ID_CONTEXT_SUFFIX, '').replace(MODEL_ID_DATE_SUFFIX, '')
  if (!core.startsWith(MODEL_ID_PREFIX)) {
    return modelId
  }
  const [family, ...version] = core.slice(MODEL_ID_PREFIX.length).split('-')
  if (family === undefined || version.length === 0 || !version.every(part => DIGITS_ONLY.test(part))) {
    return modelId
  }
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join(VERSION_JOIN)}`
}

// Shape: `🤖 <model> (<effort>)`, without the parentheses when the effort is not shown.
export const formatModel = (modelId: string, effort: string | null, config: ChatFramesConfig): string => {
  const model = `${config.icons.model} ${formatModelName(modelId)}`
  return config.show.effort ? `${model} (${effort ?? NO_EFFORT_TEXT})` : model
}

// Label order: time, model and effort (assistant rows only), context tokens and
// their change since the previous framed row. A part with no value, a part the
// config hides, and a zero change are left out; with nothing left the label is empty.
export const formatMark = (mark: ChatFramesMark, config: ChatFramesConfig = DEFAULT_CONFIG): string => {
  const parts = [formatStamp(mark.at, config)].filter(stamp => stamp !== '')
  if (config.show.model && mark.model !== undefined) {
    parts.push(formatModel(mark.model, mark.effort ?? null, config))
  }
  if (config.show.tokens && mark.contextTokens !== null) {
    parts.push(formatTokens(mark.contextTokens, mark.contextDelta, config))
  }
  return parts.join(LABEL_SEPARATOR)
}

export const buildPlainRule = (columns: number): string => RULE_GLYPH.repeat(columns)

export const buildMarkedRule = (
  columns: number,
  mark: ChatFramesMark | undefined,
  config: ChatFramesConfig = DEFAULT_CONFIG,
): string => {
  const text = mark === undefined ? '' : formatMark(mark, config)
  const label = text === '' ? '' : ` ${text} `
  const lead = RULE_GLYPH.repeat(LEADING_RULE_LENGTH)
  const tail = RULE_GLYPH.repeat(Math.max(0, columns - lead.length - label.length))
  return lead + label + tail
}

/** The surface's own Box and Text, from `$.ui.resolve(e)`. */
export type FrameElements = Pick<ElementTable, 'Box' | 'Text'>

export type UserRowParts = { topRule: string; bottomRule: string; text: string; palette: ChatFramesPalette }
export type AssistantRowParts = {
  topRule: string
  bottomRule: string
  engineRow: RenderElement
  palette: ChatFramesPalette
}

// The engine paints its own grey background behind the prompt, which covers any
// background drawn around it, so the prompt row is drawn here instead.
export const buildUserRow = (
  { Box, Text }: FrameElements,
  { topRule, bottomRule, text, palette }: UserRowParts,
): RenderElement => (
  <Box flexDirection="column">
    <Text color={palette.userRule} wrap="truncate">
      {topRule}
    </Text>
    <Box flexDirection="row" backgroundColor={palette.userBackground}>
      <Text backgroundColor={palette.userBackground}>{PROMPT_MARK}</Text>
      <Text backgroundColor={palette.userBackground}>{text}</Text>
    </Box>
    <Text color={palette.userRule} wrap="truncate">
      {bottomRule}
    </Text>
  </Box>
)

// A marked row: the engine's row opens with a blank line (its row 0); the top
// rule is painted over that line so no gap is left between the rule and the message.
export const buildAssistantRow = (
  { Box, Text }: FrameElements,
  { topRule, bottomRule, engineRow, palette }: AssistantRowParts,
): RenderElement => (
  <Box flexDirection="column">
    <Box flexDirection="column" backgroundColor={palette.assistantBackground}>
      {engineRow}
      <Box position="absolute" top={0} left={0}>
        <Text color={palette.assistantRule} wrap="truncate">
          {topRule}
        </Text>
      </Box>
    </Box>
    <Text color={palette.assistantRule} wrap="truncate">
      {bottomRule}
    </Text>
  </Box>
)

// A row with no mark: whether the engine's row opens with a blank row 0 is not
// known (API-error rows do not), so the top rule is a row of its own above it.
export const buildUnmarkedAssistantRow = (
  { Box, Text }: FrameElements,
  { topRule, bottomRule, engineRow, palette }: AssistantRowParts,
): RenderElement => (
  <Box flexDirection="column">
    <Text color={palette.assistantRule} wrap="truncate">
      {topRule}
    </Text>
    <Box flexDirection="column" backgroundColor={palette.assistantBackground}>
      {engineRow}
    </Box>
    <Text color={palette.assistantRule} wrap="truncate">
      {bottomRule}
    </Text>
  </Box>
)
// ─────────────────────────────────────────────────────────────────────────────
