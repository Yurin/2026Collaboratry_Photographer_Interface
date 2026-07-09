#!/usr/bin/env python3
from datetime import datetime, timezone

from PIL import Image

from image_utils import crop_with_normalized_rect, open_image, trim_to_aspect_ratio
from person_detector import detect_person_mask, detect_person_pose_with_count

COCO_JOINT_NAMES = [
    "nose",
    "leftEye",
    "rightEye",
    "leftEar",
    "rightEar",
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
    "leftHip",
    "rightHip",
    "leftKnee",
    "rightKnee",
    "leftAnkle",
    "rightAnkle",
]

TEMPLATE_POINTS = [
    (0.50, 0.13), (0.47, 0.12), (0.53, 0.12), (0.44, 0.14), (0.56, 0.14),
    (0.40, 0.27), (0.60, 0.27), (0.34, 0.42), (0.66, 0.42),
    (0.30, 0.56), (0.70, 0.56), (0.44, 0.53), (0.56, 0.53),
    (0.42, 0.72), (0.58, 0.72), (0.40, 0.92), (0.60, 0.92),
]


def iso_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clamp01(value):
    return max(0.0, min(1.0, float(value)))


def normalize_box(box, width, height):
    left, top, right, bottom = box
    return {
        "x": clamp01(left / width),
        "y": clamp01(top / height),
        "width": clamp01((right - left) / width),
        "height": clamp01((bottom - top) / height),
    }


def body_center(person_box):
    return {
        "x": clamp01(person_box["x"] + person_box["width"] / 2),
        "y": clamp01(person_box["y"] + person_box["height"] / 2),
    }


def keypoint_map(keypoints):
    return {
        point["name"]: point
        for point in keypoints
        if point.get("confidence", 0) > 0
    }


def average_point(points):
    valid = [point for point in points if point]
    if not valid:
        return None
    return {
        "x": clamp01(sum(point["x"] for point in valid) / len(valid)),
        "y": clamp01(sum(point["y"] for point in valid) / len(valid)),
    }


def anchors_from_keypoints(keypoints, fallback_box):
    points = keypoint_map(keypoints)
    face = average_point([
        points.get("nose"),
        points.get("leftEye"),
        points.get("rightEye"),
        points.get("leftEar"),
        points.get("rightEar"),
    ])
    shoulder_center = average_point([
        points.get("leftShoulder"),
        points.get("rightShoulder"),
    ])
    hip_center = average_point([
        points.get("leftHip"),
        points.get("rightHip"),
    ])

    return {
        "face": face or {
            "x": clamp01(fallback_box["x"] + fallback_box["width"] / 2),
            "y": clamp01(fallback_box["y"] + fallback_box["height"] * 0.18),
        },
        "shoulderCenter": shoulder_center or {
            "x": clamp01(fallback_box["x"] + fallback_box["width"] / 2),
            "y": clamp01(fallback_box["y"] + fallback_box["height"] * 0.30),
        },
        "hipCenter": hip_center or {
            "x": clamp01(fallback_box["x"] + fallback_box["width"] / 2),
            "y": clamp01(fallback_box["y"] + fallback_box["height"] * 0.60),
        },
    }


def centered_crop_rect(width, height, target_ratio=(3, 4)):
    target_aspect = target_ratio[0] / target_ratio[1]
    current_aspect = width / height
    if current_aspect > target_aspect:
        crop_width = height * target_aspect
        x = (width - crop_width) / 2 / width
        return {"x": x, "y": 0.0, "width": crop_width / width, "height": 1.0}
    if current_aspect < target_aspect:
        crop_height = width / target_aspect
        y = (height - crop_height) / 2 / height
        return {"x": 0.0, "y": y, "width": 1.0, "height": crop_height / height}
    return {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}


def prepare_3x4_image(input_path, width, height, crop_rect=None):
    source = open_image(input_path)
    if crop_rect:
        cropped = crop_with_normalized_rect(
            source,
            crop_rect["x"],
            crop_rect["y"],
            crop_rect["width"],
            crop_rect["height"],
        )
        applied_crop = {
            "x": clamp01(crop_rect["x"]),
            "y": clamp01(crop_rect["y"]),
            "width": clamp01(crop_rect["width"]),
            "height": clamp01(crop_rect["height"]),
        }
    else:
        applied_crop = centered_crop_rect(source.width, source.height)
        cropped = trim_to_aspect_ratio(source, target_ratio=(3, 4))
    return cropped.resize((width, height), resample=Image.LANCZOS), applied_crop


def fallback_keypoints():
    return [
        {
            "name": name,
            "x": x,
            "y": y,
            "confidence": 0.0,
        }
        for name, (x, y) in zip(COCO_JOINT_NAMES, TEMPLATE_POINTS)
    ]


def extract_normalized_person_features(image):
    warnings = []
    source = "auto"
    person_count = 0
    person_box = {"x": 0.18, "y": 0.08, "width": 0.64, "height": 0.84}
    keypoints = fallback_keypoints()
    confidence = 0.0

    try:
        detected_box, detected_keypoints, person_count = detect_person_pose_with_count(image)
        if detected_box is not None and detected_keypoints:
            person_box = normalize_box(detected_box, image.width, image.height)
            keypoints = [
                {
                    "name": name,
                    "x": clamp01(x / image.width),
                    "y": clamp01(y / image.height),
                    "confidence": clamp01(score),
                }
                for name, (x, y, score) in zip(COCO_JOINT_NAMES, detected_keypoints)
            ]
            confidence = max((point["confidence"] for point in keypoints), default=0.0)
            if person_count != 1:
                warnings.append(f"人物を{person_count}人検出しました。")
        else:
            source = "fallback-template"
            warnings.append("人物姿勢を検出できなかったため、テンプレート特徴を使用しました。")
    except Exception as error:
        source = "fallback-template"
        warnings.append(f"姿勢推定エラー: {error}")

    silhouette_available = False
    try:
        mask, mask_box = detect_person_mask(image)
        if mask is not None:
            silhouette_available = True
        if source != "auto" and mask_box is not None:
            person_box = normalize_box(mask_box, image.width, image.height)
    except Exception as error:
        warnings.append(f"シルエット抽出エラー: {error}")

    return {
        "source": source,
        "personCount": person_count,
        "personBox": person_box,
        "bodyCenter": body_center(person_box),
        "keypoints": keypoints,
        "anchors": anchors_from_keypoints(keypoints, person_box),
        "silhouette": {
            "available": silhouette_available,
        },
        "confidence": confidence,
        "warnings": warnings,
    }
