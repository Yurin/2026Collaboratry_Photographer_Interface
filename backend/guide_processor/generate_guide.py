#!/usr/bin/env python3
import argparse
from pathlib import Path
from PIL import Image

from image_utils import open_image, trim_to_aspect_ratio, save_png, crop_with_normalized_rect
from guide_types import create_keypoints_guide, create_rectangle_guide, create_silhouette_guide
from person_detector import detect_person_bbox, detect_person_keypoints, detect_person_mask

GUIDE_MAP = {
    "rectangle": create_rectangle_guide,
    "keypoints": create_keypoints_guide,
    "silhouette": create_silhouette_guide,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Generate a transparent guide overlay from a reference image.")
    parser.add_argument("--input", required=True, help="Path to the reference image")
    parser.add_argument("--output", required=True, help="Path to the generated guide PNG")
    parser.add_argument(
        "--type",
        choices=GUIDE_MAP.keys(),
        required=True,
        help="Guide type to generate",
    )
    parser.add_argument("--width", type=int, default=900, help="Output width in pixels")
    parser.add_argument("--height", type=int, default=1200, help="Output height in pixels")
    parser.add_argument("--crop-x", type=float, help="Normalized crop X (0.0-1.0)")
    parser.add_argument("--crop-y", type=float, help="Normalized crop Y (0.0-1.0)")
    parser.add_argument("--crop-width", type=float, help="Normalized crop width (0.0-1.0)")
    parser.add_argument("--crop-height", type=float, help="Normalized crop height (0.0-1.0)")
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        raise FileNotFoundError(f"Input image not found: {input_path}")

    source_image = open_image(input_path)
    
    # Apply crop if provided
    if args.crop_x is not None and args.crop_y is not None and args.crop_width is not None and args.crop_height is not None:
        cropped_image = crop_with_normalized_rect(
            source_image,
            args.crop_x,
            args.crop_y,
            args.crop_width,
            args.crop_height
        )
    else:
        # Fallback to auto-center 3:4 crop
        cropped_image = trim_to_aspect_ratio(source_image, target_ratio=(3, 4))
    
    output_image = cropped_image.resize((args.width, args.height), resample=Image.LANCZOS)

    # Try person detection on the resized image. If detection fails, pass None.
    try:
        person_box = detect_person_bbox(output_image)
    except Exception:
        person_box = None

    person_mask = None
    pose_keypoints = None
    if args.type == "silhouette":
        try:
            person_mask, mask_box = detect_person_mask(output_image)
            if mask_box is not None:
                person_box = mask_box
        except Exception as error:
            print(f"Segmentation unavailable, using template silhouette: {error}")

        try:
            pose_keypoints = detect_person_keypoints(output_image)
        except Exception as error:
            print(f"Pose unavailable, using silhouette without skeleton: {error}")

    guide_creator = GUIDE_MAP[args.type]
    guide_image = guide_creator(
        output_image,
        person_box=person_box,
        person_mask=person_mask,
        pose_keypoints=pose_keypoints,
    )
    save_png(guide_image, output_path)
    print(f"Guide generated: {output_path}")


if __name__ == "__main__":
    main()
