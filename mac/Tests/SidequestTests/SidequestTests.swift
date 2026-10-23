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

        // Left unfinished for over two weeks, it is filed with Done rather than Working.
        var left = fix
        left.state = "working"
        XCTAssertEqual(left.stale, false)
        XCTAssertTrue(left.isWorking)
        left.stale = true
        XCTAssertFalse(left.isWorking)
    }

    func testComparesVersions() {
        XCTAssertTrue(Updater.isNewer("0.1.58", than: "0.1.57"))
        XCTAssertTrue(Updater.isNewer("0.2.0", than: "0.1.99"))
        XCTAssertTrue(Updater.isNewer("0.1.1", than: "dev"))
        XCTAssertFalse(Updater.isNewer("0.1.57", than: "0.1.57"))
        XCTAssertFalse(Updater.isNewer("0.1.9", than: "0.1.10"))
    }

    func testFindsTheAppInARelease() throws {
        let json = """
        {"tag_name": "v0.1.7", "html_url": "https://github.com/o/r/releases/tag/v0.1.7", "name": "Sidequest 0.1.7",
         "assets": [
           {"name": "appcast.xml", "browser_download_url": "https://github.com/o/r/releases/download/v0.1.7/appcast.xml"},
           {"name": "Sidequest-0.1.7.zip", "browser_download_url": "https://github.com/o/r/releases/download/v0.1.7/Sidequest-0.1.7.zip"}
         ]}
        """
        let release = try JSONDecoder().decode(Updater.Release.self, from: Data(json.utf8))
        XCTAssertEqual(release.version, "0.1.7")
        XCTAssertEqual(release.download?.lastPathComponent, "Sidequest-0.1.7.zip")

        // Published before its zip was attached: nothing to download yet.
        let bare = try JSONDecoder().decode(Updater.Release.self, from: Data(#"{"tag_name": "v0.1.8", "html_url": "x"}"#.utf8))
        XCTAssertNil(bare.download)
    }
}

final class ActivityTests: XCTestCase {
    private func fixture() throws -> [AppSession] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "sessions", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(SessionsReply.self, from: Data(contentsOf: url)).sessions
    }

    func testFollowsWhereASessionHasGot() throws {
        let sessions = try fixture()

        // Two commits, a pull request and a reply waiting: the reply is what wants you.
        let fix = ActivityStep.steps(for: sessions[0])
        XCTAssertEqual(fix.map(\.label), ["Started from Slack", "Worktree ready", "2 commits", "Pull request #128 opened", "Reply drafted", "Merged"])
        XCTAssertEqual(fix[0].detail, "Fix, from @dana in #storefront-eng")
        XCTAssertEqual(fix[4].mark, .current)
        XCTAssertEqual(fix.last?.mark, .pending)

        // A question that failed before answering: no commits or pull request to wait for.
        let failed = ActivityStep.steps(for: sessions[1])
        XCTAssertEqual(failed.map(\.label), ["Started from Slack", "Worktree ready", "Agent stopped", "Reply", "Done"])
        XCTAssertEqual(failed[2].mark, .failed)
        XCTAssertEqual(failed[2].detail, "Exit code 1")

        // Answered in its terminal and marked done by you.
        let asked = ActivityStep.steps(for: sessions[2])
        XCTAssertEqual(asked.map(\.label), ["Started from Slack", "Worktree ready", "Reply", "Done"])
        XCTAssertEqual(asked.last?.mark, .reached)
        XCTAssertNotNil(asked.last?.time)
    }
}

final class ThemeTests: XCTestCase {
    func testReadsAndWritesHex() {
        XCTAssertEqual(RGB(hex: "#6D28D9")?.hex, "#6d28d9")
        XCTAssertEqual(RGB(hex: "2563eb")?.hex, "#2563eb")
        XCTAssertNil(RGB(hex: "violet"))
        XCTAssertNil(RGB(hex: "#fff"))
    }

    /// Whatever you pick, text in it is darkened or lightened until it reads on the window.
    func testTextShadesReadOnTheirBackground() throws {
        let dark = RGB(red: 0.12, green: 0.12, blue: 0.13)
        for hex in ["#ffd400", "#6d28d9", "#7dd3fc", "#111111", "#ffffff"] {
            let colour = try XCTUnwrap(RGB(hex: hex))
            XCTAssertGreaterThanOrEqual(colour.readable(on: .white).contrast(with: .white), 4.5, hex)
            XCTAssertGreaterThanOrEqual(colour.readable(on: dark).contrast(with: dark), 4.5, hex)
        }
        XCTAssertEqual(RGB(hex: "#6d28d9")?.textOnFill, .white)
        XCTAssertNotEqual(RGB(hex: "#ffd400")?.textOnFill, .white)
    }

    func testAPaletteKeepsDefaultsForMissingOrBadColours() throws {
        let palette = try JSONDecoder().decode(Palette.self, from: Data(##"{"accent":"#2563eb","working":"blue"}"##.utf8))
        XCTAssertEqual(palette.accent, "#2563eb")
        XCTAssertEqual(palette.working, Palette().working)
        XCTAssertEqual(palette.fix, Palette().fix)
    }

    /// A tinted window background stays light in light mode and dark in dark mode, whatever it is tinted with.
    func testWindowTintsKeepTextReadable() throws {
        let nearBlack = RGB(red: 0.11, green: 0.1, blue: 0.13)
        for hex in ["#000000", "#ffffff", "#ffd400", "#6d28d9", "#ff0000"] {
            let base = try XCTUnwrap(RGB(hex: hex))
            XCTAssertGreaterThanOrEqual(Theme.surface(from: base, dark: false).contrast(with: nearBlack), 7, hex)
            XCTAssertGreaterThanOrEqual(Theme.surface(from: base, dark: true).contrast(with: .white), 7, hex)
        }
    }

    func testWindowBackgroundsLoadOnlyWhatTheyUnderstand() throws {
        let palette = try JSONDecoder().decode(Palette.self, from: Data(##"{"listSurface":"accent","detailSurface":"plaid"}"##.utf8))
        XCTAssertEqual(palette.listSurface, "accent")
        XCTAssertEqual(palette.detailSurface, "")
        XCTAssertEqual(SurfaceKind(""), .standard)
        XCTAssertEqual(SurfaceKind("#2563eb"), .custom)
    }

    func testTicketPromptsShareATag() {
        let palette = Palette()
        XCTAssertEqual(palette.tag("jira"), palette.rgb(\.ticket))
        XCTAssertEqual(palette.tag("linear"), palette.rgb(\.ticket))
        XCTAssertNil(palette.tag("my-own-prompt"))
        XCTAssertNil(palette.rgb(Tone.neutral))
    }

    @MainActor
    func testAppearanceSavesAndResets() throws {
        let suite = "SidequestTests.appearance"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        let appearance = Appearance(defaults: defaults)
        appearance.set(\.accent, "#db2777")
        appearance.set(\.done, "not a colour")
        XCTAssertEqual(Appearance(defaults: defaults).palette.accent, "#db2777")
        XCTAssertEqual(Appearance(defaults: defaults).palette.done, Palette().done)

        appearance.setSurface(\.listSurface, "accent")
        appearance.setSurface(\.detailSurface, "plaid")
        XCTAssertEqual(Appearance(defaults: defaults).palette.listSurface, "accent")
        XCTAssertEqual(Appearance(defaults: defaults).palette.detailSurface, "")

        appearance.reset()
        XCTAssertEqual(Appearance(defaults: defaults).palette, Palette())
    }
}
