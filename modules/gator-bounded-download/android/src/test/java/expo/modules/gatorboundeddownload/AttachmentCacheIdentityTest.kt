package expo.modules.gatorboundeddownload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentCacheIdentityTest {
  @Test
  fun `hashes exact UTF8 with standard SHA256 vectors`() {
    assertEquals(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      attachmentCacheGuidSha256("abc"),
    )
    assertEquals(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
      attachmentCacheGuidSha256("😀"),
    )
    assertFalse(attachmentCacheGuidSha256("é") == attachmentCacheGuidSha256("e\u0301"))
    assertEquals(attachmentCacheGuidSha256(" x "), attachmentCacheGuidSha256(" x "))
    assertFalse(attachmentCacheGuidSha256(" x ") == attachmentCacheGuidSha256("x"))
  }

  @Test
  fun `accepts exact byte limit and rejects longer input or malformed Unicode`() {
    assertEquals(64, attachmentCacheGuidSha256("x".repeat(4096)).length)
    assertEquals(64, attachmentCacheGuidSha256("😀".repeat(1024)).length)
    for (invalid in listOf("", "x".repeat(4097), "😀".repeat(1024) + "x", "\uD800", "\uDC00")) {
      assertTrue(runCatching { attachmentCacheGuidSha256(invalid) }.isFailure)
    }
  }

  @Test
  fun `recognizes only the exact identity grammar without widening media filenames`() {
    val valid = "id-sha256-" + "a".repeat(64)
    assertTrue(isAttachmentCacheIdentitySegment(valid))
    assertTrue(isAttachmentCacheIdentitySegment("media-$valid"))
    assertFalse(isEncodedMediaSegment(valid))
    for (invalid in listOf("id-sha256-" + "A".repeat(64), valid + "a", valid.dropLast(1), valid + "/x")) {
      assertFalse(isAttachmentCacheIdentitySegment(invalid))
    }
  }
}
