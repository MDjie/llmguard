import json
from pathlib import Path
import unittest
from guardllm.canonical import canonical_json, canonical_sha256, policy_bucket

class CanonicalGoldenTests(unittest.TestCase):
    def test_shared_vectors(self):
        vectors = json.loads((Path(__file__).resolve().parents[2] / "contracts/golden/gateway-v2.json").read_text(encoding="utf-8"))
        for vector in vectors["valid"]:
            with self.subTest(vector=vector["name"]):
                value = json.loads(vector["inputJson"])
                self.assertEqual(canonical_json(value), vector["canonical"])
                self.assertEqual(canonical_sha256(value), vector["sha256"])
        for vector in vectors["invalid"]:
            with self.subTest(vector=vector["name"]), self.assertRaises((ValueError, UnicodeError, OverflowError)):
                canonical_json(json.loads(vector["inputJson"]))
        for vector in vectors["routing"]:
            self.assertEqual(policy_bucket(vector["tenantId"], vector["applicationId"], vector["businessKey"]), vector["bucket"])
