package expo.modules.gatorboundeddownload

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedDownloadPolicyTest {
  @Test
  fun `only a whole-file HTTP response is accepted`() {
    assertTrue(isCompleteDownloadResponse(200))
    assertFalse(isCompleteDownloadResponse(201))
    assertFalse(isCompleteDownloadResponse(204))
    assertFalse(isCompleteDownloadResponse(206))
    assertFalse(isCompleteDownloadResponse(299))
  }

  @Test
  fun `known response length must equal the streamed byte count`() {
    assertTrue(matchesDeclaredDownloadLength(-1L, 12L))
    assertTrue(matchesDeclaredDownloadLength(12L, 12L))
    assertFalse(matchesDeclaredDownloadLength(-2L, 12L))
    assertFalse(matchesDeclaredDownloadLength(11L, 12L))
    assertFalse(matchesDeclaredDownloadLength(13L, 12L))
  }

  @Test
  fun `image validation decode stays beneath its pixel ceiling`() {
    assertEquals(1, imageValidationSampleSize(1024, 1024, 1024L * 1024))
    assertEquals(2, imageValidationSampleSize(1025, 1025, 1024L * 1024))
    assertEquals(8, imageValidationSampleSize(8000, 6000, 1024L * 1024))
    assertEquals(16, imageValidationSampleSize(16_384, 16_384, 1024L * 1024))
  }

  @Test
  fun `a download may only write its own partial file`() {
    val cache = File("/data/user/0/app/cache")
    val parts = File(cache, "bounded-download-parts")
    assertTrue(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1700000000000-1.part")))
    assertTrue(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1-12345.part")))

    // Review M160: any other file in the app's private folders is out of bounds.
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(cache, "request-1-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(File(cache, "other"), "request-1-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(File(parts, "nested"), "request-1-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1-1.tmp")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "request-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "request-a-1.part")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, File(parts, "gator.db")))
    assertFalse(isOwnedBoundedDownloadPartial(cache, parts))
    assertFalse(
      isOwnedBoundedDownloadPartial(
        cache,
        File("/data/user/0/app/files/bounded-download-parts/request-1-1.part"),
      ),
    )
  }

  @Test
  fun `a failed exclusive create never removes the file already there`() {
    // Review M164: if the exclusive create fails, the file at that path is not this call's.
    var filled = 0
    var removed = 0
    val exists = IllegalStateException("EEXIST")
    val thrown = assertThrows(IllegalStateException::class.java) {
      fillExclusivelyCreatedFile(
        create = { throw exists },
        fill = { _: Int -> filled += 1 },
        remove = { removed += 1 },
      )
    }
    assertSame(exists, thrown)
    assertEquals(0, filled)
    assertEquals(0, removed)
  }

  @Test
  fun `a failed fill removes only the file this call created`() {
    var removed = 0
    val copyFailed = IllegalStateException("copy failed")
    val thrown = assertThrows(IllegalStateException::class.java) {
      fillExclusivelyCreatedFile(
        create = { 7 },
        fill = { descriptor ->
          assertEquals(7, descriptor)
          throw copyFailed
        },
        remove = { removed += 1 },
      )
    }
    assertSame(copyFailed, thrown)
    assertEquals(1, removed)

    // A failed removal must not hide why the fill failed.
    val stillCopyFailed = assertThrows(IllegalStateException::class.java) {
      fillExclusivelyCreatedFile(
        create = { 7 },
        fill = { throw copyFailed },
        remove = { throw IllegalStateException("EBUSY") },
      )
    }
    assertSame(copyFailed, stillCopyFailed)

    removed = 0
    fillExclusivelyCreatedFile(create = { 7 }, fill = {}, remove = { removed += 1 })
    assertEquals(0, removed)
  }
}
