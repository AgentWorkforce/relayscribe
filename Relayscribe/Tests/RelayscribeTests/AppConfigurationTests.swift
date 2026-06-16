import XCTest
@testable import RelayscribeCore

final class AppConfigurationTests: XCTestCase {
    func testDefaultSidecarPort() {
        XCTAssertEqual(AppConfiguration.sidecarPort, 3700)
    }

    func testSidecarBaseURLSchemeAndHost() {
        let url = AppConfiguration.sidecarBaseURL
        XCTAssertEqual(url.scheme, "http")
        XCTAssertEqual(url.host, "127.0.0.1")
        XCTAssertEqual(url.port, 3700)
    }

    func testSidecarBaseURLPortMatchesSidecarPort() {
        let url = AppConfiguration.sidecarBaseURL
        XCTAssertEqual(url.port, AppConfiguration.sidecarPort)
    }
}
