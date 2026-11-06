# pendpost RFCs

Most changes to pendpost do not need this process. A bug fix, a small feature, a docs improvement:
open an issue or a pull request and go. RFCs are for the deeper changes, the ones that need design
agreement before anyone writes the code:

- a new integration or plugin seam,
- a change to how the core works (persistence, the scheduler, the data model),
- anything that touches the edges of an invariant (the approval gate, the parity rule, local-first).

If you are not sure whether your idea needs an RFC, start in [Discussions](https://github.com/pendpost/pendpost/discussions)
under Ideas, or open a feature request. A maintainer will tell you if it should become an RFC.

For smaller feedback (a bug, an idea, a question), see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
and [`SUPPORT.md`](../../SUPPORT.md).

## How it works

1. **Draft.** Copy [`0000-template.md`](0000-template.md) to `docs/rfcs/NNNN-short-slug.md`, using the
   next free number. Fill it in. Open a pull request that adds only that file, and start a thread in the
   RFCs Discussions category so the design can be debated in the open.
2. **Review.** A maintainer picks it up. Discussion happens on the pull request and in the RFCs thread.
   The proposal is expected to say, explicitly, how it holds the approval gate, the parity rule, and the
   local-first posture. An RFC that weakens any of those is declined; those are non-negotiable (see
   [`GOVERNANCE.md`](../../GOVERNANCE.md)).
3. **Accepted or declined.** Decisions are made by lazy consensus; when a proposal is contested,
   maintainers decide and their decision is final (again, [`GOVERNANCE.md`](../../GOVERNANCE.md)). On
   acceptance, the pull request is merged with the RFC's status set to `accepted` and a tracking issue is
   opened. A declined RFC is closed with the reasoning recorded, and stays in the tree for the record.
4. **Implemented.** When the tracking issue is closed and the change has shipped, the RFC's status becomes
   `implemented`.

## States

`draft` -> `review` -> `accepted` -> `implemented`, or `review` -> `declined`. The status lives in the
RFC's front-matter block and is mirrored by the `rfc` issue label on the tracking issue.

## Numbering

RFCs are numbered in the order they are opened, zero-padded to four digits (`0001`, `0002`, ...).
`0000-template.md` is the template and is never an RFC itself.
