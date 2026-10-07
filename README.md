# chat-frames

A Claude Code plugin that frames each message in the transcript.

Each prompt you type and each assistant reply (each block of reply text) gets:

- a top rule that carries a label,
- a closing rule,
- a tinted background between the two rules.

By default prompts use a blue rule and replies a terracotta rule. The label can hold:

| Part | User frame | Assistant frame |
| --- | --- | --- |
| Date and time the row was added | yes | yes |
| Model and effort, like `Opus 5.5 (high)` | no | yes |
| Context tokens in use, and the change since the previous prompt or reply | yes | yes |

## Install

```
/plugin marketplace add pdmartins/claude-plugins
/plugin install chat-frames@pdmartins
```

Hooks load when a session starts, so open a new session after installing.

## Config file

The plugin works without a config file. To change anything, create this file:

```
<config-dir>/plugins/data/chat-frames-pdmartins/config.json
```

`<config-dir>` is `$CLAUDE_CONFIG_DIR` if you set it, otherwise `~/.claude`.
The file sits in the plugin's data folder, which survives plugin updates.

Create the folder with:

```
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/data/chat-frames-pdmartins"
```

Every field is optional. A field you leave out keeps its default.

### Default file

This is the complete default. A file with exactly this content changes nothing.

```json
{
  "theme": "auto",
  "show":   { "date": true, "time": true, "model": true, "effort": true, "tokens": true, "tokensDelta": true },
  "format": { "date": "DD/MM", "time": "HH:mm:ss" },
  "icons":  { "time": "🕐", "model": "🤖", "tokens": "📥" },
  "colors": {
    "dark":  { "userRule": "blue", "userBackground": "#0f1b33", "assistantRule": "claude", "assistantBackground": "#2b1811" },
    "light": { "userRule": "blue", "userBackground": "#e3ebf8", "assistantRule": "claude", "assistantBackground": "#f8e6de" }
  }
}
```

### Fields

`theme` is `auto`, `light` or `dark`. It picks the color palette, see [Theme](#theme).

`show` turns parts of the label on or off:

- `date` and `time`: the stamp. With both off, the time icon goes too.
- `model`: the model name (assistant frames only). Off drops the effort too.
- `effort`: the effort in parentheses after the model. Off drops the parentheses too.
- `tokens`: the context tokens in use. Off drops the change next to it too.
- `tokensDelta`: only the change in tokens since the previous prompt or reply, like `(+1.2k)`; see [Tokens](#tokens).

With every part off, or nothing to show, the top rule has no label.

`format` is the pattern for the date and the time. These codes are replaced:

| Code | Meaning |
| --- | --- |
| `YYYY` | year, four digits |
| `YY` | year, two digits |
| `MM` | month |
| `DD` | day |
| `HH` | hour, 24-hour clock |
| `mm` | minute |
| `ss` | second |

Codes are case-sensitive: `MM` is the month and `mm` is the minute. Any other
text stays as you wrote it.

`icons` are the symbols before the stamp, the model and the tokens.

`colors` hold one set per palette, `dark` and `light`. Each has the rule color
and the background of user frames and of assistant frames. A rule color is a
Claude Code theme color key (`claude`, `blue`) or a hex value. The plugin does
not check the color you write.

Icons, formats and colors do not accept empty text. An empty one keeps the
default. To hide a part, use `show`.

### Problems in the file

- A field with the wrong type, a value that is not allowed, or an unknown key
  keeps the default for that field.
- A file that is not valid JSON, or not a JSON object, keeps the whole default.
- Either way you get one warning toast when the file is read. It names the file,
  each field and the reason. The same text goes to the debug log.
- A missing file means the defaults, with no toast. The debug log notes that
  the defaults are in use.

### When an edit takes effect

The file is read when a session starts, and again when the plugin reloads.
The plugin does not watch the file, so an edit applies from the next session.

## Theme

With `"theme": "auto"` the palette follows Claude Code's theme. The themes
`light`, `light-daltonized` and `light-ansi` use the `light` colors. Every other
theme uses the `dark` colors.

Switching the theme with `/theme` or `/config` repaints new and existing frames.
This was seen on screen on Claude Code 2.1.291.

### Limitation of Claude Code's `auto` theme

Claude Code's own `auto` theme follows the terminal. The plugin cannot see what
Claude Code detected, so it uses the dark palette. On a light terminal with
Claude Code's `auto` theme, set this in the file:

```json
{ "theme": "light" }
```

### The terminal background

Claude Code's theme does not change the terminal's background. The terminal app
paints it. Claude Code's `light` theme is meant for a terminal with a light
background.

On a dark terminal with the `light` theme, the light palette puts the terminal's
light text on light frames. That is hard to read (seen on screen). Use a light
terminal profile, or force `"theme": "dark"`.

## How it works

These are the choices behind the frames, and the reason where there is one. The
code is in `plugin/hooks/`.

### What gets a frame

- Each prompt you type gets a frame. A prompt that did not come from the input
  box (its `origin.kind` is not `composer`) does not.
- Each block of reply text gets a frame. A block that is empty or only
  whitespace does not, and neither does the text `No response requested.`.
- Everything else stays as Claude Code draws it: slash commands, tool calls and
  their results, thinking, system rows. The plugin only handles prompt rows
  (`UserMessage`) and reply text rows (`AssistantMessage`).

### The prompt line

Claude Code paints its own grey background behind a prompt, and that grey
covers any background drawn around it. So the plugin draws the prompt line
itself: `❯ ` and the text, on the frame's background.

### Marks

When a row is added, the plugin records a mark for it: the time and the context
tokens at that moment, and for a reply also the model and the effort. The label
is built from the mark, so it keeps showing what was true when the row was
added, also after a repaint.

Marks live in the session's state and also in the plugin's store, so a resumed
session keeps its labels. The plugin's store holds 4 MiB of JSON in all, so the
limits keep the marks under that cap: 10 sessions of 1500 marks each come to
about 2.2 MB. Over 10 sessions the oldest go first, but the current one is never
dropped, so 11 can remain. Inside a session, past 1500 marks the oldest mark
goes first. The limits are `MAX_SESSIONS` and `MAX_MARKS_PER_SESSION` in
`plugin/hooks/marks.ts`.

A reply block with no mark, like an API error row, still gets a frame, with no
label. For a row with a mark, the top rule is drawn over the blank first line
Claude Code puts at the top of a reply. A row with no mark may not have that
blank line, so its rule takes a line of its own.

### Model and effort

The model name comes from the model id: `claude-opus-5-5` shows as `Opus 5.5`,
and `claude-sonnet-4-5-20250929` as `Sonnet 4.5`. A date suffix and a suffix in
brackets, like `[1m]`, are dropped. An id of any other shape shows as it is.

The effort is the one of the last step of the main loop. Steps of subagents do
not count. With no effort known, the effort shows as `--`.

### Tokens

The tokens are Claude Code's count of the context in use
(`$.session.usage().context.tokens`), read when the row is added. Claude Code's
count is the input side of the last response, so the number can lag the frame
it sits on by one response.

The change in parentheses is against the previous row that has a mark, prompt
or reply. An API error row has no mark, so it is skipped. A reply block of only
whitespace has a mark but no frame, so it can be the base. A change of zero is
not shown. A row with no earlier count to compare with has no change.

There is no count before the first response, nor right after a compaction until
the next response. Then the label has no tokens part.

## Compatibility

Built and tested on Claude Code 2.1.291. The plugin manifest has no
minimum-version field, so it does not declare a minimum.

## Development

`plugin/` is the plugin root. It is what gets installed: the marketplace
installs it as a `git-subdir` source. Repo-level files (this README, the
changelog, `publish.sh`) stay at the root.

Checks:

```
claude plugin validate plugin --strict
claude plugin test plugin
tsc -p plugin
```

`tsc -p plugin` needs the types Claude Code generates in
`plugin/.claude-plugin/types/`. Load the plugin once as a dev mod, or with
`--plugin-dir plugin`, to generate them.

A plugin loaded from a folder has no marketplace, so it reads its config from
`<config-dir>/plugins/data/chat-frames-inline/config.json`.

Releases use `bash publish.sh` (`--minor` is the default, `--major`,
`--revision`, `--dry-run`). The header of `publish.sh` has the details.

## License

MIT, see [LICENSE](LICENSE).
