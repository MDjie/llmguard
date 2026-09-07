package com.guardllm.gateway;

/** Absolute UTF-16 ranges; holdback and inspected rolling context are distinct. */
final class WindowRanges {
    record Range(int contextStart, int releaseStart, int releaseEnd, int inspectedEnd, boolean last) { }
    private WindowRanges() { }
    static Range next(String text, int released, int context, int chunk, int holdback, boolean complete) {
        if (released < 0 || released > text.length() || context < 512 || chunk < 1024 || holdback < 256) throw new GatewayFailure("WINDOW_CONFIGURATION_INVALID", 503);
        int available = text.length() - released;
        if (!complete && available < chunk + holdback) return null;
        boolean last = complete && available <= chunk + holdback;
        int end = last ? text.length() : leftBoundary(text, released + chunk);
        int start = leftBoundary(text, Math.max(0, released - context));
        int inspected = last ? text.length() : rightBoundary(text, end + holdback);
        return new Range(start, released, end, inspected, last);
    }
    private static int leftBoundary(String text, int index) {
        return index > 0 && index < text.length() && Character.isHighSurrogate(text.charAt(index - 1)) && Character.isLowSurrogate(text.charAt(index)) ? index - 1 : index;
    }
    private static int rightBoundary(String text, int index) {
        return index > 0 && index < text.length() && Character.isHighSurrogate(text.charAt(index - 1)) && Character.isLowSurrogate(text.charAt(index)) ? index + 1 : index;
    }
}
