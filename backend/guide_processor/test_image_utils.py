import tempfile
import unittest
from pathlib import Path

from PIL import Image

from image_utils import crop_with_normalized_rect, open_image, trim_to_aspect_ratio


class ImageOrientationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "reference.png"
        self.upright = Image.new("RGB", (6, 8))
        self.upright.putdata([
            (x * 40, y * 30, (x + y) * 15)
            for y in range(8) for x in range(6)
        ])

    def test_all_exif_orientations_match_displayed_pixels(self):
        # Inverse transforms encode the same upright image in each EXIF layout.
        encodings = {
            1: None,
            2: Image.Transpose.FLIP_LEFT_RIGHT,
            3: Image.Transpose.ROTATE_180,
            4: Image.Transpose.FLIP_TOP_BOTTOM,
            5: Image.Transpose.TRANSPOSE,
            6: Image.Transpose.ROTATE_90,
            7: Image.Transpose.TRANSVERSE,
            8: Image.Transpose.ROTATE_270,
        }
        for orientation, transform in encodings.items():
            with self.subTest(orientation=orientation):
                stored = self.upright if transform is None else self.upright.transpose(transform)
                exif = Image.Exif()
                exif[274] = orientation
                stored.save(self.path, exif=exif)
                loaded = open_image(self.path)
                self.assertEqual(loaded.size, self.upright.size)
                self.assertEqual(loaded.tobytes(), self.upright.convert("RGBA").tobytes())
                self.assertIn(loaded.getexif().get(274), (None, 1))
                self.assertEqual(trim_to_aspect_ratio(loaded).size, (6, 8))
                crop = crop_with_normalized_rect(loaded, 0.5, 0.25, 0.5, 0.5)
                self.assertEqual(crop.tobytes(), self.upright.crop((3, 2, 6, 6)).convert("RGBA").tobytes())
                loaded.save(self.path)
                self.assertEqual(open_image(self.path).tobytes(), loaded.tobytes())

    def test_image_without_orientation_is_unchanged(self):
        self.upright.save(self.path)
        loaded = open_image(self.path)
        self.assertEqual(loaded.size, self.upright.size)
        self.assertEqual(loaded.tobytes(), self.upright.convert("RGBA").tobytes())

    def test_camera_jpeg_is_rotated_before_loading(self):
        path = self.path.with_suffix(".jpg")
        exif = Image.Exif()
        exif[274] = 6
        self.upright.transpose(Image.Transpose.ROTATE_90).save(path, exif=exif)
        with Image.open(path) as raw:
            expected = raw.transpose(Image.Transpose.ROTATE_270).convert("RGBA")
        loaded = open_image(path)
        self.assertEqual(loaded.size, (6, 8))
        self.assertEqual(loaded.tobytes(), expected.tobytes())


if __name__ == "__main__":
    unittest.main()
