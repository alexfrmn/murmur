import Foundation

// Internal presentation states, deliberately NOT a proposed CLI JSON schema.
public enum Indicator: String, CaseIterable, Sendable {
    case unknown, stopped, offline, ready, unread, failed, paused

    public var title: String {
        switch self {
        case .unknown: "Состояние неизвестно"
        case .stopped: "Служба остановлена"
        case .offline: "Нет связи с брокером"
        case .ready: "Murmur работает"
        case .unread: "Есть непрочитанное"
        case .failed: "Требуется внимание"
        case .paused: "Приём на паузе"
        }
    }

    public var symbol: String {
        switch self {
        case .unknown: "questionmark.circle"
        case .stopped: "stop.circle"
        case .offline: "wifi.exclamationmark"
        case .ready: "checkmark.circle"
        case .unread: "envelope.badge"
        case .failed: "exclamationmark.triangle"
        case .paused: "pause.circle"
        }
    }
}

public enum ProbeError: Error, LocalizedError, Sendable {
    case missingCLI, timedOut, outputLimit, failed(Int32), failedWithReason(Int32, String), invalidJSON, unsupportedSchema

    public var errorDescription: String? {
        switch self {
        case .missingCLI: "Murmur CLI пока не найден"
        case .timedOut: "CLI не ответил вовремя"
        case .outputLimit: "Ответ CLI превышает допустимый размер"
        case .failed(let code): "CLI завершился с кодом \(code)"
        case .failedWithReason(let code, let reason): "CLI завершился с кодом \(code): \(reason)"
        case .invalidJSON: "CLI вернул некорректный JSON"
        case .unsupportedSchema: "Ожидается общий контракт status / doctor"
        }
    }
}

public struct ProbeSummary: Sendable {
    public let command: String
    public let byteCount: Int
    public let exitCode: Int32
    public let data: Data
}
