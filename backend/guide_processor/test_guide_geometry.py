import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

import generate_guide
from guide_types import GuideDetectionError, create_keypoints_guide, create_rectangle_guide, eye_marker


class GuideGeometryTests(unittest.TestCase):
    def setUp(self):
        self.image = Image.new('RGB', (300, 400))
        self.points = [(0, 0, 0)] * 17
        self.points[1:3] = [(180, 100, 0.95), (220, 110, 0.9)]

    def test_eyes_define_center_independent_of_body_crop(self):
        for bottom in (200, 300, 400):
            with self.subTest(bottom=bottom):
                center, radius = eye_marker(self.image, self.points, (20, 30, 280, bottom))
                self.assertEqual(center, (200, 105))
                self.assertGreater(radius, 20)

    def test_missing_low_confidence_and_outside_eyes_are_rejected(self):
        for point in ((0, 0, 0), (220, 110, 0.2), (310, 110, 0.9), (float('nan'), 110, 0.9)):
            with self.subTest(point=point):
                self.points[2] = point
                with self.assertRaises(GuideDetectionError):
                    create_keypoints_guide(self.image, (20, 30, 280, 400), self.points)

    def test_no_fabricated_rectangle_on_detection_failure(self):
        with self.assertRaises(GuideDetectionError):
            create_rectangle_guide(self.image)

    def test_rectangle_at_image_edge_remains_visible(self):
        guide = create_rectangle_guide(self.image, (-10, -5, 300, 400))
        self.assertGreater(guide.getpixel((299, 200))[3], 0)
        self.assertGreater(guide.getpixel((150, 399))[3], 0)

    def test_circle_is_unfilled_and_fixed_body_lines_are_removed(self):
        guide = create_keypoints_guide(self.image, (20, 30, 280, 399), self.points)
        self.assertEqual(guide.getpixel((200, 105))[3], 0)
        self.assertEqual(guide.getpixel((150, 250))[3], 0)
        self.assertGreater(guide.getpixel((200, 72))[3], 0)

    def test_generation_uses_visible_mask_and_matching_pose(self):
        mask = Image.new('L', self.image.size)
        ImageDraw.Draw(mask).rectangle((80, 40, 260, 399), fill=255)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'reference.png'
            output = Path(directory) / 'guide.png'
            self.image.save(source)
            args = ['generate_guide', '--input', str(source), '--output', str(output),
                    '--type', 'keypoints', '--width', '300', '--height', '400']
            with patch('sys.argv', args), \
                 patch.object(generate_guide, 'detect_person_bbox', return_value=None), \
                 patch.object(generate_guide, 'detect_person_mask', return_value=(mask, (0, 0, 300, 400))), \
                 patch.object(generate_guide, 'detect_person_keypoints', return_value=self.points) as pose:
                generate_guide.main()
            box = pose.call_args.kwargs['target_box']
            self.assertEqual(box, (80, 40, 261, 400))
            with Image.open(output) as guide:
                self.assertGreater(guide.getpixel((80, 200))[3], 0)
                self.assertEqual(guide.getpixel((20, 200))[3], 0)


if __name__ == '__main__':
    unittest.main()
