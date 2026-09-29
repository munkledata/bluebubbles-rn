/**
 * FaceTime link creation, call start, answer, and leave share one foreground one-shot lane. A
 * second mutation is rejected instead of waiting behind an attempt whose external outcome may
 * become ambiguous.
 */
let faceTimeMutationActive = false;

export function claimFaceTimeMutationLane(): (() => void) | null {
  if (faceTimeMutationActive) return null;
  faceTimeMutationActive = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    faceTimeMutationActive = false;
  };
}
