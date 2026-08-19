import unittest

import numpy as np
from PIL import Image

from silhouette_quality import MaskQualityError, postprocess_person_mask, validate_person_mask


def mask_image(array):
    return Image.fromarray(array.astype("uint8") * 255, mode="L")


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


if __name__ == "__main__":
    unittest.main()
