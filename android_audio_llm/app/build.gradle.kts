plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.audioinsight"
    compileSdk = 35
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.example.audioinsight"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
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
    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

// Resolve build dependencies before the Java UI implementation is complete.
tasks.register("resolveCourseDependencies") {
    doLast {
        listOf("debugCompileClasspath", "debugRuntimeClasspath").forEach { name ->
            val resolved = configurations.getByName(name).resolve()
            logger.lifecycle("Resolved {}: {} artifact(s)", name, resolved.size)
        }
    }
}
