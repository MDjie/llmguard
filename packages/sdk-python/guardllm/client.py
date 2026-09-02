from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import ssl
import time
from typing import Any, Iterable, Iterator, Mapping
from urllib.parse import urlparse
from urllib.request import HTTPSHandler, Request, build_opener
from uuid import uuid4


@dataclass(frozen=True)
class GatewayContext:
    tenant_id: str
    application_id: str
    request_id: str
    trace_id: str
    absolute_deadline_epoch_ms: int
    session_id: str | None = None
    principal_id: str | None = None
    credential_id: str | None = None


def _bounded(value: str, name: str, minimum: int) -> str:
    candidate = value.strip()
    if not minimum <= len(candidate) <= 128 or "\r" in candidate or "\n" in candidate:
        raise ValueError(f"{name} must contain {minimum}..128 characters without line breaks")
    return candidate


def context_signature_payload(context: GatewayContext) -> str:
    return "\n".join(
        (
            "guard-context-v3",
            _bounded(context.tenant_id, "tenant_id", 1),
            _bounded(context.application_id, "application_id", 1),
            _bounded(context.principal_id, "principal_id", 1) if context.principal_id else "",
            _bounded(context.credential_id, "credential_id", 1) if context.credential_id else "",
            _bounded(context.request_id, "request_id", 8),
            _bounded(context.trace_id, "trace_id", 16),
            _bounded(context.session_id, "session_id", 1) if context.session_id else "",
            str(context.absolute_deadline_epoch_ms),
        )
    )


def sign_gateway_context(context: GatewayContext, secret: str | bytes) -> str:
    key = secret.encode("utf-8") if isinstance(secret, str) else secret
    if len(key) < 32:
        raise ValueError("Gateway context HMAC secret must contain at least 32 bytes")
    now_ms = int(time.time() * 1000)
    if not now_ms < context.absolute_deadline_epoch_ms <= now_ms + 60_000:
        raise ValueError("Gateway deadline must be within the next 60 seconds")
    return hmac.new(
        key,
        context_signature_payload(context).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def gateway_context_headers(context: GatewayContext, secret: str | bytes) -> dict[str, str]:
    headers = {
        "X-Tenant-Id": context.tenant_id,
        "X-Application-Id": context.application_id,
        "X-Request-Id": context.request_id,
        "X-Trace-Id": context.trace_id,
        "X-Absolute-Deadline-Epoch-Ms": str(context.absolute_deadline_epoch_ms),
        "X-Guard-Context-Version": "3",
        "X-Guard-Context-Signature": sign_gateway_context(context, secret),
    }
    if context.session_id:
        headers["X-Session-Id"] = context.session_id
    if context.principal_id:
        headers["X-Principal-Id"] = context.principal_id
    if context.credential_id:
        headers["X-Credential-Id"] = context.credential_id
    return headers


def parse_sse_lines(lines: Iterable[bytes | str]) -> Iterator[dict[str, str]]:
    event: dict[str, str] = {}
    data: list[str] = []
    for raw in lines:
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        line = line.rstrip("\r\n")
        if not line:
            if data:
                yield {**event, "data": "\n".join(data)}
            event = {}
            data = []
            continue
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "data":
            data.append(value)
        elif field in {"event", "id"}:
            event[field] = value
    if data or event:
        raise ValueError("Guard gateway returned a truncated SSE event")


class GuardGatewayClient:
    def __init__(
        self,
        *,
        base_url: str,
        tenant_id: str,
        application_id: str,
        credential_id: str | None = None,
        context_hmac_secret: str,
        guard_api_key: str | None = None,
        ca_file: str | None = None,
        client_certificate: str | None = None,
        client_private_key: str | None = None,
        default_timeout_seconds: float = 20.0,
        opener: Any | None = None,
    ) -> None:
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Guard gateway base_url must use HTTPS outside loopback development")
        self._base_url = base_url.rstrip("/")
        self._tenant_id = _bounded(tenant_id, "tenant_id", 1)
        self._application_id = _bounded(application_id, "application_id", 1)
        self._credential_id = (
            _bounded(credential_id, "credential_id", 1) if credential_id else None
        )
        if len(context_hmac_secret.encode("utf-8")) < 32:
            raise ValueError("Gateway context HMAC secret must contain at least 32 bytes")
        self._secret = context_hmac_secret
        self._guard_api_key = guard_api_key
        self._timeout = min(60.0, max(0.001, default_timeout_seconds))
        if opener is not None:
            self._opener = opener
        else:
            context = ssl.create_default_context(cafile=ca_file)
            if bool(client_certificate) != bool(client_private_key):
                raise ValueError("Both client_certificate and client_private_key are required for mTLS")
            if client_certificate and client_private_key:
                context.load_cert_chain(client_certificate, client_private_key)
            self._opener = build_opener(HTTPSHandler(context=context))

    def _context(
        self,
        *,
        request_id: str | None,
        trace_id: str | None,
        session_id: str | None,
        principal_id: str | None,
        timeout_seconds: float | None,
    ) -> GatewayContext:
        timeout = min(60.0, max(0.001, timeout_seconds or self._timeout))
        return GatewayContext(
            tenant_id=self._tenant_id,
            application_id=self._application_id,
            request_id=request_id or str(uuid4()),
            trace_id=trace_id or str(uuid4()),
            session_id=session_id,
            principal_id=principal_id,
            credential_id=self._credential_id,
            absolute_deadline_epoch_ms=int(time.time() * 1000 + timeout * 1000),
        )

    def chat(
        self,
        body: Mapping[str, Any],
        *,
        request_id: str | None = None,
        trace_id: str | None = None,
        session_id: str | None = None,
        principal_id: str | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        context = self._context(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            principal_id=principal_id,
            timeout_seconds=timeout_seconds,
        )
        payload = json.dumps({**body, "stream": False}, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}/v1/chat/completions",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                **gateway_context_headers(context, self._secret),
            },
        )
        with self._opener.open(request, timeout=self._timeout) as response:
            return json.load(response)

    def chat_stream(
        self,
        body: Mapping[str, Any],
        *,
        request_id: str | None = None,
        trace_id: str | None = None,
        session_id: str | None = None,
        principal_id: str | None = None,
        timeout_seconds: float | None = None,
    ) -> Iterator[dict[str, str]]:
        context = self._context(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            principal_id=principal_id,
            timeout_seconds=timeout_seconds,
        )
        payload = json.dumps({**body, "stream": True}, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}/v1/chat/completions/stream",
            data=payload,
            method="POST",
            headers={
                "Accept": "text/event-stream",
                "Content-Type": "application/json",
                **gateway_context_headers(context, self._secret),
            },
        )
        with self._opener.open(request, timeout=self._timeout) as response:
            yield from parse_sse_lines(response)

    def evaluate(self, request_body: Mapping[str, Any]) -> dict[str, Any]:
        if not self._guard_api_key:
            raise ValueError("guard_api_key is required for direct evaluation")
        context = request_body.get("context")
        if not isinstance(context, Mapping) or (
            context.get("tenantId") != self._tenant_id
            or context.get("applicationId") != self._application_id
        ):
            raise ValueError("Guard request scope does not match the SDK client scope")
        payload = json.dumps(request_body, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{self._base_url}/api/v1/guard/evaluate",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Guard-Api-Key": self._guard_api_key,
            },
        )
        with self._opener.open(request, timeout=self._timeout) as response:
            return json.load(response)
