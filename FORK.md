# HeirloomForge fork

Upstream: https://github.com/elidickinson/pi-claude-bridge

Initial upstream base: `07507489c0c54f7f978ab752eb9beb5cc0960f24`.

Our changes are limited to:

- Resuming retained tool-result history after Pi's explicit compact-and-retry.
- Defaulting `provider.takeOverCompaction` to `false`. Our workstation compactor owns session compaction. Setting it to `true` explicitly restores upstream behavior.
- Passive subscription usage bars sourced only from Claude Code SDK events.
- Restoring captured custom-section order after transcript replay, with complete byte-for-byte validation (not fuzzy prompt adoption).
- Loading the bridge into pi-subagents foreground children. They run in the parent's process with its provider registry but without ambient extensions, so no bridge hook captured their prompts and every turn failed closed. The bridge appends itself to the session's required child extensions at `before_agent_start` (`src/subagent-children.ts`), after Tidy's guards register theirs at `session_start`.
- Warning when a model other than the requested one answers (`message_start.model`). On this workstation, `~/.claude/settings.json` points Claude Code at the local haiku-router (`127.0.0.1:8787`), which sends every id containing "sonnet" to a local model. So `claude-bridge/claude-sonnet-5-5` was answered by `glm-5.3-flash-exl3`, while Opus ids pass through to Anthropic.
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

## Subscription usage in Powerbar

The Bridge publishes `claude-bridge-hourly` and `claude-bridge-weekly` segments
from `rate_limit_event` messages emitted by its existing Claude Code subprocess.
It does not read OAuth credentials, call an Anthropic endpoint, or launch a
separate Claude query to fetch usage. The usage code has no network client.

Load `pi-powerbar` before the Bridge. In `/extension-settings`, add **Claude
Bridge Week (SDK)** to Powerbar's right segments. Add **Claude Bridge 5h (SDK)**
if you also want the short window. Keep `sub-hourly` and `sub-weekly` enabled for
other providers. These use separate IDs so the HTTP-based usage extension cannot
overwrite the Bridge's observations. Do not alias `claude-bridge` to `anthropic`
in that extension's provider detector.

A right-segment setting including both sources looks like this:

```json
{
  "powerbar": {
    "right": "provider,model,sub-hourly,sub-weekly,claude-bridge-hourly,claude-bridge-weekly"
  }
}
```

Merge that setting into `~/.pi/agent/settings-extensions.json`, preserving any
other settings, or use the menu. The Bridge bars appear only while a
`claude-bridge` model is selected. No Powerbar installation is required to use
the Bridge itself.

Usage is the last observation from this Pi process, not a live account poll.
The countdown repaints locally once a minute. Before the first rate-limit event,
and after a known reset passes, the percentage is `?` with no bar. Missing data
is never treated as zero. New sessions and reloads clear observations. A CLI
that reports only the limiting window can show only that window; model-specific
and extra-usage limits are not relabelled as the aggregate weekly allowance.
Claude Code 2.1.280 returned both windows on a live Opus 5.5 turn, but only
`allowed` on Haiku 4.5. A fresh Haiku-only session therefore shows `?`.

`unifiedWindows` is present in the recorded CLI streams but is not yet declared
by `SDKRateLimitInfo`. After an SDK or CLI upgrade, run the one-short-request
Opus probe to verify this runtime contract through the Bridge:

```bash
node --import tsx --test tests/int-subscription-usage.mjs
```

## Updating upstream

Use the development clone, not Pi's managed installed copy:

```bash
git fetch upstream --tags
git merge upstream/main
npm ci --ignore-scripts
npm run typecheck
npm run test:unit
# Also test against the actual Pi host, rather than only package.json's dev peers:
PI_COMPAT_HOST_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent" npm run test:unit
node --env-file-if-exists=.env.test --import tsx tests/int-compact-retry.mjs
```

Inspect the merge, especially `session_before_compact`, `session_compact`, tool-result routing, and session import. Resolve any conflict by preserving external compaction as the default. Run the local-compactor tests in pi-config too, then push the tested fork commit and update the full SHA in pi-config's `agent/settings.json`. `pi update --extensions` installs the pinned ref; it does not advance that pin to a newer upstream commit.

`PI_COMPAT_HOST_ROOT` can point at a staged candidate package before updating global Pi. The suite's preload resolves Pi peers from that host, catching compatibility breaks that tests against our development dependencies would miss. In pi-config, `agent/bin/pi-upgrade X.Y.Z` stages a specific Pi release and runs our offline startup/theme, compaction/orchestrator and bridge gates. `--install` additionally runs a live compact-retry probe and refuses to replace a runtime while Pi sessions are running. Extension pins advance separately after their tests; do not use an unqualified daily `pi update --all` on the working setup.

Prefer sending the generic recovery fix and configurable ownership upstream when authorized. If upstream adopts both, keep only our external-compaction default or configure the upstream equivalent, then retire the fork once its tests pass against the released package. No automated merges or direct edits to npm's installed files.