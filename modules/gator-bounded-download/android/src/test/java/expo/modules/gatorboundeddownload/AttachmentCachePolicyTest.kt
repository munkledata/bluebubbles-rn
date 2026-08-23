package expo.modules.gatorboundeddownload

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AttachmentCachePolicyTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun `accepts the current scoped and unscoped namespace including a missing file`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val scopedGeneration = File(root, "media-a%2Fb/generation-7").apply { mkdirs() }
    val unscopedGeneration = File(root, "media-guid/generation-unscoped").apply { mkdirs() }
    val present = File(scopedGeneration, "media-photo.jpg").apply { writeBytes(byteArrayOf(1)) }
    val unicode = File(unscopedGeneration, "media-%E2%82%AC.pdf").apply {
      writeBytes(byteArrayOf(2))
    }
    val missing = File(scopedGeneration, "media-later.pdf")

    assertEquals(present.canonicalFile, requireOwnedAttachmentCachePath(root, present))
    assertEquals(unicode.canonicalFile, requireOwnedAttachmentCachePath(root, unicode))
    assertEquals(missing.canonicalFile, requireOwnedAttachmentCachePath(root, missing))
  }

  @Test
  fun `accepts broad bounded legacy names and a mixed legacy-current directory`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val legacyDirectory = File(root, "old chat +1555 % raw").apply { mkdirs() }
    val legacyPresent = File(legacyDirectory, "Photo %41 € copy.jpg").apply {
      writeBytes(byteArrayOf(1))
    }
    val legacyMissing = File(legacyDirectory, "later file.pdf")
    val mixedDirectory = File(root, "media-collision").apply { mkdirs() }
    val directLegacy = File(mixedDirectory, "generation-01").apply { writeBytes(byteArrayOf(2)) }
    val current = File(mixedDirectory, "generation-0/media-current.pdf").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(3))
    }

    for (candidate in listOf(legacyPresent, legacyMissing, directLegacy, current)) {
      assertEquals(candidate.canonicalFile, requireOwnedAttachmentCachePath(root, candidate))
    }
  }

  @Test
  fun `current namespace grammar matches canonical JavaScript output`() {
    for (segment in listOf("media-guid", "media-a%2Fb", "media-%E2%82%AC.pdf")) {
      assertTrue(isEncodedMediaSegment(segment))
    }
    for (
      segment in listOf(
        "media-",
        "media-%41",
        "media-%7E",
        "media-%FF",
        "media-%ED%A0%80",
        "media-bad%2fname",
        "media-raw name",
      )
    ) {
      assertFalse(isEncodedMediaSegment(segment))
    }

    for (segment in listOf("generation-0", "generation-7", "generation-unscoped")) {
      assertTrue(isAttachmentCacheGenerationSegment(segment))
    }
    for (
      segment in listOf(
        "generation-00",
        "generation-01",
        "generation--1",
        "generation-9007199254740992",
      )
    ) {
      assertFalse(isAttachmentCacheGenerationSegment(segment))
    }
  }

  @Test
  fun `rejects paths outside the fixed root plus traversal and symlinks`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val outside = temporary.newFile("outside-secret.db").apply { writeBytes(byteArrayOf(9)) }
    val sibling = temporary.newFolder("attachments-copy")
    val siblingFile = File(sibling, "media-guid/generation-1/media-photo.jpg").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1))
    }
    val nested = File(root, "media-guid/generation-1").apply { mkdirs() }
    val finalLink = File(nested, "media-linked.jpg")
    Files.createSymbolicLink(finalLink.toPath(), outside.toPath())
    val parentLink = File(root, "media-linked-parent")
    Files.createSymbolicLink(parentLink.toPath(), temporary.root.toPath())
    val legacyDirectory = File(root, "legacy-guid").apply { mkdirs() }
    val legacyFinalLink = File(legacyDirectory, "linked-file.pdf")
    Files.createSymbolicLink(legacyFinalLink.toPath(), outside.toPath())

    val rejected = listOf(
      root,
      outside,
      siblingFile,
      File(root, "media-guid/generation-1/../media-escape.jpg"),
      finalLink,
      File(parentLink, "generation-1/media-${outside.name}"),
      legacyFinalLink,
    ).map { candidate ->
      runCatching { requireOwnedAttachmentCachePath(root, candidate) }.isFailure
    }

    assertTrue(rejected.all { it })
    assertTrue(outside.exists())
  }

  @Test
  fun `rejects alternate depths generations and noncanonical encoded names`() {
    val root = temporary.newFolder(ATTACHMENT_CACHE_DIRECTORY).canonicalFile
    val tooLong = "x".repeat(181)
    val tooLongLegacy = "x".repeat(MAX_LEGACY_ATTACHMENT_CACHE_SEGMENT_CHARS + 1)
    val candidates = listOf(
      File(root, "guid/generation-1/media-photo.jpg"),
      File(root, "media-guid/1/media-photo.jpg"),
      File(root, "media-guid/generation-01/media-photo.jpg"),
      File(root, "media-guid/generation-9007199254740992/media-photo.jpg"),
      File(root, "media-guid/generation--1/media-photo.jpg"),
      File(root, "media-guid/generation-account/media-photo.jpg"),
      File(root, "media-guid/generation-1/photo.jpg"),
      File(root, "media-/generation-1/media-photo.jpg"),
      File(root, "media-guid/generation-1/media-"),
      File(root, "media-%41/generation-1/media-photo.jpg"),
      File(root, "media-guid/generation-1/extra/media-photo.jpg"),
      File(root, "media-guid/generation-1/media-bad%2fname"),
      File(root, "media-guid/generation-1/media-bad%ZZname"),
      File(root, "media-guid/generation-1/media-raw name"),
      File(root, "media-guid/generation-1/media-$tooLong"),
      File(root, "media-bad%/generation-1/media-photo.jpg"),
      File(root, "$tooLongLegacy/legacy.pdf"),
      File(root, "legacy-guid/$tooLongLegacy"),
      File(root, "legacy-guid/..."),
      File(root, "legacy-guid/bad\\name.pdf"),
    )

    val rejected = candidates.map { candidate ->
      runCatching { requireOwnedAttachmentCachePath(root, candidate) }.isFailure
    }

    assertTrue(rejected.all { it })
  }

  @Test
  fun `rejects a fixed root that is a file or symlink`() {
    val fileRoot = temporary.newFile("attachments-file")
    val realRoot = temporary.newFolder("attachments-real")
    val linkedRoot = File(temporary.root, "attachments-linked")
    Files.createSymbolicLink(linkedRoot.toPath(), realRoot.toPath())

    assertTrue(
      runCatching {
        requireOwnedAttachmentCachePath(
          fileRoot,
          File(fileRoot, "media-guid/generation-1/media-photo.jpg"),
        )
      }.isFailure,
    )
    assertTrue(
      runCatching {
        requireOwnedAttachmentCachePath(
          linkedRoot,
          File(linkedRoot, "media-guid/generation-1/media-photo.jpg"),
        )
      }.isFailure,
    )
  }
}
