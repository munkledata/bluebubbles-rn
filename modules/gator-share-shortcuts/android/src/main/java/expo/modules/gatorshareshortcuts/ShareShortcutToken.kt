package expo.modules.gatorshareshortcuts

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
private const val KEY_ALIAS = "gator-share-shortcut-hmac-v2"
private const val PREFERENCES = "gator-share-shortcut-scope-v2"
private const val EPOCH_KEY = "epoch"
private const val EPOCH_BYTES = 16
private const val MAX_CHAT_GUID_BYTES = 1024
private const val MAX_TARGET_CANDIDATES = 256
private val CURRENT_SHORTCUT_ID = Regex("^gator-share-v2-[A-Za-z0-9_-]{43}$")

/** Immutable key/scope pair used for one complete token operation. */
internal class ShareShortcutTokenSnapshot(
  private val secretKey: SecretKey,
  epoch: ByteArray,
) {
  private val epoch = epoch.copyOf()

  init {
    require(this.epoch.size == EPOCH_BYTES) { "Invalid share shortcut scope" }
  }

  fun tokenFor(chatGuid: String): String {
    val guid = chatGuid.toByteArray(StandardCharsets.UTF_8)
    require(guid.isNotEmpty() && guid.size <= MAX_CHAT_GUID_BYTES) { "Invalid share chat identity" }
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(secretKey)
    mac.update(epoch)
    mac.update(0.toByte())
    val digest = mac.doFinal(guid)
    val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    return "$CURRENT_SHARE_SHORTCUT_PREFIX$encoded".also { token ->
      check(CURRENT_SHORTCUT_ID.matches(token)) { "Invalid generated share shortcut id" }
    }
  }
}

/**
 * Resolves every candidate against one key/epoch snapshot. Operational failures intentionally
 * escape this boundary so JavaScript can distinguish them from a valid no-match result.
 */
internal class ShareShortcutTokenResolver(
  private val snapshotProvider: () -> ShareShortcutTokenSnapshot,
) {
  fun tokenFor(chatGuid: String): String = snapshotProvider().tokenFor(chatGuid)

  fun resolve(token: String, candidates: List<String>): String? {
    if (!CURRENT_SHORTCUT_ID.matches(token) || candidates.size > MAX_TARGET_CANDIDATES) return null
    val snapshot = snapshotProvider()
    val tokenBytes = token.toByteArray(StandardCharsets.US_ASCII)
    var match: String? = null
    candidates.forEach { candidate ->
      val derived = snapshot.tokenFor(candidate)
      if (MessageDigest.isEqual(tokenBytes, derived.toByteArray(StandardCharsets.US_ASCII))) {
        match = candidate
      }
    }
    return match
  }
}

/** Current-account scope is random, non-sensitive, and rotated only after account cleanup. */
internal class ShareShortcutTokenOwner(private val context: Context) {
  private val resolver = ShareShortcutTokenResolver(::snapshot)

  fun tokenFor(chatGuid: String): String = resolver.tokenFor(chatGuid)

  fun resolve(token: String, candidates: List<String>): String? = resolver.resolve(token, candidates)

  fun rotate(): Boolean {
    val encoded = newEpoch()
    return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(EPOCH_KEY, encoded)
      .commit()
  }

  private fun epoch(): ByteArray {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val stored = preferences.getString(EPOCH_KEY, null)
    val decoded = stored?.let(::decodeEpoch)
    if (decoded != null) return decoded
    val encoded = newEpoch()
    check(preferences.edit().putString(EPOCH_KEY, encoded).commit()) {
      "Share shortcut scope could not be persisted"
    }
    return checkNotNull(decodeEpoch(encoded))
  }

  private fun newEpoch(): String = ByteArray(EPOCH_BYTES)
    .also(SecureRandom()::nextBytes)
    .let(Base64.getUrlEncoder().withoutPadding()::encodeToString)

  private fun decodeEpoch(encoded: String): ByteArray? = runCatching {
    Base64.getUrlDecoder().decode(encoded).takeIf { it.size == EPOCH_BYTES }
  }.getOrNull()

  private fun snapshot(): ShareShortcutTokenSnapshot = ShareShortcutTokenSnapshot(
    secretKey = secretKey(),
    epoch = epoch(),
  )

  private fun secretKey(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE_PROVIDER)
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
        .setDigests(KeyProperties.DIGEST_SHA256)
        .build(),
    )
    return generator.generateKey()
  }
}
