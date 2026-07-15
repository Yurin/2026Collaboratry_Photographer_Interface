import SwiftUI
import UIKit

struct GuideItem: Identifiable, Codable, Hashable {
    let id: UUID
    var title: String
    var guideId: String?
    var featuresUrl: String?
    var referenceImagePath: String?
    var guideImagePath: String?
    var rectangleGuideImagePath: String?
    var keypointsGuideImagePath: String?
    var silhouetteGuideImagePath: String?
    var createdAt: Date

    var referenceUIImage: UIImage? {
        loadImage(from: referenceImagePath)
    }

    var guideUIImage: UIImage? {
        loadImage(from: silhouetteGuideImagePath)
            ?? loadImage(from: rectangleGuideImagePath)
            ?? loadImage(from: keypointsGuideImagePath)
            ?? loadImage(from: guideImagePath)
    }

    func guideUIImage(for type: GuideType) -> UIImage? {
        switch type {
        case .rectangle:
            return loadImage(from: rectangleGuideImagePath) ?? guideUIImage
        case .keypoints:
            return loadImage(from: keypointsGuideImagePath) ?? guideUIImage
        case .silhouette:
            return loadImage(from: silhouetteGuideImagePath) ?? guideUIImage
        }
    }

    private func loadImage(from relativePath: String?) -> UIImage? {
        guard let relativePath else { return nil }

        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(relativePath)

        return UIImage(contentsOfFile: url.path)
    }
}

final class GuideLibraryStore: ObservableObject {
    @Published var guides: [GuideItem] = []

    private let jsonFileName = "guides.json"

    init() {
        load()
    }

    func load() {
        let url = documentsDirectory.appendingPathComponent(jsonFileName)

        guard FileManager.default.fileExists(atPath: url.path) else {
            guides = []
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode([GuideItem].self, from: data)
            guides = decoded.sorted { $0.createdAt > $1.createdAt }
        } catch {
            print("guides.json の読み込み失敗: \(error)")
            guides = []
        }
    }

    func save() {
        let url = documentsDirectory.appendingPathComponent(jsonFileName)

        do {
            let data = try JSONEncoder().encode(guides)
            try data.write(to: url, options: .atomic)
        } catch {
            print("guides.json の保存失敗: \(error)")
        }
    }

    @discardableResult
    func addGuide(title: String, referenceImage: UIImage, guideImage: UIImage) -> GuideItem? {
        addGuide(title: title, referenceImage: referenceImage, guideImages: [.silhouette: guideImage])
    }

    @discardableResult
    func addGuide(
        title: String,
        referenceImage: UIImage,
        guideImages: [GuideType: UIImage],
        guideId: String? = nil,
        featuresUrl: String? = nil
    ) -> GuideItem? {
        let id = UUID()

        guard let referenceImagePath = saveImage(referenceImage, fileName: "reference_\(id.uuidString).jpg") else {
            print("画像保存失敗")
            return nil
        }

        let rectanglePath = saveGuideImage(guideImages[.rectangle], type: .rectangle, id: id)
        let keypointsPath = saveGuideImage(guideImages[.keypoints], type: .keypoints, id: id)
        let silhouettePath = saveGuideImage(guideImages[.silhouette], type: .silhouette, id: id)
        let fallbackGuidePath = silhouettePath ?? rectanglePath ?? keypointsPath

        guard fallbackGuidePath != nil else {
            let refURL = documentsDirectory.appendingPathComponent(referenceImagePath)
            try? FileManager.default.removeItem(at: refURL)
            print("ガイド画像保存失敗")
            return nil
        }

        let newGuide = GuideItem(
            id: id,
            title: title,
            guideId: guideId,
            featuresUrl: featuresUrl,
            referenceImagePath: referenceImagePath,
            guideImagePath: fallbackGuidePath,
            rectangleGuideImagePath: rectanglePath,
            keypointsGuideImagePath: keypointsPath,
            silhouetteGuideImagePath: silhouettePath,
            createdAt: Date()
        )

        guides.insert(newGuide, at: 0)
        save()
        return newGuide
    }

    func deleteGuide(_ guide: GuideItem) {
        if let refPath = guide.referenceImagePath {
            let refURL = documentsDirectory.appendingPathComponent(refPath)
            try? FileManager.default.removeItem(at: refURL)
        }

        let guidePaths = [
            guide.guideImagePath,
            guide.rectangleGuideImagePath,
            guide.keypointsGuideImagePath,
            guide.silhouetteGuideImagePath
        ]
        for guidePath in Set(guidePaths.compactMap { $0 }) {
            let guideURL = documentsDirectory.appendingPathComponent(guidePath)
            try? FileManager.default.removeItem(at: guideURL)
        }

        guides.removeAll { $0.id == guide.id }
        save()
    }

    private func saveGuideImage(_ image: UIImage?, type: GuideType, id: UUID) -> String? {
        guard let image else { return nil }
        return saveImage(image, fileName: "guide_\(type.rawValue)_\(id.uuidString).png")
    }

    @discardableResult
    private func saveImage(_ image: UIImage, fileName: String) -> String? {
        let url = documentsDirectory.appendingPathComponent(fileName)

        let data: Data?
        if fileName.lowercased().hasSuffix(".png") {
            data = image.pngData()
        } else {
            data = image.jpegData(compressionQuality: 0.9)
        }

        guard let data else { return nil }

        do {
            try data.write(to: url, options: .atomic)
            return fileName
        } catch {
            print("画像ファイル保存失敗: \(error)")
            return nil
        }
    }

    private var documentsDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
}
