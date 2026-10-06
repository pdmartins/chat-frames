import type { ElementTable, RenderElement } from 'claude-code'

import type { ChatFramesMark } from '../types'

// ─── Display: colors, backgrounds, text, label and row layout ────────────────
// Each framed row draws, top to bottom: a rule that carries the time the row
// was appended, the model and effort (assistant rows) and the context tokens in
// use then, the message on a tinted background, then a plain rule.
// The user's prompt is drawn by this mod (prompt mark + text); an assistant
// block is the engine's own drawing; with a mark its top rule is painted over the
// engine's blank row 0, without one the top rule is a row of its own above it.
// A row with no mark has a bare top rule (no label).
// The row trees (buildUserRow, buildAssistantRow, buildUnmarkedAssistantRow) are at the end of this region:
// what is drawn where, its colors and its text change here and nowhere else.
export const USER_COLOR = 'blue'
export const USER_BACKGROUND = '#0f1b33' // very dark blue
export const ASSISTANT_COLOR = 'claude' // Claude Code's terracotta theme key; raw fallback '#D77757'
export const ASSISTANT_BACKGROUND = '#2b1811' // very dark terracotta
export const PROMPT_MARK = '❯ '
export const FALLBACK_COLUMNS = 80
const STAMP_ICON = '🕐'
const MODEL_ICON = '🤖'
const NO_EFFORT_TEXT = '--' // as qp-statusline shows a missing effort
const TOKENS_ICON = '📥'
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

export const formatStamp = (ms: number): string => {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${STAMP_ICON} ${day} ${time}`
}

const formatTokenCount = (tokens: number): string =>
  tokens < ONE_THOUSAND ? `${tokens}` : `${(tokens / ONE_THOUSAND).toFixed(1)}${THOUSANDS_SUFFIX}`

export const formatTokens = (tokens: number, delta: number | undefined): string => {
  const total = `${TOKENS_ICON} ${formatTokenCount(tokens)}`
  if (delta === undefined || delta === 0) {
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

// Same shape as qp-statusline's model item: `🤖 <model> (<effort>)`.
export const formatModel = (modelId: string, effort: string | null): string =>
  `${MODEL_ICON} ${formatModelName(modelId)} (${effort ?? NO_EFFORT_TEXT})`

// Label order: time, model and effort (assistant rows only), context tokens and
// their change since the previous framed row. A part with no value, and a zero
// change, are left out.
export const formatMark = (mark: ChatFramesMark): string => {
  const parts = [formatStamp(mark.at)]
  if (mark.model !== undefined) {
    parts.push(formatModel(mark.model, mark.effort ?? null))
  }
  if (mark.contextTokens !== null) {
    parts.push(formatTokens(mark.contextTokens, mark.contextDelta))
  }
  return parts.join(LABEL_SEPARATOR)
}

export const buildPlainRule = (columns: number): string => RULE_GLYPH.repeat(columns)

export const buildMarkedRule = (columns: number, mark: ChatFramesMark | undefined): string => {
  const label = mark === undefined ? '' : ` ${formatMark(mark)} `
  const lead = RULE_GLYPH.repeat(LEADING_RULE_LENGTH)
  const tail = RULE_GLYPH.repeat(Math.max(0, columns - lead.length - label.length))
  return lead + label + tail
}

/** The surface's own Box and Text, from `$.ui.resolve(e)`. */
export type FrameElements = Pick<ElementTable, 'Box' | 'Text'>

export type UserRowParts = { topRule: string; bottomRule: string; text: string }
export type AssistantRowParts = { topRule: string; bottomRule: string; engineRow: RenderElement }

// The engine paints its own grey background behind the prompt, which covers any
// background drawn around it, so the prompt row is drawn here instead.
export const buildUserRow = ({ Box, Text }: FrameElements, { topRule, bottomRule, text }: UserRowParts): RenderElement => (
  <Box flexDirection="column">
    <Text color={USER_COLOR} wrap="truncate">
      {topRule}
    </Text>
    <Box flexDirection="row" backgroundColor={USER_BACKGROUND}>
      <Text backgroundColor={USER_BACKGROUND}>{PROMPT_MARK}</Text>
      <Text backgroundColor={USER_BACKGROUND}>{text}</Text>
    </Box>
    <Text color={USER_COLOR} wrap="truncate">
      {bottomRule}
    </Text>
  </Box>
)

// A marked row: the engine's row opens with a blank line (its row 0); the top
// rule is painted over that line so no gap is left between the rule and the message.
export const buildAssistantRow = (
  { Box, Text }: FrameElements,
  { topRule, bottomRule, engineRow }: AssistantRowParts,
): RenderElement => (
  <Box flexDirection="column">
    <Box flexDirection="column" backgroundColor={ASSISTANT_BACKGROUND}>
      {engineRow}
      <Box position="absolute" top={0} left={0}>
        <Text color={ASSISTANT_COLOR} wrap="truncate">
          {topRule}
        </Text>
      </Box>
    </Box>
    <Text color={ASSISTANT_COLOR} wrap="truncate">
      {bottomRule}
    </Text>
  </Box>
)

// A row with no mark: whether the engine's row opens with a blank row 0 is not
// known (API-error rows do not), so the top rule is a row of its own above it.
export const buildUnmarkedAssistantRow = (
  { Box, Text }: FrameElements,
  { topRule, bottomRule, engineRow }: AssistantRowParts,
): RenderElement => (
  <Box flexDirection="column">
    <Text color={ASSISTANT_COLOR} wrap="truncate">
      {topRule}
    </Text>
    <Box flexDirection="column" backgroundColor={ASSISTANT_BACKGROUND}>
      {engineRow}
    </Box>
    <Text color={ASSISTANT_COLOR} wrap="truncate">
      {bottomRule}
    </Text>
  </Box>
)
// ─────────────────────────────────────────────────────────────────────────────
