package com.guardllm.gateway;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("guard.gateway.streaming")
public record StreamingCommitGateProperties(
        Duration maximumWait,
        int maximumUncommittedChars,
        int maximumHistoryChars) {
    public StreamingCommitGateProperties {
        maximumWait = maximumWait == null ? Duration.ofMillis(150) : maximumWait;
        maximumUncommittedChars = maximumUncommittedChars <= 0 ? 8_192 : maximumUncommittedChars;
        maximumHistoryChars = maximumHistoryChars <= 0 ? 32_768 : maximumHistoryChars;
        if (maximumWait.isNegative() || maximumWait.isZero() || maximumWait.compareTo(Duration.ofSeconds(2)) > 0) {
            throw new IllegalArgumentException("streaming maximum-wait must be in range 1ms..2s");
        }
        if (maximumUncommittedChars < 256 || maximumUncommittedChars > 65_536) {
            throw new IllegalArgumentException(
                    "streaming maximum-uncommitted-chars must be in range 256..65536");
        }
        if (maximumHistoryChars < maximumUncommittedChars || maximumHistoryChars > 1_048_576) {
            throw new IllegalArgumentException(
                    "streaming maximum-history-chars must cover the uncommitted buffer and be at most 1048576");
        }
    }
}
