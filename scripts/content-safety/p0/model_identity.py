"""Verify the content-addressed local encoder artifact before loading its files."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PureWindowsPath
import re


def _digest(file: Path) -> str:
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def verify_model_artifact(folder: str | Path) -> dict:
    """Validate the original training identity, every file, and logit label order."""
    root = Path(folder).resolve()
    meta = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(meta, dict):
        raise ValueError('MODEL_MANIFEST_INVALID')
    files = meta.get('modelFiles')
    if not isinstance(files, dict) or not files:
        raise ValueError('MODEL_FILE_BINDING_REQUIRED')
    for name, expected in files.items():
        if (not isinstance(name, str) or not name or name in {'.', '..'}
                or '/' in name or '\\' in name or ':' in name
                or Path(name).is_absolute() or PureWindowsPath(name).is_absolute()):
            raise ValueError('MODEL_FILE_PATH_INVALID')
        if not isinstance(expected, str) or re.fullmatch(r'[a-f0-9]{64}', expected) is None:
            raise ValueError('MODEL_FILE_HASH_INVALID')
    if not {'calibration.json', 'config.json'} <= files.keys():
        raise ValueError('MODEL_FILE_BINDING_REQUIRED')
    # This P0 producer writes one unsharded model; fail closed on other layouts.
    if not {'model.safetensors', 'pytorch_model.bin'} & files.keys():
        raise ValueError('MODEL_WEIGHTS_BINDING_REQUIRED')
    identity = 'sha256:' + hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    if identity != meta.get('modelSha256'):
        raise ValueError('MODEL_IDENTITY_HASH_MISMATCH')
    weights = root / 'weights'
    for name, expected in files.items():
        parent = root if name == 'calibration.json' else weights
        file = parent / name
        # Resolving symlinks must not permit a bound file outside the artifact.
        if not file.resolve().is_relative_to(root):
            raise ValueError('MODEL_FILE_PATH_INVALID')
        if not file.is_file() or _digest(file) != expected:
            raise ValueError('MODEL_HASH_MISMATCH')
    # Transformers may prefer an extra weight/config/tokenizer file over a bound
    # one. The producer binds all files in weights, so reject unbound additions.
    if any(p.is_file() and p.name not in files for p in weights.iterdir()):
        raise ValueError('MODEL_UNBOUND_WEIGHT_DIRECTORY_FILE')
    config = json.loads((weights / 'config.json').read_text(encoding='utf-8'))
    mapping = config.get('id2label') if isinstance(config, dict) else None
    labels = meta.get('labels')
    if (not isinstance(labels, list) or not labels
            or any(not isinstance(label, str) or not label for label in labels)
            or len(set(labels)) != len(labels)
            or not isinstance(mapping, dict)
            or set(mapping) != {str(i) for i in range(len(labels))}
            or labels != [mapping[str(i)] for i in range(len(labels))]):
        raise ValueError('MODEL_LABEL_ORDER_MISMATCH')
    return meta
