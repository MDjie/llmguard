# GuardLLM Media Analyzer

The service performs bounded artifact download and hash verification, PDF/image
rasterization, OCR, multi-view image analysis, audio demux/ASR, video sampling
and timeline observations. It executes model adapters as fixed commands without
a shell. Production must mount approved visual, ASR and audio-classifier
executables at the paths configured by `ANALYZER_*_COMMAND`.

The worker passes bounded runtime controls for frame batch size, frame interval,
maximum frames and minimum model confidence. Audio analysis materializes
denoise, loudness-normalized, speed-adjusted and bounded reverse-probe views,
then maps ASR timestamps back to the source timeline. Fusion applies the
configured review/block thresholds and only combines timed media segments
inside the configured cross-modal window.

The service fails readiness when model commands or the 32-byte shared token are
not configured. It never returns mock findings.
