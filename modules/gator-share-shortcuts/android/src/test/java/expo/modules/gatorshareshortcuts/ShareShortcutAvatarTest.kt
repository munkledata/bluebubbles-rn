package expo.modules.gatorshareshortcuts

import java.io.File
import org.junit.Assert.assertEquals
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
      "content://com.android.contacts@evil/contacts/1/photo",
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
  fun aBadColorOrInitialsRejectsTheWholeSpec() {
    assertNull(normalizeAvatarSpec(null, "AB", "nope", "#FFFFFF"))
    assertNull(normalizeAvatarSpec(null, "TOOLONG", "#000000", "#FFFFFF"))
    assertEquals(
      ShareShortcutAvatarSpec(null, "AB", 0xFF000000.toInt(), 0xFFFFFFFF.toInt()),
      normalizeAvatarSpec("  ", "AB", "#000000", "#FFFFFF"),
    )
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
