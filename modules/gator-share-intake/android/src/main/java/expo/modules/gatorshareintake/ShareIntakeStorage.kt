package expo.modules.gatorshareintake

import java.io.File
import java.io.FileOutputStream

private const val PENDING_MANIFEST_SUFFIX = ".pending"
private const val READY_MANIFEST_SUFFIX = ".share"
private const val CLAIMED_MANIFEST_SUFFIX = ".claimed"
private const val ACKED_MANIFEST_SUFFIX = ".acked"
private const val PENDING_FILES_SUFFIX = ".pending"
private const val REJECTION_RECEIPT = "last-rejection.receipt"
private const val REJECTION_PENDING = "last-rejection.pending"

internal data class ShareStorageStats(
  val batches: Int,
  val bytes: Long,
)

/** Fixed-root, exact-shape storage for complete native share batches. */
internal class ShareIntakeStorage(private val root: File) {
  private val queueRoot = File(root, SHARE_QUEUE_DIRECTORY)
  private val filesRoot = File(root, SHARE_FILES_DIRECTORY)

  @Synchronized
  fun recoverAndPrune(
    nowMs: Long,
    activePendingBatchIds: Set<String> = emptySet(),
  ): ShareStorageStats {
    prepareRoots()
    val queueEntries = boundedChildren(queueRoot)
    val fileEntries = boundedChildren(filesRoot)

    val pendingManifests = mutableMapOf<String, File>()
    val readyManifests = mutableMapOf<String, File>()
    val claimedManifests = mutableMapOf<String, File>()
    val ackedManifests = mutableMapOf<String, File>()
    queueEntries.forEach { entry ->
      requireOwnedChild(queueRoot, entry)
      require(entry.isFile) { "Share queue contains a non-file entry" }
      val pair = manifestEntry(entry)
        ?: throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
      when (pair.second) {
        PENDING_MANIFEST_SUFFIX -> pendingManifests[pair.first] = entry
        READY_MANIFEST_SUFFIX -> readyManifests[pair.first] = entry
        CLAIMED_MANIFEST_SUFFIX -> claimedManifests[pair.first] = entry
        ACKED_MANIFEST_SUFFIX -> ackedManifests[pair.first] = entry
      }
    }

    val committedFiles = mutableMapOf<String, File>()
    fileEntries.forEach { entry ->
      requireOwnedChild(filesRoot, entry)
      require(entry.isDirectory) { "Share files root contains a non-directory entry" }
      if (entry.name.endsWith(PENDING_FILES_SUFFIX)) {
        val batchId = entry.name.removeSuffix(PENDING_FILES_SUFFIX)
        requireValidShareBatchId(batchId)
        // A cold React mount can pull the queue while the process-owned provider worker is still
        // copying this exact batch. Only an id protected by that live worker may survive recovery;
        // after process death the set is empty and every abandoned partial is removed.
        if (batchId !in activePendingBatchIds) {
          deleteOwnedBatchDirectory(entry, allowEmpty = true)
        }
      } else {
        val batchId = requireValidShareBatchId(entry.name)
        committedFiles[batchId] = entry
      }
    }

    // A manifest is durable before its file directory is promoted. If both are complete, finish
    // the final queue rename after a crash; otherwise remove only that exact abandoned batch.
    pendingManifests.forEach { (batchId, pending) ->
      val manifest = runCatching { readManifest(pending) }.getOrNull()
      val batchDirectory = committedFiles[batchId]
      val complete = manifest != null && if (manifest.files.isEmpty()) {
        batchDirectory == null
      } else {
        batchDirectory != null && validateBatchDirectory(batchDirectory, manifest, allowMissing = false)
      }
      if (complete) {
        val ready = readyManifest(batchId)
        if (ready.exists() || !pending.renameTo(ready)) {
          throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
        }
        readyManifests[batchId] = ready
      } else {
        pending.delete()
        batchDirectory?.let { deleteOwnedBatchDirectory(it, allowEmpty = true) }
        committedFiles.remove(batchId)
      }
    }

    // Ready batches are all-or-nothing. A malformed/corrupt owned batch is discarded rather than
    // exposing a partial payload to JavaScript.
    readyManifests.toMap().forEach { (batchId, ready) ->
      val manifest = runCatching { readManifest(ready) }.getOrNull()
      val directory = committedFiles[batchId]
      val complete = manifest != null && if (manifest.files.isEmpty()) {
        directory == null
      } else {
        directory != null && validateBatchDirectory(directory, manifest, allowMissing = false)
      }
      if (!complete) {
        ready.delete()
        directory?.let { deleteOwnedBatchDirectory(it, allowEmpty = true) }
        readyManifests.remove(batchId)
        committedFiles.remove(batchId)
      }
    }

    // A claimed batch is subject to the same all-or-nothing validation as a ready batch.
    claimedManifests.toMap().forEach { (batchId, claimed) ->
      val manifest = runCatching { readManifest(claimed) }.getOrNull()
      val directory = committedFiles[batchId]
      val complete = manifest != null && if (manifest.files.isEmpty()) {
        directory == null
      } else {
        directory != null && validateBatchDirectory(directory, manifest, allowMissing = false)
      }
      if (!complete) {
        claimed.delete()
        directory?.let { deleteOwnedBatchDirectory(it, allowEmpty = true) }
        claimedManifests.remove(batchId)
        committedFiles.remove(batchId)
      }
    }

    // A valid claimed batch is replayed after process death. Normalize an impossible second claim
    // back to ready so there is still exactly one active complete batch.
    claimedManifests.toList()
      .sortedWith(compareBy({ readManifest(it.second).createdAtMs }, { it.first }))
      .drop(1)
      .forEach { (batchId, claimed) ->
        val ready = readyManifest(batchId)
        if (ready.exists() || !claimed.renameTo(ready)) {
          throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
        }
        claimedManifests.remove(batchId)
        readyManifests[batchId] = ready
      }

    // An acknowledged marker is a durable cleanup intent. Finish deleting exact native sources
    // after a process death rather than replaying already-consumed content.
    ackedManifests.toMap().forEach { (batchId, marker) ->
      val directory = committedFiles[batchId]
      directory?.let { deleteOwnedBatchDirectory(it, allowEmpty = true) }
      check(marker.delete() || !marker.exists())
      ackedManifests.remove(batchId)
      committedFiles.remove(batchId)
    }

    // Exact committed file directories without a ready/acked owner are abandoned crash output.
    committedFiles.toMap().forEach { (batchId, directory) ->
      if (
        batchId !in readyManifests &&
        batchId !in claimedManifests &&
        batchId !in ackedManifests
      ) {
        deleteOwnedBatchDirectory(directory, allowEmpty = true)
        committedFiles.remove(batchId)
      }
    }

    val cutoff = if (nowMs < Long.MIN_VALUE + SHARE_CACHE_MAX_AGE_MS) {
      Long.MIN_VALUE
    } else {
      nowMs - SHARE_CACHE_MAX_AGE_MS
    }
    // A claimed batch may still be staged in the live JavaScript process. Opportunistic recovery
    // cannot delete it behind that owner's back: exact acknowledge/discard/release/account-reset
    // operations are the only safe terminal transitions. Unclaimed ready work can still expire,
    // including a claim an earlier process left behind once releaseAllClaims returned it to ready.
    readyManifests.keys.toList().forEach { batchId ->
      val manifestFile = readyManifests[batchId] ?: return@forEach
      val manifest = readManifest(manifestFile)
      if (manifest.createdAtMs < cutoff) {
        committedFiles[batchId]?.let { deleteOwnedBatchDirectory(it, allowEmpty = true) }
        manifestFile.delete()
        committedFiles.remove(batchId)
        readyManifests.remove(batchId)
      }
    }

    return measureStorage(activePendingBatchIds)
  }

  @Synchronized
  fun admissionBudget(nowMs: Long, activePendingBatchIds: Set<String> = emptySet()): Long {
    val stats = recoverAndPrune(nowMs, activePendingBatchIds)
    if (stats.batches >= SHARE_CACHE_MAX_BATCHES || stats.bytes >= SHARE_CACHE_MAX_BYTES) {
      throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
    }
    return minOf(MAX_SHARED_BATCH_BYTES, SHARE_CACHE_MAX_BYTES - stats.bytes).also { available ->
      if (available <= 0L) throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
    }
  }

  fun pendingFilesDirectory(batchId: String): File {
    prepareRoots()
    return File(filesRoot, "${requireValidShareBatchId(batchId)}$PENDING_FILES_SUFFIX")
  }

  /** Publish the already-fsynced pending file directory and manifest in recoverable order. */
  @Synchronized
  fun commit(manifest: ShareManifest, pendingFilesDirectory: File?) {
    validateShareManifest(manifest)
    prepareRoots()
    val batchId = manifest.batchId
    val pendingManifest = pendingManifest(batchId)
    val readyManifest = readyManifest(batchId)
    val committedDirectory = committedFilesDirectory(batchId)
    require(!pendingManifest.exists() && !readyManifest.exists() && !committedDirectory.exists()) {
      "Share batch already exists"
    }
    if (manifest.files.isEmpty()) {
      require(pendingFilesDirectory == null) { "Text-only share unexpectedly has files" }
    } else {
      require(pendingFilesDirectory != null) { "File share has no pending directory" }
      requireOwnedChild(filesRoot, pendingFilesDirectory)
      require(pendingFilesDirectory.name == "$batchId$PENDING_FILES_SUFFIX") {
        "Share pending directory has the wrong owner"
      }
      check(validateBatchDirectory(pendingFilesDirectory, manifest, allowMissing = false)) {
        "Share pending directory is incomplete"
      }
    }

    try {
      writeManifest(pendingManifest, manifest)
      if (pendingFilesDirectory != null && !pendingFilesDirectory.renameTo(committedDirectory)) {
        throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
      }
      if (!pendingManifest.renameTo(readyManifest)) {
        throw ShareIntakeException(ShareIntakeFailure.PROVIDER)
      }
    } catch (error: Exception) {
      pendingManifest.delete()
      if (!readyManifest.exists()) {
        pendingFilesDirectory?.takeIf { it.exists() }?.let {
          deleteOwnedBatchDirectory(it, allowEmpty = true)
        }
        committedDirectory.takeIf { it.exists() }?.let {
          deleteOwnedBatchDirectory(it, allowEmpty = true)
        }
      }
      throw error
    }
  }

  /** Commit and retract atomically from queue observers when the absolute intake deadline passed. */
  @Synchronized
  fun commitWithinDeadline(
    manifest: ShareManifest,
    pendingFilesDirectory: File?,
    deadlineAtMs: Long,
    nowMs: () -> Long,
  ): Boolean {
    commit(manifest, pendingFilesDirectory)
    if (nowMs() < deadlineAtMs) return true
    check(discardUnclaimed(manifest.batchId)) { "Expired share batch could not be discarded" }
    return false
  }

  @Synchronized
  fun takeNext(nowMs: Long, activePendingBatchIds: Set<String> = emptySet()): ShareManifest? {
    recoverAndPrune(nowMs, activePendingBatchIds)
    val claimed = boundedChildren(queueRoot)
      .filter { it.name.endsWith(CLAIMED_MANIFEST_SUFFIX) }
    if (claimed.size > 1) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
    claimed.singleOrNull()?.let(::readManifest)?.let { return it }

    val next = boundedChildren(queueRoot)
      .filter { it.name.endsWith(READY_MANIFEST_SUFFIX) }
      .mapNotNull { file -> runCatching { readManifest(file) }.getOrNull()?.let { it to file } }
      .minWithOrNull(compareBy<Pair<ShareManifest, File>> { it.first.createdAtMs }.thenBy { it.first.batchId })
      ?: return null
    val destination = claimedManifest(next.first.batchId)
    if (destination.exists() || !next.second.renameTo(destination)) {
      throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
    }
    return next.first
  }

  /**
   * Return every claimed batch to ready, one entry at a time. An entry it cannot return (an invalid
   * name, a non-file, a batch already ready, a failed rename) stays as it was for recoverAndPrune to
   * judge. A claim belongs to the JavaScript runtime that took it and ends with its process, so
   * EarlierClaimRelease calls this at the first storage use in each new process. A returned batch
   * replays oldest first and ages out like any ready batch.
   */
  @Synchronized
  fun releaseAllClaims() {
    prepareRoots()
    boundedChildren(queueRoot)
      .filter { it.name.endsWith(CLAIMED_MANIFEST_SUFFIX) }
      .forEach { claimed ->
        runCatching {
          requireOwnedChild(queueRoot, claimed)
          require(claimed.isFile) { "Share queue contains a non-file entry" }
          val ready = readyManifest(checkNotNull(manifestEntry(claimed)).first)
          if (!ready.exists()) claimed.renameTo(ready)
        }
      }
  }

  @Synchronized
  fun hasCompleteBatch(
    nowMs: Long,
    activePendingBatchIds: Set<String> = emptySet(),
  ): Boolean {
    recoverAndPrune(nowMs, activePendingBatchIds)
    return boundedChildren(queueRoot).any { entry ->
      entry.name.endsWith(READY_MANIFEST_SUFFIX) ||
        entry.name.endsWith(CLAIMED_MANIFEST_SUFFIX)
    }
  }

  @Synchronized
  fun acknowledge(batchId: String): Boolean {
    requireValidShareBatchId(batchId)
    prepareRoots()
    val acknowledged = ackedManifest(batchId)
    if (acknowledged.exists()) {
      if (claimedManifest(batchId).exists() || readyManifest(batchId).exists()) return false
      return finishSettledCleanup(batchId, acknowledged)
    }
    val claimed = exactClaim(batchId) ?: return exactBatchIsAbsent(batchId)
    if (!claimed.renameTo(acknowledged)) return false
    return finishSettledCleanup(batchId, acknowledged)
  }

  @Synchronized
  fun release(batchId: String): Boolean {
    requireValidShareBatchId(batchId)
    prepareRoots()
    val claimed = exactClaim(batchId) ?: return false
    val ready = readyManifest(batchId)
    if (ready.exists()) return false
    return claimed.renameTo(ready)
  }

  @Synchronized
  fun discard(batchId: String): Boolean {
    requireValidShareBatchId(batchId)
    prepareRoots()
    val acknowledged = ackedManifest(batchId)
    if (acknowledged.exists()) {
      if (claimedManifest(batchId).exists() || readyManifest(batchId).exists()) return false
      return finishSettledCleanup(batchId, acknowledged)
    }
    val claimed = exactClaim(batchId) ?: return exactBatchIsAbsent(batchId)
    if (!claimed.renameTo(acknowledged)) return false
    return finishSettledCleanup(batchId, acknowledged)
  }

  /**
   * Idempotent account-teardown boundary. A durable app receipt proves this exact native batch is
   * account-bound, so remove either queue state before the encrypted account database is wiped.
   */
  @Synchronized
  fun discardForAccountReset(batchId: String): Boolean {
    requireValidShareBatchId(batchId)
    prepareRoots()
    val pending = pendingManifest(batchId)
    // A process-owned provider copy can have created either pending artifact first. Account reset
    // must never report success while that live intake can still publish the batch afterwards.
    if (pending.exists() || pendingFilesDirectory(batchId).exists()) return false
    val ready = readyManifest(batchId)
    val claimed = claimedManifest(batchId)
    if (ready.exists() && claimed.exists()) return false
    val acknowledged = ackedManifest(batchId)
    val source = when {
      claimed.exists() -> claimed
      ready.exists() -> ready
      acknowledged.exists() -> acknowledged
      else -> null
    }
    if (source != null && source != acknowledged) {
      if (acknowledged.exists() || !source.renameTo(acknowledged)) return false
    }
    committedFilesDirectory(batchId).takeIf { it.exists() }?.let {
      deleteOwnedBatchDirectory(it, allowEmpty = true)
    }
    if (acknowledged.exists() && !acknowledged.delete()) return false
    return !ready.exists() && !claimed.exists() && !committedFilesDirectory(batchId).exists()
  }

  /** Internal cleanup for a batch that has not crossed the JS claim boundary. */
  @Synchronized
  fun discardUnclaimed(batchId: String): Boolean {
    requireValidShareBatchId(batchId)
    prepareRoots()
    if (claimedManifest(batchId).exists()) return false
    listOf(pendingManifest(batchId), readyManifest(batchId), ackedManifest(batchId)).forEach { file ->
      if (file.exists() && !file.delete()) return false
    }
    listOf(pendingFilesDirectory(batchId), committedFilesDirectory(batchId)).forEach { directory ->
      if (directory.exists()) deleteOwnedBatchDirectory(directory, allowEmpty = true)
    }
    return true
  }

  @Synchronized
  fun recordRejection(reason: ShareIntakeFailure) {
    prepareRoots()
    val pending = requireOwnedChild(root, File(root, REJECTION_PENDING))
    val receipt = requireOwnedChild(root, File(root, REJECTION_RECEIPT))
    pending.delete()
    FileOutputStream(pending, false).use { output ->
      output.write(reason.name.toByteArray(Charsets.US_ASCII))
      output.flush()
      output.fd.sync()
    }
    if (receipt.exists() && !receipt.delete()) {
      pending.delete()
      throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
    }
    if (!pending.renameTo(receipt)) {
      pending.delete()
      throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
    }
  }

  @Synchronized
  fun consumeRejection(): ShareIntakeFailure? {
    prepareRoots()
    val pending = requireOwnedChild(root, File(root, REJECTION_PENDING))
    if (pending.exists()) pending.delete()
    val receipt = requireOwnedChild(root, File(root, REJECTION_RECEIPT))
    if (!receipt.exists()) return null
    val reason = runCatching {
      require(receipt.isFile && receipt.length() in 1..32)
      ShareIntakeFailure.valueOf(receipt.readText(Charsets.US_ASCII))
    }.getOrNull()
    check(receipt.delete() || !receipt.exists())
    return reason
  }

  fun committedFile(manifest: ShareManifest, file: ShareManifestFile): File {
    require(file in manifest.files) { "File is not owned by this share manifest" }
    val directory = committedFilesDirectory(manifest.batchId)
    val candidate = File(directory, file.name)
    requireOwnedChild(directory, candidate)
    return candidate
  }

  private fun prepareRoots() {
    ensureOwnedRoot(root)
    ensureOwnedDirectory(root, queueRoot)
    ensureOwnedDirectory(root, filesRoot)
  }

  private fun measureStorage(activePendingBatchIds: Set<String>): ShareStorageStats {
    val manifests = boundedChildren(queueRoot)
      .filter {
        it.name.endsWith(READY_MANIFEST_SUFFIX) ||
          it.name.endsWith(CLAIMED_MANIFEST_SUFFIX)
      }
    var bytes = 0L
    boundedChildren(filesRoot).forEach { directory ->
      requireOwnedChild(filesRoot, directory)
      if (
        directory.name.endsWith(PENDING_FILES_SUFFIX) &&
        directory.name.removeSuffix(PENDING_FILES_SUFFIX) in activePendingBatchIds
      ) {
        return@forEach
      }
      val children = boundedChildren(directory, MAX_SHARED_FILES)
      children.forEach { file ->
        requireOwnedChild(directory, file)
        require(file.isFile) { "Share batch contains a non-file" }
        val size = file.length()
        if (size <= 0L || size > MAX_SHARED_FILE_BYTES || size > Long.MAX_VALUE - bytes) {
          throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
        }
        bytes += size
      }
    }
    return ShareStorageStats(manifests.size, bytes)
  }

  private fun validateBatchDirectory(
    directory: File,
    manifest: ShareManifest,
    allowMissing: Boolean,
  ): Boolean = runCatching {
    requireOwnedChild(filesRoot, directory)
    require(directory.isDirectory)
    val expected = manifest.files.associateBy { it.name }
    val children = boundedChildren(directory, MAX_SHARED_FILES)
    if (!allowMissing) require(children.size == expected.size)
    children.forEach { child ->
      requireOwnedChild(directory, child)
      val file = expected[child.name] ?: throw IllegalArgumentException("Unexpected shared file")
      require(child.isFile && child.length() == file.size)
    }
    if (!allowMissing) require(children.map { it.name }.toSet() == expected.keys)
    true
  }.getOrDefault(false)

  private fun deleteOwnedBatchDirectory(directory: File, allowEmpty: Boolean) {
    requireOwnedChild(filesRoot, directory)
    require(directory.isDirectory) { "Share batch deletion target is not a directory" }
    val children = boundedChildren(directory, MAX_SHARED_FILES)
    if (!allowEmpty) require(children.isNotEmpty()) { "Share batch is unexpectedly empty" }
    children.forEach { child ->
      requireOwnedChild(directory, child)
      require(child.isFile) { "Share batch contains a non-file" }
    }
    children.forEach { child -> check(child.delete() || !child.exists()) }
    check(directory.delete() || !directory.exists())
  }

  /** The `.acked` rename makes a failed physical cleanup safely retryable by the exact owner. */
  private fun finishSettledCleanup(batchId: String, acknowledged: File): Boolean =
    runCatching {
      committedFilesDirectory(batchId).takeIf { it.exists() }?.let {
        deleteOwnedBatchDirectory(it, allowEmpty = true)
      }
      check(acknowledged.delete() || !acknowledged.exists())
    }.isSuccess

  private fun writeManifest(file: File, manifest: ShareManifest) {
    requireOwnedChild(queueRoot, file)
    val encoded = encodeShareManifest(manifest)
    require(file.createNewFile()) { "Share manifest already exists" }
    FileOutputStream(file, false).use { output ->
      output.write(encoded)
      output.flush()
      output.fd.sync()
    }
  }

  private fun readManifest(file: File): ShareManifest {
    requireOwnedChild(queueRoot, file)
    require(file.isFile && file.length() in 1..MAX_SHARE_MANIFEST_BYTES.toLong()) {
      "Share manifest has invalid storage shape"
    }
    val bytes = file.inputStream().use { input ->
      val encoded = input.readNBytes(MAX_SHARE_MANIFEST_BYTES + 1)
      if (encoded.size > MAX_SHARE_MANIFEST_BYTES) {
        throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
      }
      encoded
    }
    val manifest = decodeShareManifest(bytes)
    val entry = manifestEntry(file) ?: throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
    if (entry.first != manifest.batchId) throw ShareIntakeException(ShareIntakeFailure.MALFORMED)
    return manifest
  }

  private fun manifestEntry(file: File): Pair<String, String>? {
    val suffix = listOf(
      PENDING_MANIFEST_SUFFIX,
      READY_MANIFEST_SUFFIX,
      CLAIMED_MANIFEST_SUFFIX,
      ACKED_MANIFEST_SUFFIX,
    )
      .firstOrNull(file.name::endsWith)
      ?: return null
    val batchId = file.name.removeSuffix(suffix)
    requireValidShareBatchId(batchId)
    return batchId to suffix
  }

  private fun pendingManifest(batchId: String) = File(queueRoot, "$batchId$PENDING_MANIFEST_SUFFIX")
  private fun readyManifest(batchId: String) = File(queueRoot, "$batchId$READY_MANIFEST_SUFFIX")
  private fun claimedManifest(batchId: String) = File(queueRoot, "$batchId$CLAIMED_MANIFEST_SUFFIX")
  private fun ackedManifest(batchId: String) = File(queueRoot, "$batchId$ACKED_MANIFEST_SUFFIX")
  private fun committedFilesDirectory(batchId: String) = File(filesRoot, batchId)

  private fun exactClaim(batchId: String): File? {
    val claims = boundedChildren(queueRoot)
      .filter { it.name.endsWith(CLAIMED_MANIFEST_SUFFIX) }
    if (claims.size != 1) return null
    val claim = claims.single()
    return claim.takeIf { manifestEntry(it)?.first == batchId }
  }

  /** Recovery may finish a prior `.acked` cleanup before the original JS owner retries. */
  private fun exactBatchIsAbsent(batchId: String): Boolean =
    !pendingManifest(batchId).exists() &&
      !readyManifest(batchId).exists() &&
      !claimedManifest(batchId).exists() &&
      !ackedManifest(batchId).exists() &&
      !pendingFilesDirectory(batchId).exists() &&
      !committedFilesDirectory(batchId).exists()
}

/**
 * Returns the claims earlier processes left behind to ready, once per process, at the first storage
 * use. Callers hold the storage lock, so this runs before the process can claim anything itself. It
 * never fails the storage use that triggers it and is not retried: a claim it could not return
 * behaves as before, replayed first and never expired.
 */
internal class EarlierClaimRelease {
  private var done = false

  fun beforeFirstUse(storage: ShareIntakeStorage) {
    if (done) return
    done = true
    runCatching { storage.releaseAllClaims() }
  }
}

private fun ensureOwnedRoot(root: File) {
  val absolute = root.absoluteFile
  val parent = absolute.parentFile ?: throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
  val expected = File(parent.canonicalFile, absolute.name).absoluteFile
  if (!root.exists() && !root.mkdirs()) throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
  if (!root.isDirectory || root.canonicalFile.path != expected.path) {
    throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
  }
}

private fun ensureOwnedDirectory(root: File, directory: File) {
  requireOwnedChild(root, directory)
  if (!directory.exists() && !directory.mkdir()) {
    throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
  }
  require(directory.isDirectory) { "Share storage directory is unavailable" }
  requireOwnedChild(root, directory)
}

private fun requireOwnedChild(parent: File, candidate: File): File {
  val canonicalParent = parent.canonicalFile
  val canonicalCandidate = candidate.canonicalFile
  val expectedCanonicalCandidate = File(canonicalParent, candidate.name).absoluteFile
  require(
    candidate.absoluteFile.parentFile?.path == parent.absoluteFile.path &&
      canonicalCandidate.parentFile?.path == canonicalParent.path &&
      canonicalCandidate.path == expectedCanonicalCandidate.path,
  ) { "Share storage path is not one exact owned child" }
  return candidate.absoluteFile
}

private fun boundedChildren(directory: File, max: Int = SHARE_CACHE_MAX_ROOT_ENTRIES): Array<File> {
  val children = directory.listFiles()
    ?: throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
  if (children.size > max) throw ShareIntakeException(ShareIntakeFailure.CACHE_QUOTA)
  return children
}
