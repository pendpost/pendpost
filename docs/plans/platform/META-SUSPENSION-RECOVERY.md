# Meta suspension and 368 recovery runbook

This explains what a Meta error 368 means in pendpost, why the Meta lane stops,
and how to recover safely. The behaviour is implemented in
`scripts/meta-social.mjs` (the breaker) and `lib/accounts.mjs` / `lib/state.mjs`
(the recorded block state).

## What a 368 is

Meta error 368 is an action block: Meta has temporarily blocked the account from
performing an action (often after activity it considers abusive or after a policy
issue). A 368 carries no machine-readable clear time. Meta's verbatim
`error_user_msg`, when present, is the only human hint about when it lifts.

## What pendpost does automatically

- The publish engine catches a 368, sets `blocked368` on its run envelope, and
  records the block in pendpost (or writes a sentinel that pendpost absorbs
  on next boot if pendpost is down).
- The scheduler then halts the Meta lane. It NEVER auto-resumes on a guessed
  timestamp, because resuming while the block is still in force would compound it.
- Health probes send zero Graph traffic for Meta while a block is recorded, so
  pendpost cannot accidentally poke a blocked account.
- This is a one-way breaker by design: only an explicit clear re-enables the lane.

## Two related kill switches

- **Lane pause flag.** `data/plans/meta-lane.json` `{ "paused": true }`, or the
  env var `META_PUBLISHING_PAUSED=true`, pauses the Meta lane independently of any
  368. Paused writes are clean no-ops (envelope `ok:true, paused:true`); reads
  still work.
- **Cadence cap.** `data/plans/meta-lane.json` `{ "cadence": { "maxPer24h": N, "minGapMinutes": M } }`
  defers (never drops) Meta publishes that would exceed the cap. A throttled post
  stays due and publishes on a later tick.

## Recovery steps

1. Do not retry. Confirm the lane is halted (the dashboard shows the recorded
   block; activity shows the circuit-breaker entry).
2. Resolve the block on Meta's side first. Wait for the account to be reinstated,
   complete Business Verification if required, and address whatever triggered the
   block.
3. Prefer a System User token for automated publishing once healthy
   (`node scripts/meta-social.mjs setup-system-user ...`). The System User
   identity is necessary but not sufficient on its own; the account must be
   healthy first.
4. Keep the lane paused (`meta-lane.json` `paused:true`) until you are confident
   the account is reinstated.
5. Only then clear the recorded block explicitly (via the dashboard or the
   `pendpost_record_block` tool with `blockedUntil: null`) and set `paused:false`.
6. Resume with a conservative cadence. Lower `maxPer24h` and raise
   `minGapMinutes` for a while before returning to normal.

The goal is to break the retry loop that turns a temporary action block into a
longer suspension. When in doubt, stay paused.
