package expo.modules.gatorboundeddownload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
