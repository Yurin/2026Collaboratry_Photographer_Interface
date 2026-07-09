#!/usr/bin/env python3
import argparse
import json
import time
from pathlib import Path

from feature_utils import extract_normalized_person_features, prepare_3x4_image


def parse_args():
    parser = argparse.ArgumentParser(description="Extract structured LiveObservation JSON.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--trial-id")
    parser.add_argument("--source", choices=["liveFrame", "capturedPhoto"], default="capturedPhoto")
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--height", type=int, default=1200)
    return parser.parse_args()


def main():
    args = parse_args()
    image, _ = prepare_3x4_image(args.input, args.width, args.height)
    features = extract_normalized_person_features(image)
    observation = {
        "schemaVersion": "1.0",
        "kind": "LiveObservation",
        "timestamp": time.time(),
        "sessionId": args.session_id,
        "trialId": args.trial_id or None,
        "source": args.source,
        "personBox": features["personBox"],
        "bodyCenter": features["bodyCenter"],
        "keypoints": features["keypoints"],
        "anchors": features["anchors"],
        "confidence": features["confidence"],
        "personCount": features["personCount"],
        "warnings": features["warnings"],
        "canvas": {
            "width": args.width,
            "height": args.height,
            "aspectRatio": "3:4",
        },
    }

    text = json.dumps(observation, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
