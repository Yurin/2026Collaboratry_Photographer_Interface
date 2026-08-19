import SwiftUI
import UIKit

struct CropEditorView: View {
    let image: UIImage
    let onApply: (CropRect) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var centerX: Double
    @State private var centerY: Double
    @State private var zoom: Double
    @State private var dragStartCenter: CGPoint?
    @State private var magnificationStartZoom: Double?

    private let baseCrop: CropRect
    private let minimumZoom = 1.0
    private let maximumZoom = 10.0

    init(image: UIImage, initialCrop: CropRect, onApply: @escaping (CropRect) -> Void) {
        self.image = image
        self.onApply = onApply

        let baseCrop = CropRect.centered(for: image.size)
        self.baseCrop = baseCrop

        let widthZoom = initialCrop.width > 0 ? baseCrop.width / initialCrop.width : 1
        let heightZoom = initialCrop.height > 0 ? baseCrop.height / initialCrop.height : 1
        let initialZoom = min(10, max(1, max(widthZoom, heightZoom)))
        let cropWidth = baseCrop.width / initialZoom
        let cropHeight = baseCrop.height / initialZoom
        let proposedCenterX = initialCrop.x + initialCrop.width / 2
        let proposedCenterY = initialCrop.y + initialCrop.height / 2

        _centerX = State(initialValue: Self.clampCenter(proposedCenterX, extent: cropWidth))
        _centerY = State(initialValue: Self.clampCenter(proposedCenterY, extent: cropHeight))
        _zoom = State(initialValue: initialZoom)
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            GeometryReader { geometry in
                let cropFrameSize = fittedCropFrame(in: geometry.size)

                ZStack {
                    Color.black

                    cropCanvas(size: cropFrameSize)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            footer
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack {
            Button("キャンセル") {
                dismiss()
            }
            .foregroundStyle(.white)

            Spacer()

            VStack(spacing: 2) {
                Text("3:4にトリミング")
                    .font(.headline.weight(.bold))
                Text("位置と大きさを調整")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button("リセット") {
                resetCrop()
            }
            .foregroundStyle(.white)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    private var footer: some View {
        VStack(spacing: 14) {
            Label("ドラッグで移動・ピンチで拡大縮小", systemImage: "hand.draw")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)

            Button {
                onApply(currentCropRect)
                dismiss()
            } label: {
                Label("この範囲に決定", systemImage: "checkmark")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(AppPrimaryButtonStyle())
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 20)
    }

    private func cropCanvas(size: CGSize) -> some View {
        let cropWidth = baseCrop.width / zoom
        let cropHeight = baseCrop.height / zoom
        let displayedWidth = size.width / CGFloat(cropWidth)
        let displayedHeight = size.height / CGFloat(cropHeight)
        let horizontalOffset = CGFloat(0.5 - centerX) * displayedWidth
        let verticalOffset = CGFloat(0.5 - centerY) * displayedHeight

        return ZStack {
            Image(uiImage: image)
                .resizable()
                .frame(width: displayedWidth, height: displayedHeight)
                .offset(x: horizontalOffset, y: verticalOffset)

            ruleOfThirdsGrid

            Rectangle()
                .strokeBorder(.white, lineWidth: 3)

            VStack {
                Spacer()
                Text(String(format: "%.1fx", zoom))
                    .font(.caption2.monospacedDigit().weight(.bold))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.black.opacity(0.62), in: Capsule())
                    .padding(10)
            }
        }
        // Fix the canvas bounds before clipping. If this frame is applied by the
        // caller, the enlarged image can determine the ZStack's layout size and
        // make the grid/border grow together with the pinch zoom.
        .frame(width: size.width, height: size.height)
        .contentShape(Rectangle())
        .clipped()
        .gesture(dragGesture(canvasSize: size))
        .simultaneousGesture(magnificationGesture)
        .accessibilityLabel("3対4のトリミング範囲")
        .accessibilityHint("ドラッグで位置を移動し、ピンチで拡大縮小します")
    }

    private var ruleOfThirdsGrid: some View {
        GeometryReader { geometry in
            Path { path in
                let width = geometry.size.width
                let height = geometry.size.height
                for fraction in [1.0 / 3.0, 2.0 / 3.0] {
                    path.move(to: CGPoint(x: width * fraction, y: 0))
                    path.addLine(to: CGPoint(x: width * fraction, y: height))
                    path.move(to: CGPoint(x: 0, y: height * fraction))
                    path.addLine(to: CGPoint(x: width, y: height * fraction))
                }
            }
            .stroke(.white.opacity(0.45), lineWidth: 1)
        }
        .allowsHitTesting(false)
    }

    private func dragGesture(canvasSize: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                if dragStartCenter == nil {
                    dragStartCenter = CGPoint(x: centerX, y: centerY)
                }
                guard let start = dragStartCenter else { return }

                let cropWidth = baseCrop.width / zoom
                let cropHeight = baseCrop.height / zoom
                let displayedWidth = canvasSize.width / CGFloat(cropWidth)
                let displayedHeight = canvasSize.height / CGFloat(cropHeight)
                let proposedX = start.x - value.translation.width / displayedWidth
                let proposedY = start.y - value.translation.height / displayedHeight

                centerX = Self.clampCenter(Double(proposedX), extent: cropWidth)
                centerY = Self.clampCenter(Double(proposedY), extent: cropHeight)
            }
            .onEnded { _ in
                dragStartCenter = nil
            }
    }

    private var magnificationGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                if magnificationStartZoom == nil {
                    magnificationStartZoom = zoom
                }
                guard let startZoom = magnificationStartZoom else { return }

                zoom = min(maximumZoom, max(minimumZoom, startZoom * Double(value)))
                clampCurrentCenter()
            }
            .onEnded { _ in
                magnificationStartZoom = nil
            }
    }

    private var currentCropRect: CropRect {
        let width = baseCrop.width / zoom
        let height = baseCrop.height / zoom
        return CropRect(
            x: centerX - width / 2,
            y: centerY - height / 2,
            width: width,
            height: height
        ).constrained()
    }

    private func resetCrop() {
        zoom = 1
        centerX = 0.5
        centerY = 0.5
        dragStartCenter = nil
        magnificationStartZoom = nil
    }

    private func clampCurrentCenter() {
        centerX = Self.clampCenter(centerX, extent: baseCrop.width / zoom)
        centerY = Self.clampCenter(centerY, extent: baseCrop.height / zoom)
    }

    private func fittedCropFrame(in availableSize: CGSize) -> CGSize {
        let availableWidth = max(0, availableSize.width - 32)
        let availableHeight = max(0, availableSize.height - 24)
        let widthFromHeight = availableHeight * 3 / 4
        let width = min(availableWidth, widthFromHeight)
        return CGSize(width: width, height: width * 4 / 3)
    }

    private static func clampCenter(_ value: Double, extent: Double) -> Double {
        let half = min(0.5, max(0, extent / 2))
        return min(1 - half, max(half, value))
    }
}
