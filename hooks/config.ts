// ─── Config file: where it is ────────────────────────────────────────────────
// The file is `config.json` in the plugin's data folder.
const INSTALLED_PLUGIN_MARKER = '/plugins/cache/'
const DATA_FOLDER = 'plugins/data'
const CONFIG_FILE = 'config.json'
const DEV_MOD_PLUGIN_FOLDER = 'chat-frames-inline'
const DEFAULT_CONFIG_DIR_NAME = '.claude'
const PATH_SEPARATOR = '/'

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
// ─────────────────────────────────────────────────────────────────────────────
