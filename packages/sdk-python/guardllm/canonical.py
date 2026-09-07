"""guard-canonical-v2 for signed gateway envelopes; distinct from legacy context signing."""
import hashlib
import json
import math
from decimal import Decimal


def canonical_json(value, _depth=0):
    if _depth > 64:
        raise ValueError("JSON_DEPTH_EXCEEDED")
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("NON_FINITE_NUMBER")
        if number == 0:
            return "0"
        # All protocol numbers have IEEE-754 binary64 semantics, including JSON integer tokens.
        decimal = format(Decimal(repr(number)), "f")
        return decimal.rstrip("0").rstrip(".") if "." in decimal else decimal
    if isinstance(value, str):
        value.encode("utf-8", "strict")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item, _depth + 1) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("INVALID_JSON_KEY")
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "strict"))
        return "{" + ",".join(canonical_json(key) + ":" + canonical_json(value[key], _depth + 1) for key in keys) + "}"
    raise ValueError("INVALID_JSON_VALUE")


def canonical_sha256(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def policy_bucket(tenant_id, application_id, business_key):
    digest = hashlib.sha256(canonical_json([tenant_id, application_id, business_key]).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % 100
