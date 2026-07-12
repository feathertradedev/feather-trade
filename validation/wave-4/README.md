# Wave 4 validation authority foundation

This directory contains only a dependency-free validator and adversarial runtime tests. It adopts no registry event, requirement, case definition, run attempt, aggregate status/result, artifact, or evidence claim. Future authority is data, never prose, and uses this layout:

```text
validation/wave-4/
  registry/events.jsonl
  cases/<domain>.jsonl
  runs/<year>/<attempt-id>.json
```

Registry and case files are append-only JSONL. Run-attempt files are immutable JSON. Strict discovery allowlists those future authority paths plus this README, `validate.mjs`, and `test.mjs`; every other nested file, sidecar, extension, symlink, nonregular entry, unsupported Git mode/type, control-character path, or malformed UTF-8 input fails. File, aggregate-byte, physical-line, record, reference, nesting, diagnostic, and output limits apply before unbounded processing. Duplicate JSON keys are forbidden.

## Provenance is not authority

Two reconstruction artifacts are retained only as **noncanonical recovered candidates**:

- Earlier recovered draft SHA-256: `5140f497c660d13c42a2d088ccc705863558aba5c1d0aafe35fb8dc596ee2e1f`.
- Later recovered candidate SHA-256: `eac6c0e14343cb1d40602494c905c1d287d2779de29ac7d1f5e7e0f3205383ff`.

Neither digest adopts content. The sole legacy provenance label is `legacy-domain:DS-data-state`; it may appear only in the distinct closed `provenance` registry-event shape with disposition `non-resolving`. That event has no `baseRequirementId`, adopts no requirement, and cannot be referenced or mapped. Every physical JSONL prefix—including one ending in provenance—is an exact registry head, carrying forward the requirements adopted by earlier requirement events. `DS-*` IDs—including canonical `DS-03`—remain ordinary Discover requirement IDs.

Ordinary `G-*` requirements do not require a public anchor. If a registry event supplies `publicAnchorId`, the only permitted bindings are:

- `G-04` → issue #23: repeatable owned full stack, exact health reconciliation, and deterministic cleanup.
- `G-08` → issue #22: native ETH exact value, no ETH approval, gas reserve, native swap/add/remove receipt checks, and ETH/WNATIVE reconciliation.

## Record separation

- A `registry` requirement event versions one base requirement. A separate non-resolving provenance event preserves the one legacy label without entering requirement resolution. Neither shape has a subject commit, execution state, or evidence.
- A `caseDefinition` has stable ID `<BASE>.C###`, revision, base requirement, semantic key, actor, prerequisites, action, assertion IDs, negative paths, recovery, applicability, and issue references. It has no subject commit or execution result.
- A `runAttempt` binds one exact case ID/revision and exact JSONL-line SHA-256 to `subjectCommit`, `testHarnessCommit`, the exact registry-head SHA-256, timestamps, a closed environment description, and per-assertion outcomes. Optional supersession requires both a prior attempt ID and reason; the referenced attempt must be earlier, finished, and for the same case revision, while the complete supersession graph must remain acyclic.

Every object is closed. First revisions equal 1 and later revisions are contiguous. Registry/case semantic keys and child/assertion IDs are globally unambiguous; case shard prefixes match their base domain and all revisions remain in one shard. Authored `recordCommit`, aggregate requirement status/result, artifact/evidence claims, credentials, bearer/basic authentication, raw GitHub/cloud/package tokens, URL userinfo, private-key headers, cookie data, API keys, browser storage/profile/history/bookmark/download/extension dumps, prototype-affecting keys, local paths, cycles, and oversized values are rejected. Diagnostics identify only location and rule; rejected values are never echoed.

## Authority and trusted enforcement

`pnpm wave4:validate` is deliberately labeled `syntax-only`. Its output cannot be consumed as authoritative validation. Repository-bound validation requires an explicit repository and base; it verifies that commit fields are real commits and never substitutes `HEAD`.

The trusted workflow fetches only the exact event-addressed commits into a fresh, isolated bare object store with shallow filtered transfers, time/file/object-store limits, disabled hooks/config/lazy fetching, and no checkout. It streams raw NUL-delimited `ls-tree` entries, validates the complete Wave 4 subtree's paths, modes, types, counts, and byte sizes before writing, and materializes exact blob bytes with `cat-file` and exclusive fresh writes. Candidate `.gitattributes`, archive substitution, and archive exclusion therefore have no authority. Base and candidate data remain inert, and only the validator blob stored at the base SHA executes. Missing or corrupt base validators fail closed; this foundation cannot attest its own introduction. On pull requests the workflow posts context `wave4/append-only-authority` directly to the exact candidate head SHA, pending before validation and success only after the trusted base validator succeeds.

For a newly added run, `subjectCommit` must equal the exact protected, up-to-date pull-request base SHA. The referenced case revision must already exist at that base, and the base-to-candidate diff may contain only new files below `validation/wave-4/runs/`. Existing immutable runs are exempt from the new-run subject comparison. `testHarnessCommit` is checked separately and must identify a real commit in the explicit repository. This avoids an impossible self-reference to the commit enclosing the run and remains well-defined under merge or squash.

The workflow is not unskippable by itself. A repository ruleset or branch protection rule is an operational prerequisite: it must block direct/forced main updates and require the exact `wave4/append-only-authority` context. Activation order is: merge this independently audited, one-time foundation bootstrap; verify the context appears on the exact head SHA of a no-op pull request; then activate the ruleset requiring that context. This repository change does not mutate settings or claim that the bootstrap protected itself.

The normal authority context freezes both trust-root entries: `.github/workflows/wave4-authority.yml` and `validation/wave-4/validate.mjs`. Blob, mode, addition, deletion, or replacement of either fails before candidate authority is accepted. Any future trust-root upgrade therefore requires a separate, explicit, out-of-band audited upgrade procedure; it cannot be approved by the validator or workflow being replaced.

## Deterministic commands

```sh
pnpm wave4:test
pnpm wave4:validate
node validation/wave-4/validate.mjs --strict --json --base previous-tree current-tree
node validation/wave-4/validate.mjs --strict --json --repository trusted-repository --base previous-tree --expected-subject-commit protected-base-sha --candidate-commit candidate-sha current-tree
```

The CLI always emits one bounded deterministic JSON object. `--strict` and `--json` are mandatory. With `--base`, every prior registry/case JSONL byte must remain an exact prefix and every prior run file must remain byte-for-byte identical. New JSONL lines and new run files may be appended subject to the repository-bound new-run rules above.
