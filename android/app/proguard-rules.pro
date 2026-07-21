# React Native default ProGuard rules
-keep class com.facebook.react.** { *; }
-keep class com.bmoreagent.** { *; }

# ONNX Runtime (reserved for future use)
-keep class ai.onnxruntime.** { *; }

# llama.rn
-keep class com.rnllama.** { *; }

# whisper.rn
-keep class com.rnwhisper.** { *; }

# react-native-audio-recorder-player
-keep class com.dooboolab.** { *; }
-keep class com.dooboolab.audiorecorderplayer.** { *; }
