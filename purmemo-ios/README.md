# purmemo-ios

Native iOS app for Purmemo — save memories, recall context, and inject AI context from anywhere on your iPhone.

## Stack
- **Language**: Swift 5.9+
- **UI**: SwiftUI (iOS 17+)
- **Auth**: iOS Keychain (Security framework) + JWT
- **API**: api.purmemo.ai (existing endpoints)

## Project Structure

```
purmemo-ios/
├── PurmemoApp.swift          — App entry, auth gate
├── Models/
│   ├── Message.swift         — Chat message model
│   └── Memory.swift          — API request/response models
├── Services/
│   ├── KeychainService.swift — Secure token storage
│   ├── AuthService.swift     — Login, refresh, logout
│   └── PurmemoAPI.swift      — save() + recall() API calls
├── Views/
│   ├── ChatView.swift        — Main screen
│   ├── MessageBubble.swift   — Message component + design tokens
│   ├── ComposerView.swift    — Bottom input bar
│   └── LoginView.swift       — Auth screen
└── ViewModels/
    └── ChatViewModel.swift   — State + intent detection
```

## Setup

1. Open `purmemo-ios.xcodeproj` in Xcode
2. Set your Apple Developer team in Signing & Capabilities
3. Target: iPhone, iOS 17+
4. Run on simulator or device

## Design Tokens
- Accent: `#E7FC44` (yellow-green) — buttons, user bubbles
- Background: `#000000` (pure black)
- Card/bubble background: `#1a1a1a`
- No purple. No emojis in UI.

## Phase Roadmap
- **Phase 1** (current): Auth + Chat (save + recall)
- **Phase 2**: Voice input, context injection, Siri Shortcuts
- **Phase 3**: Share Sheet extension, App Store
