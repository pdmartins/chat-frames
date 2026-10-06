# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are MAJOR.MINOR.REVISION and change only on a release.

## Unreleased

## 0.3.0 — 2026-10-06

### Added

- A config file, `<config-dir>/plugins/data/chat-frames-pdmartins/config.json`,
  with every field optional: `theme`, `show`, `format`, `icons` and `colors`.
  It is read at session start.
- A light color palette next to the dark one. The palette follows Claude Code's
  theme, and switching the theme with `/theme` or `/config` repaints the frames
  at once. `"theme": "light"` or `"dark"` in the file forces one.
- Label parts that can be turned on or off: date, time, model, effort, tokens
  and the token change since the previous frame.
- Date and time formats (`YYYY`, `YY`, `MM`, `DD`, `HH`, `mm`, `ss`) and the
  icons of the time, model and tokens parts.
- One warning toast, repeated in the debug log, when the config file has a
  problem. A bad field keeps its default and a file that is not valid JSON keeps
  all the defaults.
- `publish.sh`, the release script.
- A README and this changelog.
- The MIT license.

### Changed

- Renamed from the private `qp-mod-chat-frames` (harnesses) to the public
  `chat-frames`, under the MIT license.
- The plugin root moved to `plugin/`. Repo-level files stay at the repository
  root.
- The manifest has the author, license and links, and a description that no
  longer says the background is dark.
