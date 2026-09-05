# Detection V2 data workbench

These tools generate local, immutable artifacts. They do not publish policies or grant model quality approval.

## Prepare and review

Use `pnpm detection:dataset-prepare --help`. Prepare reads the existing detection-case JSONL schema, groups source/template/normalized/near-duplicate families before assigning development/calibration/test splits, and resets all imported approval claims. Inputs over the declared comparison/text budget fail explicitly.

The review registry is an operator-controlled JSON array of `{reviewerId, publicKeyPem, role: reviewer|adjudicator, active}`. Use distinct Ed25519 public keys for actual independent reviewers. Never import a registry supplied by an untrusted candidate or model as the authoritative registry. The private key is read only from an explicitly selected `DETECTION_REVIEW_KEY_*` environment variable. Do not commit private keys.

The `review` operation appends a signed review to one record. The signature binds the complete candidate, labels and previous review. Two independent matching reviews resolve the annotation; disagreements require a third authorized adjudicator. Self-review and alternate reviewer IDs sharing a key are rejected. To correct or withdraw an annotation, prepare a new candidate revision, retain the old signed record, and re-review; existing signatures cannot be reused after changing text or labels.

The `export` operation reads an assembled workbench manifest and the trusted registry. A locked export requires independently reviewed, non-synthetic records. Export is still `NOT_EVALUATED`: the registry proves authorized signers, not human competence or actual model quality. Preserve source authorization and all annotation evidence. Use locked test-split records only for final tests, not calibration. Keep sensitive artifacts in approved encrypted storage with access and retention controls.

## Offline assistance

Use `pnpm detection:assist-candidates --help`. It requires an approved private profile and explicit network authorization. Template IDs cover lexicon curation, prelabeling, error triage and benign variants. Supply only authorized records; untrusted instructions are data. Results remain `candidate`/`needs_review`, including when the model claims confidence.

Budgets bound calls, reserved input-byte/output-token units and wall time. Byte reservation is a conservative operational budget, not a certified tokenizer measurement or a monetary-price guarantee. Checkpoints bind all inputs, profile and template; resumes do not repeat completed items. Each saved checkpoint is a new file. Failed items are preserved, not silently retried; start a new explicitly budgeted job if necessary. Model output never executes as SQL, shell or production configuration.

Generated variants retain their parent and group and must be combined with the original records before dataset validation. Synthetic families are never accepted as production gold. Review raw content in a customer-authorized environment; private-only applies to offline tasks as well as online inference.
