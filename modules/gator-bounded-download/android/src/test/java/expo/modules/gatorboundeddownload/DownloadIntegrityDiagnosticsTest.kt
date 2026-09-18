package expo.modules.gatorboundeddownload

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DownloadIntegrityDiagnosticsTest {
  @get:Rule
  val temporary = TemporaryFolder()
  private val fileSystem = NioAttachmentCacheFileSystem()

  @Test
  fun `counts only stable files in the fixed flat partial namespace`() {
    val root = temporary.newFolder(BOUNDED_DOWNLOAD_PARTIAL_DIRECTORY).canonicalFile
    val first = File(root, "request-100-1.part").apply { writeBytes(ByteArray(3)) }
    val second = File(root, "request-200-2.part").apply { writeBytes(ByteArray(5)) }

    val result = inspectBoundedDownloadPartials(root, fileSystem)

    assertEquals(2L, result.files)
    assertEquals(8L, result.bytes)
    assertTrue(first.exists())
    assertTrue(second.exists())
  }

  @Test
  fun `rejects an unexpected partial layout instead of skipping it`() {
    val root = temporary.newFolder(BOUNDED_DOWNLOAD_PARTIAL_DIRECTORY).canonicalFile
    File(root, "unexpected").mkdir()

    assertThrows(IllegalArgumentException::class.java) {
      inspectBoundedDownloadPartials(root, fileSystem)
    }
  }
}
