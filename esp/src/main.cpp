#include <Arduino.h>
#include <math.h>
#include <string.h>

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
constexpr float TWO_PI_F = 6.28318530718f;

constexpr unsigned long DOWN_BLINK_PERIOD_MS = 800;
constexpr unsigned long FADE_DURATION_MS = 420;
constexpr unsigned long MODE_TRANSITION_MS = 280;
// Terminal arrow input usually has no explicit key-up event; use key-repeat silence as release.
// Keep this above typical initial key-repeat delay to avoid false release flicker.
constexpr unsigned long KEY_RELEASE_TIMEOUT_MS = 700;
constexpr size_t SERIAL_LINE_BUFFER_SIZE = 256;

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
LedMode activeMode = LedMode::Off;
bool keyIsPressed = false;
int pressLevel = 0;
int leftOutput = 0;
int rightOutput = 0;
unsigned long lastKeyActivityMs = 0;
unsigned long lastLoopUpdateMs = 0;
unsigned long downBlinkStartMs = 0;
char serialLineBuffer[SERIAL_LINE_BUFFER_SIZE] = {0};
size_t serialLineLength = 0;

void setLedBrightness(int left, int right) {
    ledcWrite(LEFT_LED_CHANNEL, left);
    ledcWrite(RIGHT_LED_CHANNEL, right);
}

int stepForElapsed(unsigned long elapsed, unsigned long durationMs) {
    if (durationMs == 0) {
        return PWM_MAX;
    }

    int step = static_cast<int>((static_cast<unsigned long>(PWM_MAX) * elapsed + durationMs - 1) / durationMs);
    if (step < 1) {
        step = 1;
    }
    return step;
}

int moveTowards(int current, int target, int step) {
    if (current < target) {
        current += step;
        if (current > target) {
            current = target;
        }
    } else if (current > target) {
        current -= step;
        if (current < target) {
            current = target;
        }
    }
    return current;
}

int computeDownPulse(unsigned long now) {
    const unsigned long phaseMs = (now - downBlinkStartMs) % DOWN_BLINK_PERIOD_MS;
    const float phase = static_cast<float>(phaseMs) / static_cast<float>(DOWN_BLINK_PERIOD_MS);
    const float pulse = 0.5f + 0.5f * cosf(phase * TWO_PI_F);  // 0..1 smooth blink curve
    int value = static_cast<int>(pulse * static_cast<float>(PWM_MAX) + 0.5f);
    if (value < 0) {
        value = 0;
    } else if (value > PWM_MAX) {
        value = PWM_MAX;
    }
    return value;
}

void registerPress(LedMode mode, const char *label) {
    const unsigned long now = millis();

    if (!keyIsPressed || activeMode != mode) {
        Serial.printf("Pressed: %s\n", label);
    }

    keyIsPressed = true;
    if (mode == LedMode::BothBlink && activeMode != LedMode::BothBlink) {
        downBlinkStartMs = now;
    }
    activeMode = mode;
    lastKeyActivityMs = now;
}

void registerRelease(const char *label) {
    if (keyIsPressed) {
        Serial.printf("Released: %s\n", label);
    }
    keyIsPressed = false;
}

void updatePressState(unsigned long now) {
    if (keyIsPressed && now - lastKeyActivityMs > KEY_RELEASE_TIMEOUT_MS) {
        registerRelease("TIMEOUT");
    }
}

void updatePressLevel(unsigned long elapsed) {
    const int target = keyIsPressed ? PWM_MAX : 0;
    const int step = stepForElapsed(elapsed, FADE_DURATION_MS);
    pressLevel = moveTowards(pressLevel, target, step);
}

void computeTargets(unsigned long now, int &leftTarget, int &rightTarget) {
    leftTarget = 0;
    rightTarget = 0;

    int effectiveLevel = pressLevel;
    if (activeMode == LedMode::BothBlink) {
        const int pulse = computeDownPulse(now);
        effectiveLevel = (pressLevel * pulse) / PWM_MAX;
    }

    switch (activeMode) {
        case LedMode::Off:
            break;
        case LedMode::LeftOnly:
            leftTarget = effectiveLevel;
            break;
        case LedMode::RightOnly:
            rightTarget = effectiveLevel;
            break;
        case LedMode::BothOn:
        case LedMode::BothBlink:
            leftTarget = effectiveLevel;
            rightTarget = effectiveLevel;
            break;
    }
}

void updateLedOutputs(unsigned long elapsed, int leftTarget, int rightTarget) {
    const int transitionStep = stepForElapsed(elapsed, MODE_TRANSITION_MS);
    leftOutput = moveTowards(leftOutput, leftTarget, transitionStep);
    rightOutput = moveTowards(rightOutput, rightTarget, transitionStep);
    setLedBrightness(leftOutput, rightOutput);
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

bool commandLineContains(const char *line, const char *token) {
    return strstr(line, token) != nullptr;
}

void handleJsonCommandLine(const char *line) {
    if (!commandLineContains(line, "\"type\":\"command\"")) {
        return;
    }

    if (commandLineContains(line, "\"command\":\"stop\"")) {
        registerRelease("STOP");
        return;
    }

    if (!commandLineContains(line, "\"command\":\"drive\"")) {
        return;
    }

    if (commandLineContains(line, "\"direction\":\"forward\"")) {
        registerPress(LedMode::BothOn, "FORWARD");
    } else if (commandLineContains(line, "\"direction\":\"reverse\"")) {
        registerPress(LedMode::BothBlink, "REVERSE");
    } else if (commandLineContains(line, "\"direction\":\"left\"")) {
        registerPress(LedMode::LeftOnly, "LEFT");
    } else if (commandLineContains(line, "\"direction\":\"right\"")) {
        registerPress(LedMode::RightOnly, "RIGHT");
    } else if (commandLineContains(line, "\"direction\":\"stop\"")) {
        registerRelease("DRIVE_STOP");
    }
}

void flushSerialLineBuffer() {
    if (serialLineLength == 0) {
        return;
    }
    serialLineBuffer[serialLineLength] = '\0';
    handleJsonCommandLine(serialLineBuffer);
    serialLineLength = 0;
}

void processSerialByte(char ch) {
    if (escapeState != EscapeState::Idle || ch == 0x1B) {
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
        return;
    }

    if (ch == '\r') {
        return;
    }
    if (ch == '\n') {
        flushSerialLineBuffer();
        return;
    }

    if (serialLineLength < SERIAL_LINE_BUFFER_SIZE - 1) {
        serialLineBuffer[serialLineLength++] = ch;
    } else {
        // Drop oversized line payloads and wait for newline to resync.
        serialLineLength = 0;
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

    Serial.println("Ready. Arrow escape and JSON command input are both supported.");
    Serial.println("Left  = left LED, Right = right LED");
    Serial.println("Up    = both LEDs on, Down = both LEDs smooth blink");
    Serial.println("LEDs fade in on press and fade out after key release.");
}

void loop() {
    while (Serial.available() > 0) {
        const char ch = static_cast<char>(Serial.read());
        processSerialByte(ch);
    }

    const unsigned long now = millis();
    if (lastLoopUpdateMs == 0) {
        lastLoopUpdateMs = now;
    }
    const unsigned long elapsed = now - lastLoopUpdateMs;
    lastLoopUpdateMs = now;

    updatePressState(now);
    updatePressLevel(elapsed);

    int leftTarget = 0;
    int rightTarget = 0;
    computeTargets(now, leftTarget, rightTarget);
    updateLedOutputs(elapsed, leftTarget, rightTarget);

    if (!keyIsPressed && pressLevel == 0 && leftOutput == 0 && rightOutput == 0) {
        activeMode = LedMode::Off;
    }
}
