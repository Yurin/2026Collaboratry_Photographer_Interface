import SwiftUI
import Photos
import UIKit

struct ReceivedPhotosView: View {
    @Binding var sessionId: String
    let refreshRequest: Int
    
    @State private var photos: [PhotoFile] = []
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if isLoading {
                    Spacer()
                    ProgressView("写真を読み込み中...")
                    Spacer()
                } else if photos.isEmpty {
                    Spacer()
                    VStack(spacing: 12) {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.system(size: 44))
                            .foregroundColor(AppStyle.secondaryText)

                        Text("受信した写真がありません")
                            .font(.headline)

                        Text("撮影者から届いた写真がここに表示されます")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)

                        Button("更新") {
                            Task { await fetchPhotos() }
                        }
                        .buttonStyle(AppSecondaryButtonStyle())
                        .padding(.top, 8)
                    }
                    .padding()
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(photos, id: \.filename) { photo in
                                VStack(alignment: .leading, spacing: 10) {
                                    AsyncImage(url: URL(string: photo.url)) { phase in
                                        switch phase {
                                        case .empty:
                                            ZStack {
                                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                                    .fill(AppStyle.surface)
                                                ProgressView()
                                            }
                                            .frame(height: 240)

                                        case .success(let image):
                                            image
                                                .resizable()
                                                .scaledToFit()
                                                .frame(maxWidth: .infinity)
                                                .background(AppStyle.surface)
                                                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

                                        case .failure:
                                            ZStack {
                                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                                    .fill(AppStyle.surface)
                                                Text("画像を読み込めませんでした")
                                                    .foregroundColor(.red)
                                            }
                                            .frame(height: 240)

                                        @unknown default:
                                            EmptyView()
                                        }
                                    }

                                    HStack {
                                        Text(photo.filename)
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                            .lineLimit(1)

                                        Spacer()

                                        Button {
                                            Task {
                                                await saveOnePhoto(photo)
                                            }
                                        } label: {
                                            Text("保存")
                                                .fontWeight(.semibold)
                                                .padding(.horizontal, 14)
                                                .padding(.vertical, 8)
                                                .background(Color.white)
                                                .foregroundColor(.black)
                                                .clipShape(Capsule())
                                        }
                                        .disabled(isSaving)
                                    }
                                }
                                .padding(.horizontal, 16)
                            }
                        }
                        .padding(.vertical, 16)
                    }

                    VStack(spacing: 10) {
                        if let message {
                            Text(message)
                                .font(.footnote)
                                .foregroundColor(message.contains("失敗") || message.contains("許可") ? .red : .secondary)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 16)
                        }

                        HStack(spacing: 12) {
                            Button {
                                Task { await fetchPhotos() }
                            } label: {
                                Text("更新")
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(AppStyle.elevatedSurface)
                                    .foregroundColor(.primary)
                                    .clipShape(Capsule())
                            }

                            Button {
                                Task {
                                    await saveAllPhotos()
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    if isSaving {
                                        ProgressView()
                                            .tint(.white)
                                    }
                                    Text(isSaving ? "保存中..." : "すべて保存")
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(isSaving ? AppStyle.surface : Color.white)
                                .foregroundColor(isSaving ? .secondary : .black)
                                .clipShape(Capsule())
                            }
                            .disabled(isSaving || photos.isEmpty)
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 10)
                    }
                    .padding(.top, 8)
                    .background(AppStyle.background)
                }
            }
            .background(AppStyle.background)
            .navigationTitle("届いた写真")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await fetchPhotos()
            }
            .refreshable {
                await fetchPhotos()
            }
            .onChange(of: sessionId) { _, _ in
                Task { await fetchPhotos() }
            }
            .onChange(of: refreshRequest) { _, _ in
                Task { await fetchPhotos() }
            }
        }
    }

    private func fetchPhotos() async {
        guard !sessionId.isEmpty else {
            message = "セッションIDが設定されていません"
            return
        }
        
        isLoading = true
        message = nil

        do {
            let photoFiles = try await SessionAPI.shared.fetchPhotos(sessionId: sessionId)
            // filename にタイムスタンプが入っているので新しい順に並べる
            photos = photoFiles.sorted { $0.filename > $1.filename }
        } catch {
            message = "取得エラー: \(error.localizedDescription)"
        }

        isLoading = false
    }

    private func saveOnePhoto(_ photo: PhotoFile) async {
        guard let url = URL(string: photo.url) else {
            message = "画像URLが不正です"
            return
        }

        isSaving = true
        message = nil

        do {
            let allowed = await requestPhotoAccess()
            guard allowed else {
                isSaving = false
                message = "写真アプリへのアクセスが許可されていないため保存できませんでした。"
                return
            }

            let image = try await downloadImage(from: url)
            try await saveImageToPhotoLibrary(image)
            message = "1枚保存しました"
        } catch {
            message = "保存に失敗しました: \(error.localizedDescription)"
        }

        isSaving = false
    }

    private func saveAllPhotos() async {
        guard !photos.isEmpty else { return }

        isSaving = true
        message = nil

        do {
            let allowed = await requestPhotoAccess()
            guard allowed else {
                isSaving = false
                message = "写真アプリへのアクセスが許可されていないため保存できませんでした。"
                return
            }

            var images: [UIImage] = []
            for photo in photos {
                guard let url = URL(string: photo.url) else { continue }
                let image = try await downloadImage(from: url)
                images.append(image)
            }

            try await saveImagesToPhotoLibrary(images)
            message = "\(images.count)枚保存しました"
        } catch {
            message = "保存に失敗しました: \(error.localizedDescription)"
        }

        isSaving = false
    }

    private func downloadImage(from url: URL) async throws -> UIImage {
        let (data, response) = try await URLSession.shared.data(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              200..<300 ~= httpResponse.statusCode else {
            throw NSError(domain: "DownloadError", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "画像のダウンロードに失敗しました"
            ])
        }

        guard let image = UIImage(data: data) else {
            throw NSError(domain: "ImageDecodeError", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "画像の変換に失敗しました"
            ])
        }

        return image
    }

    private func requestPhotoAccess() async -> Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)

        switch status {
        case .authorized, .limited:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { newStatus in
                    continuation.resume(returning: newStatus == .authorized || newStatus == .limited)
                }
            }
        default:
            return false
        }
    }
    private func saveImageToPhotoLibrary(_ image: UIImage) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume(returning: ())
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "PhotoSaveError",
                        code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "写真の保存に失敗しました"]
                    ))
                }
            }
        }
    }

    private func saveImagesToPhotoLibrary(_ images: [UIImage]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                for image in images {
                    PHAssetChangeRequest.creationRequestForAsset(from: image)
                }
            }) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume(returning: ())
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "PhotoSaveError",
                        code: 4,
                        userInfo: [NSLocalizedDescriptionKey: "写真の一括保存に失敗しました"]
                    ))
                }
            }
        }
    }
}
