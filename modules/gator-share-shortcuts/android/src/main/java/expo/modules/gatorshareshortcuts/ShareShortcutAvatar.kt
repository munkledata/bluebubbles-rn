package expo.modules.gatorshareshortcuts

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import androidx.core.graphics.drawable.IconCompat
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * The picture a conversation shortcut shows (and therefore a conversation notification, which
 * Android draws from the shortcut). JavaScript computes it with the app's own avatar rules so the
 * shortcut looks like the in-app avatar; this side only validates and draws it.
 *
 * - [photoUri]: a contact photo (`content://com.android.contacts/...`) or a file Gator itself
 *   stored (group photos, server avatars). Anything else is ignored and the letter circle is used
 *   (see [resolveAvatarSource]).
 * - [initials]: up to [MAX_INITIALS_CODE_POINTS] code points; empty draws a person glyph.
 * - [background] / [foreground]: `#RRGGBB`.
 */
internal data class ShareShortcutAvatarSpec(
  val photoUri: String?,
  val initials: String,
  val background: Int,
  val foreground: Int,
)

internal const val MAX_INITIALS_CODE_POINTS = 4
private const val MAX_PHOTO_URI_BYTES = 2048
private const val CONTACTS_AUTHORITY = "com.android.contacts"
private val HEX_COLOR = Regex("^#[0-9A-Fa-f]{6}$")
private const val AVATAR_PX = 192
private const val MAX_DECODE_PX = AVATAR_PX * 2

/** Parse `#RRGGBB` to an opaque ARGB int, or null for anything else. Pure, JVM-testable. */
internal fun parseAvatarColor(value: String?): Int? {
  if (value == null || !HEX_COLOR.matches(value)) return null
  return (0xFF shl 24) or value.substring(1).toInt(16)
}

/** Bounded initials, or null when they are too long to be initials. Pure, JVM-testable. */
internal fun normalizeAvatarInitials(value: String?): String? {
  val trimmed = (value ?: "").trim()
  if (trimmed.codePointCount(0, trimmed.length) > MAX_INITIALS_CODE_POINTS) return null
  if (trimmed.any { it.isISOControl() }) return null
  return trimmed
}

/** Where an allowed avatar photo is read from. */
internal sealed class AvatarSource {
  /** A system contacts-provider photo, opened through the ContentResolver. */
  data class ContactPhoto(val uri: String) : AvatarSource()

  /** A file inside Gator's own storage, opened by exactly this canonical path. */
  data class OwnFile(val canonicalPath: String) : AvatarSource()
}

/**
 * Decide whether a photo URI may be opened, and how. Allowed: a contact photo from the system
 * contacts provider, or a `file://` path inside one of Gator's own directories ([ownDirectories],
 * canonical). The file path is percent-decoded BEFORE it is canonicalized, and the caller opens the
 * returned canonical path itself, so an encoded `..%2F` can't pass the check and then escape when
 * opened. Everything else (other providers, remote URLs, other apps' files) is refused. Pure,
 * JVM-testable: [canonicalPath] resolves a decoded file path.
 */
internal fun resolveAvatarSource(
  uri: String,
  ownDirectories: List<String>,
  canonicalPath: (String) -> String?,
): AvatarSource? {
  if (uri.isEmpty() || uri.toByteArray().size > MAX_PHOTO_URI_BYTES) return null
  if (uri.any { it.isISOControl() }) return null
  val parsed = runCatching { java.net.URI(uri) }.getOrNull() ?: return null
  return when (parsed.scheme?.lowercase()) {
    "content" ->
      if (parsed.rawAuthority == CONTACTS_AUTHORITY && parsed.rawUserInfo == null) {
        AvatarSource.ContactPhoto(uri)
      } else {
        null
      }
    "file" -> {
      if (!parsed.rawAuthority.isNullOrEmpty()) return null
      val decoded = parsed.path ?: return null // java.net.URI decodes percent escapes here
      if (!decoded.startsWith("/") || decoded.any { it.isISOControl() }) return null
      val resolved = canonicalPath(decoded) ?: return null
      val inside = ownDirectories.any { dir ->
        resolved.startsWith(if (dir.endsWith("/")) dir else "$dir/")
      }
      if (inside) AvatarSource.OwnFile(resolved) else null
    }
    else -> null
  }
}

/** Validate one bridge record into a spec. Pure; invalid pieces fall back rather than throw. */
internal fun normalizeAvatarSpec(
  photoUri: String?,
  initials: String?,
  background: String?,
  foreground: String?,
): ShareShortcutAvatarSpec? {
  val bg = parseAvatarColor(background) ?: return null
  val fg = parseAvatarColor(foreground) ?: return null
  val text = normalizeAvatarInitials(initials) ?: return null
  val photo = photoUri?.takeIf { it.isNotBlank() }
  return ShareShortcutAvatarSpec(photo, text, bg, fg)
}

/** Draws avatar icons. Not JVM-testable (android.graphics); covered by device proof. */
internal class ShareShortcutAvatarRenderer(private val context: Context) {
  private val ownDirectories: List<String> by lazy {
    listOfNotNull(context.filesDir, context.cacheDir, context.noBackupFilesDir)
      .mapNotNull { runCatching { it.canonicalPath }.getOrNull() }
  }

  fun iconFor(spec: ShareShortcutAvatarSpec): IconCompat {
    val photo = spec.photoUri?.let { loadPhoto(it) }
    val bitmap = photo?.let { circularCrop(it) } ?: letterCircle(spec)
    return IconCompat.createWithBitmap(bitmap)
  }

  private fun loadPhoto(uri: String): Bitmap? {
    val source = resolveAvatarSource(uri, ownDirectories) {
      runCatching { File(it).canonicalPath }.getOrNull()
    } ?: return null
    val open: () -> InputStream? = when (source) {
      is AvatarSource.ContactPhoto -> { -> context.contentResolver.openInputStream(Uri.parse(source.uri)) }
      is AvatarSource.OwnFile -> { -> FileInputStream(File(source.canonicalPath)) }
    }
    return runCatching {
      // Read the size first, then decode at most ~2x the icon size so a huge photo can't exhaust memory.
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      var sample = 1
      while (
        bounds.outWidth / (sample * 2) >= MAX_DECODE_PX &&
        bounds.outHeight / (sample * 2) >= MAX_DECODE_PX
      ) {
        sample *= 2
      }
      val options = BitmapFactory.Options().apply { inSampleSize = sample }
      open()?.use { BitmapFactory.decodeStream(it, null, options) }
    }.getOrNull()
  }

  private fun circularCrop(source: Bitmap): Bitmap {
    val out = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888)
    val scale = AVATAR_PX.toFloat() / minOf(source.width, source.height)
    val matrix = Matrix().apply {
      setScale(scale, scale)
      postTranslate((AVATAR_PX - source.width * scale) / 2f, (AVATAR_PX - source.height * scale) / 2f)
    }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
        setLocalMatrix(matrix)
      }
    }
    Canvas(out).drawOval(RectF(0f, 0f, AVATAR_PX.toFloat(), AVATAR_PX.toFloat()), paint)
    return out
  }

  /** The app's letter circle: initials at 0.4 of the size (weight 600), or a person glyph. */
  private fun letterCircle(spec: ShareShortcutAvatarSpec): Bitmap {
    val size = AVATAR_PX.toFloat()
    val out = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawOval(RectF(0f, 0f, size, size), Paint(Paint.ANTI_ALIAS_FLAG).apply { color = spec.background })
    val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = spec.foreground }
    if (spec.initials.isNotEmpty()) {
      ink.textSize = size * 0.4f
      ink.typeface = Typeface.create(Typeface.DEFAULT, 600, false)
      ink.textAlign = Paint.Align.CENTER
      val baseline = size / 2f - (ink.descent() + ink.ascent()) / 2f
      canvas.drawText(spec.initials, size / 2f, baseline, ink)
    } else {
      // A simple person silhouette at 0.55 of the size: head plus shoulders.
      val glyph = size * 0.55f
      val left = (size - glyph) / 2f
      val top = (size - glyph) / 2f
      canvas.drawCircle(size / 2f, top + glyph * 0.28f, glyph * 0.22f, ink)
      canvas.drawArc(
        RectF(left + glyph * 0.12f, top + glyph * 0.56f, left + glyph * 0.88f, top + glyph * 1.3f),
        180f,
        180f,
        true,
        ink,
      )
    }
    return out
  }
}
