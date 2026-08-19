//
//  photo2026Tests.swift
//  photo2026Tests
//
//  Created by yurin on 2026/04/07.
//

import Testing
import CoreGraphics
@testable import photo2026

struct photo2026Tests {

    @Test func centeredCropMaintainsThreeByFourPixelAspect() {
        let imageSizes = [
            CGSize(width: 4032, height: 3024),
            CGSize(width: 3024, height: 4032),
            CGSize(width: 2000, height: 4000),
        ]

        for imageSize in imageSizes {
            let crop = CropRect.centered(for: imageSize)
            let pixelWidth = crop.width * Double(imageSize.width)
            let pixelHeight = crop.height * Double(imageSize.height)
            #expect(abs(pixelWidth / pixelHeight - 3.0 / 4.0) < 0.000_001)
        }
    }

    @Test func constrainedCropStaysInsideImage() {
        let crop = CropRect(x: -0.2, y: 0.8, width: 0.7, height: 0.5).constrained()

        #expect(crop.x >= 0)
        #expect(crop.y >= 0)
        #expect(crop.x + crop.width <= 1)
        #expect(crop.y + crop.height <= 1)
    }

}
