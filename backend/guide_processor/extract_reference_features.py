#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from feature_utils import extract_normalized_person_features, iso_now, prepare_3x4_image


def parse_args():
    parser = argparse.ArgumentParser(description="Extract structured ReferenceGuide JSON.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--guide-id", required=True)
    parser.add_argument("--reference-photo-id", required=True)
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--height", type=int, default=1200)
    parser.add_argument("--crop-x", type=float)
    parser.add_argument("--crop-y", type=float)
    parser.add_argument("--crop-width", type=float)
    parser.add_argument("--crop-height", type=float)
    return parser.parse_args()


def crop_rect_from_args(args):
    if (
        args.crop_x is None
        or args.crop_y is None
        or args.crop_width is None
        or args.crop_height is None
    ):
        return None
    return {
        "x": args.crop_x,
        "y": args.crop_y,
        "width": args.crop_width,
        "height": args.crop_height,
    }


def main():
    args = parse_args()
    image, applied_crop = prepare_3x4_image(
        args.input,
        args.width,
        args.height,
        crop_rect=crop_rect_from_args(args),
    )
    features = extract_normalized_person_features(image)

    reference_guide = {
        "schemaVersion": "1.0",
        "kind": "ReferenceGuide",
        "guideId": args.guide_id,
        "referencePhotoId": args.reference_photo_id,
        "cropAspect": "3:4",
        "cropRect": applied_crop,
        "personBox": features["personBox"],
        "bodyCenter": features["bodyCenter"],
        "keypoints": features["keypoints"],
        "silhouette": features["silhouette"],
        "anchors": features["anchors"],
        "source": features["source"],
        "personCount": features["personCount"],
        "confidence": features["confidence"],
        "warnings": features["warnings"],
        "canvas": {
            "width": args.width,
            "height": args.height,
            "aspectRatio": "3:4",
        },
        "createdAt": iso_now(),
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(reference_guide, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
