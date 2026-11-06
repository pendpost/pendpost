# RFC NNNN: title

> **Status:** draft
> **Author:** your GitHub handle
> **Tracking issue:** (link, once accepted)
> **Created:** YYYY-MM-DD
> **Updated:** YYYY-MM-DD

Copy this file to `docs/rfcs/NNNN-short-slug.md` and fill in every section. Delete this line and the
guidance in parentheses as you go. Keep it in house style: no em or en dashes, English only, the product
name is always lowercase `pendpost`.

## Summary

One paragraph. What is this, in plain terms.

## Motivation

What problem does this solve, and for whom (a solo creator, an agency running several clients,
a developer wiring pendpost into an agent)? Why is the status quo not enough?
What is the outcome if we do this?

## Guide-level explanation

Explain the change as you would to a pendpost user or a new contributor. Use examples. If there are new
concepts, name and define them.

## Detailed design

The real design. Data shapes, the engine verbs or routes touched, the MCP tools affected, the on-disk
layout, migrations. Enough that a competent contributor could build it from this section.

## How it holds the invariants

Say, explicitly, how the proposal preserves each of these. An RFC that weakens any of them is declined.

- **The approval gate.** Publishing stays fail-closed; nothing publishes without approval, and no actor
  approves their own post.
- **The parity rule.** Every new capability ships on both the `/api` and the `/mcp` faces, and
  `test/parity-check.mjs` still passes.
- **Local-first, zero telemetry.** The engine still binds loopback and still sends nothing on its own.

## Drawbacks

Why might we not want to do this? Cost, complexity, maintenance burden, risk.

## Alternatives

What else did you consider, and why is this better? Include the "do nothing" option.

## Unresolved questions

What is still open, to be settled during review or deferred to implementation.

## Prior art

How do other tools solve this, if at all? Links welcome.
