from PIL import Image, ImageDraw, ImageFilter

from image_utils import create_transparent_canvas, centered_rectangle


def create_rectangle_guide(image, person_box=None, **_):
    """Draw a rectangle guide. If person_box is provided, use it; otherwise use centered box."""
    canvas = create_transparent_canvas(image.size)
    draw = ImageDraw.Draw(canvas, "RGBA")

    rect = person_box if person_box is not None else centered_rectangle(image)
    stroke_width = max(8, int(image.width * 0.02))
    draw.rectangle(rect, outline=(255, 255, 255, 220), width=stroke_width)

    return canvas


def create_keypoints_guide(image, person_box=None, **_):
    canvas = create_transparent_canvas(image.size)
    draw = ImageDraw.Draw(canvas, "RGBA")

    rect = person_box if person_box is not None else centered_rectangle(image)
    stroke_width = max(8, int(image.width * 0.02))
    draw.rectangle(rect, outline=(255, 255, 255, 220), width=stroke_width)

    left, top, right, bottom = rect
    center_x = (left + right) / 2
    height = bottom - top

    face_center = (center_x, top + height * 0.15)
    face_radius = int(image.width * 0.04)
    draw.ellipse(
        [
            face_center[0] - face_radius,
            face_center[1] - face_radius,
            face_center[0] + face_radius,
            face_center[1] + face_radius,
        ],
        fill=(255, 255, 255, 220),
        outline=(0, 0, 0, 200),
        width=max(4, int(image.width * 0.008)),
    )

    draw.line(
        [(center_x, top), (center_x, bottom)],
        fill=(255, 255, 255, 200),
        width=max(6, int(image.width * 0.015)),
    )

    draw.line(
        [(left, top + height * 0.85), (right, top + height * 0.85)],
        fill=(255, 255, 255, 200),
        width=max(6, int(image.width * 0.015)),
    )

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
