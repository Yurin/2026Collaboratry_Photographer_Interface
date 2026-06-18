import Foundation
import CoreGraphics

struct CropRect: Codable {
    let x: Double      // 0.0 ~ 1.0
    let y: Double      // 0.0 ~ 1.0
    let width: Double  // 0.0 ~ 1.0
    let height: Double // 0.0 ~ 1.0
    
    static let aspectRatio: Double = 3.0 / 4.0 // 3:4
    
    /// Fallback used before an image has been selected.
    static var centered: CropRect {
        CropRect(x: 0.125, y: 0, width: 0.75, height: 1)
    }

    /// Create the largest centered 3:4 crop that fits the selected image.
    static func centered(for imageSize: CGSize) -> CropRect {
        guard imageSize.width > 0, imageSize.height > 0 else {
            return .centered
        }

        let imageAspectRatio = Double(imageSize.width / imageSize.height)

        if imageAspectRatio > aspectRatio {
            let normalizedWidth = aspectRatio / imageAspectRatio
            return CropRect(
                x: (1.0 - normalizedWidth) / 2.0,
                y: 0,
                width: normalizedWidth,
                height: 1.0
            )
        }

        let normalizedHeight = imageAspectRatio / aspectRatio
        return CropRect(
            x: 0,
            y: (1.0 - normalizedHeight) / 2.0,
            width: 1.0,
            height: normalizedHeight
        )
    }
    
    /// Constrain to valid bounds
    func constrained() -> CropRect {
        let x = max(0, min(1.0 - width, x))
        let y = max(0, min(1.0 - height, y))
        let width = max(0, min(1.0 - x, width))
        let height = max(0, min(1.0 - y, height))
        return CropRect(x: x, y: y, width: width, height: height)
    }
}
