package com.bemore.companion

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import java.io.File
import java.io.FileOutputStream
import java.lang.IllegalStateException

/**
 * PcmRecorderModule — NativeModule que grava áudio via AudioRecord (PCM 16-bit, 16kHz, mono)
 * e salva como arquivo .wav com header RIFF/WAVE válido.
 *
 * whisper.cpp aceita PCM/WAV nativamente (sem ffmpeg linkado).
 * Substitui o MediaRecorder (AAC/M4A) que causava erro de decodificação no whisper.rn.
 */
class PcmRecorderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var audioRecord: AudioRecord? = null
    private var isRecording = false
    private var recordThread: Thread? = null

    companion object {
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    override fun getName() = "PcmRecorder"

    /**
     * Inicia gravação PCM e salva como .wav no caminho especificado.
     * Grava primeiro em .pcm temporário, depois escreve header WAV na frente.
     */
    @ReactMethod
    fun startRecording(path: String, promise: Promise) {
        try {
            if (isRecording) {
                promise.reject("ALREADY_RECORDING", "Already recording")
                return
            }

            // Defensive: checar permissão runtime ANTES de instanciar AudioRecord.
            val permGranted = ContextCompat.checkSelfPermission(
                reactApplicationContext, Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
            if (!permGranted) {
                promise.reject("PERMISSION_DENIED", "Permissão RECORD_AUDIO não concedida.")
                return
            }

            val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
            if (minBuf <= 0) {
                promise.reject("BUFFER_ERROR", "AudioRecord.getMinBufferSize retornou $minBuf — microfone indisponível ou configuração inválida.")
                return
            }
            val bufferSize = (minBuf * 2).coerceAtLeast(3200)

            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL,
                ENCODING,
                bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                promise.reject("INIT_ERROR", "AudioRecord init failed — state != INITIALIZED")
                return
            }

            // Usar filesDir do contexto em vez do path hardcoded do JS.
            // O path JS (/data/data/<pkg>/files/...) pode não corresponder
            // ao sandbox real em multi-user, perfil de trabalho, ou storage
            // adotável. Extrai apenas o nome do arquivo e constrói o caminho
            // no filesDir garantido pelo Android.
            val fileName = File(path).name  // ex: recording_12345_1.wav
            val filesDir = reactApplicationContext.filesDir
            val wavFile = File(filesDir, fileName)
            val dir = wavFile.parentFile
            if (dir != null && !dir.exists()) {
                val created = dir.mkdirs()
                if (!created && !dir.exists()) {
                    promise.reject("DIR_ERROR", "Não foi possível criar o diretório: ${dir.absolutePath}")
                    return
                }
            }
            if (wavFile.exists()) wavFile.delete()

            val pcmFileName = fileName.replace(".wav", ".pcm")
            val pcmFile = File(filesDir, pcmFileName)
            if (pcmFile.exists()) pcmFile.delete()

            audioRecord?.startRecording()
            isRecording = true

            val resolvedPath = wavFile.absolutePath

            recordThread = Thread {
                try {
                    val buffer = ShortArray(bufferSize)
                    FileOutputStream(pcmFile).use { fos ->
                        while (isRecording) {
                            val read = audioRecord?.read(buffer, 0, buffer.size) ?: -1
                            if (read > 0) {
                                val byteBuffer = ByteArray(read * 2)
                                for (i in 0 until read) {
                                    byteBuffer[i * 2] = (buffer[i].toInt() and 0xFF).toByte()
                                    byteBuffer[i * 2 + 1] = ((buffer[i].toInt() shr 8) and 0xFF).toByte()
                                }
                                fos.write(byteBuffer)
                            }
                        }
                    }
                    // Converter PCM → WAV
                    writeWavHeader(wavFile, pcmFile)
                    pcmFile.delete()
                } catch (e: Exception) {
                    // Captura exceções do thread de gravação para evitar crash nativo.
                    // O erro será detectado no JS quando stopRecording retornar
                    // e o arquivo .wav não existir ou estiver vazio.
                    android.util.Log.e("PcmRecorder", "Erro no thread de gravação", e)
                    isRecording = false
                    try { audioRecord?.stop() } catch (_: Exception) {}
                    try { audioRecord?.release() } catch (_: Exception) {}
                    audioRecord = null
                }
            }
            recordThread?.start()

            // Retorna o caminho resolvido (filesDir + fileName) para o JS,
            // não o path original hardcoded que pode estar errado.
            promise.resolve(resolvedPath)
        } catch (e: SecurityException) {
            isRecording = false
            audioRecord = null
            promise.reject("SECURITY_ERROR", "Sem permissão de microfone: ${e.message}")
        } catch (e: IllegalArgumentException) {
            isRecording = false
            audioRecord = null
            promise.reject("ILLEGAL_ARG", "Parâmetros de AudioRecord inválidos: ${e.message}")
        } catch (e: Exception) {
            isRecording = false
            audioRecord = null
            promise.reject("START_ERROR", e.message ?: "Erro desconhecido ao iniciar gravação")
        }
    }

    /**
     * Para a gravação e finaliza o arquivo .wav.
     */
    @ReactMethod
    fun stopRecording(promise: Promise) {
        try {
            isRecording = false
            recordThread?.join(5000)
            recordThread = null
            try { audioRecord?.stop() } catch (_: IllegalStateException) {
                // AudioRecord.stop() pode IllegalStateException se não estiver gravando
            }
            audioRecord?.release()
            audioRecord = null
            promise.resolve("stopped")
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e.message ?: "Erro ao parar gravação")
        }
    }

    /**
     * Escreve um arquivo .wav com header RIFF/WAVE de 44 bytes + dados PCM.
     */
    private fun writeWavHeader(wavFile: File, pcmFile: File) {
        val pcmSize = pcmFile.length().toInt()
        FileOutputStream(wavFile).use { fos ->
            val header = ByteArray(44)

            // RIFF chunk descriptor
            header[0] = 'R'.code.toByte(); header[1] = 'I'.code.toByte()
            header[2] = 'F'.code.toByte(); header[3] = 'F'.code.toByte()
            val totalSize = pcmSize + 36
            header[4] = (totalSize and 0xff).toByte()
            header[5] = ((totalSize shr 8) and 0xff).toByte()
            header[6] = ((totalSize shr 16) and 0xff).toByte()
            header[7] = ((totalSize shr 24) and 0xff).toByte()
            header[8] = 'W'.code.toByte(); header[9] = 'A'.code.toByte()
            header[10] = 'V'.code.toByte(); header[11] = 'E'.code.toByte()

            // fmt sub-chunk
            header[12] = 'f'.code.toByte(); header[13] = 'm'.code.toByte()
            header[14] = 't'.code.toByte(); header[15] = ' '.code.toByte()
            header[16] = 16; header[17] = 0; header[18] = 0; header[19] = 0  // sub-chunk size = 16
            header[20] = 1; header[21] = 0   // audio format = 1 (PCM)
            header[22] = 1; header[23] = 0   // num channels = 1 (mono)
            header[24] = (SAMPLE_RATE and 0xff).toByte()
            header[25] = ((SAMPLE_RATE shr 8) and 0xff).toByte()
            header[26] = ((SAMPLE_RATE shr 16) and 0xff).toByte()
            header[27] = ((SAMPLE_RATE shr 24) and 0xff).toByte()
            val byteRate = SAMPLE_RATE * 2  // 16-bit mono = 2 bytes per sample
            header[28] = (byteRate and 0xff).toByte()
            header[29] = ((byteRate shr 8) and 0xff).toByte()
            header[30] = ((byteRate shr 16) and 0xff).toByte()
            header[31] = ((byteRate shr 24) and 0xff).toByte()
            header[32] = 2; header[33] = 0   // block align = 2
            header[34] = 16; header[35] = 0  // bits per sample = 16

            // data sub-chunk
            header[36] = 'd'.code.toByte(); header[37] = 'a'.code.toByte()
            header[38] = 't'.code.toByte(); header[39] = 'a'.code.toByte()
            header[40] = (pcmSize and 0xff).toByte()
            header[41] = ((pcmSize shr 8) and 0xff).toByte()
            header[42] = ((pcmSize shr 16) and 0xff).toByte()
            header[43] = ((pcmSize shr 24) and 0xff).toByte()

            fos.write(header)

            // Copiar dados PCM atrás do header
            pcmFile.inputStream().use { input ->
                val copyBuf = ByteArray(4096)
                var read: Int
                while (input.read(copyBuf).also { read = it } > 0) {
                    fos.write(copyBuf, 0, read)
                }
            }
        }
    }
}
