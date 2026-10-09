import XCTest
@testable import Sidequest

final class ModelsTests: XCTestCase {
    /// The fixture comes from test/support/appFixture.ts; the daemon's tests check it still matches what it sends.
    func testDecodesTheDaemonsSessionList() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "sessions", withExtension: "json", subdirectory: "Fixtures"))
        let reply = try JSONDecoder().decode(SessionsReply.self, from: Data(contentsOf: url))
        XCTAssertEqual(reply.sessions.count, 3)

        let fix = reply.sessions[0]
        XCTAssertEqual(fix.title, "Checkout total is off by a cent on some carts with discounts")
        XCTAssertEqual(fix.pr?.number, 128)
        XCTAssertTrue(fix.needsYou)
        XCTAssertNotNil(fix.created)

        let failed = reply.sessions[1]
        XCTAssertEqual(failed.state, "failed")
        XCTAssertEqual(failed.exitCode, 1)
        XCTAssertTrue(failed.needsYou)
        XCTAssertFalse(failed.markedDone)
        XCTAssertFalse(failed.isDone)

        // Answered in its terminal, so only being marked done says it is finished.
        let asked = reply.sessions[2]
        XCTAssertEqual(asked.title, "Why are refunds slow")
        XCTAssertTrue(asked.markedDone)
        XCTAssertTrue(asked.isDone)
        XCTAssertFalse(asked.isWorking)
        XCTAssertFalse(asked.needsYou)
        XCTAssertEqual(reply.stats.streak, 6)
    }

    func testComparesVersions() {
        XCTAssertTrue(Updater.isNewer("0.1.58", than: "0.1.57"))
        XCTAssertTrue(Updater.isNewer("0.2.0", than: "0.1.99"))
        XCTAssertTrue(Updater.isNewer("0.1.1", than: "dev"))
        XCTAssertFalse(Updater.isNewer("0.1.57", than: "0.1.57"))
        XCTAssertFalse(Updater.isNewer("0.1.9", than: "0.1.10"))
    }
}
