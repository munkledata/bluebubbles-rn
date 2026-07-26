package expo.modules.gatorpasteinput

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

private const val TAG = "GatorPasteInput"
private const val EVENT_PASTE = "onPaste"

/** Batch directories live here, under the app's private cache. */
private const val CACHE_DIR = "pasted-in"

/** Accept everything — a paste is as likely to be a PDF as a screenshot. */
private val ACCEPTED_MIME_TYPES = arrayOf("*/*")

/** A pathological multi-select paste shouldn't be able to flood the composer. */
private const val MAX_FILES = 10

/** Batch directories older than this are swept before each new paste. */
private const val CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000

private const val DEFAULT_MIME = "application/octet-stream"
private const val MAX_NAME_LENGTH = 100

/**
 * Ceiling on a single pasted file. The copy has to run on the UI thread (see [onReceive]), so an
 * unbounded one would be an ANR waiting to happen the first time someone pastes a video out of a
 * file manager. Real pasted content — screenshots, stickers, GIFs, documents — is orders of
 * magnitude under this; anything above it is dropped and surfaces as the composer's
 * "couldn't read that" toast rather than freezing the app.
 */
private const val MAX_BYTES = 128L * 1024 * 1024

private const val COPY_BUFFER = 64 * 1024

/**
 * Makes the chat composer accept pasted pictures and files.
 *
 * WHY THIS MODULE EXISTS: React Native's `ReactEditText` never declares that it accepts rich
 * content — it neither calls `EditorInfoCompat.setContentMimeTypes` (so Gboard refuses to insert
 * an image/GIF/sticker: "this app doesn't support image insertion here") nor handles a URI-bearing
 * clip. Worse, `ReactEditText.onTextContextMenuItem` rewrites every `android.R.id.paste` into
 * `pasteAsPlainText`, so the system's long-press Paste coerces an image to text and drops a raw
 * `content://…` string into the input.
 *
 * THE FIX IS ONE CALL ON THE VIEW RN ALREADY CREATED — no fork, no subclass, no custom
 * ViewManager. `ReactEditText` extends androidx's `AppCompatEditText`, which ALREADY contains the
 * whole receive-content implementation (the `setContentMimeTypes` + `InputConnectionCompat`
 * wiring on API ≤30, and `AppCompatReceiveContentHelper`, which intercepts both `paste` AND
 * `pasteAsPlainText` — so RN's rewrite still routes here). It is simply dormant until a listener
 * is registered. On API 31+ the framework `TextView` does the same natively. Registering
 * `ViewCompat.setOnReceiveContentListener` therefore lights up long-press Paste, keyboard
 * image/GIF/sticker commits, and drag-and-drop at once, for any MIME type.
 *
 * See the JS half in `src/services/paste/pasteInput.ts` + `pastePayload.ts`.
 */
class GatorPasteInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GatorPasteInput")

    Events(EVENT_PASTE)

    // `tag` is the input's React tag, from `findNodeHandle(ref)`. It MUST be passed as a plain Int:
    // Expo's ref converter reads `nativeTag`, but RN 0.86's Fabric public instances expose
    // `__nativeTag`, so handing over the ref object itself silently resolves to nothing.
    //
    // Runs on the MAIN queue because `AppContext.findView` is annotated `@UiThread` (it resolves
    // through the UIManager's mounting layer).
    AsyncFunction("attach") { tag: Int ->
      val view = appContext.findView<EditText>(tag)
      // Ends on an `if` (never on `runCatching`) so the block's value is Unit — the bridge has no
      // converter for a Kotlin `Result`.
      if (view != null) {
        attach(view, tag)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") { tag: Int ->
      val view = appContext.findView<EditText>(tag)
      if (view != null) {
        runCatching {
          ViewCompat.setOnReceiveContentListener(view, null, null)
        }.onFailure { Log.w(TAG, "detach failed: ${it.message}") }
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun attach(view: EditText, tag: Int) {
    runCatching {
      // Re-registering simply replaces the previous listener, so this is idempotent and needs no
      // "already attached" bookkeeping.
      ViewCompat.setOnReceiveContentListener(view, ACCEPTED_MIME_TYPES) { _, payload ->
        onReceive(view.context, payload, tag)
      }
      // `contentMimeTypes` is only read when the input connection is CREATED. Without this, a
      // field that is already focused when we attach keeps advertising plain-text-only until the
      // user defocuses and returns — i.e. the Gboard image chip stays greyed out on first open.
      val imm = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.restartInput(view)
    }.onFailure { Log.w(TAG, "attach failed: ${it.message}") }
  }

  /**
   * Handle one paste/commit/drop.
   *
   * Returns the NON-uri remainder so ordinary text paste keeps working through the platform's
   * default handling; the URI items are consumed here and must not be returned, or the default
   * listener would `coerceToText` them into a `content://…` string in the input.
   *
   * THE COPY IS DELIBERATELY SYNCHRONOUS ON THE UI THREAD. Android grants the pasted URIs only a
   * transient read permission, and for a keyboard commit androidx's `InputConnectionCompat`
   * wrapper calls `releasePermission()` as soon as this method returns — so anything deferred to a
   * background thread or forwarded to JS would find the uri already dead. Pasted content is
   * normally a screenshot or a sticker (single-digit MB), so the copy costs a few milliseconds.
   */
  private fun onReceive(context: Context, payload: ContentInfoCompat, tag: Int): ContentInfoCompat? {
    val split = payload.partition { item -> item.uri != null }
    val withUris = split.first
    val remaining = split.second
    if (withUris == null) return remaining

    val clip = withUris.clip
    val count = minOf(clip.itemCount, MAX_FILES)
    if (count <= 0) return remaining

    val files = ArrayList<Bundle>(count)
    runCatching {
      val batchDir = File(context.cacheDir, "$CACHE_DIR/${System.currentTimeMillis()}")
      pruneOldBatches(batchDir.parentFile)
      if (!batchDir.exists() && !batchDir.mkdirs()) {
        Log.w(TAG, "could not create paste cache directory")
        return@runCatching
      }
      // Iterate every item: a multi-select copy can leave the image at index 1+, and the
      // description's MIME type says nothing about which item carries what.
      for (index in 0 until count) {
        val uri = clip.getItemAt(index)?.uri ?: continue
        val file = copyToCache(context, uri, batchDir, index)
        if (file != null) files.add(file)
      }
    }.onFailure { Log.w(TAG, "paste copy failed: ${it.message}") }

    if (files.isNotEmpty()) {
      val body = Bundle().apply {
        putInt("tag", tag)
        putParcelableArrayList("files", files)
      }
      sendEvent(EVENT_PASTE, body)
    }
    return remaining
  }

  /** Stream one pasted uri into app-private cache, or null when it could not be read. */
  private fun copyToCache(context: Context, uri: Uri, batchDir: File, index: Int): Bundle? {
    return runCatching {
      val resolver = context.contentResolver
      val mimeType = resolver.getType(uri) ?: mimeForExtension(uri.lastPathSegment) ?: DEFAULT_MIME
      val name = uniqueIn(batchDir, safeSegment(queryDisplayName(resolver, uri), index, mimeType))
      val dest = File(batchDir, name)

      // A provider that reports a size lets us reject an oversized file without reading a byte.
      val reportedSize = queryLong(resolver, uri, OpenableColumns.SIZE)
      if (reportedSize != null && reportedSize > MAX_BYTES) {
        Log.w(TAG, "pasted file too large ($reportedSize bytes) — dropping")
        return@runCatching null
      }

      val copied = resolver.openInputStream(uri)?.use { input ->
        // A bounded copy rather than `copyTo`: plenty of providers report no size at all, and this
        // is the only backstop against streaming an unbounded file on the UI thread.
        dest.outputStream().use { output ->
          val buffer = ByteArray(COPY_BUFFER)
          var total = 0L
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > MAX_BYTES) {
              Log.w(TAG, "pasted file exceeded $MAX_BYTES bytes mid-copy — dropping")
              return@use -1L
            }
            output.write(buffer, 0, read)
          }
          total
        }
      }
      if (copied == null || copied < 0L) {
        if (copied == null) Log.w(TAG, "no input stream for pasted uri ($mimeType)")
        dest.delete()
        return@runCatching null
      }
      // MANDATORY re-stat: a provider can resolve the open without ever producing bytes, so a
      // completed copy is not proof of a usable file. An empty file would stage an attachment
      // that fails at send time instead of failing loudly here.
      val length = dest.length()
      if (!dest.exists() || length == 0L) {
        dest.delete()
        Log.w(TAG, "pasted file was empty ($mimeType) — dropping")
        return@runCatching null
      }
      Bundle().apply {
        putString("uri", Uri.fromFile(dest).toString())
        putString("name", name)
        putString("mimeType", mimeType)
        putDouble("size", length.toDouble())
      }
    }.getOrNull()
  }

  /**
   * The provider's display name, or null.
   *
   * Guards the column index rather than assuming it exists: `getColumnIndex` returns -1 for a
   * provider that doesn't implement `OpenableColumns`, and reading at -1 throws — the exact bug
   * that makes `expo-share-intent` fail natively before JS ever hears about it.
   */
  private fun queryDisplayName(resolver: ContentResolver, uri: Uri): String? {
    return runCatching {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
      }
    }.getOrNull()
  }

  /** A numeric provider column (e.g. `OpenableColumns.SIZE`), or null when it isn't reported. */
  private fun queryLong(resolver: ContentResolver, uri: Uri, column: String): Long? {
    return runCatching {
      resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(column)
        if (index >= 0 && cursor.moveToFirst() && !cursor.isNull(index)) {
          cursor.getLong(index)
        } else {
          null
        }
      }
    }.getOrNull()
  }

  /**
   * A display name reduced to one safe path segment that always carries an extension.
   *
   * Stripping everything up to the last separator and then every leading dot makes traversal
   * (`../../x`) and hidden-file names structurally impossible, not merely filtered.
   */
  private fun safeSegment(raw: String?, index: Int, mimeType: String): String {
    val base = (raw ?: "").substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base
      .filter { it.code in 0x20..0x7e && it !in "/\\:*?\"<>|" }
      .trim()
      .trimStart('.')
      .trim()
    var name = if (cleaned.isEmpty()) "pasted-$index" else cleaned
    if (name.length > MAX_NAME_LENGTH) name = name.take(MAX_NAME_LENGTH)
    if (extensionOf(name).isEmpty()) {
      name = "$name.${extensionForMime(mimeType)}"
    }
    return name
  }

  /** Keep two files pasted in the same batch from colliding on one display name. */
  private fun uniqueIn(dir: File, name: String): String {
    if (!File(dir, name).exists()) return name
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    for (i in 1 until 100) {
      val candidate = "$stem-$i$ext"
      if (!File(dir, candidate).exists()) return candidate
    }
    return "$stem-${System.nanoTime()}$ext"
  }

  /**
   * Delete batch directories older than a day. Best-effort housekeeping: a staged-but-unsent
   * attachment holds a path into one of these, so the window has to be generous.
   */
  private fun pruneOldBatches(root: File?) {
    runCatching {
      val cutoff = System.currentTimeMillis() - CACHE_MAX_AGE_MS
      root?.listFiles()?.forEach { dir ->
        val stamp = dir.name.toLongOrNull()
        if (stamp == null || stamp < cutoff) dir.deleteRecursively()
      }
    }.onFailure { Log.w(TAG, "paste cache prune failed: ${it.message}") }
  }

  private fun extensionOf(name: String): String {
    val dot = name.lastIndexOf('.')
    if (dot <= 0 || dot == name.length - 1) return ""
    val ext = name.substring(dot + 1)
    return if (ext.matches(Regex("^[A-Za-z0-9]{1,8}$"))) ext.lowercase() else ""
  }

  /** A filename extension for a MIME type, without the dot. Always returns something. */
  private fun extensionForMime(mimeType: String): String {
    MIME_TO_EXT[mimeType.lowercase().trim()]?.let { return it }
    // e.g. 'image/svg+xml' → 'svg'. Anything that isn't a plain short token (including
    // 'octet-stream', whose hyphen fails the test) falls back to 'bin'.
    val subtype = mimeType.lowercase().substringAfter('/', "").substringBefore(';')
    val candidate = subtype.substringBefore('+')
    return if (candidate.matches(Regex("^[a-z0-9]{1,8}$"))) candidate else "bin"
  }

  private fun mimeForExtension(name: String?): String? {
    val ext = extensionOf(name ?: "")
    if (ext.isEmpty()) return null
    return MIME_TO_EXT.entries.firstOrNull { it.value == ext }?.key
  }

  private companion object {
    /** Mirrors the table in `src/services/share/shareIntentPayload.ts`. */
    val MIME_TO_EXT = mapOf(
      "application/pdf" to "pdf",
      "application/zip" to "zip",
      "text/plain" to "txt",
      "text/csv" to "csv",
      "text/vcard" to "vcf",
      "image/jpeg" to "jpg",
      "image/png" to "png",
      "image/gif" to "gif",
      "image/webp" to "webp",
      "image/heic" to "heic",
      "video/mp4" to "mp4",
      "video/quicktime" to "mov",
      "audio/mpeg" to "mp3",
      "audio/mp4" to "m4a",
    )
  }
}
