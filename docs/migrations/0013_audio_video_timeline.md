# Migration 0013: audio/video timeline evidence

Adds structured time-range, frame and region evidence for ASR, OCR and visual findings. Raw
transcripts are not persisted in this table; only HMAC evidence references and masked decision
previews are retained.
