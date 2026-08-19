"""person_detector.py

Ultralytics YOLO を使った人物検出・セグメンテーション・姿勢推定の薄いラッパー。
通常ガイドは人物bboxだけを使い、シルエットガイドではmask/keypointsも使います。
"""
import os
from typing import Optional, Tuple

try:
    from PIL import Image
    import numpy as np
    from ultralytics import YOLO
except Exception:
    # import failures are deferred to runtime; caller should handle missing deps
    Image = None
    YOLO = None
    np = None

try:
    from ultralytics import SAM
except Exception:
    SAM = None

_models = {}
_sam_models = {}


def load_model(weights: str | None = None, task: str = "detect"):
    if YOLO is None:
        raise RuntimeError("ultralytics YOLO is not available. Install `ultralytics` package`.")

    default_weights = {
        "detect": os.environ.get("YOLO_DETECT_WEIGHTS", "yolov8n.pt"),
        "segment": os.environ.get("YOLO_SEG_WEIGHTS", "yolo11s-seg.pt"),
        "pose": os.environ.get("YOLO_POSE_WEIGHTS", "yolov8n-pose.pt"),
    }
    model_weights = weights or default_weights.get(task, "yolov8n.pt")
    cache_key = (task, model_weights)

    if cache_key not in _models:
        _models[cache_key] = YOLO(model_weights)

    return _models[cache_key]


def _best_person_index(boxes, conf_threshold: float = 0.3) -> Optional[int]:
    if boxes is None or len(boxes) == 0:
        return None

    try:
        xyxy = boxes.xyxy.cpu().numpy()
        cls = boxes.cls.cpu().numpy()
        conf = boxes.conf.cpu().numpy()
    except Exception:
        xyxy = boxes.xyxy.numpy()
        cls = boxes.cls.numpy()
        conf = boxes.conf.numpy()

    best_index = None
    best_score = 0.0

    for index, (box, class_id, confidence) in enumerate(zip(xyxy, cls, conf)):
        if int(class_id) != 0 or float(confidence) < conf_threshold:
            continue

        x1, y1, x2, y2 = map(float, box)
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        score = area * float(confidence)

        if score > best_score:
            best_score = score
            best_index = index

    return best_index


def _person_indices(boxes, conf_threshold: float = 0.3):
    if boxes is None or len(boxes) == 0:
        return []

    try:
        cls = boxes.cls.cpu().numpy()
        conf = boxes.conf.cpu().numpy()
    except Exception:
        cls = boxes.cls.numpy()
        conf = boxes.conf.numpy()

    return [
        index
        for index, (class_id, confidence) in enumerate(zip(cls, conf))
        if int(class_id) == 0 and float(confidence) >= conf_threshold
    ]


def _box_tuple(boxes, index: int) -> Tuple[int, int, int, int]:
    try:
        xyxy = boxes.xyxy.cpu().numpy()
    except Exception:
        xyxy = boxes.xyxy.numpy()

    x1, y1, x2, y2 = map(float, xyxy[index])
    return (int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2)))


def _box_iou(first, second) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = max(0, first[2] - first[0]) * max(0, first[3] - first[1])
    second_area = max(0, second[2] - second[0]) * max(0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union > 0 else 0.0


def _matching_person_index(boxes, target_box, conf_threshold: float) -> Optional[int]:
    candidates = _person_indices(boxes, conf_threshold=conf_threshold)
    if not candidates:
        return None
    if target_box is None:
        return _best_person_index(boxes, conf_threshold=conf_threshold)
    scored = [
        (_box_iou(_box_tuple(boxes, index), target_box), index)
        for index in candidates
    ]
    best_iou, best_index = max(scored)
    return best_index if best_iou >= 0.10 else None


def detect_person_bbox(image, conf_threshold: float = 0.3) -> Optional[Tuple[int, int, int, int]]:
    """Detect person bbox in the given PIL image.

    Returns (left, top, right, bottom) in pixel coordinates for the input image size,
    or None when no person detected with sufficient confidence.
    """
    if np is None or YOLO is None:
        raise RuntimeError("Required libraries for person detection are not installed")

    model = load_model(task="detect")

    # ultralytics accepts numpy array in RGB
    arr = np.array(image.convert("RGB"))

    results = model.predict(
        arr,
        classes=[0],
        conf=conf_threshold,
        imgsz=960,
        verbose=False,
    )
    if not results or len(results) == 0:
        return None

    r = results[0]
    # r.boxes may be empty
    boxes = getattr(r, "boxes", None)
    best_index = _best_person_index(boxes, conf_threshold=conf_threshold)
    if best_index is None:
        return None

    return _box_tuple(boxes, best_index)


def detect_person_mask(image, conf_threshold: float = 0.3, mask_threshold: float = 0.5):
    """Return a PIL L mask and bbox for the most prominent segmented person."""
    if np is None or YOLO is None or Image is None:
        raise RuntimeError("Required libraries for person segmentation are not installed")

    model = load_model(task="segment")
    arr = np.array(image.convert("RGB"))
    results = model.predict(
        arr,
        classes=[0],
        conf=conf_threshold,
        imgsz=960,
        retina_masks=True,
        verbose=False,
    )
    if not results:
        return None, None

    r = results[0]
    boxes = getattr(r, "boxes", None)
    masks = getattr(r, "masks", None)
    best_index = _best_person_index(boxes, conf_threshold=conf_threshold)
    if best_index is None or masks is None:
        return None, None

    try:
        mask_array = masks.data[best_index].cpu().numpy()
    except Exception:
        mask_array = masks.data[best_index].numpy()

    mask = Image.fromarray((mask_array > mask_threshold).astype("uint8") * 255, mode="L")
    if mask.size != image.size:
        mask = mask.resize(image.size, resample=Image.NEAREST)

    return mask, _box_tuple(boxes, best_index)


def expand_person_box(box, image_size, horizontal_ratio=0.12, top_ratio=0.30, bottom_ratio=0.08):
    """Expand a person box while keeping it within the image."""
    width, height = image_size
    left, top, right, bottom = box
    box_width = max(1, right - left)
    box_height = max(1, bottom - top)
    return (
        max(0, int(round(left - box_width * horizontal_ratio))),
        max(0, int(round(top - box_height * top_ratio))),
        min(width, int(round(right + box_width * horizontal_ratio))),
        min(height, int(round(bottom + box_height * bottom_ratio))),
    )


def detect_person_mask_in_expanded_region(
    image,
    person_box,
    conf_threshold: float = 0.2,
    mask_threshold: float = 0.4,
):
    """Retry segmentation on a padded person crop and map the result to the full image."""
    if Image is None:
        raise RuntimeError("Pillow is not installed")

    region_box = expand_person_box(person_box, image.size)
    region = image.crop(region_box)
    region_mask, region_detection_box = detect_person_mask(
        region,
        conf_threshold=conf_threshold,
        mask_threshold=mask_threshold,
    )
    if region_mask is None or region_detection_box is None:
        return None, None

    full_mask = Image.new("L", image.size, 0)
    full_mask.paste(region_mask, (region_box[0], region_box[1]))
    return full_mask, (
        region_box[0] + region_detection_box[0],
        region_box[1] + region_detection_box[1],
        region_box[0] + region_detection_box[2],
        region_box[1] + region_detection_box[3],
    )


def _load_sam_model():
    if SAM is None:
        raise RuntimeError("Ultralytics SAM is not available")

    weights = os.environ.get("SAM_WEIGHTS", "mobile_sam.pt")
    if weights not in _sam_models:
        _sam_models[weights] = SAM(weights)
    return _sam_models[weights]


def _mask_box(mask):
    binary = np.asarray(mask.convert("L")) > 0
    ys, xs = np.nonzero(binary)
    if len(xs) == 0:
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def _sam_prompt_points(image_size, pose_keypoints, person_box=None):
    width, height = image_size
    positive_indices = (0, 1, 2, 5, 6, 11, 12)
    positive = [
        [float(pose_keypoints[index][0]), float(pose_keypoints[index][1])]
        for index in positive_indices
        if pose_keypoints
        and index < len(pose_keypoints)
        and pose_keypoints[index][2] >= 0.30
    ]
    if not positive:
        return None, None

    person_center = (
        (person_box[0] + person_box[2]) / 2 if person_box is not None else width / 2
    )
    background_x = width * (0.97 if person_center <= width / 2 else 0.03)
    negative = [[background_x, height * 0.03], [background_x, height * 0.50]]
    points = [positive + negative]
    labels = [[1] * len(positive) + [0] * len(negative)]
    return points, labels


def detect_person_mask_with_sam(image, person_box, pose_keypoints=None):
    """Refine a difficult person silhouette using an expanded box prompt."""
    if np is None or Image is None:
        raise RuntimeError("Required libraries for SAM segmentation are not installed")

    model = _load_sam_model()
    prompt_box = expand_person_box(
        person_box,
        image.size,
        horizontal_ratio=0.03,
        top_ratio=0.35,
        bottom_ratio=0.01,
    )
    points, labels = _sam_prompt_points(image.size, pose_keypoints, person_box=person_box)
    results = model.predict(
        np.array(image.convert("RGB")),
        bboxes=[list(prompt_box)],
        points=points,
        labels=labels,
        verbose=False,
    )
    if not results:
        return None, None

    masks = getattr(results[0], "masks", None)
    if masks is None or len(masks.data) == 0:
        return None, None

    try:
        mask_arrays = masks.data.cpu().numpy()
    except Exception:
        mask_arrays = masks.data.numpy()
    mask_array = max(mask_arrays, key=lambda item: int(np.count_nonzero(item)))
    mask = Image.fromarray((mask_array > 0.5).astype("uint8") * 255, mode="L")
    if mask.size != image.size:
        mask = mask.resize(image.size, resample=Image.NEAREST)
    return mask, _mask_box(mask)


def detect_person_keypoints(image, conf_threshold: float = 0.25, target_box=None):
    """Return COCO keypoints [(x, y, conf), ...] for the most prominent person."""
    _, keypoints = detect_person_pose(
        image,
        conf_threshold=conf_threshold,
        target_box=target_box,
    )
    return keypoints


def detect_person_pose(image, conf_threshold: float = 0.25, target_box=None):
    """Return the prominent person's bbox and COCO keypoints from one pose inference."""
    person_box, keypoints, _ = detect_person_pose_with_count(
        image,
        conf_threshold=conf_threshold,
        target_box=target_box,
    )
    return person_box, keypoints


def detect_person_pose_with_count(image, conf_threshold: float = 0.25, target_box=None):
    """Return the prominent pose and the number of detected people."""
    if np is None or YOLO is None:
        raise RuntimeError("Required libraries for pose detection are not installed")

    model = load_model(task="pose")
    arr = np.array(image.convert("RGB"))
    results = model.predict(
        arr,
        classes=[0],
        conf=conf_threshold,
        imgsz=960,
        verbose=False,
    )
    if not results:
        return None, None, 0

    r = results[0]
    boxes = getattr(r, "boxes", None)
    keypoints = getattr(r, "keypoints", None)
    person_count = len(_person_indices(boxes, conf_threshold=conf_threshold))
    best_index = _matching_person_index(
        boxes,
        target_box=target_box,
        conf_threshold=conf_threshold,
    )
    if best_index is None or keypoints is None:
        return None, None, person_count

    try:
        xy = keypoints.xy.cpu().numpy()[best_index]
        conf = keypoints.conf.cpu().numpy()[best_index]
    except Exception:
        xy = keypoints.xy.numpy()[best_index]
        conf = keypoints.conf.numpy()[best_index]

    points = [
        (float(point[0]), float(point[1]), float(confidence))
        for point, confidence in zip(xy, conf)
    ]
    return _box_tuple(boxes, best_index), points, person_count
