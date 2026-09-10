# Content-safety source notices

This directory contains source material used to build or evaluate the GuardLLM
content-safety lexicon. Raw source data is never a production input. Every file
must pass license, integrity, normalization, mapping, quality, and regression
gates before a reviewed entry can be added to the authoritative lexicon.

## fwwdn/sensitive-stop-words

- Upstream: https://github.com/fwwdn/sensitive-stop-words
- Locked revision: a7d06bb1c321e669943b6841570d9da6dad8ce2b
- Upstream license statement: Apache License 2.0
- Local use: candidate discovery only
- Important limitation: the upstream project describes its words as collected
  from public Internet material. That statement does not establish the quality,
  currency, legal classification, or production suitability of an individual
  word. No imported word is active by default.

## MLCommons AILuminate Demo

- Upstream: https://github.com/mlcommons/ailuminate
- Locked revision: 769cc2be9d20c8d4fb26ce53b68865ed41dfb8e2
- Demo prompt data license: Creative Commons Attribution 4.0 International
- Local use: evaluation only; not training and not direct lexicon generation
- Attribution: MLCommons AI Risk & Reliability working group, AILuminate v1.0
  Demo Prompt Set.

The upstream project explicitly discourages training directly on the practice
prompt set. GuardLLM keeps this data outside the lexicon and training pipeline.

## Unicode confusables

- Upstream: https://www.unicode.org/Public/security/latest/confusables.txt
- Locked file version: Unicode Security Mechanisms 17.0.0, file header dated 2025-07-22
- Specification: Unicode Technical Standard #39
- Local use: detection of visually confusable strings

Confusable skeletons are internal detection features. They must not replace the
original content or be displayed as normalized user text.

## ToxiCN lexicon

- Upstream: https://github.com/thu-coai/ToxiCN
- Locked revision: UNPINNED — files copied from the local evaluation workspace
  (`eval-data/toxiccn/lexicon/*.json`); upstream commit and exact file mapping
  have not been verified yet.
- Upstream license statement: PENDING_REVIEW
- Local use: candidate discovery only (Chinese offensive-language slurs across
  general / racism / sexism / region / LGBT categories)
- Important limitations: several entries are homophone or censorship-evasion
  variants with no literal meaning; others are standard vocabulary or community
  self-labels that must be excluded during review. Category-to-risk mapping is
  recorded per candidate and requires human sign-off before any word can leave
  `candidate` state. No imported word is active by default.

## Integrity

Exact file sizes and SHA-256 values are recorded in sources.lock.json. A change
to any upstream file is treated as a new source version and requires a reviewed
lock-file update.
