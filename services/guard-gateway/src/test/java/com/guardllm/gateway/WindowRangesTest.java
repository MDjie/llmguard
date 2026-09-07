package com.guardllm.gateway;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class WindowRangesTest {
    @Test void retainsHoldbackAndRollingContextUntilFinal() {
        assertNull(WindowRanges.next("a".repeat(1279), 0, 2048, 1024, 256, false));
        var first = WindowRanges.next("a".repeat(1280), 0, 2048, 1024, 256, false);
        assertEquals(new WindowRanges.Range(0, 0, 1024, 1280, false), first);
        var rolling = WindowRanges.next("a".repeat(5376), 4096, 2048, 1024, 256, false);
        assertEquals(new WindowRanges.Range(2048, 4096, 5120, 5376, false), rolling);
        assertEquals(new WindowRanges.Range(3072, 5120, 5376, 5376, true), WindowRanges.next("a".repeat(5376), 5120, 2048, 1024, 256, true));
    }
    @Test void neverCutsSurrogatePairsAndDrainsOversizedFragments() {
        var range = WindowRanges.next("a".repeat(1023) + "😀" + "b".repeat(4000), 0, 2048, 1024, 256, false);
        assertEquals(1023, range.releaseEnd()); assertEquals(1279, range.inspectedEnd());
        int released = 0, count = 0; String text = "a".repeat(20000);
        while (true) { var next = WindowRanges.next(text, released, 2048, 1024, 256, true); released = next.releaseEnd(); count++; if (next.last()) break; }
        assertEquals(20000, released); assertTrue(count > 10);
    }
}
