import SwiftUI

enum AppStyle {
    static let background = Color.black
    static let surface = Color.white.opacity(0.10)
    static let elevatedSurface = Color.white.opacity(0.16)
    static let border = Color.white.opacity(0.14)
    static let primaryText = Color.white
    static let secondaryText = Color.white.opacity(0.62)
    static let success = Color(red: 0.28, green: 0.84, blue: 0.48)
    static let warning = Color(red: 1.0, green: 0.72, blue: 0.22)
    static let danger = Color(red: 1.0, green: 0.30, blue: 0.30)
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
        preferredColorScheme(.dark)
            .tint(.white)
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
                .font(.title3.weight(.black))
                .foregroundStyle(AppStyle.primaryText)
        }
    }
}

struct AppPrimaryButtonStyle: ButtonStyle {
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.black))
            .foregroundStyle(destructive ? AppStyle.primaryText : Color.black)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(destructive ? AppStyle.danger : Color.white)
            .clipShape(Capsule())
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
            return AppStyle.primaryText
        }
        return filled ? Color.black : AppStyle.primaryText
    }

    private var backgroundColor: Color {
        if destructive {
            return AppStyle.danger
        }
        return filled ? Color.white : AppStyle.elevatedSurface
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
            return AppStyle.primaryText
        }
        return selected ? Color.black : AppStyle.primaryText
    }

    private var backgroundColor: Color {
        if destructive {
            return AppStyle.danger
        }
        return selected ? Color.white : AppStyle.elevatedSurface
    }
}
