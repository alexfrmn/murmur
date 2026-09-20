import Foundation

public enum AppLanguage: String, CaseIterable, Sendable {
    case english = "en"
    case russian = "ru"

    public var name: String {
        switch self {
        case .english: "English"
        case .russian: "Русский"
        }
    }
}

/// App language is explicit and defaults to English, independently of the OS language.
/// Native macOS dialogs may still use the language selected in System Settings.
public enum L10n {
    private static let preferenceKey = "interfaceLanguage"

    public static func language(in preferences: UserDefaults = .standard) -> AppLanguage {
        preferences.string(forKey: preferenceKey).flatMap(AppLanguage.init(rawValue:)) ?? .english
    }

    public static func select(_ language: AppLanguage, in preferences: UserDefaults = .standard) {
        preferences.set(language.rawValue, forKey: preferenceKey)
    }

    public static func text(_ key: String, _ arguments: String...) -> String {
        localized(key, language: language(), arguments: arguments)
    }

    public static func localized(_ key: String, language: AppLanguage, arguments: [String] = []) -> String {
        // A distributed app stores its SwiftPM resource bundle in Contents/Resources.
        // The generated Bundle.module accessor also has a build-machine fallback,
        // so use it only outside an app bundle (development and command-line checks).
        let packaged = Bundle.main.resourceURL?
            .appendingPathComponent("MurmurMenuBarSpike_MurmurTrayCore.bundle")
        let resources = packaged.flatMap(Bundle.init(url:))
            ?? (Bundle.main.bundleURL.pathExtension == "app" ? nil : Bundle.module)
        let english = resources?.url(forResource: "en", withExtension: "lproj").flatMap(Bundle.init(url:))
        let selected = resources?.url(forResource: language.rawValue, withExtension: "lproj").flatMap(Bundle.init(url:))
        let fallback = english?.localizedString(forKey: key, value: key, table: "Localizable") ?? key
        let format = selected?.localizedString(forKey: key, value: fallback, table: "Localizable") ?? fallback
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: Locale(identifier: language.rawValue), arguments: arguments)
    }
}
