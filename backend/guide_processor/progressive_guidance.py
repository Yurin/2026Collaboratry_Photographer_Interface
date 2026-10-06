"""Deterministic candidates; image composition belongs to the photographer only."""
import json
import math
from pathlib import Path

DEFAULT_CONFIG = Path(__file__).with_name("guidance_config.json")
LABELS = {"nose": "鼻", "leftShoulder": "左肩", "rightShoulder": "右肩",
          "leftElbow": "左肘", "rightElbow": "右肘", "leftWrist": "左手首",
          "rightWrist": "右手首", "leftHip": "左腰", "rightHip": "右腰",
          "leftKnee": "左膝", "rightKnee": "右膝", "leftAnkle": "左足首", "rightAnkle": "右足首"}


def load_config(path=None):
    config = json.loads(Path(path or DEFAULT_CONFIG).read_text())
    for group in ("thresholds", "categoryWeights"):
        for value in config[group].values():
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{group} must contain finite positive values")
    if not 0 < config["minConfidence"] <= 1 or not 0 < config["minTorsoLength"]:
        raise ValueError("Invalid confidence or torso threshold")
    if not config["imageAspectRatio"] > 0 or not config["poseTargets"]:
        raise ValueError("Invalid aspect ratio or targets")
    return config


def points(features, config):
    return {p["name"]: p for p in features.get("keypoints", [])
            if p.get("isEnabled", True) and
            p.get("confidence", 0) >= config["minConfidence"] and
            all(isinstance(p.get(k), (int, float)) and math.isfinite(p[k]) for k in ("x", "y"))}


def body_frame(features, config):
    p = points(features, config)
    if not all(k in p for k in ("leftShoulder", "rightShoulder", "leftHip", "rightHip")):
        return None
    aspect = config["imageAspectRatio"]
    def midpoint(a, b):
        return ((p[a]["x"] + p[b]["x"]) * aspect / 2, (p[a]["y"] + p[b]["y"]) / 2)
    shoulder = midpoint("leftShoulder", "rightShoulder")
    hip = midpoint("leftHip", "rightHip")
    length = math.dist(shoulder, hip)
    if length < config["minTorsoLength"]:
        return None
    return {k: {"x": (v["x"] * aspect - hip[0]) / length,
                "y": (v["y"] - hip[1]) / length} for k, v in p.items()}


def candidate(role, category, target, direction, error, threshold, message, config):
    normalized = error / threshold if error is not None else None
    score = normalized * config["categoryWeights"][category] if normalized is not None else None
    return {"candidateId": f"{role}:{category}:{target}", "targetRole": role,
            "category": category, "target": target, "direction": direction,
            "errorMagnitude": error, "normalizedError": normalized,
            "priority": score, "priorityScore": score, "threshold": threshold,
            "categoryWeight": config["categoryWeights"][category], "message": message,
            "isResolved": error <= threshold + 1e-9 if error is not None else False,
            "status": "unknown" if error is None else ("resolved" if error <= threshold + 1e-9 else "unresolved"),
            # Retain existing Swift/Web display fields.
            "type": category, "value": error,
            "severity": "high" if normalized is not None and normalized >= 2 else "medium"}


def analyze_progressive(reference, observation, config, condition="C"):
    limits = config["thresholds"]
    candidates = []
    detected = (observation.get("source") != "fallback-template" and
                observation.get("personCount", 1) == 1 and
                observation.get("confidence", 1) >= config["minConfidence"])
    dx = observation["bodyCenter"]["x"] - reference["bodyCenter"]["x"]
    dy = observation["bodyCenter"]["y"] - reference["bodyCenter"]["y"]
    center = math.hypot(dx, dy) if detected else None
    # Camera movement is opposite to the desired image movement.
    direction = ("right" if dx > 0 else "left") if abs(dx) >= abs(dy) else ("down" if dy > 0 else "up")
    japanese = {"right": "右", "left": "左", "up": "上", "down": "下"}
    candidates.append(candidate("photographer", "composition_position", "person", direction if detected else None,
                                center, limits["center"], f"カメラを少し{japanese[direction]}へ" if detected else "人物を1人、画面に収めて再撮影", config))
    def size(f):
        return math.sqrt(max(0, f["personBox"]["width"] * f["personBox"]["height"]))
    delta_size = size(observation) - size(reference)
    scale = abs(delta_size) if detected else None
    candidates.append(candidate("photographer", "composition_scale", "person",
                                ("farther" if delta_size > 0 else "closer") if detected else None, scale, limits["scale"],
                                ("少し離れてください" if delta_size > 0 else "少し近づいてください") if detected else "人物が見える状態で再撮影", config))
    ref_frame, obs_frame = body_frame(reference, config), body_frame(observation, config) if detected else None
    reference_points = points(reference, config)
    targets = [k for k in config["poseTargets"] if k in reference_points]
    for name in targets:
        valid = ref_frame is not None and obs_frame is not None and name in obs_frame
        if valid:
            x = ref_frame[name]["x"] - obs_frame[name]["x"]
            y = ref_frame[name]["y"] - obs_frame[name]["y"]
            error = math.hypot(x, y)
            direction = ("right" if x > 0 else "left") if abs(x) >= abs(y) else ("down" if y > 0 else "up")
            message = f"{LABELS.get(name, name)}を画面の{japanese[direction]}へ"
        else:
            error, direction, message = None, None, f"{LABELS.get(name, name)}が見える状態で再撮影"
        candidates.append(candidate("subject", "pose", name, direction, error, limits["pose"], message, config))
    if not targets or ref_frame is None:
        candidates.append(candidate("subject", "pose", "body", None, None, limits["pose"], "参照姿勢の肩・腰を確認してください", config))
    # Unknowns must never masquerade as resolved; deterministic tie-breaking.
    candidates.sort(key=lambda c: (c["status"] != "unknown", -(c["priorityScore"] or 0), c["candidateId"]))
    selected = []
    if condition != "A":
        for role in ("photographer", "subject"):
            pending = [c for c in candidates if c["targetRole"] == role and not c["isResolved"]]
            selected.extend(pending[:1] if condition == "C" else pending)
    photo = [c for c in candidates if c["targetRole"] == "photographer"]
    pose = [c for c in candidates if c["targetRole"] == "subject"]
    framing_ready = all(c["isResolved"] for c in photo)
    pose_ready = bool(pose) and all(c["isResolved"] for c in pose)
    pose_errors = [c["errorMagnitude"] for c in pose if c["errorMagnitude"] is not None]
    pose_error = max(pose_errors) if pose_errors and all(c["status"] != "unknown" for c in pose) else None
    total = None if None in (center, scale, pose_error) else (center / limits["center"] + scale / limits["scale"] + pose_error / limits["pose"]) / 3
    return {"schemaVersion": "2.0", "guidanceProtocolVersion": "progressive-v1", "conditionId": condition,
            "guidanceConfig": config, "readyThresholds": limits, "guidanceCandidates": candidates,
            "selectedGuidance": selected,
            "photographerGuidance": [c for c in selected if c["targetRole"] == "photographer"],
            "subjectGuidance": [c for c in selected if c["targetRole"] == "subject"],
            "alignmentError": {"centerError": center, "scaleError": scale, "poseError": pose_error,
                               "totalError": total, "silhouetteError": None},
            "ready": {"framingReady": framing_ready, "poseReady": pose_ready,
                      "captureReady": framing_ready and pose_ready, "guideReady": True}}
