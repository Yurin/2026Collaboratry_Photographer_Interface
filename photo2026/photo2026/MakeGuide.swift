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
    @State private var croppedPreviewImage: UIImage?
    @State private var showCropEditor = false
    @State private var hasConfirmedCrop = false
    
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
            .fullScreenCover(isPresented: $showCropEditor) {
                if let selectedImage {
                    CropEditorView(image: selectedImage, initialCrop: cropRect) { updatedCrop in
                        cropRect = updatedCrop
                        croppedPreviewImage = renderCroppedPreview(
                            image: selectedImage,
                            cropRect: updatedCrop
                        )
                        hasConfirmedCrop = true
                    }
                }
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
            AppSectionTitle(title: "最終プレビュー", eyebrow: "3 : 4 CROP")

            if let croppedPreviewImage {
                Image(uiImage: croppedPreviewImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .aspectRatio(3.0 / 4.0, contentMode: .fit)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(AppStyle.border, lineWidth: 1)
                    }
            }

            if !hasConfirmedCrop {
                Label("トリミング範囲を決定してください", systemImage: "exclamationmark.circle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(AppStyle.warning)
            }

            Button {
                showCropEditor = true
            } label: {
                Label("トリミングを変更", systemImage: "crop")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(AppSecondaryButtonStyle())
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
        .buttonStyle(AppCompactButtonStyle(
            filled: selectedImage != nil && hasConfirmedCrop && !isGenerating
        ))
        .disabled(selectedImage == nil || !hasConfirmedCrop || isGenerating)
    }

    private var displaySessionId: String {
        sessionId.isEmpty ? "default" : sessionId
    }

    private func generateGuide() {
        guard let selectedImage, hasConfirmedCrop else { return }
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
                    let initialCrop = CropRect.centered(for: uiImage.size)
                    self.cropRect = initialCrop
                    self.croppedPreviewImage = renderCroppedPreview(
                        image: uiImage,
                        cropRect: initialCrop
                    )
                    self.hasConfirmedCrop = false
                    self.showCropEditor = true
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
        croppedPreviewImage = nil
        showCropEditor = false
        hasConfirmedCrop = false
    }

    private func renderCroppedPreview(image: UIImage, cropRect: CropRect) -> UIImage? {
        let crop = cropRect.constrained()
        guard image.size.width > 0, image.size.height > 0,
              crop.width > 0, crop.height > 0 else {
            return nil
        }

        let outputSize = CGSize(width: 450, height: 600)
        let sourceCrop = CGRect(
            x: image.size.width * crop.x,
            y: image.size.height * crop.y,
            width: image.size.width * crop.width,
            height: image.size.height * crop.height
        )
        let scaleX = outputSize.width / sourceCrop.width
        let scaleY = outputSize.height / sourceCrop.height
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: outputSize, format: format).image { _ in
            UIColor.black.setFill()
            UIRectFill(CGRect(origin: .zero, size: outputSize))
            image.draw(
                in: CGRect(
                    x: -sourceCrop.minX * scaleX,
                    y: -sourceCrop.minY * scaleY,
                    width: image.size.width * scaleX,
                    height: image.size.height * scaleY
                )
            )
        }
    }

}

#Preview {
    MakeGuide(sessionId: .constant(""))
}
