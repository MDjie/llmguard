from __future__ import annotations

import hashlib
import hmac
import io
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from guardllm import (  # noqa: E402
    GatewayContext,
    GuardGatewayClient,
    context_signature_payload,
    gateway_context_headers,
    parse_sse_lines,
)


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class _Opener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return _Response(json.dumps({"id": "completion-1"}).encode("utf-8"))


class ClientTest(unittest.TestCase):
    secret = "0123456789abcdef0123456789abcdef"

    def test_signature_v3_binds_identity_session_and_trace(self):
        context = GatewayContext(
            tenant_id="tenant-1",
            application_id="app-1",
            request_id="request-123",
            trace_id="trace-1234567890",
            session_id="session-1",
            principal_id="user-1",
            credential_id="credential-1",
            absolute_deadline_epoch_ms=int(time.time() * 1000) + 20_000,
        )
        expected = hmac.new(
            self.secret.encode(),
            context_signature_payload(context).encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = gateway_context_headers(context, self.secret)
        self.assertEqual(headers["X-Guard-Context-Version"], "3")
        self.assertEqual(headers["X-Guard-Context-Signature"], expected)
        self.assertEqual(headers["X-Session-Id"], "session-1")
        self.assertEqual(headers["X-Principal-Id"], "user-1")
        self.assertEqual(headers["X-Credential-Id"], "credential-1")

    def test_fragmented_multiline_sse(self):
        lines = [
            b"event: message\n",
            b"data: first\n",
            b"data: second\n",
            b"\n",
            b"data: [DONE]\n",
            b"\n",
        ]
        self.assertEqual(
            list(parse_sse_lines(lines)),
            [
                {"event": "message", "data": "first\nsecond"},
                {"data": "[DONE]"},
            ],
        )

    def test_chat_adds_signed_headers_and_disables_stream(self):
        opener = _Opener()
        client = GuardGatewayClient(
            base_url="http://localhost:8080",
            tenant_id="tenant-1",
            application_id="app-1",
            credential_id="credential-1",
            context_hmac_secret=self.secret,
            guard_api_key="test-application-key",
            opener=opener,
        )
        result = client.chat(
            {"messages": []},
            request_id="request-123",
            trace_id="trace-1234567890",
            session_id="session-1",
            principal_id="user-1",
        )
        self.assertEqual(result, {"id": "completion-1"})
        request, _timeout = opener.requests[0]
        self.assertEqual(request.headers["X-guard-context-version"], "3")
        self.assertEqual(request.headers["X-principal-id"], "user-1")
        self.assertEqual(request.headers["X-credential-id"], "credential-1")
        self.assertEqual(request.headers["X-guard-api-key"], "test-application-key")
        self.assertEqual(request.headers["Idempotency-key"], "request-123")
        self.assertIn("X-guard-deadline", request.headers)
        self.assertFalse(json.loads(request.data)["stream"])


if __name__ == "__main__":
    unittest.main()
