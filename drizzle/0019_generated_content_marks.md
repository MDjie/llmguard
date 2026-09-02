# 0019 generated-content marks

- Stores no generated raw content. It stores a keyed content fingerprint, signed metadata, the explicit-mark result and any legally required exemption record.
- Exemption rows are constrained to retain identity, agreement version and purpose for at least 180 days.
- This migration implements the text marking control plane. Binary media marking remains fail-closed until a format-specific worker embeds both visible and file-header metadata and verifies the exported artifact.
- Rollback requires exporting exemption audit records still inside their retention period. Dropping those records early is prohibited.
