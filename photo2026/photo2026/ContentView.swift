import SwiftUI

struct ContentView: View {
    @State private var selectedIndex = TabbarItem.home.rawValue
    @State private var takePhotoResetID = UUID()
    @State private var pendingSelectedGuides: [GuideItem] = []
    @State private var sessionId: String = ""
    @StateObject private var experimentState = ExperimentState()

    var body: some View {
        ZStack(alignment: .bottom) {
            AppStyle.background.ignoresSafeArea()

            TabView(selection: $selectedIndex) {
                HomeView(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    pendingSelectedGuides: $pendingSelectedGuides
                )
                .tag(TabbarItem.home.rawValue)

                TakePhoto(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    sessionId: $sessionId,
                    selectedGuides: pendingSelectedGuides,
                    experimentState: experimentState
                )
                .id(takePhotoResetID)
                .tag(TabbarItem.photo.rawValue)

                MakeGuide(sessionId: $sessionId)
                    .tag(TabbarItem.guide.rawValue)

                SceneTemplateView(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    pendingSelectedGuides: $pendingSelectedGuides
                )
                .tag(TabbarItem.template.rawValue)

                ShowGuide(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    pendingSelectedGuides: $pendingSelectedGuides
                )
                .tag(TabbarItem.showGuide.rawValue)
                
                ReceivedPhotosView(sessionId: $sessionId)
                .tag(TabbarItem.receivedPhotos.rawValue)

                ExperimentSetupView(
                    experimentState: experimentState,
                    sessionId: $sessionId,
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID
                )
                .tag(TabbarItem.experiment.rawValue)
            }

            HStack(spacing: 0) {
                ForEach(TabbarItem.allCases, id: \.self) { item in
                    Button {
                        selectedIndex = item.rawValue
                    } label: {
                        tabItemView(
                            tabbarItem: item,
                            isActive: selectedIndex == item.rawValue
                        )
                    }
                }
            }
            .padding(5)
            .frame(height: 62)
            .background(.ultraThinMaterial)
            .clipShape(Capsule())
            .overlay {
                Capsule().stroke(AppStyle.border, lineWidth: 1)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        .appScreen()
    }

    func tabItemView(tabbarItem: TabbarItem, isActive: Bool) -> some View {
        VStack(spacing: 3) {
            Image(systemName: tabbarItem.iconName)
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(isActive ? .black : AppStyle.secondaryText)

            Text(tabbarItem.title)
                .lineLimit(1)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(isActive ? .black : AppStyle.secondaryText)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .background(isActive ? Color.white : Color.clear)
        .clipShape(Capsule())
    }
}

enum TabbarItem: Int, CaseIterable {
    case home
    case photo
    case guide
    case template
    case showGuide
    case receivedPhotos
    case experiment

    static var allCases: [TabbarItem] {
        [.home, .photo, .guide, .showGuide, .receivedPhotos, .experiment]
    }

    var title: String {
        switch self {
        case .home:
            return "ホーム"
        case .photo:
            return "写真"
        case .guide:
            return "ガイド作成"
        case .template:
            return "テンプレ"
        case .showGuide:
            return "ライブラリ"
        case .receivedPhotos:
            return "写真一覧"
        case .experiment:
            return "実験"
        }
    }

    var iconName: String {
        switch self {
        case .home:
            return "house.fill"
        case .photo:
            return "camera.fill"
        case .guide:
            return "wand.and.stars"
        case .template:
            return "person.crop.rectangle"
        case .showGuide:
            return "square.grid.2x2.fill"
        case .receivedPhotos:
            return "photo.on.rectangle"
        case .experiment:
            return "flask.fill"
        }
    }
}

#Preview {
    ContentView()
}
