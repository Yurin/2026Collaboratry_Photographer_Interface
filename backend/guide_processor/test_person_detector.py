import unittest

import numpy as np

from person_detector import _matching_person_index, _sam_prompt_points, expand_person_box


class FakeTensor:
    def __init__(self, values):
        self.values = np.asarray(values)

    def cpu(self):
        return self

    def numpy(self):
        return self.values


class FakeBoxes:
    def __init__(self, boxes, classes, confidences):
        self.xyxy = FakeTensor(boxes)
        self.cls = FakeTensor(classes)
        self.conf = FakeTensor(confidences)

    def __len__(self):
        return len(self.conf.values)


class PersonMatchingTests(unittest.TestCase):
    def test_expands_person_box_more_above_the_head(self):
        expanded = expand_person_box((100, 200, 500, 900), (900, 1200))

        self.assertEqual(expanded, (52, 0, 548, 956))

    def test_sam_prompt_uses_visible_torso_points_and_background_negatives(self):
        keypoints = [(0.0, 0.0, 0.0) for _ in range(17)]
        keypoints[0] = (100.0, 80.0, 0.9)
        keypoints[5] = (80.0, 150.0, 0.9)
        keypoints[6] = (140.0, 150.0, 0.9)

        points, labels = _sam_prompt_points((300, 400), keypoints, (20, 30, 180, 390))

        self.assertEqual(labels, [[1, 1, 1, 0, 0]])
        self.assertEqual(points[0][:3], [[100.0, 80.0], [80.0, 150.0], [140.0, 150.0]])
        self.assertEqual(points[0][-1], [291.0, 200.0])

    def test_matches_pose_to_segmentation_box_instead_of_largest_person(self):
        boxes = FakeBoxes(
            boxes=[(0, 0, 400, 800), (500, 100, 700, 700)],
            classes=[0, 0],
            confidences=[0.95, 0.85],
        )

        selected = _matching_person_index(
            boxes,
            target_box=(490, 90, 710, 710),
            conf_threshold=0.25,
        )

        self.assertEqual(selected, 1)

    def test_does_not_attach_unrelated_pose(self):
        boxes = FakeBoxes(
            boxes=[(0, 0, 100, 100)],
            classes=[0],
            confidences=[0.95],
        )

        selected = _matching_person_index(
            boxes,
            target_box=(500, 500, 700, 900),
            conf_threshold=0.25,
        )

        self.assertIsNone(selected)


if __name__ == "__main__":
    unittest.main()
