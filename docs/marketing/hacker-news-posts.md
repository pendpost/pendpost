# Hacker News posts

Ready-to-post drafts aimed at the Hacker News audience (developers, technical
founders, self-hosters). Every post here is written to pass the pendpost
brand-lint rules in `rules.json`: no em/en dashes, no AI stock vocabulary, no
promotional puffery, no build-up "it is not X, it is Y" parallelism, no
reflexive three-item lists, no filler words. That constraint lines up with what
HN rewards, so the guidelines and the audience pull the same direction.

## How to use these

- **One `Show HN` per launch.** Pick a single primary post below and lead with
  it. The alternates are angle variations for a re-submission window or for a
  different sub-community, not for posting all at once.
- **Follow HN's own rules.** `Show HN` is for something people can try. Post it
  yourself, be around in the thread to answer, and do not use marketing
  language. See the guidelines: https://news.ycombinator.com/showhn.html
- **Stay honest about the posture.** pendpost is not an autonomous posting bot,
  and the human approval gate is the point (see `DISCLAIMER.md`). Never frame
  these posts as "AI posts for you while you sleep". That claim is both untrue
  and the fastest way to get flamed on HN.
- **Disclose authorship** when you reply in someone else's thread. HN is fine
  with makers showing up; it is not fine with undisclosed plugging.
- **Lint before you post.** Run any edited copy through `brand_lint` (MCP tool
  or the dashboard composer) so a stray em dash or a stock word does not slip in.

---

## Primary Show HN

**Title**

```
Show HN: Pendpost, an MCP-native social planner with a human approval gate
```

**URL:** `https://github.com/pendpost/pendpost`

**First comment (post this yourself, right after submitting):**

```
I built pendpost because I wanted an agent to do the grind of social posting
without handing it the keys to my accounts. It runs locally, drafts posts for
the platforms I use, and queues them behind an approval step I control. Nothing
goes live until a human says yes.

The core is a fail-closed approval gate. Every post has a state: draft,
approved, or rejected. A post with no approval will not publish, and the actor
that created a post cannot be the one to approve it. The compose tool only ever
writes a draft. I made that structural rather than a checkbox you can forget,
because it is the whole reason the tool exists.

It is MCP-native. The agent side is a set of MCP tools and the web dashboard
mirrors the same contract, so anything an agent can do you can also do by hand
and watch land in the queue. Read-only tools can never publish. It self-boots
over stdio, so the MCP client launches the server for you.

Things I cared about:

- Anti-ban breakers. A Meta error 368 (an action block) halts the Meta lane and
  never auto-resumes, because 368 carries no machine-readable clear time. There
  is a cadence cap that defers bursts instead of dropping them, and a per-lane
  kill switch.
- A caption linter that runs before publish. The rules live in a JSON file you
  edit. The shipped set flags English AI-writing tells (stock vocabulary, em
  dashes, puffery) so drafts stop reading like a press release.
- Honest scheduling. Where a platform schedules natively (Facebook and YouTube,
  among others) it uses that, so those fire when your machine is off.
  Instagram, LinkedIn, X: none of them expose scheduling, so the app has to be
  running to publish those. It tells you which is which per platform instead of
  pretending.

It binds to loopback, never phones home, and keeps secrets in your own .env.
Stack is one zero-dependency Node process. Plans and state are local JSON, and
each platform is one publish engine spawned as a subprocess.

It is early and maintained part-time, so expect rough edges. MIT licensed. I
would most like feedback on the approval model, and on which platform lane to
harden next.

Try it: npx pendpost, then open http://127.0.0.1:8090
```

---

## Alternate angle A: the anti-ban / operations story

Use this if the launch window is crowded, or to reach the self-hoster and
account-safety crowd.

**Title**

```
Show HN: Pendpost, a local social planner built around not getting flagged
```

**First comment:**

```
Most "AI social" tools are a scheduler with an agent bolted on. pendpost is
shaped the other way around: it is an operations layer for the agent-plus-human
workflow, and the account-safety parts are the reason I kept building it.

What that means in practice:

- The Meta action-block breaker. Graph API error 368 halts the Meta lane and
  does not auto-resume, because the error gives you no time to resume at. Health
  probes send zero Graph traffic while the lane is blocked, so a probe cannot
  dig the hole deeper.
- A cadence cap that defers a burst to a later slot rather than dropping the
  post or firing everything at once.
- A kill switch per lane, always reachable from the dashboard and as an MCP
  tool.

None of this makes automated posting safe. It lowers the odds of an action
block and stays honest that platforms change enforcement without notice (the
DISCLAIMER spells that out). I would rather ship conservative defaults than
promise an account will never get limited.

It is local-first (binds 127.0.0.1, secrets stay in your .env), MIT licensed,
and every account still sits behind a human approval gate: an agent drafts, a
person approves, and only then does anything publish.

Repo and one-line install in the README: https://github.com/pendpost/pendpost
```

---

## Alternate angle B: the MCP / agent-tooling story

Use this for the MCP and agent-builder audience.

**Title**

```
Show HN: Pendpost, social posting as MCP tools with a human in the loop
```

**First comment:**

```
pendpost exposes social posting as MCP tools, with the safety property that the
agent can draft and schedule but cannot approve its own work.

Design notes that might interest people building MCP servers:

- Read/write split at the tool layer. Read-only tools carry the readOnlyHint
  annotation and physically cannot publish. Write tools create drafts and are
  gated by the approval rules. A test enforces that split so it cannot rot.
- Dashboard/agent parity. Every capability ships as both an MCP tool and a
  dashboard action, driven by the same contract, and a parity test fails the
  build if one face gains a capability the other lacks. It keeps the "agent can
  do more than the human can see" failure mode from ever existing.
- Self-booting stdio transport, so a client like Claude Desktop launches the
  server itself with no separate process to babysit. There is also a
  streamable-HTTP face at /mcp for the dev workflow.

The whole thing is one zero-dependency Node process. Plans and state are local
JSON, and each platform is a subprocess that emits a JSON envelope, so a broken
engine cannot take the server down with it.

It is MIT, local-first, and early. The MCP tool reference is in AGENTS.md if you
want to read the contract before installing.

https://github.com/pendpost/pendpost
```

---

## Ask HN (softer, discussion-first)

Use this only if a direct `Show HN` has already run. It leads with a question,
so it needs a real answer you are curious about, not a veiled pitch.

**Title**

```
Ask HN: How are you keeping AI agents from posting garbage to your accounts?
```

**Body:**

```
I have been building a local tool where an agent drafts social posts and a human
approves each one before it can publish, and it made me curious how others draw
that line.

If you let an agent anywhere near a publishing credential, what stops a bad draft
from going out? A hard approval step, a linter on the copy, rate limits, a
staging account, something else? And for the people who let agents post with no
human check: what has that cost you, if anything?

I will share what I landed on in the thread. Mostly I want to hear where people
put the gate, because I suspect I am missing failure modes.
```

---

## Thread replies (for organic, disclosed participation)

Drop these only into threads where they answer the question. Always
disclose that you are the maker. Never lead with the link.

**When a thread is about AI spamming social feeds:**

```
I went the opposite way on a side project: the agent can draft and schedule but
a post with no human approval will not publish, and the actor that wrote
a post is barred from approving it. Making the gate structural instead of a
setting was the only version I trusted myself with. (Disclosure: I built it,
it is MIT and local-first. Happy to go into the design if it is useful.)
```

**When a thread is about Meta / Instagram automation getting accounts banned:**

```
The one that bit me was Graph error 368. It is an action block with no
machine-readable clear time, so anything that auto-retries on it just deepens
the block. I ended up building a breaker that halts the whole Meta lane on a 368
and refuses to auto-resume, plus health probes that send zero Graph traffic
while blocked. It does not make automation safe, it just stops the tooling from
making a bad day worse. (I maintain the tool this is from; glad to share
specifics.)
```

**When a thread is about MCP servers or agent tool design:**

```
One pattern that has held up well for me: split read and write at the tool
layer, mark read-only tools with readOnlyHint so they physically cannot mutate,
and gate every write behind an approval another actor has to grant. Then a test
enforces that the human dashboard and the agent tool surface stay at parity, so
the agent never quietly gains a capability the human cannot see. (Context: this
is from an MCP-native tool I build; MIT if you want to read the code.)
```

---

## Timing and etiquette notes

- Submit between roughly 08:00 and 11:00 US Eastern on a weekday for the widest
  first-hour audience. Avoid Friday and weekends for a launch.
- Post the first comment within a minute of submitting, then stay in the thread
  for the first few hours. Answering fast matters more than the title.
- If the first `Show HN` sinks with no discussion, HN allows a second try later.
  Use a different angle from this file rather than reposting the same text.
- Reply to criticism with the concrete detail, not a defense. HN respects a
  maker who concedes a real limitation and says what they will do about it.
