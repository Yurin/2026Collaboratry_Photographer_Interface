import SwiftUI
import UIKit

struct ShowGuide: View {
    @Binding var selectedIndex: Int
    @Binding var resetID: UUID
    @Binding var pendingSelectedGuides: [GuideItem]

    @StateObject private var store = GuideLibraryStore()
    @State private var selectedGuideIDs: Set<UUID> = []

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                headerSection

                if store.guides.isEmpty {
                    emptyStateView
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(store.guides) { guide in
                                NavigationLink {
                                    GuideDetailView(
                                        guide: guide,
                                        isSelected: selectedGuideIDs.contains(guide.id),
                                        onToggleSelection: {
                                            toggleSelection(for: guide.id)
                                        }
                                    )
                                } label: {
                                    GuideCardView(
                                        guide: guide,
                                        isSelected: selectedGuideIDs.contains(guide.id)
                                    )
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button {
                                        toggleSelection(for: guide.id)
                                    } label: {
                                        Label(
                                            selectedGuideIDs.contains(guide.id) ? "選択解除" : "選択する",
                                            systemImage: selectedGuideIDs.contains(guide.id) ? "checkmark.circle.fill" : "circle"
                                        )
                                    }

                                    Button(role: .destructive) {
                                        deleteGuide(guide)
                                    } label: {
                                        Label("削除", systemImage: "trash")
                                    }
                                }
                            }
                        }
                        .padding(16)
                    }
                }

                bottomActionBar
            }
            .background(AppStyle.background)
            .navigationTitle("ガイド")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("再読み込み") {
                        reloadGuides()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    if !store.guides.isEmpty {
                        Menu {
                            Button("全選択") {
                                selectedGuideIDs = Set(store.guides.map(\.id))
                            }

                            Button("選択解除") {
                                selectedGuideIDs.removeAll()
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
            .onAppear {
                reloadGuides()
            }
            .onChange(of: selectedGuideIDs) { _, _ in
                syncSelectedGuides()
            }
        }
    }

    private var selectedGuides: [GuideItem] {
        store.guides.filter { selectedGuideIDs.contains($0.id) }
    }

    private var headerSection: some View {
        VStack(spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("保存した参照写真を一覧表示")
                        .font(.headline)

                    Text("画像をタップすると詳細、複数選択して撮影へ進める")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()
            }

            HStack {
                Label("保存済み \(store.guides.count)件", systemImage: "photo.stack")
                    .font(.subheadline)

                Spacer()

                Label("選択中 \(selectedGuideIDs.count)件", systemImage: "checkmark.circle")
                    .font(.subheadline)
                        .foregroundColor(selectedGuideIDs.isEmpty ? .secondary : .white)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(AppStyle.background)
    }

    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 52))
                .foregroundColor(AppStyle.secondaryText)

            Text("まだガイドがありません")
                .font(.title3)
                .fontWeight(.semibold)

            Text("作成したガイドがここに表示されます")
                .font(.subheadline)
                .foregroundColor(.secondary)

            Spacer()
        }
    }

    private var bottomActionBar: some View {
        VStack(spacing: 10) {
            Divider()

            HStack(spacing: 12) {
                Button {
                    selectedGuideIDs.removeAll()
                } label: {
                    Text("選択解除")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppStyle.elevatedSurface)
                        .foregroundColor(.primary)
                        .clipShape(Capsule())
                }
                .disabled(selectedGuideIDs.isEmpty)

                Button {
                    if !selectedGuides.isEmpty {
                        pendingSelectedGuides = selectedGuides
                        resetID = UUID()
                        selectedIndex = TabbarItem.photo.rawValue
                    }
                } label: {
                    Text(selectedGuideIDs.isEmpty ? "ガイドを選択して撮影へ" : "このガイドで撮影")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(selectedGuideIDs.isEmpty ? AppStyle.surface : Color.white)
                        .foregroundColor(selectedGuideIDs.isEmpty ? .secondary : .black)
                        .clipShape(Capsule())
                }
                .disabled(selectedGuideIDs.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 14)
            .background(AppStyle.background)
        }
    }

    private func toggleSelection(for id: UUID) {
        if selectedGuideIDs.contains(id) {
            selectedGuideIDs.remove(id)
        } else {
            selectedGuideIDs.insert(id)
        }
    }

    private func reloadGuides() {
        store.load()

        let availableGuideIDs = Set(store.guides.map(\.id))
        let pendingGuideIDs = Set(pendingSelectedGuides.map(\.id))
        selectedGuideIDs = pendingGuideIDs.intersection(availableGuideIDs)
        syncSelectedGuides()
    }

    private func syncSelectedGuides() {
        pendingSelectedGuides = selectedGuides
    }

    private func deleteGuide(_ guide: GuideItem) {
        if selectedGuideIDs.contains(guide.id) {
            selectedGuideIDs.remove(guide.id)
        }
        store.deleteGuide(guide)
    }
}

private struct GuideDetailView: View {
    let guide: GuideItem
    let isSelected: Bool
    let onToggleSelection: () -> Void

    @State private var showGuideImageFullscreen = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("参照写真")
                        .font(.headline)

                    if let refImage = guide.referenceUIImage {
                        Image(uiImage: refImage)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    } else {
                        missingImageView(text: "参照写真が見つかりません")
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("生成されたガイド")
                            .font(.headline)

                        Spacer()

                        Button("大きく見る") {
                            showGuideImageFullscreen = true
                        }
                        .font(.subheadline)
                    }

                    if let guideImage = guide.guideUIImage {
                        Button {
                            showGuideImageFullscreen = true
                        } label: {
                            Image(uiImage: guideImage)
                                .resizable()
                                .scaledToFit()
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        }
                        .buttonStyle(.plain)
                    } else {
                        missingImageView(text: "ガイド画像が見つかりません")
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("情報")
                        .font(.headline)

                    detailRow(title: "タイトル", value: guide.title)
                    detailRow(
                        title: "作成日",
                        value: guide.createdAt.formatted(date: .abbreviated, time: .shortened)
                    )
                }

                Button {
                    onToggleSelection()
                } label: {
                    Text(isSelected ? "このガイドを選択解除" : "このガイドを選択")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(isSelected ? AppStyle.success : Color.white)
                        .foregroundStyle(.black)
                        .clipShape(Capsule())
                }
            }
            .padding(16)
        }
        .navigationTitle("ガイド詳細")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $showGuideImageFullscreen) {
            FullscreenGuideView(guide: guide)
        }
    }

    private func detailRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.vertical, 4)
    }

    private func missingImageView(text: String) -> some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(Color.gray.opacity(0.12))
            .frame(height: 220)
            .overlay {
                Text(text)
                    .foregroundStyle(.secondary)
            }
    }
}

private struct FullscreenGuideView: View {
    let guide: GuideItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            if let image = guide.guideUIImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding()
            } else {
                Text("ガイド画像が見つかりません")
                    .foregroundStyle(.white)
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.white)
                    .padding()
            }
        }
    }
}

private struct GuideCardView: View {
    let guide: GuideItem
    let isSelected: Bool

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 8) {
                if let image = guide.referenceUIImage {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(height: 150)
                        .frame(maxWidth: .infinity)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                } else {
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color.gray.opacity(0.12))
                        .frame(height: 150)
                        .overlay {
                            Text("画像なし")
                                .foregroundStyle(.secondary)
                        }
                }

                Text(guide.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineLimit(1)

                Text(guide.createdAt.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(AppStyle.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(isSelected ? Color.white : AppStyle.border, lineWidth: isSelected ? 3 : 1)
            )

            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 24))
                .foregroundStyle(.white)
                .padding(12)
                .shadow(radius: 2)
        }
    }
}

private struct GuideCaptureView: View {
    let selectedGuides: [GuideItem]
    @Environment(\.dismiss) private var dismiss

    @State private var overlayOpacity: Double = 0.45
    @State private var currentIndex: Int = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                ZStack {
                    Rectangle()
                        .fill(Color.black)
                        .overlay {
                            Text("ここを TakePhoto に置き換える")
                                .foregroundStyle(.white.opacity(0.7))
                        }

                    if !selectedGuides.isEmpty,
                       let image = selectedGuides[currentIndex].guideUIImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .opacity(overlayOpacity)
                            .padding()
                    }
                }

                VStack(spacing: 16) {
                    if !selectedGuides.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("表示中のガイド")
                                    .font(.subheadline)
                                    .fontWeight(.semibold)
                                Spacer()
                                Text("\(currentIndex + 1) / \(selectedGuides.count)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(Array(selectedGuides.enumerated()), id: \.element.id) { index, guide in
                                        Button {
                                            currentIndex = index
                                        } label: {
                                            VStack(spacing: 6) {
                                                if let img = guide.referenceUIImage {
                                                    Image(uiImage: img)
                                                        .resizable()
                                                        .aspectRatio(contentMode: .fill)
                                                        .frame(width: 72, height: 72)
                                                        .clipped()
                                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                                }

                                                Text(guide.title)
                                                    .font(.caption2)
                                                    .lineLimit(1)
                                                    .frame(width: 72)
                                            }
                                            .padding(6)
                                            .background(currentIndex == index ? Color.blue.opacity(0.15) : Color.clear)
                                            .clipShape(RoundedRectangle(cornerRadius: 12))
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("ガイドの透明度")
                                .font(.subheadline)
                                .fontWeight(.semibold)

                            Slider(value: $overlayOpacity, in: 0.1...1.0)
                        }
                    }
                }
                .padding(16)
                .background(.ultraThinMaterial)
            }

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.backward")
                            .font(.headline)
                            .padding(12)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                    }

                    Spacer()

                    Text("ガイド重ね撮影")
                        .font(.headline)
                        .foregroundStyle(.white)

                    Spacer()

                    Color.clear.frame(width: 44, height: 44)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)

                Spacer()
            }
        }
        .navigationBarBackButtonHidden(true)
    }
}

#Preview {
    ShowGuide(
        selectedIndex: .constant(0),
        resetID: .constant(UUID()),
        pendingSelectedGuides: .constant([])
    )
}
