package com.guardllm.gateway;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.TreeMap;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Cross-language guard-canonical-v2. No locale-dependent formatting. */
final class CanonicalJson {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private CanonicalJson() { }
    static String encode(JsonNode value) { return encode(value, 0); }
    private static String encode(JsonNode value, int depth) {
        if (depth > 64) throw new GatewayFailure("JSON_DEPTH_EXCEEDED", 413);
        if (value == null || value.isNull()) return "null";
        if (value.isString()) { unicode(value.stringValue()); return JSON.writeValueAsString(value.stringValue()); }
        if (value.isBoolean()) return value.asBoolean() ? "true" : "false";
        if (value.isNumber()) {
            double number = value.asDouble();
            if (!Double.isFinite(number)) throw new GatewayFailure("NON_FINITE_NUMBER", 400);
            if (number == 0) return "0";
            BigDecimal exact = new BigDecimal(number);
            for (int precision = 1; precision <= 17; precision++) {
                BigDecimal rounded = exact.round(new java.math.MathContext(precision, java.math.RoundingMode.HALF_EVEN));
                if (Double.doubleToLongBits(rounded.doubleValue()) == Double.doubleToLongBits(number)) return rounded.stripTrailingZeros().toPlainString();
            }
            throw new GatewayFailure("NUMBER_NORMALIZATION_FAILED", 400);
        }
        if (value.isArray()) {
            var elements = new java.util.ArrayList<String>();
            value.forEach(item -> elements.add(encode(item, depth + 1)));
            return "[" + String.join(",", elements) + "]";
        }
        if (!value.isObject()) throw new GatewayFailure("INVALID_JSON_VALUE", 400);
        var fields = new TreeMap<String, JsonNode>();
        value.properties().forEach(entry -> fields.put(entry.getKey(), entry.getValue()));
        var members = new java.util.ArrayList<String>();
        fields.forEach((key, item) -> { unicode(key); members.add(JSON.writeValueAsString(key) + ":" + encode(item, depth + 1)); });
        return "{" + String.join(",", members) + "}";
    }
    static String sha256(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.GeneralSecurityException error) { throw new IllegalStateException(error); }
    }
    static void unicode(String text) {
        for (int i = 0; i < text.length(); i++) {
            char unit = text.charAt(i);
            if (Character.isHighSurrogate(unit)) {
                if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) throw new GatewayFailure("INVALID_UNICODE", 400);
            } else if (Character.isLowSurrogate(unit)) throw new GatewayFailure("INVALID_UNICODE", 400);
        }
    }
}
