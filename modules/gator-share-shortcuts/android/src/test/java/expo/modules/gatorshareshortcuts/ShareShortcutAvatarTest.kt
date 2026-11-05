package expo.modules.gatorshareshortcuts

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class ShareShortcutAvatarTest {
  private val own = listOf("/data/user/0/com.gator/files", "/data/user/0/com.gator/cache")

  /** Canonicalize like java.io.File does, without touching the disk. */
  private val canonical: (String) -> String? = { File(it).toPath().normalize().toString() }

  private fun resolve(uri: String) = resolveAvatarSource(uri, own, canonical)

  @Test
  fun acceptsContactProviderPhotos() {
    val uri = "content://com.android.contacts/contacts/42/photo"
    assertEquals(AvatarSource.ContactPhoto(uri), resolve(uri))
  }

  @Test
  fun acceptsFilesInsideOwnStorageByTheirCanonicalPath() {
    assertEquals(
      AvatarSource.OwnFile("/data/user/0/com.gator/files/group-photos/a b.jpg"),
      resolve("file:///data/user/0/com.gator/files/group-photos/a%20b.jpg"),
    )
  }

  @Test
  fun refusesPercentEncodedTraversalOutOfOwnStorage() {
    assertNull(resolve("file:///data/user/0/com.gator/files/..%2F..%2Fcom.other/secret.jpg"))
    assertNull(resolve("file:///data/user/0/com.gator/files/../../com.other/secret.jpg"))
  }

  @Test
  fun refusesSiblingDirectoriesThatOnlyShareAPrefix() {
    assertNull(resolve("file:///data/user/0/com.gator/files-evil/x.jpg"))
  }

  @Test
  fun refusesOtherProvidersSchemesAndMalformedInput() {
    for (uri in listOf(
      "content://media/external/images/1",
      "content://com.android.contacts@evil/contacts/1/photo", // authority is not exactly contacts
      "content://com.android.contacts.evil/contacts/1/photo",
      "https://example.com/a.jpg",
      "file://host/data/user/0/com.gator/files/a.jpg",
      "file:relative.jpg",
      "/data/user/0/com.gator/files/a.jpg",
      "",
      "content://com.android.contacts/contacts/1/photo\u0000",
      "content://com.android.contacts/" + "x".repeat(3000),
    )) {
      assertNull(uri, resolve(uri))
    }
  }

  @Test
  fun parsesOnlySixDigitHexColors() {
    assertEquals(0xFF4DABF7.toInt(), parseAvatarColor("#4DABF7"))
    assertEquals(0xFF4DABF7.toInt(), parseAvatarColor("#4dabf7"))
    for (bad in listOf(null, "", "4DABF7", "#4DAB", "#4DABF7FF", "#GGGGGG", " #4DABF7")) {
      assertNull(bad, parseAvatarColor(bad))
    }
  }

  @Test
  fun boundsInitials() {
    assertEquals("ÉZ", normalizeAvatarInitials(" ÉZ "))
    assertEquals("", normalizeAvatarInitials(""))
    assertEquals("", normalizeAvatarInitials(null))
    assertNull(normalizeAvatarInitials("ABCDE"))
    assertNull(normalizeAvatarInitials("A\u0007"))
  }

  @Test
  fun aBadLetterCircleFallsBackButNeverDropsAGoodPhoto() {
    assertNull(normalizeAvatarSpec(null, "AB", "nope", "#FFFFFF", FALLBACK_AVATAR))
    assertNull(normalizeAvatarSpec(null, "TOOLONG", "#000000", "#FFFFFF", FALLBACK_AVATAR))
    assertEquals(
      FALLBACK_AVATAR.copy(photoUri = "content://com.android.contacts/contacts/1/photo"),
      normalizeAvatarSpec(
        "content://com.android.contacts/contacts/1/photo",
        "AB",
        "nope",
        "#FFFFFF",
        FALLBACK_AVATAR,
      ),
    )
    assertEquals(
      ShareShortcutAvatarSpec(null, "AB", 0xFF000000.toInt(), 0xFFFFFFFF.toInt()),
      normalizeAvatarSpec("  ", "AB", "#000000", "#FFFFFF", FALLBACK_AVATAR),
    )
  }

  @Test
  fun samplesUntilBothSidesFitAndRefusesHugeImages() {
    assertEquals(1, avatarSampleSize(300, 300))
    assertEquals(8, avatarSampleSize(1200, 1600)) // 1600 / 4 = 400 is still over 384
    // A long panorama: halved until its LONG side fits, not left at full size.
    val panorama = avatarSampleSize(30_000, 300)
    assertTrue(panorama != null && 30_000 / panorama <= 384)
    // A small file claiming an enormous height can't sneak a huge allocation through.
    val tall = avatarSampleSize(400, 1_000_000)
    assertTrue(tall == null || (400L / tall) * (1_000_000L / tall) <= 1_000_000L)
    assertNull(avatarSampleSize(0, 10))
    assertNull(avatarSampleSize(10, -1))
  }

  @Test
  fun ignoresTheQueryAndFragmentOfAFileUri() {
    assertEquals(
      AvatarSource.OwnFile("/data/user/0/com.gator/files/a.jpg"),
      resolve("file:///data/user/0/com.gator/files/a.jpg?x=1#y"),
    )
  }

  @Test
  fun followsSymlinksWhenCheckingOwnStorage() {
    val root = Files.createTempDirectory("gator-avatar").toFile()
    try {
      val ownDir = File(root, "files").apply { mkdirs() }
      val outside = File(root, "other").apply { mkdirs() }
      File(outside, "secret.jpg").writeText("x")
      Files.createSymbolicLink(File(ownDir, "link").toPath(), outside.toPath())
      val real: (String) -> String? = { runCatching { File(it).canonicalPath }.getOrNull() }
      val dirs = listOf(ownDir.canonicalPath)
      assertNull(resolveAvatarSource("file://${ownDir.canonicalPath}/link/secret.jpg", dirs, real))
      File(ownDir, "mine.jpg").writeText("x")
      assertEquals(
        AvatarSource.OwnFile(File(ownDir, "mine.jpg").canonicalPath),
        resolveAvatarSource("file://${ownDir.canonicalPath}/mine.jpg", dirs, real),
      )
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun lruCacheKeepsTheMostRecentlyUsedEntries() {
    val cache = AvatarLruCache<String, Int>(2)
    cache.put("a", 1)
    cache.put("b", 2)
    assertEquals(1, cache.get("a")) // touch a, so b is now the eldest
    cache.put("c", 3)
    assertNull(cache.get("b"))
    assertEquals(1, cache.get("a"))
    assertEquals(3, cache.get("c"))
    cache.clear()
    assertEquals(0, cache.size())
  }

  @Test
  fun aReplacedFileGetsADifferentCacheKey() {
    val spec = ShareShortcutAvatarSpec("file:///x.jpg", "A", 0, 0)
    assertTrue(AvatarCacheKey(spec, "100:5") != AvatarCacheKey(spec, "200:5"))
    assertEquals(AvatarCacheKey(spec, "100:5"), AvatarCacheKey(spec, "100:5"))
  }

  @Test
  fun shortcutSpecsFallBackToANeutralPictureNeverTheAppIcon() {
    val record = ShareShortcutRecord().apply {
      guid = "iMessage;-;+15551234567"
      label = "Jordan"
      background = "not a color"
    }
    assertEquals(FALLBACK_AVATAR, normalizeShareShortcutSpecs(listOf(record)).single().avatar)
  }
}
