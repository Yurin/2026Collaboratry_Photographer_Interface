import copy
import unittest
from progressive_guidance import load_config
from role_guidance import analyze


def features():
    coords = {"nose": (.5, .18), "leftShoulder": (.4, .3), "rightShoulder": (.6, .3),
              "leftHip": (.43, .6), "rightHip": (.57, .6), "leftElbow": (.3, .45),
              "rightElbow": (.7, .45), "leftWrist": (.2, .6), "rightWrist": (.8, .6)}
    return {"source": "auto", "personCount": 1, "confidence": 1,
            "bodyCenter": {"x": .5, "y": .5},
            "personBox": {"x": .2, "y": .1, "width": .6, "height": .8},
            "keypoints": [{"name": n, "x": x, "y": y, "confidence": 1} for n, (x, y) in coords.items()]}


class ProgressiveTests(unittest.TestCase):
    def test_conditions_share_candidates_but_select_differently(self):
        r, o = features(), features()
        o["bodyCenter"]["x"] += .2
        o["personBox"]["width"] = .2
        o["keypoints"][-1]["y"] += .2
        o["keypoints"][-2]["y"] += .2
        a, b, c = [analyze(r, o, condition=k) for k in "ABC"]
        self.assertEqual(a["guidanceCandidates"], b["guidanceCandidates"])
        self.assertEqual(b["guidanceCandidates"], c["guidanceCandidates"])
        self.assertEqual(a["selectedGuidance"], [])
        self.assertEqual(len(b["photographerGuidance"]), 2)
        self.assertEqual(len(b["subjectGuidance"]), 2)
        self.assertEqual(len(c["photographerGuidance"]), 1)
        self.assertEqual(len(c["subjectGuidance"]), 1)
        for item in c["selectedGuidance"]:
            self.assertAlmostEqual(item["priorityScore"], item["errorMagnitude"] / item["threshold"] * item["categoryWeight"])

    def test_camera_translation_scale_does_not_issue_pose_instruction(self):
        r, o = features(), features()
        for point in o["keypoints"]:
            point["x"] = .1 + .7 * point["x"]
            point["y"] = .1 + .7 * point["y"]
        o["bodyCenter"] = {"x": .7, "y": .6}
        result = analyze(r, o)
        self.assertTrue(result["ready"]["poseReady"])
        self.assertFalse(result["ready"]["framingReady"])
        self.assertEqual(result["subjectGuidance"], [])

    def test_resolved_candidate_is_replaced_by_next(self):
        r, o = features(), features()
        o["keypoints"][-1]["y"] += .2
        o["keypoints"][-2]["y"] += .1
        first = analyze(r, o)["subjectGuidance"][0]
        self.assertEqual(first["target"], "rightWrist")
        o["keypoints"][-1]["y"] -= .2
        self.assertEqual(analyze(r, o)["subjectGuidance"][0]["target"], "leftWrist")

    def test_threshold_boundary_and_small_residual_are_ready(self):
        r, o = features(), features()
        o["bodyCenter"]["x"] += load_config()["thresholds"]["center"]
        o["keypoints"][-1]["y"] += .3 * load_config()["thresholds"]["pose"]
        result = analyze(r, o)
        self.assertTrue(result["ready"]["captureReady"])
        self.assertEqual(result["selectedGuidance"], [])

    def test_one_large_joint_error_cannot_be_hidden_by_average(self):
        r, o = features(), features()
        o["keypoints"][-1]["y"] += .15
        self.assertFalse(analyze(r, o)["ready"]["poseReady"])

    def test_unknown_and_multiple_people_are_not_ready(self):
        for change in ({"source": "fallback-template"}, {"personCount": 2}, {"keypoints": []}):
            o = {**features(), **change}
            result = analyze(features(), o)
            self.assertFalse(result["ready"]["captureReady"])
            self.assertTrue(any(c["status"] == "unknown" for c in result["guidanceCandidates"]))
            if change.get("source") == "fallback-template":
                self.assertTrue(all("再撮影" in c["message"] and c["direction"] is None for c in result["photographerGuidance"]))

    def test_disabled_reference_joint_is_not_evaluated(self):
        r, o = features(), features()
        r["keypoints"][-1]["isEnabled"] = False
        o["keypoints"][-1]["y"] += .2
        self.assertTrue(analyze(r, o)["ready"]["captureReady"])

    def test_manual_reference_changes_pose_error_and_direction(self):
        r, o = features(), features()
        self.assertTrue(analyze(r, o)["ready"]["captureReady"])
        r["keypoints"][-1]["y"] -= .2
        item = analyze(r, o)["subjectGuidance"][0]
        self.assertEqual(item["targetRole"], "subject")
        self.assertEqual(item["direction"], "up")

    def test_deterministic_order_and_configuration(self):
        r, o = features(), features()
        o["bodyCenter"]["x"] += .2
        o["personBox"]["width"] = .1
        config = copy.deepcopy(load_config())
        config["categoryWeights"]["composition_scale"] = 100
        result = analyze(r, o, config=config)
        self.assertEqual(result, analyze(r, o, config=config))
        self.assertEqual(result["photographerGuidance"][0]["category"], "composition_scale")


if __name__ == "__main__":
    unittest.main()
