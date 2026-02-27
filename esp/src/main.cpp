#include <Arduino.h>

// Wiring:
// Left LED  anode -> resistor -> GPIO2, cathode -> GND
// Right LED anode -> resistor -> GPIO4, cathode -> GND
constexpr int LEFT_LED_PIN = 2;
constexpr int RIGHT_LED_PIN = 4;
constexpr int LEFT_LED_CHANNEL = 0;
constexpr int RIGHT_LED_CHANNEL = 1;
constexpr int PWM_FREQUENCY_HZ = 5000;
constexpr int PWM_RESOLUTION_BITS = 8;
constexpr int PWM_MAX = (1 << PWM_RESOLUTION_BITS) - 1;

constexpr unsigned long BLINK_INTERVAL_MS = 250;
constexpr unsigned long FADE_DURATION_MS = 180;
// Terminal arrow input usually has no explicit key-up event; use key-repeat silence as release.
constexpr unsigned long KEY_RELEASE_TIMEOUT_MS = 650;

enum class LedMode {
    Off,
    LeftOnly,
    RightOnly,
    BothOn,
    BothBlink
};

enum class EscapeState {
    Idle,
    SawEsc,
    SawBracket
};

EscapeState escapeState = EscapeState::Idle;
LedMode pressedMode = LedMode::Off;
LedMode renderMode = LedMode::Off;
bool keyIsPressed = false;
bool blinkOn = true;
int brightness = 0;
unsigned long lastBlinkToggleMs = 0;
unsigned long lastFadeUpdateMs = 0;
unsigned long lastKeyActivityMs = 0;

void setLedBrightness(int left, int right) {
    ledcWrite(LEFT_LED_CHANNEL, left);
    ledcWrite(RIGHT_LED_CHANNEL, right);
}

void registerPress(LedMode mode, const char *label) {
    const unsigned long now = millis();

    if (!keyIsPressed || pressedMode != mode) {
        Serial.printf("Pressed: %s\n", label);
    }

    keyIsPressed = true;
    pressedMode = mode;
    renderMode = mode;
    lastKeyActivityMs = now;

    if (mode == LedMode::BothBlink) {
        blinkOn = true;
        lastBlinkToggleMs = now;
    }
}

void updatePressState(unsigned long now) {
    if (keyIsPressed && now - lastKeyActivityMs > KEY_RELEASE_TIMEOUT_MS) {
        keyIsPressed = false;
        Serial.println("Released");
    }
}

void updateBrightness(unsigned long now) {
    if (lastFadeUpdateMs == 0) {
        lastFadeUpdateMs = now;
    }

    const unsigned long elapsed = now - lastFadeUpdateMs;
    if (elapsed == 0) {
        return;
    }
    lastFadeUpdateMs = now;

    const int targetBrightness = keyIsPressed ? PWM_MAX : 0;
    int step = static_cast<int>((static_cast<unsigned long>(PWM_MAX) * elapsed + FADE_DURATION_MS - 1) /
                                FADE_DURATION_MS);
    if (step < 1) {
        step = 1;
    }

    if (brightness < targetBrightness) {
        brightness += step;
        if (brightness > targetBrightness) {
            brightness = targetBrightness;
        }
    } else if (brightness > targetBrightness) {
        brightness -= step;
        if (brightness < targetBrightness) {
            brightness = targetBrightness;
        }
    }

    if (!keyIsPressed && brightness == 0) {
        renderMode = LedMode::Off;
    }
}

void updateBlink(unsigned long now) {
    if (renderMode != LedMode::BothBlink || brightness == 0) {
        blinkOn = true;
        return;
    }

    if (now - lastBlinkToggleMs >= BLINK_INTERVAL_MS) {
        lastBlinkToggleMs = now;
        blinkOn = !blinkOn;
    }
}

void renderLeds() {
    int left = 0;
    int right = 0;

    switch (renderMode) {
        case LedMode::Off:
            break;
        case LedMode::LeftOnly:
            left = brightness;
            break;
        case LedMode::RightOnly:
            right = brightness;
            break;
        case LedMode::BothOn:
            left = brightness;
            right = brightness;
            break;
        case LedMode::BothBlink:
            if (blinkOn) {
                left = brightness;
                right = brightness;
            }
            break;
    }

    setLedBrightness(left, right);
}

void handleArrowEscapeCode(char code) {
    switch (code) {
        case 'A':
            registerPress(LedMode::BothOn, "UP");
            break;
        case 'B':
            registerPress(LedMode::BothBlink, "DOWN");
            break;
        case 'C':
            registerPress(LedMode::RightOnly, "RIGHT");
            break;
        case 'D':
            registerPress(LedMode::LeftOnly, "LEFT");
            break;
        default:
            break;
    }
}

void processSerialByte(char ch) {
    // Arrow keys are ANSI escape sequences: ESC [ A/B/C/D.
    switch (escapeState) {
        case EscapeState::Idle:
            if (ch == 0x1B) {
                escapeState = EscapeState::SawEsc;
            }
            break;
        case EscapeState::SawEsc:
            escapeState = (ch == '[') ? EscapeState::SawBracket : EscapeState::Idle;
            break;
        case EscapeState::SawBracket:
            handleArrowEscapeCode(ch);
            escapeState = EscapeState::Idle;
            break;
    }
}

void setup() {
    ledcSetup(LEFT_LED_CHANNEL, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
    ledcSetup(RIGHT_LED_CHANNEL, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
    ledcAttachPin(LEFT_LED_PIN, LEFT_LED_CHANNEL);
    ledcAttachPin(RIGHT_LED_PIN, RIGHT_LED_CHANNEL);
    setLedBrightness(0, 0);

    Serial.begin(115200);
    delay(200);

    Serial.println("Ready. Press arrow keys in your serial terminal:");
    Serial.println("Left  = left LED, Right = right LED");
    Serial.println("Up    = both LEDs on, Down = both LEDs blink");
    Serial.println("LEDs fade in on press and fade out after key release.");
}

void loop() {
    const unsigned long now = millis();

    while (Serial.available() > 0) {
        const char ch = static_cast<char>(Serial.read());
        processSerialByte(ch);
    }

    updatePressState(now);
    updateBrightness(now);
    updateBlink(now);
    renderLeds();
}
