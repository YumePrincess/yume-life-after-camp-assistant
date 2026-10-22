import SwiftUI

enum YumePalette {
    static let gold = Color(red: 0.91, green: 0.64, blue: 0.29)
    static let warmGold = Color(red: 0.98, green: 0.78, blue: 0.44)
    static let ink = Color(red: 0.035, green: 0.055, blue: 0.075)
}

struct GlassPanel: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    var radius: CGFloat = 24
    var padding: CGFloat = 20
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(colorScheme == .dark ? .white.opacity(0.105) : .black.opacity(0.075), lineWidth: 1)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.16 : 0.08), radius: 20, y: 8)
    }
}

extension View {
    func glassPanel(radius: CGFloat = 24, padding: CGFloat = 20) -> some View {
        modifier(GlassPanel(radius: radius, padding: padding))
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(2)
            .minimumScaleFactor(0.76)
            .allowsTightening(true)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .foregroundStyle(Color.black.opacity(0.84))
            .background(YumePalette.warmGold, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(.white.opacity(0.25), lineWidth: 1)
            }
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct GlassButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .lineLimit(2)
            .minimumScaleFactor(0.76)
            .allowsTightening(true)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(colorScheme == .dark ? .white.opacity(0.12) : .black.opacity(0.09), lineWidth: 1)
            }
            .opacity(configuration.isPressed ? 0.76 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.99 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct GlassCheckboxToggleStyle: ToggleStyle {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(configuration.isOn
                        ? YumePalette.warmGold
                        : (colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04)))
                    .overlay {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .strokeBorder(configuration.isOn
                                ? YumePalette.warmGold
                                : (colorScheme == .dark ? Color.white.opacity(0.55) : Color.black.opacity(0.45)), lineWidth: 1.25)
                    }
                    .overlay {
                        if configuration.isOn {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(YumePalette.ink)
                        }
                    }
                    .frame(width: 18, height: 18)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                configuration.label
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.5)
        .accessibilityRepresentation {
            Toggle(isOn: configuration.$isOn) { configuration.label }
                .toggleStyle(.checkbox)
        }
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
