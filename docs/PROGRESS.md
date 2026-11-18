# Progress (resume file)
Deadline 17:00 Kyiv. Features stop 16:30; after that README, green CI, push only. Pushed by 16:55.
Stages 1-5 done (see git log). Remaining:
- [x] 6 Waitlist + review (5a67928, fix 20ee7f3: lock order). Gaps: no slotsChanged post-commit publish; expiry via sweeper only (no delayed job); no pagination/40001/FLUSHALL tests; no auto-close on normal booking; no 5-entry limit; leave/join GraphQL in stage 8
- [ ] 8 GraphQL API (Sonnet) + security-reviewer
- [ ] 9 Seed, report, perf (Sonnet)
- [ ] 10 Web + Playwright e2e (Sonnet/Haiku)
- [ ] 11 README (Haiku)

## Status update (~16:05)
- [x] 8 GraphQL API (be8daa8); security review done; fixes (foreign status NOT_FOUND, WS Origin allowlist, password cap) by Haiku in progress.
- [~] 9 seed/report: Sonnet finishing (seed acfa9c11 done ~147k rows).
- [~] 10 web: 10a scaffold (Sonnet) in progress, then Haiku UI.
Known gaps to put in README: login throttle is per-account only (no per-IP counter, lockout can be used for account-lockout DoS, check-then-record not atomic); no myAppointmentChanged/myOfferChanged/clinicBoardChanged/doctorDayChanged subscriptions; complexity limit not applied over WebSocket; waitlist gaps (see stage 6).

## Status update (16:40)
- [x] CI fixed (707f72a, ac9ab28): codegen builds shared first, web dep @graphql-typed-document-node/core, allowBuilds for @parcel/watcher.
- [x] 9 seed/report done (cdd1f12).
- [x] 11 README written (honest status, gaps).
- [~] 10 web: scaffold only (i18n, urql, slotsChanged hook, format helpers). NOT done: UI screens, forms, Playwright e2e. Listed in README 'What is not done'.
- Not verified locally: docker compose up / compose-smoke (no Docker access).
