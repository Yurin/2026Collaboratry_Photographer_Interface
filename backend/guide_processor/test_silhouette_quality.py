import unittest

import numpy as np
from PIL import Image

from silhouette_quality import (
    MaskQualityError,
    classify_pose_frame,
    postprocess_person_mask,
    validate_person_mask,
)


def mask_image(array):
    return Image.fromarray(array.astype("uint8") * 255, mode="L")


def keypoints_with(**points):
    result = [(0.0, 0.0, 0.0) for _ in range(17)]
    for index, point in points.items():
        result[int(index)] = (*point, 0.95)
    return result


class SilhouetteQualityTests(unittest.TestCase):
    def test_postprocess_keeps_main_component_and_fills_hole(self):
        raw = np.zeros((200, 150), dtype=np.uint8)
        raw[30:180, 45:105] = 1
        raw[80:90, 70:80] = 0
        raw[10:14, 10:14] = 1

        processed = np.asarray(postprocess_person_mask(mask_image(raw))) >= 128

        self.assertTrue(processed[85, 75])
        self.assertFalse(processed[12, 12])

    def test_accepts_consistent_person_mask(self):
        raw = np.zeros((200, 150), dtype=np.uint8)
        raw[25:185, 40:110] = 1
        image = mask_image(raw)

        validate_person_mask(image, image, (38, 23, 112, 187))

    def test_rejects_fragmented_mask(self):
        raw = np.zeros((200, 150), dtype=np.uint8)
        raw[25:105, 15:65] = 1
        raw[110:190, 85:135] = 1
        processed = postprocess_person_mask(mask_image(raw))

        with self.assertRaises(MaskQualityError):
            validate_person_mask(mask_image(raw), processed, (10, 20, 140, 195))

    def test_rejects_mask_touching_either_horizontal_edge(self):
        cases = (
            (slice(25, 185), slice(0, 70), (0, 23, 72, 187)),
            (slice(25, 185), slice(80, 150), (78, 23, 150, 187)),
        )

        for rows, columns, detection_box in cases:
            with self.subTest(columns=columns):
                raw = np.zeros((200, 150), dtype=np.uint8)
                raw[rows, columns] = 1
                image = mask_image(raw)

                with self.assertRaisesRegex(
                    MaskQualityError,
                    "左右からはみ出しています",
                ):
                    validate_person_mask(image, image, detection_box)

    def test_accepts_mask_touching_only_bottom_edge(self):
        raw = np.zeros((200, 150), dtype=np.uint8)
        raw[40:200, 40:110] = 1
        image = mask_image(raw)

        validate_person_mask(image, image, (38, 38, 112, 200))

    def test_classifies_upper_body_seated_and_full_body(self):
        common = {
            "0": (75, 40),
            "5": (55, 70),
            "6": (95, 70),
            "11": (60, 125),
            "12": (90, 125),
        }
        upper_body = keypoints_with(**common)
        seated = keypoints_with(**common, **{"13": (55, 160), "14": (95, 160)})
        full_body = keypoints_with(
            **common,
            **{
                "13": (55, 175),
                "14": (95, 175),
                "15": (55, 220),
                "16": (95, 220),
            },
        )

        self.assertEqual(classify_pose_frame(upper_body), "upper_body")
        self.assertEqual(classify_pose_frame(seated), "seated")
        self.assertEqual(classify_pose_frame(full_body), "full_body")

    def test_rejects_head_clipped_at_detection_box(self):
        raw = np.zeros((200, 150), dtype=np.uint8)
        raw[40:190, 35:115] = 1
        image = mask_image(raw)
        pose = keypoints_with(
            **{
                "0": (75, 48),
                "1": (68, 45),
                "2": (82, 45),
                "5": (55, 80),
                "6": (95, 80),
                "11": (60, 140),
                "12": (90, 140),
            }
        )

        with self.assertRaisesRegex(MaskQualityError, "頭頂部"):
            validate_person_mask(image, image, (35, 40, 115, 190), pose)

    def test_accepts_upper_body_when_hands_and_legs_are_hidden(self):
        raw = np.zeros((200, 150), dtype=np.uint8)
        import cv2

        cv2.ellipse(raw, (75, 42), (23, 22), 0, 0, 360, 1, -1)
        raw[58:200, 38:112] = 1
        image = mask_image(raw)
        pose = keypoints_with(
            **{
                "0": (75, 43),
                "1": (68, 39),
                "2": (82, 39),
                "3": (60, 42),
                "4": (90, 42),
                "5": (55, 75),
                "6": (95, 75),
                "11": (60, 145),
                "12": (90, 145),
            }
        )

        validate_person_mask(
            image,
            image,
            (50, 18, 114, 200),
            pose_keypoints=pose,
            pose_frame="upper_body",
        )


if __name__ == "__main__":
    unittest.main()
