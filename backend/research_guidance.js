// Pure experiment policy, reference conversion and longitudinal comparisons.
const PROTOCOL = "progressive-v1";
function referenceFromPose(pose, guideId) {
  const box = pose.boundingBox;
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    throw new Error("reference pose bounding box is invalid");
  }
  const corrected = pose.source === "manual-corrected";
  return {
    schemaVersion: "2.0", guideId, source: pose.source, referenceImageId: pose.referenceImageId,
    referencePoseVersion: pose.versionId, personCount: 1, personBox: box,
    bodyCenter: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    keypoints: pose.keypoints.map((p) => ({ ...p,
      // Human-confirmed enabled points are ground truth, even when auto-confidence was zero.
      confidence: p.isEnabled === false ? 0 : corrected ? 1 : p.confidence,
    })),
    anchors: {}, image: pose.image,
  };
}
function compareGuidance(previous, current) {
  if (!previous || previous.trialId !== current.trialId || previous.guideId !== current.guideId ||
      previous.conditionId !== current.conditionId ||
      JSON.stringify(previous.guidanceConfig) !== JSON.stringify(current.guidanceConfig) ||
      JSON.stringify(previous.guideTransform) !== JSON.stringify(current.guideTransform) ||
      !Number.isSafeInteger(current.captureSequence) || !Number.isSafeInteger(previous.captureSequence) ||
      current.captureSequence <= previous.captureSequence) return [];
  const prior = new Map((previous.guidanceCandidates || []).map((c) => [c.candidateId, c]));
  const selected = new Set((previous.selectedGuidance || []).map((c) => c.candidateId));
  return (current.guidanceCandidates || []).filter((c) => prior.has(c.candidateId)).map((c) => {
    const old = prior.get(c.candidateId);
    const known = Number.isFinite(old.errorMagnitude) && Number.isFinite(c.errorMagnitude);
    return { candidateId: c.candidateId, targetRole: c.targetRole, guidanceCategory: c.category,
      previousAnalysisId: previous.analysisId, analysisId: current.analysisId,
      previousCaptureSequence: previous.captureSequence, captureSequence: current.captureSequence,
      wasSelected: selected.has(c.candidateId), beforeError: old.errorMagnitude, afterError: c.errorMagnitude,
      improvement: known ? old.errorMagnitude - c.errorMagnitude : null,
      improved: known ? c.errorMagnitude < old.errorMagnitude : null,
      status: c.status, resolved: c.isResolved, newlyResolved: !old.isResolved && c.isResolved,
      regressed: known && old.isResolved && !c.isResolved,
      captureIntervalMs: Number.isFinite(current.captureTimestamp) && Number.isFinite(previous.captureTimestamp)
        ? current.captureTimestamp - previous.captureTimestamp : null };
  });
}
module.exports = { PROTOCOL, referenceFromPose, compareGuidance };
