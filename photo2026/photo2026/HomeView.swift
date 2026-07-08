import SwiftUI
import UIKit

struct HomeView: View {
    @Binding var selectedIndex: Int
    @Binding var resetID: UUID
    @Binding var pendingSelectedGuides: [GuideItem]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("PHOTO GUIDE")
                        .font(.system(size: 34, weight: .black, design: .rounded))
                        .tracking(-1.2)
                        .foregroundStyle(.white)

                    Text("ふたりで、狙った一枚を。")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppStyle.secondaryText)
                }
                .padding(.top, 22)

                VStack(spacing: 12) {
                    Button {
                        resetID = UUID()
                        selectedIndex = TabbarItem.photo.rawValue
                    } label: {
                        HomeActionCard(
                            title: "撮影を始める",
                            subtitle: "相手とつないで撮影セッションへ",
                            systemImage: "camera.fill",
                            isPrimary: true
                        )
                    }
                    .buttonStyle(.plain)

                    Button {
                        selectedIndex = TabbarItem.guide.rawValue
                    } label: {
                        HomeActionCard(
                            title: "ガイドを作る",
                            subtitle: "お手本写真から構図を準備",
                            systemImage: "wand.and.stars",
                            isPrimary: false
                        )
                    }
                    .buttonStyle(.plain)

                    Button {
                        selectedIndex = TabbarItem.template.rawValue
                    } label: {
                        HomeActionCard(
                            title: "シーンから選ぶ",
                            subtitle: "カフェ・自宅・屋外の定番構図をすぐ使う",
                            systemImage: "person.crop.rectangle",
                            isPrimary: false
                        )
                    }
                    .buttonStyle(.plain)

                    Button {
                        selectedIndex = TabbarItem.showGuide.rawValue
                    } label: {
                        HomeActionCard(
                            title: "保存したガイド",
                            subtitle: "作成したお手本を選んで撮影",
                            systemImage: "square.grid.2x2.fill",
                            isPrimary: false
                        )
                    }
                    .buttonStyle(.plain)
                }

                VStack(alignment: .leading, spacing: 16) {
                    AppSectionTitle(title: "かんたん3ステップ", eyebrow: "HOW IT WORKS")

                    VStack(spacing: 14) {
                        StepRow(number: "1", title: "お手本画像を選ぶ", description: "撮りたい構図やポーズを決めます")
                        StepRow(number: "2", title: "ガイドを準備する", description: "写真生成またはシーン別テンプレートを選びます")
                        StepRow(number: "3", title: "ふたりで合わせる", description: "画面を見ながら位置やポーズを調整します")
                    }
                }
                .appCard()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 110)
        }
        .background(AppStyle.background)
    }
}

struct SceneTemplateView: View {
    @Binding var selectedIndex: Int
    @Binding var resetID: UUID
    @Binding var pendingSelectedGuides: [GuideItem]

    @StateObject private var store = GuideLibraryStore()
    @State private var selectedSceneID: String = PortraitSceneTemplateCatalog.scenes.first?.id ?? "cafe"
    @State private var statusMessage: String?

    private var selectedScene: PortraitScene {
        PortraitSceneTemplateCatalog.scenes.first { $0.id == selectedSceneID }
            ?? PortraitSceneTemplateCatalog.scenes[0]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                sceneSelector
                templateGrid

                if let statusMessage {
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(AppStyle.secondaryText)
                        .padding(.horizontal, 2)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 110)
        }
        .background(AppStyle.background)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SCENE TEMPLATES")
                .font(.caption.weight(.black))
                .tracking(1.4)
                .foregroundStyle(AppStyle.secondaryText)

            Text("シーンからガイドを選ぶ")
                .font(.system(size: 28, weight: .black, design: .rounded))
                .foregroundStyle(.white)

            Text("参照写真がない時でも、定番の構図ガイドを選んでそのまま撮影に進めます。")
                .font(.subheadline)
                .foregroundStyle(AppStyle.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var sceneSelector: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(PortraitSceneTemplateCatalog.scenes) { scene in
                    Button {
                        selectedSceneID = scene.id
                    } label: {
                        Label(scene.name, systemImage: scene.systemImage)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(selectedSceneID == scene.id ? Color.black : AppStyle.primaryText)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(selectedSceneID == scene.id ? Color.white : AppStyle.surface)
                            .clipShape(Capsule())
                            .overlay {
                                Capsule().stroke(AppStyle.border, lineWidth: selectedSceneID == scene.id ? 0 : 1)
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private var templateGrid: some View {
        VStack(alignment: .leading, spacing: 14) {
            AppSectionTitle(title: selectedScene.name, eyebrow: selectedScene.subtitle)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                ForEach(selectedScene.templates) { template in
                    Button {
                        useTemplate(template, scene: selectedScene)
                    } label: {
                        TemplateCard(template: template)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func useTemplate(_ template: PortraitGuideTemplate, scene: PortraitScene) {
        let renderer = PortraitTemplateRenderer(template: template, scene: scene)
        let referenceImage = renderer.makeReferenceImage()
        let guideImage = renderer.makeGuideImage()
        let title = "\(scene.name)・\(template.title)"

        guard let guide = store.addGuide(
            title: title,
            referenceImage: referenceImage,
            guideImages: [
                .rectangle: guideImage,
                .keypoints: guideImage,
                .silhouette: guideImage
            ]
        ) else {
            statusMessage = "テンプレートガイドを保存できませんでした。"
            return
        }

        pendingSelectedGuides = [guide]
        resetID = UUID()
        selectedIndex = TabbarItem.photo.rawValue
    }
}

struct TemplateCard: View {
    let template: PortraitGuideTemplate

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(template.accent.opacity(0.22))
                    .aspectRatio(3 / 4, contentMode: .fit)

                TemplateGuidePreview(style: template.style, accent: template.accent)
                    .padding(14)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(AppStyle.border, lineWidth: 1)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(template.title)
                    .font(.subheadline.weight(.black))
                    .foregroundStyle(AppStyle.primaryText)
                    .lineLimit(1)

                Text(template.hint)
                    .font(.caption)
                    .foregroundStyle(AppStyle.secondaryText)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .background(AppStyle.surface)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(AppStyle.border, lineWidth: 1)
        }
    }
}

struct TemplateGuidePreview: View {
    let style: PortraitTemplateStyle
    let accent: Color

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                PortraitTemplateDrawing.draw(style: style, in: CGRect(origin: .zero, size: size), context: &context, accent: accent)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .aspectRatio(3 / 4, contentMode: .fit)
    }
}

struct PortraitScene: Identifiable {
    let id: String
    let name: String
    let subtitle: String
    let systemImage: String
    let templates: [PortraitGuideTemplate]
}

struct PortraitGuideTemplate: Identifiable {
    let id: String
    let title: String
    let hint: String
    let style: PortraitTemplateStyle
    let accent: Color
}

enum PortraitTemplateStyle {
    case cafeSeated
    case homeWindow
    case carSeat
    case outdoorWalk
}

enum PortraitSceneTemplateCatalog {
    static let scenes: [PortraitScene] = [
        PortraitScene(
            id: "cafe",
            name: "カフェ",
            subtitle: "TABLE / SEAT",
            systemImage: "cup.and.saucer.fill",
            templates: [
                PortraitGuideTemplate(id: "cafe-seated", title: "テーブル越し", hint: "少し斜めに座り、顔を明るい方へ向ける", style: .cafeSeated, accent: Color(red: 0.96, green: 0.74, blue: 0.42)),
                PortraitGuideTemplate(id: "cafe-close", title: "上半身寄り", hint: "目線を外して余白を少し残す", style: .homeWindow, accent: Color(red: 0.56, green: 0.82, blue: 0.76))
            ]
        ),
        PortraitScene(
            id: "home",
            name: "自宅",
            subtitle: "WINDOW / ROOM",
            systemImage: "house.fill",
            templates: [
                PortraitGuideTemplate(id: "home-window", title: "窓ぎわ", hint: "窓光を横から受けて自然な立ち姿にする", style: .homeWindow, accent: Color(red: 0.50, green: 0.66, blue: 0.98)),
                PortraitGuideTemplate(id: "home-seat", title: "くつろぎ座り", hint: "体を少し傾けて手元に余白を作る", style: .cafeSeated, accent: Color(red: 0.72, green: 0.64, blue: 0.95))
            ]
        ),
        PortraitScene(
            id: "car",
            name: "車内",
            subtitle: "SEAT / WINDOW",
            systemImage: "car.fill",
            templates: [
                PortraitGuideTemplate(id: "car-seat", title: "助手席", hint: "窓側に顔を向け、肩のラインを斜めにする", style: .carSeat, accent: Color(red: 0.94, green: 0.52, blue: 0.52))
            ]
        ),
        PortraitScene(
            id: "outdoor",
            name: "屋外",
            subtitle: "STREET / TRAVEL",
            systemImage: "leaf.fill",
            templates: [
                PortraitGuideTemplate(id: "outdoor-walk", title: "歩き姿", hint: "進行方向に余白を作り、全身を少し小さめに入れる", style: .outdoorWalk, accent: Color(red: 0.45, green: 0.84, blue: 0.52)),
                PortraitGuideTemplate(id: "outdoor-stand", title: "背景込み", hint: "人物を三分割線に置き、背景を広く見せる", style: .homeWindow, accent: Color(red: 0.48, green: 0.76, blue: 0.94))
            ]
        )
    ]
}

enum PortraitTemplateDrawing {
    static func draw(style: PortraitTemplateStyle, in rect: CGRect, context: inout GraphicsContext, accent: Color) {
        drawThirds(in: rect, context: &context)

        switch style {
        case .cafeSeated:
            drawTable(in: rect, context: &context, accent: accent)
            drawPerson(in: rect.offsetBy(dx: rect.width * -0.08, dy: rect.height * 0.04), context: &context, accent: accent, scale: 0.92)
        case .homeWindow:
            drawWindow(in: rect, context: &context, accent: accent)
            drawPerson(in: rect.offsetBy(dx: rect.width * 0.11, dy: rect.height * 0.02), context: &context, accent: accent, scale: 1.0)
        case .carSeat:
            drawSeat(in: rect, context: &context, accent: accent)
            drawPerson(in: rect.offsetBy(dx: rect.width * 0.08, dy: rect.height * 0.02), context: &context, accent: accent, scale: 0.88)
        case .outdoorWalk:
            drawPath(in: rect, context: &context, accent: accent)
            drawPerson(in: rect.offsetBy(dx: rect.width * -0.12, dy: rect.height * 0.08), context: &context, accent: accent, scale: 0.82)
        }
    }

    private static func drawThirds(in rect: CGRect, context: inout GraphicsContext) {
        var path = Path()
        for ratio in [1.0 / 3.0, 2.0 / 3.0] {
            path.move(to: CGPoint(x: rect.minX + rect.width * ratio, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX + rect.width * ratio, y: rect.maxY))
            path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * ratio))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * ratio))
        }
        context.stroke(path, with: .color(.white.opacity(0.22)), lineWidth: 1)
    }

    private static func drawPerson(in rect: CGRect, context: inout GraphicsContext, accent: Color, scale: CGFloat) {
        let centerX = rect.midX
        let headRadius = rect.width * 0.09 * scale
        let headCenter = CGPoint(x: centerX, y: rect.minY + rect.height * 0.28)
        let bodyTop = CGPoint(x: centerX, y: headCenter.y + headRadius * 1.35)
        let bodyBottom = CGPoint(x: centerX, y: rect.minY + rect.height * 0.68)

        var silhouette = Path()
        silhouette.addEllipse(in: CGRect(x: headCenter.x - headRadius, y: headCenter.y - headRadius, width: headRadius * 2, height: headRadius * 2))
        silhouette.move(to: bodyTop)
        silhouette.addQuadCurve(to: CGPoint(x: centerX - rect.width * 0.20 * scale, y: bodyBottom.y), control: CGPoint(x: centerX - rect.width * 0.24 * scale, y: rect.minY + rect.height * 0.46))
        silhouette.addLine(to: CGPoint(x: centerX + rect.width * 0.20 * scale, y: bodyBottom.y))
        silhouette.addQuadCurve(to: bodyTop, control: CGPoint(x: centerX + rect.width * 0.24 * scale, y: rect.minY + rect.height * 0.46))

        context.fill(silhouette, with: .color(accent.opacity(0.22)))
        context.stroke(silhouette, with: .color(accent.opacity(0.95)), lineWidth: 3)

        var pose = Path()
        pose.move(to: bodyTop)
        pose.addLine(to: bodyBottom)
        pose.move(to: CGPoint(x: centerX - rect.width * 0.18 * scale, y: rect.minY + rect.height * 0.46))
        pose.addLine(to: CGPoint(x: centerX + rect.width * 0.18 * scale, y: rect.minY + rect.height * 0.43))
        context.stroke(pose, with: .color(.white.opacity(0.64)), lineWidth: 2)
    }

    private static func drawTable(in rect: CGRect, context: inout GraphicsContext, accent: Color) {
        let table = CGRect(x: rect.minX + rect.width * 0.08, y: rect.minY + rect.height * 0.72, width: rect.width * 0.84, height: rect.height * 0.08)
        context.fill(Path(roundedRect: table, cornerRadius: 8), with: .color(.white.opacity(0.12)))
        context.stroke(Path(roundedRect: table, cornerRadius: 8), with: .color(accent.opacity(0.55)), lineWidth: 2)
    }

    private static func drawWindow(in rect: CGRect, context: inout GraphicsContext, accent: Color) {
        let window = CGRect(x: rect.minX + rect.width * 0.08, y: rect.minY + rect.height * 0.10, width: rect.width * 0.28, height: rect.height * 0.36)
        context.stroke(Path(roundedRect: window, cornerRadius: 8), with: .color(accent.opacity(0.55)), lineWidth: 2)
    }

    private static func drawSeat(in rect: CGRect, context: inout GraphicsContext, accent: Color) {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.18, y: rect.minY + rect.height * 0.32))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.72, y: rect.minY + rect.height * 0.46))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.86, y: rect.minY + rect.height * 0.82))
        context.stroke(path, with: .color(accent.opacity(0.55)), lineWidth: 3)
    }

    private static func drawPath(in rect: CGRect, context: inout GraphicsContext, accent: Color) {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.40, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.58, y: rect.minY))
        context.stroke(path, with: .color(accent.opacity(0.5)), lineWidth: 3)
    }
}

@MainActor
struct PortraitTemplateRenderer {
    let template: PortraitGuideTemplate
    let scene: PortraitScene

    func makeReferenceImage() -> UIImage {
        render(opaque: true)
    }

    func makeGuideImage() -> UIImage {
        render(opaque: false)
    }

    private func render(opaque: Bool) -> UIImage {
        let size = CGSize(width: 900, height: 1200)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            let cg = context.cgContext
            let rect = CGRect(origin: .zero, size: size)

            if opaque {
                UIColor(white: 0.08, alpha: 1).setFill()
                cg.fill(rect)
            } else {
                cg.clear(rect)
            }

            let hosting = ImageRenderer(content: TemplateGuidePreview(style: template.style, accent: template.accent).frame(width: size.width, height: size.height))
            hosting.scale = 1
            if let image = hosting.uiImage {
                image.draw(in: rect)
            }
        }
    }
}

struct HomeActionCard: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let isPrimary: Bool

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(isPrimary ? Color.black : AppStyle.elevatedSurface)
                    .frame(width: 54, height: 54)

                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(isPrimary ? .white : AppStyle.primaryText)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline.weight(.black))
                    .foregroundStyle(isPrimary ? .black : AppStyle.primaryText)

                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(isPrimary ? Color.black.opacity(0.6) : AppStyle.secondaryText)
                    .multilineTextAlignment(.leading)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.subheadline.weight(.black))
                .foregroundStyle(isPrimary ? Color.black.opacity(0.55) : AppStyle.secondaryText)
        }
        .padding(16)
        .background(isPrimary ? Color.white : AppStyle.surface)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(isPrimary ? Color.clear : AppStyle.border, lineWidth: 1)
        }
    }
}

struct StepRow: View {
    let number: String
    let title: String
    let description: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.subheadline.weight(.black))
                .foregroundStyle(.black)
                .frame(width: 30, height: 30)
                .background(Color.white)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)

                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(AppStyle.secondaryText)
            }

            Spacer()
        }
    }
}
