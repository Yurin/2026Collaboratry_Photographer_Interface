"""Render the exact frozen, corrected trial skeleton; no model inference."""
import json
import sys
from PIL import Image, ImageDraw
from guide_types import draw_pose_skeleton
from progressive_guidance import load_config

NAMES = ["nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle"]
config = load_config(sys.argv[3] if len(sys.argv) > 3 else None)
reference = json.load(open(sys.argv[1]))
canvas = Image.new("RGBA", (900, 1200))
points = {p["name"]: p for p in reference["keypoints"]}
keypoints = [(points[n]["x"] * 900, points[n]["y"] * 1200, points[n].get("confidence", 0)) if n in points else (0, 0, 0) for n in NAMES]
draw_pose_skeleton(canvas, keypoints, conf_threshold=config["minConfidence"])
b = reference["personBox"]
ImageDraw.Draw(canvas).rectangle((b["x"] * 900, b["y"] * 1200, (b["x"] + b["width"]) * 900, (b["y"] + b["height"]) * 1200), outline=(255, 255, 255, 220), width=5)
canvas.save(sys.argv[2])
