import SwiftUI
import PhotosUI
import UIKit

struct MakeGuide: View {
    @StateObject private var store = GuideLibraryStore()
    @Binding var sessionId: String

    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var selectedImage: UIImage?
    @State private var generatedGuideImages: [GuideType: UIImage] = [:]
    @State private var generatedGuideId: String?
    @State private var generatedFeaturesUrl: String?
    @State private var isGenerating: Bool = false
    @State private var showGenerationErrorAlert: Bool = false
    @State private var alertMessage: String = ""

    @State private var titleText: String = ""
    @State private var showSaveAlert: Bool = false
    
    @State private var cropRect: CropRect = .centered
    @State private var cropDragOffset: CGSize = .zero
    
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    titleInputSection
                    imagePickerSection
                    if selectedImage != nil {
                        cropImageSection
                    }
                    sessionInfoSection
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

    private var sessionInfoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSectionTitle(title: "保存内容", eyebrow: "GUIDE SET")

            Text("生成すると、枠・キーポイント・シルエットの3種類をまとめて保存します。")
                .font(.subheadline)
                .foregroundColor(.secondary)

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
        Button {
            generateGuide()
        } label: {
            if isGenerating {
                ProgressView()
            } else {
                Label("3種類を生成して保存", systemImage: "wand.and.stars")
                    .frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(AppCompactButtonStyle(filled: selectedImage != nil && !isGenerating))
        .disabled(selectedImage == nil || isGenerating)
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
                let generatedGuideSet = try await SessionAPI.shared.generateGuideSet(
                    sessionId: effectiveSessionId,
                    referenceImage: selectedImage,
                    cropRect: constrainedCropRect
                )

                guard !generatedGuideSet.urls.isEmpty else {
                    throw SessionAPIError.invalidResponse
                }

                var downloadedImages: [GuideType: UIImage] = [:]
                for guideType in GuideType.allCases {
                    guard let guideUrl = generatedGuideSet.urls[guideType] else { continue }
                    downloadedImages[guideType] = try await downloadImage(from: guideUrl)
                }

                guard downloadedImages.count == GuideType.allCases.count else {
                    throw SessionAPIError.invalidResponse
                }

                await MainActor.run {
                    generatedGuideImages = downloadedImages
                    generatedGuideId = generatedGuideSet.guideId
                    generatedFeaturesUrl = generatedGuideSet.featuresUrl
                    saveGuide()
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
                    self.generatedGuideId = nil
                    self.generatedFeaturesUrl = nil
                    self.cropRect = .centered(for: uiImage.size)
                    self.cropDragOffset = .zero
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

        let finalTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "無題のガイド"
            : titleText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard store.addGuide(
            title: finalTitle,
            referenceImage: selectedImage,
            guideImages: generatedGuideImages,
            guideId: generatedGuideId,
            featuresUrl: generatedFeaturesUrl
        ) != nil else {
            alertMessage = "3種類のガイドを端末に保存できませんでした。"
            showGenerationErrorAlert = true
            return
        }

        alertMessage = "枠・キーポイント・シルエットの3種類を保存しました。"
        showSaveAlert = true

        resetForm()
    }

    private func resetForm() {
        selectedPhotoItem = nil
        selectedImage = nil
        generatedGuideImages = [:]
        generatedGuideId = nil
        generatedFeaturesUrl = nil
        titleText = ""
        cropRect = .centered
        cropDragOffset = .zero
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

}

#Preview {
    MakeGuide(sessionId: .constant(""))
}
