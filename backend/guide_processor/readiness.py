def compute_ready(alignment_error, thresholds=None):
    limits = {
        "center": 0.06,
        "scale": 0.10,
        "pose": 0.14,
    }
    if thresholds:
        limits.update(thresholds)

    center_error = alignment_error.get("centerError")
    scale_error = alignment_error.get("scaleError")
    pose_error = alignment_error.get("poseError")
    framing_ready = (
        center_error is not None
        and scale_error is not None
        and center_error <= limits["center"]
        and scale_error <= limits["scale"]
    )
    pose_ready = pose_error is not None and pose_error <= limits["pose"]
    return {
        "connectionReady": None,
        "cameraReady": None,
        "guideReady": True,
        "framingReady": framing_ready,
        "poseReady": pose_ready,
        "captureReady": framing_ready and pose_ready,
    }
