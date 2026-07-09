#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

from readiness import compute_ready

UPPER_BODY_KEYS = {
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
}
FACE_KEYS = {"nose", "leftEye", "rightEye", "leftEar", "rightEar"}


def parse_args():
    parser = argparse.ArgumentParser(description="Compute role-aware guidance from reference/live features.")
    parser.add_argument("--reference", required=True)
    parser.add_argument("--observation", required=True)
    parser.add_argument("--output")
    parser.add_argument("--guide-transform")
    return parser.parse_args()


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def clamp(value, low, high):
    return max(low, min(high, value))


def distance(a, b):
    return math.hypot(float(a["x"]) - float(b["x"]), float(a["y"]) - float(b["y"]))


def keypoints_by_name(points):
    return {
        point["name"]: point
        for point in points or []
        if point.get("confidence", 0) >= 0.15
    }


def transformed_point(point, transform):
    scale = float(transform.get("scale", 1.0))
    offset_x = float(transform.get("offsetX", transform.get("translationX", 0.0)))
    offset_y = float(transform.get("offsetY", transform.get("translationY", 0.0)))
    return {
        "x": clamp(0.5 + (float(point["x"]) - 0.5) * scale + offset_x, 0.0, 1.0),
        "y": clamp(0.5 + (float(point["y"]) - 0.5) * scale + offset_y, 0.0, 1.0),
    }


def transformed_box(box, transform):
    center = transformed_point({
        "x": float(box["x"]) + float(box["width"]) / 2,
        "y": float(box["y"]) + float(box["height"]) / 2,
    }, transform)
    scale = float(transform.get("scale", 1.0))
    width = clamp(float(box["width"]) * scale, 0.0, 1.0)
    height = clamp(float(box["height"]) * scale, 0.0, 1.0)
    return {
        "x": clamp(center["x"] - width / 2, 0.0, 1.0),
        "y": clamp(center["y"] - height / 2, 0.0, 1.0),
        "width": width,
        "height": height,
    }


def transformed_reference(reference, transform):
    keypoints = []
    for point in reference.get("keypoints", []):
        moved = transformed_point(point, transform)
        keypoints.append({**point, **moved})
    person_box = transformed_box(reference["personBox"], transform)
    body_center = transformed_point(reference["bodyCenter"], transform)
    anchors = {
        name: transformed_point(point, transform)
        for name, point in (reference.get("anchors") or {}).items()
        if point
    }
    return {
        **reference,
        "personBox": person_box,
        "bodyCenter": body_center,
        "keypoints": keypoints,
        "anchors": anchors,
    }


def average_keypoint_error(reference, observation, names=None):
    reference_points = keypoints_by_name(reference.get("keypoints"))
    observation_points = keypoints_by_name(observation.get("keypoints"))
    distances = []
    for name, reference_point in reference_points.items():
        if names is not None and name not in names:
            continue
        observation_point = observation_points.get(name)
        if observation_point:
            distances.append(distance(reference_point, observation_point))
    if not distances:
        return None
    return sum(distances) / len(distances)


def compute_alignment_error(reference, observation):
    reference_box = reference["personBox"]
    observation_box = observation["personBox"]
    center_error = distance(reference["bodyCenter"], observation["bodyCenter"])
    reference_size = math.sqrt(max(0.0, reference_box["width"] * reference_box["height"]))
    observation_size = math.sqrt(max(0.0, observation_box["width"] * observation_box["height"]))
    scale_error = abs(reference_size - observation_size)
    pose_error = average_keypoint_error(reference, observation)
    upper_body_error = average_keypoint_error(reference, observation, UPPER_BODY_KEYS)
    face_error = average_keypoint_error(reference, observation, FACE_KEYS)

    weighted = [
        (center_error, 0.25),
        (scale_error, 0.20),
        (pose_error if pose_error is not None else 0.25, 0.30),
        (upper_body_error if upper_body_error is not None else 0.20, 0.15),
        (face_error if face_error is not None else 0.15, 0.10),
    ]
    total_weight = sum(weight for _, weight in weighted)
    total_error = sum(value * weight for value, weight in weighted) / total_weight
    return {
        "centerError": center_error,
        "scaleError": scale_error,
        "poseError": pose_error,
        "upperBodyError": upper_body_error,
        "faceError": face_error,
        "silhouetteError": None,
        "totalError": total_error,
    }


def severity(value, medium=0.06, high=0.12):
    if value is None:
        return "low"
    if value >= high:
        return "high"
    if value >= medium:
        return "medium"
    return "low"


def guidance_item(kind, message, value, medium=0.06, high=0.12):
    return {
        "type": kind,
        "message": message,
        "severity": severity(value, medium=medium, high=high),
        "value": value,
    }


def decompose_guidance(reference, observation, alignment_error):
    photographer = []
    subject = []
    dx = observation["bodyCenter"]["x"] - reference["bodyCenter"]["x"]
    dy = observation["bodyCenter"]["y"] - reference["bodyCenter"]["y"]
    center_error = alignment_error["centerError"]
    scale_error = alignment_error["scaleError"]

    if center_error > 0.035:
        if abs(dx) >= abs(dy):
            direction = "左" if dx > 0 else "右"
            message = f"被写体をもう少し{direction}に合わせてください"
        else:
            direction = "上" if dy > 0 else "下"
            message = f"被写体をもう少し{direction}に合わせてください"
        photographer.append(guidance_item("adjust_framing", message, center_error))

    reference_size = math.sqrt(reference["personBox"]["width"] * reference["personBox"]["height"])
    observation_size = math.sqrt(observation["personBox"]["width"] * observation["personBox"]["height"])
    if scale_error > 0.05:
        if observation_size < reference_size:
            message = "少し近づいてください"
        else:
            message = "少し離れてください"
        photographer.append(guidance_item("adjust_distance", message, scale_error, medium=0.05, high=0.10))

    pose_error = alignment_error.get("poseError")
    if pose_error is None:
        subject.append({
            "type": "pose_unknown",
            "message": "ポーズ検出結果を確認できませんでした",
            "severity": "medium",
            "value": None,
        })
    elif pose_error > 0.08:
        subject.append(guidance_item("adjust_pose", "ポーズを参照写真に近づけてください", pose_error, medium=0.08, high=0.16))

    upper_body_error = alignment_error.get("upperBodyError")
    if upper_body_error is not None and upper_body_error > 0.08:
        subject.append(guidance_item("adjust_upper_body", "肩や腕の位置を調整してください", upper_body_error, medium=0.08, high=0.16))

    face_error = alignment_error.get("faceError")
    if face_error is not None and face_error > 0.06:
        subject.append(guidance_item("adjust_face", "顔の向きを調整してください", face_error, medium=0.06, high=0.12))

    if not photographer:
        photographer.append(guidance_item("framing_ok", "構図は大きくずれていません", center_error, medium=0.06, high=0.12))
    if not subject:
        subject.append(guidance_item("pose_ok", "ポーズは大きくずれていません", pose_error or 0.0, medium=0.08, high=0.16))

    return photographer, subject


def analyze(reference, observation, guide_transform=None):
    transform = guide_transform or {}
    transformed = transformed_reference(reference, transform)
    alignment_error = compute_alignment_error(transformed, observation)
    photographer, subject = decompose_guidance(transformed, observation, alignment_error)
    return {
        "schemaVersion": "1.0",
        "alignmentError": alignment_error,
        "photographerGuidance": photographer,
        "subjectGuidance": subject,
        "ready": compute_ready(alignment_error),
        "appliedGuideTransform": transform,
    }


def main():
    args = parse_args()
    reference = load_json(args.reference)
    observation = load_json(args.observation)
    guide_transform = json.loads(args.guide_transform) if args.guide_transform else {}
    result = analyze(reference, observation, guide_transform)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
