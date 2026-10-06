/** What the top rule of a framed row shows, taken as the row was appended. */
export type ChatFramesMark = {
  /** Epoch milliseconds at which the row was appended. */
  at: number
  /** Context tokens in use at that moment (the last response's input side), null before the first response. */
  contextTokens: number | null
  /** Change in context tokens since the previous framed row; absent when there is nothing to compare with. */
  contextDelta?: number
  /** Id of the model that answered; only on assistant rows. */
  model?: string
  /** Effort level of the request that answered, null for a model without effort; only on assistant rows. */
  effort?: string | null
}

/** The marks of one session as `$.store` keeps them: row uuid to mark, oldest first. */
export type ChatFramesSessionMarks = Record<string, ChatFramesMark>

/** The names a config file may use for the color theme. */
export type ChatFramesTheme = 'auto' | 'light' | 'dark'

/** The colors of one theme: the rule and the background of each side of the conversation. */
export type ChatFramesPalette = {
  userRule: string
  userBackground: string
  assistantRule: string
  assistantBackground: string
}

/** The settings of the plugin's config file, every field present (a missing one holds its default). */
export type ChatFramesConfig = {
  theme: ChatFramesTheme
  /** Which parts of the label a rule shows. */
  show: {
    date: boolean
    time: boolean
    model: boolean
    effort: boolean
    tokens: boolean
    tokensDelta: boolean
  }
  /** Date and time patterns: YYYY, YY, MM, DD, HH, mm and ss become numbers, other text stays. */
  format: { date: string; time: string }
  icons: { time: string; model: string; tokens: string }
  colors: { dark: ChatFramesPalette; light: ChatFramesPalette }
}

declare module 'claude-code' {
  interface PluginState {
    'chat-frames': {
      /** One mark per transcript row, keyed by the row's uuid. */
      marks: StateFamily<ChatFramesMark>
      /** The effort level the main loop's latest model request asked for, null for a model without effort. */
      lastEffort: string | null
      /** Context tokens recorded on the latest framed row, null when it had none. */
      lastContextTokens: number | null
      /** The settings read from the config file at the latest `session.start`; never written before the first read. */
      config: ChatFramesConfig
    }
  }
}
