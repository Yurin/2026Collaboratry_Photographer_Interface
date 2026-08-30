import unittest

from readiness import READINESS_THRESHOLDS, compute_ready
from role_guidance import decompose_guidance


def framing_features(center_x=0.5, center_y=0.5, width=0.4, height=0.6):
    return {
        "bodyCenter": {"x": center_x, "y": center_y},
        "personBox": {
            "x": center_x - width / 2,
            "y": center_y - height / 2,
            "width": width,
            "height": height,
        },
        "keypoints": [],
    }


def alignment_error(center, scale):
    return {
        "centerError": center,
        "scaleError": scale,
        "poseError": 0.0,
        "upperBodyError": 0.0,
        "faceError": 0.0,
    }


class RoleGuidanceThresholdTests(unittest.TestCase):
    def setUp(self):
        self.reference = framing_features()

    def guidance_types(self, observation, errors):
        photographer, _ = decompose_guidance(self.reference, observation, errors)
        return {item["type"] for item in photographer}

    def test_threshold_boundary_is_ready_without_adjustment_instruction(self):
        errors = alignment_error(
            READINESS_THRESHOLDS["center"],
            READINESS_THRESHOLDS["scale"],
        )
        observation = framing_features(center_x=0.56, width=0.49, height=0.7)

        self.assertTrue(compute_ready(errors)["framingReady"])
        self.assertEqual(self.guidance_types(observation, errors), {"framing_ok"})

    def test_center_error_above_ready_threshold_requests_adjustment(self):
        errors = alignment_error(READINESS_THRESHOLDS["center"] + 0.001, 0.0)
        observation = framing_features(center_x=0.561)

        self.assertFalse(compute_ready(errors)["framingReady"])
        self.assertIn("adjust_framing", self.guidance_types(observation, errors))

    def test_scale_error_above_ready_threshold_requests_adjustment(self):
        errors = alignment_error(0.0, READINESS_THRESHOLDS["scale"] + 0.001)
        observation = framing_features(width=0.25, height=0.4)

        self.assertFalse(compute_ready(errors)["framingReady"])
        self.assertIn("adjust_distance", self.guidance_types(observation, errors))


if __name__ == "__main__":
    unittest.main()
