# Agent profile skills

Profiles can optionally name CLI-native skills. Existing profiles deserialize
with an empty list, preserving each CLI's usual automatic skill choice. The
profile editor discovers file-backed personal and fixed-directory project
skills and accepts manual names for plugin, synced, and per-node skills. It
does not install or copy skill content.

The Rust runner validates names and adds Claude Code `/name` or Codex `$name`
mentions to the rendered prompt before the process starts. The same contract
is mirrored in TypeScript for profile validation and the browser mock preview.
Custom CLIs remain unchanged because their skill invocation semantics are
unknown. The CLI remains responsible for resolving and executing a selected
skill; missing or unavailable skills must be diagnosed with that CLI.
