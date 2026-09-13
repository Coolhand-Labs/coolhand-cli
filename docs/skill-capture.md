# Skill Capture

`coolhand sync-skills` uploads locally-built Claude **skills** (`SKILL.md` files) to Coolhand as
client files, so a client's skill-building activity becomes citable context/evidence — the same
motivating use case as `map-claude-projects`, but capturing each skill's actual content as its own
client file rather than a single directory-tree listing.

## Sources

The command scans three local skill stores by default, each tagged with a `sourceKind`:

| sourceKind | Path | What it is |
| ---------- | ---- | ---------- |
| `authored` | `~/Documents/Claude` (recursively) | User-facing, often iCloud-synced "source of truth" skill files |
| `installed` | `~/Library/Application Support/Claude/local-agent-mode-sessions` | Cowork's installed runtime copies — a fresh full set per local-agent-mode session, so this is the noisiest source |
| `claude-code` | `~/.claude/skills` | Claude Code's own skills directory |

`--root PATH` replaces all three defaults with a single custom root (tagged `sourceKind: custom`).
`--source NAME` (repeatable, comma-separable) restricts the default scan to one or more of
`authored`, `installed`, `claude-code` — useful to skip the noisy `installed` tree for a faster run.
A missing root (e.g. no `~/.claude/skills` on a machine that's never used Claude Code) simply
yields zero matches from that root; it is never treated as an error.

## What it does

1. **Scan.** Recursively finds every file literally named `SKILL.md` under each root.
2. **Hash and dedupe.** Every discovered file is read and SHA-256 hashed. Files are grouped by
   `(skillName, contentHash)` — not skill name alone, so a genuinely edited authored copy is never
   silently squashed by a stale installed duplicate of the same name. Within a group, one canonical
   file is chosen to upload: prefer `authored` over `claude-code` over `installed` over `custom`,
   then the newest modification time, then path order as a final deterministic tie-break. The rest
   of the group only contributes to a `duplicateCount`. The skill's display name and description
   come from its YAML frontmatter (`name:`/`description:`), falling back to the parent directory's
   name when frontmatter is absent or incomplete.
3. **Upload.** Each surviving candidate is uploaded via the same `uploadClientFile()` core that
   `upload-client-file` and `map-claude-projects` use, as a `document`-type client file. `metadata`
   carries `source: 'sync-skills'`, `skillName`, `sourceKind`, `sourcePath`, `contentHash`,
   `discoveredAt`, `duplicateCount`, and `root`.

## How duplicates are avoided

Two separate mechanisms handle two different kinds of duplication:

- **On-disk duplication** (many copies of the same skill across `installed` session folders) is
  handled by the content-hash dedup described above, before anything is uploaded.
- **Cross-run duplication** (not re-uploading a skill that hasn't changed since last time) is
  handled by a local state file, `skills-state.json`, kept next to `config.json` in the same
  config folder (`~/.coolhand`, or `COOLHAND_CONFIG_DIR`). It records, per client, each uploaded
  skill's content hash. A candidate whose hash matches its recorded hash is skipped (`unchanged`);
  a candidate with no record, or a **different** hash than recorded (the skill's authored content
  genuinely changed), is uploaded and the record is updated. `--force` bypasses this check and
  re-uploads every matched skill regardless of prior state.

Unlike `analyze-claude-sessions`, there is no mtime pre-filter cutoff — skill counts on a typical
machine are small (dozens, not thousands of session transcripts), so a full re-scan and hash
comparison on every run is cheap and simpler to reason about than an incremental cutoff.

There is currently no server-side way to ask "has a client file with this content hash already
been uploaded for this client" — the `client_files` API only supports creating a file, not
listing or searching existing ones. `skills-state.json` is therefore the only source of truth for
what has already been sent from *this* machine; deleting it, or running `sync-skills` for the same
client from a different machine, means the next run re-uploads everything it finds (each upload is
still deduplicated against whatever else that run discovers, just not against a prior machine's
uploads).

## Choosing what gets uploaded

```bash
# Only skills from the authored, human-facing location — skip the noisy installed-copies tree
coolhand sync-skills --source authored

# Only skills whose name contains "eos"; or everything except them
coolhand sync-skills --skill eos
coolhand sync-skills --exclude-skill eos

# Scan a custom location instead of the 3 defaults
coolhand sync-skills --root /Volumes/backup/old-mac/Documents/Claude
```

`--skill`/`--exclude-skill` repeat (`--skill a --skill b`) or take comma lists (`--skill a,b`) and
match skill names as case-insensitive substrings — the same normalization
`analyze-claude-sessions` uses for `--project`/`--exclude-project`. Combine with `--dry-run` first
to preview the effect; the summary reports how many candidates a filter excluded (`filteredOut`).

## Flags

| Flag | Effect |
| ---- | ------ |
| `--root PATH` | Search only PATH (recursively) instead of the 3 default roots; matches tagged `sourceKind: custom`. |
| `--source NAME` | Restrict the default scan to `authored`, `installed`, and/or `claude-code` (repeatable, comma-separable). |
| `--skill NAME` | Only matching skill names (repeatable, comma-separable). |
| `--exclude-skill NAME` | Skip matching skill names (repeatable, comma-separable). |
| `--force` | Re-upload every matched skill, ignoring `skills-state.json`'s unchanged-content skip. |
| `--dry-run` | Scan, hash, and dedupe without uploading or touching local state. |
| `--client-id` | Use a specific stored client instead of the default. |
| `--json` | Emit machine-readable JSON output instead of human-readable text. |

The canonical flag reference lives in [commands.md](./commands.md#sync-skills).
