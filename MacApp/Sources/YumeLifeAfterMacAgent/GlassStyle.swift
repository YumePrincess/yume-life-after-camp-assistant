import SwiftUI

enum YumePalette {
    static let gold = Color(red: 0.91, green: 0.64, blue: 0.29)
    static let warmGold = Color(red: 0.98, green: 0.78, blue: 0.44)
    static let ink = Color(red: 0.035, green: 0.055, blue: 0.075)
}

struct GlassPanel: ViewModifier {
    var radius: CGFloat = 24
    var padding: CGFloat = 20
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(.white.opacity(0.16), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.18), radius: 24, y: 12)
    }
}

extension View {
    func glassPanel(radius: CGFloat = 24, padding: CGFloat = 20) -> some View {
        modifier(GlassPanel(radius: radius, padding: padding))
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold, design: .rounded))
            .lineLimit(2)
            .minimumScaleFactor(0.76)
            .allowsTightening(true)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 2)
            .frame(minHeight: 40)
            .foregroundStyle(.black.opacity(0.82))
            .background(
                LinearGradient(
                    colors: [YumePalette.warmGold, YumePalette.gold],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: Capsule()
            )
            .shadow(color: YumePalette.gold.opacity(configuration.isPressed ? 0.12 : 0.28), radius: 12, y: 4)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.78), value: configuration.isPressed)
    }
}

struct GlassButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .lineLimit(2)
            .minimumScaleFactor(0.76)
            .allowsTightening(true)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 2)
            .frame(minHeight: 40)
            .background(.thinMaterial, in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.16)))
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct AppBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        ZStack {
            (colorScheme == .dark ? YumePalette.ink : Color(red: 0.91, green: 0.88, blue: 0.84))
            RadialGradient(
                colors: [YumePalette.gold.opacity(colorScheme == .dark ? 0.15 : 0.2), .clear],
                center: .topLeading,
                startRadius: 20,
                endRadius: 700
            )
            RadialGradient(
                colors: [Color.teal.opacity(0.13), .clear],
                center: .bottomTrailing,
                startRadius: 40,
                endRadius: 760
            )
        }
        .ignoresSafeArea()
    }
}
