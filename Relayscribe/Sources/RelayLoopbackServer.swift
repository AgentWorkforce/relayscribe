import Foundation
import Network

/// One-shot loopback HTTP server for the Relay CLI-login browser callback.
///
/// This mirrors exactly what `relayfile login` does: bind an ephemeral port on
/// the loopback interface, open the browser at `/api/v1/cli/login?redirect_uri=
/// http://127.0.0.1:<port>/callback&state=…`, and capture the tokens the cloud
/// 307-redirects back as query parameters. The listener is restricted to the
/// loopback interface so nothing off-host can reach it.
///
/// `@unchecked Sendable`: all mutable state is confined to `queue`, a single
/// serial dispatch queue that every NWListener/NWConnection handler runs on.
final class RelayLoopbackServer: @unchecked Sendable {
    enum LoopbackError: LocalizedError {
        case malformedCallback

        var errorDescription: String? {
            "The Relay sign-in callback was malformed."
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "com.agentrelay.relayscribe.loopback")

    private var connection: NWConnection?
    private var buffer = Data()
    private var finished = false
    private var pendingResult: Result<[String: String], Error>?
    private var completion: ((Result<[String: String], Error>) -> Void)?

    init() throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
    }

    /// Starts the listener and returns the assigned loopback port.
    func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            let resume = ResumeOnce(cont)
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if let port = self?.listener.port?.rawValue {
                        resume.success(port)
                    }
                case .failed(let error):
                    resume.failure(error)
                case .cancelled:
                    resume.failure(LoopbackError.malformedCallback)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                guard let self else {
                    conn.cancel()
                    return
                }
                self.queue.async { self.accept(conn) }
            }
            listener.start(queue: queue)
        }
    }

    /// Awaits the first callback request and returns its parsed query parameters.
    func waitForCallback() async throws -> [String: String] {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String: String], Error>) in
            queue.async { [weak self] in
                guard let self else {
                    cont.resume(throwing: LoopbackError.malformedCallback)
                    return
                }
                if let pending = self.pendingResult {
                    cont.resume(with: pending)
                } else {
                    self.completion = { result in cont.resume(with: result) }
                }
            }
        }
    }

    func stop() {
        queue.async { [weak self] in
            self?.listener.cancel()
            self?.connection?.cancel()
        }
    }

    // MARK: - Connection handling (all on `queue`)

    private func accept(_ conn: NWConnection) {
        guard connection == nil else {
            conn.cancel()
            return
        }
        connection = conn
        conn.start(queue: queue)
        receive(conn)
    }

    private func receive(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                if let separator = self.buffer.firstRange(of: Data("\r\n\r\n".utf8)) {
                    self.respond(headerData: self.buffer[..<separator.lowerBound], conn: conn)
                    return
                }
            }
            if let error {
                self.finish(.failure(error))
                conn.cancel()
                return
            }
            if isComplete {
                self.finish(.failure(LoopbackError.malformedCallback))
                conn.cancel()
                return
            }
            self.receive(conn)
        }
    }

    private func respond(headerData: Data, conn: NWConnection) {
        let params = Self.parseQuery(fromRequestHeader: headerData)
        let body = """
        <!doctype html><html><head><meta charset="utf-8"><title>\(Brand.productName)</title></head>\
        <body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding-top:64px;color:#1d1d1f">\
        <h2>Signed in to Relay</h2>\
        <p>You can close this window and return to \(Brand.productName).</p></body></html>
        """
        let response = """
        HTTP/1.1 200 OK\r
        Content-Type: text/html; charset=utf-8\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """
        conn.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })

        if params.isEmpty {
            finish(.failure(LoopbackError.malformedCallback))
        } else {
            finish(.success(params))
        }
    }

    private func finish(_ result: Result<[String: String], Error>) {
        guard !finished else { return }
        finished = true
        if let completion {
            completion(result)
            self.completion = nil
        } else {
            pendingResult = result
        }
    }

    // MARK: - Parsing

    /// Extracts the query parameters from the request line of a raw HTTP header.
    /// e.g. `GET /callback?state=…&access_token=… HTTP/1.1` → `[state: …, …]`.
    private static func parseQuery(fromRequestHeader headerData: Data) -> [String: String] {
        let header = String(decoding: headerData, as: UTF8.self)
        guard let requestLine = header.split(separator: "\r\n").first else { return [:] }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return [:] }
        let path = String(parts[1])
        guard
            let components = URLComponents(string: "http://127.0.0.1\(path)"),
            let items = components.queryItems
        else { return [:] }
        var params: [String: String] = [:]
        for item in items {
            params[item.name] = item.value ?? ""
        }
        return params
    }
}

/// Guards a `CheckedContinuation` so it can only be resumed once, even though
/// NWListener may emit multiple terminal state transitions.
private final class ResumeOnce: @unchecked Sendable {
    private var continuation: CheckedContinuation<UInt16, Error>?

    init(_ continuation: CheckedContinuation<UInt16, Error>) {
        self.continuation = continuation
    }

    func success(_ value: UInt16) {
        continuation?.resume(returning: value)
        continuation = nil
    }

    func failure(_ error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
