import Foundation
import MurmurTrayCore

func runLocalizationChecks() throws -> Int {
    let suite = "murmur-localization-check-\(UUID().uuidString)"
    guard let preferences = UserDefaults(suiteName: suite) else {
        throw CheckFailure(message: "Could not create isolated language preferences")
    }
    defer { preferences.removePersistentDomain(forName: suite) }
    var count = 0
    func passed(_ name: String) { print("PASS localization: \(name)"); count += 1 }

    try check(L10n.language(in: preferences) == .english, "A new user starts in English")
    passed("English default without a language preference")
    L10n.select(.russian, in: preferences)
    try check(L10n.language(in: UserDefaults(suiteName: suite)!) == .russian,
              "An explicit Russian selection survives a new preferences reader")
    passed("explicit Russian preference persists")
    L10n.select(.english, in: preferences)
    try check(L10n.language(in: preferences) == .english, "User can switch back to English")
    passed("switch back to English")
    preferences.set("unsupported", forKey: "interfaceLanguage")
    try check(L10n.language(in: preferences) == .english, "Unsupported preference falls back to English")
    passed("invalid preference falls back to English")

    try check(L10n.localized("Choose profile folder…", language: .english) == "Choose identity folder…"
              && L10n.localized("Choose profile folder…", language: .russian) == "Выбрать папку личности…",
              "Both real resource catalogs must be readable")
    passed("English and Russian resources load")
    let literal = "user's профиль %@ ; $(false)"
    try check(L10n.localized("Profile: %@", language: .english, arguments: [literal]) == "Identity: " + literal
              && L10n.localized("Profile: %@", language: .russian, arguments: [literal]) == "Личность: " + literal,
              "Values must remain literal in both languages")
    passed("Unicode, quotes and format characters remain literal")
    let node = "Murmur needs Node.js %@ or newer. Install the current LTS version from nodejs.org, then select Try again."
    try check(L10n.localized(node, language: .english, arguments: ["30.1.2"]).contains("Node.js 30.1.2 or newer")
              && L10n.localized(node, language: .russian, arguments: ["30.1.2"]).contains("Node.js 30.1.2 или новее"),
              "Runtime-owned Node minimum must survive both translations")
    passed("dynamic Node requirement in both languages")
    try check(L10n.localized("unrecognized diagnostic code", language: .russian) == "unrecognized diagnostic code",
              "An additive diagnostic remains visible")
    passed("unknown text remains visible")
    let savedDomain = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
    defer { UserDefaults.standard.setVolatileDomain(savedDomain, forName: UserDefaults.argumentDomain) }
    for (language, title, reply) in [("en", "Message exchange", "Reply"), ("ru", "Обмен сообщениями", "Ответ")] {
        UserDefaults.standard.setVolatileDomain(["interfaceLanguage": language], forName: UserDefaults.argumentDomain)
        let roundtripIndex = DoctorSnapshot.stageIDs.firstIndex(of: "roundtrip")!
        try check(DoctorSnapshot.titles[roundtripIndex] == title && L10n.text("Reply") == reply && title != reply,
                  "Doctor exchange and pairing Reply have separate localized meanings")
        passed("Doctor roundtrip is distinct from pairing Reply: \(language)")
    }
    return count
}
