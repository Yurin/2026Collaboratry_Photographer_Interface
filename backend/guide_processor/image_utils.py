from pathlib import Path
from PIL import Image


def open_image(path):
    image_path = Path(path)
    image = Image.open(image_path)
    return image.convert("RGBA")


def trim_to_aspect_ratio(image, target_ratio=(3, 4)):
    width, height = image.size
    target_width, target_height = target_ratio
    target_aspect = target_width / target_height
    current_aspect = width / height

    if current_aspect > target_aspect:
        new_width = int(height * target_aspect)
        left = (width - new_width) // 2
        return image.crop((left, 0, left + new_width, height))
    elif current_aspect < target_aspect:
        new_height = int(width / target_aspect)
        top = (height - new_height) // 2
        return image.crop((0, top, width, top + new_height))

    return image


def create_transparent_canvas(size):
    return Image.new("RGBA", size, (0, 0, 0, 0))


def centered_rectangle(image, inset_ratio=(0.18, 0.12)):
    width, height = image.size
    inset_x = int(width * inset_ratio[0])
    inset_y = int(height * inset_ratio[1])
    return (inset_x, inset_y, width - inset_x, height - inset_y)


def save_png(image, output_path):
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_file, format="PNG")


def crop_with_normalized_rect(image, x, y, width, height):
    """Crop image using normalized coordinates (0.0-1.0).
    
    Args:
        image: PIL Image to crop
        x, y, width, height: Normalized coordinates (0.0-1.0)
    
    Returns:
        Cropped PIL Image
    """
    img_width, img_height = image.size
    
    # Clamp to valid bounds
    x = max(0.0, min(1.0 - width, x))
    y = max(0.0, min(1.0 - height, y))
    width = max(0.0, min(1.0 - x, width))
    height = max(0.0, min(1.0 - y, height))
    
    # Convert to pixel coordinates
    x1 = int(x * img_width)
    y1 = int(y * img_height)
    x2 = int((x + width) * img_width)
    y2 = int((y + height) * img_height)
    
    # Crop
    return image.crop((x1, y1, x2, y2))
