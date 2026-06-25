#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image

from image_utils import open_image, trim_to_aspect_ratio
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


def parse_args():
    parser = argparse.ArgumentParser(description="Extract editable reference pose data.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--image-output", required=True)
    parser.add_argument("--mask-output")
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--height", type=int, default=1200)
    return parser.parse_args()


def normalize_box(box, width, height):
    left, top, right, bottom = box
    return {
        "x": max(0.0, min(1.0, left / width)),
        "y": max(0.0, min(1.0, top / height)),
        "width": max(0.0, min(1.0, (right - left) / width)),
        "height": max(0.0, min(1.0, (bottom - top) / height)),
    }


def template_result():
    return {
        "source": "fallback-template",
        "personCount": 0,
        "boundingBox": {"x": 0.18, "y": 0.08, "width": 0.64, "height": 0.84},
        "keypoints": [
            {
                "name": name,
                "x": x,
                "y": y,
                "confidence": 0.0,
                "isEnabled": True,
            }
            for name, (x, y) in zip(COCO_JOINT_NAMES, TEMPLATE_POINTS)
        ],
        "warnings": ["姿勢推定を利用できなかったため、手動補正用の初期骨格を表示しています。"],
    }


def main():
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    image_output_path = Path(args.image_output)
    mask_output_path = Path(args.mask_output) if args.mask_output else None

    source = open_image(input_path)
    cropped = trim_to_aspect_ratio(source, target_ratio=(3, 4))
    image = cropped.resize((args.width, args.height), resample=Image.LANCZOS)
    image_output_path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(image_output_path, format="JPEG", quality=92)

    result = template_result()
    try:
        person_box, keypoints, person_count = detect_person_pose_with_count(image)
        if person_box is not None and keypoints:
            result = {
                "source": "auto",
                "personCount": person_count,
                "boundingBox": normalize_box(person_box, image.width, image.height),
                "keypoints": [
                    {
                        "name": name,
                        "x": max(0.0, min(1.0, x / image.width)),
                        "y": max(0.0, min(1.0, y / image.height)),
                        "confidence": max(0.0, min(1.0, confidence)),
                        "isEnabled": confidence >= 0.15,
                    }
                    for name, (x, y, confidence) in zip(COCO_JOINT_NAMES, keypoints)
                ],
                "warnings": (
                    []
                    if person_count == 1
                    else [f"人物を{person_count}人検出しました。対象人物の関節点を確認してください。"]
                ),
            }
    except Exception as error:
        result["warnings"].append(f"姿勢推定エラー: {error}")

    result["silhouetteAvailable"] = False
    if mask_output_path:
        try:
            mask, mask_box = detect_person_mask(image)
            if mask is not None:
                mask_output_path.parent.mkdir(parents=True, exist_ok=True)
                mask.save(mask_output_path, format="PNG")
                result["silhouetteAvailable"] = True
                if result["source"] != "auto" and mask_box is not None:
                    result["boundingBox"] = normalize_box(mask_box, image.width, image.height)
        except Exception as error:
            result["warnings"].append(f"シルエット抽出エラー: {error}")

    result["canvas"] = {
        "width": args.width,
        "height": args.height,
        "aspectRatio": "3:4",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
