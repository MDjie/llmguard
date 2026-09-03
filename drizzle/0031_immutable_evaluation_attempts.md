# 0031 Immutable evaluation attempts

Evaluation retries append rows keyed by run, case and attempt. Updates are rejected so a
failed or inconvenient first result cannot be overwritten by a later retry. Deletes remain
available only for the separately governed retention workflow.

The old uniqueness rule is replaced without deleting existing evidence. Rollback would
collapse multiple attempts and is therefore not automatic; export and sign all attempt rows
before any approved rollback.
