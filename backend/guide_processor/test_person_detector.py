import unittest

import numpy as np

from person_detector import _matching_person_index


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
