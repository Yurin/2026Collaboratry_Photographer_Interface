"""Render an older guide's saved crop without running person detection."""
import json
import sys
from pathlib import Path

from PIL import Image
from image_utils import open_image, crop_with_normalized_rect, trim_to_aspect_ratio


def render_reference_photo(source, destination, crop=None):
    image = open_image(source)
    if crop:
        image = crop_with_normalized_rect(image, crop['x'], crop['y'], crop['width'], crop['height'])
    else:
        image = trim_to_aspect_ratio(image)
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    image.resize((900, 1200), Image.LANCZOS).convert('RGB').save(destination, quality=90)


if __name__ == '__main__':
    render_reference_photo(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
