import type { Register } from 'claude-code'

import { THEME_ROW_KEY, loadConfig, pickPalette, readClaudeTheme, resolveConfigPath } from './config'
import {
  DEFAULT_CONFIG,
  FALLBACK_COLUMNS,
  buildAssistantRow,
  buildMarkedRule,
  buildPlainRule,
  buildUnmarkedAssistantRow,
  buildUserRow,
} from './display'
import {
  COMPOSER_ORIGIN,
  computeMark,
  isMarkedRow,
  newestContextTokens,
  persistMark,
  restoreSessionMarks,
} from './marks'
import type { MarkStore } from './marks'

const MARKS = { plugin: 'chat-frames', key: 'marks' } as const
const LAST_EFFORT = { plugin: 'chat-frames', key: 'lastEffort' } as const
const LAST_CONTEXT_TOKENS = { plugin: 'chat-frames', key: 'lastContextTokens' } as const
const CONFIG = { plugin: 'chat-frames', key: 'config' } as const
const PALETTE = { plugin: 'chat-frames', key: 'palette' } as const
const NEVER_WRITTEN_VERSION = 0
const NO_RESPONSE_TEXT = 'No response requested.' // the engine draws nothing for it

// The engine reads each `$` call at its site, so `$.store` is never passed on as a
// value: this hands the persistence functions the four calls they need.
const storeOf = ($: { store: MarkStore }): MarkStore => ({
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  delete: key => $.store.delete(key),
  keys: () => $.store.keys(),
})

export const register: Register = on => {
  // `turn.step` fires for subagent requests too; only the main loop's (no
  // `agentId`) is kept, so the latest effort is the one the main thread asked for.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await $.state.set(LAST_EFFORT, e.effort === undefined ? null : String(e.effort))
    }
    return yield* next(e)
  })

  // `session.append` does not run for the rows a resume loads, and `$.state` ends
  // with the process, so the marks saved in `$.store` are put back here. The first
  // `session.start` is awaited before the first turn, and it runs again on a reload:
  // a mark is written over its saved copy, the baseline only when none is held.
  // The config file is read here too, so on a reload as well, and with Claude Code's
  // theme it gives the palette; before the first read nothing is in state and the
  // defaults apply (the dark palette).
  on('session.start', async ($, e, next) => {
    const path = resolveConfigPath({
      pluginRoot: $.plugin.root,
      configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
      home: await $.env.get('HOME'),
    })
    const config = await loadConfig(path, {
      exists: filePath => $.fs.exists(filePath),
      read: filePath => $.fs.read(filePath),
      log: text => $.ui.log(text, { to: 'debug' }),
      toast: text => $.ui.toast(text),
    })
    await $.state.set(CONFIG, config)
    const claudeTheme = await readClaudeTheme({
      list: () => $.config.list(),
      log: text => $.ui.log(text, { to: 'debug' }),
    })
    await $.state.set(PALETTE, pickPalette(config, claudeTheme))
    const marks = await restoreSessionMarks(storeOf($), text => $.ui.log(text, { to: 'debug' }), await $.session.id())
    await Promise.all(Object.entries(marks).map(([id, mark]) => $.state.set({ ...MARKS, id }, mark)))
    const savedTokens = newestContextTokens(marks)
    const { version } = await $.state.get(LAST_CONTEXT_TOKENS)
    if (savedTokens !== undefined && version === NEVER_WRITTEN_VERSION) {
      await $.state.set(LAST_CONTEXT_TOKENS, savedTokens)
    }
    return next(e)
  })

  // A change of Claude Code's theme row: once it is written, the palette is chosen
  // again with the new value (the one `next` reports, which a hook may have clamped).
  // A refused change leaves the palette as it was.
  on('config.set', { key: THEME_ROW_KEY }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      const { value: config = DEFAULT_CONFIG } = await $.state.get(CONFIG)
      await $.state.set(PALETTE, pickPalette(config, result.value))
    }
    return result
  })

  // Marks only the main thread's rows this mod frames (see isMarkedRow). A row's
  // uuid is the requestId its ui.render receives, so the mark is keyed by it.
  on('session.append', async ($, e, next) => {
    if (!isMarkedRow(e)) {
      return next(e)
    }

    const { context } = await $.session.usage()
    const { value: previousTokens } = await $.state.get(LAST_CONTEXT_TOKENS)
    const { value: effort } = await $.state.get(LAST_EFFORT)
    const mark = computeMark({
      now: await $.clock.now(),
      contextTokens: context.tokens ?? null,
      previousTokens,
      origin: e.origin,
      effort,
    })

    await $.state.set({ ...MARKS, id: e.uuid }, mark)
    await $.state.set(LAST_CONTEXT_TOKENS, mark.contextTokens)
    await persistMark(storeOf($), text => $.ui.log(text, { to: 'debug' }), () => $.session.id(), e.uuid, mark)
    return next(e)
  })

  // Every prompt of the person and every assistant text block is framed; the
  // label is the mark's when there is one. A row with no mark (a stand-in row, a
  // row a resume loaded without saved marks) gets a bare rule and, for the
  // assistant, a layout that does not assume the engine's blank row 0.
  on('ui.render', { component: ['UserMessage', 'AssistantMessage'] }, async ($, e, next) => {
    if (e.component === 'UserMessage' && e.props.origin.kind !== COMPOSER_ORIGIN) {
      return next(e)
    }
    if (e.component === 'AssistantMessage' && (e.props.text.trim() === '' || e.props.text === NO_RESPONSE_TEXT)) {
      return next(e)
    }

    const { value: mark } = await $.state.get({ ...MARKS, id: e.requestId })
    const { value: config = DEFAULT_CONFIG } = await $.state.get(CONFIG)
    const { value: palette = DEFAULT_CONFIG.colors.dark } = await $.state.get(PALETTE)
    const columns = e.viewport?.columns ?? FALLBACK_COLUMNS
    const topRule = buildMarkedRule(columns, mark, config)
    const bottomRule = buildPlainRule(columns)
    const elements = $.ui.resolve(e)

    if (e.component === 'UserMessage') {
      return buildUserRow(elements, { topRule, bottomRule, text: e.props.text, palette })
    }
    const build = mark === undefined ? buildUnmarkedAssistantRow : buildAssistantRow
    return build(elements, { topRule, bottomRule, engineRow: await next(e), palette })
  })
}
