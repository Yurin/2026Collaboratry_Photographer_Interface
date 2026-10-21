import math

from PIL import Image, ImageDraw, ImageFilter

from image_utils import create_transparent_canvas, centered_rectangle


class GuideDetectionError(ValueError):
    """A guide cannot be placed reliably on the reference image."""


def guide_rectangle(image, person_box):
    if person_box is None:
        raise GuideDetectionError("人物の範囲を検出できませんでした。人物が見える写真を選んでください。")
    left, top, right, bottom = person_box
    rect = (max(0, left), max(0, top), min(image.width - 1, right), min(image.height - 1, bottom))
    if not all(math.isfinite(value) for value in person_box) or rect[2] <= rect[0] or rect[3] <= rect[1]:
        raise GuideDetectionError("人物の範囲を正しく検出できませんでした。")
    return rect


def eye_marker(image, pose_keypoints, person_box):
    rect = guide_rectangle(image, person_box)
    eyes = []
    for index in (1, 2):  # COCO left/right eye
        if pose_keypoints is None or len(pose_keypoints) <= index:
            continue
        x, y, confidence = pose_keypoints[index]
        if (all(math.isfinite(value) for value in (x, y, confidence))
                and confidence >= 0.5 and x > 0 and y > 0
                and rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]):
            eyes.append((x, y))
    if len(eyes) != 2:
        raise GuideDetectionError("両目の位置を検出できませんでした。目が見える写真やトリミング範囲で再試行してください。")
    center = ((eyes[0][0] + eyes[1][0]) / 2, (eyes[0][1] + eyes[1][1]) / 2)
    distance = math.dist(*eyes)
    radius = max(image.width * 0.015, min(distance * 0.8, image.width * 0.12))
    return center, radius


def create_rectangle_guide(image, person_box=None, **_):
    canvas = create_transparent_canvas(image.size)
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rectangle(guide_rectangle(image, person_box), outline=(255, 255, 255, 220),
                   width=max(8, int(image.width * 0.02)))
    return canvas


def create_keypoints_guide(image, person_box=None, pose_keypoints=None, **_):
    canvas = create_rectangle_guide(image, person_box)
    draw = ImageDraw.Draw(canvas, "RGBA")
    (x, y), radius = eye_marker(image, pose_keypoints, person_box)
    # An unfilled circle keeps the eyes visible beneath the overlay.
    draw.ellipse((x - radius, y - radius, x + radius, y + radius),
                 outline=(255, 255, 255, 240), width=max(4, int(image.width * 0.008)))
    return canvas


def create_silhouette_guide(image, person_box=None, person_mask=None, pose_keypoints=None):
    if person_mask is not None:
        return create_segmented_pose_guide(image, person_mask, pose_keypoints)

    return create_template_silhouette_guide(image, person_box=person_box)


def create_segmented_pose_guide(image, person_mask, pose_keypoints=None):
    canvas = create_transparent_canvas(image.size)

    mask = person_mask.convert("L")
    fill = Image.new("RGBA", image.size, (255, 255, 255, 95))
    canvas.alpha_composite(Image.composite(fill, create_transparent_canvas(image.size), mask))

    edge_mask = mask.filter(ImageFilter.FIND_EDGES)
    edge_mask = edge_mask.point(lambda value: 255 if value > 16 else 0)
    edge_mask = edge_mask.filter(ImageFilter.MaxFilter(max(3, int(image.width * 0.008) | 1)))
    outline = Image.new("RGBA", image.size, (255, 255, 255, 235))
    canvas.alpha_composite(Image.composite(outline, create_transparent_canvas(image.size), edge_mask))

    if pose_keypoints:
        draw_pose_skeleton(canvas, pose_keypoints)

    return canvas


def draw_pose_skeleton(canvas, keypoints, conf_threshold=0.25):
    draw = ImageDraw.Draw(canvas, "RGBA")
    line_width = max(5, int(canvas.width * 0.012))
    point_radius = max(5, int(canvas.width * 0.012))

    # COCO keypoint pairs: nose/eyes/ears/shoulders/elbows/wrists/hips/knees/ankles.
    skeleton_pairs = [
        (5, 6),
        (5, 7),
        (7, 9),
        (6, 8),
        (8, 10),
        (5, 11),
        (6, 12),
        (11, 12),
        (11, 13),
        (13, 15),
        (12, 14),
        (14, 16),
        (0, 5),
        (0, 6),
    ]

    def valid(index):
        if index >= len(keypoints):
            return False
        x, y, confidence = keypoints[index]
        return confidence >= conf_threshold and x > 0 and y > 0

    for start, end in skeleton_pairs:
        if not valid(start) or not valid(end):
            continue
        x1, y1, _ = keypoints[start]
        x2, y2, _ = keypoints[end]
        draw.line(
            [(x1, y1), (x2, y2)],
            fill=(56, 189, 248, 235),
            width=line_width,
        )

    for index, (x, y, confidence) in enumerate(keypoints):
        if confidence < conf_threshold or x <= 0 or y <= 0:
            continue
        radius = point_radius * (1.25 if index in (5, 6, 11, 12) else 1.0)
        draw.ellipse(
            [x - radius, y - radius, x + radius, y + radius],
            fill=(255, 255, 255, 235),
            outline=(14, 165, 233, 235),
            width=max(2, line_width // 3),
        )


def create_template_silhouette_guide(image, person_box=None):
    canvas = create_transparent_canvas(image.size)
    draw = ImageDraw.Draw(canvas, "RGBA")

    rect = person_box if person_box is not None else centered_rectangle(image)
    left, top, right, bottom = rect
    width = right - left
    height = bottom - top
    center_x = (left + right) / 2

    fill_color = (255, 255, 255, 170)
    line_color = (255, 255, 255, 220)
    outline_width = max(8, int(image.width * 0.02))

    head_radius = int(width * 0.12)
    head_center = (center_x, top + head_radius)
    draw.ellipse(
        [
            head_center[0] - head_radius,
            head_center[1] - head_radius,
            head_center[0] + head_radius,
            head_center[1] + head_radius,
        ],
        fill=fill_color,
    )

    torso_top = head_center[1] + head_radius * 0.6
    torso_bottom = bottom - int(height * 0.18)
    torso_width = width * 0.34
    torso_left = center_x - torso_width / 2
    torso_right = center_x + torso_width / 2
    draw.rectangle(
        [
            torso_left,
            torso_top,
            torso_right,
            torso_bottom,
        ],
        fill=fill_color,
    )

    arm_top = torso_top + int(height * 0.08)
    arm_length = width * 0.28
    draw.polygon(
        [
            (torso_left, arm_top),
            (torso_left - arm_length, arm_top + int(height * 0.08)),
            (torso_left - arm_length + int(width * 0.05), arm_top + int(height * 0.12)),
            (torso_left, arm_top + int(height * 0.1)),
        ],
        fill=fill_color,
    )
    draw.polygon(
        [
            (torso_right, arm_top),
            (torso_right + arm_length, arm_top + int(height * 0.08)),
            (torso_right + arm_length - int(width * 0.05), arm_top + int(height * 0.12)),
            (torso_right, arm_top + int(height * 0.1)),
        ],
        fill=fill_color,
    )

    leg_top = torso_bottom
    left_leg = [
        (torso_left + int(width * 0.08), leg_top),
        (torso_left + int(width * 0.08), bottom),
        (center_x - int(width * 0.08), bottom),
        (center_x - int(width * 0.08), leg_top),
    ]
    right_leg = [
        (torso_right - int(width * 0.08), leg_top),
        (torso_right - int(width * 0.08), bottom),
        (center_x + int(width * 0.08), bottom),
        (center_x + int(width * 0.08), leg_top),
    ]
    draw.polygon(left_leg, fill=fill_color)
    draw.polygon(right_leg, fill=fill_color)

    draw.ellipse(
        [
            head_center[0] - head_radius,
            head_center[1] - head_radius,
            head_center[0] + head_radius,
            head_center[1] + head_radius,
        ],
        outline=line_color,
        width=outline_width,
    )
    draw.rectangle([
        torso_left,
        torso_top,
        torso_right,
        torso_bottom,
    ], outline=line_color, width=outline_width)
    draw.line([left_leg[0], left_leg[-1]], fill=line_color, width=outline_width)
    draw.line([right_leg[0], right_leg[-1]], fill=line_color, width=outline_width)

    return canvas
