# Governance

pendpost is maintained by the @pendpost/maintainers team under Nomadik GmbH, the copyright holder. The project is MIT-licensed and local-first. This document explains who does what, how decisions get made, and the lines we do not cross.

It is short on purpose. pendpost is maintained part-time by a small team, so the process is lightweight by design.

## Roles

**Users** run pendpost, file issues, ask questions, and report bugs. You do not need to write code to help: a clear bug report with reproduction steps, a documentation fix, or a well-scoped feature request all move the project forward.

**Contributors** open pull requests. Anyone can become a contributor by sending a change. Work on a short-lived feature branch and open a pull request into `develop`, the default branch and integration trunk. See `CONTRIBUTING.md` for how to run the project and the rules a change has to satisfy.

**Maintainers** are the @pendpost/maintainers team. They review and merge pull requests, triage issues, cut releases, and uphold the non-negotiables below. Maintainers have commit access and the final say on what lands. Releases promote in one direction only: `develop` to `staging` to `main`, where releases are tagged.

## How decisions are made

Most decisions happen in the open on pull requests and issues, by lazy consensus. A change that has been reviewed, has no unresolved objections from a maintainer, and passes the test gate (`npm run check`) can be merged. If a maintainer raises a concern, it should be resolved or explicitly overruled before merge, not ignored.

When consensus is unclear or a change is contested, maintainers decide, and their decision is final. We aim to explain the reasoning rather than just rule.

The team is small and part-time, so please allow time. We read every issue and pull request. Small, focused changes with clear reproduction steps get reviewed fastest.

## Non-negotiables

Some properties of pendpost are not up for negotiation in a pull request. A change that weakens any of these will be rejected regardless of how good the rest of it is.

- **The human approval gate.** Publishing is fail-closed. A post with no approval never publishes, and the actor who created a post cannot approve it. There is no self-approval. No change may weaken or bypass the gate.
- **The parity rule.** Every capability ships on both the web API (`/api`) and the MCP face (`/mcp`). `test/parity-check.mjs` enforces this and fails the build on drift. If you add a capability to one face, add it to the other.
- **The house style.** No em dash and no en dash characters anywhere. Use a hyphen, a comma, or restructure. English only. The product name is always lowercase `pendpost`, even at the start of a sentence. pendpost ships a brand-lint that flags violations.

## Scope

pendpost is the local-first, MIT-licensed core. A separate hosted commercial cloud for agencies is out of scope for this repository and would be a separate product if it ever exists. See `ROADMAP.md` for where the project might go. The local-first, zero-telemetry core stays as it is.

## Becoming a maintainer

Maintainers are added by invitation from the existing @pendpost/maintainers team. The path is sustained, high-quality contributions over time: good pull requests, helpful reviews, sound judgement on the non-negotiables, and care for other contributors. There is no application form. When the team sees that pattern, it invites.

## Code of conduct

Participation in pendpost is governed by `CODE_OF_CONDUCT.md`. Report unacceptable behaviour privately to conduct@pendpost.com. Reports are reviewed promptly and fairly, and the reporter's privacy is respected.
