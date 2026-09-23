# HeirloomForge fork

Upstream: https://github.com/elidickinson/pi-claude-bridge

Initial upstream base: `07507489c0c54f7f978ab752eb9beb5cc0960f24`.

Our changes are limited to:

- Resuming retained tool-result history after Pi's explicit compact-and-retry.
- Defaulting `provider.takeOverCompaction` to `false`. Our workstation compactor owns session compaction. Setting it to `true` explicitly restores upstream behavior.
- Regression tests and this documentation.
- Patched transitive dependencies within upstream's declared version ranges.

This setting covers manual and automatic session compaction, including overflow recovery. It does not route `/tree` branch summaries or `/bug` reports to the local model. Claude Code's own auto-compaction remains disabled through `DISABLE_AUTO_COMPACT=1`.

## Installation

Pi's global `packages` list should contain one pinned Git source for this fork, not the upstream npm package alongside it:

```text
git:github.com/HeirloomForge/pi-claude-bridge@<tested-full-commit-sha>
```

The local compactor is maintained separately in `HeirloomForge/pi-config`, at `agent/extensions/workstation-compaction-model.ts`. Keep it enabled. It cancels on failure instead of handing compaction back to the session model.

After changing the package source or either extension, restart Pi or use `/reload` while idle. Already-running sessions do not hot-swap their provider state when files change.

## Updating upstream

Use the development clone, not Pi's managed installed copy:

```bash
git fetch upstream --tags
git merge upstream/main
npm ci --ignore-scripts
npm run typecheck
npm run test:unit
node --import tsx tests/int-compact-retry.mjs
```

Inspect the merge, especially `session_before_compact`, `session_compact`, tool-result routing, and session import. Resolve any conflict by preserving external compaction as the default. Run the local-compactor tests in pi-config too, then push the tested fork commit and update the full SHA in pi-config's `agent/settings.json`. `pi update --extensions` installs the pinned ref; it does not advance that pin to a newer upstream commit.

Prefer sending the generic recovery fix and configurable ownership upstream when authorized. If upstream adopts both, keep only our external-compaction default or configure the upstream equivalent, then retire the fork once its tests pass against the released package. No automated merges or direct edits to npm's installed files.