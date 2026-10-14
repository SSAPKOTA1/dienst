plugins {
    id("com.android.application")
}

android {
    namespace = "de.dienst.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.dienst.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // no runtime libraries: the app is a thin shell around the platform WebView
    testImplementation("junit:junit:4.13.2")
}
