import Foundation
import SwiftUI
import AuthenticationServices

struct LoginRequest: Codable {
    let email: String
    let password: String
}

struct LoginResponse: Codable {
    let access_token: String
    let refresh_token: String
    let token_type: String
}

struct RefreshRequest: Codable {
    let refresh_token: String
}

@MainActor
@Observable
class AuthService {
    var isAuthenticated = false
    var userEmail: String = ""
    var oauthError: String?

    private let baseURL = "https://api.purmemo.ai"
    static let oauthCallbackScheme = "purmemo"

    /// Retain the auth session so it isn't deallocated mid-flow.
    /// Static to guarantee it survives any @Observable view redraws.
    private static var activeAuthSession: ASWebAuthenticationSession?

    init() {
        if let token = KeychainService.load(.accessToken), !token.isEmpty {
            isAuthenticated = true
            userEmail = KeychainService.load(.userEmail) ?? ""
        }
    }

    /// Explicit deinit avoids Swift runtime crash with SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor
    /// on iOS < 26.4 (swiftlang/swift#88036)
    deinit {}

    // MARK: - Email/Password Login

    func login(email: String, password: String) async throws {
        let url = URL(string: "\(baseURL)/api/v1/auth/login")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(LoginRequest(email: email, password: password))

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw AuthError.invalidCredentials
        }

        let loginResponse = try JSONDecoder().decode(LoginResponse.self, from: data)
        KeychainService.save(loginResponse.access_token, for: .accessToken)
        KeychainService.save(loginResponse.refresh_token, for: .refreshToken)
        KeychainService.save(email, for: .userEmail)

        self.userEmail = email
        self.isAuthenticated = true
    }

    // MARK: - OAuth Login (Google / GitHub)

    /// Start the OAuth flow. This is NOT async — it opens the browser sheet
    /// and the completion handler fires when the user finishes or cancels.
    func startOAuth(provider: String) {
        let callbackURL = "\(Self.oauthCallbackScheme)://oauth_callback"
        guard let encoded = callbackURL.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let loginURL = URL(string: "\(baseURL)/api/v1/oauth/\(provider)/login?return_url=\(encoded)") else {
            return
        }

        let session = ASWebAuthenticationSession(
            url: loginURL,
            callbackURLScheme: Self.oauthCallbackScheme
        ) { @Sendable [weak self] callbackUrl, error in
            // Completion fires on arbitrary thread — dispatch to main
            DispatchQueue.main.async {
                AuthService.activeAuthSession = nil
                self?.handleOAuthCallback(callbackUrl: callbackUrl, error: error)
            }
        }
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = OAuthPresentationContext.shared

        Self.activeAuthSession = session
        session.start()
    }

    /// Process the OAuth callback URL on the main thread
    private func handleOAuthCallback(callbackUrl: URL?, error: Error?) {
        if let error = error as? NSError {
            // User cancelled — don't show error
            if error.domain == ASWebAuthenticationSessionErrorDomain
                && error.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                return
            }
            oauthError = error.localizedDescription
            return
        }

        guard let callbackUrl,
              let components = URLComponents(url: callbackUrl, resolvingAgainstBaseURL: false),
              let items = components.queryItems,
              let token = items.first(where: { $0.name == "token" })?.value,
              let refreshToken = items.first(where: { $0.name == "refresh_token" })?.value else {
            oauthError = "Sign in failed — no tokens received"
            return
        }

        // Save tokens
        KeychainService.save(token, for: .accessToken)
        KeychainService.save(refreshToken, for: .refreshToken)

        // Fetch email in background, authenticate immediately
        self.isAuthenticated = true
        self.userEmail = "..."

        Task { @MainActor in
            let email = await self.fetchUserEmail(token: token)
            KeychainService.save(email, for: .userEmail)
            self.userEmail = email
        }
    }

    private func fetchUserEmail(token: String) async -> String {
        let url = URL(string: "\(baseURL)/api/v1/auth/me")!
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let email = json["email"] as? String else {
                return "User"
            }
            return email
        } catch {
            return "User"
        }
    }

    // MARK: - Token Management

    func refreshToken() async throws -> String {
        guard let refreshToken = KeychainService.load(.refreshToken) else {
            throw AuthError.noRefreshToken
        }

        let url = URL(string: "\(baseURL)/api/v1/auth/refresh")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RefreshRequest(refresh_token: refreshToken))

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            self.logout()
            throw AuthError.sessionExpired
        }

        let loginResponse = try JSONDecoder().decode(LoginResponse.self, from: data)
        KeychainService.save(loginResponse.access_token, for: .accessToken)
        KeychainService.save(loginResponse.refresh_token, for: .refreshToken)
        return loginResponse.access_token
    }

    func validToken() async throws -> String {
        guard let token = KeychainService.load(.accessToken) else {
            throw AuthError.notAuthenticated
        }
        return token
    }

    func logout() {
        KeychainService.deleteAll()
        isAuthenticated = false
        userEmail = ""
    }
}

// MARK: - OAuth Presentation Context

/// Minimal presentation context — ASPresentationAnchor() lets the system choose the right window.
/// No UIApplication.shared access needed (avoids MainActor isolation issues).
class OAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding, @unchecked Sendable {
    static let shared = OAuthPresentationContext()

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return MainActor.assumeIsolated { ASPresentationAnchor() }
    }

    deinit {}
}

// MARK: - Errors

enum AuthError: LocalizedError {
    case invalidCredentials
    case noRefreshToken
    case sessionExpired
    case notAuthenticated
    case oauthFailed

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: return "Invalid email or password"
        case .noRefreshToken:     return "Session expired, please log in again"
        case .sessionExpired:     return "Session expired, please log in again"
        case .notAuthenticated:   return "Please log in to continue"
        case .oauthFailed:        return "Sign in was cancelled or failed"
        }
    }
}
