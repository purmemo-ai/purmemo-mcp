import SwiftUI
import Speech
import AVFoundation

struct ComposerView: View {
    @Binding var text: String
    let isLoading: Bool
    let onSend: () -> Void

    @State private var voiceService = VoiceService()
    @State private var isRecording = false
    @FocusState private var isTextFieldFocused: Bool

    private var hasText: Bool {
        !text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// What the morphing pill shows
    private var pillState: PillState {
        if isLoading { return .sending }
        if isRecording { return .listening }
        return .rest
    }

    var body: some View {
        VStack(spacing: 0) {
            // Unified morphing pill
            morphingPill
                .padding(.top, 8)
                .padding(.bottom, 6)

            HStack(alignment: .center, spacing: 12) {
                // Text field
                TextField("Save a thought or ask anything...", text: $text, axis: .vertical)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                    .lineLimit(1...5)
                    .focused($isTextFieldFocused)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Color(hex: "#1a1a1a"))
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22)
                            .stroke(isRecording ? Color(hex: "#E7FC44").opacity(0.4) : Color.white.opacity(0.08), lineWidth: 1)
                    )
                    .onSubmit { if !isLoading && hasText { sendAndReset() } }
                    .submitLabel(.send)

                // Action button — mic or send, same position
                actionButton
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .background(Color.black)
        .onChange(of: voiceService.transcript) { _, newValue in
            if !newValue.isEmpty {
                text = newValue
            }
        }
    }

    // MARK: - Action Button

    @ViewBuilder
    private var actionButton: some View {
        if hasText || isLoading {
            // Send button
            Button(action: sendAndReset) {
                Group {
                    if isLoading {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .black))
                            .frame(width: 20, height: 20)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.black)
                    }
                }
                .frame(width: 44, height: 44)
                .background(Color(hex: "#E7FC44"))
                .clipShape(Circle())
            }
            .disabled(!hasText || isLoading)
        } else {
            // Mic button
            Button {
                if isRecording { stopRecording() } else { startRecording() }
            } label: {
                Image(systemName: isRecording ? "waveform" : "mic.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(isRecording ? .black : .white.opacity(0.6))
                    .symbolEffect(.variableColor.iterative, isActive: isRecording)
                    .frame(width: 44, height: 44)
                    .background(isRecording ? Color(hex: "#E7FC44") : Color(hex: "#1a1a1a"))
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(isRecording ? Color.clear : Color.white.opacity(0.08), lineWidth: 1)
                    )
                    .animation(.easeInOut(duration: 0.2), value: isRecording)
            }
        }
    }

    // MARK: - Morphing Pill

    enum PillState: Equatable {
        case rest
        case listening
        case sending
    }

    private var morphingPill: some View {
        HStack(spacing: 6) {
            if pillState == .listening {
                Circle()
                    .fill(Color(hex: "#E7FC44"))
                    .frame(width: 6, height: 6)
                    .transition(.scale.combined(with: .opacity))

                Text("Listening")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Color(hex: "#E7FC44"))
                    .transition(.opacity)
            } else if pillState == .sending {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: Color(hex: "#E7FC44")))
                    .scaleEffect(0.6)
                    .frame(width: 10, height: 10)
                    .transition(.scale.combined(with: .opacity))

                Text("Sending")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Color(hex: "#E7FC44").opacity(0.7))
                    .transition(.opacity)
            }
        }
        .frame(height: 4)
        .padding(.horizontal, pillState == .rest ? 0 : 14)
        .padding(.vertical, pillState == .rest ? 0 : 6)
        .frame(width: pillState == .rest ? 36 : nil)
        .background(
            Capsule()
                .fill(pillState == .rest
                      ? Color.white.opacity(0.12)
                      : Color(hex: "#E7FC44").opacity(0.12))
        )
        .clipShape(Capsule())
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: pillState)
    }

    // MARK: - Actions

    private func startRecording() {
        let haptic = UIImpactFeedbackGenerator(style: .medium)
        haptic.impactOccurred()

        // Dismiss keyboard and start voice simultaneously
        isTextFieldFocused = false
        isRecording = true
        voiceService.startListening()
    }

    private func stopRecording() {
        let haptic = UIImpactFeedbackGenerator(style: .light)
        haptic.impactOccurred()
        isRecording = false
        voiceService.stopListening()
    }

    /// Send message and clean up voice state
    private func sendAndReset() {
        // Stop voice if active
        if isRecording {
            isRecording = false
            voiceService.stopListening()
        }

        // Dismiss keyboard
        isTextFieldFocused = false

        onSend()
    }
}

// MARK: - Voice Service

@Observable
class VoiceService {
    var transcript: String = ""
    var isFinal: Bool = false
    var isAuthorized: Bool = false
    var isActive: Bool = false

    /// Accumulates finalized segments so pauses don't clear previous words
    private var finalizedText: String = ""

    private var audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    deinit {}

    func startListening() {
        transcript = ""
        finalizedText = ""
        isFinal = false
        isActive = true

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else { return }
            DispatchQueue.main.async {
                self?.isAuthorized = true
                self?.beginRecognition()
            }
        }
    }

    func stopListening() {
        isActive = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }

    private func beginRecognition() {
        guard isActive else { return }

        // Cancel any existing task
        recognitionTask?.cancel()
        recognitionTask = nil

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return
        }

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else { return }
        recognitionRequest.shouldReportPartialResults = true

        // Use on-device recognition if available
        if speechRecognizer?.supportsOnDeviceRecognition == true {
            recognitionRequest.requiresOnDeviceRecognition = true
        }

        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { @Sendable [weak self] result, error in
            guard let self else { return }
            if let result {
                DispatchQueue.main.async {
                    let newText = result.bestTranscription.formattedString
                    if self.finalizedText.isEmpty {
                        self.transcript = newText
                    } else {
                        self.transcript = self.finalizedText + " " + newText
                    }
                    if result.isFinal {
                        self.finalizedText = self.transcript
                    }
                    self.isFinal = result.isFinal
                }
            }
            if error != nil || result?.isFinal == true {
                // Full teardown on the main actor so audio engine + recognizer
                // state are released before the next session is created.
                // Without this, iOS 26 accumulates leaked audio buffers across
                // restarts and OOM-kills the app after a few minutes.
                DispatchQueue.main.async {
                    self.audioEngine.stop()
                    self.audioEngine.inputNode.removeTap(onBus: 0)
                    self.recognitionRequest?.endAudio()
                    self.recognitionRequest = nil
                    self.recognitionTask = nil

                    // Restart only if still active, after a real delay so the
                    // previous recognizer fully deallocates before the new one
                    // claims the same audio resources.
                    if self.isActive {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            guard self.isActive else { return }
                            self.beginRecognition()
                        }
                    }
                }
            }
        }

        let inputNode = audioEngine.inputNode
        inputNode.removeTap(onBus: 0)

        let recordingFormat = inputNode.outputFormat(forBus: 0)
        guard recordingFormat.sampleRate > 0 && recordingFormat.channelCount > 0 else {
            self.recognitionRequest = nil
            self.recognitionTask = nil
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            stopListening()
        }
    }
}
