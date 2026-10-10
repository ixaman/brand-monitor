# Project rules
- Read SPEC.MD before any task. It is the source of truth.
- Work on ONE slice at a time. Never start the next slice on your own.
- Hard rule: the main feed shows only articles published in the last 24 hours.
- The Chrome extension contains NO business logic (see SPEC.MD).
- Write tests for date parsing, URL canonicalization, Bangla matching, dedup, and the 24h logic.
- After each slice: list what changed, how to run it, how to test it, then stop.
- Never commit secrets. Use .env files and keep them in .gitignore.
