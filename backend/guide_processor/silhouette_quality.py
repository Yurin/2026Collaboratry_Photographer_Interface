"""Mask cleanup and conservative quality checks for silhouette guides."""

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image


@dataclass
class MaskQualityError(RuntimeError):
    reasons: list[str]

    def __str__(self):
        detail = "、".join(self.reasons)
        return f"シルエットを正しく抽出できませんでした（{detail}）。頭部と主要な人物領域が見えるようにトリミングを調整してください。"


def _odd_kernel_size(image_size, ratio=0.003):
    size = max(3, int(round(min(image_size) * ratio)))
    return size if size % 2 == 1 else size + 1


def postprocess_person_mask(mask):
    """Keep the main subject, close small gaps, fill holes, and smooth the edge."""
    binary = (np.asarray(mask.convert("L")) >= 128).astype(np.uint8)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if component_count <= 1:
        return Image.fromarray(binary * 255, mode="L")

    largest_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    cleaned = (labels == largest_label).astype(np.uint8) * 255
    kernel_size = _odd_kernel_size(mask.size)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)

    # Fill enclosed holes without closing natural gaps between limbs.
    padded = cv2.copyMakeBorder(cleaned, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    flood = padded.copy()
    flood_mask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
    cv2.floodFill(flood, flood_mask, (0, 0), 255)
    filled_holes = cv2.bitwise_not(flood)[1:-1, 1:-1]
    cleaned = cv2.bitwise_or(cleaned, filled_holes)

    blurred = cv2.GaussianBlur(cleaned, (kernel_size, kernel_size), 0)
    _, cleaned = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)
    return Image.fromarray(cleaned, mode="L")


def _box_iou(first, second):
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = max(0, first[2] - first[0]) * max(0, first[3] - first[1])
    second_area = max(0, second[2] - second[0]) * max(0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union > 0 else 0.0


def _mask_box(binary):
    ys, xs = np.nonzero(binary)
    if len(xs) == 0:
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def _visible_points(pose_keypoints, indices, confidence=0.30):
    if not pose_keypoints:
        return []
    return [
        pose_keypoints[index]
        for index in indices
        if index < len(pose_keypoints) and pose_keypoints[index][2] >= confidence
    ]


def classify_pose_frame(pose_keypoints, image_size=None):
    """Classify visible anatomy so hidden hands/legs are not treated as mask failures."""
    if not pose_keypoints:
        return "unknown"

    face = _visible_points(pose_keypoints, (0, 1, 2, 3, 4))
    shoulders = _visible_points(pose_keypoints, (5, 6))
    hips = _visible_points(pose_keypoints, (11, 12))
    knees = _visible_points(pose_keypoints, (13, 14))
    ankles = _visible_points(pose_keypoints, (15, 16))

    if hips and knees:
        if not ankles:
            return "seated"
        shoulder_y = sum(point[1] for point in shoulders) / len(shoulders) if shoulders else None
        hip_y = sum(point[1] for point in hips) / len(hips)
        knee_y = sum(point[1] for point in knees) / len(knees)
        if shoulder_y is not None:
            torso_height = max(1.0, hip_y - shoulder_y)
            if knee_y - hip_y < torso_height * 0.70:
                return "seated"
        return "full_body"

    if face and shoulders:
        return "upper_body"
    return "unknown"


def _point_inside_mask(binary, point, radius):
    height, width = binary.shape
    x, y, _ = point
    px = int(round(x))
    py = int(round(y))
    x1, x2 = max(0, px - radius), min(width, px + radius + 1)
    y1, y2 = max(0, py - radius), min(height, py + radius + 1)
    return x1 < x2 and y1 < y2 and binary[y1:y2, x1:x2].any()


def _head_quality_reasons(processed, actual_box, detection_box, pose_keypoints):
    if actual_box is None or not pose_keypoints:
        return []

    reasons = []
    height, _ = processed.shape
    radius = max(3, int(round(min(processed.shape) * 0.01)))
    face = _visible_points(pose_keypoints, (0, 1, 2, 3, 4), confidence=0.25)
    if len(face) >= 2:
        outside = sum(not _point_inside_mask(processed, point, radius) for point in face)
        if outside / len(face) > 0.40:
            reasons.append("頭部の輪郭と顔の位置が一致していません")

        mask_top = actual_box[1]
        face_top = min(point[1] for point in face)
        face_width = max(point[0] for point in face) - min(point[0] for point in face)
        shoulders = _visible_points(pose_keypoints, (5, 6), confidence=0.25)
        shoulder_width = (
            abs(shoulders[0][0] - shoulders[1][0]) if len(shoulders) == 2 else 0.0
        )
        required_clearance = max(height * 0.012, face_width * 0.30, shoulder_width * 0.08)
        if face_top - mask_top < required_clearance:
            reasons.append("頭頂部の輪郭が不足しています")

    mask_top = actual_box[1]
    mask_width = max(1, actual_box[2] - actual_box[0])
    detection_top = detection_box[1]
    if abs(mask_top - detection_top) <= 2:
        top_row_width = int(processed[mask_top].sum())
        if top_row_width / mask_width >= 0.25:
            reasons.append("頭頂部が人物検出枠で切れています")
    return reasons


def validate_person_mask(
    raw_mask,
    processed_mask,
    detection_box,
    pose_keypoints=None,
    pose_frame=None,
):
    """Raise a user-facing error when a detected mask is unsafe to use as a guide."""
    raw = np.asarray(raw_mask.convert("L")) >= 128
    processed = np.asarray(processed_mask.convert("L")) >= 128
    image_area = processed.size
    foreground = int(processed.sum())
    reasons = []

    if foreground == 0:
        raise MaskQualityError(["人物領域が空です"])

    area_ratio = foreground / image_area
    if area_ratio < 0.015:
        reasons.append("人物領域が小さすぎます")
    elif area_ratio > 0.90:
        reasons.append("人物領域が画面を覆いすぎています")

    component_count, _, stats, _ = cv2.connectedComponentsWithStats(raw.astype(np.uint8), 8)
    if component_count > 1:
        component_areas = stats[1:, cv2.CC_STAT_AREA]
        largest_ratio = float(component_areas.max()) / max(1, int(component_areas.sum()))
        if largest_ratio < 0.85:
            reasons.append("人物領域が複数に分断されています")

    actual_box = _mask_box(processed)
    if actual_box is None or _box_iou(actual_box, detection_box) < 0.50:
        reasons.append("人物枠と輪郭が一致していません")

    if actual_box is not None:
        left, top, right, bottom = actual_box
        height, width = processed.shape
        touches = {
            "left": left <= 1,
            "top": top <= 1,
            "right": right >= width - 1,
            "bottom": bottom >= height - 1,
        }
        opposing_edges = (
            (touches["left"] and touches["right"])
            or (touches["top"] and touches["bottom"])
        )
        touches_horizontal_edge = touches["left"] or touches["right"]
        if touches_horizontal_edge:
            reasons.append("人物がトリミング範囲の左右からはみ出しています")
        elif opposing_edges or sum(touches.values()) >= 3:
            reasons.append("人物がトリミング範囲からはみ出しています")

    reasons.extend(
        _head_quality_reasons(processed, actual_box, detection_box, pose_keypoints)
    )

    if pose_keypoints:
        radius = max(3, int(round(min(processed_mask.size) * 0.01)))
        frame = pose_frame or classify_pose_frame(pose_keypoints, processed_mask.size)
        important_by_frame = {
            "full_body": tuple(range(17)),
            "seated": (0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14),
            "upper_body": (0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12),
            "unknown": (0, 1, 2, 3, 4, 5, 6, 11, 12),
        }
        important_indices = important_by_frame[frame]
        checked = 0
        outside = 0
        for index in important_indices:
            if index >= len(pose_keypoints):
                continue
            point = pose_keypoints[index]
            _, _, confidence = point
            if confidence < 0.35:
                continue
            checked += 1
            if not _point_inside_mask(processed, point, radius):
                outside += 1
        if checked >= 4 and outside / checked > 0.30:
            reasons.append("輪郭と主要関節の位置が一致していません")

    if reasons:
        raise MaskQualityError(reasons)
