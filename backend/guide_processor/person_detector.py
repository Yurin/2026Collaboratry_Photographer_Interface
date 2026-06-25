"""person_detector.py

YOLOv8 を使った人物検出・セグメンテーション・姿勢推定の薄いラッパー。
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

_models = {}


def load_model(weights: str | None = None, task: str = "detect"):
    if YOLO is None:
        raise RuntimeError("ultralytics YOLO is not available. Install `ultralytics` package`.")

    default_weights = {
        "detect": os.environ.get("YOLO_DETECT_WEIGHTS", "yolov8n.pt"),
        "segment": os.environ.get("YOLO_SEG_WEIGHTS", "yolov8n-seg.pt"),
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

    results = model(arr)
    if not results or len(results) == 0:
        return None

    r = results[0]
    # r.boxes may be empty
    boxes = getattr(r, "boxes", None)
    best_index = _best_person_index(boxes, conf_threshold=conf_threshold)
    if best_index is None:
        return None

    return _box_tuple(boxes, best_index)


def detect_person_mask(image, conf_threshold: float = 0.3):
    """Return a PIL L mask and bbox for the most prominent segmented person."""
    if np is None or YOLO is None or Image is None:
        raise RuntimeError("Required libraries for person segmentation are not installed")

    model = load_model(task="segment")
    arr = np.array(image.convert("RGB"))
    results = model(arr)
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

    mask = Image.fromarray((mask_array > 0.5).astype("uint8") * 255, mode="L")
    if mask.size != image.size:
        mask = mask.resize(image.size, resample=Image.NEAREST)

    return mask, _box_tuple(boxes, best_index)


def detect_person_keypoints(image, conf_threshold: float = 0.25):
    """Return COCO keypoints [(x, y, conf), ...] for the most prominent person."""
    _, keypoints = detect_person_pose(image, conf_threshold=conf_threshold)
    return keypoints


def detect_person_pose(image, conf_threshold: float = 0.25):
    """Return the prominent person's bbox and COCO keypoints from one pose inference."""
    person_box, keypoints, _ = detect_person_pose_with_count(
        image,
        conf_threshold=conf_threshold,
    )
    return person_box, keypoints


def detect_person_pose_with_count(image, conf_threshold: float = 0.25):
    """Return the prominent pose and the number of detected people."""
    if np is None or YOLO is None:
        raise RuntimeError("Required libraries for pose detection are not installed")

    model = load_model(task="pose")
    arr = np.array(image.convert("RGB"))
    results = model(arr)
    if not results:
        return None, None, 0

    r = results[0]
    boxes = getattr(r, "boxes", None)
    keypoints = getattr(r, "keypoints", None)
    person_count = len(_person_indices(boxes, conf_threshold=conf_threshold))
    best_index = _best_person_index(boxes, conf_threshold=conf_threshold)
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
