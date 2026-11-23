# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Unge32/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Unge32/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for [make.fun's "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100). Referral code: `seno-angga`.

**mend** is one command-line tool that applies the edits AI models write — in
all four formats models actually use — to one written specification, and
changes every file or none:

- a **unified diff** (often with wrong line numbers),
- **SEARCH/REPLACE** blocks,
- the **V4A** patch format,
- **text-editor tool calls as JSON**.

It finds the lines an edit names even when the model drifted their whitespace
or indentation (three matching tiers: exact, trailing-whitespace, full
trim with re-indentation), takes the hunk nearest the line number the diff
claims, follows V4A anchors and cursors, and reports every failure instead
of writing half a patch. A failed edit changes nothing, and the edits after
it still run, so every failure is reported.

## Run it

Node 22, standard library only — nothing is installed, nothing is fetched,
no network is used:

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

```sh
# Apply a patch file
node main.ts fix.patch

# Pipe a patch in, dry-run it first
cat fix.patch | node main.ts --check -
```

Exit 0 lists the files that changed (`A`/`D`/`M`, `R old -> new` for a move)
and `ok: <n> files`. Exit 1 lists one `error: <code> <path>` line per failed
edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage,
missing-patch, undetected-format or parse error (`error: parse <N>` names
the patch line).

## The files

- `main.ts` — the CLI. `SPEC.md` is the whole specification it implements.
- `runner.ts` — the kit's runner, unchanged. In a trial it reads the checks
  from the environment and runs `main.ts` on each one.
- `check.ts` — the practice set on your own machine:
  `node check.ts <practice.json>`. Practice score: **1000** (100 of 100).

## How it works

Every check is one run in a fresh directory. mend reads the patch in the
format it detects (or the one named), turns each section or block into one
edit, and applies the edits in order to the tree as earlier edits left it.
Matching is tiered: exact lines first, then trailing whitespace ignored,
then leading and trailing whitespace ignored with the new lines re-indented
to the file's own indentation — context lines are always written as the
file's own matched lines. Unified hunks take the occurrence nearest the
claimed line number (adjusted for earlier hunks); SEARCH/REPLACE fails
ambiguous instead of guessing; V4A chunks follow their anchor and cursor
and end-of-file chunks only match at the end of the file. Created files get
LF breaks; changed files keep their own break (CRLF or LF) and their final
line break, except where a unified hunk's `\ No newline at end of file`
says otherwise. Unsafe paths (`..`, absolute, backslash, empty segments)
fail before anything else about the edit is looked at.

Deterministic: the same check gives the same exit code, stdout and files
every run — no times, no randomness, no network.
