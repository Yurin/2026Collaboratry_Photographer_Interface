import SwiftUI

struct HomeView: View {
    @Binding var selectedIndex: Int
    @Binding var resetID: UUID

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
                        StepRow(number: "2", title: "ガイドを生成する", description: "写真をもとに撮影用ガイドを作ります")
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
