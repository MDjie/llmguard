"""CPU-only, synthetic-file tests for P0 artifact identity checks."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from model_identity import verify_model_artifact


class ModelIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        weights = self.root / 'weights'
        weights.mkdir()
        (weights / 'config.json').write_text(json.dumps({'id2label': {'0': 'cs_0', '1': 'cs_1'}}), encoding='utf-8')
        (weights / 'model.safetensors').write_bytes(b'synthetic weights, never loaded')
        (self.root / 'calibration.json').write_text('{}', encoding='utf-8')
        self.meta = {'labels': ['cs_0', 'cs_1'], 'modelFiles': {
            name: hashlib.sha256(file.read_bytes()).hexdigest()
            for name, file in [('config.json', weights / 'config.json'),
                               ('model.safetensors', weights / 'model.safetensors'),
                               ('calibration.json', self.root / 'calibration.json')]}}
        self.save(rehash=True)

    def save(self, rehash=False):
        if rehash:
            self.meta['modelSha256'] = 'sha256:' + hashlib.sha256(json.dumps(self.meta['modelFiles'], sort_keys=True).encode()).hexdigest()
        (self.root / 'manifest.json').write_text(json.dumps(self.meta), encoding='utf-8')

    def test_valid_artifact(self):
        self.assertEqual(verify_model_artifact(self.root), self.meta)

    def test_changed_calibration_and_file_hash_cannot_keep_old_identity(self):
        file = self.root / 'calibration.json'
        file.write_text('{"changed":true}', encoding='utf-8')
        self.meta['modelFiles']['calibration.json'] = hashlib.sha256(file.read_bytes()).hexdigest()
        self.save()
        with self.assertRaisesRegex(ValueError, 'MODEL_IDENTITY_HASH_MISMATCH'):
            verify_model_artifact(self.root)

    def test_changed_bound_file(self):
        (self.root / 'weights' / 'model.safetensors').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'MODEL_HASH_MISMATCH'):
            verify_model_artifact(self.root)

    def test_missing_required_binding(self):
        for name in ('config.json', 'calibration.json', 'model.safetensors'):
            with self.subTest(name=name):
                value = self.meta['modelFiles'].pop(name)
                self.save(rehash=True)
                with self.assertRaisesRegex(ValueError, 'BINDING_REQUIRED'):
                    verify_model_artifact(self.root)
                self.meta['modelFiles'][name] = value

    def test_missing_bound_file(self):
        (self.root / 'calibration.json').unlink()
        with self.assertRaisesRegex(ValueError, 'MODEL_HASH_MISMATCH'):
            verify_model_artifact(self.root)

    def test_manifest_label_reorder(self):
        self.meta['labels'].reverse()
        self.save()
        with self.assertRaisesRegex(ValueError, 'MODEL_LABEL_ORDER_MISMATCH'):
            verify_model_artifact(self.root)

    def test_noncontiguous_config_labels(self):
        file = self.root / 'weights' / 'config.json'
        file.write_text(json.dumps({'id2label': {'0': 'cs_0', '2': 'cs_1'}}), encoding='utf-8')
        self.meta['modelFiles']['config.json'] = hashlib.sha256(file.read_bytes()).hexdigest()
        self.save(rehash=True)
        with self.assertRaisesRegex(ValueError, 'MODEL_LABEL_ORDER_MISMATCH'):
            verify_model_artifact(self.root)

    def test_path_escape(self):
        for name in ('../outside.bin', '..\\outside.bin', '/outside.bin', 'C:\\outside.bin', 'C:outside.bin'):
            with self.subTest(name=name):
                self.meta['modelFiles'][name] = '0' * 64
                self.save(rehash=True)
                with self.assertRaisesRegex(ValueError, 'MODEL_FILE_PATH_INVALID'):
                    verify_model_artifact(self.root)
                del self.meta['modelFiles'][name]

    def test_unbound_alternate_weights(self):
        (self.root / 'weights' / 'pytorch_model.bin').write_bytes(b'alternate')
        with self.assertRaisesRegex(ValueError, 'MODEL_UNBOUND_WEIGHT_DIRECTORY_FILE'):
            verify_model_artifact(self.root)


if __name__ == '__main__':
    unittest.main()
