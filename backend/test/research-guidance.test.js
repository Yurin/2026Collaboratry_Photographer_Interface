const assert = require("node:assert/strict");
const { referenceFromPose, compareGuidance } = require("../research_guidance");
const pose = { source: "manual-corrected", versionId: "manual-1", boundingBox: {x: 0, y: 0, width: 1, height: 1}, keypoints: [{name: "leftWrist", x: .2, y: .3, confidence: 0}, {name: "rightWrist", x: .8, y: .3, confidence: 1, isEnabled: false}] };
const reference = referenceFromPose(pose, "g");
assert.equal(reference.keypoints[0].confidence, 1);
assert.equal(reference.keypoints[1].confidence, 0);
assert.equal(reference.referencePoseVersion, "manual-1");
function state(sequence, error) {
  const candidate = {candidateId: "p", targetRole: "subject", category: "pose", errorMagnitude: error, isResolved: error <= .25, status: error <= .25 ? "resolved" : "unresolved"};
  return {trialId: "t", guideId: "g", conditionId: "C", captureSequence: sequence, captureTimestamp: sequence * 1000, analysisId: `a${sequence}`, guidanceCandidates: [candidate], selectedGuidance: [candidate]};
}
const prior = state(1, .5), current = state(2, .1);
assert.equal(compareGuidance(prior, current)[0].improvement, .4);
assert.equal(compareGuidance(prior, current)[0].newlyResolved, true);
assert.equal(compareGuidance(current, state(3, .6))[0].regressed, true);
for (const next of [state(0, .1), state(1, .1), {...current, trialId: "other"}, {...current, guideId: "other"}, {...current, conditionId: "B"}, {...current, guidanceConfig: {changed: true}}]) {
  assert.deepEqual(compareGuidance(prior, next), []);
}
const unknown = state(2, null);
assert.equal(compareGuidance(prior, unknown)[0].improvement, null);
console.log("research guidance policy passed");
