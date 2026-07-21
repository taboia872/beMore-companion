# Be More Companion

React Native 0.76 (Old Arch) — assistente pessoal com LLM via localhost ou on-device.

## Stack
- **LLM**: Localhost (Ollama/LM Studio/llama.cpp server) ou Local (llama.rn)
- **STT**: whisper.rn 0.6.0 (PCM/WAV nativo)
- **TTS**: Fish Audio API (cloud)
- **Audio Recording**: AudioRecord nativo (PCM 16-bit 16kHz mono → WAV)

## Build
```bash
npm install
cd android && ./gradlew assembleDebug
```
