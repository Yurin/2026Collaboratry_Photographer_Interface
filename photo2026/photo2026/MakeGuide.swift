import SwiftUI
import PhotosUI
import UIKit

struct MakeGuide: View {
    @StateObject private var store = GuideLibraryStore()
    @Binding var sessionId: String
    @State private var selectedGuideType: GuideType = .rectangle

    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var selectedImage: UIImage?
    @State private var generatedGuideImages: [GuideType: UIImage] = [:]
    @State private var isGenerating: Bool = false
    @State private var showGenerationErrorAlert: Bool = false
    @State private var alertMessage: String = ""

    @State private var titleText: String = ""
    @State private var isSaving: Bool = false
    @State private var showSaveAlert: Bool = false
    
    @State private var cropRect: CropRect = .centered
    @State private var cropDragOffset: CGSize = .zero
    
    @State private var guideHorizontalOffset: Double = 0.0
    @State private var guideScale: Double = 1.0
    @State private var guideDragStartOffset: Double = 0.0
    @State private var guideScaleStart: Double = 1.0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    titleInputSection
                    imagePickerSection
                    if selectedImage != nil {
                        cropImageSection
                    }
                    guideTypeSection
                    previewSection
                    actionSection
                }
                .padding(16)
            }
            .background(AppStyle.background)
            .navigationTitle("ガイドを作る")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: selectedPhotoItem) { _, newItem in
                guard let newItem else { return }
                Task {
                    await loadSelectedImage(from: newItem)
                }
            }
            .alert("保存結果", isPresented: $showSaveAlert) {
                Button("OK") { }
            } message: {
                Text(alertMessage)
            }
            .alert("ガイド生成に失敗しました", isPresented: $showGenerationErrorAlert) {
                Button("OK") { }
            } message: {
                Text(alertMessage)
            }
        }
    }

    private var titleInputSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionTitle(title: "タイトル", eyebrow: "NEW GUIDE")

            TextField("例: 東京駅で全身ポーズ", text: $titleText)
                .padding(14)
                .background(AppStyle.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private var imagePickerSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSectionTitle(title: "参照写真", eyebrow: "REFERENCE")

            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                Label("カメラロール", systemImage: "photo")
            }
            .buttonStyle(AppCompactButtonStyle(filled: true))

            if let selectedImage {
                Image(uiImage: selectedImage)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(AppStyle.border, lineWidth: 1)
                    )
            } else {
                placeholderCard(text: "まだ参照写真が選ばれていません")
            }
        }
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSectionTitle(title: "生成プレビュー", eyebrow: "PREVIEW")

            if let generatedGuideImage = selectedGeneratedGuideImage {
                GeometryReader { geo in
                    ZStack {
                        Color.black.opacity(0.92)

                        if let selectedImage {
                            Image(uiImage: selectedImage)
                                .resizable()
                                .scaledToFill()
                                .opacity(0.35)
                                .frame(width: geo.size.width, height: geo.size.height)
                                .clipped()
                        }

                        Image(uiImage: generatedGuideImage)
                            .resizable()
                            .scaledToFit()
                            .scaleEffect(guideScale)
                            .offset(x: guideHorizontalOffset * geo.size.width)
                            .gesture(
                                DragGesture()
                                    .onChanged { value in
                                        guideHorizontalOffset = constrainedGuideOffset(
                                            guideDragStartOffset + Double(value.translation.width / geo.size.width)
                                        )
                                    }
                                    .onEnded { _ in
                                        guideDragStartOffset = guideHorizontalOffset
                                    }
                            )
                            .simultaneousGesture(
                                MagnificationGesture()
                                    .onChanged { value in
                                        guideScale = constrainedGuideScale(guideScaleStart * Double(value))
                                    }
                                    .onEnded { _ in
                                        guideScaleStart = guideScale
                                    }
                            )
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(AppStyle.border, lineWidth: 1)
                    )
                }
                .aspectRatio(3.0 / 4.0, contentMode: .fit)

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("左右")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Slider(value: $guideHorizontalOffset, in: -0.35...0.35)
                            .onChange(of: guideHorizontalOffset) { _, newValue in
                                guideHorizontalOffset = constrainedGuideOffset(newValue)
                                guideDragStartOffset = guideHorizontalOffset
                            }
                    }

                    HStack {
                        Text("大きさ")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        Slider(value: $guideScale, in: 0.65...1.5)
                            .onChange(of: guideScale) { _, newValue in
                                guideScale = constrainedGuideScale(newValue)
                                guideScaleStart = guideScale
                            }
                    }

                    Button {
                        resetGuideAdjustment()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .buttonStyle(AppIconButtonStyle())
                    .accessibilityLabel("ガイド位置をリセット")
                }
            } else {
                placeholderCard(text: "まだガイドが生成されていません")
            }
        }
    }

    private var cropImageSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSectionTitle(title: "トリミング", eyebrow: "3 : 4 CROP")

            GeometryReader { geo in
                if let selectedImage {
                    let imageFrame = aspectFitFrame(
                        imageSize: selectedImage.size,
                        containerSize: geo.size
                    )
                    let cropFrameWidth = imageFrame.width * cropRect.width
                    let cropFrameHeight = imageFrame.height * cropRect.height
                    let cropOriginX = imageFrame.minX
                        + imageFrame.width * cropRect.x
                        + cropDragOffset.width
                    let cropOriginY = imageFrame.minY
                        + imageFrame.height * cropRect.y
                        + cropDragOffset.height

                    ZStack {
                        Color.gray.opacity(0.1)

                        Image(uiImage: selectedImage)
                            .resizable()
                            .scaledToFit()
                            .frame(width: geo.size.width, height: geo.size.height)

                        Color.black.opacity(0.42)
                            .mask {
                                Path { path in
                                    path.addRect(CGRect(origin: .zero, size: geo.size))
                                    path.addRoundedRect(
                                        in: CGRect(
                                            x: cropOriginX,
                                            y: cropOriginY,
                                            width: cropFrameWidth,
                                            height: cropFrameHeight
                                        ),
                                        cornerSize: CGSize(width: 8, height: 8)
                                    )
                                }
                                .fill(style: FillStyle(eoFill: true))
                            }

                        ZStack {
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Color.white, lineWidth: 3)

                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.clear)
                                .gesture(
                                    DragGesture()
                                        .onChanged { value in
                                            cropDragOffset = value.translation
                                        }
                                        .onEnded { _ in
                                            let nextX = cropRect.x + cropDragOffset.width / imageFrame.width
                                            let nextY = cropRect.y + cropDragOffset.height / imageFrame.height
                                            let updated = CropRect(
                                                x: nextX,
                                                y: nextY,
                                                width: cropRect.width,
                                                height: cropRect.height
                                            ).constrained()
                                            cropRect = updated
                                            cropDragOffset = .zero
                                        }
                                )
                        }
                        .frame(width: cropFrameWidth, height: cropFrameHeight)
                        .position(
                            x: cropOriginX + cropFrameWidth / 2,
                            y: cropOriginY + cropFrameHeight / 2
                        )
                    }
                    .clipped()
                }
            }
            .frame(height: 280)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

            HStack(spacing: 16) {
                Button {
                    scaleCrop(by: 0.9)
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .buttonStyle(AppIconButtonStyle())
                .accessibilityLabel("トリミング範囲を縮小")

                Button {
                    scaleCrop(by: 1.1)
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .buttonStyle(AppIconButtonStyle())
                .accessibilityLabel("トリミング範囲を拡大")

                Spacer()

                Button {
                    resetCrop()
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(AppIconButtonStyle())
                .accessibilityLabel("トリミング範囲をリセット")
            }
        }
    }

    private var guideTypeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSectionTitle(title: "ガイド種類", eyebrow: "STYLE")

            Picker("ガイド種類", selection: $selectedGuideType) {
                ForEach(GuideType.allCases) { type in
                    Text(type.displayName).tag(type)
                }
            }
            .pickerStyle(.menu)
            .padding(12)
            .background(AppStyle.surface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            HStack {
                Text("セッションID")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Spacer()
                Text(displaySessionId)
                    .font(.subheadline)
                    .bold()
            }
        }
    }

    private var actionSection: some View {
        HStack(spacing: 10) {
            Button {
                generateGuide()
            } label: {
                if isGenerating {
                    ProgressView()
                } else {
                    Label("生成", systemImage: "wand.and.stars")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(AppCompactButtonStyle(filled: selectedImage != nil && !isGenerating))
            .disabled(selectedImage == nil || isGenerating)

            Button {
                saveGuide()
            } label: {
                if isSaving {
                    ProgressView()
                } else {
                    Label("保存", systemImage: "tray.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(AppCompactButtonStyle(filled: canSave))
            .disabled(!canSave || isSaving)
        }
    }

    private var canSave: Bool {
        selectedImage != nil && !generatedGuideImages.isEmpty
    }

    private var selectedGeneratedGuideImage: UIImage? {
        generatedGuideImages[selectedGuideType]
            ?? generatedGuideImages[.silhouette]
            ?? generatedGuideImages[.rectangle]
            ?? generatedGuideImages[.keypoints]
    }

    private var displaySessionId: String {
        sessionId.isEmpty ? "default" : sessionId
    }

    private func generateGuide() {
        guard let selectedImage else { return }
        isGenerating = true
        alertMessage = ""
        showGenerationErrorAlert = false

        let effectiveSessionId = displaySessionId
        let constrainedCropRect = cropRect.constrained()

        Task {
            do {
                let guideUrls = try await SessionAPI.shared.generateGuideSet(
                    sessionId: effectiveSessionId,
                    referenceImage: selectedImage,
                    cropRect: constrainedCropRect
                )

                guard !guideUrls.isEmpty else {
                    throw SessionAPIError.invalidResponse
                }

                var downloadedImages: [GuideType: UIImage] = [:]
                for guideType in GuideType.allCases {
                    guard let guideUrl = guideUrls[guideType] else { continue }
                    downloadedImages[guideType] = try await downloadImage(from: guideUrl)
                }

                await MainActor.run {
                    generatedGuideImages = downloadedImages
                    resetGuideAdjustment()
                }
            } catch {
                await MainActor.run {
                    alertMessage = error.localizedDescription
                    showGenerationErrorAlert = true
                }
            }

            await MainActor.run {
                isGenerating = false
            }
        }
    }

    private func downloadImage(from url: URL) async throws -> UIImage {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw SessionAPIError.requestFailed(statusCode: (response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        guard let uiImage = UIImage(data: data) else {
            throw SessionAPIError.invalidResponse
        }
        return uiImage
    }

    private func placeholderCard(text: String) -> some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(AppStyle.surface)
            .frame(height: 220)
            .overlay {
                Text(text)
                    .foregroundStyle(.secondary)
            }
    }

    private func loadSelectedImage(from item: PhotosPickerItem) async {
        do {
            if let data = try await item.loadTransferable(type: Data.self),
               let uiImage = UIImage(data: data) {
                await MainActor.run {
                    self.selectedImage = uiImage
                    self.generatedGuideImages = [:]
                    self.cropRect = .centered(for: uiImage.size)
                    self.cropDragOffset = .zero
                    resetGuideAdjustment()
                }
            }
        } catch {
            print("画像読み込み失敗: \(error)")
        }
    }

    private func saveGuide() {
        guard let selectedImage,
              !generatedGuideImages.isEmpty else {
            return
        }

        isSaving = true
        var adjustedGuideImages: [GuideType: UIImage] = [:]
        for (guideType, guideImage) in generatedGuideImages {
            adjustedGuideImages[guideType] = renderAdjustedGuideImage(from: guideImage)
        }

        let finalTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "無題のガイド"
            : titleText.trimmingCharacters(in: .whitespacesAndNewlines)

        store.addGuide(
            title: finalTitle,
            referenceImage: selectedImage,
            guideImages: adjustedGuideImages
        )

        isSaving = false
        alertMessage = "ガイドを保存したよ。ShowGuide に表示されるはず！"
        showSaveAlert = true

        resetForm()
    }

    private func resetForm() {
        selectedPhotoItem = nil
        selectedImage = nil
        generatedGuideImages = [:]
        titleText = ""
        cropRect = .centered
        cropDragOffset = .zero
        resetGuideAdjustment()
    }

    private func aspectFitFrame(imageSize: CGSize, containerSize: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0,
              containerSize.width > 0, containerSize.height > 0 else {
            return .zero
        }

        let scale = min(
            containerSize.width / imageSize.width,
            containerSize.height / imageSize.height
        )
        let displayedSize = CGSize(
            width: imageSize.width * scale,
            height: imageSize.height * scale
        )

        return CGRect(
            x: (containerSize.width - displayedSize.width) / 2,
            y: (containerSize.height - displayedSize.height) / 2,
            width: displayedSize.width,
            height: displayedSize.height
        )
    }

    private func resetCrop() {
        guard let selectedImage else {
            cropRect = .centered
            cropDragOffset = .zero
            return
        }

        cropRect = .centered(for: selectedImage.size)
        cropDragOffset = .zero
    }

    private func scaleCrop(by factor: Double) {
        let centerX = cropRect.x + cropRect.width / 2
        let centerY = cropRect.y + cropRect.height / 2
        let minimumWidth = 0.15
        let minimumHeight = 0.15
        let minimumFactor = max(
            minimumWidth / cropRect.width,
            minimumHeight / cropRect.height
        )
        let appliedFactor = max(factor, minimumFactor)

        var newWidth = cropRect.width * appliedFactor
        var newHeight = cropRect.height * appliedFactor

        let maximumFactor = min(
            1.0 / newWidth,
            1.0 / newHeight,
            centerX / (newWidth / 2),
            (1.0 - centerX) / (newWidth / 2),
            centerY / (newHeight / 2),
            (1.0 - centerY) / (newHeight / 2)
        )

        if maximumFactor < 1.0 {
            newWidth *= maximumFactor
            newHeight *= maximumFactor
        }

        cropRect = CropRect(
            x: centerX - newWidth / 2,
            y: centerY - newHeight / 2,
            width: newWidth,
            height: newHeight
        ).constrained()
        cropDragOffset = .zero
    }

    private func resetGuideAdjustment() {
        guideHorizontalOffset = 0.0
        guideScale = 1.0
        guideDragStartOffset = 0.0
        guideScaleStart = 1.0
    }

    private func constrainedGuideOffset(_ value: Double) -> Double {
        min(0.35, max(-0.35, value))
    }

    private func constrainedGuideScale(_ value: Double) -> Double {
        min(1.5, max(0.65, value))
    }

    private func renderAdjustedGuideImage(from guideImage: UIImage) -> UIImage {
        let size = guideImage.size
        let format = UIGraphicsImageRendererFormat()
        format.scale = guideImage.scale
        format.opaque = false

        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            let scale = CGFloat(guideScale)
            let horizontalOffset = CGFloat(guideHorizontalOffset)
            let scaledWidth = size.width * scale
            let scaledHeight = size.height * scale
            let originX = (size.width - scaledWidth) / 2 + size.width * horizontalOffset
            let originY = (size.height - scaledHeight) / 2
            let rect = CGRect(x: originX, y: originY, width: scaledWidth, height: scaledHeight)
            guideImage.draw(in: rect)
        }
    }

    private func makeGuideOverlayImage(from baseImage: UIImage) -> UIImage {
        let size = baseImage.size
        let renderer = UIGraphicsImageRenderer(size: size)

        return renderer.image { context in
            baseImage.draw(in: CGRect(origin: .zero, size: size))

            let cg = context.cgContext

            cg.setStrokeColor(UIColor.systemBlue.withAlphaComponent(0.9).cgColor)
            cg.setLineWidth(max(6, size.width * 0.01))

            let marginX = size.width * 0.18
            let marginY = size.height * 0.12
            let rect = CGRect(
                x: marginX,
                y: marginY,
                width: size.width - marginX * 2,
                height: size.height - marginY * 2
            )
            cg.stroke(rect)

            cg.setStrokeColor(UIColor.systemPink.withAlphaComponent(0.9).cgColor)
            cg.setLineWidth(max(4, size.width * 0.008))
            cg.move(to: CGPoint(x: size.width / 2, y: rect.minY))
            cg.addLine(to: CGPoint(x: size.width / 2, y: rect.maxY))
            cg.move(to: CGPoint(x: rect.minX, y: size.height / 2))
            cg.addLine(to: CGPoint(x: rect.maxX, y: size.height / 2))
            cg.strokePath()

            cg.setFillColor(UIColor.systemYellow.withAlphaComponent(0.95).cgColor)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let circleRect = CGRect(x: center.x - 16, y: center.y - 16, width: 32, height: 32)
            cg.fillEllipse(in: circleRect)

            let text = "GUIDE"
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.boldSystemFont(ofSize: max(28, size.width * 0.05)),
                .foregroundColor: UIColor.white,
                .backgroundColor: UIColor.black.withAlphaComponent(0.45)
            ]
            let attributed = NSAttributedString(string: text, attributes: attrs)
            attributed.draw(at: CGPoint(x: 20, y: 20))
        }
    }
}

#Preview {
    MakeGuide(sessionId: .constant(""))
}
