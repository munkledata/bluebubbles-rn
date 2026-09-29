package expo.modules.gatorshareshortcuts

import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ShareShortcutTokenTest {
  private val key = SecretKeySpec(ByteArray(32) { index -> (index + 1).toByte() }, "HmacSHA256")

  @Test
  fun `token round trip is deterministic and resolve uses one snapshot`() {
    val snapshot = ShareShortcutTokenSnapshot(key, ByteArray(16) { 7 })
    var snapshotReads = 0
    val resolver = ShareShortcutTokenResolver {
      snapshotReads += 1
      snapshot
    }
    val token = snapshot.tokenFor("chat-guid-2")

    assertEquals(token, snapshot.tokenFor("chat-guid-2"))
    assertEquals(
      "chat-guid-2",
      resolver.resolve(token, listOf("chat-guid-1", "chat-guid-2", "chat-guid-3")),
    )
    assertEquals(1, snapshotReads)
    assertTrue(token.matches(Regex("^gator-share-v2-[A-Za-z0-9_-]{43}$")))
  }

  @Test
  fun `epoch rotation invalidates tokens from the previous scope`() {
    val oldSnapshot = ShareShortcutTokenSnapshot(key, ByteArray(16) { 1 })
    val rotatedSnapshot = ShareShortcutTokenSnapshot(key, ByteArray(16) { 2 })
    val oldToken = oldSnapshot.tokenFor("chat-guid")

    assertNull(ShareShortcutTokenResolver { rotatedSnapshot }.resolve(oldToken, listOf("chat-guid")))
  }

  @Test
  fun `snapshot provider operational failure propagates`() {
    val resolver = ShareShortcutTokenResolver {
      throw IllegalStateException("simulated keystore failure")
    }

    val error = expectFailure {
      resolver.resolve("${CURRENT_SHARE_SHORTCUT_PREFIX}${"a".repeat(43)}", listOf("chat-guid"))
    }

    assertEquals("simulated keystore failure", error.message)
  }
}

private fun expectFailure(action: () -> Unit): Throwable {
  try {
    action()
  } catch (error: Throwable) {
    return error
  }
  fail("Expected operation to fail")
  error("unreachable")
}
