import AppKit
import Observation
import SwiftUI

/// An sRGB colour as three 0–1 channels: what the palette stores, and what the maths below works on.
struct RGB: Equatable {
    var red: Double
    var green: Double
    var blue: Double

    static let white = RGB(red: 1, green: 1, blue: 1)
    static let black = RGB(red: 0, green: 0, blue: 0)

    init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// "#6d28d9" or "6d28d9"; nil for anything else.
    init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xff) / 255,
                  green: Double((value >> 8) & 0xff) / 255,
                  blue: Double(value & 0xff) / 255)
    }

    /// What a colour well hands back, whatever space it picked in.
    init?(_ color: Color) {
        guard let srgb = NSColor(color).usingColorSpace(.sRGB) else { return nil }
        self.init(red: Double(srgb.redComponent), green: Double(srgb.greenComponent), blue: Double(srgb.blueComponent))
    }

    var hex: String { String(format: "#%02x%02x%02x", Self.byte(red), Self.byte(green), Self.byte(blue)) }
    var color: Color { Color(.sRGB, red: red, green: green, blue: blue) }

    private static func byte(_ channel: Double) -> Int { Int((min(max(channel, 0), 1) * 255).rounded()) }

    /// `amount` of the way from this colour to `other`.
    func mixed(with other: RGB, _ amount: Double) -> RGB {
        RGB(red: red + (other.red - red) * amount,
            green: green + (other.green - green) * amount,
            blue: blue + (other.blue - blue) * amount)
    }

    /// Relative luminance, as WCAG defines it.
    var luminance: Double {
        func linear(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    func contrast(with other: RGB) -> Double {
        let (a, b) = (luminance, other.luminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// This colour, darkened or lightened just enough for text in it to read on `background` (4.5:1).
    func readable(on background: RGB) -> RGB {
        let toward: RGB = background.luminance > 0.5 ? .black : .white
        var shade = self
        for _ in 0..<20 where shade.contrast(with: background) < 4.5 {
            shade = shade.mixed(with: toward, 0.1)
        }
        return shade
    }

    /// Text drawn on a fill of this colour: white unless the fill is too light for it.
    var textOnFill: RGB { contrast(with: .white) >= 3 ? .white : RGB(red: 0.11, green: 0.1, blue: 0.13) }
}

/// The colours you can change, as hex, in Settings › Appearance or from the window's palette button.
/// Everything else on screen (tints, borders, readable text shades) is worked out from these.
struct Palette: Codable, Equatable {
    var accent = "#6d28d9"
    var needsYou = "#6d28d9"
    var working = "#1d64d8"
    var failed = "#b42318"
    var done = "#0f766e"
    var fix = "#c2410c"
    var investigate = "#7e22ce"
    var ask = "#1d4ed8"
    var review = "#0f766e"
    /// Linear, GitHub and Jira prompts.
    var ticket = "#4338ca"
    /// The list's background: "" for the standard one, "accent" for a tint of the accent, or a hex colour to tint it with.
    var listSurface = ""
    /// The session pane's background, the same way.
    var detailSurface = ""

    init() {}

    /// A colour that is missing or isn't hex keeps its default, so an old or hand-edited copy still loads.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func read(_ key: CodingKeys, _ fallback: String) -> String {
            guard let value = try? container.decodeIfPresent(String.self, forKey: key), RGB(hex: value) != nil else { return fallback }
            return value
        }
        let standard = Palette()
        accent = read(.accent, standard.accent)
        needsYou = read(.needsYou, standard.needsYou)
        working = read(.working, standard.working)
        failed = read(.failed, standard.failed)
        done = read(.done, standard.done)
        fix = read(.fix, standard.fix)
        investigate = read(.investigate, standard.investigate)
        ask = read(.ask, standard.ask)
        review = read(.review, standard.review)
        ticket = read(.ticket, standard.ticket)
        func surface(_ key: CodingKeys) -> String {
            guard let value = try? container.decodeIfPresent(String.self, forKey: key), Palette.isSurface(value) else { return "" }
            return value
        }
        listSurface = surface(.listSurface)
        detailSurface = surface(.detailSurface)
    }

    /// "", "accent" or a hex colour.
    static func isSurface(_ value: String) -> Bool { value.isEmpty || value == "accent" || RGB(hex: value) != nil }

    func rgb(_ key: KeyPath<Palette, String>) -> RGB {
        RGB(hex: self[keyPath: key]) ?? RGB(hex: Palette()[keyPath: key]) ?? .black
    }

    func rgb(_ tone: Tone) -> RGB? {
        switch tone {
        case .needsYou: return rgb(\.needsYou)
        case .working: return rgb(\.working)
        case .failed: return rgb(\.failed)
        case .done: return rgb(\.done)
        case .neutral: return nil
        }
    }

    /// The colour of a prompt's tag, by its key; nil for a custom prompt.
    func tag(_ promptKey: String) -> RGB? {
        switch promptKey {
        case "fix": return rgb(\.fix)
        case "investigate": return rgb(\.investigate)
        case "ask": return rgb(\.ask)
        case "review": return rgb(\.review)
        case "linear", "github", "jira": return rgb(\.ticket)
        default: return nil
        }
    }
}

/// Which of the palette's status colours a session's state wears.
enum Tone: Hashable {
    case needsYou, working, failed, done, neutral
}

/// The palette, kept in this Mac's preferences: it is how this app looks, nothing the engine or Slack needs.
@MainActor
@Observable
final class Appearance {
    private(set) var palette: Palette
    private let defaults: UserDefaults
    private static let key = "appearancePalette"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        palette = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(Palette.self, from: $0) } ?? Palette()
    }

    func set(_ key: WritableKeyPath<Palette, String>, _ hex: String) {
        guard RGB(hex: hex) != nil, palette[keyPath: key] != hex else { return }
        palette[keyPath: key] = hex
        save()
    }

    /// A colour well's binding to one of the palette's colours.
    func color(_ key: WritableKeyPath<Palette, String>) -> Binding<Color> {
        Binding(
            get: { self.palette.rgb(key).color },
            set: { color in if let rgb = RGB(color) { self.set(key, rgb.hex) } }
        )
    }

    func setSurface(_ key: WritableKeyPath<Palette, String>, _ value: String) {
        guard Palette.isSurface(value), palette[keyPath: key] != value else { return }
        palette[keyPath: key] = value
        save()
    }

    /// A background's picker: standard, a tint of the accent, or a tint of a colour of your own
    /// (starting from the accent's, so the well opens on something sensible).
    func surfaceKind(_ key: WritableKeyPath<Palette, String>) -> Binding<SurfaceKind> {
        Binding(
            get: { SurfaceKind(self.palette[keyPath: key]) },
            set: { kind in
                switch kind {
                case .standard: self.setSurface(key, "")
                case .accent: self.setSurface(key, "accent")
                case .custom:
                    if RGB(hex: self.palette[keyPath: key]) == nil { self.setSurface(key, self.palette.rgb(\.accent).hex) }
                }
            }
        )
    }

    /// A background's colour well, for a custom tint.
    func surfaceColor(_ key: WritableKeyPath<Palette, String>) -> Binding<Color> {
        Binding(
            get: { (RGB(hex: self.palette[keyPath: key]) ?? self.palette.rgb(\.accent)).color },
            set: { color in if let rgb = RGB(color) { self.setSurface(key, rgb.hex) } }
        )
    }

    func reset() {
        palette = Palette()
        defaults.removeObject(forKey: Self.key)
    }

    private func save() {
        if let data = try? JSONEncoder().encode(palette) { defaults.set(data, forKey: Self.key) }
    }
}

/// What a window background is tinted with.
enum SurfaceKind: Hashable {
    case standard, accent, custom

    init(_ value: String) {
        switch value {
        case "": self = .standard
        case "accent": self = .accent
        default: self = .custom
        }
    }
}

/// The palette worked out for the light or dark appearance the window is in.
struct Theme {
    var palette: Palette
    var scheme: ColorScheme

    static let darkPage = RGB(red: 0.12, green: 0.12, blue: 0.13)

    /// What text sits on: the window's background, near enough.
    private var page: RGB { scheme == .dark ? Self.darkPage : .white }

    /// A background tinted with `base`: nearly white in light mode and nearly black in dark, whatever the
    /// colour, so the window's own text keeps reading on it.
    static func surface(from base: RGB, dark: Bool) -> RGB {
        dark ? base.mixed(with: darkPage, 0.84) : base.mixed(with: .white, 0.92)
    }

    /// A background setting as a colour; nil for the standard background.
    func surface(_ value: String) -> Color? {
        let base: RGB
        if value == "accent" {
            base = palette.rgb(\.accent)
        } else if let rgb = RGB(hex: value) {
            base = rgb
        } else {
            return nil
        }
        return Self.surface(from: base, dark: scheme == .dark).color
    }

    var listSurface: Color? { surface(palette.listSurface) }
    var detailSurface: Color? { surface(palette.detailSurface) }

    /// The selected row in the list: a tint of the accent, in place of the system's highlight.
    var selection: Color { accent.opacity(scheme == .dark ? 0.32 : 0.16) }

    var accent: Color { palette.rgb(\.accent).color }
    var accentText: Color { palette.rgb(\.accent).readable(on: page).color }
    var onAccent: Color { palette.rgb(\.accent).textOnFill.color }

    func fill(_ tone: Tone) -> Color { palette.rgb(tone)?.color ?? Color.secondary }
    func text(_ tone: Tone) -> Color { palette.rgb(tone).map { $0.readable(on: page).color } ?? Color.secondary }
    func onFill(_ tone: Tone) -> Color { palette.rgb(tone).map { $0.textOnFill.color } ?? Color.white }

    func tagText(_ promptKey: String) -> Color { palette.tag(promptKey).map { $0.readable(on: page).color } ?? Color.secondary }
    func tagFill(_ promptKey: String) -> Color { palette.tag(promptKey).map { $0.color.opacity(0.14) } ?? Color.secondary.opacity(0.12) }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme(palette: Palette(), scheme: .light)
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

/// Hands the views under it the theme, and tints their controls with the accent.
private struct Themed: ViewModifier {
    @Environment(Appearance.self) private var appearance
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let theme = Theme(palette: appearance.palette, scheme: scheme)
        content
            .environment(\.theme, theme)
            .tint(theme.accent)
    }
}

extension View {
    /// Put this on a window's root, inside `.environment(appearance)`.
    func themed() -> some View { modifier(Themed()) }
}

/// Where you pick the colours: the window's palette popover and Settings › Appearance.
struct AppearanceEditor: View {
    @Environment(Appearance.self) private var appearance
    @Environment(\.theme) private var theme

    struct Swatch: Hashable {
        var name: String
        var hex: String
    }

    static let swatches = [
        Swatch(name: "Violet", hex: "#6d28d9"), Swatch(name: "Blue", hex: "#2563eb"), Swatch(name: "Pink", hex: "#db2777"),
        Swatch(name: "Orange", hex: "#ea580c"), Swatch(name: "Green", hex: "#15803d"), Swatch(name: "Graphite", hex: "#4b5563"),
    ]

    var body: some View {
        Form {
            Section {
                LabeledContent("Accent") {
                    HStack(spacing: 8) {
                        ForEach(Self.swatches, id: \.hex) { swatch in
                            let picked = appearance.palette.accent.lowercased() == swatch.hex
                            Button { appearance.set(\.accent, swatch.hex) } label: {
                                Circle()
                                    .fill(RGB(hex: swatch.hex)?.color ?? Color.secondary)
                                    .frame(width: 18, height: 18)
                                    .padding(2)
                                    .overlay(Circle().strokeBorder(picked ? RGB(hex: swatch.hex)?.color ?? Color.clear : Color.clear, lineWidth: 2))
                            }
                            .buttonStyle(.plain)
                            .help(swatch.name)
                            .accessibilityLabel(swatch.name)
                            .accessibilityAddTraits(picked ? .isSelected : [])
                        }
                        ColorPicker("Custom accent", selection: appearance.color(\.accent), supportsOpacity: false)
                            .labelsHidden()
                    }
                }
            } footer: {
                Text("Buttons, links, the activity timeline and the app's controls.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                surface("List", \.listSurface)
                surface("Session", \.detailSurface)
            } header: {
                Text("Window")
            } footer: {
                Text("A light tint in light mode and a dark one in dark mode, so text stays readable. The selected session is always tinted with the accent.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Status") {
                status("Needs you", \.needsYou, .needsYou, sample: "reply ready", filled: true)
                status("Working", \.working, .working, sample: "running")
                status("Failed", \.failed, .failed, sample: "failed")
                status("Done", \.done, .done, sample: "merged")
            }
            Section("Prompt tags") {
                tag("Fix", \.fix, prompt: "fix")
                tag("Investigate", \.investigate, prompt: "investigate")
                tag("Ask", \.ask, prompt: "ask")
                tag("Review", \.review, prompt: "review")
                tag("Linear · GitHub · Jira", \.ticket, prompt: "linear")
            }
            Section {
                HStack {
                    Spacer()
                    Button("Reset to Defaults") { appearance.reset() }
                        .disabled(appearance.palette == Palette())
                }
            }
        }
        .formStyle(.grouped)
    }

    private func surface(_ label: String, _ key: WritableKeyPath<Palette, String>) -> some View {
        let kind = SurfaceKind(appearance.palette[keyPath: key])
        return HStack(spacing: 10) {
            Picker(label, selection: appearance.surfaceKind(key)) {
                Text("Standard").tag(SurfaceKind.standard)
                Text("Accent tint").tag(SurfaceKind.accent)
                Text("Custom tint").tag(SurfaceKind.custom)
            }
            if kind == .custom {
                ColorPicker("\(label) tint", selection: appearance.surfaceColor(key), supportsOpacity: false)
                    .labelsHidden()
            }
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(theme.surface(appearance.palette[keyPath: key]) ?? Color(nsColor: .windowBackgroundColor))
                .frame(width: 28, height: 18)
                .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(.quaternary))
                .accessibilityHidden(true)
        }
    }

    private func status(_ label: String, _ key: WritableKeyPath<Palette, String>, _ tone: Tone, sample: String, filled: Bool = false) -> some View {
        ColorPicker(selection: appearance.color(key), supportsOpacity: false) {
            HStack(spacing: 8) {
                StatusDot(tone: tone)
                Text(label)
                Spacer()
                Pill(text: sample, tone: tone, filled: filled)
            }
        }
    }

    private func tag(_ label: String, _ key: WritableKeyPath<Palette, String>, prompt promptKey: String) -> some View {
        ColorPicker(selection: appearance.color(key), supportsOpacity: false) {
            HStack {
                PromptChip(text: label, promptKey: promptKey)
                Spacer()
            }
        }
    }
}
