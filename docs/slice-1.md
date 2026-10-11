# Slice 1: clients and keyword configuration

Run `pnpm db:migrate`, then `pnpm dev` and open `/clients` after signing in with an approved Google account. The shared workspace lists active and inactive clients; selecting one scopes keyword reads, edits and deletes. Admin/analyst can manage; viewer can only read. Every page/action and repository operation checks current approval/role in PostgreSQL. Next.js Server Actions provide same-origin mutation protection. Invalid input returns a visible error; missing client URLs return 404.

Only `clients` and `keywords` are added by `001_slice1`. Client deletion cascades to its keywords, with an explicit confirmation button in the UI. Keyword edits increment revision atomically, including concurrent updates. No historical revision table or rematch job is needed until article processing exists.

Terms, aliases, exclusions and Boolean literal leaves remove U+200B/U+200C/U+200D/U+FEFF and normalize NFC (including canonical Bangla nukta forms). Aliases and exclusions are deduplicated after normalization. Lists accept at most 50 nonblank terms of 500 characters each. Client names accept 200 characters and notes 10000. Matching article text is deferred to slice 3.

Boolean JSON uses a finite tree:

```json
{"op":"and","args":[{"op":"literal","value":"ব্র্যান্ড"},{"op":"not","arg":{"op":"literal","value":"চাকরি"}}]}
```

`literal` has a `value`; `not` has one `arg`; `and`/`or` have 2–20 `args`. Unknown fields/operators, empty literals, depth over 10 and trees over 100 nodes are rejected. Exact/any rules require an empty Boolean field. Expressions are data and never executed as code. Aliases are alternatives and exclusions veto matches when the matcher is implemented.

Checks: `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`. Unit tests cover rule bounds and Bangla normalization; integration tests use real PostgreSQL for CRUD, scoping, revisions, role changes, disabled users, constraints and cascade cleanup.

On a disposable database, `pnpm db:rollback` removes only slice 1, preserving auth. `pnpm db:migrate` restores its empty tables. A second rollback removes slice 0. Fresh setup, migration idempotency, latest-slice rollback and full rollback/reapply were verified on a separate disposable database.
