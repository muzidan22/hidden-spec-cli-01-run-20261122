# mend — one patch tool for every AI edit format

`mend` applies an edit written as a unified diff, SEARCH/REPLACE blocks, a
V4A patch, or JSON text-editor tool calls, to a tree of text files.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is a file, or `-` / absent for stdin. Options and PATCH may come in
any order; `--` ends the options.

- `--format=unified | search-replace | v4a | json | auto` (default `auto`,
  which detects the format from the patch text)
- `--check` prints what would change and writes nothing
- `--strict` matches lines exactly, with no whitespace-drift tiers

## Formats

- **Unified diff**: `diff --git` sections or `---`/`+++` pairs, hunks with
  drifted line numbers, creates, deletes, renames, `\ No newline at end of
  file` handling, CRLF preservation.
- **SEARCH/REPLACE**: `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, each preceded by its path line.
- **V4A**: `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
  `*** Delete File:`, `*** Update File:`, `*** Move to:` and anchored
  chunks, including `*** End of File` chunks.
- **JSON**: one JSON array of edit objects, or one edit object per line
  (JSON Lines), with `create`, `str_replace` and `insert` commands.

## Matching and safety

Old lines are found at the first of three tiers that matches: exact, then
trailing spaces and tabs ignored, then leading and trailing ignored, with
tier-2 re-indentation of the new lines. Edits apply in patch order to the
tree as earlier edits left it; a failed edit is rolled back on its own and
later edits still run. If any edit fails, exit 1 and nothing is written;
otherwise exit 0 and the changed paths are listed in UTF-8 byte order,
with moves as `R <old> -> <new>`. Usage, missing-patch, format and parse
faults exit 2 with a single `error:` line.

Node 22, standard library only, deterministic. `runner.ts` is the kit's
trial runner, kept as shipped.
