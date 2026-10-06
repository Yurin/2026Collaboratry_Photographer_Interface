import SwiftUI

// Shared Vocabulary-inspired palette. Photo and guide rendering keep their own colors.
enum AppStyle {
    static let background = Color(red: 0.94, green: 0.925, blue: 0.88)
    static let surface = Color(red: 0.98, green: 0.965, blue: 0.93)
    static let elevatedSurface = Color(red: 0.88, green: 0.91, blue: 0.87)
    static let border = Color(red: 0.12, green: 0.14, blue: 0.13)
    static let primaryText = Color(red: 0.08, green: 0.10, blue: 0.09)
    static let secondaryText = Color(red: 0.36, green: 0.38, blue: 0.35)
    static let accent = Color(red: 0.58, green: 0.75, blue: 0.75)
    static let coral = Color(red: 0.94, green: 0.64, blue: 0.56)
    static let success = Color(red: 0.16, green: 0.40, blue: 0.29)
    static let warning = Color(red: 0.53, green: 0.34, blue: 0.08)
    static let danger = Color(red: 0.66, green: 0.20, blue: 0.16)
}

struct AppCardModifier: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(AppStyle.surface)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(AppStyle.border, lineWidth: 1)
            }
    }
}

extension View {
    func appCard(padding: CGFloat = 16) -> some View {
        modifier(AppCardModifier(padding: padding))
    }

    func appScreen() -> some View {
        preferredColorScheme(.light)
            .tint(AppStyle.primaryText)
    }
}

struct AppSectionTitle: View {
    let title: String
    var eyebrow: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let eyebrow {
                Text(eyebrow.uppercased())
                    .font(.caption2.weight(.black))
                    .tracking(1.5)
                    .foregroundStyle(AppStyle.secondaryText)
            }

            Text(title)
                .font(.system(.title3, design: .serif, weight: .bold))
                .foregroundStyle(AppStyle.primaryText)
        }
    }
}

struct AppPrimaryButtonStyle: ButtonStyle {
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.black))
            .foregroundStyle(destructive ? Color.white : AppStyle.primaryText)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(destructive ? AppStyle.danger : AppStyle.accent)
            .clipShape(Capsule())
            .overlay { Capsule().stroke(AppStyle.border, lineWidth: 1.5) }
            .shadow(color: AppStyle.border, radius: 0, x: 0, y: configuration.isPressed ? 1 : 4)
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct AppSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.bold))
            .foregroundStyle(AppStyle.primaryText)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(AppStyle.elevatedSurface)
            .clipShape(Capsule())
            .overlay {
                Capsule().stroke(AppStyle.border, lineWidth: 1)
            }
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct AppCompactButtonStyle: ButtonStyle {
    var filled = false
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.black))
            .foregroundStyle(foregroundColor)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(backgroundColor)
            .clipShape(Capsule())
            .overlay {
                Capsule().stroke(AppStyle.border, lineWidth: filled || destructive ? 0 : 1)
            }
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }

    private var foregroundColor: Color {
        if destructive {
            return Color.white
        }
        return filled ? Color.black : AppStyle.primaryText
    }

    private var backgroundColor: Color {
        if destructive {
            return AppStyle.danger
        }
        return filled ? AppStyle.accent : AppStyle.surface
    }
}

struct AppIconButtonStyle: ButtonStyle {
    var selected = false
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .black))
            .foregroundStyle(foregroundColor)
            .frame(width: 42, height: 42)
            .background(backgroundColor)
            .clipShape(Circle())
            .overlay {
                Circle().stroke(AppStyle.border, lineWidth: selected || destructive ? 0 : 1)
            }
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }

    private var foregroundColor: Color {
        if destructive {
            return Color.white
        }
        return selected ? Color.black : AppStyle.primaryText
    }

    private var backgroundColor: Color {
        if destructive {
            return AppStyle.danger
        }
        return selected ? AppStyle.accent : AppStyle.surface
    }
}
