package com.bemore.companion

import android.os.Bundle
import androidx.core.view.WindowCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    override fun getMainComponentName(): String = "beMoreCompanion"

    override fun onCreate(savedInstanceState: Bundle?) {
        // Garante que o conteúdo do app respeita as barras do sistema
        // (status bar no topo, navegacao no rodape). Sem isso, em algumas
        // configuracoes de tema AppCompat, a UI é desenhada sob as barras.
        WindowCompat.setDecorFitsSystemWindows(window, true)
        super.onCreate(savedInstanceState)
    }

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
