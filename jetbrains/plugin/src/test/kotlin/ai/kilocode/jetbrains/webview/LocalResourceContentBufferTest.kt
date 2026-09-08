package ai.kilocode.jetbrains.webview

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LocalResourceContentBufferTest {
    @Test
    fun `successive legacy and modern reads share the same cursor`() {
        val buffer = LocalResourceContentBuffer(byteArrayOf(1, 2, 3, 4, 5))
        val first = ByteArray(3)
        assertEquals(3, buffer.read(first, 3))
        assertArrayEquals(byteArrayOf(1, 2, 3), first)

        val last = ByteArray(3)
        assertEquals(2, buffer.read(last, 3))
        assertArrayEquals(byteArrayOf(4, 5, 0), last)
        assertNull(buffer.read(ByteArray(3), 3))
        assertEquals(5, buffer.size)
    }

    @Test
    fun `skip advances the same cursor as reads`() {
        val buffer = LocalResourceContentBuffer(byteArrayOf(1, 2, 3, 4, 5))
        assertEquals(1, buffer.read(ByteArray(1), 1))
        assertEquals(2L, buffer.skip(2))
        val remaining = ByteArray(2)
        assertEquals(2, buffer.read(remaining, 2))
        assertArrayEquals(byteArrayOf(4, 5), remaining)
        assertEquals(-2L, buffer.skip(1))
        assertEquals(0L, buffer.skip(0))
    }

    @Test
    fun `skip larger than content clamps without integer overflow`() {
        val buffer = LocalResourceContentBuffer(byteArrayOf(1, 2, 3))
        assertEquals(3L, buffer.skip(Long.MAX_VALUE))
        assertNull(buffer.read(ByteArray(1), 1))
        assertEquals(-2L, buffer.skip(1))
    }

    @Test
    fun `invalid skip does not advance cursor`() {
        val buffer = LocalResourceContentBuffer(byteArrayOf(7, 8))
        assertEquals(-2L, buffer.skip(-1))
        val bytes = ByteArray(2)
        assertEquals(2, buffer.read(bytes, 2))
        assertArrayEquals(byteArrayOf(7, 8), bytes)
    }

    @Test
    fun `empty resource immediately reaches end of stream`() {
        val buffer = LocalResourceContentBuffer(byteArrayOf())
        assertEquals(0, buffer.size)
        assertNull(buffer.read(ByteArray(1), 1))
        assertEquals(0L, buffer.skip(0))
        assertEquals(-2L, buffer.skip(1))
    }

    @Test
    fun `zero byte read preserves position`() {
        val buffer = LocalResourceContentBuffer(byteArrayOf(9))
        assertEquals(0, buffer.read(ByteArray(0), 0))
        val bytes = ByteArray(1)
        assertEquals(1, buffer.read(bytes, 1))
        assertArrayEquals(byteArrayOf(9), bytes)
    }
}
